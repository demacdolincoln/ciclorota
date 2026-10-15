import base64
import gzip
import re
import unicodedata

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
                                   LineString([(-34.91, -8.06), (-34.892, -8.06)])], crs=4326)
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


def test_nomes_legiveis_na_busca():
    """Reproduz o bug do mapa real: as properties de D.geo traziam só o nome canônico do OSM
    ('R AURORA', chave 'AURORA' após normalizar), que nenhum índice do front-end conhece —
    RUAS_BUSCA guarda o nome de exibição ('Rua Aurora') e irParaRua casa pelo nome legível.
    Sem 'd' nas features, digitar na busca nunca encontrava a via desenhada no mapa.
    Com nomes_legiveis=True cada feature carrega 'd' na forma de exibição."""
    e = gpd.GeoDataFrame({"name": ["Rua Aurora", "Rua Aurora"], "ref": ["", ""],
                          "bairro": ["AURORA", "AURORA"]},
                         geometry=[LineString([(-34.9, -8.05), (-34.89, -8.05)]),
                                   LineString([(-34.89, -8.05), (-34.88, -8.05)])], crs=4326)
    ex = rede.preparar_arestas(e, None, com_alias=False)
    k = str(ex["key"].iloc[0])                       # normalizar('Rua Aurora') -> 'AURORA' (canônica)
    assert k == "AURORA"
    nomes_exib = {k: "Rua Aurora"}                   # forma mais frequente (raw), como no build
    ruas, feats, _ = rede.montar_features(ex, {(k, "AURORA")}, nomes_exib, {}, False)
    assert ruas[0]["n"] == "Rua Aurora"
    assert not any(f["properties"].get("d") for f in feats)      # padrão: nada muda p/ quem não pede
    _, feats, _ = rede.montar_features(ex, {(k, "AURORA")}, nomes_exib, {}, False,
                                       nomes_legiveis=True)
    assert all(f["properties"]["d"] == "Rua Aurora" for f in feats)

    def norm_busca(s):                               # ~ normBusca do front-end (sem acento + lower)
        return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()
    alvo = norm_busca("rua aurora")                  # como RUAS_BUSCA indexa D.ruas_osm
    assert any(norm_busca(f["properties"]["d"]) == alvo for f in feats)   # legível casa com o catálogo
    # sem 'd' a busca fica muda: 'n' é a forma crua/canônica ('R AURORA' -> exibição 'Rua Aurora'),
    # que normBusca jamais iguala ao nome de exibição indexado pelo front-end
    cru = [dict(f["properties"], n="R AURORA") for f in feats]
    assert not any(norm_busca(p["n"]) == alvo for p in cru)


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
