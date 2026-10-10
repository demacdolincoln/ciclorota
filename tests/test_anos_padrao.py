import geopandas as gpd

from samu_risco import build, db, geodata, samu
from tests.mockdata import Mock, csv_moderno
from tests.test_fluxo import _malha


def test_anos_so_com_atropelamento_ficam_fora_do_padrao(monkeypatch, pasta):
    from samu_risco import config
    m = Mock()
    monkeypatch.setattr(config, "API", m.api)
    antigos = ["ATROPELCARRO", "ATROPELMOTO", "ATROPELBIKE", "PARADA CARDIACA"]       # como em 2016-2019
    m.add("servico-de-atendimento-movel-de-urgencia-samu-2017", [("Solicitações de Atendimento 2017", "CSV", "a.csv", csv_moderno(2017, subs=antigos))])
    m.add("servico-de-atendimento-movel-de-urgencia-samu-2024", [("Solicitações de Atendimento 2024", "CSV", "b.csv", csv_moderno(2024))])
    for slug in ("malha-cicloviaria-do-recife", "localizacao-dos-semaforos", "paraciclos-do-recife", "area-urbana"):
        m.add(slug, [("x", "CSV", slug + ".csv", b"a\n1\n")])
    samu.coletar(pasta, log=lambda *a: None)
    _malha(pasta)
    monkeypatch.setattr(geodata, "osm_malha", lambda p, forcar=False, log=print: gpd.read_parquet(p.geo / "arestas.parquet"))
    con = db.conectar(pasta.db)
    D = build.montar_dados(pasta, con, {"arestas": gpd.read_parquet(pasta.geo / "arestas.parquet")}, log=lambda *a: None)
    assert D["anos"] == [2017, 2024]
    assert D["anos_padrao"] == [1]                                  # 2017 só tem atropelamentos -> fora do padrão
    assert "2017" in D["aviso_anos"] and "2024" in D["aviso_anos"]
    df = build.carregar_eventos(con)
    assert df.filter(df["ano"] == 2017)["natureza"].unique().to_list() == ["Atropelamento"]   # nomes antigos mapeados
