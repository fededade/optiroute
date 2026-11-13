#!/usr/bin/env python3
"""Test dell'attivazione dal gestionale (POST /v1/attiva) — solo stdlib.

Server reale su una porta libera di 127.0.0.1, verifica amministratore
FINTA (nessuna chiamata a Firestore), orologio finto. Verifica: indirizzo
autorizzato / sconosciuto / assente, token mancante, utente non admin,
errore di verifica, ri-attivazione idempotente (senza richiamare la
verifica), /v1/pratiche 409 prima e 200 dopo, contenuto di /v1/health
(mai `message`, mai dati delle pratiche), preflight, verifiche mai in
parallelo, token mai nei log. Dati SINTETICI.

Esecuzione:
    python test_bridge_attivazione.py
"""

from __future__ import annotations

import http.client
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_server import Attivazione, BridgeState, make_server, start_in_thread  # noqa: E402
from verifica_gestionale import ErroreVerifica, Utente  # noqa: E402

TOKEN_BRIDGE = "token-bridge-di-prova-123"
ORIGINE = "https://gestionale.example"
ADMIN = "id-token-admin-di-prova"
TECNICO = "id-token-tecnico-di-prova"
SCADUTO = "id-token-scaduto-di-prova"
GUASTO = "id-token-rete-guasta-di-prova"
IMPREVISTO = "id-token-imprevisto-di-prova"

PRATICA = {
    "portal": "prelios", "codice": "826361", "intestatario": "ROSSI MARIO",
    "via": "VIA ROMA", "civico": "10", "comune": "PAVIA", "provincia": "PV",
    "telefono": "+393331234567", "note": "nota", "progetto": "PROGETTO X",
    "tipologia": "FULL - Acquisto", "esito": "OK", "aggiornatoIl": "2026-11-11T09:29:41Z",
}


class FintaVerifica:
    def __init__(self, ritardo: float = 0.0):
        self.chiamate: list[str] = []
        self.ritardo = ritardo
        self._lock = threading.Lock()
        self.in_corso = 0
        self.massimo_in_parallelo = 0

    def __call__(self, token: str) -> Utente:
        with self._lock:
            self.chiamate.append(token)
            self.in_corso += 1
            self.massimo_in_parallelo = max(self.massimo_in_parallelo, self.in_corso)
        try:
            if self.ritardo:
                time.sleep(self.ritardo)
            if token == TECNICO:
                raise ErroreVerifica("ruolo", "non admin", Utente("Tecnico Prova", "Tecnico"))
            if token == SCADUTO:
                raise ErroreVerifica("token", "accesso scaduto")
            if token == GUASTO:
                raise ErroreVerifica("verifica", "gestionale non raggiungibile")
            if token == IMPREVISTO:
                raise RuntimeError("guasto imprevisto")
            return Utente("Anna Prova", "Amministratore" if token == ADMIN else "Super Amministratore")
        finally:
            with self._lock:
                self.in_corso -= 1


class Orologio:
    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _richiesta(port: int, metodo: str, path: str, headers: dict | None = None,
               corpo: bytes | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(metodo, path, body=corpo, headers=headers or {})
        r = conn.getresponse()
        body = r.read()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, body
    finally:
        conn.close()


def _json(body: bytes) -> dict:
    return json.loads(body.decode("utf-8"))


def _attiva(port: int, token: str | None, origine: str | None = ORIGINE,
            corpo: bytes | None = None):
    headers = {}
    if origine is not None:
        headers["Origin"] = origine
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    st, h, body = _richiesta(port, "POST", "/v1/attiva", headers, corpo)
    return st, h, _json(body)


def _avvia(attivazione: Attivazione):
    state = BridgeState(intervallo_minuti=15.0)
    state.set_portal("prelios", "starting", "In attesa: ROSSI MARIO +393331234567",
                     last_sync="2026-11-11T09:29:41Z")
    state.set_pratiche("prelios", [PRATICA])
    server = make_server(state, TOKEN_BRIDGE, port=0, attivazione=attivazione)
    start_in_thread(server)
    return server, server.server_address[1]


def test_flusso_completo() -> None:
    verifica = FintaVerifica()
    orologio = Orologio()
    log: list[str] = []
    att = Attivazione([ORIGINE, "http://localhost:5000"], verifica=verifica,
                      orologio=orologio, log=log.append)
    server, port = _avvia(att)
    try:
        # --- health prima dell'attivazione ---
        st, h, body = _richiesta(port, "GET", "/v1/health", {"Origin": ORIGINE})
        assert st == 200
        assert _json(body) == {"bridge": "optiroute-bridge", "version": 1,
                               "attivazione": "in_attesa",
                               "portali": [{"id": "prelios", "status": "starting",
                                            "lastSync": "2026-11-11T09:29:41Z"}],
                               "pratiche": 1, "intervalloMinuti": 15}, body
        assert b"message" not in body and b"ROSSI" not in body and b"+39" not in body
        assert h["access-control-allow-origin"] == ORIGINE

        # --- /v1/pratiche prima dell'attivazione: 409 anche col token giusto ---
        st, _h, body = _richiesta(port, "GET", "/v1/pratiche", {"X-Bridge-Token": TOKEN_BRIDGE})
        assert st == 409 and _json(body) == {"error": "non_attivo"}, (st, body)
        st, _h, body = _richiesta(port, "GET", f"/v1/pratiche?token={TOKEN_BRIDGE}")
        assert st == 409

        # --- indirizzo sconosciuto / assente: 403, verifica NON chiamata ---
        for origine in ("https://altro.example", "https://gestionale.example.altro.example",
                        "http://gestionale.example", "null", None):
            st, _h, dati = _attiva(port, ADMIN, origine)
            assert st == 403 and dati == {"error": "origine"}, (origine, st, dati)
        assert verifica.chiamate == []

        # --- token mancante o non Bearer: 401, verifica NON chiamata ---
        st, _h, dati = _attiva(port, None)
        assert st == 401 and dati == {"error": "token"}
        st, _h, body = _richiesta(port, "POST", "/v1/attiva",
                                  {"Origin": ORIGINE, "Authorization": "Basic abc"})
        assert st == 401 and _json(body) == {"error": "token"}
        st, _h, dati = _attiva(port, "")
        assert st == 401
        assert verifica.chiamate == []

        # --- esiti negativi della verifica ---
        st, h, dati = _attiva(port, TECNICO)
        assert st == 403 and dati == {"error": "ruolo"}, (st, dati)
        assert h["access-control-allow-origin"] == ORIGINE
        st, _h, dati = _attiva(port, SCADUTO)
        assert st == 401 and dati == {"error": "token"}
        st, _h, dati = _attiva(port, GUASTO)
        assert st == 502 and dati == {"error": "verifica"}
        st, _h, dati = _attiva(port, IMPREVISTO)
        assert st == 502 and dati == {"error": "verifica"}
        assert not att.attivo and att.stato() == "in_attesa"
        st, _h, _b = _richiesta(port, "GET", "/v1/pratiche", {"X-Bridge-Token": TOKEN_BRIDGE})
        assert st == 409

        # --- attivazione riuscita (con un corpo, che viene ignorato) ---
        n = len(verifica.chiamate)
        st, h, dati = _attiva(port, ADMIN, corpo=b'{"ignorato": true}')
        assert st == 200, (st, dati)
        assert dati == {"attivo": True, "token": TOKEN_BRIDGE,
                        "utente": {"nome": "Anna Prova", "ruolo": "Amministratore"}}, dati
        assert h["access-control-allow-origin"] == ORIGINE and h["vary"] == "Origin"
        assert len(verifica.chiamate) == n + 1
        assert att.attivo and att.utente.nome == "Anna Prova"

        # --- ri-attivazione con lo stesso token: niente nuova verifica ---
        st, _h, dati = _attiva(port, ADMIN)
        assert st == 200 and dati["token"] == TOKEN_BRIDGE
        assert len(verifica.chiamate) == n + 1
        # ... anche dall'altro indirizzo autorizzato
        st, _h, _d = _attiva(port, ADMIN, "http://localhost:5000")
        assert st == 200 and len(verifica.chiamate) == n + 1
        # dopo 5 minuti si verifica di nuovo
        orologio.t += 301
        st, _h, _d = _attiva(port, ADMIN)
        assert st == 200 and len(verifica.chiamate) == n + 2
        # un altro token viene sempre verificato
        st, _h, dati = _attiva(port, "id-token-super-di-prova")
        assert st == 200 and dati["utente"]["ruolo"] == "Super Amministratore"
        assert len(verifica.chiamate) == n + 3
        # un tentativo fallito dopo l'attivazione non spegne il bridge
        st, _h, _d = _attiva(port, TECNICO)
        assert st == 403 and att.attivo

        # --- dopo l'attivazione: pratiche col token, health "attivo" ---
        st, _h, body = _richiesta(port, "GET", "/v1/pratiche", {"X-Bridge-Token": TOKEN_BRIDGE})
        assert st == 200 and _json(body)["pratiche"] == [PRATICA]
        st, _h, body = _richiesta(port, "GET", "/v1/pratiche")
        assert st == 401 and _json(body) == {"error": "token"}
        st, _h, body = _richiesta(port, "GET", "/v1/health")
        salute = _json(body)
        assert salute["attivazione"] == "attivo"
        assert "message" not in json.dumps(salute) and b"ROSSI" not in body

        # --- preflight per POST con Authorization ---
        st, h, body = _richiesta(port, "OPTIONS", "/v1/attiva", {
            "Origin": ORIGINE,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization",
            "Access-Control-Request-Private-Network": "true",
        })
        assert st == 204 and body == b""
        assert h["access-control-allow-origin"] == ORIGINE and h["vary"] == "Origin"
        assert h["access-control-allow-methods"] == "GET, POST, OPTIONS"
        assert h["access-control-allow-headers"] == "X-Bridge-Token, Content-Type, Authorization"
        assert h["access-control-allow-private-network"] == "true"

        # --- metodi e percorsi ---
        st, _h, _b = _richiesta(port, "GET", "/v1/attiva")
        assert st == 404
        st, _h, _b = _richiesta(port, "PUT", "/v1/attiva")
        assert st == 405
    finally:
        server.shutdown()
        server.server_close()

    # Nessun token (del gestionale o del bridge) nei messaggi di log
    testo = "\n".join(log)
    assert testo, "ci si aspettano righe di log"
    for segreto in (ADMIN, TECNICO, SCADUTO, GUASTO, TOKEN_BRIDGE):
        assert segreto not in testo, segreto
    print("OK test_flusso_completo")


def test_corpo_scartato_keep_alive() -> None:
    """Due POST sulla stessa connessione: il corpo del primo viene letto e
    scartato, il secondo viene interpretato correttamente."""
    att = Attivazione([ORIGINE], verifica=FintaVerifica())
    server, port = _avvia(att)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        for _ in range(2):
            conn.request("POST", "/v1/attiva", body=b"x" * 5000,
                         headers={"Origin": ORIGINE, "Authorization": f"Bearer {ADMIN}"})
            r = conn.getresponse()
            assert r.status == 200, r.status
            assert json.loads(r.read())["attivo"] is True
        conn.close()
        st, _h, body = _richiesta(port, "POST", "/v1/attiva",
                                  {"Origin": ORIGINE, "Authorization": f"Bearer {ADMIN}"},
                                  corpo=b"x" * (70 * 1024))
        assert st == 413
    finally:
        server.shutdown()
        server.server_close()
    print("OK test_corpo_scartato_keep_alive")


def test_mai_in_parallelo() -> None:
    verifica = FintaVerifica(ritardo=0.2)
    att = Attivazione([ORIGINE], verifica=verifica)
    server, port = _avvia(att)
    risultati: list[int] = []
    try:
        thread = [threading.Thread(target=lambda t=t: risultati.append(_attiva(port, t)[0]))
                  for t in ("id-token-uno-di-prova", "id-token-due-di-prova",
                            "id-token-tre-di-prova", ADMIN, ADMIN, ADMIN)]
        for t in thread:
            t.start()
        for t in thread:
            t.join(10)
    finally:
        server.shutdown()
        server.server_close()
    assert sorted(risultati) == [200] * 6, risultati
    assert verifica.massimo_in_parallelo == 1, verifica.massimo_in_parallelo
    # lo stesso token arrivato insieme viene verificato una volta sola
    assert verifica.chiamate.count(ADMIN) == 1, verifica.chiamate
    print("OK test_mai_in_parallelo")


def test_modalita_manuale() -> None:
    att = Attivazione()
    assert not att.gestionale and att.stato() == "non_richiesta"
    assert att.attiva(ORIGINE, ADMIN) == (409, {"error": "non_configurato"})
    print("OK test_modalita_manuale")


def main() -> int:
    test_flusso_completo()
    test_corpo_scartato_keep_alive()
    test_mai_in_parallelo()
    test_modalita_manuale()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
