import pytest

from samu_risco import config
from tests.mockdata import Mock


@pytest.fixture()
def mock(monkeypatch):
    m = Mock().popular()
    monkeypatch.setattr(config, "API", m.api)
    return m


@pytest.fixture()
def pasta(tmp_path):
    return config.pastas(str(tmp_path / "dados"))
