"""Servidor CKAN simulado (formatos observados no portal real) para os testes."""
import csv
import io
import json
import random
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from samu_risco.config import SUBTIPOS

ENDS = ["R CONDE DO IRAJA", "AV AGAMENON MAGALHAES 1200", "AV CAXANGA", "R DA AURORA",
        "BR 101 KM 5", "AV NORTE", "R FRASCISCO JASINTO", "AV BEBERIBE SENTIDO SUBURBIO",
        "PONTE DA BOA VISTA", "AV 17 DE AGOSTO 100", "R INEXISTENTE QUALQUER"]
BAIRROS = ["BOA VIAGEM", "TORRE", "CASA AMARELA", "BOA VISTA", "ILHA DO LEITE"]
SUBS = list(SUBTIPOS) + ["PARADA CARDIACA", "OUTROS"]


def csv_moderno(ano, n=300, sep=";", enc="utf-8-sig", seed=0, subs=None):
    rnd = random.Random(seed + ano)
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=sep, quoting=csv.QUOTE_ALL, lineterminator="\n")
    w.writerow(["data", "hora_minuto", "municipio", "bairro", "endereco", "origem_chamado", "tipo",
                "subtipo", "sexo", "idade", "motivo_finalizacao", "motivo_desfecho"])
    for _ in range(n):
        d = f"{ano}-{rnd.randint(1, 12):02d}-{rnd.randint(1, 28):02d}T00:00:00"
        w.writerow([d, f"{rnd.randint(0, 23):02d}:{rnd.randint(0, 59):02d}:10",
                    rnd.choice(["RECIFE"] * 4 + ["OLINDA"]), rnd.choice(BAIRROS), rnd.choice(ENDS),
                    "VIA PÚBLICA", "CAUSAS EXTERNAS", rnd.choice(subs or SUBS), rnd.choice(["MASCULINO", "FEMININO"]),
                    rnd.choice(["25", "40,5", "", "130"]), "", "1. OCORRÊNCIA CONCLUÍDA COM ÊXITO"])
    return buf.getvalue().encode(enc)


def csv_legado(ano, n=50):
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_ALL, lineterminator="\n")
    w.writerow(["solicitacao_numero", "solicitacao_data", "paciente_sexo", "paciente_idadeanos",
                "bairrosaude_descricao", "origemchamado_descricao", "situacaosolicitacao_descricao",
                "sistemasaude_descricao"])
    for i in range(n):
        w.writerow([1000 + i, f"{ano}-03-01T14:04:00", "M", 37, "CAMPO GRANDE", "VIA PÚBLICA", "CONCLUIDA", "TRAUMA"])
    return buf.getvalue().encode("utf-8-sig")


def geojson(features):
    return json.dumps({"type": "FeatureCollection", "features": features}).encode()


def linha(x, y, props):
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "LineString", "coordinates": [[x, y], [x + 0.004, y + 0.001]]}}


def quadrado(i, nome):
    x, y = -34.95 + (i % 10) * 0.01, -8.12 + (i // 10) * 0.012
    return {"type": "Feature", "properties": {"bairro_nome": nome, "codigo": i},
            "geometry": {"type": "Polygon", "coordinates": [[[x, y], [x + .01, y], [x + .01, y + .012], [x, y + .012], [x, y]]]}}


class Mock:
    def __init__(self):
        self.arquivos = {}      # nome -> bytes
        self.pacotes = {}       # slug -> dict
        self.contagem = {}      # nome -> nº de downloads
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _json(self, obj, code=200):
                b = json.dumps(obj).encode()
                self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
                if u.path.startswith("/api/3/action/"):
                    a = u.path.rsplit("/", 1)[-1]
                    if a == "package_search":
                        return self._json({"success": True, "result": {"results": [
                            p for p in mock.pacotes.values() if q.get("q", "") in p["name"]]}})
                    if a == "package_show":
                        p = mock.pacotes.get(q["id"])
                        return self._json({"success": bool(p), "result": p, "error": "nao existe"}, 200 if p else 404)
                if u.path.startswith("/files/"):       # redireciona como o S3 presigned do portal
                    self.send_response(302); self.send_header("Location", "/store" + u.path[6:]); self.end_headers(); return
                if u.path.startswith("/store/"):
                    nome = u.path[7:]
                    mock.contagem[nome] = mock.contagem.get(nome, 0) + 1
                    b = mock.arquivos[nome]
                    self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers()
                    self.wfile.write(b); return
                self._json({"success": False}, 404)

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def api(self): return f"http://127.0.0.1:{self.port}/api/3/action"

    def add(self, slug, recursos, titulo=None):
        """recursos: [(nome, formato, nome_arquivo, bytes)]"""
        rs = []
        for i, (nome, fmt, arq, dados, *resto) in enumerate(recursos):
            self.arquivos[arq] = dados
            rs.append({"id": f"{slug}-{i}", "name": nome, "format": fmt, "size": len(dados),
                       "last_modified": resto[0] if resto else "2026-03-06T00:00:00", "metadata_modified": "2026-03-06",
                       "url": f"http://127.0.0.1:{self.port}/files/{arq}"})
        self.pacotes[slug] = {"name": slug, "title": titulo or slug, "resources": rs}

    def popular(self):
        self.add("servico-de-atendimento-movel-de-urgencia-samu-2015",
                 [("Solicitações de atendimento", "CSV", "s2015.csv", csv_legado(2015)),
                  ("Remoções", "CSV", "r2015.csv", csv_legado(2015, 5))])
        self.add("servico-de-atendimento-movel-de-urgencia-samu-2017",
                 [("Solicitações de Atendimento 2017", "CSV", "s2017.csv",
                   csv_moderno(2017, sep=",", enc="cp1252")),
                  ("Dicionário", "JSON", "d2017.json", b"{}")])
        for ano in (2024, 2025):
            self.add(f"servico-de-atendimento-movel-de-urgencia-samu-{ano}",
                     [("Dicionário", "JSON", f"d{ano}.json", b"{}"),
                      (f"Solicitações de Atendimento {ano}", "CSV", f"s{ano}.csv", csv_moderno(ano))])
        self.add("outro-conjunto-samu-lista", [("x", "CSV", "x.csv", b"a;b\n1;2\n")])   # sem ano: ignorado
        self.add("malha-cicloviaria-do-recife", [
            ("Malha", "GEOJSON", "ciclo.geojson", geojson([
                linha(-34.90, -8.05, {"tipo": "Ciclovia", "nome": "A"}),
                linha(-34.91, -8.06, {"tipo": "Ciclofaixa", "nome": "B"}),
                linha(-34.92, -8.07, {"tipo": "Ciclorrota", "nome": "C"}),
                linha(-34.93, -8.08, {"tipo": "Ciclovia", "nome": "D"})]))])
        sem = "id;endereco;latitude;longitude\n1;A;-8,0631;-34,8811\n2;B;-8,0700;-34,9000\n3;C;;\n4;D;0;0\n"
        self.add("localizacao-dos-semaforos", [("Semáforos", "CSV", "sem.csv", sem.encode("utf-8-sig"))])
        self.add("paraciclos-do-recife", [("Paraciclos", "GEOJSON", "para.geojson", geojson([
            {"type": "Feature", "properties": {"nome": "p"}, "geometry": {"type": "Point", "coordinates": [-34.9, -8.05]}}]))])
        self.add("area-urbana", [("Bairros", "GEOJSON", "bairros.geojson",
                                  geojson([quadrado(i, f"BAIRRO {i}") for i in range(64)]))])
        return self
