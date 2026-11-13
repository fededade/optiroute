"""Server HTTP locale della modalità servizio — contratto v1.

Solo libreria standard (http.server). Ascolta SOLO su 127.0.0.1, gira in un
thread daemon; Selenium resta nel thread principale. I dati esposti sono
uno snapshot protetto da lock, aggiornato dal giro.

Contratto v1 (il client nella web app OptiRoute si basa su questo):
- GET /v1/health   → 200 {"bridge":"optiroute-bridge","version":1,
                     "attivazione":"non_richiesta"|"in_attesa"|"attivo",
                     "portali":[{id,status,lastSync}], "pratiche":<numero>,
                     "intervalloMinuti":<minuti>}
                     senza token e senza dati personali (mai `message`, mai
                     il contenuto delle pratiche)
- GET /v1/pratiche → 200 {bridge, version, generatedAt, portals[], pratiche[]}
                     token in header X-Bridge-Token oppure query ?token=
                     token mancante/errato → 401 {"error":"token"}
                     in modalità gestionale, prima dell'attivazione →
                     409 {"error":"non_attivo"}
- POST /v1/attiva  → attivazione dal gestionale (vedi la classe Attivazione)
- OPTIONS *        → 204 (preflight CORS)
CORS su ogni risposta: Access-Control-Allow-Origin = Origin della richiesta
(o '*'), Vary: Origin.

"Modalità gestionale" = è configurato almeno un indirizzo del gestionale
(bridge_config.json oppure --gestionale). Senza, il bridge funziona come
prima (attivazione "non_richiesta", token incollato a mano).

I dati sono personali (nomi, telefoni): nessun endpoint li espone senza
token e il token non viene mai scritto nei log.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import secrets
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

BRIDGE_NAME = "optiroute-bridge"
API_VERSION = 1
HOST = "127.0.0.1"
DEFAULT_PORT = 8765
INTERVALLO_DEFAULT_MIN = 15

STATI_PORTALE = ("starting", "login_required", "running", "ok", "error")

# Una ri-attivazione con lo stesso token entro questo tempo non richiama
# Firestore (secondi).
RIUSO_VERIFICA_SEC = 5 * 60
# Corpo massimo accettato (e scartato) su POST.
CORPO_MAX = 64 * 1024


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

    def __init__(self, intervallo_minuti: float = INTERVALLO_DEFAULT_MIN):
        self._lock = threading.Lock()
        self._portals: dict[str, dict] = {}
        self._pratiche: dict[str, list[dict]] = {}
        self.intervallo_minuti = intervallo_minuti

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

    def salute(self) -> dict:
        """Parte di /v1/health che dipende dai dati: SOLO lo stato dei portali
        (senza `message`, che può contenere dati personali) e il numero delle
        pratiche."""
        with self._lock:
            portali = [{"id": p["id"], "status": p["status"], "lastSync": p.get("lastSync")}
                       for p in self._portals.values()]
            n = sum(len(rs) for rs in self._pratiche.values())
        minuti = self.intervallo_minuti
        if isinstance(minuti, float) and minuti.is_integer():
            minuti = int(minuti)
        return {"portali": portali, "pratiche": n, "intervalloMinuti": minuti}


# ---------------------------------------------------------------------------
# ATTIVAZIONE DAL GESTIONALE
# ---------------------------------------------------------------------------

class Attivazione:
    """Stato dell'attivazione dal gestionale.

    - `origini`: indirizzi (origin) del gestionale autorizzati; vuoto =
      modalità manuale (attivazione "non_richiesta").
    - `verifica(token)` → Utente, oppure solleva ErroreVerifica
      (verifica_gestionale.verifica_admin; sostituibile nei test).

    Le verifiche non avvengono mai in parallelo; una ri-attivazione con lo
    stesso token (se ne conserva solo l'impronta SHA-256) entro
    RIUSO_VERIFICA_SEC non richiama Firestore. Una volta attivo, il bridge
    resta attivo finché il programma resta acceso.
    """

    def __init__(self, origini=(), verifica=None, orologio=time.monotonic, log=None):
        self.origini = tuple(origini)
        self._verifica = verifica
        self._orologio = orologio
        self._log = log or (lambda _msg: None)
        self._lock = threading.Lock()            # stato
        self._lock_verifica = threading.Lock()   # una verifica alla volta
        self._evento = threading.Event()
        self._utente = None
        # impronta SHA-256 dei token verificati di recente → (quando, utente)
        self._recenti: dict[str, tuple[float, object]] = {}

    @property
    def gestionale(self) -> bool:
        return bool(self.origini)

    @property
    def attivo(self) -> bool:
        return self._evento.is_set()

    @property
    def utente(self):
        with self._lock:
            return self._utente

    def stato(self) -> str:
        if not self.gestionale:
            return "non_richiesta"
        return "attivo" if self.attivo else "in_attesa"

    def attendi(self, timeout: float | None = None) -> bool:
        """True quando il bridge è stato attivato (attesa massima `timeout`)."""
        return self._evento.wait(timeout)

    @staticmethod
    def _risposta_ok(utente) -> tuple[int, dict]:
        return 200, {"attivo": True, "utente": {"nome": utente.nome, "ruolo": utente.ruolo}}

    def attiva(self, origine: str | None, token: str | None) -> tuple[int, dict]:
        """Controlli del contratto, nell'ordine. Ritorna (stato HTTP, corpo
        SENZA il token del bridge: lo aggiunge il server)."""
        from verifica_gestionale import ErroreVerifica

        if not self.gestionale:
            return 409, {"error": "non_configurato"}
        if not origine or origine not in self.origini:
            self._log(f"Attivazione rifiutata: indirizzo non autorizzato ({origine or 'assente'}).")
            return 403, {"error": "origine"}
        if not token:
            self._log("Attivazione rifiutata: manca l'accesso al gestionale.")
            return 401, {"error": "token"}

        impronta = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self._lock_verifica:
            with self._lock:
                adesso = self._orologio()
                self._recenti = {k: v for k, v in self._recenti.items()
                                 if adesso - v[0] < RIUSO_VERIFICA_SEC}
                recente = self._recenti.get(impronta)
                if self.attivo and recente is not None:
                    return self._risposta_ok(recente[1])
            try:
                if self._verifica is None:
                    raise ErroreVerifica("verifica", "verifica non disponibile")
                utente = self._verifica(token)
            except ErroreVerifica as e:
                if e.codice == "ruolo":
                    u = e.utente
                    chi = (f"{u.nome or 'utente'} ({u.ruolo or 'ruolo sconosciuto'})"
                           if u else "l'utente")
                    self._log(f"Attivazione rifiutata: {chi} non è un amministratore del gestionale.")
                    return 403, {"error": "ruolo"}
                if e.codice == "token":
                    self._log(f"Attivazione rifiutata: accesso al gestionale non valido "
                              f"({e.descrizione}).")
                    return 401, {"error": "token"}
                self._log(f"Attivazione non riuscita: {e.descrizione}.")
                return 502, {"error": "verifica"}
            except Exception as e:  # noqa: BLE001 — mai un errore 500 con dettagli
                self._log(f"Attivazione non riuscita: errore imprevisto ({type(e).__name__}).")
                return 502, {"error": "verifica"}
            with self._lock:
                gia_attivo = self.attivo
                self._utente = utente
                self._recenti[impronta] = (self._orologio(), utente)
                self._evento.set()
            if gia_attivo:
                self._log(f"Attivazione confermata da {utente.nome or 'utente'} ({utente.ruolo}).")
            return self._risposta_ok(utente)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    server_version = "OptiRouteBridge/1"
    # Impostati da make_server sulla sottoclasse
    state: BridgeState
    token: str
    attivazione: Attivazione

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

    def _scarta_corpo(self) -> bool:
        """Legge e scarta l'eventuale corpo della richiesta. False se è
        troppo grande o non dichiarato con Content-Length (la connessione
        verrà chiusa)."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > CORPO_MAX or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            return False
        while n > 0:
            blocco = self.rfile.read(min(n, 8192))
            if not blocco:
                break
            n -= len(blocco)
        return True

    def _bearer(self) -> str:
        valore = (self.headers.get("Authorization") or "").strip()
        schema, _, resto = valore.partition(" ")
        if schema.lower() != "bearer":
            return ""
        return resto.strip()

    # --- metodi ---

    def do_OPTIONS(self):  # noqa: N802 — nome imposto da http.server
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "X-Bridge-Token, Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parti = urlsplit(self.path)
        percorso = parti.path.rstrip("/") or "/"
        query = parse_qs(parti.query)

        if percorso == "/v1/health":
            corpo = {"bridge": BRIDGE_NAME, "version": API_VERSION,
                     "attivazione": self.attivazione.stato()}
            corpo.update(self.state.salute())
            self._json(200, corpo)
            return
        if percorso == "/v1/pratiche":
            if self.attivazione.gestionale and not self.attivazione.attivo:
                self._json(409, {"error": "non_attivo"})
                return
            if not self._token_ok(query):
                self._json(401, {"error": "token"})
                return
            self._json(200, self.state.snapshot())
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if not self._scarta_corpo():
            self._json(413, {"error": "corpo"})
            return
        percorso = urlsplit(self.path).path.rstrip("/") or "/"
        if percorso != "/v1/attiva":
            self._metodo_non_ammesso()
            return
        stato, corpo = self.attivazione.attiva(self.headers.get("Origin"), self._bearer())
        if stato == 200:
            corpo = {"attivo": True, "token": self.token, "utente": corpo["utente"]}
        self._json(stato, corpo)

    def _metodo_non_ammesso(self):
        self._json(405, {"error": "method"})

    do_PUT = do_PATCH = do_DELETE = _metodo_non_ammesso


def make_server(state: BridgeState, token: str, port: int = DEFAULT_PORT,
                host: str = HOST, attivazione: Attivazione | None = None) -> ThreadingHTTPServer:
    """Crea il server (non ancora avviato). port=0 → porta libera effimera.
    `attivazione` assente = modalità manuale. Solleva OSError se la porta è
    occupata."""
    if host != HOST:
        raise ValueError("Il bridge ascolta solo in locale (127.0.0.1).")
    attivazione = attivazione or Attivazione()
    handler = type("BridgeHandler", (_Handler,),
                   {"state": state, "token": token, "attivazione": attivazione})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def start_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    """Avvia serve_forever in un thread daemon (muore col processo)."""
    t = threading.Thread(target=server.serve_forever, name="bridge-http", daemon=True)
    t.start()
    return t
