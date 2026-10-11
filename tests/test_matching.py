import json

from samu_risco import db, matching

OSM = ["CONDE IRAJA", "AGAMENON MAGALHAES", "FRANCISCO JACINTO", "BR 101", "BEBERIBE", "DOM BOSCO"]


def test_pontuar_exato_fuzzy_curto_vazio():
    r = matching.pontuar(["CONDE IRAJA", "FRASCISCO JASINTO", "AB", "", "BOSCO", "XYZ QWERTY ASDF"], OSM)
    assert r["CONDE IRAJA"][:3] == ("CONDE IRAJA", 100, "exato")
    via, sc, met, _ = r["FRASCISCO JASINTO"]
    assert via == "FRANCISCO JACINTO" and 86 <= sc < 100 and met == "fuzzy"
    assert r["AB"][2] == "curto" and r[""][2] == "vazio"
    assert r["BOSCO"][0] is None or r["BOSCO"][1] < 86        # não casa 'BOSCO' com 'DOM BOSCO'
    assert r["XYZ QWERTY ASDF"][0] is None


# Vocabulário com os falsos positivos que apareceram na calibração manual (CSV).
OSM_CAL = ["CORREGO JAQUEIRA", "CORREGO DO IMBAUBA", "AV FRANCISCO JACINTO", "RUA LE PARQUE",
           "PRAÇA EÇA DE QUEIROZ", "CAJUEIRO", "RUA CONDE IRAJA", "CRISOLITA", "ECA QUEIROZ"]


def test_genericos_e_toponimos_nao_casam():
    """Casos do CSV de calibração: só genérico/topônimo em comum não é similaridade."""
    r = matching.pontuar(["CORREGO IMBAUBA", "LE PARC", "CICLISTA", "ECA QUEIROZ"], OSM_CAL)
    # CORREGO IMBAUBA ~ CORREGO DO IMBAUBA é match legítimo (conector 'DO' omitido no endereço);
    # o que não pode casar é 'CORREGO IMBAUBA' com 'CORREGO JAQUEIRA'.
    assert r["CORREGO IMBAUBA"][0] in (None, "CORREGO DO IMBAUBA")
    assert r["LE PARC"][0] is None                            # nome curto: corte rígido
    assert r["CICLISTA"][2] == "nao_e_via"                    # modo, não endereço
    # 'ECA QUEIROZ' só casa se existir no OSM; com 'ECA QUEIROZ' ausente, CAJUEIRO é topônimo
    # derivado e não pode ser candidato.
    if r["ECA QUEIROZ"][0] is not None:
        assert r["ECA QUEIROZ"][0] != "CAJUEIRO"


def test_typo_perdoado_sem_abrir_porta_para_toponimo():
    """Typos reais casam; derivações de topônimo ('QUEIROZ'~'CAJUEIRO') não."""
    sem_eca = [v for v in OSM_CAL if v != "ECA QUEIROZ"]
    for k, esperado in [("FRANCISCO JASINTO", "AV FRANCISCO JACINTO"),
                        ("CORREGO DO IMBAUVA", "CORREGO DO IMBAUBA")]:
        assert matching.pontuar([k], sem_eca)[k][0] == esperado, k
    r = matching.pontuar(["ECA QUEIROZ"], sem_eca)["ECA QUEIROZ"]
    assert r[0] is None or r[0] != "CAJUEIRO"


def test_corte_cache_e_correcao(tmp_path):
    con = db.conectar(tmp_path / "t.duckdb")
    r = matching.casar(con, ["FRASCISCO JASINTO"], OSM, corte=86)
    assert r["FRASCISCO JASINTO"][0] == "FRANCISCO JACINTO"
    r = matching.casar(con, ["FRASCISCO JASINTO"], OSM, corte=99)         # mesmo cache, corte maior
    assert r["FRASCISCO JASINTO"][0] is None and r["FRASCISCO JASINTO"][4] == "FRANCISCO JACINTO"
    con.execute("INSERT INTO match_correcoes VALUES ('FRASCISCO JASINTO','BEBERIBE')")
    r = matching.casar(con, ["FRASCISCO JASINTO"], OSM, corte=99)
    assert r["FRASCISCO JASINTO"][:3] == ("BEBERIBE", 100, "correcao")
    # mudar o OSM invalida o cache
    n_antes = con.execute("SELECT count(*) FROM match_cache").fetchone()[0]
    matching.casar(con, ["CONDE IRAJA"], OSM + ["NOVA VIA"], corte=86)
    assert n_antes >= 1 and con.execute("SELECT count(*) FROM match_cache").fetchone()[0] == 1


def test_desempatar():
    vpb = {"A": {"TORRE"}, "B": {"BOA VISTA"}}
    assert matching.desempatar("A", ["B"], "BOA VISTA", vpb) == "B"
    assert matching.desempatar("A", ["B"], "CENTRO", vpb) == "A"
    assert matching.desempatar("A", [], "TORRE", vpb) == "A"


def test_ler_rotulos_tolerancias(tmp_path):
    """Leitura robusta: BOM duplicado, aspas no cabeçalho, separador ',' e sinônimos de S/N."""
    import csv
    import io
    cab = '"chave";"candidato";"score";"correto";"via_correta"'
    txt = "\ufeff\ufeff" + cab + "\r\n" + '"RUA A";"RUA B";90;"sim";""\r\n' * 12 + "\n\n"
    arq = tmp_path / "amostra.csv"
    arq.write_bytes(txt.encode("utf-8-sig"))
    rot = matching._ler_rotulos(arq)
    assert len(rot) == 12 and all(r["ok"] and r["chave"] == "RUA A" for r in rot)

    # vírgula como separador (planilha regravada com 'Texto CSV')
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=",")
    w.writerow(["chave", "endereco_exemplo", "ocorrencias", "candidato", "score", "faixa", "correto", "via_correta"])
    for i in range(5):
        w.writerow([f"RUA {i}", "E", i, f"RUA {i}", 80, "70-80", "N" if i % 2 else "S", ""])
    arq2 = tmp_path / "amostra2.csv"
    arq2.write_bytes(buf.getvalue().encode("utf-8-sig"))
    rot2 = matching._ler_rotulos(arq2)
    assert len(rot2) == 5 and [r["ok"] for r in rot2] == [True, False, True, False, True]

    # nada preenchido -> erro claro (e não 'Poucos rótulos' silencioso sobre o motivo)
    arq3 = tmp_path / "amostra3.csv"
    arq3.write_bytes((buf.getvalue().replace(",S,", ",,").replace(",N,", ",,"))
                     .encode("utf-8-sig"))
    try:
        matching._ler_rotulos(arq3)
        assert False, "deveria levantar ValueError"
    except ValueError as e:
        assert "correto" in str(e)


def test_calibracao_ponta_a_ponta(pasta):
    con = db.conectar(pasta.db)
    import random
    rnd = random.Random(7)
    L = "ABCDEFGHIJLMNOPQRSTUVXZ"
    osm = ["".join(rnd.choice(L) for _ in range(7)) + " " + "".join(rnd.choice(L) for _ in range(7))
           for _ in range(150)] + ["RUA ALVO"]
    cand = []
    for i, nome in enumerate(osm[:150]):                 # 0..8 trocas de caractere -> scores variados
        t = list(nome)
        for pos in rnd.sample([j for j, c in enumerate(t) if c != " "], i % 9):
            t[pos] = rnd.choice(L)
        cand.append("".join(t))
    res = matching.casar(con, cand, osm, corte=70)
    amostra = matching.gerar_amostra(pasta, res, {k: k for k in res}, {k: 1 for k in res}, por_faixa=10)
    assert amostra.exists()
    # rotula: tudo que o candidato é a via certa -> S, exceto score < 90 -> N
    import csv
    linhas = list(csv.DictReader(open(amostra, encoding="utf-8-sig"), delimiter=";"))
    assert len(linhas) >= 20
    with open(amostra, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(linhas[0]), delimiter=";")
        w.writeheader()
        for l in linhas:
            l["correto"] = "S" if int(l["score"]) >= 90 else "N"
            if l["correto"] == "N":
                l["via_correta"] = "RUA ALVO"
            w.writerow(l)
    out = matching.avaliar(pasta, con, osm)
    assert out["corte"] >= 86 and json.loads(pasta.calibracao.read_text())["corte"] == out["corte"]
    assert matching.corte_atual(pasta) == out["corte"]
    assert con.execute("SELECT count(*) FROM match_correcoes").fetchone()[0] == out["correcoes"]


def test_alias_por_titulo_no_endereco_e_no_osm():
    osm = ["JAYME FONTE", "DOUTOR ABDIAS CARVALHO", "BEBERIBE"]
    r = matching.pontuar(["DOUTOR JAYME FONTE", "ABDIAS CARVALHO"], osm)
    assert r["DOUTOR JAYME FONTE"][:3] == ("JAYME FONTE", 100, "exato")      # título só no endereço
    assert r["ABDIAS CARVALHO"][0] is None or r["ABDIAS CARVALHO"][1] < 100    # sem alias no OSM: cai no fuzzy


def test_rodovia_sem_numero():
    assert matching.pontuar(["BR", "PE"], ["BR 101"])["BR"][2] == "rodovia_sem_numero"
    vpb = {"BR 101": {"CURADO"}, "BR 232": {"CURADO", "JAIQUE"}}
    rod = ["BR 101", "BR 232"]
    assert matching.resolver_rodovia("BR", "JAIQUE", rod, vpb) == "BR 232"      # só uma passa no bairro
    assert matching.resolver_rodovia("BR", "CURADO", rod, vpb) is None          # ambígua
    assert matching.resolver_rodovia("BR", "TORRE", rod, vpb) is None
