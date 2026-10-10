"""Constantes e caminhos do projeto."""
import os
from dataclasses import dataclass
from pathlib import Path

API = os.environ.get("CKAN_BASE", "https://dados.recife.pe.gov.br/api/3/action").rstrip("/")
UA = "Mozilla/5.0 (compatible; samu-risco/0.2)"

MUNICIPIO = "RECIFE"
LUGAR_OSM = "Recife, Pernambuco, Brazil"
CRS_M = 31985             # SIRGAS 2000 / UTM 25S (metros)
SIMPLIFICAR_M = 2.0
SCORE_PADRAO = 86         # corte do fuzzy; sobrescrito por dados/calibracao.json

# (veículo, natureza) por subtipo de trânsito do SAMU
SUBTIPOS = {
    "ACIDENTE DE TRANSITO ENVOLVENDO MOTO":               ("Moto", "Acidente"),
    "ACIDENTE DE TRANSITO COM CARROS":                    ("Carro", "Acidente"),
    "ACIDENTE DE TRANSITO ENVOLVENDO BICICLETA":          ("Bicicleta", "Acidente"),
    "ACIDENTE DE TRANSITO ENVOLVENDO ONIBUS OU CAMINHAO": ("Ônibus/Caminhão", "Acidente"),
    "ATROPELAMENTO POR MOTO":                             ("Moto", "Atropelamento"),
    "ATROPELAMENTO POR CARRO":                            ("Carro", "Atropelamento"),
    "ATROPELAMENTO POR BICICLETA":                        ("Bicicleta", "Atropelamento"),
    "ATROPELAMENTO POR ONIBUS OU CAMINHAO":               ("Ônibus/Caminhão", "Atropelamento"),
}
VEICULOS = ["Moto", "Carro", "Bicicleta", "Ônibus/Caminhão"]
_TOK_VEICULO = [("MOTO", "Moto"), ("BIKE", "Bicicleta"), ("BICI", "Bicicleta"), ("ONIBUS", "Ônibus/Caminhão"),
                ("CAMINH", "Ônibus/Caminhão"), ("CARRO", "Carro"), ("AUTO", "Carro")]


def classificar_subtipo(sub):
    """(veículo, natureza) de um subtipo do SAMU, ou None se não for trânsito.
    Cobre os nomes canônicos (SUBTIPOS) e os antigos (2016-2020: ATROPELCARRO, ATROPELMOTO,
    ATROPELONIBUS, ATROPELBIKE) por regra: natureza (ATROPEL / TRANSITO / ACID...) + veículo."""
    if not isinstance(sub, str) or not sub.strip():
        return None
    from .textnorm import sem_acento
    s = sem_acento(sub).upper().strip()
    if s in SUBTIPOS:
        return SUBTIPOS[s]
    if any(x in s for x in ("ANIMA", "OBJETO", "PERFUR")):
        return None
    if "ATROPEL" in s:
        nat = "Atropelamento"
    elif "TRANSITO" in s or s.startswith("ACID") or "COLISAO" in s:
        nat = "Acidente"
    else:
        return None
    for tok, v in _TOK_VEICULO:
        if tok in s:
            return (v, nat)
    return None
NATUREZAS = ["Acidente", "Atropelamento"]
PERIODOS = ["Madrugada (0-5h)", "Manhã (6-11h)", "Tarde (12-17h)", "Noite (18-23h)"]
FAIXAS = ["0-11", "12-17", "18-29", "30-44", "45-59", "60+", "N/I"]
MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
DIAS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]
CLASSES_CICLO = ["Ciclovia / via exclusiva", "Ciclofaixa", "Faixa compartilhada"]

# Slugs conhecidos do portal (verificados em 08/10/2026)
SLUG_CICLOVIAS = "malha-cicloviaria-do-recife"
SLUG_SEMAFOROS = "localizacao-dos-semaforos"
SLUG_PARACICLOS = "paraciclos-do-recife"
SLUGS_BAIRROS = ["area-urbana", "mapas-de-limites-e-divisoes-territoriais", "distritos-sanitarios"]


@dataclass
class Pastas:
    base: Path

    @property
    def raw(self): return self.base / "raw"
    @property
    def geo(self): return self.base / "geo"
    @property
    def db(self): return self.base / "samu.duckdb"
    @property
    def calibracao(self): return self.base / "calibracao.json"

    def criar(self):
        for p in (self.base, self.raw, self.geo):
            p.mkdir(parents=True, exist_ok=True)
        return self


def pastas(base="dados") -> Pastas:
    return Pastas(Path(base)).criar()
