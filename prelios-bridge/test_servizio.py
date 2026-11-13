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


# ---------------------------------------------------------------------------
# Modalità gestionale: il browser parte SOLO dopo l'attivazione
# ---------------------------------------------------------------------------

ORIGINE = "https://gestionale.example"
TOKEN_ADMIN = "id-token-admin-di-prova"


class Fermati(BaseException):
    """Interrompe il loop infinito del servizio nei test (non è un Exception,
    quindi il ciclo non la intercetta)."""


class FintoBrowser:
    def __init__(self, registro: list[str]):
        self.registro = registro
        self.is_running = True

    def start(self):
        self.registro.append("browser.start")

    def stop(self):
        self.registro.append("browser.stop")


class AdapterCheSiFerma(FakeAdapter):
    def __init__(self, registro: list[str]):
        super().__init__([pratica("4001")], {})
        self.registro = registro

    def is_logged_in(self, browser) -> bool:
        self.registro.append("portale.is_logged_in")
        return True

    def list_assigned(self, browser, log=print):
        self.registro.append("portale.list_assigned")
        raise Fermati()


def _verifica_finta(token: str):
    from verifica_gestionale import ErroreVerifica, Utente
    if token != TOKEN_ADMIN:
        raise ErroreVerifica("ruolo", "non admin", Utente("Tecnico Prova", "Tecnico"))
    return Utente("Anna Prova", "Amministratore")


def test_attende_attivazione() -> None:
    import threading
    import time

    from bridge_server import Attivazione

    registro: list[str] = []
    adapter = AdapterCheSiFerma(registro)
    path = Path(tempfile.mkdtemp(prefix="test_servizio_")) / "bridge_cache.json"
    args = SimpleNamespace(elenco=None, limit=0, interval=15, dry_run=False)
    state = BridgeState()

    def crea_browser():
        registro.append("browser.crea")
        return FintoBrowser(registro)

    s = _Servizio(args, adapter, BridgeCache(path), state, crea_browser=crea_browser)
    att = Attivazione([ORIGINE], verifica=_verifica_finta)
    esito: list[str] = []

    def gira():
        try:
            s.esegui(att)
        except Fermati:
            esito.append("fermato")

    t = threading.Thread(target=gira, daemon=True)
    t.start()
    time.sleep(0.8)
    assert t.is_alive() and registro == [], registro   # nessun browser, nessun portale
    # un tecnico non basta
    assert att.attiva(ORIGINE, "id-token-tecnico")[0] == 403
    time.sleep(0.6)
    assert registro == [], registro
    # attivazione da un altro thread (come fa il server HTTP)
    assert att.attiva(ORIGINE, TOKEN_ADMIN)[0] == 200
    t.join(5)
    assert not t.is_alive() and esito == ["fermato"]
    assert registro[:3] == ["browser.crea", "browser.start", "portale.is_logged_in"], registro
    assert registro[-1] == "browser.stop", registro
    print("OK test_attende_attivazione")


def _prepara_esegui(tmp: Path, registro: list[str]):
    """Sostituisce in servizio.py ciò che toccherebbe disco reale, portale e
    porta fissa. Ritorna (ripristina, server catturati)."""
    import servizio

    originali = (servizio.CACHE_PATH, servizio.TOKEN_PATH, servizio.get_adapter,
                 servizio.make_server)
    server_creati = []

    def make_server_spia(*a, **kw):
        srv = originali[3](*a, **kw)
        server_creati.append(srv)
        return srv

    servizio.CACHE_PATH = tmp / "bridge_cache.json"
    servizio.TOKEN_PATH = tmp / "bridge_token.txt"
    servizio.get_adapter = lambda *a, **kw: AdapterCheSiFerma(registro)
    servizio.make_server = make_server_spia

    def ripristina():
        (servizio.CACHE_PATH, servizio.TOKEN_PATH, servizio.get_adapter,
         servizio.make_server) = originali

    return ripristina, server_creati


def _http(port: int, metodo: str, percorso: str, headers: dict | None = None):
    import http.client
    import json
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(metodo, percorso, headers=headers or {})
        r = conn.getresponse()
        return r.status, json.loads(r.read().decode("utf-8"))
    finally:
        conn.close()


def _esegui_in_thread(argv: list[str], config: Path, registro: list[str]):
    import io
    import threading
    from contextlib import redirect_stdout

    import run_giro
    import servizio

    args = run_giro.crea_parser().parse_args(argv)
    uscita = io.StringIO()
    esito: list[str] = []

    def gira():
        with redirect_stdout(uscita):
            try:
                servizio.esegui_servizio(args, verifica=_verifica_finta, config_path=config,
                                         crea_browser=lambda: FintoBrowser(registro))
            except Fermati:
                esito.append("fermato")

    t = threading.Thread(target=gira, daemon=True)
    t.start()
    return t, uscita, esito


def _attendi_server(server_creati: list, secondi: float = 5.0) -> int:
    import time
    fine = time.monotonic() + secondi
    while not server_creati and time.monotonic() < fine:
        time.sleep(0.05)
    assert server_creati, "server non avviato"
    return server_creati[0].server_address[1]


def test_esegui_servizio_gestionale() -> None:
    import time

    from bridge_config import salva_config

    tmp = Path(tempfile.mkdtemp(prefix="test_servizio_gest_"))
    config = tmp / "bridge_config.json"
    salva_config({"gestionale": [ORIGINE]}, config)
    registro: list[str] = []
    ripristina, server_creati = _prepara_esegui(tmp, registro)
    try:
        t, uscita, esito = _esegui_in_thread(["--serve", "--port", "0"], config, registro)
        port = _attendi_server(server_creati)
        time.sleep(0.3)
        st, salute = _http(port, "GET", "/v1/health")
        assert st == 200 and salute["attivazione"] == "in_attesa", salute
        assert salute["intervalloMinuti"] == 15
        assert registro == [], registro
        st, dati = _http(port, "POST", "/v1/attiva",
                         {"Origin": ORIGINE, "Authorization": f"Bearer {TOKEN_ADMIN}"})
        assert st == 200 and dati["utente"]["nome"] == "Anna Prova", dati
        t.join(5)
        assert esito == ["fermato"], esito
        assert registro[0] == "browser.start", registro
        testo = uscita.getvalue()
        assert "IN ATTESA DI ATTIVAZIONE" in testo, testo
        assert "Anna Prova (Amministratore)" in testo, testo
        assert "Token da incollare" not in testo
        token_bridge = (tmp / "bridge_token.txt").read_text(encoding="utf-8").strip()
        assert token_bridge not in testo and TOKEN_ADMIN not in testo
    finally:
        ripristina()
    print("OK test_esegui_servizio_gestionale")


def test_esegui_servizio_manuale() -> None:
    """Senza gestionale: come prima (token stampato, browser subito)."""
    tmp = Path(tempfile.mkdtemp(prefix="test_servizio_man_"))
    registro: list[str] = []
    ripristina, server_creati = _prepara_esegui(tmp, registro)
    try:
        t, uscita, esito = _esegui_in_thread(["--serve", "--port", "0"],
                                             tmp / "bridge_config.json", registro)
        t.join(5)
        assert esito == ["fermato"], esito
        assert registro[0] == "browser.start", registro
        testo = uscita.getvalue()
        assert "Token da incollare" in testo and "IN ATTESA" not in testo, testo
        port = server_creati[0].server_address[1]
        assert port  # server chiuso a fine esecuzione: non lo si interroga più
    finally:
        ripristina()
    print("OK test_esegui_servizio_manuale")


def test_ctrl_c_in_attesa() -> None:
    """Ctrl+C mentre si aspetta l'attivazione: uscita pulita (codice 0)."""
    import _thread
    import io
    import threading
    from contextlib import redirect_stdout

    import run_giro
    import servizio
    from bridge_config import salva_config

    tmp = Path(tempfile.mkdtemp(prefix="test_servizio_ctrlc_"))
    config = tmp / "bridge_config.json"
    salva_config({"gestionale": [ORIGINE]}, config)
    registro: list[str] = []
    ripristina, server_creati = _prepara_esegui(tmp, registro)
    timer = threading.Timer(0.8, _thread.interrupt_main)
    try:
        args = run_giro.crea_parser().parse_args(["--serve", "--port", "0"])
        uscita = io.StringIO()
        timer.start()
        with redirect_stdout(uscita):
            codice = servizio.esegui_servizio(args, verifica=_verifica_finta, config_path=config,
                                              crea_browser=lambda: FintoBrowser(registro))
    finally:
        timer.cancel()
        ripristina()
    assert codice == 0, codice
    assert registro == [], registro
    assert "Interrotto dall'operatore" in uscita.getvalue()
    print("OK test_ctrl_c_in_attesa")


def test_intervallo_default() -> None:
    import run_giro
    from bridge_server import BridgeState as Stato

    assert run_giro.crea_parser().parse_args(["--serve"]).interval == 15
    assert run_giro.crea_parser().parse_args(["--serve", "--interval", "5"]).interval == 5
    assert Stato().intervallo_minuti == 15
    print("OK test_intervallo_default")


def main() -> int:
    test_solo_nuove()
    test_sessione_persa()
    test_elenco_vuoto_non_cancella()
    test_attende_attivazione()
    test_esegui_servizio_gestionale()
    test_esegui_servizio_manuale()
    test_ctrl_c_in_attesa()
    test_intervallo_default()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
