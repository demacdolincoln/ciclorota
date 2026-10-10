"""Valida com ferramentas independentes os arquivos exportados pelo teste do front-end."""
import glob
import json
import tarfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

OUT = Path(__file__).parent / "out"
NS = {"g": "http://www.topografix.com/GPX/1/1"}
z = zipfile.ZipFile(glob.glob(str(OUT / "saida_*.zip"))[0])
assert z.testzip() is None
for n in z.namelist():
    assert len(ET.fromstring(z.read(n)).findall(".//g:trkpt", NS)) >= 2
t = tarfile.open(glob.glob(str(OUT / "saida_*.tar.gz"))[0], "r:gz")
assert sorted(m.name for m in t.getmembers()) == sorted(z.namelist())
for m in t.getmembers():
    ET.fromstring(t.extractfile(m).read())
assert len(json.load(open(glob.glob(str(OUT / "saida_*.json"))[0]))["rotas"]) == 2
print("exportações OK:", z.namelist())
