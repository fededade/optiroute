"""Modalità servizio del bridge: `python run_giro.py --serve [elenco]`.

Dopo il login MANUALE (MFA) resta in esecuzione e a ogni ciclo:
1. rilegge l'elenco pratiche (dal file, se passato; altrimenti dal portale
   con adapter.list_assigned — best-effort);
2. recupera il telefono SOLO delle pratiche nuove (quelle già risolte con
   telefono non vengono riaperte, quelle senza telefono si ritentano al
   massimo una volta al giorno) — vedi bridge_cache.py;
3. pubblica i dati sul server HTTP locale (127.0.0.1, contratto v1 in
   bridge_server.py) da cui la web app OptiRoute li legge da sola.

Se la sessione del portale scade lo stato diventa `login_required` e il
bridge aspetta il nuovo login senza terminare. Ctrl+C per fermarlo.

Selenium gira SOLO in questo thread (principale); il server HTTP è in un
thread daemon e legge uno snapshot protetto da lock.
"""

from __future__ import annotations

import time
import traceback
from datetime import datetime
from pathlib import Path

from bridge_cache import BridgeCache, iso_utc
from bridge_server import BridgeState, carica_o_crea_token, make_server, start_in_thread
from excel_pratiche import load_pratiche
from portals import PortaleNonConfigurato, get_adapter

BRIDGE_DIR = Path(__file__).resolve().parent
CACHE_PATH = BRIDGE_DIR / "bridge_cache.json"
TOKEN_PATH = BRIDGE_DIR / "bridge_token.txt"

# Ogni quanto, durante l'attesa fra due cicli, si verifica che la sessione
# del portale sia ancora attiva (secondi).
CONTROLLO_SESSIONE_SEC = 120
# Durata di ogni attesa del login prima di ricontrollare (secondi).
ATTESA_LOGIN_SEC = 120


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def _stampa_avvio(port: int, token: str, creato: bool) -> None:
    riga = "=" * 68
    print(riga)
    print(f" OptiRoute Bridge in ascolto su http://127.0.0.1:{port}  (solo questo PC)")
    if creato:
        print(" Generato un NUOVO token di accesso.")
    print(" Token da incollare UNA volta nelle impostazioni di OptiRoute (bridge):")
    print(f"     {token}")
    print(f" Il token è salvato in {TOKEN_PATH.name}: non condividerlo.")
    print(" Ctrl+C per fermare il bridge.")
    print(riga, flush=True)


class _Servizio:
    """Stato del servizio per un singolo portale."""

    def __init__(self, args, adapter, cache: BridgeCache, state: BridgeState):
        self.args = args
        self.adapter = adapter
        self.pid = adapter.id
        self.cache = cache
        self.state = state
        self.browser = None

    # --- pubblicazione verso l'HTTP ---

    def pubblica(self) -> None:
        self.state.set_pratiche(self.pid, self.cache.snapshot(self.pid))

    def stato(self, status: str, message: str, last_sync: str | None = None) -> None:
        self.state.set_portal(self.pid, status, message, last_sync=last_sync)

    def salva(self) -> None:
        try:
            self.cache.save()
        except OSError as e:
            _log(f"ATTENZIONE: cache non salvata ({e})")

    # --- elenco ---

    def leggi_elenco(self):
        if self.args.elenco:
            return load_pratiche(self.args.elenco)
        return self.adapter.list_assigned(self.browser, log=_log)

    # --- browser e login ---

    def avvia_browser(self) -> bool:
        from browser import PreliosBrowser
        self.browser = PreliosBrowser()
        try:
            self.browser.start()
            return True
        except Exception as e:  # noqa: BLE001
            _log(f"ERRORE avvio browser ({e}). Chrome è installato? Selenium "
                 "presente? (pip install selenium; CHROME_PATH per un percorso "
                 "non standard)")
            self.stato("error", f"Avvio browser non riuscito: {e}"[:300])
            return False

    def _riavvia_browser(self) -> None:
        _log("Il browser non risponde: provo a riavviarlo...")
        try:
            self.browser.stop()
        except Exception:
            pass
        try:
            self.browser.start()
        except Exception as e:  # noqa: BLE001
            _log(f"Riavvio browser non riuscito ({e}); riprovo fra un minuto.")
            time.sleep(60)

    def assicura_login(self) -> None:
        """Ritorna solo quando la sessione del portale è attiva. Non termina
        mai per login mancante: aspetta l'operatore (stato login_required)."""
        if self.adapter.is_logged_in(self.browser):
            return
        self.stato("login_required",
                   "Login richiesto: completa il login (MFA) nella finestra "
                   "Chrome del bridge.")
        _log("Login richiesto: completa il login (MFA) nella finestra Chrome del bridge.")
        naviga = True
        while True:
            try:
                if self.adapter.login(self.browser, wait_seconds=ATTESA_LOGIN_SEC,
                                      log=_log, navigate=naviga):
                    _log("Login effettuato.")
                    self.stato("running", "Login effettuato.")
                    return
                naviga = False
            except Exception as e:  # noqa: BLE001
                _log(f"Errore durante l'attesa del login: {e}")
                if not self.browser.is_running:
                    self._riavvia_browser()
                    naviga = True
                else:
                    time.sleep(5)

    # --- ciclo ---

    def ciclo(self) -> str:
        """Un giro completo. Ritorna 'ok', 'errore' o 'login' (sessione persa)."""
        self.stato("running", "Lettura elenco pratiche...")
        try:
            pratiche = self.leggi_elenco()
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            if not self.args.elenco and not self.adapter.is_logged_in(self.browser):
                return "login"
            self.stato("error", f"Lettura elenco non riuscita: {e}"[:300])
            return "errore"

        if not pratiche and not self.args.elenco and self.cache.elenco(self.pid):
            # Probabile lettura griglia fallita: non si svuota l'elenco noto.
            msg = ("Elenco letto dal portale vuoto: mantengo l'ultimo elenco "
                   "noto (verificare con dump_elenco.py).")
            _log("ATTENZIONE: " + msg)
            self.stato("error", msg)
            return "errore"

        self.cache.aggiorna_elenco(self.pid, pratiche)
        self.salva()
        self.pubblica()

        da_fare = self.cache.da_lavorare(self.pid, pratiche)
        if self.args.limit and self.args.limit > 0:
            da_fare = da_fare[:self.args.limit]
        _log(f"Pratiche FULL - Acquisto nell'elenco: {len(pratiche)}; "
             f"da lavorare in questo ciclo: {len(da_fare)}")

        for i, pratica in enumerate(da_fare, start=1):
            self.stato("running", f"Recupero telefoni {i}/{len(da_fare)}")
            _log(f"[{i}/{len(da_fare)}] Pratica {pratica.codice} ({pratica.intestatario})...")
            try:
                telefono, esito, nota = self.adapter.enrich(self.browser, pratica, log=_log)
            except Exception as e:  # noqa: BLE001 — il giro deve continuare
                traceback.print_exc()
                if not self.adapter.is_logged_in(self.browser):
                    _log("Sessione del portale persa: la pratica verrà ritentata dopo il login.")
                    return "login"
                telefono, esito, nota = "", f"ERRORE: {e}", ""
            else:
                if not telefono and esito.startswith("KO") and \
                        not self.adapter.is_logged_in(self.browser):
                    _log("Sessione del portale persa: la pratica verrà ritentata dopo il login.")
                    return "login"
            _log(f"    -> {esito}" + (f" tel={telefono}" if telefono else ""))
            self.cache.registra(self.pid, pratica, telefono, esito, nota)
            self.salva()
            self.pubblica()

        last = self.cache.set_last_sync(self.pid)
        self.salva()
        self.pubblica()
        n, con_tel = self.cache.conteggi(self.pid)
        self.stato("ok", f"{n} pratiche, {con_tel} con telefono", last_sync=last)
        _log(f"Ciclo completato: {n} pratiche, {con_tel} con telefono.")
        return "ok"

    def attendi(self, minuti: float) -> None:
        """Pausa fino al prossimo ciclo; esce prima se la sessione cade."""
        fine = time.monotonic() + minuti * 60
        prossimo = datetime.fromtimestamp(time.time() + minuti * 60).strftime("%H:%M")
        _log(f"Prossimo controllo alle {prossimo}.")
        ultimo_controllo = time.monotonic()
        while time.monotonic() < fine:
            time.sleep(min(5.0, max(0.1, fine - time.monotonic())))
            if self.browser and time.monotonic() - ultimo_controllo >= CONTROLLO_SESSIONE_SEC:
                ultimo_controllo = time.monotonic()
                if not self.adapter.is_logged_in(self.browser):
                    _log("Sessione del portale non più attiva.")
                    return

    # --- loop principali ---

    def loop_portale(self) -> int:
        if not self.avvia_browser():
            return 3
        try:
            while True:
                self.assicura_login()
                esito = self.ciclo()
                if esito == "login":
                    continue  # assicura_login gestisce lo stato login_required
                self.attendi(self.args.interval)
        finally:
            self.browser.stop()

    def loop_dry_run(self) -> int:
        """--serve --dry-run: serve le pratiche del file SENZA aprire il
        portale (telefoni vuoti). Utile per provare la web app."""
        while True:
            try:
                pratiche = load_pratiche(self.args.elenco)
            except Exception as e:  # noqa: BLE001
                self.stato("error", f"Lettura elenco non riuscita: {e}"[:300])
            else:
                self.cache.aggiorna_elenco(self.pid, pratiche)
                righe = self.cache.snapshot(self.pid)
                for r in righe:
                    r["esito"] = "DRY-RUN"
                self.state.set_pratiche(self.pid, righe)
                self.stato("ok", f"{len(righe)} pratiche (DRY-RUN: portale non contattato)",
                           last_sync=iso_utc())
                _log(f"DRY-RUN: pubblicate {len(righe)} pratiche dal file.")
            self.attendi(self.args.interval)


def esegui_servizio(args) -> int:
    """Punto d'ingresso di `run_giro.py --serve`."""
    try:
        adapter = get_adapter(args.portal, user_id=args.user_id)
    except PortaleNonConfigurato as e:
        print(str(e))
        return 5
    except KeyError as e:
        print(f"ERRORE: {e}")
        return 2

    if args.elenco:
        if not Path(args.elenco).exists():
            print(f"ERRORE: elenco non trovato: {args.elenco}")
            return 1
    elif args.dry_run:
        print("ERRORE: --serve --dry-run richiede il file elenco.")
        return 2
    elif not adapter.supporta_elenco:
        print(f"ERRORE: il portale {adapter.nome} non supporta la lettura "
              "automatica dell'elenco: passare il file elenco.")
        return 2
    else:
        _log("Nessun file elenco: l'elenco verrà letto dal portale (BEST-EFFORT, "
             "da verificare al primo giro con dump_elenco.py).")

    if args.interval <= 0:
        print("ERRORE: --interval deve essere > 0 (minuti).")
        return 2

    # In DRY-RUN la cache è solo in memoria: nessun file scritto.
    cache = BridgeCache(CACHE_PATH)
    if not args.dry_run:
        cache.load()
    state = BridgeState()
    state.set_portal(adapter.id, "starting", "Avvio del bridge...",
                     last_sync=cache.last_sync(adapter.id))
    state.set_pratiche(adapter.id, cache.snapshot(adapter.id))

    token, creato = carica_o_crea_token(TOKEN_PATH)
    try:
        server = make_server(state, token, port=args.port)
    except OSError as e:
        print(f"ERRORE: porta {args.port} non disponibile ({e}). Un altro bridge "
              "è già avviato? Usa --port per sceglierne un'altra.")
        return 6
    start_in_thread(server)
    _stampa_avvio(server.server_address[1], token, creato)

    servizio = _Servizio(args, adapter, cache, state)
    try:
        if args.dry_run:
            return servizio.loop_dry_run()
        return servizio.loop_portale()
    except KeyboardInterrupt:
        _log("Interrotto dall'operatore (Ctrl+C).")
        return 0
    finally:
        server.shutdown()
        server.server_close()
