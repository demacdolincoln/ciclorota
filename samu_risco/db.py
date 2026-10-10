"""DuckDB embarcado: eventos do SAMU, controle de atualização e cache de matching."""
from pathlib import Path

import duckdb

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
  chave TEXT PRIMARY KEY, via TEXT, score INTEGER, metodo TEXT, empates TEXT);
CREATE TABLE IF NOT EXISTS match_correcoes(chave TEXT PRIMARY KEY, via TEXT);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""


def conectar(caminho: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(str(caminho))
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
