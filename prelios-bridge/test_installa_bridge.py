#!/usr/bin/env python3
"""Test PURI dell'installazione (installa_bridge.py).

Registro di Windows FINTO (in memoria), cartelle Desktop e configurazione
temporanee, pip finto. Verifica: comando del collegamento optiroute-bridge
(Python avviato direttamente, niente cmd.exe né .bat, "%1" per ultimo dopo
lo script; percorsi con spazi e accenti), chiavi e valori scritti, Desktop
letto da "User Shell Folders" (anche spostato, es. OneDrive) o di riserva
%USERPROFILE%\\Desktop, icona sul Desktop, domanda dell'indirizzo del
gestionale, --non-interattivo, --disinstalla, comportamento su macOS/Linux.

Esecuzione:
    python test_installa_bridge.py
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import installa_bridge as ib  # noqa: E402

ORIGINE = "https://gestionale.example"
LANCIATORE = r"C:\Utenti\Mario Prova\Documenti\Città bridge\prelios-bridge\Avvia bridge.bat"
SCRIPT = r"C:\Utenti\Mario Prova\Documenti\Città bridge\prelios-bridge\avvia_bridge.py"
PY = r"C:\WINDOWS\py.exe"
CMD = r"C:\WINDOWS\system32\cmd.exe"


class FintoWinreg:
    """Il minimo di winreg usato da installa_bridge, in memoria."""

    HKEY_CURRENT_USER = "HKCU"
    KEY_WRITE = 0x20006
    REG_SZ = 1
    REG_EXPAND_SZ = 2

    class _Chiave:
        def __init__(self, percorso):
            self.percorso = percorso

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def __init__(self):
        self.chiavi: dict[str, dict[str, tuple]] = {}

    @staticmethod
    def _norm(root, percorso):
        assert root == "HKCU"
        return percorso.lower()

    def CreateKeyEx(self, root, percorso, riservato=0, accesso=0):  # noqa: N802
        p = self._norm(root, percorso)
        parti = p.split("\\")
        for i in range(1, len(parti) + 1):   # crea anche le intermedie, come Windows
            self.chiavi.setdefault("\\".join(parti[:i]), {})
        return self._Chiave(p)

    def OpenKey(self, root, percorso, riservato=0, accesso=0):  # noqa: N802
        p = self._norm(root, percorso)
        if p not in self.chiavi:
            raise FileNotFoundError(percorso)
        return self._Chiave(p)

    def SetValueEx(self, chiave, nome, riservato, tipo, valore):  # noqa: N802
        self.chiavi[chiave.percorso][nome.lower()] = (valore, tipo)

    def QueryValueEx(self, chiave, nome):  # noqa: N802
        try:
            return self.chiavi[chiave.percorso][nome.lower()]
        except KeyError:
            raise FileNotFoundError(nome) from None

    def DeleteKey(self, root, percorso):  # noqa: N802
        p = self._norm(root, percorso)
        if p not in self.chiavi:
            raise FileNotFoundError(percorso)
        if any(k.startswith(p + "\\") for k in self.chiavi):
            raise PermissionError("la chiave ha sottochiavi")
        del self.chiavi[p]

    def valore(self, percorso, nome=""):
        return self.chiavi[percorso.lower()][nome.lower()]


def _ambiente(tmp: Path, desktop_reg: str | None, winreg: FintoWinreg) -> dict:
    env = {"COMSPEC": CMD, "SystemRoot": r"C:\WINDOWS", "USERPROFILE": str(tmp / "profilo"),
           "OneDrive": str(tmp / "OneDrive")}
    if desktop_reg is not None:
        with winreg.CreateKeyEx("HKCU", ib.CHIAVE_CARTELLE) as k:
            winreg.SetValueEx(k, "Desktop", 0, winreg.REG_EXPAND_SZ, desktop_reg)
    return env


def _main(argv, **kw) -> tuple[int, str]:
    uscita = io.StringIO()
    kw.setdefault("assicura", lambda: True)
    kw.setdefault("interprete", (PY, ["-3"]))
    kw.setdefault("script", SCRIPT)
    with redirect_stdout(uscita):
        codice = ib.main(argv, **kw)
    return codice, uscita.getvalue()


def test_comando_protocollo() -> None:
    comando = ib.comando_protocollo(PY, ["-3"], SCRIPT)
    assert comando == (r'"C:\WINDOWS\py.exe" -3 "C:\Utenti\Mario Prova\Documenti'
                       r'\Città bridge\prelios-bridge\avvia_bridge.py" --da-gestionale "%1"'), comando
    # niente shell: né cmd.exe né file .bat
    assert "cmd" not in comando.lower() and ".bat" not in comando.lower()
    # l'indirizzo cliccato ("%1") è l'ultimo argomento, dopo lo script
    assert comando.endswith(' --da-gestionale "%1"')
    assert comando.index('"%1"') > comando.index("avvia_bridge.py")
    assert comando.count("%") == 1
    # senza py.exe: questo stesso Python, senza -3
    assert ib.comando_protocollo(r"C:\Python312\python.exe", [], SCRIPT) == \
        f'"C:\\Python312\\python.exe" "{SCRIPT}" --da-gestionale "%1"'
    print("OK test_comando_protocollo")


def test_trova_interprete() -> None:
    assert ib.trova_interprete(which=lambda _n: "/opt/py", eseguibile="/x/python") == \
        ("/opt/py", ["-3"])
    assert ib.trova_interprete(which=lambda _n: None, eseguibile="/x/python3") == ("/x/python3", [])
    # mai pythonw (niente finestra = niente messaggi)
    exe, opz = ib.trova_interprete(which=lambda _n: None, eseguibile="/x/pythonw.exe")
    assert exe == "/x/python.exe" and opz == []
    print("OK test_trova_interprete")


def test_espandi_e_desktop() -> None:
    env = {"USERPROFILE": r"C:\Users\prova", "OneDrive": r"C:\Users\prova\OneDrive"}
    assert ib.espandi_variabili(r"%OneDrive%\Desktop", env) == r"C:\Users\prova\OneDrive\Desktop"
    assert ib.espandi_variabili(r"%userprofile%\x", env) == r"C:\Users\prova\x"
    assert ib.espandi_variabili(r"%SCONOSCIUTA%\x", env) == r"%SCONOSCIUTA%\x"

    tmp = Path(tempfile.mkdtemp(prefix="test_installa_"))
    # Desktop spostato su OneDrive (con accenti e spazi)
    reale = tmp / "OneDrive" / "Scrivania di prova è"
    reale.mkdir(parents=True)
    wr = FintoWinreg()
    env = _ambiente(tmp, "%OneDrive%" + "/" + "Scrivania di prova è", wr)
    assert ib.cartella_desktop(wr, env) == reale
    # valore assente → %USERPROFILE%\Desktop
    wr2 = FintoWinreg()
    assert ib.cartella_desktop(wr2, env) == tmp / "profilo" / "Desktop"
    # valore che punta a una cartella inesistente → riserva
    wr3 = FintoWinreg()
    env3 = _ambiente(tmp, "%OneDrive%/non-esiste", wr3)
    assert ib.cartella_desktop(wr3, env3) == tmp / "profilo" / "Desktop"
    print("OK test_espandi_e_desktop")


def test_icona() -> None:
    testo = ib.contenuto_icona(LANCIATORE)
    assert testo == ('@echo off\r\n' + ib.MARCATORE + '\r\n'
                     f'call "{LANCIATORE}" %*\r\n'), testo
    # cp850 contiene "à": nessun cambio di code page
    dati = ib.codifica_bat(testo, "cp850")
    assert dati.decode("cp850") == testo and b"chcp" not in dati
    # carattere che cp850 non ha → UTF-8 con chcp 65001
    strano = ib.contenuto_icona(r"C:\Dati\Łódź\Avvia bridge.bat")
    dati = ib.codifica_bat(strano, "cp850")
    assert dati.startswith(b"@chcp 65001 >nul\r\n") and "Łódź" in dati.decode("utf-8")
    # il simbolo % nel percorso viene protetto
    assert 'call "C:\\100%%\\Avvia bridge.bat" %*' in ib.contenuto_icona(r"C:\100%\Avvia bridge.bat")
    print("OK test_icona")


def test_installa_windows() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="test_installa_win_"))
    desktop = tmp / "OneDrive" / "Desktop"
    desktop.mkdir(parents=True)
    config = tmp / "bridge" / "bridge_config.json"
    wr = FintoWinreg()
    env = _ambiente(tmp, r"%OneDrive%" + "/Desktop", wr)
    risposte = iter(["http://non-sicuro.example", "gestionale.example/optiroute.html"])

    codice, testo = _main([], winreg=wr, sistema="win32", env=env, config_path=config,
                          leggi=lambda _domanda: next(risposte), codepage="cp850",
                          lanciatore=LANCIATORE)
    assert codice == 0, testo
    # (b) configurazione salvata (il primo indirizzo, non sicuro, è stato rifiutato)
    assert json.loads(config.read_text(encoding="utf-8")) == \
        {"gestionale": [ORIGINE], "pagina": "/optiroute.html"}
    assert "Indirizzo non accettato" in testo
    # (c) collegamento optiroute-bridge
    base = ib.CHIAVE_PROTOCOLLO
    assert wr.valore(base) == ("URL:OptiRoute Bridge", wr.REG_SZ)
    assert wr.valore(base, "URL Protocol") == ("", wr.REG_SZ)
    assert wr.valore(base + r"\shell\open\command") == \
        (f'"{PY}" -3 "{SCRIPT}" --da-gestionale "%1"', wr.REG_SZ)
    assert base.lower() == r"software\classes\optiroute-bridge"
    # (d) icona sul Desktop reale
    icona = desktop / ib.NOME_ICONA
    assert icona.read_bytes().decode("cp850") == ib.contenuto_icona(LANCIATORE)
    # (e) spiegazioni
    assert "Super Amministratore" in testo and "OptiRoute Bridge" in testo

    # Seconda esecuzione: mostra gli indirizzi salvati, nessuna domanda
    codice, testo = _main(["--non-interattivo"], winreg=wr, sistema="win32", env=env,
                          config_path=config, codepage="cp850", lanciatore=LANCIATORE,
                          leggi=lambda _d: (_ for _ in ()).throw(AssertionError("domanda")))
    assert codice == 0 and "Già salvati: " + ORIGINE in testo, testo

    # --gestionale aggiunge un secondo indirizzo senza domande
    codice, testo = _main(["--gestionale", "https://altro.example:8443/x"], winreg=wr,
                          sistema="win32", env=env, config_path=config, codepage="cp850",
                          lanciatore=LANCIATORE)
    assert codice == 0
    assert json.loads(config.read_text(encoding="utf-8"))["gestionale"] == \
        [ORIGINE, "https://altro.example:8443"]

    # --gestionale non valido → errore, nulla di scritto
    codice, testo = _main(["--gestionale", "http://altro.example"], winreg=wr,
                          sistema="win32", env=env, config_path=config, lanciatore=LANCIATORE)
    assert codice == 2 and "ERRORE" in testo

    # --disinstalla: via collegamento e icona; configurazione e token restano
    token = config.parent / "bridge_token.txt"
    token.write_text("segreto-di-prova\n", encoding="utf-8")
    codice, testo = _main(["--disinstalla"], winreg=wr, sistema="win32", env=env,
                          config_path=config, lanciatore=LANCIATORE,
                          assicura=lambda: (_ for _ in ()).throw(AssertionError("pip")))
    assert codice == 0, testo
    assert not any(k.startswith(base.lower()) for k in wr.chiavi), wr.chiavi
    assert ib.CHIAVE_CARTELLE.lower() in wr.chiavi   # le altre chiavi restano
    assert not icona.exists()
    assert config.exists() and token.exists()
    # una seconda disinstallazione non dà errori
    codice, testo = _main(["--disinstalla"], winreg=wr, sistema="win32", env=env,
                          config_path=config)
    assert codice == 0 and "non presente" in testo
    print("OK test_installa_windows")


def test_non_tocca_icone_altrui() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="test_installa_altrui_"))
    (tmp / ib.NOME_ICONA).write_text("@echo off\r\necho mio\r\n", encoding="ascii")
    assert not ib.rimuovi_icona(tmp)
    assert (tmp / ib.NOME_ICONA).exists()
    print("OK test_non_tocca_icone_altrui")


def test_pacchetti_falliti() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="test_installa_pip_"))
    wr = FintoWinreg()
    codice, testo = _main(["--non-interattivo"], winreg=wr, sistema="win32",
                          env=_ambiente(tmp, None, wr), config_path=tmp / "c.json",
                          assicura=lambda: False)
    assert codice == 1 and wr.chiavi == {} and not (tmp / "c.json").exists(), testo
    print("OK test_pacchetti_falliti")


def test_macos_linux() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="test_installa_mac_"))
    config = tmp / "bridge_config.json"
    codice, testo = _main([], sistema="darwin", env={}, config_path=config,
                          leggi=lambda _d: "https://gestionale.example/optiroute.html")
    assert codice == 0, testo
    assert json.loads(config.read_text(encoding="utf-8"))["gestionale"] == [ORIGINE]
    assert "solo su Windows" in testo
    # risposta vuota → si salta, nulla di scritto
    config2 = tmp / "altro.json"
    codice, testo = _main([], sistema="linux", env={}, config_path=config2,
                          leggi=lambda _d: "")
    assert codice == 0 and not config2.exists() and "saltato" in testo
    codice, testo = _main(["--disinstalla"], sistema="darwin", env={}, config_path=config)
    assert codice == 0 and config.exists()
    print("OK test_macos_linux")


def main() -> int:
    test_comando_protocollo()
    test_trova_interprete()
    test_espandi_e_desktop()
    test_icona()
    test_installa_windows()
    test_non_tocca_icone_altrui()
    test_pacchetti_falliti()
    test_macos_linux()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
