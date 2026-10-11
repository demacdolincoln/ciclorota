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

from . import config, db
from .textnorm import norm_bairro, sem_titulos

CORTE_MIN = 70            # abaixo disso nem sugestão é registrada
VERSAO_ALGORITMO = 5     # mude a cada ajuste de pontuação/desempate (invalida o match_cache)

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


def _proprio(k: str) -> str:
    p = _distinguir(k)
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
    Retorna D como lista de linhas (imutável) para indexação esparsa rápida.
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
                                  score_cutoff=70, dtype=np.float32) / 100.0
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
    v = dict(D=[row.tolist() for row in D], idx=idx, pos=pos)
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
    for k in chaves:
        if not k:
            res[k] = (None, 0, "vazio", [])
        elif k in {"BR", "PE"}:
            res[k] = (None, 0, "rodovia_sem_numero", [])
        elif k in NAO_VIA:
            res[k] = (None, 0, "nao_e_via", [])
        elif k in osm_set or sem_titulos(k) in osm_set:      # 'DOUTOR X' no endereço, 'X' no OSM
            res[k] = (sem_titulos(k) if sem_titulos(k) in osm_set else k, 100, "exato", [])
        elif len(k) < 6:
            res[k] = (None, 0, "curto", [])
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
                res[k] = (None, 0, "sem_candidato", [])
                continue
            sc, via, afin = rank[0]
            # Piso curto: nomes próprios pequenos geram falsos positivos no fuzzy
            # ('LE PARQUE' ~ 'LE PARC'). Exige quase-exatidão do nome próprio — que o
            # score composto já garante quando os tokens coincidem ('LE PARQUE' bate
            # 'RUA LE PARQUE' com afinidade 1,0 => 100).
            if sc < 92 and len(_proprio(k)) <= 8 and afin < 0.95:
                res[k] = (None, sc, "curto_riscoso", [v for _, v, _ in rank[:4]])
            else:
                res[k] = (via, sc, "fuzzy", [v for _, v, _ in rank[1:5]])
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
    sensível ao bairro da ocorrência (decisão global; ver `pontuar`). Nesse caso o cache
    é ignorado para as chaves afetadas — o resultado deixa de ser função só da chave.
    Sem bairros, o resultado por chave permanece cacheável."""
    h = hashlib.sha1(f"{hash_osm(osm_keys)}|v{VERSAO_ALGORITMO}".encode()).hexdigest()[:16]
    sensivel = bool(bairros_por_via and bairro_por_chave)
    if db.meta_get(con, "osm_hash") != h:
        con.execute("DELETE FROM match_cache")
        db.meta_set(con, "osm_hash", h)
    chaves = list(dict.fromkeys(chaves))
    em_cache = ({} if sensivel else
                {r[0]: r[1:] for r in con.execute(
                    "SELECT chave, via, score, metodo, empates FROM match_cache").fetchall()})
    novas = [k for k in chaves if k not in em_cache]
    if novas:
        log(f"  matching: {len(novas)} chaves {'reavaliadas' if sensivel else 'novas'}"
            f" (cache: {len(chaves) - len(novas)})")
        for k, (via, sc, met, emp) in pontuar(novas, osm_keys, bairros_por_via,
                                              bairro_por_chave).items():
            em_cache[k] = (via, sc, met, "|".join(emp))
            if not sensivel:
                con.execute("INSERT OR REPLACE INTO match_cache VALUES (?,?,?,?,?)",
                            [k, via, sc, met, "|".join(emp)])
    corr = dict(con.execute("SELECT chave, via FROM match_correcoes").fetchall())
    osm_set = set(osm_keys)
    out = {}
    for k in chaves:
        if k in corr and corr[k] in osm_set:
            out[k] = (corr[k], 100, "correcao", [], None)
            continue
        via, sc, met, emp = em_cache[k]
        emp = [e for e in (emp or "").split("|") if e]
        if via is not None and sc >= corte:
            out[k] = (via, sc, met, emp, None)
        else:
            out[k] = (None, sc, met if via is None else "abaixo_do_corte", [], via)
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


def gerar_amostra(p, resultados: dict, exemplos: dict, contagem: dict, por_faixa=40, semente=1) -> Path:
    """CSV (;) estratificado por faixa de score para rotulagem manual.
    correto = S/N (o candidato é a via certa?); via_correta = chave correta se N (opcional).

    Inclui também as rejeições que têm candidato (penalizadas/abaixo-do-corte/sugestões):
    exatamente os casos que o filtro derrubou precisam poder ser rotulados e corrigidos —
    'S' numa rejeição vira correção manual em `avaliar`."""
    rnd = random.Random(semente)
    linhas = []
    for lo, hi in FAIXAS_SCORE:
        grupo = [k for k, r in resultados.items() if lo <= r[1] < hi and _cand(r) and r[2] != "correcao"]
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
    return destino


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
