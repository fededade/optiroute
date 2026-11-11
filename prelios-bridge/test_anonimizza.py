#!/usr/bin/env python3
"""Test PURI dell'anonimizzazione delle catture e del registro portali.

Niente browser: la cattura e' un dizionario SINTETICO con la stessa forma di
quella prodotta da capture_portal.py. Verifica che la struttura resti
(intestazioni, id/name dei campi, etichette brevi) e i dati spariscano
(testi delle celle, valori, query dell'URL, titolo), preservando lunghezza e
punteggiatura. Verifica anche che Cerved sia registrato ma NON configurato.

Esecuzione:
    python test_anonimizza.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from anonimizza import anonimizza, anonimizza_cattura, anonimizza_url  # noqa: E402


def test_anonimizza_testo() -> None:
    assert anonimizza("ROSSI MARIO - 333 1234567") == "xxxxx xxxxx - 999 9999999"
    assert anonimizza("Via Roma, 10/B") == "xxx xxxx, 99/x"
    assert anonimizza("mario.rossi@esempio.it") == "xxxxx.xxxxx@xxxxxxx.xx"
    assert anonimizza("+39 02-1234") == "+99 99-9999"
    assert anonimizza("Città àèù") == "xxxxx xxx"   # lettere accentate
    assert anonimizza(None) == ""
    assert anonimizza(826361) == "999999"
    s = "Intestatario: NERI ANNA (CF RSSMRA80A01F205X)"
    assert len(anonimizza(s)) == len(s)
    print("OK test_anonimizza_testo")


def test_anonimizza_url() -> None:
    u = anonimizza_url("https://portale.example/pratiche/826361/dettaglio?id=826361&nome=ROSSI#tab2")
    assert u.startswith("https://portale.example/pratiche/999999/dettaglio?"), u
    assert "id=999999" in u and "nome=xxxxx" in u and u.endswith("#xxx9"), u
    assert "826361" not in u and "ROSSI" not in u
    print("OK test_anonimizza_url")


def _cattura_sintetica() -> dict:
    return {
        "quando": "2026-11-11T09:00:00",
        "etichetta": "elenco",
        "finestre": [{"documento": {
            "url": "https://portale.example/elenco?utente=MARIO",
            "titolo": "Pratica ROSSI MARIO",
            "tabelle": [{
                "indice": 0, "id": "grid_826361", "classe": "griglia", "righe": 2,
                "intestazioni": ["Codice", "Intestatario", "Telefono"],
                "campione": [
                    {"celle": [{"t": "Codice", "th": True}, {"t": "Intestatario", "th": True},
                               {"t": "Telefono", "th": True}],
                     "id": "", "classe": "", "onclick": ""},
                    {"celle": [{"t": "826361", "th": False}, {"t": "ROSSI MARIO", "th": False},
                               {"t": "333 1234567", "th": False}],
                     "id": "r_826361", "classe": "riga",
                     "onclick": "apri(this,'826361.8468')"},
                ],
            }],
            "campi": [
                {"tag": "INPUT", "type": "text", "id": "tel_mutuatario", "name": "tel",
                 "label": "Telefono Mutuatario", "label_fonte": "td", "label_celle_riga": 2,
                 "placeholder": "", "value": "3331234567"},
                {"tag": "INPUT", "type": "checkbox", "id": "sel", "name": "sel",
                 "label": "ROSSI MARIO", "label_fonte": "td", "label_celle_riga": 12,
                 "placeholder": "", "value": "on"},
            ],
            "azioni": [
                {"tag": "A", "id": "menu1", "testo": "Elenco pratiche", "href": "/elenco",
                 "onclick": "", "in_tabella": False},
                {"tag": "A", "id": "", "testo": "VERDI ANNA", "href": "/p?id=5",
                 "onclick": "apri(5)", "in_tabella": True},
            ],
            "frame": [{
                "url": "https://portale.example/scheda", "titolo": "Scheda",
                "tabelle": [], "azioni": [], "frame": [],
                "campi": [{"tag": "TEXTAREA", "type": "textarea", "id": "note", "name": "note",
                           "label": "Note", "label_fonte": "label", "label_celle_riga": 0,
                           "placeholder": "", "value": "Chiamare BIANCHI 3471234567"}],
            }],
        }}],
    }


def test_anonimizza_cattura() -> None:
    originale = _cattura_sintetica()
    anon = anonimizza_cattura(originale)
    assert anon["anonimizzata"] is True
    assert originale["finestre"][0]["documento"]["titolo"] == "Pratica ROSSI MARIO"  # copia

    doc = anon["finestre"][0]["documento"]
    assert doc["url"] == "https://portale.example/elenco?utente=xxxxx", doc["url"]
    assert doc["titolo"] == "xxxxxxx xxxxx xxxxx", doc["titolo"]

    t = doc["tabelle"][0]
    assert t["intestazioni"] == ["Codice", "Intestatario", "Telefono"]  # struttura
    assert t["id"] == "grid_999999"
    intest, dati = t["campione"]
    assert [c["t"] for c in intest["celle"]] == ["Codice", "Intestatario", "Telefono"]
    assert [c["t"] for c in dati["celle"]] == ["999999", "xxxxx xxxxx", "999 9999999"]
    assert dati["onclick"] == "apri(this,'999999.9999')"

    tel, check = doc["campi"]
    assert tel["id"] == "tel_mutuatario" and tel["name"] == "tel"
    assert tel["label"] == "Telefono Mutuatario"     # etichetta di modulo: in chiaro
    assert tel["value"] == "9999999999"
    assert check["label"] == "xxxxx xxxxx"           # "etichetta" in una griglia: dato

    menu, link_riga = doc["azioni"]
    assert menu["testo"] == "Elenco pratiche"
    assert link_riga["testo"] == "xxxxx xxxx" and link_riga["href"] == "/p?id=9"

    nota = doc["frame"][0]["campi"][0]
    assert nota["label"] == "Note"
    assert nota["value"] == "xxxxxxxx xxxxxxx 9999999999"

    testo = str(anon)
    for dato in ("ROSSI", "MARIO", "BIANCHI", "VERDI", "3331234567", "826361", "3471234567"):
        assert dato not in testo, dato
    print("OK test_anonimizza_cattura")


def test_registro_portali() -> None:
    from portals import (MESSAGGIO_CERVED, PortaleNonConfigurato, PreliosAdapter,
                         get_adapter)
    p = get_adapter("prelios", user_id="1234")
    assert isinstance(p, PreliosAdapter) and p.user_id == "1234" and p.supporta_elenco
    try:
        get_adapter("cerved")
    except PortaleNonConfigurato as e:
        assert "NON ancora configurato" in str(e)
        assert "capture_portal.py" in str(e)
    else:
        raise AssertionError("Cerved non deve essere utilizzabile")
    assert "URL" in MESSAGGIO_CERVED and "telefono" in MESSAGGIO_CERVED
    try:
        get_adapter("sconosciuto")
    except KeyError:
        pass
    else:
        raise AssertionError("portale sconosciuto accettato")
    print("OK test_registro_portali")


def main() -> int:
    test_anonimizza_testo()
    test_anonimizza_url()
    test_anonimizza_cattura()
    test_registro_portali()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
