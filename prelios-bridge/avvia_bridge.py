"""Avvio del bridge con un doppio clic (usato da "Avvia bridge.bat" su
Windows e da "avvia-bridge.command" su macOS).

Cosa fa, in ordine:
1. se un bridge risponde già su questo PC, lo dice ed esce (nessun doppione);
2. controlla i componenti Python necessari (selenium, openpyxl) e installa
   quelli che mancano;
3. se è configurato un gestionale (bridge_config.json) apre la sua pagina
   OptiRoute nel browser — tranne quando l'avvio arriva proprio dal
   gestionale (opzione --da-gestionale);
4. avvia il bridge in modalità servizio (controllo del portale ogni 15
   minuti), passando le eventuali opzioni ricevute (--limit, --dry-run,
   --portal, --port, --interval, ...).

Avvio dal pulsante del gestionale (collegamento optiroute-bridge://, solo
Windows): Windows avvia direttamente Python con --da-gestionale seguito
dall'indirizzo cliccato. Quell'indirizzo può sceglierlo qualsiasi pagina
web, quindi con --da-gestionale TUTTI gli altri argomenti vengono ignorati
e il bridge parte solo con le impostazioni predefinite.

Solo libreria standard.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

VERSIONE_MINIMA = (3, 10)
PORTA_DEFAULT = 8765
INTERVALLO_MIN = 15
NOME_BRIDGE = "optiroute-bridge"
# Secondi per leggere il messaggio "già acceso" prima che la finestra si chiuda
ATTESA_MESSAGGIO_SEC = 4

# (modulo importato dal codice, pacchetto da installare con pip)
#  - selenium: pilota il Chrome del portale (browser.py)
#  - openpyxl: legge/scrive gli Excel (excel_pratiche.py, run_giro.py)
PACCHETTI = (("selenium", "selenium"), ("openpyxl", "openpyxl"))


# ---------------------------------------------------------------------------
# Bridge già acceso?
# ---------------------------------------------------------------------------

def _apri_senza_proxy(url: str, timeout: float):
    # 127.0.0.1 non deve mai passare da un proxy di sistema
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(url, timeout=timeout)


def bridge_gia_attivo(porta: int, apri=_apri_senza_proxy, timeout: float = 1.5) -> bool:
    """True se su 127.0.0.1:<porta> risponde un OptiRoute Bridge."""
    try:
        with apri(f"http://127.0.0.1:{porta}/v1/health", timeout) as risposta:
            dati = json.loads(risposta.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — qualsiasi errore = non c'è un bridge
        return False
    return isinstance(dati, dict) and dati.get("bridge") == NOME_BRIDGE


# ---------------------------------------------------------------------------
# Componenti Python
# ---------------------------------------------------------------------------

def pacchetti_mancanti(trova=importlib.util.find_spec) -> list[str]:
    """Nomi pip dei pacchetti non installati."""
    mancanti = []
    for modulo, pacchetto in PACCHETTI:
        try:
            presente = trova(modulo) is not None
        except (ImportError, ValueError):
            presente = False
        if not presente:
            mancanti.append(pacchetto)
    return mancanti


def assicura_pacchetti(trova=importlib.util.find_spec, esegui=subprocess.call,
                       scrivi=print) -> bool:
    """Installa (pip) i pacchetti mancanti. False se non ci riesce."""
    mancanti = pacchetti_mancanti(trova)
    if not mancanti:
        return True
    scrivi(f"Installo i componenti che mancano: {', '.join(mancanti)} "
           "(serve Internet, può richiedere qualche minuto)...")
    comando = [sys.executable, "-m", "pip", "install", *mancanti]
    try:
        codice = esegui(comando)
    except OSError as e:
        scrivi(f"ERRORE: installazione non avviata ({e}).")
        codice = 1
    importlib.invalidate_caches()
    if codice == 0 and not pacchetti_mancanti(trova):
        scrivi("Componenti installati.")
        return True
    scrivi("ERRORE: non sono riuscito a installare i componenti necessari.")
    scrivi("Controlla la connessione a Internet e riprova. Se il problema resta,")
    if sys.platform == "win32":
        scrivi("apri il Prompt dei comandi e scrivi:  py -m pip install " + " ".join(mancanti))
    else:
        scrivi("apri il Terminale e scrivi:  python3 -m pip install " + " ".join(mancanti))
    return False


# ---------------------------------------------------------------------------
# Argomenti
# ---------------------------------------------------------------------------

def dividi_argomenti(argv: list[str]) -> tuple[bool, list[str]]:
    """(avvio dal gestionale?, argomenti da passare al bridge).

    Con --da-gestionale il programma è stato avviato dal collegamento
    optiroute-bridge:// e gli altri argomenti possono contenere l'indirizzo
    cliccato, che qualsiasi pagina web può scegliere: vengono IGNORATI tutti
    e il bridge parte solo con le impostazioni predefinite."""
    if "--da-gestionale" in argv:
        return True, []
    return False, list(argv)


def leggi_opzioni(extra: list[str]) -> argparse.Namespace:
    """Legge dagli argomenti solo ciò che serve al lanciatore (porta e
    gestionale); il resto passa al bridge così com'è."""
    p = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    p.add_argument("--port", default=None)
    p.add_argument("--gestionale", action="append", default=None)
    p.add_argument("--senza-gestionale", action="store_true")
    opzioni, _resto = p.parse_known_args(extra)
    try:
        opzioni.port = int(opzioni.port) if opzioni.port is not None else PORTA_DEFAULT
    except ValueError:
        opzioni.port = PORTA_DEFAULT
    return opzioni


def argomenti_servizio(extra: list[str]) -> list[str]:
    """Argomenti per run_giro.py. Un --interval ricevuto vince sul 15 di
    default (argparse tiene l'ultimo valore)."""
    return ["--serve", "--interval", str(INTERVALLO_MIN), *extra]


def _avvia_servizio(argomenti: list[str]) -> int:
    import run_giro
    return run_giro.main(argomenti)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None, *, apri=_apri_senza_proxy,
         trova=importlib.util.find_spec, esegui=subprocess.call,
         apri_browser=webbrowser.open, avvia_servizio=_avvia_servizio,
         config_path=None, pausa=time.sleep) -> int:
    if sys.version_info < VERSIONE_MINIMA:
        print("ERRORE: serve Python 3.10 o più recente (installato: "
              f"{sys.version.split()[0]}). Scaricalo da https://www.python.org/downloads/")
        return 1

    from bridge_config import CONFIG_PATH, ConfigNonValida, origini_effettive

    argv = list(sys.argv[1:] if argv is None else argv)
    da_gestionale, extra = dividi_argomenti(argv)
    opzioni = leggi_opzioni(extra)
    try:
        origini, pagina = origini_effettive(opzioni.gestionale, opzioni.senza_gestionale,
                                            config_path or CONFIG_PATH)
    except ConfigNonValida as e:
        print(f"ERRORE: {e}")
        return 1
    pagina_gestionale = origini[0] + pagina if origini else ""

    def apri_gestionale() -> None:
        if not pagina_gestionale or da_gestionale:
            return
        print(f"Apro il gestionale nel browser: {pagina_gestionale}")
        try:
            apri_browser(pagina_gestionale)
        except Exception:  # noqa: BLE001
            print("Non riesco ad aprire il browser: apri tu la pagina indicata sopra.")

    if bridge_gia_attivo(opzioni.port, apri=apri):
        if da_gestionale:
            return 0  # avviato dal pulsante: c'è già, si esce in silenzio
        print(f"Il bridge è già acceso su questo PC (porta {opzioni.port}): "
              "non serve avviarlo di nuovo.")
        apri_gestionale()
        pausa(ATTESA_MESSAGGIO_SEC)  # il tempo di leggere prima che la finestra si chiuda
        return 0

    if not assicura_pacchetti(trova=trova, esegui=esegui):
        return 1

    apri_gestionale()
    print("Avvio del bridge... (per fermarlo: Ctrl+C oppure chiudi questa finestra)")
    return avvia_servizio(argomenti_servizio(extra))


def avvio(argv: list[str] | None = None, *, esegui_main=main, leggi=input) -> int:
    """Punto d'ingresso reale. Avviato dal collegamento optiroute-bridge://
    non c'è un .bat che tenga aperta la finestra: in caso di errore si
    aspetta Invio, così l'operatore può leggere il messaggio."""
    argv = list(sys.argv[1:] if argv is None else argv)
    da_gestionale = "--da-gestionale" in argv
    try:
        os.chdir(BRIDGE_DIR)
    except OSError:
        pass
    try:
        codice = esegui_main(argv)
    except SystemExit as e:
        codice = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except KeyboardInterrupt:
        codice = 0
    except Exception as e:  # noqa: BLE001 — messaggio breve, niente traceback
        print(f"ERRORE: il bridge si è fermato per un problema imprevisto ({type(e).__name__}).")
        codice = 1
    if codice and da_gestionale:
        try:
            leggi("Premi Invio per chiudere questa finestra.")
        except (EOFError, KeyboardInterrupt):
            pass
    return codice


if __name__ == "__main__":
    raise SystemExit(avvio())
