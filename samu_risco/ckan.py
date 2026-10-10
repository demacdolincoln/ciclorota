"""Cliente mínimo da API CKAN (somente biblioteca padrão)."""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import config


class CkanErro(RuntimeError):
    pass


def _get(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": config.UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def chamar(acao: str, tentativas: int = 3, **params):
    """Chama uma ação da API e devolve `result`. Repete em falhas de rede/5xx."""
    qs = {k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
          for k, v in params.items() if v is not None}
    url = f"{config.API}/{acao}?" + urllib.parse.urlencode(qs)
    ultimo = None
    for i in range(tentativas):
        try:
            with _get(url, {"Accept": "application/json"}) as r:
                d = json.loads(r.read().decode("utf-8"))
            if not d.get("success"):
                raise CkanErro(f"{acao}: {d.get('error')}")
            return d["result"]
        except urllib.error.HTTPError as e:
            ultimo = e
            if e.code < 500:
                raise CkanErro(f"{acao}: HTTP {e.code}") from e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            ultimo = e
        time.sleep(1.5 * (i + 1))
    raise CkanErro(f"{acao}: falhou após {tentativas} tentativas ({ultimo})")


def buscar_pacotes(q: str, rows: int = 100) -> list[dict]:
    return chamar("package_search", q=q, rows=rows)["results"]


def pacote(slug: str) -> dict:
    return chamar("package_show", id=slug)


def baixar(url: str, destino: Path, tentativas: int = 3, timeout: int = 180) -> Path:
    """Baixa para `destino` (via .part) conferindo o tamanho quando informado."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    parte = destino.with_suffix(destino.suffix + ".part")
    ultimo = None
    for i in range(tentativas):
        try:
            with _get(url, timeout=timeout) as r, open(parte, "wb") as f:
                esperado = r.headers.get("Content-Length")
                n = 0
                while True:
                    bloco = r.read(1 << 20)
                    if not bloco:
                        break
                    f.write(bloco)
                    n += len(bloco)
            if esperado and int(esperado) != n:
                raise IOError(f"tamanho divergente: {n} de {esperado} bytes")
            parte.replace(destino)
            return destino
        except (urllib.error.URLError, TimeoutError, IOError) as e:
            ultimo = e
            time.sleep(2 * (i + 1))
    raise CkanErro(f"download falhou ({url}): {ultimo}")
