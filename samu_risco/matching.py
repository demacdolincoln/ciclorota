"""Casamento endereço -> via do OSM (exato + fuzzy multi-thread) e calibração do corte."""
import csv
import hashlib
import io
import json
import random
from pathlib import Path

import numpy as np
from rapidfuzz import fuzz, process

from . import config, db
from .textnorm import sem_titulos

CORTE_MIN = 70   # abaixo disso nem sugestão é registrada


# ---------------------------------------------------------------- núcleo
def pontuar(chaves: list[str], osm_keys: list[str]) -> dict:
    """Melhor candidato para cada chave (independente do corte).
    Retorna chave -> (via|None, score, metodo, [empates])."""
    osm = np.array(sorted(osm_keys))
    osm_set = set(osm.tolist())
    res, pend = {}, []
    for k in chaves:
        if not k:
            res[k] = (None, 0, "vazio", [])
        elif k in {"BR", "PE"}:
            res[k] = (None, 0, "rodovia_sem_numero", [])
        elif k in osm_set:
            res[k] = (k, 100, "exato", [])
        elif sem_titulos(k) in osm_set:                    # 'DOUTOR X' no endereço, 'X' no OSM
            res[k] = (sem_titulos(k), 100, "exato", [])
        elif len(k) < 6:
            res[k] = (None, 0, "curto", [])
        else:
            pend.append(k)
    if pend and len(osm):
        M = process.cdist(pend, osm, scorer=fuzz.token_sort_ratio, dtype=np.uint8,
                          workers=-1, score_cutoff=CORTE_MIN)
        idx = M.argmax(axis=1)
        best = M[np.arange(len(pend)), idx]
        for i, (k, j, sc) in enumerate(zip(pend, idx, best)):
            if sc < CORTE_MIN:
                res[k] = (None, int(sc), "sem_candidato", [])
                continue
            emp = [str(osm[x]) for x in np.flatnonzero(M[i] == sc)[:6] if x != j]
            res[k] = (str(osm[j]), int(sc), "fuzzy", emp)
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


def casar(con, chaves, osm_keys, corte: int, log=print) -> dict:
    """Aplica cache (por hash do OSM), correções manuais e o corte.
    Retorna chave -> (via_final|None, score, metodo, [empates], sugestao|None)."""
    h = hash_osm(osm_keys)
    if db.meta_get(con, "osm_hash") != h:
        con.execute("DELETE FROM match_cache")
        db.meta_set(con, "osm_hash", h)
    chaves = list(dict.fromkeys(chaves))
    em_cache = {r[0]: r[1:] for r in con.execute("SELECT chave, via, score, metodo, empates FROM match_cache").fetchall()}
    novas = [k for k in chaves if k not in em_cache]
    if novas:
        log(f"  matching: {len(novas)} chaves novas (cache: {len(chaves) - len(novas)})")
        for k, (via, sc, met, emp) in pontuar(novas, osm_keys).items():
            em_cache[k] = (via, sc, met, "|".join(emp))
            con.execute("INSERT OR REPLACE INTO match_cache VALUES (?,?,?,?,?)", [k, via, sc, met, "|".join(emp)])
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
    """Entre candidatos de mesmo score, prefere o que existe no bairro do evento."""
    if not empates or not bairro or not vias_por_bairro:
        return via
    cand = [v for v in [via] + empates if bairro in vias_por_bairro.get(v, ())]
    return cand[0] if len(cand) == 1 else via


# ---------------------------------------------------------------- calibração
FAIXAS_SCORE = [(70, 80), (80, 86), (86, 90), (90, 95), (95, 100), (100, 101)]
COLS = ["chave", "endereco_exemplo", "ocorrencias", "candidato", "score", "faixa", "correto", "via_correta"]


def gerar_amostra(p, resultados: dict, exemplos: dict, contagem: dict, por_faixa=40, semente=1) -> Path:
    """CSV (;) estratificado por faixa de score para rotulagem manual.
    correto = S/N (o candidato é a via certa?); via_correta = chave correta se N (opcional)."""
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


def _ler_rotulos(caminho: Path):
    txt = caminho.read_text(encoding="utf-8-sig")
    sep = ";" if txt.split("\n", 1)[0].count(";") >= txt.split("\n", 1)[0].count(",") else ","
    rows = list(csv.DictReader(io.StringIO(txt), delimiter=sep))
    out = []
    for r in rows:
        c = (r.get("correto") or "").strip().lower()
        if c in ("s", "sim", "1", "y"):
            ok = True
        elif c in ("n", "nao", "não", "0"):
            ok = False
        else:
            continue
        out.append(dict(chave=r["chave"], candidato=r["candidato"], score=int(float(r["score"])),
                        ok=ok, via_correta=(r.get("via_correta") or "").strip().upper()))
    return out


def avaliar(p, con, osm_keys, min_precisao=0.95) -> dict:
    """Escolhe o corte pela amostra rotulada e registra correções manuais."""
    arq = p.base / "calibracao_amostra.csv"
    rot = _ler_rotulos(arq)
    if len(rot) < 20:
        raise ValueError(f"Poucos rótulos preenchidos ({len(rot)}); preencha a coluna 'correto' (S/N).")
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
