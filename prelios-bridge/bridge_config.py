"""Configurazione locale del bridge: `bridge_config.json` (accanto agli script).

Contiene gli indirizzi del gestionale autorizzati ad attivare il bridge e la
pagina del gestionale da aprire con il doppio clic:

    {"gestionale": ["https://gestionale.example"], "pagina": "/optiroute.html"}

Il file resta sul PC dell'operatore e NON va nel repository (.gitignore).
Se non esiste, o la lista è vuota, il bridge funziona come prima
("modalità manuale": token da incollare a mano nella web app).

Solo libreria standard.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

BRIDGE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BRIDGE_DIR / "bridge_config.json"
PAGINA_DEFAULT = "/optiroute.html"

# http è ammesso solo per le prove sul proprio PC
HOST_LOCALI = ("localhost", "127.0.0.1")
_RE_HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")


class ConfigNonValida(ValueError):
    """Indirizzo o file di configurazione non accettabile (messaggio in italiano)."""


def normalizza_origine(testo: str) -> str:
    """Da un indirizzo qualsiasi del gestionale ricava l'"origine"
    (`https://host[:porta]`, host in minuscolo), cioè ciò che il browser
    dichiara nell'header Origin.

    Accetta l'indirizzo con o senza `https://` e con qualsiasi percorso
    (es. `gestionale.example/optiroute.html`). Ammette solo https, tranne
    `http://localhost` e `http://127.0.0.1` per le prove locali.

    Raises:
        ConfigNonValida: indirizzo vuoto, non valido o non sicuro.
    """
    grezzo = (testo or "").strip()
    if not grezzo:
        raise ConfigNonValida("Indirizzo del gestionale vuoto.")
    if any(c.isspace() for c in grezzo):
        raise ConfigNonValida(f"Indirizzo non valido (contiene spazi): {grezzo!r}")
    if "://" not in grezzo:
        grezzo = "https://" + grezzo.lstrip("/")
    try:
        parti = urlsplit(grezzo)
        porta = parti.port
    except ValueError:
        raise ConfigNonValida(f"Indirizzo non valido: {testo.strip()!r}") from None
    schema = parti.scheme.lower()
    if "@" in parti.netloc:
        raise ConfigNonValida("L'indirizzo non deve contenere nome utente o password.")
    host = (parti.hostname or "").rstrip(".")
    if not host:
        raise ConfigNonValida(f"Indirizzo non valido (manca il nome del sito): {testo.strip()!r}")
    if not host.isascii():
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            raise ConfigNonValida(f"Nome del sito non valido: {host!r}") from None
    host = host.lower()
    if not _RE_HOST.match(host):
        raise ConfigNonValida(f"Nome del sito non valido: {host!r}")

    if schema == "https":
        predefinita = 443
    elif schema == "http" and host in HOST_LOCALI:
        predefinita = 80
    elif schema == "http":
        raise ConfigNonValida(
            f"L'indirizzo deve iniziare con https:// (http è ammesso solo per "
            f"localhost e 127.0.0.1): {testo.strip()!r}")
    else:
        raise ConfigNonValida(f"Indirizzo non valido (deve essere https://...): {testo.strip()!r}")

    origine = f"{schema}://{host}"
    if porta is not None and porta != predefinita:
        origine += f":{porta}"
    return origine


def _normalizza_pagina(pagina) -> str:
    if not isinstance(pagina, str) or not pagina.strip():
        return PAGINA_DEFAULT
    pagina = pagina.strip()
    if "://" in pagina or any(c.isspace() for c in pagina):
        raise ConfigNonValida(f"Pagina del gestionale non valida: {pagina!r}")
    return pagina if pagina.startswith("/") else "/" + pagina


def config_vuota() -> dict:
    return {"gestionale": [], "pagina": PAGINA_DEFAULT}


def carica_config(path: str | Path = CONFIG_PATH) -> dict:
    """Legge `bridge_config.json`. File assente → configurazione vuota
    (modalità manuale). Gli indirizzi vengono normalizzati e deduplicati.

    Raises:
        ConfigNonValida: file illeggibile o con un indirizzo non valido.
    """
    path = Path(path)
    if not path.exists():
        return config_vuota()
    try:
        dati = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:
        raise ConfigNonValida(f"Il file {path.name} non è leggibile ({e}). "
                              "Correggilo o cancellalo e rilancia l'installazione.") from None
    if not isinstance(dati, dict):
        raise ConfigNonValida(f"Il file {path.name} non ha il formato atteso.")
    elenco = dati.get("gestionale", [])
    if isinstance(elenco, str):
        elenco = [elenco]
    if not isinstance(elenco, list):
        raise ConfigNonValida(f"Nel file {path.name} la voce \"gestionale\" deve essere un elenco.")
    origini: list[str] = []
    for voce in elenco:
        try:
            o = normalizza_origine(str(voce))
        except ConfigNonValida as e:
            raise ConfigNonValida(f"{path.name}: {e}") from None
        if o not in origini:
            origini.append(o)
    return {"gestionale": origini, "pagina": _normalizza_pagina(dati.get("pagina"))}


def salva_config(config: dict, path: str | Path = CONFIG_PATH) -> None:
    """Scrive la configurazione (scrittura atomica, UTF-8, leggibile a mano)."""
    path = Path(path)
    dati = {"gestionale": list(config.get("gestionale", [])),
            "pagina": _normalizza_pagina(config.get("pagina"))}
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".bridge_config_", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(dati, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def aggiungi_gestionale(config: dict, indirizzo: str) -> tuple[str, bool]:
    """Aggiunge l'origine di `indirizzo` alla configurazione (in memoria).
    Ritorna (origine, aggiunta_ora). Solleva ConfigNonValida."""
    origine = normalizza_origine(indirizzo)
    elenco = config.setdefault("gestionale", [])
    if origine in elenco:
        return origine, False
    elenco.append(origine)
    return origine, True


def origini_effettive(da_riga_di_comando: list[str] | None = None,
                      senza_gestionale: bool = False,
                      path: str | Path = CONFIG_PATH) -> tuple[list[str], str]:
    """Origini autorizzate per QUESTA esecuzione e pagina del gestionale.

    - `--senza-gestionale` → nessuna (modalità manuale);
    - `--gestionale URL` (anche più volte) → sostituisce l'elenco del file;
    - altrimenti → l'elenco di `bridge_config.json` (se c'è).
    """
    if senza_gestionale:
        pagina = PAGINA_DEFAULT
        try:
            pagina = carica_config(path)["pagina"]
        except ConfigNonValida:
            pass
        return [], pagina
    if da_riga_di_comando:
        origini: list[str] = []
        for voce in da_riga_di_comando:
            o = normalizza_origine(voce)
            if o not in origini:
                origini.append(o)
        try:
            pagina = carica_config(path)["pagina"]
        except ConfigNonValida:
            pagina = PAGINA_DEFAULT
        return origini, pagina
    config = carica_config(path)
    return config["gestionale"], config["pagina"]
