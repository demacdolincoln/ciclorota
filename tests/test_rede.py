import base64
import gzip
import re

import geopandas as gpd
import orjson
import pandas as pd
import shapely
from shapely.geometry import LineString, MultiLineString

from samu_risco import build, rede


def decodificar(partes, esc=100000):
    out = []
    for a in partes:
        x, y = a[0], a[1]
        pts = [(x / esc, y / esc)]
        for i in range(2, len(a), 2):
            x += a[i]; y += a[i + 1]
            pts.append((x / esc, y / esc))
        out.append(pts)
    return out


def test_codificar_ida_e_volta():
    g = MultiLineString([[(-34.90001, -8.05002), (-34.89, -8.0402), (-34.88, -8.04)], [(-34.9, -8.1), (-34.91, -8.11)]])
    dec = decodificar(rede.codificar(g))
    assert len(dec) == 2 and len(dec[0]) == 3
    for orig, novo in zip(g.geoms, dec):
        for (x1, y1), (x2, y2) in zip(orig.coords, novo):
            assert abs(x1 - x2) < 1e-5 and abs(y1 - y2) < 1e-5
    assert rede.codificar(LineString()) == []


def test_montar_base_classes():
    a = gpd.GeoDataFrame({"highway": ["primary", "residential|service", "service"]},
                         geometry=[LineString([(-34.9, -8.05), (-34.89, -8.05)]),
                                   LineString([(-34.9, -8.06), (-34.89, -8.06)]),
                                   LineString([(-34.9, -8.07), (-34.89, -8.07)])], crs=4326)
    b = rede.montar_base({"arestas": a, "bairros": None})
    assert len(b["vias"][0]) == 1 and len(b["vias"][1]) == 1       # arterial / local; 'service' fica de fora
    assert b["bairros"] == []


def test_catalogo_ruas_busca():
    """Catálogo da busca: uma linha por via com os bairros que ela corta, mesmo sem ocorrência."""
    e = gpd.GeoDataFrame({"name": ["Rua Aurora", "Rua Aurora", "Rua do Sol"], "ref": ["", "", ""]},
                         geometry=[LineString([(-34.9, -8.05), (-34.89, -8.05)]),
                                   LineString([(-34.89, -8.05), (-34.88, -8.05)]),
                                   LineString([(-34.91, -8.055), (-34.892, -8.055)])], crs=4326)
    def bd(x0, x1, nome):
        poly = shapely.box(x0, -8.06, x1, -8.04)
        return gpd.GeoDataFrame({"name": [nome]}, geometry=[poly], crs=4326)
    bairros = pd.concat([bd(-34.905, -34.895, "Casa Forte"), bd(-34.895, -34.875, "Boa Vista")])
    cat = rede.catalogo_ruas(e, bairros)
    assert isinstance(cat, list) and all(isinstance(c[1], list) for c in cat)
    d = dict(cat)
    # bairros normalizados (maiúsculas), como em D.bairros do pipeline real
    assert sorted(d["Rua Aurora"]) == ["BOA VISTA", "CASA FORTE"]   # via × bairro agrupado
    assert d["Rua do Sol"] == ["CASA FORTE"]
    assert [c[0] for c in cat] == sorted(c[0] for c in cat)                 # ordenado por nome
    assert rede.catalogo_ruas(None) == []                                   # malha ausente: nada a buscar


def test_html_comprimido_e_offline(tmp_path):
    D = {"titulo": "T", "periodo": "p", "x": list(range(1000))}
    for comp in (True, False):
        out = build.gerar_html(D, tmp_path / f"m{comp}.html", comprimir=comp)
        h = out.read_text(encoding="utf-8")
        assert "cdnjs" not in h and "unpkg" not in h                  # bibliotecas embutidas
        assert "L.map" in h or "Leaflet" in h
        m = re.search(r'<script id="dados" type="application/octet-stream" data-enc="([^"]+)">(.*?)</script>', h, re.S)
        enc, bloco = m.groups()
        bruto = gzip.decompress(base64.b64decode(bloco)) if enc == "gzip-b64" else bloco.encode()
        assert orjson.loads(bruto)["x"][-1] == 999
    assert (tmp_path / "mTrue.html").stat().st_size < (tmp_path / "mFalse.html").stat().st_size


def test_aliases_sem_titulo_somente_quando_unicos():
    e = gpd.GeoDataFrame({"name": ["Avenida Doutor Abdias de Carvalho", "Rua Doutor João Santos", "Rua João Santos",
                                   "Avenida Engenheiro Domingos Ferreira"],
                          "ref": [""] * 4},
                         geometry=[LineString([(-34.9 + i * .01, -8.05), (-34.89 + i * .01, -8.05)]) for i in range(4)],
                         crs=4326)
    ex = rede.preparar_arestas(e, None)
    chaves = set(ex["key"])
    assert {"DOUTOR ABDIAS CARVALHO", "ABDIAS CARVALHO", "DOMINGOS FERREIRA"} <= chaves
    assert "JOAO SANTOS" in chaves and "DOUTOR JOAO SANTOS" in chaves        # vias distintas, ambas presentes
    # o alias 'JOAO SANTOS' é a via real (sem título), não a 'DOUTOR JOAO SANTOS' fundida
    assert len(ex[ex["key"] == "JOAO SANTOS"]) == 1
