#!/usr/bin/env python3
"""Test del server HTTP locale (contratto v1) — solo libreria standard.

Avvia il server su una porta libera effimera di 127.0.0.1 e verifica:
health senza token, 401 senza/con token errato, 200 con token in header e in
query, formato della risposta, header CORS (Origin riflesso / '*', Vary) e
risposta al preflight OPTIONS. Dati SINTETICI. Niente rete esterna.

Esecuzione:
    python test_bridge_server.py
"""

from __future__ import annotations

import http.client
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_server import (  # noqa: E402
    BridgeState,
    carica_o_crea_token,
    make_server,
    start_in_thread,
)

TOKEN = "token-di-prova-123"
RE_ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

PRATICA = {
    "portal": "prelios", "codice": "826361", "intestatario": "ROSSI MARIO",
    "via": "VIA ROMA", "civico": "10", "comune": "PAVIA", "provincia": "PV",
    "telefono": "+393331234567", "note": "nota", "progetto": "PROGETTO X",
    "tipologia": "FULL - Acquisto", "esito": "OK", "aggiornatoIl": "2026-11-11T09:29:41Z",
}


def _richiesta(port: int, metodo: str, path: str, headers: dict | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(metodo, path, headers=headers or {})
        r = conn.getresponse()
        body = r.read()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, body
    finally:
        conn.close()


def _json(body: bytes) -> dict:
    return json.loads(body.decode("utf-8"))


def test_server() -> None:
    state = BridgeState()
    state.set_portal("prelios", "ok", "1 pratiche, 1 con telefono",
                     last_sync="2026-11-11T09:29:41Z")
    state.set_pratiche("prelios", [PRATICA])

    server = make_server(state, TOKEN, port=0)
    port = server.server_address[1]
    assert server.server_address[0] == "127.0.0.1"
    start_in_thread(server)
    try:
        # --- health: senza token ---
        st, h, body = _richiesta(port, "GET", "/v1/health")
        assert st == 200, st
        assert _json(body) == {"bridge": "optiroute-bridge", "version": 1}
        assert h["access-control-allow-origin"] == "*", h
        assert h["vary"] == "Origin"
        assert h["content-type"].startswith("application/json")

        # --- pratiche senza token / token errato → 401 ---
        st, h, body = _richiesta(port, "GET", "/v1/pratiche")
        assert st == 401 and _json(body) == {"error": "token"}, (st, body)
        assert h["access-control-allow-origin"] == "*"
        st, _h, body = _richiesta(port, "GET", "/v1/pratiche",
                                  {"X-Bridge-Token": "sbagliato"})
        assert st == 401 and _json(body) == {"error": "token"}
        st, _h, _b = _richiesta(port, "GET", "/v1/pratiche?token=sbagliato")
        assert st == 401

        # --- token in header, con Origin riflesso ---
        origin = "https://optiroute.example"
        st, h, body = _richiesta(port, "GET", "/v1/pratiche",
                                 {"X-Bridge-Token": TOKEN, "Origin": origin})
        assert st == 200, st
        assert h["access-control-allow-origin"] == origin, h
        assert h["vary"] == "Origin"
        dati = _json(body)
        assert set(dati) == {"bridge", "version", "generatedAt", "portals", "pratiche"}, dati.keys()
        assert dati["bridge"] == "optiroute-bridge" and dati["version"] == 1
        assert RE_ISO_Z.match(dati["generatedAt"]), dati["generatedAt"]
        assert dati["portals"] == [{"id": "prelios", "status": "ok",
                                    "lastSync": "2026-11-11T09:29:41Z",
                                    "message": "1 pratiche, 1 con telefono"}], dati["portals"]
        assert dati["pratiche"] == [PRATICA]

        # --- token in query ---
        st, _h, body = _richiesta(port, "GET", f"/v1/pratiche?token={TOKEN}")
        assert st == 200 and _json(body)["pratiche"] == [PRATICA]

        # --- preflight OPTIONS ---
        st, h, body = _richiesta(port, "OPTIONS", "/v1/pratiche", {
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-Bridge-Token",
            "Access-Control-Request-Private-Network": "true",
        })
        assert st == 204, st
        assert body == b""
        assert h["access-control-allow-origin"] == origin
        assert h["vary"] == "Origin"
        assert h["access-control-allow-methods"] == "GET, OPTIONS"
        assert h["access-control-allow-headers"] == "X-Bridge-Token, Content-Type"
        assert h["access-control-allow-private-network"] == "true"
        assert h["access-control-max-age"] == "600"

        # --- lo stato si aggiorna (snapshot non condiviso) ---
        state.set_portal("prelios", "login_required", "Login richiesto")
        st, _h, body = _richiesta(port, "GET", "/v1/pratiche", {"X-Bridge-Token": TOKEN})
        p = _json(body)["portals"][0]
        assert p["status"] == "login_required"
        assert p["lastSync"] == "2026-11-11T09:29:41Z"  # lastSync conservato

        # --- percorso sconosciuto / metodo non ammesso ---
        st, _h, _b = _richiesta(port, "GET", "/v1/altro")
        assert st == 404
        st, _h, _b = _richiesta(port, "POST", "/v1/pratiche", {"X-Bridge-Token": TOKEN})
        assert st == 405
    finally:
        server.shutdown()
        server.server_close()
    print("OK test_server")


def test_stati_ammessi() -> None:
    state = BridgeState()
    for s in ("starting", "login_required", "running", "ok", "error"):
        state.set_portal("prelios", s, "")
    try:
        state.set_portal("prelios", "sconosciuto", "")
    except ValueError:
        pass
    else:
        raise AssertionError("stato non valido accettato")
    try:
        make_server(state, TOKEN, port=0, host="0.0.0.0")
    except ValueError:
        pass
    else:
        raise AssertionError("il server deve ascoltare solo su 127.0.0.1")
    print("OK test_stati_ammessi")


def test_token_persistente() -> None:
    path = Path(tempfile.mkdtemp(prefix="test_bridge_token_")) / "bridge_token.txt"
    t1, creato1 = carica_o_crea_token(path)
    t2, creato2 = carica_o_crea_token(path)
    assert creato1 and not creato2
    assert t1 == t2 and len(t1) >= 32
    print("OK test_token_persistente")


def main() -> int:
    test_server()
    test_stati_ammessi()
    test_token_persistente()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
