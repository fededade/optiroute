#!/usr/bin/env python3
"""Test PURI della configurazione del gestionale (bridge_config.py).

Normalizzazione degli indirizzi (origine), lettura/scrittura di
bridge_config.json in una cartella temporanea, precedenza delle opzioni
--gestionale / --senza-gestionale. Niente rete.

Esecuzione:
    python test_bridge_config.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_config import (  # noqa: E402
    PAGINA_DEFAULT,
    ConfigNonValida,
    aggiungi_gestionale,
    carica_config,
    normalizza_origine,
    origini_effettive,
    salva_config,
)


def _errore(testo: str) -> None:
    try:
        normalizza_origine(testo)
    except ConfigNonValida as e:
        assert str(e), testo
        return
    raise AssertionError(f"accettato per errore: {testo!r}")


def test_normalizza_origine() -> None:
    casi = {
        "https://gestionale.example": "https://gestionale.example",
        "https://gestionale.example/": "https://gestionale.example",
        "gestionale.example": "https://gestionale.example",
        "  gestionale.example/optiroute.html  ": "https://gestionale.example",
        "HTTPS://Gestionale.EXAMPLE/Pagina?x=1#a": "https://gestionale.example",
        "https://gestionale.example:443/x": "https://gestionale.example",
        "https://gestionale.example:8443/x": "https://gestionale.example:8443",
        "https://progetto-di-prova.web.app/optiroute.html": "https://progetto-di-prova.web.app",
        "http://localhost:5000/optiroute.html": "http://localhost:5000",
        "http://127.0.0.1:8080": "http://127.0.0.1:8080",
        "http://localhost": "http://localhost",
        "http://localhost:80/": "http://localhost",
    }
    for dato, atteso in casi.items():
        assert normalizza_origine(dato) == atteso, (dato, normalizza_origine(dato))
    for sbagliato in ("", "   ", "http://gestionale.example", "ftp://gestionale.example",
                      "https://", "https://utente:pw@gestionale.example",
                      "https://gestionale.example:99999", "https://gestio nale.example",
                      "javascript:alert(1)", "https://gest_ionale.example"):
        _errore(sbagliato)
    print("OK test_normalizza_origine")


def test_carica_salva() -> None:
    cartella = Path(tempfile.mkdtemp(prefix="test_bridge_config_"))
    path = cartella / "bridge_config.json"
    # file assente → configurazione vuota (modalità manuale)
    assert carica_config(path) == {"gestionale": [], "pagina": PAGINA_DEFAULT}

    config = carica_config(path)
    assert aggiungi_gestionale(config, "gestionale.example/optiroute.html") == \
        ("https://gestionale.example", True)
    assert aggiungi_gestionale(config, "https://GESTIONALE.example") == \
        ("https://gestionale.example", False)
    salva_config(config, path)
    dati = json.loads(path.read_text(encoding="utf-8"))
    assert dati == {"gestionale": ["https://gestionale.example"], "pagina": "/optiroute.html"}
    assert carica_config(path) == dati
    assert not list(cartella.glob(".bridge_config_*.tmp"))

    # il file scritto a mano viene normalizzato e deduplicato
    path.write_text(json.dumps({"gestionale": ["gestionale.example", "https://gestionale.example/x"],
                                "pagina": "pagina.html"}), encoding="utf-8")
    assert carica_config(path) == {"gestionale": ["https://gestionale.example"],
                                   "pagina": "/pagina.html"}

    # file rovinato o con indirizzo non valido → errore chiaro
    for contenuto in ("{non json", "[]", json.dumps({"gestionale": ["http://gestionale.example"]}),
                      json.dumps({"gestionale": 5})):
        path.write_text(contenuto, encoding="utf-8")
        try:
            carica_config(path)
        except ConfigNonValida as e:
            assert "bridge_config.json" in str(e), str(e)
        else:
            raise AssertionError(f"accettato: {contenuto}")
    print("OK test_carica_salva")


def test_origini_effettive() -> None:
    cartella = Path(tempfile.mkdtemp(prefix="test_bridge_config_"))
    path = cartella / "bridge_config.json"
    assert origini_effettive(None, False, path) == ([], PAGINA_DEFAULT)
    salva_config({"gestionale": ["https://gestionale.example"], "pagina": "/op.html"}, path)
    assert origini_effettive(None, False, path) == (["https://gestionale.example"], "/op.html")
    # --gestionale sostituisce l'elenco del file (la pagina resta quella del file)
    assert origini_effettive(["altro.example", "https://altro.example/"], False, path) == \
        (["https://altro.example"], "/op.html")
    # --senza-gestionale → modalità manuale
    assert origini_effettive(None, True, path)[0] == []
    try:
        origini_effettive(["http://altro.example"], False, path)
    except ConfigNonValida:
        pass
    else:
        raise AssertionError("http accettato")
    print("OK test_origini_effettive")


def main() -> int:
    test_normalizza_origine()
    test_carica_salva()
    test_origini_effettive()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
