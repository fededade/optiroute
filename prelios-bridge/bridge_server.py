"""Server HTTP locale della modalità servizio — contratto v1.

Solo libreria standard (http.server). Ascolta SOLO su 127.0.0.1, gira in un
thread daemon; Selenium resta nel thread principale. I dati esposti sono
uno snapshot protetto da lock, aggiornato dal giro.

Contratto v1 (il client nella web app OptiRoute si basa su questo):
- GET /v1/health   → 200 {"bridge":"optiroute-bridge","version":1}  (no token)
- GET /v1/pratiche → 200 {bridge, version, generatedAt, portals[], pratiche[]}
                     token in header X-Bridge-Token oppure query ?token=
                     token mancante/errato → 401 {"error":"token"}
- OPTIONS *        → 204 (preflight CORS)
CORS su ogni risposta: Access-Control-Allow-Origin = Origin della richiesta
(o '*'), Vary: Origin.

I dati sono personali (nomi, telefoni): nessun endpoint li espone senza
token e il token non viene mai scritto nei log.
"""

from __future__ import annotations

import copy
import hmac
import json
import secrets
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

BRIDGE_NAME = "optiroute-bridge"
API_VERSION = 1
HOST = "127.0.0.1"
DEFAULT_PORT = 8765

STATI_PORTALE = ("starting", "login_required", "running", "ok", "error")


def _iso_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# TOKEN
# ---------------------------------------------------------------------------

def carica_o_crea_token(path: str | Path) -> tuple[str, bool]:
    """Legge il token da `path`; se manca lo genera (secrets.token_urlsafe) e
    lo salva. Ritorna (token, creato_ora)."""
    path = Path(path)
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return token, False
    token = secrets.token_urlsafe(32)
    path.write_text(token + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)  # solo l'utente corrente (dove il sistema lo consente)
    except OSError:
        pass
    return token, True


# ---------------------------------------------------------------------------
# STATO CONDIVISO
# ---------------------------------------------------------------------------

class BridgeState:
    """Snapshot dei dati esposti via HTTP, protetto da lock.

    Il thread del giro chiama set_portal()/set_pratiche(); il server legge
    con snapshot() (copia profonda, mai riferimenti condivisi)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._portals: dict[str, dict] = {}
        self._pratiche: dict[str, list[dict]] = {}

    def set_portal(self, portal_id: str, status: str, message: str = "",
                   last_sync: str | None = None, keep_last_sync: bool = True) -> None:
        if status not in STATI_PORTALE:
            raise ValueError(f"stato non valido: {status}")
        with self._lock:
            prec = self._portals.get(portal_id, {})
            if last_sync is None and keep_last_sync:
                last_sync = prec.get("lastSync")
            self._portals[portal_id] = {"id": portal_id, "status": status,
                                        "lastSync": last_sync, "message": message}

    def set_pratiche(self, portal_id: str, pratiche: list[dict]) -> None:
        with self._lock:
            self._pratiche[portal_id] = copy.deepcopy(pratiche)

    def portal_status(self, portal_id: str) -> str | None:
        with self._lock:
            p = self._portals.get(portal_id)
            return p["status"] if p else None

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "bridge": BRIDGE_NAME,
                "version": API_VERSION,
                "generatedAt": _iso_utc(),
                "portals": [copy.deepcopy(p) for p in self._portals.values()],
                "pratiche": [copy.deepcopy(r) for rs in self._pratiche.values() for r in rs],
            }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    server_version = "OptiRouteBridge/1"
    # Impostati da make_server sulla sottoclasse
    state: BridgeState
    token: str

    # Nessun log delle richieste: l'URL può contenere ?token=
    def log_message(self, format, *args):  # noqa: A002 — firma della stdlib
        return

    # --- utilità ---

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
        self.send_header("Vary", "Origin")

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _token_ok(self, query: dict) -> bool:
        ricevuto = self.headers.get("X-Bridge-Token") or ""
        if not ricevuto:
            ricevuto = (query.get("token") or [""])[0]
        if not ricevuto or not self.token:
            return False
        return hmac.compare_digest(ricevuto.encode("utf-8"), self.token.encode("utf-8"))

    # --- metodi ---

    def do_OPTIONS(self):  # noqa: N802 — nome imposto da http.server
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-Bridge-Token, Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parti = urlsplit(self.path)
        percorso = parti.path.rstrip("/") or "/"
        query = parse_qs(parti.query)

        if percorso == "/v1/health":
            self._json(200, {"bridge": BRIDGE_NAME, "version": API_VERSION})
            return
        if percorso == "/v1/pratiche":
            if not self._token_ok(query):
                self._json(401, {"error": "token"})
                return
            self._json(200, self.state.snapshot())
            return
        self._json(404, {"error": "not_found"})

    def _metodo_non_ammesso(self):
        self._json(405, {"error": "method"})

    do_POST = do_PUT = do_PATCH = do_DELETE = _metodo_non_ammesso


def make_server(state: BridgeState, token: str, port: int = DEFAULT_PORT,
                host: str = HOST) -> ThreadingHTTPServer:
    """Crea il server (non ancora avviato). port=0 → porta libera effimera.
    Solleva OSError se la porta è occupata."""
    if host != HOST:
        raise ValueError("Il bridge ascolta solo in locale (127.0.0.1).")
    handler = type("BridgeHandler", (_Handler,), {"state": state, "token": token})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def start_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    """Avvia serve_forever in un thread daemon (muore col processo)."""
    t = threading.Thread(target=server.serve_forever, name="bridge-http", daemon=True)
    t.start()
    return t
