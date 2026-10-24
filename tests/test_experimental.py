"""Módulos JS experimentais (templates/experimental/*.js) são concatenados ao rotas.js pelo build."""
from pathlib import Path

from samu_risco import build

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"


def test_experimental_concatena_modulos():
    js = build._experimental(TEMPLATES)
    assert "function casarGrafo(" in js and "function compararCaminhosGrafo(" in js


def test_experimental_ausente_nao_quebra(tmp_path):
    assert build._experimental(tmp_path) == ""


def test_html_gerado_inclui_botao_e_modulo():
    html = (TEMPLATES / "index.html").read_text(encoding="utf-8")
    assert 'id="btnMM"' in html and 'id="mmMsg"' in html
