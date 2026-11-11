#!/usr/bin/env python3
"""Test PURI del ciclo della modalità servizio (servizio._Servizio.ciclo).

Adapter e browser FINTI (nessun Selenium, nessun portale), cache in una
cartella temporanea. Verifica: solo le pratiche nuove vengono aperte, lo
stato pubblicato (ok/messaggio/lastSync), la sessione persa a metà ciclo
(→ 'login', pratica NON registrata come tentata) e l'elenco vuoto letto dal
portale (non cancella l'ultimo elenco noto).

Esecuzione:
    python test_servizio.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_cache import BridgeCache  # noqa: E402
from bridge_server import BridgeState  # noqa: E402
from excel_pratiche import Pratica  # noqa: E402
from portals import PortalAdapter  # noqa: E402
from servizio import _Servizio  # noqa: E402


def pratica(codice: str) -> Pratica:
    return Pratica(codice=codice, intestatario="ROSSI MARIO", via="VIA ROMA",
                   civico="1", comune="PAVIA", provincia="PV", progetto="P")


class FakeAdapter(PortalAdapter):
    id = "prelios"
    nome = "Finto"
    supporta_elenco = True

    def __init__(self, elenco, telefoni, cade_su=None):
        self.elenco = elenco
        self.telefoni = telefoni
        self.cade_su = cade_su
        self.loggato = True
        self.aperte: list[str] = []

    def is_logged_in(self, browser) -> bool:
        return self.loggato

    def list_assigned(self, browser, log=print):
        return list(self.elenco)

    def enrich(self, browser, p, log=print):
        if p.codice == self.cade_su:
            self.loggato = False
            raise RuntimeError("sessione scaduta")
        self.aperte.append(p.codice)
        tel = self.telefoni.get(p.codice, "")
        return tel, ("OK" if tel else "OK (telefono non trovato)"), ""


def _servizio(adapter) -> tuple[_Servizio, BridgeState]:
    path = Path(tempfile.mkdtemp(prefix="test_servizio_")) / "bridge_cache.json"
    args = SimpleNamespace(elenco=None, limit=0, interval=30)
    state = BridgeState()
    s = _Servizio(args, adapter, BridgeCache(path), state)
    s.browser = object()
    return s, state


def test_solo_nuove() -> None:
    a = FakeAdapter([pratica("1001"), pratica("1002")], {"1001": "+393331234567"})
    s, state = _servizio(a)
    assert s.ciclo() == "ok"
    assert a.aperte == ["1001", "1002"]
    snap = state.snapshot()
    (portale,) = snap["portals"]
    assert portale["status"] == "ok" and portale["message"] == "2 pratiche, 1 con telefono"
    assert portale["lastSync"]
    assert [r["telefono"] for r in snap["pratiche"]] == ["+393331234567", ""]

    # Secondo ciclo, stesso giorno, con una pratica nuova: si apre SOLO quella
    a.aperte.clear()
    a.elenco.append(pratica("1003"))
    assert s.ciclo() == "ok"
    assert a.aperte == ["1003"], a.aperte
    print("OK test_solo_nuove")


def test_sessione_persa() -> None:
    a = FakeAdapter([pratica("2001"), pratica("2002"), pratica("2003")],
                    {"2001": "+393331234567"}, cade_su="2002")
    s, _state = _servizio(a)
    assert s.ciclo() == "login"
    # 2002 NON e' registrata come tentata: dopo il login viene rifatta
    a.loggato, a.cade_su = True, None
    a.aperte.clear()
    assert s.ciclo() == "ok"
    assert a.aperte == ["2002", "2003"], a.aperte
    print("OK test_sessione_persa")


def test_elenco_vuoto_non_cancella() -> None:
    a = FakeAdapter([pratica("3001")], {"3001": "+393331234567"})
    s, state = _servizio(a)
    assert s.ciclo() == "ok"
    a.elenco = []
    assert s.ciclo() == "errore"
    snap = state.snapshot()
    assert snap["portals"][0]["status"] == "error"
    assert [r["codice"] for r in snap["pratiche"]] == ["3001"]
    print("OK test_elenco_vuoto_non_cancella")


def main() -> int:
    test_solo_nuove()
    test_sessione_persa()
    test_elenco_vuoto_non_cancella()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
