"""Fluxo completo com malha viária sintética: coletar -> montar dados -> HTML."""
import re

import geopandas as gpd
import orjson
from shapely.geometry import LineString

from samu_risco import build, config, db, geodata, samu
from samu_risco.textnorm import normalizar
from tests.mockdata import ENDS


def _malha(pasta):
    rows, x0 = [], -34.95
    for i, e in enumerate(ENDS[:8]):
        nome = ("Rua " if i % 2 else "Avenida ") + normalizar(e).replace("FRASCISCO JASINTO", "FRANCISCO JACINTO").title()
        if not normalizar(e):
            continue
        g = LineString([(x0 + i * .01, -8.05), (x0 + i * .01 + .004, -8.048)])
        rows += [(nome, "", "primary", g), (nome, "", "primary", LineString(list(g.coords)[::-1]))]
    rows.append(("", "BR-101;BR-232", "trunk", LineString([(-34.95, -8.0), (-34.9, -8.02)])))
    g = gpd.GeoDataFrame(rows, columns=["name", "ref", "highway", "geometry"], crs=4326)
    g["maxspeed"], g["lanes"], g["oneway"] = None, None, ""
    g.to_parquet(pasta.geo / "arestas.parquet")


def _bike_de(arestas):
    """Nós e arestas de bicicleta sintéticos a partir da malha de teste (ida e volta)."""
    import pandas as pd
    nos, linhas = [], []
    for i, r in enumerate(arestas.itertuples()):
        c = list(r.geometry.coords)
        a, b = 2 * i + 1, 2 * i + 2
        nos += [{"osmid": a, "x": c[0][0], "y": c[0][1]}, {"osmid": b, "x": c[-1][0], "y": c[-1][1]}]
        comp = float(gpd.GeoSeries([r.geometry], crs=4326).to_crs(31985).length.iloc[0])
        linhas += [(a, b, r.name, "primary", comp, r.geometry), (b, a, r.name, "primary", comp, LineString(c[::-1]))]
    return (pd.DataFrame(nos), gpd.GeoDataFrame(linhas, columns=["u", "v", "name", "highway", "length", "geometry"], crs=4326))


def test_fluxo_completo(mock, pasta, monkeypatch):
    samu.coletar(pasta, log=lambda *a: None)
    _malha(pasta)
    monkeypatch.setattr(geodata, "osm_malha", lambda p, forcar=False, log=print: gpd.read_parquet(p.geo / "arestas.parquet"))
    geodata.geodados(pasta, log=lambda *a: None)
    con, geo = db.conectar(pasta.db), geodata.carregar(pasta)
    geo["bike_nos"], geo["bike_arestas"] = _bike_de(geo["arestas"][geo["arestas"]["name"] != ""])
    D = build.montar_dados(pasta, con, geo, log=lambda *a: None)
    G = D["grafo"]
    assert G and len(G["u"]) > 0 and any(f >= 0 for f in G["f"]) and max(G["f"]) < len(D["geo"]["features"])
    assert D["anos_padrao"] == [0, 1, 2]
    q = D["qual"]
    assert q["total"] > 100 and 0.5 < q["localizadas"] / q["total"] < 1.0
    assert q["fuzzy"] > 0 and q["sem_match"] > 0
    assert D["anos"] == [2017, 2024, 2025]
    assert all(len(e) == 11 for e in D["ev"]) and max(e[0] for e in D["ev"]) < len(D["geo"]["features"])
    assert len(D["ciclo"]["feats"]) == 3 and len(D["pontos"]["semaforos"]) == 2
    assert (pasta.base / "nao_casados.csv").exists()
    assert all("g" in f and "geometry" not in f for f in D["geo"]["features"])
    assert D["base"]["vias"][0] or D["base"]["vias"][1]
    nomes = {f["properties"]["n"] for f in D["geo"]["features"]}
    assert "Avenida Conde Iraja".title() in {n.title() for n in nomes} or any("Iraja" in n for n in nomes)
    out = build.gerar_html(D, pasta.base / "mapa.html")
    html = out.read_text(encoding="utf-8")
    assert "{{" not in html and "__DATA__" not in html and "<antml" not in html
    assert 'data-enc="gzip-b64"' in html and "cdnjs" not in html
    # idempotência do cache de matching
    D2 = build.montar_dados(pasta, con, geo, log=lambda *a: None)
    assert D2["ev"] == D["ev"]
