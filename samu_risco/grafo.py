"""Grafo de bicicleta compacto (para roteamento no navegador).

Formato (listas de inteiros, uma posição por aresta):
  n  : [x0, y0, x1, y1, ...]  posições dos nós em graus*1e5
  u,v: nós extremos | l: comprimento (m) | f: id da feature de risco da via (-1 = sem registro)
  c  : infraestrutura cicloviária (0 nenhuma, 1 ciclovia, 2 ciclofaixa, 3 compartilhada)
  t  : tipo de via (0 local, 1 coletora, 2 arterial, 3 exclusiva/não motorizada)
  o  : 1 = só sentido u->v (mão única) | g: índice em `gl` (pontos intermediários) ou -1
  gl : listas [dx1, dy1, dx2, dy2, ...] a partir da posição do nó u (graus*1e5)
"""
import numpy as np
import pandas as pd
import geopandas as gpd
import shapely

from . import config, rede

NAO_MOTORIZADA = {"cycleway", "path", "footway", "pedestrian", "track", "steps", "bridleway"}


def tipo_via(hw: str) -> int:
    base = (hw or "").split("|")[0].replace("_link", "")
    if base in {"motorway", "trunk", "primary", "secondary"}:
        return 2
    if base == "tertiary":
        return 1
    if base in NAO_MOTORIZADA:
        return 3
    return 0


def _unir_sentidos(arestas: gpd.GeoDataFrame) -> list[tuple]:
    """MultiDiGraph -> arestas únicas: (u, v, mao_unica, geometria u->v, comprimento, highway, name)."""
    e = arestas.reset_index(drop=True).copy()
    e = e[e["u"] != e["v"]]
    e["name"] = e["name"].fillna("")
    e["highway"] = e["highway"].fillna("")
    e["fw"] = e["u"] < e["v"]
    # O ponto médio (~1 m) entra na assinatura: as duas pistas de mão única de uma avenida que
    # ligam os MESMOS nós têm nome e comprimento quase iguais, mas geometrias distintas — sem isto
    # eram fundidas numa só via de mão dupla e o roteador passava a permitir a contramão.
    # (o sentido inverso da MESMA via tem o mesmo ponto médio, então continua casando)
    mid = shapely.line_interpolate_point(e.geometry.values, 0.5, normalized=True)
    mx, my = np.round(shapely.get_x(mid), 5), np.round(shapely.get_y(mid), 5)
    e["sig"] = (np.minimum(e["u"], e["v"]).astype(str) + "-" + np.maximum(e["u"], e["v"]).astype(str) + "-" +
                e["length"].round(0).astype(int).astype(str) + "-" + e["name"] + "-" +
                pd.Series(mx, index=e.index).astype(str) + "," + pd.Series(my, index=e.index).astype(str))
    fw = e[e["fw"]].drop_duplicates("sig").set_index("sig").to_dict("index")
    bw = e[~e["fw"]].drop_duplicates("sig").set_index("sig").to_dict("index")
    out = []
    for sig in dict.fromkeys(list(fw) + list(bw)):
        if sig in fw and sig in bw:
            r, ow = fw[sig], 0
        else:
            r, ow = (fw.get(sig) or bw[sig]), 1
        out.append((int(r["u"]), int(r["v"]), ow, r["geometry"], float(r["length"]), r["highway"], r["name"]))
    return out


def montar(nos: pd.DataFrame, arestas: gpd.GeoDataFrame, ciclo=None, bairros=None, resolver=None,
           esc: int = 100000):
    """Monta o grafo compacto. `resolver(lista_de_nomes, bairro_norm) -> fid|-1` liga a aresta ao risco."""
    if arestas is None or not len(arestas):
        return None
    rows = _unir_sentidos(arestas)
    if not rows:
        return None
    ids = sorted({r[0] for r in rows} | {r[1] for r in rows})
    idx = {n: i for i, n in enumerate(ids)}
    pos = {}
    if nos is not None and len(nos):
        pos = {int(o): (x, y) for o, x, y in zip(nos["osmid"], nos["x"], nos["y"])}
    for u, v, ow, g, *_ in rows:                 # nós ausentes: usa os extremos da geometria
        c = list(g.coords)
        pos.setdefault(u, (c[0][0], c[0][1]))
        pos.setdefault(v, (c[-1][0], c[-1][1]))
    n = []
    for nid in ids:
        x, y = pos[nid]
        n += [int(round(x * esc)), int(round(y * esc))]

    geoms = gpd.GeoSeries([r[3] for r in rows], crs=4326).to_crs(config.CRS_M)
    simp = geoms.simplify(2.0)
    xs = [shapely.get_x(shapely.line_interpolate_point(simp.values, f, normalized=True)) for f in (.25, .5, .75)]
    ys = [shapely.get_y(shapely.line_interpolate_point(simp.values, f, normalized=True)) for f in (.25, .5, .75)]
    simp4 = simp.to_crs(4326)

    c_arr = np.zeros(len(rows), dtype=int)
    if ciclo is not None and len(ciclo):
        cm = ciclo.to_crs(config.CRS_M)
        for cl in sorted(cm["classe"].unique(), reverse=True):      # classe menor sobrescreve por último
            poly = shapely.union_all(cm.loc[cm["classe"] == cl].geometry.buffer(15).values)
            hits = sum(shapely.contains_xy(poly, xs[k], ys[k]).astype(int) for k in range(3))
            c_arr = np.where(hits >= 2, int(cl) + 1, c_arr)
    hw = [r[5] for r in rows]
    t_arr = np.array([tipo_via(h) for h in hw])
    c_arr = np.where((c_arr == 0) & np.array([h.split("|")[0] == "cycleway" for h in hw]), 1, c_arr)

    bairro = rede.bairro_por_ponto(gpd.GeoSeries(shapely.points(xs[1], ys[1]), crs=config.CRS_M), bairros)
    out = {"esc": esc, "n": n, "u": [], "v": [], "l": [], "f": [], "c": c_arr.tolist(), "t": t_arr.tolist(),
           "o": [], "g": [], "gl": []}
    for i, (u, v, ow, g, comp, h, nome) in enumerate(rows):
        out["u"].append(idx[u]); out["v"].append(idx[v]); out["o"].append(ow)
        out["l"].append(max(1, int(round(comp))))
        nomes = [x for x in nome.split("|") if x.strip()]
        out["f"].append(int(resolver(nomes, bairro[i])) if (resolver and nomes) else -1)
        co = np.asarray(simp4.iloc[i].coords)[:, :2]
        if len(co) > 2:
            ix, iy = np.round(co[1:-1, 0] * esc).astype(np.int64), np.round(co[1:-1, 1] * esc).astype(np.int64)
            px, py = int(round(pos[u][0] * esc)), int(round(pos[u][1] * esc))
            d = []
            for a, b in zip(ix, iy):
                d += [int(a) - px, int(b) - py]
                px, py = int(a), int(b)
            out["g"].append(len(out["gl"])); out["gl"].append(d)
        else:
            out["g"].append(-1)
    return out
