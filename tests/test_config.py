import pytest

from samu_risco.config import classificar_subtipo as c


@pytest.mark.parametrize("sub,esperado", [
    ("ACIDENTE DE TRANSITO ENVOLVENDO MOTO", ("Moto", "Acidente")),
    ("ACIDENTE DE TRÂNSITO COM CARROS", ("Carro", "Acidente")),
    ("ATROPELCARRO", ("Carro", "Atropelamento")),            # nomes de 2016-2020
    ("ATROPELMOTO", ("Moto", "Atropelamento")),
    ("ATROPELONIBUS", ("Ônibus/Caminhão", "Atropelamento")),
    ("ATROPELBIKE", ("Bicicleta", "Atropelamento")),
    ("ACIDMOTO", ("Moto", "Acidente")),                       # variante hipotética: pela regra
    ("ACIDENTE COM ANIMAIS TERRESTRES", None),
    ("ACIDENTE COM OBJETO PERFURO-CORTANTE/CONTUDENTE", None),
    ("PARADA CARDIORRESPIRATORIA", None), ("", None), (None, None),
])
def test_classificar_subtipo(sub, esperado):
    assert c(sub) == esperado
