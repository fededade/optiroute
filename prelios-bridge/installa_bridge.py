"""Installazione del bridge sul PC dell'operatore (da fare UNA volta).

Si avvia con un doppio clic su "Installa.bat" (Windows) oppure con
`python3 installa_bridge.py` (macOS/Linux). Fa questo:

a) controlla i componenti Python (selenium, openpyxl) e installa quelli che
   mancano;
b) chiede l'indirizzo del gestionale e lo salva in bridge_config.json
   (mostra quelli già salvati);
c) solo Windows: registra per l'utente corrente il collegamento
   "optiroute-bridge://", così il pulsante nel gestionale può accendere il
   bridge. Windows avvia direttamente Python (niente cmd.exe né .bat);
   l'indirizzo cliccato arriva in fondo alla riga di comando ma il
   programma lo ignora del tutto, insieme a qualsiasi altra cosa vi sia
   scritta;
d) solo Windows: mette sul Desktop l'icona "OptiRoute Bridge.bat";
e) spiega cosa ha fatto e cosa fare dopo.

Opzioni:
    --gestionale URL     indirizzo del gestionale (ripetibile), senza domande
    --non-interattivo    non fa domande
    --disinstalla        toglie il collegamento e l'icona sul Desktop
                         (lascia configurazione, token e dati salvati)

Solo libreria standard.
"""

from __future__ import annotations

import argparse
import codecs
import os
import re
import shutil
import sys
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

from avvia_bridge import assicura_pacchetti  # noqa: E402
from bridge_config import (CONFIG_PATH, ConfigNonValida, aggiungi_gestionale,  # noqa: E402
                           carica_config, salva_config)

PROTOCOLLO = "optiroute-bridge"
CHIAVE_PROTOCOLLO = r"Software\Classes" + "\\" + PROTOCOLLO
CHIAVE_CARTELLE = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
NOME_ICONA = "OptiRoute Bridge.bat"
MARCATORE = "rem OptiRoute Bridge - creato da installa_bridge.py"
LANCIATORE = BRIDGE_DIR / "Avvia bridge.bat"      # per l'icona sul Desktop
SCRIPT_AVVIO = BRIDGE_DIR / "avvia_bridge.py"     # per il pulsante del gestionale
DOMANDA = ("Indirizzo del gestionale (incollalo e premi Invio; "
           "lascia vuoto per saltare): ")


# ---------------------------------------------------------------------------
# Utilità Windows (testabili anche altrove: winreg e ambiente sono iniettati)
# ---------------------------------------------------------------------------

def _variabile(env, nome: str) -> str:
    """Variabile d'ambiente senza distinzione maiuscole/minuscole (come Windows)."""
    if nome in env:
        return env[nome]
    basso = nome.lower()
    for k, v in env.items():
        if k.lower() == basso:
            return v
    return ""


def espandi_variabili(testo: str, env) -> str:
    """Espande %VARIABILE% come fa Windows (le sconosciute restano come sono)."""
    return re.sub(r"%([^%]+)%", lambda m: _variabile(env, m.group(1)) or m.group(0), testo)


def trova_interprete(which=shutil.which, eseguibile: str | None = None) -> tuple[str, list[str]]:
    """Python da registrare per optiroute-bridge://: il launcher py.exe (con
    -3) se c'è, altrimenti questo stesso Python (mai pythonw: serve la
    finestra con i messaggi)."""
    py = which("py")
    if py:
        return os.path.abspath(py), ["-3"]
    eseguibile = eseguibile or sys.executable
    p = Path(eseguibile)
    if p.name.lower() == "pythonw.exe":
        eseguibile = str(p.with_name("python.exe"))
    return eseguibile, []


def comando_protocollo(interprete: str, opzioni: list[str], script) -> str:
    """Comando registrato per optiroute-bridge://.

    Windows avvia DIRETTAMENTE Python (niente cmd.exe, niente .bat: nessun
    carattere dell'indirizzo può diventare un comando). L'indirizzo cliccato
    ("%1") viene messo per ultimo, dopo il percorso dello script, quindi non
    può mai essere letto come opzione di Python; avvia_bridge.py, visto
    --da-gestionale, lo ignora del tutto."""
    parti = [f'"{interprete}"', *opzioni, f'"{script}"', "--da-gestionale", '"%1"']
    return " ".join(parti)


def registra_protocollo(winreg, comando: str) -> None:
    hkcu = winreg.HKEY_CURRENT_USER
    with winreg.CreateKeyEx(hkcu, CHIAVE_PROTOCOLLO, 0, winreg.KEY_WRITE) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:OptiRoute Bridge")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKeyEx(hkcu, CHIAVE_PROTOCOLLO + r"\shell\open\command", 0,
                            winreg.KEY_WRITE) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, comando)


def rimuovi_protocollo(winreg) -> bool:
    """Toglie la registrazione (dalla chiave più interna). True se c'era."""
    tolto = False
    for sotto in (r"\shell\open\command", r"\shell\open", r"\shell", ""):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, CHIAVE_PROTOCOLLO + sotto)
            tolto = True
        except OSError:  # FileNotFoundError compreso: già assente
            pass
    return tolto


def cartella_desktop(winreg, env) -> Path:
    """Cartella Desktop reale dell'utente (può essere spostata su OneDrive).
    Legge 'User Shell Folders' → Desktop; altrimenti %USERPROFILE%\\Desktop."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, CHIAVE_CARTELLE) as k:
            valore, _tipo = winreg.QueryValueEx(k, "Desktop")
        percorso = espandi_variabili(str(valore or ""), env).strip()
        if percorso and "%" not in percorso and Path(percorso).is_dir():
            return Path(percorso)
    except OSError:
        pass
    return Path(_variabile(env, "USERPROFILE") or Path.home()) / "Desktop"


def codepage_oem() -> str:
    """Codifica con cui cmd.exe legge i file .bat (code page OEM)."""
    try:
        import ctypes
        cp = f"cp{ctypes.windll.kernel32.GetOEMCP()}"  # type: ignore[attr-defined]
        codecs.lookup(cp)
        return cp
    except Exception:  # noqa: BLE001
        return "cp850"


def contenuto_icona(lanciatore) -> str:
    percorso = str(lanciatore).replace("%", "%%")
    return f'@echo off\r\n{MARCATORE}\r\ncall "{percorso}" %*\r\n'


def codifica_bat(testo: str, codepage: str) -> bytes:
    """I .bat sono letti nella code page OEM: se il percorso contiene
    caratteri che lì non esistono si passa a UTF-8 (chcp 65001)."""
    try:
        return testo.encode(codepage)
    except UnicodeEncodeError:
        return ("@chcp 65001 >nul\r\n" + testo).encode("utf-8")


def scrivi_icona(desktop: Path, lanciatore, codepage: str) -> Path:
    destinazione = desktop / NOME_ICONA
    destinazione.write_bytes(codifica_bat(contenuto_icona(lanciatore), codepage))
    return destinazione


def rimuovi_icona(desktop: Path) -> bool:
    """Toglie l'icona solo se l'ha creata questo programma."""
    destinazione = desktop / NOME_ICONA
    try:
        contenuto = destinazione.read_bytes().decode("latin-1")
    except OSError:
        return False
    if MARCATORE not in contenuto:
        return False
    destinazione.unlink()
    return True


# ---------------------------------------------------------------------------
# Gestionale
# ---------------------------------------------------------------------------

def chiedi_gestionale(config: dict, leggi=input, scrivi=print) -> list[str]:
    """Chiede un indirizzo finché è valido o vuoto. Ritorna gli aggiunti."""
    while True:
        try:
            risposta = leggi(DOMANDA).strip()
        except EOFError:
            risposta = ""
        if not risposta:
            scrivi("Nessun indirizzo inserito: passaggio saltato.")
            return []
        try:
            origine, nuova = aggiungi_gestionale(config, risposta)
        except ConfigNonValida as e:
            scrivi(f"Indirizzo non accettato: {e}")
            scrivi("Riprova (oppure premi solo Invio per saltare).")
            continue
        if nuova:
            scrivi(f"Aggiunto: {origine}")
            return [origine]
        scrivi(f"Già presente: {origine}")
        return []


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _riga(scrivi) -> None:
    scrivi("=" * 68)


def disinstalla(windows: bool, winreg, env, scrivi=print) -> int:
    _riga(scrivi)
    if not windows:
        scrivi("Su questo sistema non c'è niente da togliere: il collegamento con il")
        scrivi("gestionale e l'icona sul Desktop esistono solo su Windows.")
        _riga(scrivi)
        return 0
    tolto = rimuovi_protocollo(winreg)
    scrivi("Collegamento optiroute-bridge:// " + ("tolto." if tolto else "non presente."))
    desktop = cartella_desktop(winreg, env)
    if rimuovi_icona(desktop):
        scrivi(f"Icona tolta dal Desktop ({desktop / NOME_ICONA}).")
    else:
        scrivi("Icona sul Desktop non presente.")
    scrivi("Configurazione, token e dati salvati sono rimasti nella cartella del bridge.")
    scrivi("Il pulsante nel gestionale non potrà più accendere il bridge.")
    _riga(scrivi)
    return 0


def main(argv: list[str] | None = None, *, winreg=None, sistema: str | None = None,
         env=None, config_path=CONFIG_PATH, leggi=input, scrivi=print,
         assicura=None, codepage: str | None = None, lanciatore=LANCIATORE,
         script=SCRIPT_AVVIO, interprete: tuple[str, list[str]] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Installa il bridge OptiRoute su questo PC (una volta sola).")
    parser.add_argument("--gestionale", action="append", metavar="URL", default=[],
                        help="indirizzo del gestionale (ripetibile)")
    parser.add_argument("--non-interattivo", action="store_true",
                        help="non fa domande")
    parser.add_argument("--disinstalla", action="store_true",
                        help="toglie collegamento e icona (lascia configurazione e dati)")
    args = parser.parse_args(argv)

    sistema = sistema or sys.platform
    windows = sistema == "win32"
    env = os.environ if env is None else env
    if windows and winreg is None:
        import winreg as _winreg
        winreg = _winreg

    if args.disinstalla:
        return disinstalla(windows, winreg, env, scrivi)

    _riga(scrivi)
    scrivi(" Installazione di OptiRoute Bridge")
    _riga(scrivi)

    # a) componenti
    scrivi("1) Controllo dei componenti Python...")
    assicura = assicura or (lambda: assicura_pacchetti(scrivi=scrivi))
    if not assicura():
        scrivi("Installazione interrotta: risolvi il problema indicato e rilancia.")
        return 1
    scrivi("   Componenti a posto.")

    # b) gestionale
    scrivi("2) Indirizzo del gestionale")
    try:
        config = carica_config(config_path)
    except ConfigNonValida as e:
        scrivi(f"ERRORE: {e}")
        return 1
    if config["gestionale"]:
        scrivi("   Già salvati: " + ", ".join(config["gestionale"]))
    else:
        scrivi("   Nessun indirizzo salvato finora.")
    aggiunti: list[str] = []
    for voce in args.gestionale:
        try:
            origine, nuova = aggiungi_gestionale(config, voce)
        except ConfigNonValida as e:
            scrivi(f"ERRORE: {e}")
            return 2
        if nuova:
            aggiunti.append(origine)
    if not args.gestionale and not args.non_interattivo:
        aggiunti += chiedi_gestionale(config, leggi=leggi, scrivi=scrivi)
    if aggiunti:
        salva_config(config, config_path)
        scrivi(f"   Salvato in {Path(config_path).name}: " + ", ".join(aggiunti))

    # c) + d) solo Windows
    icona = None
    protocollo_ok = False
    if windows:
        scrivi("3) Collegamento con il pulsante del gestionale")
        try:
            eseguibile, opzioni = interprete or trova_interprete()
            registra_protocollo(winreg, comando_protocollo(eseguibile, opzioni, script))
            protocollo_ok = True
            scrivi("   Fatto (solo per questo utente di Windows). Il pulsante avvia")
            scrivi("   direttamente Python; l'indirizzo cliccato non viene usato dal programma.")
        except OSError as e:
            scrivi(f"   ATTENZIONE: non riuscito ({e}).")
        scrivi("4) Icona sul Desktop")
        desktop = cartella_desktop(winreg, env)
        try:
            if not desktop.is_dir():
                raise OSError(f"cartella Desktop non trovata: {desktop}")
            icona = scrivi_icona(desktop, lanciatore, codepage or codepage_oem())
            scrivi(f"   Creata: {icona}")
        except OSError as e:
            scrivi(f"   ATTENZIONE: icona non creata ({e}).")

    # e) riepilogo
    _riga(scrivi)
    scrivi(" Fatto. Cosa fare adesso:")
    if config["gestionale"]:
        scrivi(" - Il bridge si attiva SOLO quando un amministratore del gestionale")
        scrivi("   (Super Amministratore o Amministratore) apre la pagina OptiRoute.")
    else:
        scrivi(" - Nessun gestionale configurato: il bridge funzionerà in modalità")
        scrivi("   manuale (token da incollare in OptiRoute). Rilancia l'installazione")
        scrivi("   per aggiungere l'indirizzo del gestionale.")
    if windows:
        if icona:
            scrivi(" - Ogni giorno: doppio clic su \"OptiRoute Bridge\" sul Desktop,")
        else:
            scrivi(" - Ogni giorno: doppio clic su \"Avvia bridge.bat\" nella cartella del bridge,")
        if protocollo_ok:
            scrivi("   oppure il pulsante \"Avvia bridge\" nel gestionale.")
        scrivi(" - Si apre una finestra nera: lasciala aperta. Quando il bridge è attivo")
        scrivi("   si apre il Chrome del portale: fai il login (MFA) come sempre.")
        scrivi(" - Per fermarlo: chiudi la finestra nera (oppure Ctrl+C).")
        scrivi(" - Per togliere collegamento e icona: nella cartella del bridge apri il")
        scrivi("   Prompt dei comandi e scrivi  py installa_bridge.py --disinstalla")
    else:
        scrivi(" - Ogni giorno: doppio clic su \"avvia-bridge.command\" (macOS) oppure")
        scrivi("   python3 avvia_bridge.py dal Terminale.")
        scrivi(" - Il pulsante \"Avvia bridge\" nel gestionale funziona solo su Windows:")
        scrivi("   qui il bridge va acceso a mano; poi si attiva dal gestionale.")
    _riga(scrivi)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
