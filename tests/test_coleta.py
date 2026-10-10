import polars as pl

from samu_risco import ckan, db, samu


def test_descobrir_anos_e_recurso(mock):
    r = samu.descobrir()
    assert [x["ano"] for x in r] == [2015, 2017, 2024, 2025]       # 'outro-conjunto-samu-lista' ignorado
    assert r[0]["nome"] == "Solicitações de atendimento"            # não pega 'Remoções'
    assert r[3]["nome"].endswith("2025")                            # acha o recurso mesmo na 2ª posição


def test_coletar_moderno_legado_e_incremental(mock, pasta):
    rel = samu.coletar(pasta, log=lambda *a: None)
    assert len(rel) == 4 and "legado" in rel[0] and "moderno" in rel[1]
    con = db.conectar(pasta.db)
    assert con.execute("SELECT count(*) FROM samu_eventos").fetchone()[0] == 900          # 3 anos x 300
    assert con.execute("SELECT count(*) FROM samu_legado").fetchone()[0] == 50
    # 2017 veio em cp1252 com ',' como separador; acentos e idade com vírgula preservados
    r = con.execute("SELECT origem_chamado, max(idade) FROM samu_eventos WHERE ano_fonte=2017 GROUP BY 1").fetchall()
    assert r == [("VIA PÚBLICA", 130.0)]
    assert con.execute("SELECT count(*) FROM samu_eventos WHERE ano_fonte=2024 AND idade=40.5").fetchone()[0] > 0
    assert con.execute("SELECT min(ano), max(ano) FROM samu_eventos").fetchone() == (2017, 2025)
    # segunda execução não baixa nada
    antes = dict(mock.contagem)
    rel2 = samu.coletar(pasta, log=lambda *a: None)
    assert rel2 == [] and mock.contagem == antes
    # --forcar baixa de novo, sem duplicar linhas
    samu.coletar(pasta, anos=[2024], forcar=True, log=lambda *a: None)
    assert con.execute("SELECT count(*) FROM samu_eventos WHERE ano_fonte=2024").fetchone()[0] == 300
    assert (pasta.base / "relatorio_samu.txt").exists()


def test_esquema_desconhecido_nao_importa(mock, pasta):
    mock.add("servico-de-atendimento-movel-de-urgencia-samu-2030",
             [("Solicitações de Atendimento 2030", "CSV", "s2030.csv", b"colx;coly\n1;2\n")])
    rel = samu.coletar(pasta, anos=[2030], log=lambda *a: None)
    assert "DESCONHECIDO" in rel[0]
    con = db.conectar(pasta.db)
    assert db.fonte(con, "samu:2030") is None            # não marca como atualizado


def test_ckan_erro_404(mock):
    import pytest
    with pytest.raises(ckan.CkanErro):
        ckan.pacote("nao-existe")


def test_ler_csv_detecta_separador(tmp_path):
    f = tmp_path / "a.csv"
    f.write_bytes('"a";"b"\n"1";"é"\n'.encode("cp1252"))
    df = samu.ler_csv(f)
    assert df.columns == ["a", "b"] and df["b"][0] == "é"


def test_relatorio_local_aponta_colunas_ausentes_e_subtipos_nao_mapeados(pasta):
    txt = ('"data";"hora_minuto";"municipio";"bairro";"endereco";"tipo";"subtipo"\n'
           '"2016-05-01T00:00:00";"10:00:00";"RECIFE";"TORRE";"R A";"CAUSAS EXTERNAS";"ACIDENTE DE TRÂNSITO ENVOLVENDO MOTO"\n'
           '"2016-05-02T00:00:00";"11:00:00";"Recife";"TORRE";"R B";"CAUSAS EXTERNAS";"ATROPELAMENTO POR CARRO"\n'
           '"2016-05-03T00:00:00";"12:00:00";"RECIFE";"TORRE";"R C";"CAUSAS EXTERNAS";"ACIDENTE DE TRANSITO COM TREM"\n')
    (pasta.raw / "samu_2016.csv").write_text(txt, encoding="utf-8")
    linha = samu.relatorio_local(pasta, log=lambda *a: None)[0]
    assert "acidentes 1, atropelamentos 1" in linha                  # 'TRÂNSITO' acentuado foi normalizado
    assert "colunas ausentes" in linha and "sexo" in linha and "idade" in linha
    assert "ACIDENTE DE TRANSITO COM TREM" in linha                  # variante não mapeada aparece
    assert (pasta.base / "relatorio_samu.txt").exists()
