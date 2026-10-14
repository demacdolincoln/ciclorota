import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString

from samu_risco import grafo

X0, Y0, D = -34.90, -8.05, 0.001
N = 6


def nid(r, c): return 1 + r * N + c


def _malha_grade():
    nos = pd.DataFrame([{"osmid": nid(r, c), "x": X0 + c * D, "y": Y0 + r * D} for r in range(N) for c in range(N)])
    linhas = []

    def aresta(u, v, nome, hw, dois_sentidos=True, extra=None):
        pu = (X0 + ((u - 1) % N) * D, Y0 + ((u - 1) // N) * D)
        pv = (X0 + ((v - 1) % N) * D, Y0 + ((v - 1) // N) * D)
        coords = [pu] + ([extra] if extra else []) + [pv]
        g = LineString(coords)
        comp = float(gpd.GeoSeries([g], crs=4326).to_crs(31985).length.iloc[0])
        linhas.append((u, v, nome, hw, comp, g))
        if dois_sentidos:
            linhas.append((v, u, nome, hw, comp, LineString(coords[::-1])))

    for r in range(N):
        for c in range(N - 1):
            aresta(nid(r, c), nid(r, c + 1), f"Rua Linha {r}", "primary" if r == 0 else "residential",
                   dois_sentidos=(r != 3))                                        # linha 3: mão única
    for c in range(N):
        for r in range(N - 1):
            extra = (X0 + c * D + 0.0003, Y0 + r * D + 0.0005) if (c, r) == (1, 1) else None
            aresta(nid(r, c), nid(r + 1, c), f"Rua Coluna {c}", "residential", extra=extra)
    ed = gpd.GeoDataFrame(linhas, columns=["u", "v", "name", "highway", "length", "geometry"], crs=4326)
    return nos, ed


def test_montar_grafo_compacto():
    nos, ed = _malha_grade()
    ciclo = gpd.GeoDataFrame({"classe": [1]}, geometry=[LineString([(X0, Y0 + 2 * D), (X0 + 5 * D, Y0 + 2 * D)])], crs=4326)
    g = grafo.montar(nos, ed, ciclo, None, lambda nomes, b: 7 if any("Linha 2" in x for x in nomes) else -1)

    assert len(g["n"]) == 2 * N * N
    assert len(g["u"]) == 2 * N * (N - 1)                       # 60 arestas únicas (pares fundidos)
    assert sum(g["o"]) == N - 1                                 # só a linha 3 é mão única
    assert all(isinstance(x, int) for x in g["l"]) and min(g["l"]) >= 100

    nome_de = {}
    for i in range(len(g["u"])):
        nome_de[i] = (g["u"][i], g["v"][i])
    linha2 = [i for i in range(len(g["u"])) if g["f"][i] == 7]
    assert len(linha2) == N - 1
    assert all(g["c"][i] == 2 for i in linha2)                  # ciclofaixa (classe 1) -> 2
    assert sum(1 for c in g["c"] if c > 0) == N - 1             # só a linha 2 tem infraestrutura
    arteriais = [i for i in range(len(g["u"])) if g["t"][i] == 2]
    assert len(arteriais) == N - 1                              # linha 0: primary

    # geometria intermediária da aresta curva (coluna 1, entre linhas 1 e 2) é recuperável
    com_geom = [i for i, k in enumerate(g["g"]) if k >= 0]
    assert len(com_geom) == 1
    i = com_geom[0]
    d = g["gl"][g["g"][i]]
    u = g["u"][i]
    esc = g["esc"]
    mx, my = g["n"][2 * u] + d[0], g["n"][2 * u + 1] + d[1]
    assert abs(mx / esc - (X0 + 0.0003 + 1 * D * 0)) < 1e-4 or abs(my / esc - (Y0 + D + 0.0005)) < 1e-4


def test_sem_arestas_devolve_none():
    assert grafo.montar(pd.DataFrame(), gpd.GeoDataFrame({"u": [], "v": [], "name": [], "highway": [], "length": []},
                                                          geometry=[], crs=4326)) is None


def test_tipo_via():
    assert [grafo.tipo_via(x) for x in ("residential", "tertiary", "primary_link", "trunk", "cycleway", "", "service")] == [0, 1, 2, 2, 3, 0, 0]


def test_pistas_de_mao_unica_entre_os_mesmos_nos_nao_viram_mao_dupla():
    """Duas pistas opostas da mesma avenida (mesmo nome, mesmos nós, comprimento ~igual) NÃO podem ser
    fundidas numa via de mão dupla — isso liberava a contramão. A mesma via nos dois sentidos continua unida."""
    def aresta(u, v, nome, hw, comp, coords):
        return dict(u=u, v=v, name=nome, highway=hw, length=comp, geometry=LineString(coords))
    norte = [(0, 0), (0.001, 0.0002), (0.002, 0)]
    sul = [(0.002, 0), (0.001, -0.0002), (0, 0)]
    e = gpd.GeoDataFrame([
        aresta(1, 2, "Av X", "primary", 100.2, norte), aresta(2, 1, "Av X", "primary", 100.3, sul),     # pistas separadas
        aresta(2, 3, "Rua Y", "residential", 50.0, [(0.002, 0), (0.003, 0)]),                         # mão dupla de verdade
        aresta(3, 2, "Rua Y", "residential", 50.0, [(0.003, 0), (0.002, 0)]),
        aresta(3, 4, "Rua Z", "residential", 80.0, [(0.003, 0), (0.003, 0.001)]),                     # mão única
    ], crs=4326)
    por_nome = {}
    for u, v, ow, _g, _l, _hw, nome in grafo._unir_sentidos(e):
        por_nome.setdefault(nome, []).append((u, v, ow))
    assert sorted(por_nome["Av X"]) == [(1, 2, 1), (2, 1, 1)]          # duas arestas de mão única
    assert por_nome["Rua Y"] == [(2, 3, 0)]                            # uma aresta de mão dupla
    assert por_nome["Rua Z"] == [(3, 4, 1)]


def test_aresta_sem_trecho_proprio_herda_o_trecho_mais_proximo_da_mesma_via():
    """Avenida longa em vários bairros: o bairro do meio não tem trecho de risco próprio. A aresta dele deve herdar o
    risco do trecho da MESMA via mais PRÓXIMO — e não o do primeiro trecho em ordem alfabética (arbitrário, podia ser
    um trecho de baixo risco e fazer um pedaço da avenida perigosa parecer segura para o roteador)."""
    from shapely.geometry import LineString
    from samu_risco import build
    from samu_risco.textnorm import normalizar

    k = normalizar("Avenida Caxangá")
    destino = {(k, "ALFA"): 0, (k, "ZULU"): 1}                       # ALFA = calmo (1º alfabético), ZULU = perigoso
    fgeo = [(k, LineString([(0, 0), (1000, 0)])), (k, LineString([(3000, 0), (4000, 0)]))]
    r = build.criar_resolver(destino, fgeo)
    assert r(["Avenida Caxangá"], "ALFA", (500, 0)) == 0                # bairro com trecho: casamento exato
    assert r(["Avenida Caxangá"], "MEIO", (2800, 0)) == 1               # sem trecho: o mais próximo (ZULU), não o 1º (ALFA)
    assert r(["Avenida Caxangá"], "MEIO", (1200, 0)) == 0               # perto do outro lado → ALFA
    assert r(["Avenida Caxangá"], "MEIO") == 0                           # sem ponto: mantém o fallback antigo
    assert r(["Rua Inexistente"], "ALFA", (0, 5000)) == -1              # nome desconhecido e longe de qualquer trecho
    assert r([], "ALFA", (0, 5000)) == -1


def test_aresta_sem_nome_herda_o_trecho_de_risco_mais_proximo_ate_25m():
    """Ciclovia (aresta sem nome) paralela a uma avenida crítica: a nota associa o ponto da rota ao trecho mais próximo
    (até 25 m); o roteador também precisa, senão a ciclovia vira "sem registro" e o roteador a prefere à avenida."""
    from shapely.geometry import LineString
    from samu_risco import build
    from samu_risco.textnorm import normalizar

    k = normalizar("Avenida Caxangá")
    destino = {(k, "ALFA"): 0}
    r = build.criar_resolver(destino, [(k, LineString([(0, 0), (1000, 0)]))])
    assert r([], "ALFA", (500, 10)) == 0                     # sem nome, a 10 m da avenida → herda o trecho
    assert r(["Ciclovia do Capibaribe"], "ALFA", (500, 20)) == 0   # nome sem casamento, a 20 m → idem
    assert r([], "ALFA", (500, 40)) == -1                    # a 40 m: fora do raio → sem registro
    assert r([], "ALFA") == -1                               # sem ponto, nada a fazer
