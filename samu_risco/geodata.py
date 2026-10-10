"""Geodados: malha viária (OSM) e camadas da Prefeitura (ciclovias, semáforos, paraciclos, bairros).

Os esquemas dos arquivos da Prefeitura ainda não foram inspecionados; por isso cada camada
passa por heurísticas de detecção de colunas e gera um relatório de perfil
(relatorio_geodados.txt) para conferência na primeira execução."""
import json
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd

from . import ckan, config, db
from .config import Pastas
from .samu import ler_csv
from .textnorm import norm_bairro, sem_acento

BBOX_RECIFE = (-35.2, -8.3, -34.7, -7.8)   # lon_min, lat_min, lon_max, lat_max


# ---------------------------------------------------------------- utilidades
def _juntar(v) -> str:
    if isinstance(v, (list, tuple, set)):
        return "|".join(str(x) for x in v)
    return v if isinstance(v, str) else ""


def _primeiro_numero(v):
    m = re.search(r"\d+", _juntar(v))
    return int(m.group()) if m else None


def ler_geo(caminho: Path) -> gpd.GeoDataFrame:
    g = gpd.read_file(caminho)
    if g.crs is None:
        minx, miny, maxx, maxy = g.total_bounds
        g = g.set_crs(4326 if max(abs(minx), abs(maxx)) <= 180 else config.CRS_M)
    return g.to_crs(4326)


def sanear(g):
    """Garante que o parquet grava: valores não escalares (listas/dicts) viram texto."""
    g = g.copy()
    for c in g.columns:
        if c == "geometry" or pd.api.types.is_numeric_dtype(g[c]) or pd.api.types.is_bool_dtype(g[c]):
            continue
        g[c] = g[c].map(lambda v: v if (v is None or isinstance(v, (str, int, float, bool))) else json.dumps(v, ensure_ascii=False, default=str))
    return g


def candidatos(slug: str, formatos: list[str]) -> list[dict]:
    """Todos os recursos do pacote nos formatos pedidos. Ordem: 'permanente' primeiro,
    depois formato preferido e, por fim, o mais recente."""
    pk = ckan.pacote(slug)
    rs = [r for r in pk.get("resources", []) if (r.get("format") or "").upper() in formatos]
    rs.sort(key=lambda r: str(r.get("last_modified") or r.get("metadata_modified") or ""), reverse=True)
    rs.sort(key=lambda r: (0 if "permanente" in sem_acento(r.get("name", "")).lower() else 1,
                           formatos.index((r.get("format") or "").upper())))
    return rs


def baixar_recurso(p: Pastas, con, slug: str, r: dict, forcar=False, log=print) -> Path:
    ext = (r.get("format") or "dat").lower()
    arq = p.raw / f"{slug}-{str(r['id'])[:8]}.{ext}"
    mod, tam = str(r.get("last_modified") or r.get("metadata_modified") or ""), int(r.get("size") or 0)
    chave = f"geo:{slug}:{r['id']}"
    if forcar or not arq.exists() or db.fonte(con, chave) != (mod, tam):
        log(f"  {slug}: baixando '{r.get('name')}' ({ext}, {tam / 1e6:.1f} MB)")
        ckan.baixar(r["url"], arq)
        db.registrar_fonte(con, chave, mod, tam)
    else:
        log(f"  {slug}: '{r.get('name')}' já atualizado")
    return arq


def escolher_recurso(slug: str, formatos: list[str]):
    """Recurso mais recente do pacote no primeiro formato disponível (por preferência)."""
    pk = ckan.pacote(slug)
    for fmt in formatos:
        cands = [r for r in pk.get("resources", []) if (r.get("format") or "").upper() == fmt]
        if cands:
            cands.sort(key=lambda r: str(r.get("last_modified") or r.get("metadata_modified") or ""))
            return cands[-1], pk
    return None, pk


def obter(p: Pastas, con, slug: str, formatos: list[str], forcar=False, log=print):
    r, _ = escolher_recurso(slug, formatos)
    if not r:
        log(f"  {slug}: nenhum recurso nos formatos {formatos}")
        return None, None
    ext = (r.get("format") or "dat").lower()
    arq = p.raw / f"{slug}.{ext}"
    mod, tam = str(r.get("last_modified") or r.get("metadata_modified") or ""), int(r.get("size") or 0)
    chave = f"geo:{slug}"
    if forcar or not arq.exists() or db.fonte(con, chave) != (mod, tam):
        log(f"  {slug}: baixando '{r.get('name')}' ({ext}, {tam / 1e6:.1f} MB)")
        ckan.baixar(r["url"], arq)
        db.registrar_fonte(con, chave, mod, tam)
    else:
        log(f"  {slug}: já atualizado")
    return arq, r


def perfil(g: pd.DataFrame, nome: str) -> list[str]:
    linhas = [f"[{nome}] {len(g)} feições"]
    if isinstance(g, gpd.GeoDataFrame):
        linhas.append(f"  geometrias: {dict(g.geom_type.value_counts())}")
    for c in g.columns:
        if c == "geometry":
            continue
        s = g[c].dropna()
        if s.empty:
            linhas.append(f"  {c}: (vazia)")
        elif s.astype(str).nunique() <= 15:
            linhas.append(f"  {c}: {dict(s.astype(str).value_counts().head(8))}")
        else:
            linhas.append(f"  {c}: {s.astype(str).nunique()} valores, ex.: {list(s.astype(str).head(2))}")
    return linhas


# ---------------------------------------------------------------- OSM
def osm_malha(p: Pastas, forcar=False, log=print) -> gpd.GeoDataFrame:
    f = p.geo / "arestas.parquet"
    if f.exists() and not forcar:
        log("  malha OSM: cache")
        return gpd.read_parquet(f)
    import osmnx as ox
    log("  malha OSM: baixando (só na primeira execução)...")
    G = ox.graph_from_place(config.LUGAR_OSM, network_type="drive")
    e = ox.graph_to_gdfs(G, nodes=False).reset_index(drop=True)
    out = gpd.GeoDataFrame({
        "name": e["name"].map(_juntar) if "name" in e else "",
        "ref": e["ref"].map(_juntar) if "ref" in e else "",
        "highway": e["highway"].map(_juntar) if "highway" in e else "",
        "maxspeed": e["maxspeed"].map(_primeiro_numero) if "maxspeed" in e else None,
        "lanes": e["lanes"].map(_primeiro_numero) if "lanes" in e else None,
        "oneway": e["oneway"].astype(str) if "oneway" in e else "",
    }, geometry=e.geometry, crs=4326)
    out.to_parquet(f)
    log(f"  malha OSM: {len(out):,} arestas")
    return out


def osm_bike(p: Pastas, forcar=False, log=print):
    """Malha de bicicleta do OSM (nós e arestas) para o roteamento; cache em parquet."""
    fa, fn = p.geo / "bike_arestas.parquet", p.geo / "bike_nos.parquet"
    if fa.exists() and fn.exists() and not forcar:
        log("  malha de bicicleta: cache")
        return pd.read_parquet(fn), gpd.read_parquet(fa)
    import osmnx as ox
    log("  malha de bicicleta: baixando do OSM (só na primeira execução)...")
    G = ox.graph_from_place(config.LUGAR_OSM, network_type="bike")
    nos, ed = ox.graph_to_gdfs(G)
    nos = pd.DataFrame({"osmid": nos.index.to_numpy(), "x": nos["x"].to_numpy(), "y": nos["y"].to_numpy()})
    ed = ed.reset_index()
    arestas = gpd.GeoDataFrame({
        "u": ed["u"].astype("int64"), "v": ed["v"].astype("int64"),
        "name": ed["name"].map(_juntar) if "name" in ed else "",
        "highway": ed["highway"].map(_juntar) if "highway" in ed else "",
        "length": ed["length"].astype(float)}, geometry=ed.geometry, crs=4326)
    nos.to_parquet(fn)
    arestas.to_parquet(fa)
    log(f"  malha de bicicleta: {len(nos):,} nós, {len(arestas):,} arestas")
    return nos, arestas


def osm_bairros(p: Pastas, log=print):
    import osmnx as ox
    for tags in ({"boundary": "administrative", "admin_level": "10"},
                 {"place": ["suburb", "neighbourhood", "quarter"]}):
        g = ox.features_from_place(config.LUGAR_OSM, tags).reset_index(drop=True)
        g = g[g.geom_type.isin(["Polygon", "MultiPolygon"]) & g["name"].notna()]
        if "admin_level" in g and (g["admin_level"].astype(str) == "10").sum() >= 20:
            g = g[g["admin_level"].astype(str) == "10"]
        g = g[(g.to_crs(config.CRS_M).area / 1e6) < 60]          # exclui município e vizinhos (>60 km²)
        g = g[g["name"].map(norm_bairro) != "RECIFE"]
        if len(g) >= 20:
            return g[["name", "geometry"]].drop_duplicates("name").reset_index(drop=True)
    return None


def osm_ciclovias(log=print):
    import osmnx as ox
    tags = {"highway": "cycleway", "cycleway": True, "cycleway:left": True,
            "cycleway:right": True, "cycleway:both": True}
    g = ox.features_from_place(config.LUGAR_OSM, tags).reset_index(drop=True)
    g = g[g.geom_type.isin(["LineString", "MultiLineString"])].copy()

    def cls(row):
        if row.get("highway") == "cycleway":
            return 0
        v = {str(row.get(c, "")) for c in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both")}
        if v & {"track", "opposite_track", "separate"}:
            return 0
        if v & {"lane", "opposite_lane"}:
            return 1
        return 2 if v - {"", "nan", "None", "no", "none"} else None
    g["classe"] = g.apply(cls, axis=1)
    g = g.dropna(subset=["classe"])
    g["classe"] = g["classe"].astype(int)
    return g[["classe", "geometry"]].set_crs(4326, allow_override=True)


# ---------------------------------------------------------------- Prefeitura
def classificar_ciclo(g: gpd.GeoDataFrame) -> tuple[pd.Series, str]:
    """Classe 0 ciclovia, 1 ciclofaixa, 2 compartilhada/ciclorrota. Usa a coluna
    categórica que mais se parece com um 'tipo'; senão, o texto da linha inteira."""
    def cls(txt):
        t = sem_acento(str(txt)).lower()
        if "ciclofaixa" in t:
            return 1
        if "ciclovia" in t:
            return 0
        if "rota" in t or "compartilh" in t:
            return 2
        return None
    melhor = None
    for c in g.columns:
        if c == "geometry" or pd.api.types.is_numeric_dtype(g[c]):
            continue
        v = g[c].dropna().astype(str)
        if v.empty or v.nunique() > 15:
            continue
        hit = v.map(lambda x: cls(x) is not None).mean()
        if hit > 0.5 and (melhor is None or hit > melhor[1]):
            melhor = (c, hit)
    if melhor:
        s = g[melhor[0]].map(cls)
        origem = f"coluna '{melhor[0]}'"
    else:
        txt = g.drop(columns="geometry").astype(str).agg(" ".join, axis=1)
        s = txt.map(cls)
        origem = "texto da linha inteira"
    return s, origem


def _pontos_de_csv(arq: Path):
    df = ler_csv(arq)
    cols = {c: c for c in df.columns}
    lat = next((c for c in cols if re.search(r"\blat|latitude", c)), None)
    lon = next((c for c in cols if re.search(r"\blon|lng|longitude", c)), None)
    if not (lat and lon):
        lat = next((c for c in cols if c in ("y", "coord_y")), lat)
        lon = next((c for c in cols if c in ("x", "coord_x")), lon)
    if not (lat and lon):
        return None, df.columns
    pdf = df.to_pandas()
    for c in (lat, lon):
        pdf[c] = pd.to_numeric(pdf[c].astype(str).str.replace(",", "."), errors="coerce")
    pdf = pdf.dropna(subset=[lat, lon])
    pdf = pdf[pdf[lon].between(BBOX_RECIFE[0], BBOX_RECIFE[2]) & pdf[lat].between(BBOX_RECIFE[1], BBOX_RECIFE[3])]
    g = gpd.GeoDataFrame(pdf, geometry=gpd.points_from_xy(pdf[lon], pdf[lat]), crs=4326)
    return g, df.columns


RX_PESADOS = re.compile(r"lote|edifica|quadra|trecho|recurso|ponte|setor|face|distrito fiscal|microrreg", re.I)


def escolher_bairros(p: Pastas, con, forcar=False, log=print):
    """Procura polígonos de bairro nos pacotes candidatos. Devolve (gdf|None, slug|None, notas)."""
    notas = []
    for slug in config.SLUGS_BAIRROS:
        try:
            rs = candidatos(slug, ["GEOJSON"])
        except Exception as e:
            notas.append(f"{slug}: pacote indisponível ({type(e).__name__}: {e})")
            continue
        pesados = [r.get("name") for r in rs if RX_PESADOS.search(r.get("name", ""))]
        if pesados:
            notas.append(f"{slug}: ignorados por serem camadas pesadas/irrelevantes: {pesados}")
        rs = [r for r in rs if not RX_PESADOS.search(r.get("name", ""))]
        rs.sort(key=lambda r: 0 if re.search(r"bairro", r.get("name", ""), re.I) else 1)
        if not rs:
            notas.append(f"{slug}: sem recurso GeoJSON utilizável")
        for r in rs:
            rotulo = f"{slug} / '{r.get('name')}'"
            try:
                g = ler_geo(baixar_recurso(p, con, slug, r, forcar, log))
                g = g[g.geom_type.isin(["Polygon", "MultiPolygon"])]
                cols = [c for c in g.columns if c != "geometry"]
                resumo = {c: int(g[c].astype(str).nunique()) for c in cols[:12]}
                achou = next((c for c in cols if re.search(r"bairro|nome|nm_|name", c, re.I)
                              and 60 <= g[c].astype(str).nunique() <= 200), None)
                notas.append(f"{rotulo}: {len(g)} polígonos; valores distintos por coluna: {resumo}"
                             + (f" -> usando '{achou}'" if achou else " -> sem coluna de bairro"))
                if achou:
                    log(f"  bairros: usando {rotulo} (coluna '{achou}')")
                    return sanear(g[[achou, "geometry"]].rename(columns={achou: "name"})), slug, notas
            except Exception as e:
                notas.append(f"{rotulo}: falhou ({type(e).__name__}: {e})")
    return None, None, notas


def geodados(p: Pastas, forcar=False, log=print) -> dict:
    con = db.conectar(p.db)
    rel, status = [], {}

    def etapa(nome, fn):
        try:
            status[nome] = fn()
        except Exception as e:
            status[nome] = None
            log(f"  [{nome}] FALHOU: {type(e).__name__}: {e}")
            rel.append(f"[{nome}] FALHOU: {type(e).__name__}: {e}")

    # malha OSM
    def _osm():
        g = osm_malha(p, forcar, log)
        rel.extend(perfil(g.drop(columns="geometry").assign(geometry=g.geometry), "OSM arestas"))
        return len(g)
    etapa("osm", _osm)

    # malha de bicicleta (roteamento)
    def _bike():
        nos, ar = osm_bike(p, forcar, log)
        rel.append(f"[OSM bicicleta] {len(nos)} nós, {len(ar)} arestas; highway: {dict(ar['highway'].str.split('|').str[0].value_counts().head(8))}")
        return len(ar)
    etapa("bike", _bike)

    # ciclovias da Prefeitura (tenta cada recurso GeoJSON; fallback OSM)
    def _ciclo_prefeitura():
        falhas = []
        rs = candidatos(config.SLUG_CICLOVIAS, ["GEOJSON", "JSON"])
        rel.append(f"[ciclovias] recursos candidatos: {[r.get('name') for r in rs]}")
        for r in rs:
            try:
                g = ler_geo(baixar_recurso(p, con, config.SLUG_CICLOVIAS, r, forcar, log))
                g = g[g.geom_type.isin(["LineString", "MultiLineString"])].copy()
                if len(g) < 3:
                    raise ValueError(f"apenas {len(g)} trechos lineares")
                g["classe"], origem = classificar_ciclo(g)
                n_nao = int(g["classe"].isna().sum())
                g["classe"] = g["classe"].fillna(2).astype(int)
                g = sanear(g)
                rel.extend(perfil(g, f"Malha cicloviária '{r.get('name')}' (classe via {origem}; {n_nao} sem tipo -> 2)"))
                rel.append(f"  classes: {dict(g['classe'].value_counts())}")
                g.to_parquet(p.geo / "ciclovias.parquet")
                return r.get("name")
            except Exception as e:
                falhas.append(f"'{r.get('name')}': {type(e).__name__}: {e}")
        raise RuntimeError("; ".join(falhas) or "nenhum recurso GeoJSON no pacote")
    try:
        status["ciclovias"] = "prefeitura: " + str(_ciclo_prefeitura())
    except Exception as e:
        msg = f"Prefeitura falhou ({type(e).__name__}: {e})"
        log(f"  [ciclovias] {msg}; tentando OSM")
        rel.append(f"[ciclovias] {msg}")
        try:
            g = osm_ciclovias(log)
            sanear(g).to_parquet(p.geo / "ciclovias.parquet")
            status["ciclovias"] = "osm"
            rel.append(f"[ciclovias] fallback OSM: {len(g)} trechos")
        except Exception as e2:
            status["ciclovias"] = None
            rel.append(f"[ciclovias] FALHOU também no OSM: {e2}")

    # semáforos
    def _sem():
        arq, r = obter(p, con, config.SLUG_SEMAFOROS, ["CSV"], forcar, log)
        g, cols = _pontos_de_csv(arq)
        if g is None:
            rel.append(f"[semáforos] colunas sem lat/lon reconhecíveis: {list(cols)}")
            return 0
        rel.extend(perfil(g, "Semáforos"))
        sanear(g).to_parquet(p.geo / "semaforos.parquet")
        return len(g)
    etapa("semaforos", _sem)

    # paraciclos
    def _para():
        arq, r = obter(p, con, config.SLUG_PARACICLOS, ["GEOJSON", "CSV"], forcar, log)
        if arq.suffix == ".csv":
            g, cols = _pontos_de_csv(arq)
            if g is None:
                rel.append(f"[paraciclos] colunas sem lat/lon: {list(cols)}")
                return 0
        else:
            g = ler_geo(arq)
        rel.extend(perfil(g, "Paraciclos"))
        sanear(g).to_parquet(p.geo / "paraciclos.parquet")
        return len(g)
    etapa("paraciclos", _para)

    # bairros
    def _bairros():
        g, slug, notas = escolher_bairros(p, con, forcar, log)
        rel.extend(f"[bairros] {n}" for n in notas)
        if g is None:
            log("  bairros: usando polígonos do OSM (filtrados: admin_level 10, sem o município)")
            g = osm_bairros(p, log)
            slug = "osm"
        if g is None:
            rel.append("[bairros] indisponíveis")
            return 0
        g["fonte"] = slug
        rel.extend(perfil(g, f"Bairros (fonte {slug})"))
        g.to_parquet(p.geo / "bairros.parquet")
        return len(g)
    etapa("bairros", _bairros)

    rel.append("[radares] não localizados no portal (ver 'Registro das Infrações'); pendente")
    (p.base / "relatorio_geodados.txt").write_text("\n".join(rel) + "\n", encoding="utf-8")
    con.close()
    return status


def carregar(p: Pastas) -> dict:
    """Camadas disponíveis em cache (None quando ausentes)."""
    def _l(nome):
        f = p.geo / f"{nome}.parquet"
        return gpd.read_parquet(f) if f.exists() else None
    out = {n: _l(n) for n in ("arestas", "ciclovias", "semaforos", "paraciclos", "bairros", "bike_arestas")}
    fn = p.geo / "bike_nos.parquet"
    out["bike_nos"] = pd.read_parquet(fn) if fn.exists() else None
    return out
