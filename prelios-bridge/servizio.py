"""Modalità servizio del bridge: `python run_giro.py --serve [elenco]`.

Dopo il login MANUALE (MFA) resta in esecuzione e a ogni ciclo:
1. rilegge l'elenco pratiche (dal file, se passato; altrimenti dal portale
   con adapter.list_assigned — best-effort);
2. recupera il telefono SOLO delle pratiche nuove (quelle già risolte con
   telefono non vengono riaperte, quelle senza telefono si ritentano al
   massimo una volta al giorno) — vedi bridge_cache.py;
   NON apre quelle che sul portale hanno il sopralluogo già fissato, già
   fatto o sono chiuse (stato_portale.py); per le sospese legge anche la
   nota di sospensione (BEST-EFFORT), poi rilegge le note scadute (max 10);
3. pubblica i dati sul server HTTP locale (127.0.0.1, contratto v1 in
   bridge_server.py) da cui la web app OptiRoute li legge da sola.

Se la sessione del portale scade lo stato diventa `login_required` e il
bridge aspetta il nuovo login senza terminare. Ctrl+C per fermarlo.

MODALITÀ GESTIONALE (bridge_config.json o --gestionale): il server HTTP
parte subito ma il bridge resta "in attesa di attivazione"; Chrome e il
portale vengono avviati SOLO dopo che un amministratore del gestionale lo ha
attivato (POST /v1/attiva). Da lì in poi tutto procede come sopra.

Selenium gira SOLO in questo thread (principale); il server HTTP è in un
thread daemon e legge uno snapshot protetto da lock.
"""

from __future__ import annotations

import time
import traceback
from datetime import datetime
from pathlib import Path

from bridge_cache import BridgeCache, iso_utc
from bridge_config import CONFIG_PATH, ConfigNonValida, origini_effettive
from bridge_server import (Attivazione, BridgeState, carica_o_crea_token, make_server,
                           start_in_thread)
from excel_pratiche import load_pratiche
from portals import PortaleNonConfigurato, get_adapter
from stato_portale import DA_FISSARE, FASI_DA_NON_APRIRE, SOSPESA, riga_conteggi

MSG_NOTA_NON_TROVATA = ("nota di sospensione non letta (voce «Sospesi» non trovata o "
                        "griglia non comparsa nella pagina della perizia): vedi "
                        "elenco_struttura.json")

BRIDGE_DIR = Path(__file__).resolve().parent
CACHE_PATH = BRIDGE_DIR / "bridge_cache.json"
TOKEN_PATH = BRIDGE_DIR / "bridge_token.txt"
# Descrizione anonima dell'elenco del portale (riscritta a ogni lettura)
STRUTTURA_PATH = BRIDGE_DIR / "elenco_struttura.json"

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


def _stampa_avvio_gestionale(port: int, origini: list[str], minuti: float) -> None:
    riga = "=" * 68
    print(riga)
    print(f" OptiRoute Bridge acceso su http://127.0.0.1:{port}  (solo questo PC)")
    print(" IN ATTESA DI ATTIVAZIONE dal gestionale.")
    print(" Un amministratore (Super Amministratore o Amministratore) deve")
    print(" aprire la pagina OptiRoute del gestionale: il bridge si attiva da solo.")
    print(" Solo dopo l'attivazione si apre la finestra Chrome del portale.")
    print(" Gestionale autorizzato: " + ", ".join(origini))
    print(f" Controllo del portale ogni {minuti:g} minuti.")
    print(" Lascia aperta questa finestra. Ctrl+C per fermare il bridge.")
    print(riga, flush=True)


def _attendi_attivazione(attivazione: Attivazione, passo: float = 0.5) -> None:
    """Aspetta l'attivazione dal gestionale. Attese brevi e ripetute, così
    Ctrl+C interrompe subito anche su Windows."""
    while not attivazione.attendi(passo):
        pass
    utente = attivazione.utente
    if utente is not None:
        _log(f"Bridge attivato dal gestionale da {utente.nome or 'utente senza nome'} "
             f"({utente.ruolo}).")
    else:
        _log("Bridge attivato dal gestionale.")


def _crea_browser_predefinito():
    from browser import PreliosBrowser
    return PreliosBrowser()


class _Servizio:
    """Stato del servizio per un singolo portale."""

    def __init__(self, args, adapter, cache: BridgeCache, state: BridgeState,
                 crea_browser=None):
        self.args = args
        self.adapter = adapter
        self.pid = adapter.id
        self.cache = cache
        self.state = state
        self.browser = None
        self._crea_browser = crea_browser or _crea_browser_predefinito
        self.percorso_struttura = STRUTTURA_PATH
        # Perizia aperta SOLO per descriverne la pagina: una volta per avvio
        self._descrizione_perizia_tentata = False
        self._avvisata_nota = False

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
            stats: dict = {}
            pratiche = load_pratiche(self.args.elenco, stats=stats)
            if stats.get("colonne_stato"):
                _log(f"Stato delle perizie non letto dal file ({stats['colonne_stato']}): "
                     "tutte trattate come prima, senza stato.")
            return pratiche
        return self.adapter.list_assigned(self.browser, log=_log)

    def salva_struttura(self, pratiche, dopo_perizia: bool = False) -> None:
        """Scrive elenco_struttura.json (com'è fatto l'elenco del portale,
        senza dati dei clienti) e stampa una riga di riepilogo. Qualunque
        errore viene solo segnalato: il ciclo prosegue.

        dopo_perizia: riscrittura a fine ciclo, dopo aver descritto la
        pagina di una perizia (messaggi diversi)."""
        n = len(pratiche)
        try:
            struttura = self.adapter.descrizione_elenco()
            if not struttura:
                if not dopo_perizia:
                    _log(f"Elenco letto: {n} pratiche FULL - Acquisto (descrizione "
                         "dell'elenco non disponibile).")
                return
            from struttura_elenco import scrivi_struttura, valori_pratiche
            telefoni = [r.get("telefono", "") for r in self.cache.snapshot(self.pid)]
            vietati = (valori_pratiche(pratiche, telefoni, self.cache.testi_letti(self.pid))
                       | self.adapter.valori_da_nascondere())
            righe = struttura.get("conteggi", {}).get("righe_lette", "?")
            problemi = scrivi_struttura(self.percorso_struttura, struttura, vietati)
            if dopo_perizia:
                if problemi:
                    _log("ATTENZIONE: descrizione della pagina della perizia NON salvata, "
                         f"il controllo finale ha trovato possibili dati dei clienti "
                         f"({problemi[0]}).")
                else:
                    _log("Descrizione della pagina di una perizia aggiunta a "
                         f"{Path(self.percorso_struttura).name} (senza dati dei clienti).")
                return
            if problemi:
                _log(f"Elenco letto: {n} pratiche FULL - Acquisto su {righe} righe. "
                     f"ATTENZIONE: descrizione dell'elenco NON salvata, il controllo "
                     f"finale ha trovato possibili dati dei clienti ({problemi[0]}).")
                return
            _log(f"Elenco letto: {n} pratiche FULL - Acquisto su {righe} righe "
                 f"(descrizione dell'elenco salvata in {Path(self.percorso_struttura).name}, "
                 "senza dati dei clienti)")
        except Exception as e:  # noqa: BLE001 — mai bloccante
            _log(f"Elenco letto: {n} pratiche FULL - Acquisto. ATTENZIONE: "
                 f"descrizione dell'elenco non salvata ({e}).")

    # --- browser e login ---

    def avvia_browser(self) -> bool:
        try:
            self.browser = self._crea_browser()
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

        if not self.args.elenco:
            self.salva_struttura(pratiche)
        fasi = [p.fase for p in pratiche if p.fase]
        if fasi:
            _log(riga_conteggi(fasi))

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

        legge_sosp = bool(getattr(self.adapter, "legge_sospensione", False))
        descrive = legge_sosp and not self.args.elenco
        if descrive:
            self.adapter.richiedi_descrizione_perizia()
        self._avvisata_nota = False

        # Prima i telefoni mancanti, poi le note di sospensione da rileggere
        da_fare = self.cache.da_lavorare(self.pid, pratiche)
        non_aperte = sum(1 for p in pratiche if p.fase in FASI_DA_NON_APRIRE)
        note = (self.cache.sospensioni_da_rileggere(self.pid, pratiche,
                                                    escludi={p.codice for p in da_fare})
                if legge_sosp else [])
        if self.args.limit and self.args.limit > 0:
            da_fare = da_fare[:self.args.limit]
            note = note[:max(0, self.args.limit - len(da_fare))]
        _log(f"Pratiche FULL - Acquisto nell'elenco: {len(pratiche)}; "
             f"da lavorare in questo ciclo: {len(da_fare)}"
             + (f"; non aperte perché sul portale il sopralluogo è fissato, già "
                f"fatto o la perizia è chiusa: {non_aperte}" if non_aperte else "")
             + (f"; note di sospensione da rileggere: {len(note)}" if note else ""))

        for i, pratica in enumerate(da_fare, start=1):
            self.stato("running", f"Recupero telefoni {i}/{len(da_fare)}")
            _log(f"[{i}/{len(da_fare)}] Pratica {pratica.codice} ({pratica.intestatario})...")
            sosp = {} if (legge_sosp and pratica.fase == SOSPESA) else None
            extra = {"sospensione": sosp} if sosp is not None else {}
            try:
                telefono, esito, nota = self.adapter.enrich(self.browser, pratica, log=_log,
                                                            **extra)
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
            if sosp is not None:
                self._registra_nota(pratica, sosp.get("nota", ""), bool(sosp.get("letta")),
                                    sosp.get("dal", ""), aperta=bool(sosp))
            self.salva()
            self.pubblica()

        for i, pratica in enumerate(note, start=1):
            self.stato("running", f"Note di sospensione {i}/{len(note)}")
            _log(f"[nota {i}/{len(note)}] Pratica {pratica.codice} ({pratica.intestatario}): "
                 "nota di sospensione...")
            try:
                testo, dal, esito = self.adapter.leggi_sospensione(self.browser, pratica,
                                                                   log=_log)
            except Exception as e:  # noqa: BLE001 — il giro deve continuare
                traceback.print_exc()
                if not self.adapter.is_logged_in(self.browser):
                    _log("Sessione del portale persa: la nota verrà riletta dopo il login.")
                    return "login"
                testo, dal, esito = "", "", f"ERRORE: {e}"
            else:
                if esito != "OK" and not self.adapter.is_logged_in(self.browser):
                    _log("Sessione del portale persa: la nota verrà riletta dopo il login.")
                    return "login"
            if esito != "OK" and not esito.startswith("NON LETTA"):
                _log(f"    -> {esito}")
            self._registra_nota(pratica, testo, esito == "OK", dal,
                                aperta=esito == "OK" or esito.startswith("NON LETTA"))
            self.salva()
            self.pubblica()

        if descrive and self._descrivi_perizia(pratiche) == "login":
            return "login"

        last = self.cache.set_last_sync(self.pid)
        self.salva()
        self.pubblica()
        n, con_tel = self.cache.conteggi(self.pid)
        self.stato("ok", f"{n} pratiche, {con_tel} con telefono", last_sync=last)
        _log(f"Ciclo completato: {n} pratiche, {con_tel} con telefono.")
        return "ok"

    def _registra_nota(self, pratica, nota: str, letta: bool, dal: str = "",
                       aperta: bool = True) -> None:
        """Salva la nota di sospensione. Se la perizia è stata aperta ma la
        pagina «Sospesi» non è stata raggiunta: UNA riga nel log per ciclo."""
        self.cache.registra_sospensione(self.pid, pratica, nota, letta, dal)
        if letta:
            _log("    -> nota di sospensione letta" if nota else
                 "    -> pagina «Sospesi» senza nota")
        elif aperta and not self._avvisata_nota:
            self._avvisata_nota = True
            _log("ATTENZIONE: " + MSG_NOTA_NON_TROVATA)

    def _descrivi_perizia(self, pratiche) -> str:
        """Fine ciclo: se è stata descritta la pagina di una perizia, la
        aggiunge a elenco_struttura.json. Se in questo ciclo non se n'è aperta
        nessuna e da quando il bridge è avviato non se n'è mai descritta una,
        ne apre UNA (sospesa o da fissare) solo per descriverla: una volta
        per avvio. Ritorna 'login' se la sessione cade, altrimenti ''."""
        a = self.adapter
        if not a.perizia_descritta and not self._descrizione_perizia_tentata \
                and not a.ha_descrizione_perizia():
            candidati = ([p for p in pratiche if p.fase == SOSPESA]
                         + [p for p in pratiche if p.fase in (DA_FISSARE, "")])
            if candidati:
                self._descrizione_perizia_tentata = True
                p = candidati[0]
                _log(f"Apro la pratica {p.codice} solo per descrivere la pagina della "
                     "perizia (una volta per avvio, nessun dato dei clienti).")
                try:
                    a.descrivi_perizia(self.browser, p, log=_log)
                except Exception as e:  # noqa: BLE001 — solo descrizione
                    if not a.is_logged_in(self.browser):
                        return "login"
                    _log(f"ATTENZIONE: pagina della perizia non descritta ({e}).")
        if a.perizia_descritta:
            self.salva_struttura(pratiche, dopo_perizia=True)
        return ""

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

    def esegui(self, attivazione: Attivazione | None = None) -> int:
        """In modalità gestionale aspetta l'attivazione PRIMA di aprire il
        browser o il portale; poi procede come sempre."""
        if attivazione is not None and attivazione.gestionale:
            _attendi_attivazione(attivazione)
            self.stato("starting", "Bridge attivato dal gestionale: avvio in corso...")
        if self.args.dry_run:
            return self.loop_dry_run()
        return self.loop_portale()


def esegui_servizio(args, *, verifica=None, config_path=CONFIG_PATH,
                    crea_browser=None) -> int:
    """Punto d'ingresso di `run_giro.py --serve`.

    `verifica`, `config_path` e `crea_browser` sono sostituibili nei test."""
    try:
        origini, _pagina = origini_effettive(getattr(args, "gestionale", None),
                                             getattr(args, "senza_gestionale", False),
                                             config_path)
    except ConfigNonValida as e:
        print(f"ERRORE: {e}")
        return 2

    try:
        adapter = get_adapter(args.portal, user_id=args.user_id,
                              max_righe=getattr(args, "max_righe", 200))
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
    state = BridgeState(intervallo_minuti=args.interval)
    messaggio_avvio = ("In attesa di attivazione dal gestionale." if origini
                       else "Avvio del bridge...")
    state.set_portal(adapter.id, "starting", messaggio_avvio,
                     last_sync=cache.last_sync(adapter.id))
    state.set_pratiche(adapter.id, cache.snapshot(adapter.id))

    attivazione = None
    if origini:
        if verifica is None:
            from verifica_gestionale import verifica_admin as verifica
        attivazione = Attivazione(origini, verifica=verifica, log=_log)

    token, creato = carica_o_crea_token(TOKEN_PATH)
    try:
        server = make_server(state, token, port=args.port, attivazione=attivazione)
    except OSError as e:
        print(f"ERRORE: porta {args.port} non disponibile ({e}). Un altro bridge "
              "è già avviato? Usa --port per sceglierne un'altra.")
        return 6
    start_in_thread(server)
    if attivazione is not None:
        _stampa_avvio_gestionale(server.server_address[1], list(origini), args.interval)
    else:
        _stampa_avvio(server.server_address[1], token, creato)

    servizio = _Servizio(args, adapter, cache, state, crea_browser=crea_browser)
    try:
        return servizio.esegui(attivazione)
    except KeyboardInterrupt:
        _log("Interrotto dall'operatore (Ctrl+C).")
        return 0
    finally:
        server.shutdown()
        server.server_close()
