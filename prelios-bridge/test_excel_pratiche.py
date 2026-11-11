#!/usr/bin/env python3
"""Test PURI per excel_pratiche (senza pipeline MISI, senza pytest).

Usa solo assert + main. I dati sono SINTETICI e ANONIMI (nessun nominativo o
indirizzo reale). Copre: filtro FULL - Acquisto, estrazione campi, euristica
posizionale senza header, parsing con header, riferimento gestore, lettura
file TSV (percorso che funziona anche senza openpyxl).

Esecuzione:
    python test_excel_pratiche.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from excel_pratiche import (  # noqa: E402
    Pratica,
    TIPOLOGIA_TARGET,
    load_pratiche,
    normalizza_tipologia,
    parse_rows,
)


def riga_sintetica(codice: object, progetto: str, tipologia: str,
                   intestatario: str, via: str, civico: str, comune: str,
                   prov: str, note: str = "") -> list[object]:
    """Costruisce una riga nel formato dell'elenco reale (senza header):
    [stato, vuoto, codice, fase, vuoto, vuoto, progetto, ndg, tipologia,
     0, 0, intestatario, via, civico, comune, prov, vuoto, data, note]
    La colonna Tipologia e' quindi T=8: intestatario=T+3, via=T+4,
    civico=T+5, comune=T+6, prov=T+7, progetto=T-2, codice nelle prime 4.
    """
    return ["ASSEGNATA", "", codice, "SOPRALLUOGO", "", "", progetto,
            "1234567890", tipologia, 0, 0, intestatario, via, civico,
            comune, prov, "", "01/07/2026", note]


def test_normalizza_tipologia() -> None:
    assert normalizza_tipologia("FULL - Acquisto") == "FULL - ACQUISTO"
    assert normalizza_tipologia("full  -   acquisto") == "FULL - ACQUISTO"
    assert normalizza_tipologia("FULL-Acquisto") == "FULL - ACQUISTO"
    assert normalizza_tipologia("  DSKT - ALTRO ") == "DSKT - ALTRO"
    assert normalizza_tipologia(None) == ""
    print("OK test_normalizza_tipologia")


def test_filtro_full_acquisto() -> None:
    """Tiene solo FULL - Acquisto (case-insensitive, spazi collassati);
    esclude FULL - Surroga e DSKT - ALTRO."""
    rows = [
        riga_sintetica(515077, "PROGETTO A", "FULL - Acquisto",
                       "ROSSI MARIO", "VIA ROMA", "10", "MILANO", "MI"),
        riga_sintetica(515078, "PROGETTO A", "FULL - Surroga",
                       "VERDI GIUSEPPE", "VIA MILANO", "2", "TORINO", "TO"),
        riga_sintetica(515079, "PROGETTO B", "DSKT - ALTRO",
                       "BIANCHI LUIGI", "VIA NAPOLI", "5", "ROMA", "RM"),
        riga_sintetica(515080, "PROGETTO B", "full  -  ACQUISTO",
                       "NERI ANNA", "VIA TORINO", "7", "GENOVA", "GE"),
    ]
    pratiche = parse_rows(rows)
    assert len(pratiche) == 2, f"attese 2 pratiche, trovate {len(pratiche)}"
    assert [p.codice for p in pratiche] == ["515077", "515080"]
    assert all(isinstance(p, Pratica) for p in pratiche)

    # Senza filtro devono uscire tutte e 4
    tutte = parse_rows(rows, solo_tipologia=None)
    assert len(tutte) == 4, f"attese 4 pratiche senza filtro, trovate {len(tutte)}"
    print("OK test_filtro_full_acquisto")


def test_estrazione_campi() -> None:
    """I campi devono finire nelle proprieta' giuste della dataclass."""
    rows = [
        riga_sintetica(612345, "PROGETTO C", "FULL - Acquisto",
                       "ROSSI MARIO", "VIA GARIBALDI", "42/B", "BOLOGNA", "BO"),
    ]
    (p,) = parse_rows(rows)
    assert p.codice == "612345"
    assert p.intestatario == "ROSSI MARIO"
    assert p.via == "VIA GARIBALDI"
    assert p.civico == "42/B"
    assert p.comune == "BOLOGNA"
    assert p.provincia == "BO"
    assert p.progetto == "PROGETTO C"
    assert p.note_gestore == ""
    print("OK test_estrazione_campi")


def test_euristica_senza_header() -> None:
    """L'euristica e' ancorata alla colonna Tipologia, non a posizioni fisse:
    con un layout diverso (T=4, codice in colonna 1) i campi devono comunque
    finire al posto giusto. Il codice float di Excel (515081.0) va pulito."""
    # Layout alternativo: [vuoto, codice, progetto, ndg, tipologia, 0, 0,
    #                      intestatario(T+3), via, civico, comune, prov]
    row = ["", 515081.0, "PROGETTO D", "9876543210", "FULL - Acquisto",
           0, 0, "ESPOSITO CARLA", "VIA DANTE", "3", "FIRENZE", "FI"]
    (p,) = parse_rows([row])
    assert p.codice == "515081"
    assert p.intestatario == "ESPOSITO CARLA"
    assert p.via == "VIA DANTE"
    assert p.civico == "3"
    assert p.comune == "FIRENZE"
    assert p.provincia == "FI"
    assert p.progetto == "PROGETTO D"

    # Codice con punto migliaia nelle prime 4 colonne: "515.082" -> "515082"
    row2 = riga_sintetica("515.082", "PROGETTO D", "FULL - Acquisto",
                          "COLOMBO PAOLO", "VIA VERDI", "1", "PADOVA", "PD")
    (p2,) = parse_rows([row2])
    assert p2.codice == "515082"

    # Righe vuote o senza tipologia riconoscibile vengono ignorate
    rumore = [[], ["", "", ""], ["TOTALE", 12, "note varie"]]
    assert parse_rows(rumore) == []
    print("OK test_euristica_senza_header")


def test_parsing_con_header() -> None:
    """Con riga di intestazione le colonne si risolvono per NOME, anche con
    un ordine diverso da quello dell'euristica posizionale."""
    rows = [
        ["Codice", "Progetto", "Tipologia", "Intestatario", "Indirizzo",
         "Civico", "Comune", "Prov.", "Note"],
        [712345, "PROGETTO E", "FULL - Acquisto", "FERRARI LUCIA",
         "VIA MAZZINI", "8", "VERONA", "VR", ""],
        [712346, "PROGETTO E", "FULL - Surroga", "RICCI ANDREA",
         "VIA LEOPARDI", "12", "BARI", "BA", ""],
        [712347, "PROGETTO F", "FULL - ACQUISTO", "GRECO SOFIA",
         "VIA CARDUCCI", "9", "PALERMO", "PA",
         "Urgente. Rif. Gestore: BRUNO STEFANO 333 1234567 s.bruno@esempio.it"],
    ]
    pratiche = parse_rows(rows)
    assert len(pratiche) == 2, f"attese 2 pratiche, trovate {len(pratiche)}"

    p1, p2 = pratiche
    assert p1.codice == "712345"
    assert p1.intestatario == "FERRARI LUCIA"
    assert p1.via == "VIA MAZZINI"
    assert p1.civico == "8"
    assert p1.comune == "VERONA"
    assert p1.provincia == "VR"
    assert p1.progetto == "PROGETTO E"

    # Riferimento gestore estratto dalla colonna note (pattern Rif. Gestore:)
    assert p2.codice == "712347"
    assert p2.note_gestore.startswith("Rif. Gestore:"), p2.note_gestore
    assert "BRUNO STEFANO" in p2.note_gestore
    assert "333 1234567" in p2.note_gestore
    print("OK test_parsing_con_header")


def test_rif_gestore_senza_header() -> None:
    """Il riferimento gestore va trovato anche nell'ultima colonna note del
    formato senza intestazione."""
    row = riga_sintetica(812345, "PROGETTO G", "FULL - Acquisto",
                         "GALLO MARTA", "VIA ROMA", "15", "TRENTO", "TN",
                         note="Rif. Gestore: FONTANA MARCO 3487654321")
    (p,) = parse_rows([row])
    assert p.note_gestore == "Rif. Gestore: FONTANA MARCO 3487654321"
    print("OK test_rif_gestore_senza_header")


def test_load_pratiche_tsv() -> None:
    """load_pratiche deve leggere un TSV senza bisogno di openpyxl."""
    rows = [
        riga_sintetica(912345, "PROGETTO H", "FULL - Acquisto",
                       "ROSSI MARIO", "VIA ROMA", "10", "MILANO", "MI",
                       note="Rif. Gestore: RIZZO ELENA 3391112223"),
        riga_sintetica(912346, "PROGETTO H", "DSKT - ALTRO",
                       "VERDI GIUSEPPE", "VIA MILANO", "2", "TORINO", "TO"),
    ]
    contenuto = "\n".join(
        "\t".join(str(c) for c in row) for row in rows
    )
    with tempfile.NamedTemporaryFile("w", suffix=".tsv", delete=False,
                                     encoding="utf-8") as f:
        f.write(contenuto)
        percorso = Path(f.name)

    try:
        pratiche = load_pratiche(percorso)
        assert len(pratiche) == 1, f"attesa 1 pratica, trovate {len(pratiche)}"
        (p,) = pratiche
        assert p.codice == "912345"
        assert p.intestatario == "ROSSI MARIO"
        assert p.comune == "MILANO"
        assert "RIZZO ELENA" in p.note_gestore
    finally:
        percorso.unlink(missing_ok=True)
    print("OK test_load_pratiche_tsv")


def main() -> int:
    assert normalizza_tipologia(TIPOLOGIA_TARGET) == TIPOLOGIA_TARGET
    test_normalizza_tipologia()
    test_filtro_full_acquisto()
    test_estrazione_campi()
    test_euristica_senza_header()
    test_parsing_con_header()
    test_rif_gestore_senza_header()
    test_load_pratiche_tsv()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
