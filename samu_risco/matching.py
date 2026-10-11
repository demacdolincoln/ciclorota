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

# Palavras que não distinguem uma via de outra (topônimos naturais e complementos de logradouro).
# No score fuzzy só o nome próprio deve pesar; 'CORREGO IMBAUBA' vs 'CORREGO JAQUEIRA' não é
# similaridade, é a palavra genérica repetida.
GENERICAS = {
    "CORREGO", "RIO", "CANAL", "LAGOA", "LAGO", "MANGUE", "BREJO", "IGARAPE",
    "SN", "S/N", "E", "S",
}
# Chaves que nunca são vias (modo/desconhecido registrados no campo endereço).
NAO_VIA = {
    "CICLISTA", "BIKE", "BICICLETA", "MOTO", "MOTOCICLETA", "PEDESTRE", "A PE", "AUTO",
    "CARRO", "VEICULO", "ONIBUS", "CAMINHAO", "VAN", "TAXI", "MOTORISTA", "CONDUTOR",
    "VITIMA", "ACIDENTE", "SEM LOCAL", "OUTROS", "IGNORADO", "N", "S",
}


# ---------------------------------------------------------------- núcleo
_VOCAB_CACHE: dict[tuple, list[str]] = {}


def _vocabulario(osm_keys) -> list[str]:
    """Tokens do OSM com suas frequências (cache — a lista de vias é estável entre chamadas)."""
    chave = hash(tuple(sorted(osm_keys)))
    v = _VOCAB_CACHE.get(chave)
    if v is None:
        cont: dict[str, int] = {}
        for nome in osm_keys:
            for t in nome.split():
                if t not in GENERICAS:
                    cont[t] = cont.get(t, 0) + 1
        v = sorted(cont.items())
        _VOCAB_CACHE.clear()                    # um vocabulário por vez (OSM muda raramente)
        _VOCAB_CACHE[chave] = v
    return v


def _peso_fuzzy(k: str, vocab: list[str], osm_candidato: str) -> float:
    """Grau de pertencimento de `k` ao conjunto fuzzy das vias do OSM (0..1).

    Fuzzy puro casa topônimos ('ECA QUEIROZ' ~ 'CAJUEIRO') porque token_sort_ratio mede
    sobreposição de letras. Aqui cada token do nome próprio recebe peso = maior similaridade
    com qualquer token do vocabulário das vias; tokens genéricos (CORREGO/RIO/...) não contam.
    Tokens que aparecem em POUCAS vias (nomes próprios raros) só valem pleno se casarem quase
    exatamente com o candidato escolhido — sem isso 'QUEIROZ' colaria em 'CAJUEIRO'. Erros de
    digitação reais ('FRASCISCO JASINTO' ~ 'FRANCISCO JACINTO') são perdoados."""
    toks = [t for t in k.split() if t not in GENERICAS]
    if not toks or not vocab:
        return 0.0
    freq = dict(vocab)
    n_tok = sum(freq.values()) or 1
    cand = set(osm_candidato.split())
    out = []
    for t in toks:
        best = process.extractOne(t, list(freq), scorer=fuzz.WRatio)
        sc = (best[1] if best else 0) / 100
        f = freq.get(best[0], 0) / n_tok
        # quanto mais específico o token no vocabulário, mais perto de 1 ele precisa estar
        limiar = 0.97 if f >= 0.5 else 0.90 if f >= 0.02 else 0.84
        if sc < limiar and t not in cand:
            sc *= 0.5                              # palavra rara e mal casada: provavelmente outro lugar
        out.append(sc)
    return sum(out) / len(out)


def _corte_efetivo(k: str) -> int:
    """Corte maior para nomes curtos: com poucas letras, fuzzy gera falsos positivos
    ('LE PARQUE' ~ 'LE PARC'). Exige quase-exatidão quando o nome próprio é pequeno."""
    proprio = " ".join(t for t in k.split() if t not in GENERICAS)
    if len(proprio) <= 8:
        return max(CORTE_MIN, 92)
    if len(proprio) <= 12:
        return max(CORTE_MIN, 86)
    return CORTE_MIN


def pontuar(chaves: list[str], osm_keys: list[str],
            bairros_por_via: dict[str, set] | None = None,
            bairro: str | None = None) -> dict:
    """Melhor candidato para cada chave (independente do corte).
    Retorna chave -> (via|None, score, metodo, [empates]).

    `bairros_por_via` + `bairro`: se informados, candidatos que não passam pelo bairro da
    ocorrência perdem prioridade no desempate (só decide quando há empate de score — assim
    nunca descarta um match exato por divergência de grafias de bairro)."""
    osm = np.array(sorted(osm_keys))
    osm_set = set(osm.tolist())
    vocab = _vocabulario(osm_keys)
    res, pend = {}, []
    for k in chaves:
        if not k:
            res[k] = (None, 0, "vazio", [])
        elif k in {"BR", "PE"}:
            res[k] = (None, 0, "rodovia_sem_numero", [])
        elif k in NAO_VIA:
            res[k] = (None, 0, "nao_e_via", [])
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
        for i, k in enumerate(pend):
            linha = M[i]
            sc = int(linha.max()) if linha.size else 0
            if sc < CORTE_MIN:
                res[k] = (None, sc, "sem_candidato", [])
                continue
            # Pesa pelo nome próprio: se as palavras que diferenciam a via não existem no
            # OSM, o match é espúrio (compartilha só genéricos/topônimos).
            empates = np.flatnonzero(linha == sc)[:6]
            ordem = list(empates)
            if bairros_por_via is not None and bairro:
                ordem.sort(key=lambda x: 0 if bairro in bairros_por_via.get(str(osm[x]), ()) else 1)
            j = ordem[0]
            w = _peso_fuzzy(k, vocab, str(osm[j]))
            sc_pen = sc if w >= 0.99 else int(round(sc * (0.35 + 0.65 * w)))
            if sc_pen < _corte_efetivo(k):
                res[k] = (None, sc_pen, "penalizado", [])
                continue
            emp = [str(osm[x]) for x in ordem[1:] if x != j]
            res[k] = (str(osm[j]), sc_pen, "fuzzy", emp)
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
    Retorna chave -> (via_final|None, score, metodo, [empates], sugestao|None).

    O desempate por bairro acontece depois (build), por (chave, bairro); aqui o resultado é
    apenas independente do evento."""
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
