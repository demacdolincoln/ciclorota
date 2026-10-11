"""Casamento endereço -> via do OSM (exato + fuzzy) e calibração do corte.

Algoritmo v5 — reescrito a partir da evidência da calibração manual (rótulos S/N):

- Score único e comparável entre candidatos: S = 0,6·Afinidade + 0,4·Bruto (0..100).
  Afinidade = média, sobre os tokens do nome próprio do endereço, da melhor
  similaridade de edição com um token do candidato; Bruto = token_sort_ratio entre
  nomes próprios (sem títulos/prefixos/genéricos). Não existe mais "penalização"
  aplicada só ao escolhido: a genericidade está no score de cada candidato, então
  a via certa com 85 pode vencer a errada com 86 (decisão global, não só empates).
- Typos são perdoados pela afinidade ('FRASCISCO JASINTO' ≈ 88, 'LE PARQUE' ~
  'RUA LE PARQUE' = 100 quando o nome próprio é idêntico), mas topônimos derivados
  ('ECA QUEIROZ' ~ 'CAJUEIRO') caem bem abaixo do corte calibrado e viram apenas
  sugestão na amostra de revisão — nunca match automático.
- Bairro participa da decisão de forma defensiva (+3 se a via passa pelo bairro da
  ocorrência, −6 se tem ≥2 tokens e nenhum aparece no vocabulário do bairro):
  inclinado, nunca vetando — grafias divergentes de bairro não destroem um bom match.
- Cache invalidado por (hash do OSM, VERSAO_ALGORITMO): mudanças aqui recomputam
  automaticamente para quem já rodou o pipeline.
"""
import csv
import hashlib
import io
import json
import random
from collections import defaultdict
from pathlib import Path

import numpy as np
from rapidfuzz import fuzz, process
from rapidfuzz.distance import Levenshtein

from . import config, db
from .textnorm import HONORIFICOS, norm_bairro, sem_titulos

CORTE_MIN = 70            # piso de calibração: igual à primeira faixa da amostra (70-80).
                          # Baixar para 60 fez o avaliar recomendar corte 60 aceitando,
                          # sem nunca terem sido rotulados, candidatos 60-69. Se quiser
                          # julgar essa faixa, crie a faixa no gerar_amostra ANTES de baixar.
VERSAO_ALGORITMO = 7      # mude a cada ajuste de pontuação/desempate (invalida o match_cache)

# Palavras que não distinguem uma via de outra (topônimos naturais e complementos).
# No score só o nome próprio pesa; 'CORREGO IMBAUBA' vs 'CORREGO JAQUEIRA' não é
# similaridade, é a palavra genérica repetida.
GENERICAS = {
    "CORREGO", "RIO", "CANAL", "LAGOA", "LAGO", "MANGUE", "BREJO", "IGARAPE",
    "SN", "S/N", "E", "S",
}
# Prefixos/títulos de logradouro: comuns a quase todas as vias, não diferenciam nada.
TITULOS = {
    "RUA", "AV", "AVENIDA", "TRAVESSA", "TV", "PRACA", "PRAÇA", "PCA", "PC", "AL",
    "ALAMEDA", "VIELA", "ESTRADA", "EST", "ROD", "RODOVIA", "RADIAL", "VIADUTO",
    "PASSAGEM", "PASSEIO", "BOULEVARD", "BLC", "BLOCO", "LOT", "LOTE", "LT", "VILA",
    "CONJ", "CONJUNTO", "RES", "RESIDENCIAL", "COM", "COMERCIAL", "CAMPO", "ILHA",
    "MATA", "PONTE", "ELEVADO", "MARGINAL", "CONTORNO", "RAMPA", "ENTRADA", "SAIDA",
    "SAÍDA", "ACO", "AÇO", "TRECHO", "PROL", "DOUTOR", "DR", "DRª", "ENG", "CEL",
    "TEN", "TENENTE", "CAP", "MAJ", "GEN", "PADRE", "FREI", "SANTO", "SANTA", "SAO",
    "SÃO", "DOM", "NOSSA", "SR", "SENHOR",
}
# Conectores de topônimo que podem aparecer omitidos no endereço ('CORREGO IMBAUBA'
# ~ 'CORREGO DO IMBAUBA').
CONECTORES = {"DO", "DA", "DOS", "DAS", "D", "E"}
# Chaves que nunca são vias (modo/desconhecido registrados no campo endereço).
NAO_VIA = {
    "CICLISTA", "BIKE", "BICICLETA", "MOTO", "MOTOCICLETA", "PEDESTRE", "A PE", "AUTO",
    "CARRO", "VEICULO", "ONIBUS", "CAMINHAO", "VAN", "TAXI", "MOTORISTA", "CONDUTOR",
    "VITIMA", "ACIDENTE", "SEM LOCAL", "OUTROS", "IGNORADO", "N", "S",
}


def _tokens(k: str) -> list[str]:
    return [t for t in k.split() if t not in GENERICAS]


def _distinguir(k: str) -> list[str]:
    """Tokens que diferenciam a via: sem genéricos, títulos/prefixos e conectores."""
    return [t for t in _tokens(k) if t not in TITULOS and t not in CONECTORES]


def _proprio(k: str, *, com_honorifico: bool = False) -> str:
    """Nome próprio da via: sem genéricos, títulos/prefixos e conectores.

    `com_honorifico=True` preserva DOUTOR/SANTO etc. quando o endereço os traz —
    é a forma usada na régua de 'exato': 'DOUTOR JAYME FONTE' só é idêntico a um
    OSM que também traz o título; contra 'RUA X SANTO Y' (título como parte do
    topônimo) não pode colapsar em match exato."""
    skip = TITULOS if not com_honorifico else (TITULOS - HONORIFICOS)
    p = [t for t in _tokens(k) if t not in skip]
    return " ".join(p) if p else k


# ---------------------------------------------------------------- afinidade por token
_AFIN_CACHE: dict[tuple, dict] = {}


def _afinidade(vocab_osm: list[str], pend_tokens: list[str]) -> dict:
    """Matriz de similaridade (0..1) entre tokens dos endereços e o vocabulário das vias.

    Uma única `cdist` (pendentes × vocabulário OSM) — o laço antigo comparava cada
    token com todo o vocabulário em Python (~16 ms/token). Tokens que só aparecem
    nos endereços precisam da linha completa (o candidato pode não conter nenhum token
    deles, e é isso que derruba 'ECA QUEIROZ' ~ 'CAJUEIRO'); para os demais basta a
    coluna diagonal (=1). Cache keyed por (vocabulário, pendentes); mantém ≤2 entradas.
    Retorna D como ndarray float32 (linhas densas, ~4 MB p/ 2k×9k tokens; listas de
    Python estouravam a RAM — 830 MB de pico no teste sintético).
    Sem `score_cutoff`: zerar similaridades <70 tornava o mesmo par inconsistente
    conforme o token existia ou não no OSM ('PARQUE~PARC' valia 78 ou 60).
    """
    chave = (hash(tuple(vocab_osm)), hash(frozenset(pend_tokens)))
    v = _AFIN_CACHE.get(chave)
    if v is not None:
        return v
    idx = {w: i for i, w in enumerate(vocab_osm)}
    pos = {t: i for i, t in enumerate(pend_tokens)}
    D = np.zeros((len(pend_tokens), len(vocab_osm)), dtype=np.float32)
    if pend_tokens and vocab_osm:
        precisas = [t for t in pend_tokens if t in idx]      # token existe no OSM: só a coluna dele
        if precisas:
            Dprec = process.cdist(precisas, vocab_osm, scorer=fuzz.ratio, workers=-1,
                                  dtype=np.float32) / 100.0
            for a, t in enumerate(precisas):
                D[pos[t]] = Dprec[a]
        extras = [t for t in pend_tokens if t not in idx]     # token ausente do OSM: linha completa
        if extras:
            De = process.cdist(extras, vocab_osm, scorer=fuzz.ratio, workers=-1,
                               dtype=np.float32) / 100.0
            for a, t in enumerate(extras):
                D[pos[t]] = De[a]
    while len(_AFIN_CACHE) >= 2:
        _AFIN_CACHE.pop(next(iter(_AFIN_CACHE)))
    v = dict(D=D, idx=idx, pos=pos)
    _AFIN_CACHE[chave] = v
    return v


def _rank_candidatos(k: str, bairro: str | None, vocab: dict, osm_arr: np.ndarray,
                     toksets: list[set], linha_bruto: np.ndarray,
                     bairros_por_via: dict[str, set] | None,
                     tokens_bairro: set | None) -> list[tuple[int, str]]:
    """Todos os candidatos com bruto ≥ CORTE_MIN, ordenados por prioridade global.

    Prioridade = S + bônus de bairro (inclinado, não veta). Retorna
    [(score_int, via, afinidade)] com escore truncado em 0..100."""
    T = _distinguir(k)
    D, idx, pos = vocab["D"], vocab["idx"], vocab["pos"]
    js = np.flatnonzero(linha_bruto >= CORTE_MIN)
    saida = []
    for j in js:
        v = str(osm_arr[j])
        bruto = int(linha_bruto[j])
        C = toksets[j]
        if T and C:
            afin = sum(max(D[pos[t]][idx[c]] for c in C) for t in T) / len(T)
        else:
            afin = 1.0 if set(T) == C else 0.0
        s = 60.0 * afin + 40.0 * bruto / 100.0
        if bairros_por_via is not None and bairro:
            if bairro in bairros_por_via.get(v, ()):
                s += 3.0
            elif tokens_bairro is not None and len(T) >= 2 and not (set(T) & tokens_bairro):
                s -= 6.0          # nenhuma palavra que diferencia a via existe no bairro
        saida.append((int(round(min(s, 100.0))), v, afin))
    saida.sort(key=lambda x: (-x[0], x[1]))
    return saida


def _moda_bairro(df) -> dict:
    """chave -> bairro mais frequente das ocorrências daquele endereço (modo).

    Ordenar por contagem e dar `dict(zip(...))` deixa vencer o ÚLTIMO par — ou seja,
    o bairro MENOS frequente (bug confirmado: Caxangá×5 vs Várzea×2 escolhia Várzea).
    Aqui cada chave guarda explicitamente a maior contagem."""
    cont = df.group_by(["key", "bnorm"]).len().sort(["key", "len"], descending=[False, True])
    moda: dict = {}
    for k, b, _n in cont.iter_rows():
        if k not in moda:                 # primeira linha por chave = maior contagem
            moda[k] = b
    return moda


def pontuar(chaves: list[str], osm_keys: list[str],
            bairros_por_via: dict[str, set] | None = None,
            bairro_por_chave: dict[str, str] | None = None) -> dict:
    """Melhor candidato para cada chave (independente do corte calibrado).
    Retorna chave -> (via|None, score, metodo, [outros candidatos por prioridade]).

    `bairros_por_via` + `bairro_por_chave` (chave -> bairro normalizado da ocorrência):
    participam da prioridade global de cada candidato (ver `_rank_candidatos`) — não
    apenas do desempate entre iguais, pois a via certa precisa poder vencer a errada.
    """
    osm = np.array(sorted(set(osm_keys)))
    osm_set = set(osm.tolist())
    props = [_proprio(v) for v in osm.tolist()]
    toksets = [{t for t in _tokens(v) if t not in TITULOS} for v in osm.tolist()]
    vocab_osm = sorted({t for s in toksets for t in s})
    vocab_idx = {w: i for i, w in enumerate(vocab_osm)}
    res, pend = {}, []
    # alias de título só quando a forma SEM título NÃO existe como nome próprio no OSM.
    # 'BOSCO' ~ 'DOM BOSCO' tem o MESMO nome próprio — são vias distintas e o fuzzy decide;
    # 'ABDIAS CARVALHO' ~ 'DOUTOR ABDIAS CARVALHO' difere só pelo título (HONORIFICOS), é alias.
    # Ambíguo (mais de uma via para a mesma forma) NÃO vira exato: vai ao fuzzy.
    props_sem = {_proprio(sem_titulos(v)) for v in osm_set}
    # nomes próprios de vias que EXISTEM SEM título no OSM: se 'X' existe, um endereço 'X'
    # é a via 'X', não alias de 'DOUTOR X' (mesmo nome próprio — o fuzzy decide).
    props_exatos = {_proprio(v) for v in osm_set if sem_titulos(v) == v}
    props_sem -= props_exatos
    sem_titulo_a_via: dict[str, set] = {}
    for v in osm_set:
        st = sem_titulos(v)
        # a via OSM traz honorífico que não faz parte do nome próprio dela E o nome próprio
        # dela NÃO existe como via autônoma no OSM — senão 'BOSCO' viraria alias de
        # 'DOM BOSCO', que são vias distintas.
        if st != v and _proprio(st) not in props_sem:
            sem_titulo_a_via.setdefault(_proprio(st), set()).add(v)
    sem_titulo_a_via = {p: next(iter(vs)) for p, vs in sem_titulo_a_via.items() if len(vs) == 1}
    # alias no sentido inverso: endereço traz título que o OSM não tem ('DOUTOR X' -> 'X').
    # só quando 'X' existe no OSM e o nome próprio COM honorífico do endereço colapsa ao
    # remover só títulos comuns (TITULOS-HONORIFICOS já caem fora de _proprio; se remover
    # o honorífico muda o nome próprio — ex. topônimo 'JAYME SANTO FONTE' — não é alias).
    titulos_a_via: dict[str, str] = {}
    ambiguo_tit: set = set()
    for v in sorted(osm_set):
        if sem_titulos(v) == v:                    # via OSM sem honorífico
            pv = _proprio(v)
            for t in HONORIFICOS:
                k_alias = f"{t} {pv}"
                if _proprio(k_alias, com_honorifico=True) != _proprio(k_alias):
                    continue                        # 'SANTO' etc. dentro do topônimo: régua falha
                if k_alias in osm_set:
                    continue                        # a forma com título É outra via: ambígua
                if pv in titulos_a_via:
                    ambiguo_tit.add(pv)
                else:
                    titulos_a_via[pv] = v
    for k in chaves:
        if not k:
            res[k] = (None, 0, "vazio", [], None)
        elif k in {"BR", "PE"}:
            res[k] = (None, 0, "rodovia_sem_numero", [], None)
        elif k in NAO_VIA:
            res[k] = (None, 0, "nao_e_via", [], None)
        elif k in osm_set:
            res[k] = (k, 100, "exato", [], None)
        elif _proprio(k, com_honorifico=True) == _proprio(sem_titulos(k), com_honorifico=True) \
                and sem_titulos(k) in osm_set:
            # endereço traz título que o OSM não tem ('DOUTOR X' -> 'X'): mesmo nome próprio.
            # A régua usa a forma COM honorífico dos dois lados: se o título é parte do
            # topônimo ('RUA JAYME SANTO FONTE' vs 'RUA DOUTOR JAYME FONTE'), remover um
            # dos lados muda o nome e NÃO pode virar exato — vai ao fuzzy/alias normal.
            res[k] = (sem_titulos(k), 100, "exato", [], None)
        elif _proprio(k) in sem_titulo_a_via:      # 'ABDIAS CARVALHO' -> 'DOUTOR ABDIAS CARVALHO'
            res[k] = (sem_titulo_a_via[_proprio(k)], 100, "exato_alias", [], None)
        elif len(k) < 6:
            res[k] = (None, 0, "curto", [], None)
        else:
            pend.append(k)
    if pend and len(osm):
        pends = sorted(dict.fromkeys(pend))
        pend_tokens = sorted({t for k in pends for t in _distinguir(k)})
        af = _afinidade(vocab_osm, pend_tokens)
        vocab = dict(D=af["D"], idx=vocab_idx, pos=af["pos"])
        M = process.cdist([_proprio(k) for k in pends], np.array(props),
                          scorer=fuzz.token_sort_ratio, workers=-1, dtype=np.uint8)
        bairro_por_chave = bairro_por_chave or {}
        vpb = bairros_por_via
        # vocabulário de nomes por bairro: consultado só quando a via NÃO passa pelo
        # bairro do evento (penalidade leve, defensiva).
        tokens_bairro: dict[str, set] = defaultdict(set)
        if vpb and bairro_por_chave:
            for vk, bs in vpb.items():
                for t in _distinguir(vk):
                    for bd in bs:
                        tokens_bairro[bd].add(t)
        for i, k in enumerate(pends):
            b = bairro_por_chave.get(k)
            rank = _rank_candidatos(k, b, vocab, osm, toksets, M[i], vpb, tokens_bairro.get(b))
            if not rank:
                res[k] = (None, 0, "sem_candidato", [], None)
                continue
            sc, via, afin = rank[0]
            # Piso curto: nomes próprios pequenos geram falsos positivos no fuzzy. O critério é
            # a distância de edição do nome próprio NORMALIZADA PELO COMPRIMENTO DO CANDIDATO
            # (cobertura relativa, não partial_ratio): typo de uma letra custa 1/n e passa
            # ('IMBAUVA'~'IMBAUBA' = 6/7 ≈ 86%); topônimo derivado custa caro contra palavra
            # curta ('PARQUE'~'PARC' = 4/6 ≈ 67%) e vira só sugestão na amostra — mas o mesmo
            # 'PARQUE' contra 'MIGUEL ARCANJO PARC' (20 chars) é custo diluído ≈ 90% e casa,
            # exatamente o caso que o partial_ratio absoluto derrubava.
            proprio, pcand = _proprio(k), _proprio(via) if via else ""
            if len(proprio) <= 8 and pcand:
                d = Levenshtein.distance(proprio, pcand)
                if min(100.0, 100.0 * (1 - d / max(len(proprio), len(pcand)))) < 80:
                    # rejeição COM candidato: via vai como sugestão para poder ser rotulada
                    # na amostra ('curto_riscoso' antes sumia da calibração — via None, sug None).
                    sug = [v for _, v, _ in rank[:4]]
                    res[k] = (None, sc, "curto_riscoso", sug[1:], sug[0])
                    continue
            res[k] = (via, sc, "fuzzy", [v for _, v, _ in rank[1:5]], None)
    return res

def hash_osm(osm_keys) -> str:
    return hashlib.sha1("\n".join(sorted(osm_keys)).encode()).hexdigest()[:16]


def corte_atual(p) -> int:
    if p.calibracao.exists():
        try:
            return int(json.loads(p.calibracao.read_text())["corte"])
        except Exception:
            pass
    return config.SCORE_PADRAO


def casar(con, chaves, osm_keys, corte: int, log=print,
          bairros_por_via: dict[str, set] | None = None,
          bairro_por_chave: dict[str, str] | None = None) -> dict:
    """Aplica cache, correções manuais e o corte.
    Retorna chave -> (via_final|None, score, metodo, [outros candidatos], sugestao|None).

    O cache é invalidado por (hash do OSM, VERSAO_ALGORITMO): quem rodou o pipeline com
    uma versão antiga do pontuador recomputa automaticamente — senão continuaria vendo
    resultados velhos (p. ex. 'LE PARQUE' rejeitado pela regra anterior).

    `bairros_por_via` + `bairro_por_chave`: quando informados, o ranking de candidatos é
    sensível ao bairro da ocorrência (decisão global; ver `pontuar`). O cache continua
    valendo: o bairro entra como parte da chave (tabela match_cache keyed por
    (chave, bairro)) — o resultado por (chave, bairro) é determinístico. Sem bairros,
    bairro=None e uma linha por chave."""
    h = hashlib.sha1(f"{hash_osm(osm_keys)}|v{VERSAO_ALGORITMO}".encode()).hexdigest()[:16]
    if db.meta_get(con, "osm_hash") != h:
        con.execute("DELETE FROM match_cache")
        db.meta_set(con, "osm_hash", h)
    pares = list(dict.fromkeys((k, (bairro_por_chave or {}).get(k)) for k in chaves))
    # bairro entra na PK do cache; DuckDB não aceita NULL em PK — usa-se '' como sentinela
    # para "sem informação de bairro" (modo insensível a bairro).
    cache: dict[tuple, tuple] = {}
    for c, b, via, sc, met, emp, sug in con.execute(
            "SELECT chave, bairro, via, score, metodo, empates, sugestao FROM match_cache").fetchall():
        cache[(c, b or "")] = (via, sc, met, emp, sug)
    novas = [kb for kb in pares if (kb[0], kb[1] or "") not in cache]
    if novas:
        log(f"  matching: {len(novas)} chaves{'×bairro' if any(b for _, b in novas) else ''}"
            f" avaliadas (cache: {len(pares) - len(novas)})")
        grupos: dict[str | None, list[str]] = defaultdict(list)
        for k, b in novas:
            grupos[b].append(k)
        for b, ks in grupos.items():
            res_p = pontuar(ks, osm_keys, bairros_por_via,
                            {k: b for k in ks} if b else None)
            for k, (via, sc, met, emp, sug) in res_p.items():
                cache[(k, b or "")] = (via, sc, met, "|".join(emp), sug)
                con.execute("INSERT OR REPLACE INTO match_cache VALUES (?,?,?,?,?,?,?)",
                            [k, b or "", via, sc, met, "|".join(emp), sug])
    corr = dict(con.execute("SELECT chave, via FROM match_correcoes").fetchall())
    osm_set = set(osm_keys)
    out = {}
    for k, b in pares:
        if k in corr and corr[k] in osm_set:
            out[k] = (corr[k], 100, "correcao", [], None)
            continue
        via, sc, met, emp, sug = cache[(k, b or "")]
        emp = [e for e in (emp or "").split("|") if e]
        if via is not None and sc >= corte:
            out[k] = (via, sc, met, emp, None)
        else:
            # abaixo do corte: a via casada vira sugestão; rejeições com candidato
            # (curto_riscoso) já trazem a sugestão própria de `pontuar`.
            out[k] = (None, sc, met if via is None else "abaixo_do_corte", [],
                      via if via is not None else sug)
    return out


def resolver_rodovia(k, bairro, rodovias, vias_por_bairro):
    """'BR'/'PE' sem número: se só uma rodovia daquele prefixo passa pelo bairro, é ela."""
    cand = [v for v in rodovias if v.startswith(k + " ") and bairro in vias_por_bairro.get(v, ())]
    return cand[0] if len(cand) == 1 else None


def desempatar(via, empates, bairro, vias_por_bairro) -> str:
    """Entre candidatos ordenados por prioridade, mantém a escolha se ela passar pelo
    bairro; senão, se exatamente um concorrente passar, ele vence. (Mantido para o
    caminho legado/sem-bairro do cache; `pontuar` já decide globalmente quando há bairros.)"""
    if not empates or not bairro or not vias_por_bairro:
        return via
    if bairro in vias_por_bairro.get(via, ()):
        return via
    cand = [v for v in empates if bairro in vias_por_bairro.get(v, ())]
    return cand[0] if len(cand) == 1 else via


# ---------------------------------------------------------------- calibração
FAIXAS_SCORE = [(70, 80), (80, 86), (86, 90), (90, 95), (95, 100), (100, 101)]
COLS = ["chave", "endereco_exemplo", "ocorrencias", "candidato", "score", "faixa", "correto", "via_correta"]


def gerar_amostra(p, resultados: dict, exemplos: dict, contagem: dict, por_faixa=40, semente=1) -> tuple[Path, int]:
    """CSV (;) estratificado por faixa de score para rotulagem manual.
    correto = S/N (o candidato é a via certa?); via_correta = chave correta se N (opcional).

    Inclui também as rejeições que têm candidato (curto_riscoso/abaixo-do-corte/sugestões):
    exatamente os casos que o filtro derrubou precisam poder ser rotulados e corrigidos —
    'S' numa rejeição vira correção manual em `avaliar`. Retorna (caminho, n_rotuláveis)."""
    rnd = random.Random(semente)
    linhas, sem_cand = [], 0
    for lo, hi in FAIXAS_SCORE:
        grupo = [k for k, r in resultados.items() if lo <= r[1] < hi and _cand(r) and r[2] != "correcao"]
        sem_cand += sum(1 for k, r in resultados.items()
                        if lo <= r[1] < hi and not _cand(r) and r[2] != "correcao")
        rnd.shuffle(grupo)
        n = por_faixa if lo < 100 else max(10, por_faixa // 2)
        for k in grupo[:n]:
            cand = _cand(resultados[k])
            linhas.append([k, exemplos.get(k, ""), contagem.get(k, 0), cand, resultados[k][1],
                           f"{lo}-{min(hi, 100)}", "", ""])
    destino = p.base / "calibracao_amostra.csv"
    with open(destino, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(COLS)
        w.writerows(linhas)
    return destino, len(linhas)


def _cand(r):
    """Candidato (casado ou sugerido) de um resultado de `casar`."""
    return r[0] or r[4]


def _achar_coluna(campos, alvo):
    """Localiza `alvo` entre os cabeçalhos, tolerando BOM residual e nomes com aspas/espaços."""
    norm = lambda s: (s or "").strip().strip('"').lstrip("\ufeff").lower()
    for c in campos:
        if norm(c) == alvo:
            return c
    return None


def _ler_rotulos(caminho: Path):
    raw = caminho.read_bytes().decode("utf-8-sig", errors="replace")
    # remove BOMs residuais (arquivos regravados por planilha podem acumular mais de um)
    while raw.startswith("\ufeff"):
        raw = raw[1:]
    primeira = raw.splitlines()[0] if raw.splitlines() else ""
    sep = ";" if primeira.count(";") >= primeira.count(",") else ","
    rows = list(csv.reader(io.StringIO(raw), delimiter=sep))
    if not rows:
        return []
    cab = rows[0]
    col = {nome: _achar_coluna(cab, nome) for nome in ("chave", "candidato", "score", "correto", "via_correta")}
    idx = {nome: (cab.index(col[nome]) if col[nome] is not None else None) for nome in col}

    def celula(r, nome):
        i = idx[nome]
        return (r[i] if i is not None and i < len(r) else "") or ""

    out, ignoradas = [], 0
    for r in rows[1:]:
        if not any((c or "").strip() for c in r):          # linha em branco
            continue
        c = celula(r, "correto").strip().lower().strip('"')
        if c in ("s", "sim", "1", "y", "verdadeiro", "true"):
            ok = True
        elif c in ("n", "nao", "não", "0", "falso", "false"):
            ok = False
        else:
            ignoradas += 1
            continue
        sc = celula(r, "score").strip().strip('"').replace(",", ".")
        try:
            score = int(float(sc))
        except ValueError:
            score = CORTE_MIN                              # sem score válido: trata como abaixo do corte
        out.append(dict(chave=celula(r, "chave").strip(), candidato=celula(r, "candidato").strip(),
                        score=score, ok=ok, via_correta=celula(r, "via_correta").strip().upper()))
    if not out and rows[1:]:
        raise ValueError(
            f"Nenhum rótulo reconhecido na coluna 'correto' de {caminho.name} "
            f"({len(rows) - 1} linhas lidas, {ignoradas} sem S/N). "
            "Preencha 'correto' com S ou N em pelo menos 20 linhas e salve o arquivo "
            "(CSV; separador ; UTF-8) antes de rodar calibrar-avaliar."
        )
    return out


def avaliar(p, con, osm_keys, min_precisao=0.95) -> dict:
    """Escolhe o corte pela amostra rotulada e registra correções manuais."""
    arq = p.base / "calibracao_amostra.csv"
    if not arq.exists():
        raise ValueError(f"Amostra não encontrada em {arq}; rode 'calibrar-gerar' primeiro.")
    rot = _ler_rotulos(arq)
    if len(rot) < 20:
        raise ValueError(
            f"Poucos rótulos preenchidos ({len(rot)}) em {arq}; "
            "preencha a coluna 'correto' com S/N em pelo menos 20 linhas e SALVE o arquivo "
            "(se abriu no LibreOffice/Excel, confirme que salvou como CSV separador ';' UTF-8 "
            "no mesmo caminho) antes de rodar calibrar-avaliar."
        )
    tabela = []
    for c in range(CORTE_MIN, 101):
        tp = sum(1 for r in rot if r["score"] >= c and r["ok"])
        fp = sum(1 for r in rot if r["score"] >= c and not r["ok"])
        fn = sum(1 for r in rot if r["score"] < c and r["ok"])
        prec = tp / (tp + fp) if tp + fp else 1.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        tabela.append(dict(corte=c, precisao=round(prec, 3), revocacao=round(rec, 3), f1=round(f1, 3)))
    boas = [t for t in tabela if t["precisao"] >= min_precisao]
    escolhido = (boas[0] if boas else max(tabela, key=lambda t: t["f1"]))["corte"]
    # correções: N com via_correta válida; S abaixo do corte (força aceitar)
    osm_set, n_corr = set(osm_keys), 0
    for r in rot:
        alvo = None
        if not r["ok"] and r["via_correta"] in osm_set:
            alvo = r["via_correta"]
        elif r["ok"] and r["score"] < escolhido and r["candidato"] in osm_set:
            alvo = r["candidato"]
        if alvo:
            con.execute("INSERT OR REPLACE INTO match_correcoes VALUES (?,?)", [r["chave"], alvo])
            n_corr += 1
    res = dict(corte=escolhido, n_rotulos=len(rot), min_precisao=min_precisao,
               correcoes=n_corr, tabela=tabela)
    p.calibracao.write_text(json.dumps(res, ensure_ascii=False, indent=1))
    return res
