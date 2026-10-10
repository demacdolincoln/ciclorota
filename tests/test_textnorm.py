import pytest
from samu_risco.textnorm import normalizar, norm_bairro


@pytest.mark.parametrize("entrada,esperado", [
    ("R FRASCISCO JASINTO 16 SANTO AMARO", "FRASCISCO JASINTO"),
    ("AV 17 DE AGOSTO 100", "17 AGOSTO"),
    ("R LINHA VELHA DA MURIBECA N", "LINHA VELHA MURIBECA"),
    ("AV BEBERIBE SENTIDO SUBURBIO", "BEBERIBE"),
    ("ROD BR-101 KM 5", "BR 101"),
    ("BR 232", "BR 232"),
    ("Rua Conde do Irajá", "CONDE IRAJA"),
    ("R CONDE DO IRAJA", "CONDE IRAJA"),
    ("AV DR JOSE RUFINO 200 ESQ COM R X", "DOUTOR JOSE RUFINO"),
    ("AV CRUZ CABUGA", "CRUZ CABUGA"),
    ("VD TEMUDO", "VIADUTO TEMUDO"),
    ("BR", "BR"), ("PE", "PE"), ("AC BR-101", "BR 101"), ("ROD 101", "BR 101"),
    ("AV AGAMENON MAGALHAES PISTA LOCAL", "AGAMENON MAGALHAES"),
    ("AC AVENIDA MASCARENHAS DE MORAIS", "MASCARENHAS MORAIS"),
    ("AV", ""), ("", ""), (None, ""),
])
def test_normalizar(entrada, esperado):
    assert normalizar(entrada) == esperado


def test_osm_e_endereco_convergem():
    assert normalizar("Avenida Governador Agamenon Magalhães") == normalizar("AV GOV AGAMENON MAGALHAES")


def test_bairro():
    assert norm_bairro("  Várzea ") == "VARZEA"


def test_sem_titulos():
    from samu_risco.textnorm import sem_titulos
    assert sem_titulos("DOUTOR ABDIAS CARVALHO") == "ABDIAS CARVALHO"
    assert sem_titulos("ENGENHEIRO DOMINGOS FERREIRA") == "DOMINGOS FERREIRA"
    assert sem_titulos("DOM BOSCO") == "BOSCO"
    assert sem_titulos("BR 101") == "BR 101"
    assert sem_titulos("DOUTOR") == "DOUTOR"            # só título: mantém
    assert sem_titulos("SANTA RITA") == "SANTA RITA"    # santo/santa não são títulos descartáveis
