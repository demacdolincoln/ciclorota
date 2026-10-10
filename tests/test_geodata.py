import geopandas as gpd
from shapely.geometry import LineString

from samu_risco import config, geodata


def _osm_falso(monkeypatch):
    monkeypatch.setattr(geodata, "osm_malha", lambda p, forcar=False, log=print: gpd.GeoDataFrame(
        {"name": ["Rua X"], "ref": [""], "highway": ["residential"], "maxspeed": [None], "lanes": [None], "oneway": ["False"]},
        geometry=[LineString([(-34.9, -8.05), (-34.89, -8.05)])], crs=4326))


def test_geodados_prefeitura(mock, pasta, monkeypatch):
    _osm_falso(monkeypatch)
    st = geodata.geodados(pasta, log=lambda *a: None)
    assert st["ciclovias"].startswith("prefeitura")
    g = gpd.read_parquet(pasta.geo / "ciclovias.parquet")
    assert dict(g["classe"].value_counts()) == {0: 2, 1: 1, 2: 1}          # Ciclovia x2, Ciclofaixa, Ciclorrota
    sem = gpd.read_parquet(pasta.geo / "semaforos.parquet")
    assert len(sem) == 2 and abs(sem.geometry.iloc[0].y + 8.0631) < 1e-6    # vírgula decimal; linhas vazias/zero descartadas
    assert len(gpd.read_parquet(pasta.geo / "paraciclos.parquet")) == 1
    b = gpd.read_parquet(pasta.geo / "bairros.parquet")
    assert len(b) == 64 and b["name"].iloc[0] == "BAIRRO 0" and (b["fonte"] == "area-urbana").all()
    rel = (pasta.base / "relatorio_geodados.txt").read_text(encoding="utf-8")
    assert "Malha cicloviária" in rel and "tipo:" in rel and "radares" in rel


def test_geodados_ciclovia_fallback_osm(mock, pasta, monkeypatch):
    _osm_falso(monkeypatch)
    del mock.pacotes["malha-cicloviaria-do-recife"]
    monkeypatch.setattr(geodata, "osm_ciclovias", lambda log=print: gpd.GeoDataFrame(
        {"classe": [0]}, geometry=[LineString([(-34.9, -8.05), (-34.89, -8.05)])], crs=4326))
    st = geodata.geodados(pasta, log=lambda *a: None)
    assert st["ciclovias"] == "osm"


def test_bairros_cai_para_osm_se_portal_sem_bairros(mock, pasta, monkeypatch):
    _osm_falso(monkeypatch)
    del mock.pacotes["area-urbana"]
    monkeypatch.setattr(geodata, "osm_bairros", lambda p, log=print: gpd.GeoDataFrame(
        {"name": ["TORRE"]}, geometry=[LineString([(0, 0), (1, 1)]).buffer(1)], crs=4326))
    geodata.geodados(pasta, log=lambda *a: None)
    b = gpd.read_parquet(pasta.geo / "bairros.parquet")
    assert (b["fonte"] == "osm").all()


# ---------------------------------------------------------------- correções pós-relatório real
import sys
import types

import pandas as pd
from shapely.geometry import Point, box

from samu_risco import rede
from tests.mockdata import geojson, linha


def _linhas(n, tipos):
    return geojson([linha(-34.95 + i * .003, -8.05, {"tipo": tipos[i % len(tipos)], "rota": i}) for i in range(n)])


def test_ciclovias_prefere_permanente_mesmo_com_conecta_mais_novo(mock, pasta, monkeypatch):
    _osm_falso(monkeypatch)
    mock.add("malha-cicloviaria-do-recife", [
        ("Rotas Cicláveis do Recife - Conecta", "GEOJSON", "conecta.geojson", _linhas(1, ["x"]), "2026-04-08T00:00:00"),
        ("Rotas Cicláveis do Recife - Permanente", "GEOJSON", "perm.geojson",
         _linhas(24, ["Ciclovia", "Ciclofaixa", "Ciclorrota"]), "2026-03-02T00:00:00")])
    st = geodata.geodados(pasta, log=lambda *a: None)
    assert st["ciclovias"].startswith("prefeitura") and "Permanente" in st["ciclovias"]
    g = gpd.read_parquet(pasta.geo / "ciclovias.parquet")
    assert len(g) == 24 and set(g["classe"]) == {0, 1, 2}


def test_ciclovias_tenta_proximo_recurso_e_registra_motivo(mock, pasta, monkeypatch):
    _osm_falso(monkeypatch)
    mock.add("malha-cicloviaria-do-recife", [
        ("Rotas Cicláveis - Permanente", "GEOJSON", "perm.geojson", b"isto nao e geojson"),
        ("Rotas Cicláveis - Conecta", "GEOJSON", "conecta.geojson", _linhas(30, ["Ciclovia", "Ciclofaixa"]))])
    st = geodata.geodados(pasta, log=lambda *a: None)
    assert "Conecta" in st["ciclovias"]


def test_ciclovias_todas_falham_vai_para_osm_e_relatorio_diz_porque(mock, pasta, monkeypatch):
    _osm_falso(monkeypatch)
    mock.add("malha-cicloviaria-do-recife", [("Conecta", "GEOJSON", "c.geojson", b"lixo")])
    monkeypatch.setattr(geodata, "osm_ciclovias", lambda log=print: gpd.GeoDataFrame(
        {"classe": [0]}, geometry=[LineString([(-34.9, -8.05), (-34.89, -8.05)])], crs=4326))
    st = geodata.geodados(pasta, log=lambda *a: None)
    assert st["ciclovias"] == "osm"
    rel = (pasta.base / "relatorio_geodados.txt").read_text(encoding="utf-8")
    assert "Prefeitura falhou" in rel and "'Conecta'" in rel


def test_bairros_relatorio_lista_candidatos_sem_coluna(mock, pasta, monkeypatch):
    _osm_falso(monkeypatch)
    mock.add("area-urbana", [("Area", "GEOJSON", "au.geojson", geojson([quadrado_pol(0)]))])
    monkeypatch.setattr(geodata, "osm_bairros", lambda p, log=print: None)
    geodata.geodados(pasta, log=lambda *a: None)
    rel = (pasta.base / "relatorio_geodados.txt").read_text(encoding="utf-8")
    assert "sem coluna de bairro" in rel and "[bairros] indisponíveis" in rel


def quadrado_pol(i):
    return {"type": "Feature", "properties": {"codigo": i}, "geometry": {
        "type": "Polygon", "coordinates": [[[0, 0], [.1, 0], [.1, .1], [0, .1], [0, 0]]]}}


def test_sanear_valores_nao_escalares(tmp_path):
    g = gpd.GeoDataFrame({"x": [{"a": 1}], "y": [[1, 2]], "n": [3]}, geometry=[Point(0, 0)], crs=4326)
    geodata.sanear(g).to_parquet(tmp_path / "a.parquet")
    assert gpd.read_parquet(tmp_path / "a.parquet")["x"].iloc[0] == '{"a": 1}'


def test_classificar_ciclo_com_dtype_texto_novo():
    g = gpd.GeoDataFrame({"tipo": pd.array(["Ciclovia", "Ciclofaixa", "Ciclorrota"], dtype="string"),
                          "nome": ["a", "b", "c"]}, geometry=[Point(0, 0)] * 3, crs=4326)
    s, origem = geodata.classificar_ciclo(g)
    assert list(s) == [0, 1, 2] and "tipo" in origem


def test_aresta_pega_o_menor_bairro_quando_ha_poligonos_sobrepostos():
    edges = gpd.GeoDataFrame({"name": ["Rua Teste"], "ref": [""]},
                             geometry=[LineString([(-34.901, -8.051), (-34.899, -8.051)])], crs=4326)
    bairros = gpd.GeoDataFrame({"name": ["Recife", "Torre"]},          # município primeiro: não pode vencer
                               geometry=[box(-35.0, -8.2, -34.7, -7.9), box(-34.91, -8.06, -34.89, -8.04)], crs=4326)
    ex = rede.preparar_arestas(edges, bairros)
    assert list(ex["bairro"]) == ["TORRE"]


def test_osm_bairros_exclui_municipio_e_poligonos_grandes(pasta, monkeypatch):
    bairros = [{"name": f"B{i}", "admin_level": "10",
                "geometry": box(-34.95 + i * .01, -8.1, -34.94 + i * .01, -8.09)} for i in range(25)]
    outros = [{"name": "Recife", "admin_level": "8", "geometry": box(-35.1, -8.3, -34.7, -7.8)},
              {"name": "Olinda", "admin_level": "8", "geometry": box(-34.9, -8.0, -34.8, -7.9)}]
    gdf = gpd.GeoDataFrame(bairros + outros, crs=4326)
    fake = types.SimpleNamespace(features_from_place=lambda lugar, tags: gdf)
    monkeypatch.setitem(sys.modules, "osmnx", fake)
    b = geodata.osm_bairros(pasta, log=lambda *a: None)
    assert len(b) == 25 and "Recife" not in set(b["name"]) and "Olinda" not in set(b["name"])
