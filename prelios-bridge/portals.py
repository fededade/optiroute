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

Il modulo NON importa Selenium: i moduli del portale sono importati solo
quando servono (così i test puri girano anche senza selenium).
"""

from __future__ import annotations

from excel_pratiche import Pratica, parse_grid_rows


class PortaleNonConfigurato(RuntimeError):
    """Il portale è registrato ma non ancora implementato/configurato."""


class PortalAdapter:
    """Interfaccia comune. Le sottoclassi ridefiniscono i metodi supportati."""

    id = ""
    nome = ""
    supporta_elenco = False

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


# ---------------------------------------------------------------------------
# PRELIOS — wrapper delle funzioni esistenti di prelios.py
# ---------------------------------------------------------------------------

class PreliosAdapter(PortalAdapter):
    id = "prelios"
    nome = "Prelios"
    supporta_elenco = True

    def __init__(self, user_id: str = "8468"):
        self.user_id = user_id

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
        righe = prelios.list_assigned(browser, log=log)
        stats: dict = {}
        pratiche = parse_grid_rows(righe, stats=stats)
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

    def enrich(self, browser, pratica: Pratica, log=print) -> tuple[str, str, str]:
        """Ricerca → apertura → estrazione telefono (identico al giro classico).

        Returns: (telefono, esito, nota_contatto).
        """
        import prelios

        if not prelios.search_perizia(browser, pratica.codice, log=log):
            return "", "KO perizia non trovata", ""
        if not prelios.open_perizia(browser, pratica.codice, self.user_id, log=log):
            return "", "KO apertura fallita", ""

        telefono, nota_contatto = prelios.extract_phone(browser, log=log)
        esito = "OK" if telefono else "OK (telefono non trovato)"
        return telefono, esito, nota_contatto


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
        return PreliosAdapter(user_id=kwargs.get("user_id", "8468"))
    return cls(**kwargs)
