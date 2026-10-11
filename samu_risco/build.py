"""Montagem dos dados e geração do HTML (tratamento de eventos 100% em polars)."""
import base64
import gzip
import re
from pathlib import Path

import numpy as np
import orjson
import polars as pl

from . import config, grafo as grafo_mod, matching, rede
from .config import (DIAS, FAIXAS, MESES, MUNICIPIO, NATUREZAS, PERIODOS, VEICULOS, Pastas,
                     classificar_subtipo)
from .textnorm import norm_bairro, normalizar, sem_titulos


# ---------------------------------------------------------------- eventos
def carregar_eventos(con) -> pl.DataFrame:
    """Eventos de trânsito do município. A classificação (veículo, natureza) usa os nomes
    canônicos e os antigos (2016-2020) via config.classificar_subtipo."""
    subs = [r[0] for r in con.execute(
        "SELECT DISTINCT subtipo FROM samu_eventos WHERE municipio=? AND subtipo IS NOT NULL", [MUNICIPIO]).fetchall()]
    mapa = {x: classificar_subtipo(x) for x in subs}
    mapa = {k: v for k, v in mapa.items() if v}
    if not mapa:
        return pl.DataFrame(schema={"ano": pl.Int32, "data": pl.Date, "hora_minuto": pl.Utf8, "bairro": pl.Utf8,
                                    "endereco": pl.Utf8, "subtipo": pl.Utf8, "sexo": pl.Utf8, "idade": pl.Float64,
                                    "veiculo": pl.Utf8, "natureza": pl.Utf8})
    ph = ",".join("?" * len(mapa))
    df = con.execute(
        f"SELECT ano, data, hora_minuto, bairro, endereco, subtipo, sexo, idade "
        f"FROM samu_eventos WHERE municipio=? AND subtipo IN ({ph}) AND data IS NOT NULL",
        [MUNICIPIO, *mapa]).pl()
    tab = pl.DataFrame({"subtipo": list(mapa), "veiculo": [v[0] for v in mapa.values()],
                        "natureza": [v[1] for v in mapa.values()]})
    df = (df.join(tab, on="subtipo", how="inner")
            .with_columns(pl.col("hora_minuto").str.slice(0, 2).cast(pl.Int8, strict=False).alias("hora"),
                          (pl.col("data").dt.month() - 1).cast(pl.Int8).alias("mes"),
                          (pl.col("data").dt.weekday() - 1).cast(pl.Int8).alias("dow"))
            .drop_nulls(["hora"]).filter(pl.col("hora").is_between(0, 23)))
    return df.with_columns(
        pl.when(pl.col("hora") < 6).then(0).when(pl.col("hora") < 12).then(1)
          .when(pl.col("hora") < 18).then(2).otherwise(3).alias("per"),
        pl.when(pl.col("idade").is_null() | (pl.col("idade") < 0) | (pl.col("idade") > 110)).then(6)
          .when(pl.col("idade") < 12).then(0).when(pl.col("idade") < 18).then(1)
          .when(pl.col("idade") < 30).then(2).when(pl.col("idade") < 45).then(3)
          .when(pl.col("idade") < 60).then(4).otherwise(5).alias("faixa"),
        pl.col("sexo").fill_null("").replace({"": "N/I"}).alias("sexo"),
    )


def com_chaves(df: pl.DataFrame) -> pl.DataFrame:
    """Acrescenta `key` (via normalizada) e `bnorm` (bairro normalizado)."""
    nm = {a: normalizar(a) for a in df["endereco"].fill_null("").unique().to_list()}
    bm = {b: norm_bairro(b) for b in df["bairro"].fill_null("").unique().to_list()}
    return df.with_columns(
        pl.col("endereco").fill_null("").replace_strict(nm, default="").alias("key"),
        pl.col("bairro").fill_null("").replace_strict(bm, default="").alias("bnorm"))


def resumo_chaves(df: pl.DataFrame):
    g = df.group_by("key").agg(pl.col("endereco").first().alias("ex"), pl.len().alias("n"))
    return dict(zip(g["key"], g["ex"])), dict(zip(g["key"], g["n"]))


# ---------------------------------------------------------------- dados do HTML
def montar_dados(p: Pastas, con, geo: dict, log=print) -> dict:
    if geo.get("arestas") is None:
        raise RuntimeError("Malha viária ausente: rode `geodados` antes de `gerar`.")
    df = carregar_eventos(con)
    if df.is_empty():
        raise RuntimeError("Sem eventos de trânsito no banco: rode `coletar` antes de `gerar`.")
    log(f"Eventos de trânsito em {MUNICIPIO}: {df.height:,} "
        f"({df['data'].min()} a {df['data'].max()})")
    df = com_chaves(df)

    ex = rede.preparar_arestas(geo["arestas"], geo.get("bairros"))
    osm_keys = list(ex["key"].unique())
    vpb = ex.groupby("key")["bairro"].agg(set).to_dict()
    corte = matching.corte_atual(p)
    log(f"Vias únicas no OSM (chaves): {len(osm_keys):,}")
    pares_df = df.select("key", "bnorm").unique()
    # bairro por chave: moda dos bairros das ocorrências com esse endereço — é assim que o
    # contexto da ocorrência chega ao matching (antes `pontuar` aceitava bairros mas ninguém passava).
    cont_b = df.group_by(["key", "bnorm"]).len().sort(["key", "len"], descending=[False, True])
    bairro_por_chave = dict(zip(cont_b["key"].to_list(), cont_b["bnorm"].to_list()))
    res = matching.casar(con, df["key"].unique().to_list(), osm_keys, corte, log, vpb, bairro_por_chave)

    rodovias = [k for k in osm_keys if k[:3] in ("BR ", "PE ")]
    linhas = []
    for k, b in pares_df.iter_rows():
        via, sc, met, emp, sug = res[k]
        if not via and sug:                              # abaixo do corte: sugestão também sente o bairro
            sug = matching.desempatar(sug, emp, b, vpb)
        elif k in ("BR", "PE"):                          # rodovia sem número: só uma no bairro -> inferida
            via = matching.resolver_rodovia(k, b, rodovias, vpb)
            sc = 95 if via else sc
        linhas.append((k, b, via, sc))
    pares = {(v, b) for _, b, v, _ in linhas if v}
    sub = ex[ex["key"].isin({v for v, _ in pares})].reset_index(drop=True)
    nomes_exib = sub.groupby("key")["raw"].agg(lambda s: s.value_counts().index[0]).to_dict()
    bairros_exib = {}
    if geo.get("bairros") is not None:
        bairros_exib = {norm_bairro(n): n for n in geo["bairros"]["name"]}
    ruas, features, destino = rede.montar_features(sub, pares, nomes_exib, bairros_exib)

    mapa = pl.DataFrame({
        "key": [l[0] for l in linhas], "bnorm": [l[1] for l in linhas],
        "via": [l[2] for l in linhas], "score": [l[3] for l in linhas],
        "fid": [destino[(l[2], l[1])] if l[2] else -1 for l in linhas]},
        schema_overrides={"via": pl.Utf8})
    df = df.join(mapa, on=["key", "bnorm"], how="left")

    bnomes = sorted(b for b in df["bairro"].drop_nulls().unique().to_list() if str(b).strip())
    sexos = sorted(df["sexo"].unique().to_list())
    anos = sorted(df["ano"].unique().to_list())
    df = df.with_columns(
        pl.col("veiculo").replace_strict({v: i for i, v in enumerate(VEICULOS)}).alias("vi"),
        pl.col("natureza").replace_strict({v: i for i, v in enumerate(NATUREZAS)}).alias("ni"),
        pl.col("sexo").replace_strict({v: i for i, v in enumerate(sexos)}).alias("si"),
        pl.col("bairro").replace_strict({v: i for i, v in enumerate(bnomes)}, default=-1).alias("bi"),
        pl.col("ano").replace_strict({v: i for i, v in enumerate(anos)}).alias("ai"))
    arr = (df.select("fid", "vi", "ni", "mes", "dow", "hora", "per", "si", "faixa", "bi", "ai")
             .cast(pl.Int64).to_numpy())

    # Anos com classificação consistente: a parcela de acidentes (não atropelamentos) deve ser relevante.
    # Em 2016-2020 só os atropelamentos têm subtipo reconhecível; incluí-los distorce comparações.
    por_ano = {a: df.filter(pl.col("ano") == a) for a in anos}
    padrao = [i for i, a in enumerate(anos)
              if por_ano[a].height and por_ano[a].filter(pl.col("natureza") == "Acidente").height / por_ano[a].height >= 0.35]
    if not padrao:
        padrao = list(range(len(anos)))
    aviso_anos = ""
    if len(padrao) < len(anos):
        fora = [str(anos[i]) for i in range(len(anos)) if i not in padrao]
        aviso_anos = ("Anos selecionados por padrão: " + ", ".join(str(anos[i]) for i in padrao) +
                      ". Em " + ", ".join(fora) + " quase só atropelamentos têm subtipo reconhecível "
                      "(outra classificação do SAMU); incluí-los distorce comparações.")

    n, loc = df.height, int(df["via"].is_not_null().sum())
    exato = int(df.filter(pl.col("via").is_not_null() & (pl.col("score") == 100)).height)
    qual = {"total": n, "localizadas": loc, "exato": exato, "fuzzy": loc - exato,
            "sem_match": n - loc, "corte": corte}
    log(f"Localizadas: {loc:,}/{n:,} ({100 * loc / max(n, 1):.1f}%) - exato {exato:,}, fuzzy {loc - exato:,} (corte {corte})")

    # não casados para revisão
    nc = (df.filter(pl.col("via").is_null())
            .group_by("endereco", "key").agg(pl.len().alias("ocorrencias"))
            .sort("ocorrencias", descending=True))
    nc = nc.with_columns(pl.col("key").map_elements(lambda k: res[k][4] or "", return_dtype=pl.Utf8).alias("sugestao"),
                         pl.col("key").map_elements(lambda k: res[k][1], return_dtype=pl.Int64).alias("score"))
    nc.write_csv(p.base / "nao_casados.csv", separator=";")
    log(f"Relatório de não casados: {p.base / 'nao_casados.csv'} ({nc.height} endereços)")

    top = df.filter(pl.col("via").is_not_null()).group_by("via").len().sort("len", descending=True).head(15)
    print("\nTOP 15 VIAS (geral):")
    for v, c in top.iter_rows():
        print(f"  {c:5d}  {nomes_exib.get(v, v)}")

    grafo = None
    if geo.get("bike_arestas") is not None:
        fid_por_via = {}
        for (k, _b), f in destino.items():
            fid_por_via.setdefault(k, f)

        def resolver(nomes, bn):
            for nm in nomes:
                k = normalizar(nm)
                for kk in ((k, sem_titulos(k)) if k else ()):
                    for chave in ((kk, bn), (kk, "*")):
                        if chave in destino:
                            return destino[chave]
                    if kk in fid_por_via:
                        return fid_por_via[kk]
            return -1
        grafo = grafo_mod.montar(geo.get("bike_nos"), geo["bike_arestas"], geo.get("ciclovias"),
                                 geo.get("bairros"), resolver)
        if grafo:
            log(f"Grafo de bicicleta: {len(grafo['n']) // 2:,} nós, {len(grafo['u']):,} arestas "
                f"({sum(1 for f in grafo['f'] if f >= 0):,} com risco da via)")

    return {
        "titulo": f"Acidentes e atropelamentos – {MUNICIPIO.title()} (SAMU)",
        "periodo": f"{df['data'].min()} a {df['data'].max()}",
        "veic": VEICULOS, "nat": NATUREZAS, "per": PERIODOS, "faixa": FAIXAS, "sexo": sexos,
        "bairros": bnomes, "meses": MESES, "meses_ok": sorted(df["mes"].unique().to_list()),
        "dias": DIAS, "anos": anos, "anos_padrao": padrao, "aviso_anos": aviso_anos, "ruas": ruas,
        "geo": {"type": "FeatureCollection", "features": features},
        "ev": arr.tolist(), "qual": qual,
        "ciclo": rede.montar_ciclovias(geo.get("ciclovias")),
        "base": rede.montar_base(geo), "grafo": grafo,
        "pontos": {"semaforos": rede.pontos(geo.get("semaforos")),
                   "paraciclos": rede.pontos(geo.get("paraciclos"))},
    }


# ---------------------------------------------------------------- HTML
def _templates() -> Path:
    for c in (Path(__file__).parent / "templates", Path(__file__).parent.parent / "templates"):
        if (c / "index.html").exists():
            return c
    raise FileNotFoundError("pasta templates/ não encontrada")


def _vendor(t: Path) -> tuple[str, str]:
    """Bibliotecas embutidas (uso offline): devolve (<style>, <script>s)."""
    v = t / "vendor"
    css = re.sub(r"url\(images/[^)]*\)", "none", (v / "leaflet.css").read_text(encoding="utf-8"))
    js = ""
    for nome in ("leaflet.js", "leaflet-heat.js", "chart.umd.js"):
        src = (v / nome).read_text(encoding="utf-8")
        assert "</script" not in src, nome
        js += f"<script>{src}\n</script>\n"
    return f"<style>{css}</style>", js


def gerar_html(D: dict, destino: Path, comprimir: bool = True) -> Path:
    t = _templates()
    bruto = orjson.dumps(D, option=orjson.OPT_SERIALIZE_NUMPY)
    if comprimir:
        enc, bloco = "gzip-b64", base64.b64encode(gzip.compress(bruto, 9)).decode()
    else:
        enc, bloco = "json", bruto.decode().replace("</", "<\\/")
    vcss, vjs = _vendor(t)
    html = ((t / "index.html").read_text(encoding="utf-8")
            .replace("{{TITULO}}", D["titulo"]).replace("{{PERIODO}}", D["periodo"])
            .replace("{{VENDOR_CSS}}", vcss).replace("{{VENDOR_JS}}", vjs)
            .replace("{{CSS}}", (t / "style.css").read_text(encoding="utf-8"))
            .replace("{{DADOS}}", f'<script id="dados" type="application/octet-stream" data-enc="{enc}">{bloco}</script>')
            .replace("{{JS}}", (t / "app.js").read_text(encoding="utf-8")
                     .replace("/*@@ROTAS@@*/", (t / "rotas.js").read_text(encoding="utf-8"))))
    destino.write_text(html, encoding="utf-8")
    return destino
