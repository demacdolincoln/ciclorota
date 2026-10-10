"""Gera o HTML de teste do front-end (dados sintéticos + grafo com um caminho paralelo).
Uso:  python tests/js/gerar_html.py     (a partir da raiz do projeto)"""
import datetime as dt
import json
import pathlib
import sys
import tempfile

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from samu_risco import build, config, db, geodata, samu          # noqa: E402
from tests.mockdata import Mock                                    # noqa: E402
from tests.test_fluxo import _bike_de, _malha                      # noqa: E402

OUT = pathlib.Path(__file__).parent / "out"
OUT.mkdir(exist_ok=True)
m = Mock().popular()
config.API = m.api
p = config.pastas(tempfile.mkdtemp() + "/d")
samu.coletar(p, log=lambda *a: None)
_malha(p)
geodata.osm_malha = lambda p, forcar=False, log=print: gpd.read_parquet(p.geo / "arestas.parquet")
geodata.geodados(p, log=lambda *a: None)
con, geo = db.conectar(p.db), geodata.carregar(p)
ar = geo["arestas"][geo["arestas"]["name"] != ""]
nos, ed = _bike_de(ar)
aur = ar[ar["name"].str.contains("Aurora")].iloc[0].geometry          # via de maior risco
c = list(aur.coords); A, B = c[0], c[-1]; off = 0.0004                # caminho paralelo 44 m ao norte
nos = pd.concat([nos, pd.DataFrame([{"osmid": 10_000, "x": A[0], "y": A[1] + off}, {"osmid": 10_001, "x": B[0], "y": B[1] + off}])], ignore_index=True)
perto = lambda pt: int(nos.assign(d=(nos.x - pt[0]) ** 2 + (nos.y - pt[1]) ** 2).sort_values("d").iloc[0].osmid)


def ln(u, v, pu, pv):
    g = LineString([pu, pv]); comp = float(gpd.GeoSeries([g], crs=4326).to_crs(31985).length.iloc[0])
    return [(u, v, "", "residential", comp, g), (v, u, "", "residential", comp, LineString([pv, pu]))]


extra = (ln(perto(A), 10_000, A, (A[0], A[1] + off)) + ln(10_000, 10_001, (A[0], A[1] + off), (B[0], B[1] + off))
         + ln(10_001, perto(B), (B[0], B[1] + off), B))
ed = gpd.GeoDataFrame(pd.concat([ed, gpd.GeoDataFrame(extra, columns=list(ed.columns), crs=4326)], ignore_index=True), crs=4326)
geo["bike_nos"], geo["bike_arestas"] = nos, ed
D = build.montar_dados(p, con, geo, log=lambda *a: None)
build.gerar_html(D, OUT / "mapa.html")
n = 30; t0 = dt.datetime(2026, 10, 6, 15, 10, tzinfo=dt.timezone.utc)             # terça 12:10 local
pts = "".join(f'<trkpt lat="{A[1] + (B[1] - A[1]) * i / n:.6f}" lon="{A[0] + (B[0] - A[0]) * i / n:.6f}"><time>'
              f'{(t0 + dt.timedelta(seconds=10 * i)).strftime("%Y-%m-%dT%H:%M:%SZ")}</time></trkpt>' for i in range(n + 1))
(OUT / "aurora.gpx").write_text(f'<?xml version="1.0"?><gpx version="1.1"><trk><name>Ida pela Aurora</name><trkseg>{pts}</trkseg></trk></gpx>')
json.dump({"A": [A[1], A[0]], "B": [B[1], B[0]]}, open(OUT / "pontos.json", "w"))
print("gerado:", OUT / "mapa.html")
