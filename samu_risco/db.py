"""DuckDB embarcado: eventos do SAMU, controle de atualização e cache de matching."""
from pathlib import Path

import duckdb
import polars as pl

SCHEMA = """
CREATE TABLE IF NOT EXISTS fontes(
  chave TEXT PRIMARY KEY, modificado TEXT, tamanho BIGINT, baixado_em TIMESTAMP DEFAULT now());
CREATE TABLE IF NOT EXISTS samu_eventos(
  ano_fonte INTEGER, ano INTEGER, data DATE, hora_minuto TEXT, municipio TEXT, bairro TEXT, endereco TEXT,
  origem_chamado TEXT, tipo TEXT, subtipo TEXT, sexo TEXT, idade DOUBLE,
  motivo_finalizacao TEXT, motivo_desfecho TEXT);
CREATE TABLE IF NOT EXISTS samu_legado(
  ano_fonte INTEGER, ano INTEGER, numero TEXT, data DATE, hora_minuto TEXT, sexo TEXT, idade DOUBLE, bairro TEXT,
  origem_chamado TEXT, situacao TEXT, sistema_saude TEXT);
CREATE TABLE IF NOT EXISTS match_cache(
  chave TEXT, bairro TEXT, via TEXT, score INTEGER, metodo TEXT, empates TEXT, sugestao TEXT,
  PRIMARY KEY(chave, bairro));
CREATE TABLE IF NOT EXISTS match_correcoes(chave TEXT PRIMARY KEY, via TEXT);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""


def consulta_pl(con: duckdb.DuckDBPyConnection, sql: str, params: list | None = None) -> pl.DataFrame:
    """Executa `sql` e devolve um DataFrame do polars, em qualquer versão do duckdb.

    O atalho `con.execute(...).pl()` existe no duckdb 1.x mas foi REMOVIDO no 2.0 (onde `execute()` devolve a própria
    conexão, sem `.pl()`/`.arrow()`/`.fetch_arrow_table()`). Usa a relação (`con.sql`), que é o caminho recomendado no
    2.x (o caminho via `execute()` faz uma cópia extra e emite UserWarning), e passa pelo Arrow, que preserva os tipos.
    O nome do método que entrega a tabela Arrow mudou entre versões, então tenta os conhecidos e só então cai para
    `fetchall()`.
    """
    rel = con.sql(sql, params=params or None)
    for nome in ("to_arrow_table", "fetch_arrow_table"):
        f = getattr(rel, nome, None)
        if f is not None:
            return pl.from_arrow(f())
    colunas = list(rel.columns)
    return pl.DataFrame(rel.fetchall(), schema=colunas, orient="row")


def conectar(caminho: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(caminho))
    # migração de bancos antigos: match_cache com chave primária simples (sem bairro)
    # é incompatível com o schema atual — a tabela é só cache, pode ser recriada.
    try:
        cols = [r[0] for r in con.execute("DESCRIBE match_cache").fetchall()]
    except Exception:
        cols = []
    if cols and "bairro" not in cols:
        con.execute("DROP TABLE match_cache")
    con.execute(SCHEMA)
    return con


def fonte(con, chave):
    r = con.execute("SELECT modificado, tamanho FROM fontes WHERE chave=?", [chave]).fetchone()
    return r


def registrar_fonte(con, chave, modificado, tamanho):
    con.execute("DELETE FROM fontes WHERE chave=?", [chave])
    con.execute("INSERT INTO fontes(chave, modificado, tamanho) VALUES (?,?,?)",
                [chave, str(modificado), int(tamanho or 0)])


def meta_get(con, k, padrao=None):
    r = con.execute("SELECT v FROM meta WHERE k=?", [k]).fetchone()
    return r[0] if r else padrao


def meta_set(con, k, v):
    con.execute("DELETE FROM meta WHERE k=?", [k])
    con.execute("INSERT INTO meta VALUES (?,?)", [k, str(v)])
