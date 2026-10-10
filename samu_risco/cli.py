"""Linha de comando: coletar | geodados | calibrar-gerar | calibrar-avaliar | gerar | tudo."""
import argparse
import sys
from pathlib import Path

from . import build, config, db, geodata, matching, rede, samu


def _anos(txt):
    if not txt:
        return None
    anos = set()
    for parte in txt.split(","):
        if "-" in parte:
            a, b = parte.split("-")
            anos.update(range(int(a), int(b) + 1))
        else:
            anos.add(int(parte))
    return sorted(anos)


def _carregar(p):
    con = db.conectar(p.db)
    return con, geodata.carregar(p)


def cmd_coletar(a):
    p = config.pastas(a.dir)
    samu.coletar(p, anos=_anos(a.anos), forcar=a.forcar)
    print(f"\nRelatório: {p.base / 'relatorio_samu.txt'}")


def cmd_relatorio(a):
    p = config.pastas(a.dir)
    samu.relatorio_local(p)
    print(f"\nRelatório: {p.base / 'relatorio_samu.txt'}")


def cmd_geodados(a):
    p = config.pastas(a.dir)
    st = geodata.geodados(p, forcar=a.forcar)
    print(f"\nStatus: {st}\nRelatório: {p.base / 'relatorio_geodados.txt'}")


def _pontuacao_amostra(p, con, geo):
    df = build.com_chaves(build.carregar_eventos(con))
    ex = rede.preparar_arestas(geo["arestas"], geo.get("bairros"))
    osm_keys = list(ex["key"].unique())
    res = matching.casar(con, df["key"].unique().to_list(), osm_keys, matching.corte_atual(p))
    exemplos, contagem = build.resumo_chaves(df)
    return res, exemplos, contagem, osm_keys


def cmd_calibrar_gerar(a):
    p = config.pastas(a.dir)
    con, geo = _carregar(p)
    res, ex, cont, _ = _pontuacao_amostra(p, con, geo)
    arq = matching.gerar_amostra(p, res, ex, cont, por_faixa=a.por_faixa)
    print(f"Amostra gerada: {arq}\nPreencha 'correto' (S/N) e, se N, 'via_correta' (chave); depois rode calibrar-avaliar.")


def cmd_calibrar_avaliar(a):
    p = config.pastas(a.dir)
    con, geo = _carregar(p)
    ex = rede.preparar_arestas(geo["arestas"], geo.get("bairros"))
    r = matching.avaliar(p, con, list(ex["key"].unique()), a.precisao)
    print(f"Corte recomendado: {r['corte']} (rótulos: {r['n_rotulos']}, correções: {r['correcoes']})")
    for t in r["tabela"][::3]:
        print(f"  corte {t['corte']:3d}  precisão {t['precisao']:.3f}  revocação {t['revocacao']:.3f}  F1 {t['f1']:.3f}")
    print(f"Salvo em {p.calibracao}")


def cmd_gerar(a):
    p = config.pastas(a.dir)
    con, geo = _carregar(p)
    D = build.montar_dados(p, con, geo)
    out = build.gerar_html(D, Path(a.saida))
    print(f"HTML gerado: {out} ({out.stat().st_size / 1e6:.2f} MB)")


def cmd_tudo(a):
    cmd_coletar(a)
    cmd_geodados(a)
    cmd_gerar(a)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="samu-risco", description=__doc__)
    ap.add_argument("--dir", default="dados", help="pasta de dados (padrão: dados)")
    sp = ap.add_subparsers(dest="cmd", required=True)

    c = sp.add_parser("coletar", help="baixa o SAMU (CKAN) e grava no DuckDB")
    c.add_argument("--anos", help="ex.: 2016-2026 ou 2024,2025")
    c.add_argument("--forcar", action="store_true")
    c.set_defaults(f=cmd_coletar)

    r = sp.add_parser("relatorio", help="refaz o relatório do SAMU com os CSV já baixados (sem rede)")
    r.set_defaults(f=cmd_relatorio)

    g = sp.add_parser("geodados", help="malha OSM + ciclovias, semáforos, paraciclos e bairros")
    g.add_argument("--forcar", action="store_true")
    g.set_defaults(f=cmd_geodados)

    cg = sp.add_parser("calibrar-gerar", help="gera amostra para rotular o corte do fuzzy")
    cg.add_argument("--por-faixa", type=int, default=40)
    cg.set_defaults(f=cmd_calibrar_gerar)

    ca = sp.add_parser("calibrar-avaliar", help="lê a amostra rotulada e escolhe o corte")
    ca.add_argument("--precisao", type=float, default=0.95)
    ca.set_defaults(f=cmd_calibrar_avaliar)

    ge = sp.add_parser("gerar", help="gera o HTML")
    ge.add_argument("--saida", default="mapa_acidentes_recife.html")
    ge.set_defaults(f=cmd_gerar)

    t = sp.add_parser("tudo", help="coletar + geodados + gerar")
    t.add_argument("--anos")
    t.add_argument("--forcar", action="store_true")
    t.add_argument("--saida", default="mapa_acidentes_recife.html")
    t.set_defaults(f=cmd_tudo)

    a = ap.parse_args(argv)
    a.f(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
