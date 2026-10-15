"""Geometria das vias: arestas por nome normalizado, bairro da aresta e features compactas."""
import re

import geopandas as gpd
import numpy as np
import shapely

from . import config
import pandas as pd

from .textnorm import normalizar, norm_bairro, sem_titulos


def bairro_por_ponto(pts: gpd.GeoSeries, bairros, tol: float = 0.0) -> list[str]:
    """Bairro (normalizado) de cada ponto (CRS métrico). Polígonos sobrepostos: vale o menor.
    Sem polígonos: lista de ''. `tol` > 0 aceita pontos até essa distância da borda do polígono
    (within estrito perde vias-divisa cujo centro cai exatamente na fronteira)."""
    if bairros is None or not len(bairros):
        return [""] * len(pts)
    b = bairros.to_crs(config.CRS_M).copy()
    b["bnorm"] = b["name"].map(norm_bairro)
    b["area"] = b.geometry.area
    g = gpd.GeoDataFrame(geometry=pts.reset_index(drop=True), crs=config.CRS_M)
    pred = "dwithin" if tol else "within"
    j = gpd.sjoin(g, b[["bnorm", "area", "geometry"]], how="left", predicate=pred,
                  **({"distance": tol} if tol else {}))
    j = j.sort_values("area")
    j = j[~j.index.duplicated(keep="first")]
    return j["bnorm"].reindex(g.index).fillna("").tolist()


def preparar_arestas(edges: gpd.GeoDataFrame, bairros, com_alias: bool = True) -> gpd.GeoDataFrame:
    """Uma linha por (aresta, nome de via): chave normalizada e bairro da aresta.

    `com_alias=False` pula a criação de chaves-alias sem título: alias é uma via
    DIFERENTE no ranking do matching (duas linhas para o mesmo nome), então só faz
    sentido quando os nomes já são as chaves-canônicas do OSM (pipeline real)."""
    e = edges.to_crs(config.CRS_M).reset_index(drop=True)
    # ponto médio com tolerance: o within estrito descarta arestas cujo centro cai na borda do
    # polígono do bairro (vias-divisa; a reprojeção deixa ~mm de erro). 1 m não cruza para o
    # bairro vizinho em nenhuma via real (divisas são retificadas no mesmo CRS métrico)
    e["bairro"] = bairro_por_ponto(e.geometry.interpolate(0.5, normalized=True), bairros, tol=1.0)
    nomes = e["name"].fillna("").str.split("|")
    refs = e["ref"].fillna("").str.replace(";", "|").str.split("|")
    refs = refs.map(lambda L: [r for r in L if re.match(r"^\s*(BR|PE)\s*-?\s*\d{2,3}", r.upper())])
    e["raw"] = [[n for n in a if n.strip()] + r for a, r in zip(nomes, refs)]
    ex = e.explode("raw").dropna(subset=["raw"]).reset_index(drop=True)
    cache = {r: normalizar(r) for r in ex["raw"].unique()}
    ex["key"] = ex["raw"].map(cache)
    ex = ex[ex["key"] != ""].reset_index(drop=True)
    return com_aliases(ex) if com_alias else ex


def bairros_por_via(ex: gpd.GeoDataFrame) -> dict:
    """key da via -> conjunto de bairros (normalizados) por onde ela passa."""
    return ex.groupby("key")["bairro"].agg(set).to_dict()


def com_aliases(ex: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Para cada via com título honorífico ('DOUTOR ABDIAS CARVALHO') cria também a chave sem título
    ('ABDIAS CARVALHO'), desde que ela não colida com outra via. Evita falhas de matching por título."""
    cheias = set(ex["key"].unique())
    alias = {}
    for k in cheias:
        a = sem_titulos(k)
        if a != k and len(a) >= 3:
            alias.setdefault(a, set()).add(k)
    inv = {next(iter(ks)): a for a, ks in alias.items() if len(ks) == 1 and a not in cheias}
    if not inv:
        return ex
    extra = ex[ex["key"].isin(inv)].copy()
    extra["key"] = extra["key"].map(inv)
    return pd.concat([ex, extra], ignore_index=True)


def _geom_via(geoms):
    return shapely.line_merge(shapely.union_all(geoms))   # dissolve mãos duplas


def codificar(g, esc: int = 100000) -> list[list[int]]:
    """Linhas -> listas de inteiros [x0, y0, dx1, dy1, ...] (graus * esc, deltas).
    Decodificação no JS: ver `decLinhas` em app.js."""
    if g is None or g.is_empty:
        return []
    partes = [g] if g.geom_type == "LineString" else [x for x in getattr(g, "geoms", []) if x.geom_type == "LineString"]
    out = []
    for ln in partes:
        c = np.asarray(ln.coords)[:, :2]
        xs, ys = np.round(c[:, 0] * esc).astype(np.int64), np.round(c[:, 1] * esc).astype(np.int64)
        inter = np.empty(2 * (len(xs) - 1), dtype=np.int64)
        inter[0::2], inter[1::2] = np.diff(xs), np.diff(ys)
        out.append([int(xs[0]), int(ys[0])] + inter.tolist())
    return out


def montar_features(ex, pares, nomes_exib, bairros_exib, devolver_geoms=False, nomes_legiveis=False):
    """pares: {(via, bairro_norm)}. Uma feature por (via, bairro) ou pela via inteira
    quando ela não tem arestas naquele bairro.

    `nomes_legiveis=True` acrescenta "d" (nome de exibição + bairro) nos properties —
    sem isso a busca por rua ficava muda no mapa real: as propriedades só trazem o nome
    CANÔNICO do OSM ('R AURORA'), que nenhum índice do front-end conhece; com os nomes
    de exibição de D.ruas/D.ruas_osm ('Rua Aurora') nada casava."""
    geoms = ex.geometry.values
    por_grupo = ex.groupby(["key", "bairro"]).indices
    por_rua = ex.groupby("key").indices
    rua_idx, ruas = {}, []
    for k in sorted({k for k, _ in pares}):
        g = _geom_via(geoms[por_rua[k]])
        rua_idx[k] = len(ruas)
        ruas.append({"n": nomes_exib[k], "km": round(g.length / 1000, 3)})
    destino, feats_g, feats_p, feats_k = {}, [], [], []
    for k, b in sorted(pares):
        alvo = (k, b) if (k, b) in por_grupo else (k, "*")
        if alvo not in destino:
            idx = por_grupo[alvo] if alvo[1] != "*" else por_rua[k]
            g = _geom_via(geoms[idx])
            destino[alvo] = len(feats_g)
            feats_g.append(g); feats_k.append(k)
            p = {"r": rua_idx[k], "n": nomes_exib[k],
                 "b": bairros_exib.get(alvo[1], "") if alvo[1] != "*" else "",
                 "km": round(g.length / 1000, 3)}
            if nomes_legiveis:                             # forma legível p/ a busca (app.js lê f.properties.d)
                p["d"] = nomes_exib[k] + (" — " + p["b"].title() if p["b"] else "")
            feats_p.append(p)
        destino[(k, b)] = destino[alvo]
    fgeo = list(zip(feats_k, feats_g))            # (via, geometria em metros) por fid — liga arestas sem trecho ao mais próximo
    if not feats_g:
        return (ruas, [], destino, fgeo) if devolver_geoms else (ruas, [], destino)
    gs = gpd.GeoSeries(feats_g, crs=config.CRS_M).simplify(config.SIMPLIFICAR_M).to_crs(4326)
    rp = gs.representative_point()
    features = []
    for g, p, c in zip(gs.values, feats_p, rp.values):
        p["c"] = [round(c.y, 5), round(c.x, 5)]
        features.append({"properties": p, "g": codificar(g)})
    return (ruas, features, destino, fgeo) if devolver_geoms else (ruas, features, destino)


def montar_ciclovias(g) -> dict:
    out = {"classes": config.CLASSES_CICLO, "feats": []}
    if g is None or len(g) == 0:
        return out
    g = g.to_crs(config.CRS_M)
    for c in sorted(g["classe"].unique()):
        geom = shapely.line_merge(shapely.union_all(g.loc[g["classe"] == c].geometry.values))
        geom = gpd.GeoSeries([geom], crs=config.CRS_M).simplify(config.SIMPLIFICAR_M).to_crs(4326).iloc[0]
        out["feats"].append({"c": int(c), "g": codificar(geom)})
    return out


def pontos(g, limite=20000) -> list:
    """[[lat, lon], ...] com 5 casas (≈1 m); aceita pontos e usa o centroide de outras geometrias."""
    if g is None or len(g) == 0:
        return []
    c = g.geometry.centroid if (g.geom_type != "Point").any() else g.geometry
    return [[round(p.y, 5), round(p.x, 5)] for p in c.to_crs(4326).head(limite) if p is not None and not p.is_empty]


ARTERIAIS = {"motorway", "trunk", "primary", "secondary", "tertiary",
             "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}


def _lin_wgs84(geom, tol):
    geom = gpd.GeoSeries([geom], crs=config.CRS_M).simplify(tol).to_crs(4326).iloc[0]
    return codificar(geom)


def catalogo_ruas(arestas, bairros=None) -> list:
    """Catálogo de ruas/logradouros da malha OSM para a busca do painel: uma linha por
    via, ['nome', [bairros que ela corta]] — ordenada por nome. Inclui vias sem nenhuma
    ocorrência registrada (o ranking e D.ruas só têm as com registro; a busca precisa
    achar qualquer logradouro). Nomes exibidos: forma mais frequente; bairros na ordem
    em que aparecem no dataset (como em D.bairros). Vias fora dos polígonos (bairro '')
    entram com a lista vazia — continuam localizáveis pela lupa."""
    if arestas is None or not len(arestas):
        return []
    ex = preparar_arestas(arestas, bairros)
    raws = ex.groupby("key")["raw"].agg(lambda s: s.value_counts().index[0])
    ordem_bairro = {b: i for i, b in enumerate(ex.loc[ex["bairro"] != "", "bairro"].unique())}
    grupos: dict[str, set] = {raws[k]: set() for k in raws.index}
    for bn, k in zip(ex["bairro"], ex["key"]):
        if bn:
            grupos[raws[k]].add(bn)
    return sorted(([n, sorted(bs, key=lambda b: ordem_bairro[b])] for n, bs in grupos.items()),
                  key=lambda x: x[0])


def montar_base(geo: dict) -> dict:
    """Base vetorial para uso sem internet: contornos de bairros e malha viária em 2 classes."""
    out = {"bairros": [], "vias": [[], []]}
    b = geo.get("bairros")
    if b is not None and len(b):
        lin = shapely.union_all(b.to_crs(config.CRS_M).boundary.values)
        out["bairros"] = _lin_wgs84(lin, 5.0)
    a = geo.get("arestas")
    if a is not None and len(a):
        a = a.to_crs(config.CRS_M)
        hw = (a["highway"].fillna("").str.split("|").str[0] if "highway" in a else None)
        eh_art = hw.isin(ARTERIAIS) if hw is not None else np.zeros(len(a), bool)
        nao_serv = ~hw.isin({"service", "track", "path", "footway", "cycleway", "steps"}) if hw is not None else np.ones(len(a), bool)
        for i, m in enumerate((eh_art, ~eh_art & nao_serv)):
            sel = a.geometry.values[np.asarray(m)]
            if len(sel):
                out["vias"][i] = _lin_wgs84(shapely.line_merge(shapely.union_all(sel)), 3.0)
    return out
