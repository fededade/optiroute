"""Contratto minimo degli adapter di portale (Prelios oggi, Cerved in futuro).

Ogni portale espone le stesse operazioni, così run_giro.py (giro singolo e
modalità servizio) non dipende dai dettagli del singolo portale:

- `id`                       identificativo breve ('prelios', 'cerved')
- `login(browser, ...)`      attende il login MANUALE (MFA): mai aggirato
- `is_logged_in(browser)`    True se la sessione del portale è ancora attiva
- `list_assigned(browser)`   pratiche assegnate lette dal portale (può non
                             essere supportato: `supporta_elenco = False`)
- `enrich(browser, pratica)` telefono/note di una pratica →
                             (telefono, esito, nota_contatto)
- `descrizione_elenco()`     descrizione ANONIMA dell'ultimo elenco letto dal
                             portale (per elenco_struttura.json), o None

Facoltativi (stato sul portale, contratto §6), con `legge_sospensione = True`:
- `enrich(..., sospensione={})`   legge anche la nota di sospensione e la
                                  mette nel dizionario passato
- `leggi_sospensione(browser, pratica)` riapre una perizia SOLO per la nota
                                  → (nota, campi trovati, esito)
- `richiedi_descrizione_perizia()` / `perizia_descritta` / `descrivi_perizia()`
                                  descrizione anonima della pagina di UNA
                                  perizia (sezione "perizia" del file)

Il modulo NON importa Selenium: i moduli del portale sono importati solo
quando servono (così i test puri girano anche senza selenium).
"""

from __future__ import annotations

import re

from excel_pratiche import Pratica, parse_grid_rows


class PortaleNonConfigurato(RuntimeError):
    """Il portale è registrato ma non ancora implementato/configurato."""


class PortalAdapter:
    """Interfaccia comune. Le sottoclassi ridefiniscono i metodi supportati."""

    id = ""
    nome = ""
    supporta_elenco = False
    # True se enrich accetta `sospensione` e c'è leggi_sospensione
    legge_sospensione = False
    # True se nel ciclo corrente è già stata descritta la pagina di una perizia
    perizia_descritta = False

    def login(self, browser, wait_seconds: int = 240, log=print,
              navigate: bool = True) -> bool:
        raise NotImplementedError

    def is_logged_in(self, browser) -> bool:
        raise NotImplementedError

    def list_assigned(self, browser, log=print) -> list[Pratica]:
        raise NotImplementedError(
            f"Il portale {self.nome or self.id} non supporta la lettura "
            "automatica dell'elenco: passare il file elenco."
        )

    def enrich(self, browser, pratica: Pratica, log=print) -> tuple[str, str, str]:
        raise NotImplementedError

    def descrizione_elenco(self) -> dict | None:
        """Descrizione anonima dell'ultimo elenco letto (struttura_elenco.py),
        None se non disponibile."""
        return getattr(self, "_descrizione", None)

    def valori_da_nascondere(self) -> set[str]:
        """Nomi, vie e comuni di TUTTE le righe dell'ultimo elenco letto
        (anche di altre tipologie), per il controllo finale della
        descrizione. Restano in memoria, non vengono mai scritti."""
        return set(getattr(self, "_vietati", set()))

    def richiedi_descrizione_perizia(self) -> None:
        """Inizio ciclo: la prima perizia aperta verrà descritta."""

    def descrivi_perizia(self, browser, pratica: Pratica, log=print) -> bool:
        """Apre una perizia SOLO per descriverne la pagina. False se non
        supportato o non riuscito."""
        return False

    def ha_descrizione_perizia(self) -> bool:
        """True se da quando il bridge è avviato una pagina di perizia è
        già stata descritta."""
        return False


# ---------------------------------------------------------------------------
# PRELIOS — wrapper delle funzioni esistenti di prelios.py
# ---------------------------------------------------------------------------

# Testi letti dal portale tenuti in memoria per il controllo della descrizione
_MAX_TESTI_LETTI = 5000


class PreliosAdapter(PortalAdapter):
    id = "prelios"
    nome = "Prelios"
    supporta_elenco = True
    legge_sospensione = True

    def __init__(self, user_id: str = "8468", max_righe: int = 200):
        self.user_id = user_id
        # «Max Righe» impostato prima della ricerca (0 = non toccarlo)
        self.max_righe = int(max_righe or 0)
        self._perizia_grezza: dict | None = None   # ultima pagina descritta (questo avvio)
        self._sospesi_grezza: dict | None = None   # ultima pagina «Sospesi» descritta
        self._descrivi_prossima = False
        self._descrivi_sospesi = False
        self.perizia_descritta = False
        self._testi_letti: set[str] = set()

    # --- descrizione della pagina della perizia ---

    def richiedi_descrizione_perizia(self) -> None:
        self._descrivi_prossima = True
        self._descrivi_sospesi = True
        self.perizia_descritta = False

    def _leggi_sospesi(self, browser, log=print) -> dict:
        """Pagina «Sospesi» della perizia aperta (prelios.leggi_pagina_sospesi):
        nota composta, data della riga, descrizione della pagina se richiesta.

        Returns: {"letta": bool, "nota": str, "dal": AAAA-MM-GG o '', "esito"}"""
        import prelios
        from stato_portale import nota_da_sospesi
        ris = prelios.leggi_pagina_sospesi(browser, log=log)
        if not ris.get("raggiunta"):
            return {"letta": False, "nota": "", "dal": "", "esito": ris.get("esito", "")}
        if self._descrivi_sospesi:
            try:
                self._sospesi_grezza = prelios.read_perizia_structure(browser)
                self._descrivi_sospesi = False
                self.perizia_descritta = True
            except Exception as e:  # noqa: BLE001 — solo descrizione
                log(f"ATTENZIONE: pagina «Sospesi» non descritta ({e}).")
        nota, dal = nota_da_sospesi(ris.get("righe") or [], ris.get("motivo") or "")
        self._ricorda(nota)
        return {"letta": True, "nota": nota, "dal": dal, "esito": "OK"}

    def _ricorda(self, *testi: str) -> None:
        """Telefoni e note letti: mai nella descrizione (controllo finale)."""
        for t in testi:
            t = re.sub(r"\s+", " ", t or "").strip().lower()
            if len(t) >= 3 and len(self._testi_letti) < _MAX_TESTI_LETTI:
                self._testi_letti.add(t)
                if t.startswith("+39"):
                    self._testi_letti.add(t[3:])

    def _descrivi_se_richiesto(self, browser, log=print, forza: bool = False) -> None:
        """Legge la struttura della pagina corrente della perizia (SOLO
        lettura, senza valori). Un errore non ferma niente."""
        if not (forza or self._descrivi_prossima):
            return
        import prelios
        try:
            self._perizia_grezza = prelios.read_perizia_structure(browser)
            self._descrivi_prossima = False
            self.perizia_descritta = True
        except Exception as e:  # noqa: BLE001 — solo descrizione, mai bloccante
            log(f"ATTENZIONE: pagina della perizia non descritta ({e}).")

    def descrivi_perizia(self, browser, pratica: Pratica, log=print) -> bool:
        import prelios
        if not prelios.search_perizia(browser, pratica.codice, log=log):
            return False
        if not prelios.open_perizia(browser, pratica.codice, self.user_id, log=log):
            return False
        prelios.apri_anagrafica(browser, log=log)
        self._descrivi_se_richiesto(browser, log=log, forza=True)
        if pratica.fase == "sospesa":
            self._descrivi_sospesi = True
            self._leggi_sospesi(browser, log=log)
        return self.perizia_descritta

    def ha_descrizione_perizia(self) -> bool:
        return self._perizia_grezza is not None

    def descrizione_elenco(self) -> dict | None:
        """Descrizione dell'ultimo elenco con, se nota, la sezione "perizia"
        (l'ultima pagina di perizia descritta da quando il bridge è avviato)."""
        d = getattr(self, "_descrizione", None)
        if d is None:
            return None
        d = dict(d)
        if self._perizia_grezza is not None or self._sospesi_grezza is not None:
            from struttura_elenco import descrivi_perizia
            vietati = self.valori_da_nascondere()
            d["perizia"] = descrivi_perizia(self._perizia_grezza, vietati)
            if self._sospesi_grezza is not None:
                d["perizia"]["pagina_sospesi"] = descrivi_perizia(self._sospesi_grezza, vietati)
        return d

    def valori_da_nascondere(self) -> set[str]:
        return set(getattr(self, "_vietati", set())) | self._testi_letti

    def login(self, browser, wait_seconds: int = 240, log=print,
              navigate: bool = True) -> bool:
        import prelios
        return prelios.login(browser, wait_seconds=wait_seconds, log=log,
                             navigate=navigate)

    def is_logged_in(self, browser) -> bool:
        import prelios
        return prelios.is_logged_in(browser)

    def list_assigned(self, browser, log=print) -> list[Pratica]:
        """Elenco dalla griglia del portale (BEST-EFFORT, non verificato sul
        portale reale) passato al parser ad ancora-Tipologia dei file."""
        import prelios
        self._descrizione = None
        self._vietati = set()
        info: dict = {}
        righe = prelios.list_assigned(browser, log=log, info=info, max_righe=self.max_righe,
                                      cerca_sospese_ora=True)
        stats: dict = {}
        pagina = info.get("pagina") if isinstance(info.get("pagina"), dict) else {}
        th = [t.get("celle") or [] for t in (pagina.get("th") or []) if isinstance(t, dict)]

        # Sospese ADESSO: dalla seconda ricerca, se è stata possibile
        ricerca = info.get("sospese") if isinstance(info.get("sospese"), dict) else {}
        righe_sospese = list(ricerca.get("righe") or []) if ricerca.get("esito") == "ok" else []
        codici_sospesi: set[str] | None = None
        if ricerca.get("esito") == "ok":
            codici_sospesi = {p.codice for p in parse_grid_rows(
                righe_sospese, solo_tipologia=None, intestazioni=th)}
        pratiche = parse_grid_rows(righe, stats=stats, intestazioni=th, sospese=codici_sospesi)
        aggiunte = 0
        if codici_sospesi is not None:
            noti = {p.codice for p in pratiche}
            for p in parse_grid_rows(righe_sospese, intestazioni=th, sospese=codici_sospesi):
                if p.codice not in noti:   # sospese vecchie, fuori dalle più recenti
                    pratiche.append(p)
                    noti.add(p.codice)
                    aggiunte += 1
        stato_info = {
            "strada": "ricerca_sospese" if codici_sospesi is not None else "colonna_sospensione",
            "sospese_trovate": len(codici_sospesi) if codici_sospesi is not None else None,
            "sospese_aggiunte": aggiunte,
        }
        if codici_sospesi is None:
            stato_info["motivo_ricerca"] = str(ricerca.get("esito") or "ricerca non fatta")[:200]
            log("ATTENZIONE: ricerca delle perizie sospese non possibile "
                f"({stato_info['motivo_ricerca']}): per «sospesa» uso la colonna "
                "«Sospensione» (può includere perizie già riattivate).")
        else:
            log(f"Sospese adesso (ricerca «Stato Perizia» = sospesa): {len(codici_sospesi)}, "
                f"di cui {aggiunte} FULL - Acquisto non fra le più recenti (aggiunte).")
        stats["stato_info"] = stato_info
        try:
            from struttura_elenco import descrivi_elenco, valori_vietati
            self._vietati = valori_vietati(righe) | valori_vietati(righe_sospese)
            self._descrizione = descrivi_elenco(righe, stats, info,
                                                fasi=[p.fase for p in pratiche])
        except Exception as e:  # noqa: BLE001 — la descrizione non deve mai fermare il giro
            log(f"ATTENZIONE: descrizione dell'elenco non preparata ({e}).")
        if stats.get("colonne_stato"):
            log("ATTENZIONE: stato delle perizie NON letto dall'elenco "
                f"({stats['colonne_stato']}): tutte trattate come prima, senza stato.")
        elif stats.get("senza_stato"):
            log(f"ATTENZIONE: {stats['senza_stato']} righe non allineate alle "
                "intestazioni: per quelle lo stato non è stato letto.")
        log(f"Elenco Prelios: {stats.get('righe', 0)} righe lette, "
            f"{stats.get('con_tipologia', 0)} con tipologia, "
            f"{stats.get('altre_tipologie', 0)} di altre tipologie, "
            f"{stats.get('senza_codice', 0)} senza codice, "
            f"{stats.get('duplicate', 0)} duplicate → "
            f"{len(pratiche)} pratiche FULL - Acquisto.")
        if stats.get("senza_codice"):
            log("ATTENZIONE: righe FULL - Acquisto senza codice riconoscibile "
                "(atteso nelle prime 4 colonne): verificare con dump_elenco.py.")
        return pratiche

    def enrich(self, browser, pratica: Pratica, log=print,
               sospensione: dict | None = None) -> tuple[str, str, str]:
        """Ricerca → apertura → estrazione telefono (identico al giro classico).

        Se `sospensione` è un dizionario, sulla stessa pagina legge anche la
        nota di sospensione (BEST-EFFORT) e ci scrive "nota" e "campi"
        (quanti campi con «sosp» trovati). Se richiesto, descrive la pagina.

        Returns: (telefono, esito, nota_contatto).
        """
        import prelios

        if not prelios.search_perizia(browser, pratica.codice, log=log):
            return "", "KO perizia non trovata", ""
        if not prelios.open_perizia(browser, pratica.codice, self.user_id, log=log):
            return "", "KO apertura fallita", ""

        telefono, nota_contatto = prelios.extract_phone(browser, log=log)
        esito = "OK" if telefono else "OK (telefono non trovato)"
        self._ricorda(telefono, nota_contatto)
        self._descrivi_se_richiesto(browser, log=log)
        if sospensione is not None:
            sospensione.update(self._leggi_sospesi(browser, log=log))
        return telefono, esito, nota_contatto

    def leggi_sospensione(self, browser, pratica: Pratica, log=print) -> tuple[str, str, str]:
        """Riapre una perizia SOLO per la nota di sospensione (pagina
        «Sospesi», BEST-EFFORT).

        Returns: (nota, data della riga AAAA-MM-GG o '', esito 'OK' / 'KO ...')."""
        import prelios

        if not prelios.search_perizia(browser, pratica.codice, log=log):
            return "", "", "KO perizia non trovata"
        if not prelios.open_perizia(browser, pratica.codice, self.user_id, log=log):
            return "", "", "KO apertura fallita"
        prelios.apri_anagrafica(browser, log=log)
        self._descrivi_se_richiesto(browser, log=log)
        ris = self._leggi_sospesi(browser, log=log)
        if not ris["letta"]:
            return "", "", f"NON LETTA: {ris['esito']}"
        return ris["nota"], ris["dal"], "OK"


# ---------------------------------------------------------------------------
# CERVED — NON implementato: nessun URL/selettore/campo inventato
# ---------------------------------------------------------------------------

MESSAGGIO_CERVED = """\
Portale Cerved: NON ancora configurato in questo bridge.

Per costruire l'adapter servono informazioni che oggi non abbiamo:
  1. URL di accesso e tipo di login (SSO? MFA? con quale schermata finale
     si capisce che il login è completato?);
  2. struttura dell'elenco delle pratiche ASSEGNATE: in che pagina sta,
     colonne (codice, tipologia, intestatario, indirizzo...), filtri e
     paginazione;
  3. scheda della singola pratica: come si apre dall'elenco e in quali
     campi stanno telefono e referente del cliente (ed eventuali note).

Come raccoglierle in sicurezza (dati personali anonimizzati di default):
    python capture_portal.py --url <indirizzo del portale Cerved>
fai il login e naviga a mano; premi INVIO sulle pagine di elenco e di
dettaglio pratica: le catture finiscono in captures/ e si possono condividere.
"""


class CervedAdapter(PortalAdapter):
    id = "cerved"
    nome = "Cerved"
    supporta_elenco = False

    def __init__(self, **_kwargs):
        raise PortaleNonConfigurato(MESSAGGIO_CERVED)


# ---------------------------------------------------------------------------
# REGISTRO
# ---------------------------------------------------------------------------

REGISTRO: dict[str, type[PortalAdapter]] = {
    PreliosAdapter.id: PreliosAdapter,
    CervedAdapter.id: CervedAdapter,
}


def get_adapter(portal_id: str, **kwargs) -> PortalAdapter:
    """Istanzia l'adapter del portale.

    Raises:
        PortaleNonConfigurato: portale registrato ma non implementato (Cerved).
        KeyError: portale sconosciuto.
    """
    pid = (portal_id or "").strip().lower()
    if pid not in REGISTRO:
        raise KeyError(f"Portale sconosciuto: {portal_id!r} "
                       f"(disponibili: {', '.join(sorted(REGISTRO))})")
    cls = REGISTRO[pid]
    if cls is PreliosAdapter:
        return PreliosAdapter(user_id=kwargs.get("user_id", "8468"),
                              max_righe=kwargs.get("max_righe", 200))
    return cls(**kwargs)
