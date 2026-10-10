"""Normalização de nomes de via e bairro (aplicada a endereços E a nomes do OSM)."""
import re
import unicodedata

_ACENTO = re.compile(r"[\u0300-\u036f]")


def sem_acento(s: str) -> str:
    return _ACENTO.sub("", unicodedata.normalize("NFKD", s))


TIPOS_VIA = {"R", "RUA", "AV", "AVENIDA", "TV", "TRAV", "TRAVESSA", "EST", "ESTRADA",
             "PC", "PCA", "PRACA", "LAD", "LADEIRA", "ALM", "ALAMEDA", "VIA", "VL",
             "VIELA", "BC", "BECO", "CAM", "CAMINHO", "LG", "LARGO", "PAT", "PATIO",
             "ROD", "RODOVIA", "AC", "ACESSO"}
CONECTORES = {"DE", "DA", "DO", "DAS", "DOS", "E"}
# Títulos que o OSM costuma ter e os endereços do SAMU costumam omitir (e vice-versa).
# Usados só para gerar chaves-alias (ver rede.preparar_arestas e matching.pontuar).
HONORIFICOS = {"DOUTOR", "DOUTORA", "PROFESSOR", "PROFESSORA", "GOVERNADOR", "PADRE", "CORONEL", "MARECHAL",
               "VEREADOR", "DEPUTADO", "SENADOR", "PRESIDENTE", "ENGENHEIRO", "CAPITAO", "TENENTE", "GENERAL",
               "DESEMBARGADOR", "ALMIRANTE", "COMANDANTE", "BARAO", "CONDE", "CONDESSA", "VISCONDE", "MARQUES",
               "DUQUE", "CONSELHEIRO", "MONSENHOR", "ARQUITETO", "DOM", "DONA", "FREI", "IRMA", "IRMAO",
               "CONEGO", "BISPO", "CARDEAL", "SARGENTO", "MAJOR", "COMENDADOR", "INTENDENTE", "JORNALISTA",
               "MINISTRO", "PREFEITO", "JUIZ", "PASTOR", "SOLDADO", "CABO", "JURISTA", "POETA", "MESTRE"}
ABREV = {"DR": "DOUTOR", "DRA": "DOUTORA", "PROF": "PROFESSOR", "PROFA": "PROFESSORA",
         "GOV": "GOVERNADOR", "ENG": "ENGENHEIRO", "CEL": "CORONEL", "MAL": "MARECHAL",
         "CAP": "CAPITAO", "TEN": "TENENTE", "GEN": "GENERAL", "PRES": "PRESIDENTE",
         "DEP": "DEPUTADO", "SEN": "SENADOR", "DES": "DESEMBARGADOR", "VER": "VEREADOR",
         "VD": "VIADUTO", "PTE": "PONTE", "STA": "SANTA", "STO": "SANTO", "SRA": "SENHORA",
         "SR": "SENHOR", "PE": "PADRE", "ALF": "ALFERES", "ALM": "ALMIRANTE",
         "COM": "COMANDANTE", "BAR": "BARAO", "CONS": "CONSELHEIRO", "MONS": "MONSENHOR",
         "ARQ": "ARQUITETO"}

RX_RODOVIA = re.compile(r"^(BR|PE)\s*-?\s*(\d{2,3})\b")
RX_CRUZ = re.compile(r"\s*(?:/|\bCOM\b|\bX\b|\bESQ(?:UINA)?\b|\bCRUZAMENTO\b)\s*")
RX_CORTE = re.compile(r"\b(?:SENTIDO|PROX\w*|ALTURA|EM FRENTE|REFERENCIA|NUMERO|S\s*/?\s*N|KM|PISTA)\b.*$")
RX_NUM = re.compile(r"\s+(?:N[O]?\s*)?\d+(?!\s*(?:DE|DO|DA)\b)\b.*$")
RX_SOBRA = re.compile(r"[^A-Z0-9 ]")


def normalizar(s) -> str:
    """Chave do logradouro: sem acento, tipo (RUA/AV), número, sentido/referência e
    conectores; abreviações expandidas. Vazio se não houver nome utilizável."""
    if not isinstance(s, str):
        return ""
    s = sem_acento(s).upper().strip()
    pre = re.sub(r"^(?:(?:ROD|RODOVIA|AC|ACESSO)\s+)+", "", s.replace(".", " ").strip())
    m = RX_RODOVIA.match(pre)
    if m:
        return f"{m.group(1)} {m.group(2)}"
    if pre in {"BR", "PE"}:
        return pre                                  # rodovia sem número: resolvida pelo bairro (ver build)
    m = re.match(r"^(101|232|408)\b", pre)
    if m and s != pre:                              # 'ROD 101' / 'AC 232'
        return f"BR {m.group(1)}"
    s = re.split(r"[,;]| - ", s)[0]
    s = RX_CRUZ.split(s)[0]
    s = RX_SOBRA.sub(" ", s.replace("-", " "))
    s = re.sub(r"\s+", " ", s).strip()
    s = RX_CORTE.sub("", s).strip()
    s = RX_NUM.sub("", s).strip()
    tok = s.split()
    while tok and tok[0] in TIPOS_VIA:
        tok = tok[1:]
    if tok and tok[-1] in {"N", "SN"}:
        tok = tok[:-1]
    tok = [ABREV.get(t, t) for t in tok]
    tok = [t for t in tok if t not in CONECTORES]
    s = " ".join(tok)
    return s if len(s) >= 3 else ""


def norm_bairro(s) -> str:
    return re.sub(r"\s+", " ", sem_acento(s).upper().strip()) if isinstance(s, str) else ""


def sem_titulos(chave: str) -> str:
    """Chave sem títulos honoríficos ('DOUTOR JAYME FONTE' -> 'JAYME FONTE'). Mantém a chave se
    só restassem títulos ou se for rodovia."""
    if not chave or chave.split()[0] in {"BR", "PE"}:
        return chave
    t = [x for x in chave.split() if x not in HONORIFICOS]
    return " ".join(t) if t else chave
