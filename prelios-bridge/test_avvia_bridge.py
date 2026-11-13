#!/usr/bin/env python3
"""Test PURI del lanciatore con doppio clic (avvia_bridge.py).

Niente rete esterna, niente pip vero, niente browser vero: tutto ciò che il
lanciatore farebbe sul PC è sostituito da funzioni finte. Verifica: bridge
già acceso (anche con un vero server locale su porta libera), installazione
dei componenti mancanti (riuscita / fallita), apertura della pagina del
gestionale (sì / no con --da-gestionale / no senza gestionale) e passaggio
degli argomenti al bridge.

Esecuzione:
    python test_avvia_bridge.py
"""

from __future__ import annotations

import io
import json
import socket
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import avvia_bridge  # noqa: E402
from bridge_config import salva_config  # noqa: E402
from bridge_server import BridgeState, make_server, start_in_thread  # noqa: E402

ORIGINE = "https://gestionale.example"


class FintaRisposta(io.BytesIO):
    pass


def apri_che_risponde(nome: str, chiamate: list):
    def apri(url, timeout):
        chiamate.append(url)
        return FintaRisposta(json.dumps({"bridge": nome, "version": 1}).encode())
    return apri


def apri_spento(chiamate: list):
    def apri(url, timeout):
        chiamate.append(url)
        raise ConnectionRefusedError("nessuno in ascolto")
    return apri


def tutto_installato(_modulo):
    return object()


class Registro:
    def __init__(self):
        self.pip: list[list[str]] = []
        self.pagine: list[str] = []
        self.servizio: list[list[str]] = []
        self.pause: list[float] = []

    def esegui(self, comando):
        self.pip.append(comando)
        return 0

    def apri_browser(self, url):
        self.pagine.append(url)
        return True

    def avvia_servizio(self, argomenti):
        self.servizio.append(argomenti)
        return 0


def _config(con_gestionale: bool) -> Path:
    path = Path(tempfile.mkdtemp(prefix="test_avvia_")) / "bridge_config.json"
    if con_gestionale:
        salva_config({"gestionale": [ORIGINE], "pagina": "/optiroute.html"}, path)
    return path


def _main(argv, reg: Registro, apri, config: Path, trova=tutto_installato) -> tuple[int, str]:
    uscita = io.StringIO()
    with redirect_stdout(uscita):
        codice = avvia_bridge.main(argv, apri=apri, trova=trova, esegui=reg.esegui,
                                   apri_browser=reg.apri_browser,
                                   avvia_servizio=reg.avvia_servizio, config_path=config,
                                   pausa=reg.pause.append)
    return codice, uscita.getvalue()


def test_rileva_bridge() -> None:
    chiamate: list[str] = []
    assert avvia_bridge.bridge_gia_attivo(8765, apri=apri_che_risponde("optiroute-bridge", chiamate))
    assert chiamate == ["http://127.0.0.1:8765/v1/health"]
    assert not avvia_bridge.bridge_gia_attivo(8765, apri=apri_che_risponde("altro", []))
    assert not avvia_bridge.bridge_gia_attivo(8765, apri=apri_spento([]))

    # Server vero su porta libera di 127.0.0.1
    server = make_server(BridgeState(), "token-di-prova", port=0)
    start_in_thread(server)
    port = server.server_address[1]
    try:
        assert avvia_bridge.bridge_gia_attivo(port)
    finally:
        server.shutdown()
        server.server_close()
    # porta chiusa → no
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    libera = s.getsockname()[1]
    s.close()
    assert not avvia_bridge.bridge_gia_attivo(libera)
    print("OK test_rileva_bridge")


def test_gia_acceso() -> None:
    reg = Registro()
    chiamate: list[str] = []
    codice, testo = _main([], reg, apri_che_risponde("optiroute-bridge", chiamate), _config(True))
    assert codice == 0 and "già acceso" in testo, testo
    assert reg.servizio == [] and reg.pip == []
    assert reg.pagine == [ORIGINE + "/optiroute.html"]
    assert reg.pause == [4], reg.pause   # tempo per leggere il messaggio

    # porta personalizzata (doppio clic con opzioni) rispettata
    reg = Registro()
    chiamate = []
    codice, _ = _main(["--port", "9100"], reg,
                      apri_che_risponde("optiroute-bridge", chiamate), _config(True))
    assert codice == 0 and chiamate == ["http://127.0.0.1:9100/v1/health"], chiamate

    # avviato dal gestionale: esce in silenzio, senza pagina né attesa
    reg = Registro()
    chiamate = []
    codice, testo = _main(["--da-gestionale"], reg,
                          apri_che_risponde("optiroute-bridge", chiamate), _config(True))
    assert codice == 0 and testo == "" and reg.pagine == [] and reg.pause == []
    assert reg.servizio == [] and chiamate == ["http://127.0.0.1:8765/v1/health"]
    print("OK test_gia_acceso")


def test_argomenti_ostili_da_gestionale() -> None:
    """Con --da-gestionale gli altri argomenti (l'indirizzo cliccato, che una
    pagina web qualsiasi può scegliere) sono ignorati del tutto."""
    ostili = [
        ["--da-gestionale", "optiroute-bridge://avvia&calc"],
        ["--da-gestionale", "optiroute-bridge:x", "--senza-gestionale", "--port", "1",
         "elenco.xlsx", "--gestionale", "https://evil.example"],
        ["optiroute-bridge:x --port 1 --dry-run", "--port", "1", "--gestionale",
         "https://evil.example", "--da-gestionale"],
        ["--interval", "0.01", "--da-gestionale", "--portal", "cerved", "--limit", "1",
         "--out", "C:\\x.xlsx", "-c", "import os", "%USERPROFILE%", "a\"b c", "^&|()"],
    ]
    import run_giro
    for argv in ostili:
        config = _config(True)
        prima = config.read_bytes()
        reg = Registro()
        chiamate: list[str] = []
        codice, _ = _main(argv, reg, apri_spento(chiamate), config)
        assert codice == 0, argv
        assert reg.servizio == [["--serve", "--interval", "15"]], (argv, reg.servizio)
        assert chiamate == ["http://127.0.0.1:8765/v1/health"], (argv, chiamate)
        assert reg.pagine == []                       # niente browser aperto
        assert config.read_bytes() == prima           # configurazione intatta
        args = run_giro.crea_parser().parse_args(reg.servizio[0])
        assert args.elenco is None and args.port == 8765 and args.interval == 15
        assert args.gestionale is None and not args.senza_gestionale and not args.dry_run
        assert args.portal == "prelios" and args.limit == 0
    # e la modalità gestionale resta quella del file (non "evil", non manuale)
    from bridge_config import origini_effettive
    a = avvia_bridge.leggi_opzioni(avvia_bridge.dividi_argomenti(ostili[1])[1])
    assert origini_effettive(a.gestionale, a.senza_gestionale, _config(True))[0] == [ORIGINE]
    print("OK test_argomenti_ostili_da_gestionale")


def test_avvio_finestra() -> None:
    """avvio(): cartella del bridge, attesa di Invio SOLO dopo un errore
    quando l'avvio arriva dal gestionale (non c'è un .bat a tenere aperta
    la finestra), messaggio breve per gli errori imprevisti."""
    import os
    domande: list[str] = []
    altrove = tempfile.mkdtemp(prefix="test_avvia_cwd_")
    cwd = os.getcwd()
    try:
        os.chdir(altrove)
        assert avvia_bridge.avvio(["--da-gestionale"], esegui_main=lambda a: 0,
                                  leggi=domande.append) == 0
        assert Path(os.getcwd()).resolve() == avvia_bridge.BRIDGE_DIR
    finally:
        os.chdir(cwd)
    assert domande == []

    def guasto(_argv):
        raise RuntimeError("C:\\percorso\\segreto")

    uscita = io.StringIO()
    with redirect_stdout(uscita):
        assert avvia_bridge.avvio(["--da-gestionale", "x"], esegui_main=guasto,
                                  leggi=domande.append) == 1
    assert "segreto" not in uscita.getvalue() and "ERRORE" in uscita.getvalue()
    assert len(domande) == 1 and "Invio" in domande[0]

    domande.clear()
    assert avvia_bridge.avvio(["--da-gestionale"], esegui_main=lambda a: 3,
                              leggi=domande.append) == 3
    assert len(domande) == 1

    def esce(_argv):
        raise SystemExit(2)

    domande.clear()
    assert avvia_bridge.avvio(["--da-gestionale"], esegui_main=esce, leggi=domande.append) == 2
    assert len(domande) == 1

    # doppio clic (.bat): è il .bat a fare "pause", qui nessuna attesa
    domande.clear()
    assert avvia_bridge.avvio([], esegui_main=lambda a: 1, leggi=domande.append) == 1
    assert domande == []
    os.chdir(cwd)
    print("OK test_avvio_finestra")


def test_avvio_e_argomenti() -> None:
    reg = Registro()
    chiamate: list[str] = []
    extra = ["--limit", "3", "--dry-run", "elenco prova.xlsx", "--portal", "prelios",
             "--port", "9000", "--interval", "5"]
    codice, testo = _main(extra, reg, apri_spento(chiamate), _config(True))
    assert codice == 0, testo
    assert chiamate == ["http://127.0.0.1:9000/v1/health"]
    assert reg.pip == []
    assert reg.pagine == [ORIGINE + "/optiroute.html"]
    (argomenti,) = reg.servizio
    assert argomenti == ["--serve", "--interval", "15", *extra], argomenti

    # gli argomenti arrivano davvero a run_giro (l'ultimo --interval vince)
    import run_giro
    args = run_giro.crea_parser().parse_args(argomenti)
    assert args.serve and args.interval == 5 and args.limit == 3 and args.port == 9000
    assert args.dry_run and args.elenco == "elenco prova.xlsx"
    assert run_giro.crea_parser().parse_args(avvia_bridge.argomenti_servizio([])).interval == 15

    # dal gestionale: niente pagina, e --da-gestionale NON arriva al bridge
    reg = Registro()
    codice, _ = _main(["--da-gestionale"], reg, apri_spento([]), _config(True))
    assert codice == 0 and reg.pagine == []
    assert reg.servizio == [["--serve", "--interval", "15"]], reg.servizio

    # senza gestionale configurato: nessuna pagina
    reg = Registro()
    codice, _ = _main([], reg, apri_spento([]), _config(False))
    assert codice == 0 and reg.pagine == [] and len(reg.servizio) == 1

    # --senza-gestionale: nessuna pagina anche con il file
    reg = Registro()
    codice, _ = _main(["--senza-gestionale"], reg, apri_spento([]), _config(True))
    assert codice == 0 and reg.pagine == []
    assert reg.servizio == [["--serve", "--interval", "15", "--senza-gestionale"]]
    print("OK test_avvio_e_argomenti")


def test_installa_mancanti() -> None:
    installati = {"openpyxl"}

    def trova(modulo):
        return object() if modulo in installati else None

    reg = Registro()

    def pip_riuscito(comando):
        reg.pip.append(comando)
        installati.update(comando[4:])
        return 0

    reg.esegui = pip_riuscito
    codice, testo = _main([], reg, apri_spento([]), _config(False), trova=trova)
    assert codice == 0, testo
    assert reg.pip == [[sys.executable, "-m", "pip", "install", "selenium"]], reg.pip
    assert "selenium" in testo and len(reg.servizio) == 1

    # pip fallisce → messaggio chiaro, codice 1, bridge NON avviato
    reg = Registro()
    reg.esegui = lambda comando: (reg.pip.append(comando), 1)[1]
    codice, testo = _main([], reg, apri_spento([]), _config(True),
                          trova=lambda m: None)
    assert codice == 1 and reg.servizio == [] and reg.pagine == []
    assert reg.pip == [[sys.executable, "-m", "pip", "install", "selenium", "openpyxl"]]
    assert "ERRORE" in testo and "pip install selenium openpyxl" in testo, testo
    print("OK test_installa_mancanti")


def test_config_rovinata() -> None:
    path = Path(tempfile.mkdtemp(prefix="test_avvia_")) / "bridge_config.json"
    path.write_text("{rovinato", encoding="utf-8")
    reg = Registro()
    codice, testo = _main([], reg, apri_spento([]), path)
    assert codice == 1 and "bridge_config.json" in testo and reg.servizio == []
    print("OK test_config_rovinata")


def main() -> int:
    test_rileva_bridge()
    test_gia_acceso()
    test_argomenti_ostili_da_gestionale()
    test_avvio_finestra()
    test_avvio_e_argomenti()
    test_installa_mancanti()
    test_config_rovinata()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
