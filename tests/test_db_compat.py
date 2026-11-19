"""`consulta_pl` precisa funcionar no duckdb 1.x e no 2.x (onde `.pl()` foi removido)."""
import datetime as dt

import duckdb
import polars as pl

from samu_risco.db import consulta_pl


def _con():
    con = duckdb.connect()
    con.execute("CREATE TABLE t(ano INTEGER, data DATE, idade DOUBLE, nome TEXT)")
    con.execute("INSERT INTO t VALUES (2023, DATE '2023-05-01', 30.5, 'a'), (2024, DATE '2024-06-02', NULL, 'b'), "
                "(2024, DATE '2024-07-03', 7, NULL)")
    return con


def test_tipos_preservados_e_parametros():
    df = consulta_pl(_con(), "SELECT * FROM t WHERE ano >= ? ORDER BY data", [2024])
    assert isinstance(df, pl.DataFrame) and df.height == 2
    assert df.schema["ano"] == pl.Int32 and df.schema["data"] == pl.Date and df.schema["idade"] == pl.Float64
    assert df["data"].to_list() == [dt.date(2024, 6, 2), dt.date(2024, 7, 3)]
    assert df["idade"].to_list() == [None, 7.0] and df["nome"].to_list() == ["b", None]


def test_resultado_vazio_mantem_colunas():
    df = consulta_pl(_con(), "SELECT ano, nome FROM t WHERE ano > ?", [3000])
    assert df.height == 0 and df.columns == ["ano", "nome"]


def test_conexao_reutilizavel_depois():
    con = _con()
    consulta_pl(con, "SELECT * FROM t")
    assert con.execute("SELECT count(*) FROM t").fetchall() == [(3,)]
