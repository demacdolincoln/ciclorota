"""Coleta do SAMU (portal de dados abertos do Recife) -> DuckDB.

O datastore do portal limita cada chamada a 500 linhas; por isso o coletor baixa o
CSV anual (um pedido por ano) e é incremental (compara data de modificação e tamanho)."""
import io
import re
from pathlib import Path

import polars as pl

from . import ckan, db
from .config import Pastas, classificar_subtipo
from .textnorm import sem_acento

RX_ANO = re.compile(r"samu-(\d{4})$")
COLS_MODERNO = ["data", "hora_minuto", "municipio", "bairro", "endereco", "origem_chamado",
                "tipo", "subtipo", "sexo", "idade", "motivo_finalizacao", "motivo_desfecho"]


# ---------------------------------------------------------------- descoberta
def descobrir() -> list[dict]:
    """Um recurso 'Solicitações' (CSV) por ano de SAMU publicado no portal."""
    achados = {}
    for d in ckan.buscar_pacotes("samu", rows=100):
        m = RX_ANO.search(d.get("name", ""))
        if not m:
            continue
        cands = [r for r in d.get("resources", [])
                 if (r.get("format") or "").upper() == "CSV"
                 and "solicitac" in sem_acento(r.get("name", "")).lower()]
        if not cands:
            continue
        r = cands[0]
        ano = int(m.group(1))
        achados[ano] = dict(
            ano=ano, dataset=d["name"], recurso=r["id"], nome=r.get("name", ""),
            url=r["url"], tamanho=int(r.get("size") or 0),
            modificado=str(r.get("last_modified") or r.get("metadata_modified") or ""))
    return [achados[a] for a in sorted(achados)]


# ---------------------------------------------------------------- leitura
def ler_csv(caminho: Path) -> pl.DataFrame:
    """CSV do portal: separador e codificação detectados; tudo como texto."""
    bruto = caminho.read_bytes()
    try:
        texto = bruto.decode("utf-8-sig")
    except UnicodeDecodeError:
        texto = bruto.decode("cp1252", errors="replace")
    primeira = texto.split("\n", 1)[0]
    sep = max([";", ",", "\t"], key=primeira.count)
    df = pl.read_csv(io.BytesIO(texto.encode("utf-8")), separator=sep, quote_char='"',
                     infer_schema_length=0, truncate_ragged_lines=True)
    return df.rename({c: c.strip().lower() for c in df.columns})


def tipo_esquema(colunas) -> str:
    s = set(colunas)
    if {"endereco", "subtipo", "municipio"} <= s:
        return "moderno"
    if "solicitacao_numero" in s or "solicitacao_data" in s:
        return "legado"
    return "desconhecido"


def _txt(df, nome, maiusculo=True):
    if nome not in df.columns:
        return pl.lit(None, dtype=pl.Utf8).alias(nome)
    e = pl.col(nome).cast(pl.Utf8).str.strip_chars()
    return (e.str.to_uppercase() if maiusculo else e).alias(nome)


def _data(df, nome):
    if nome not in df.columns:
        return pl.lit(None, dtype=pl.Date)
    s = pl.col(nome).cast(pl.Utf8).str.slice(0, 10)
    return pl.coalesce(s.str.to_date("%Y-%m-%d", strict=False),
                       s.str.to_date("%d/%m/%Y", strict=False))


def _num(df, nome):
    if nome not in df.columns:
        return pl.lit(None, dtype=pl.Float64)
    return pl.col(nome).cast(pl.Utf8).str.replace(",", ".").cast(pl.Float64, strict=False)


def _sem_acento_col(df: pl.DataFrame, nome: str) -> pl.DataFrame:
    """Remove acentos de uma coluna de texto (via valores únicos) para casar 'TRÂNSITO' com 'TRANSITO'."""
    if nome not in df.columns:
        return df
    m = {v: sem_acento(v) for v in df[nome].drop_nulls().unique().to_list()}
    return df.with_columns(pl.col(nome).replace_strict(m, default=None))


def harmonizar_moderno(df: pl.DataFrame, ano_fonte: int) -> pl.DataFrame:
    out = df.select(
        _data(df, "data").alias("data"),
        (pl.col("hora_minuto").cast(pl.Utf8).str.slice(0, 8)
         if "hora_minuto" in df.columns else pl.lit(None, dtype=pl.Utf8)).alias("hora_minuto"),
        _txt(df, "municipio"), _txt(df, "bairro"), _txt(df, "endereco"),
        _txt(df, "origem_chamado"), _txt(df, "tipo"), _txt(df, "subtipo"), _txt(df, "sexo"),
        _num(df, "idade").alias("idade"),
        _txt(df, "motivo_finalizacao", False), _txt(df, "motivo_desfecho", False),
    )
    for c in ("municipio", "subtipo", "tipo"):
        out = _sem_acento_col(out, c)
    return out.with_columns(
        pl.lit(ano_fonte).cast(pl.Int32).alias("ano_fonte"),
        pl.col("data").dt.year().fill_null(ano_fonte).cast(pl.Int32).alias("ano"),
    ).select(["ano_fonte", "ano"] + COLS_MODERNO)


def harmonizar_legado(df: pl.DataFrame, ano_fonte: int) -> pl.DataFrame:
    def t(nome, novo, maiusculo=True):
        return _txt(df, nome, maiusculo).alias(novo)
    ts = (pl.col("solicitacao_data").cast(pl.Utf8) if "solicitacao_data" in df.columns
          else pl.lit(None, dtype=pl.Utf8))
    out = df.select(
        t("solicitacao_numero", "numero", False),
        _data(df, "solicitacao_data").alias("data"),
        ts.str.slice(11, 8).alias("hora_minuto"),
        t("paciente_sexo", "sexo"),
        _num(df, "paciente_idadeanos").alias("idade"),
        t("bairrosaude_descricao", "bairro"),
        t("origemchamado_descricao", "origem_chamado"),
        t("situacaosolicitacao_descricao", "situacao"),
        t("sistemasaude_descricao", "sistema_saude"),
    )
    return out.with_columns(
        pl.lit(ano_fonte).cast(pl.Int32).alias("ano_fonte"),
        pl.col("data").dt.year().fill_null(ano_fonte).cast(pl.Int32).alias("ano"),
    ).select(["ano_fonte", "ano", "numero", "data", "hora_minuto", "sexo", "idade",
              "bairro", "origem_chamado", "situacao", "sistema_saude"])


# ---------------------------------------------------------------- ingestão
def _gravar(con, tabela: str, df: pl.DataFrame, ano_fonte: int):
    con.execute(f"DELETE FROM {tabela} WHERE ano_fonte=?", [ano_fonte])
    con.register("tmp_df", df.to_arrow())
    cols = ", ".join(df.columns)
    con.execute(f"INSERT INTO {tabela}({cols}) SELECT {cols} FROM tmp_df")
    con.unregister("tmp_df")


def _diag_moderno(bruto: pl.DataFrame, h: pl.DataFrame) -> str:
    faltam = [c for c in COLS_MODERNO if c not in bruto.columns]
    extras = [c for c in bruto.columns if c not in COLS_MODERNO]
    rec = h.filter(pl.col("municipio") == "RECIFE")
    mapa = {x: classificar_subtipo(x) for x in rec["subtipo"].drop_nulls().unique().to_list()}
    ok = [k for k, v in mapa.items() if v]
    n_ac = rec.filter(pl.col("subtipo").is_in([k for k in ok if mapa[k][1] == "Acidente"])).height
    n_at = rec.filter(pl.col("subtipo").is_in([k for k in ok if mapa[k][1] == "Atropelamento"])).height
    nao = (rec.filter(~pl.col("subtipo").is_in(ok)).group_by("subtipo").len()
              .sort("len", descending=True).head(8))
    return (f"trânsito RECIFE mapeado: acidentes {n_ac}, atropelamentos {n_at} | colunas ausentes {faltam} | "
            f"colunas extras {extras} | subtipos NÃO mapeados (top) {dict(nao.iter_rows())}")


def _linha_relatorio(info, esquema, df_bruto, df_h) -> str:
    n = df_bruto.height
    if esquema == "moderno":
        pe = 100 * df_h["endereco"].drop_nulls().filter(df_h["endereco"].drop_nulls() != "").len() / max(n, 1)
        rec = df_h.filter((pl.col("municipio") == "RECIFE")).height
        extra = f"endereço preenchido {pe:.0f}% | linhas RECIFE {rec} | " + _diag_moderno(df_bruto, df_h)
    elif esquema == "legado":
        extra = "SEM endereço/subtipo (esquema legado) - não usado no risco por via"
    else:
        extra = "ESQUEMA DESCONHECIDO - dados não importados"
    dmin = df_h["data"].min() if esquema != "desconhecido" else None
    dmax = df_h["data"].max() if esquema != "desconhecido" else None
    return (f"{info['ano']} | {esquema:<11} | {n:>7} linhas | {len(df_bruto.columns):>2} colunas | "
            f"{dmin} a {dmax} | {extra}")


def coletar(p: Pastas, anos=None, forcar=False, log=print) -> list[str]:
    con = db.conectar(p.db)
    recursos = descobrir()
    if anos:
        recursos = [r for r in recursos if r["ano"] in set(anos)]
    log(f"Recursos SAMU encontrados: {len(recursos)} ({recursos[0]['ano']}–{recursos[-1]['ano']})"
        if recursos else "Nenhum recurso SAMU encontrado.")
    relatorio = []
    for info in recursos:
        chave = f"samu:{info['ano']}"
        arq = p.raw / f"samu_{info['ano']}.csv"
        atual = db.fonte(con, chave)
        if (not forcar and atual == (info["modificado"], info["tamanho"]) and arq.exists()):
            log(f"  {info['ano']}: já atualizado, pulando")
            continue
        log(f"  {info['ano']}: baixando {info['tamanho'] / 1e6:.1f} MB ...")
        ckan.baixar(info["url"], arq)
        bruto = ler_csv(arq)
        esq = tipo_esquema(bruto.columns)
        if esq == "moderno":
            h = harmonizar_moderno(bruto, info["ano"])
            _gravar(con, "samu_eventos", h, info["ano"])
        elif esq == "legado":
            h = harmonizar_legado(bruto, info["ano"])
            _gravar(con, "samu_legado", h, info["ano"])
        else:
            h = bruto
            log(f"  aviso: colunas desconhecidas em {info['ano']}: {bruto.columns}")
        if esq != "desconhecido":
            db.registrar_fonte(con, chave, info["modificado"], info["tamanho"])
        linha = _linha_relatorio(info, esq, bruto, h)
        relatorio.append(linha)
        log("    " + linha)
    if relatorio:
        (p.base / "relatorio_samu.txt").write_text("\n".join(relatorio) + "\n", encoding="utf-8")
    con.close()
    return relatorio


def relatorio_local(p: Pastas, log=print) -> list[str]:
    """Refaz o relatório com os CSV já baixados em dados/raw (sem acessar a rede)."""
    out = []
    for arq in sorted(p.raw.glob("samu_*.csv")):
        ano = int(arq.stem.split("_")[1])
        bruto = ler_csv(arq)
        esq = tipo_esquema(bruto.columns)
        h = (harmonizar_moderno(bruto, ano) if esq == "moderno"
             else harmonizar_legado(bruto, ano) if esq == "legado" else bruto)
        linha = _linha_relatorio({"ano": ano}, esq, bruto, h)
        if esq == "legado":
            linha += f" | colunas: {bruto.columns}"
        out.append(linha)
        log(linha)
    if out:
        (p.base / "relatorio_samu.txt").write_text("\n".join(out) + "\n", encoding="utf-8")
    return out
