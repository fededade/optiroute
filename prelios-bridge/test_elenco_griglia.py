#!/usr/bin/env python3
"""Test PURI di parse_grid_rows (righe lette dalla griglia del portale).

Niente browser, niente portale: le righe sono SINTETICHE e ANONIME e imitano
quello che list_assigned raccoglie dal DOM (liste di testi delle celle, con
intestazioni ripetute, righe di layout/paginazione, la stessa griglia vista
da piu' frame). Copre anche dump_elenco.costruisci_report.

Esecuzione:
    python test_elenco_griglia.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from excel_pratiche import parse_grid_rows, parse_rows  # noqa: E402

HEADER = ["Stato", "", "Cod. Immobile", "Fase", "", "", "Progetto", "NDG",
          "Tipologia", "", "", "Intestatario", "Indirizzo", "N.Civ.",
          "Comune", "Prov.", "", "Data", "Note"]


def riga(codice: str, tipologia: str, intestatario: str, via: str = "VIA ROMA",
         civico: str = "1", comune: str = "PAVIA", prov: str = "PV",
         note: str = "") -> list[str]:
    """Riga griglia nel layout dell'export (Tipologia in colonna 8), tutte
    stringhe come le legge il DOM."""
    return ["ASSEGNATA", "", codice, "SOPRALLUOGO", "", "", "PROGETTO X",
            "1234567890", tipologia, "0", "0", intestatario, via, civico,
            comune, prov, "", "01/07/2026", note]


def test_righe_miste() -> None:
    """Header ripetuti, righe non-pratica e tipologie non FULL - Acquisto."""
    rows = [
        ["Elenco Perizie"],                              # titolo
        HEADER,
        riga("515077", "FULL - Acquisto", "ROSSI MARIO"),
        riga("515078", "FULL - Surroga", "VERDI GIUSEPPE"),
        riga("515079", "DSKT - ALTRO", "BIANCHI LUIGI"),
        HEADER,                                          # header ripetuto
        riga("515.080", "full - acquisto", "NERI ANNA", note="Rif. Gestore: FONTANA MARCO 3487654321"),
        ["<", "1", "2", "3", ">"],                       # paginazione
        ["Totale righe: 4"],
        [],
        ["", "", ""],
    ]
    stats: dict = {}
    pratiche = parse_grid_rows(rows, stats=stats)
    assert [p.codice for p in pratiche] == ["515077", "515080"], pratiche
    p1, p2 = pratiche
    assert p1.intestatario == "ROSSI MARIO" and p1.comune == "PAVIA" and p1.provincia == "PV"
    assert p1.progetto == "PROGETTO X"
    assert p2.note_gestore == "Rif. Gestore: FONTANA MARCO 3487654321"
    assert stats["con_tipologia"] == 4, stats
    assert stats["altre_tipologie"] == 2, stats
    assert stats["pratiche"] == 2, stats
    print("OK test_righe_miste")


def test_dedup_e_frame() -> None:
    """La stessa griglia letta da documento e frame non duplica le pratiche."""
    pagina = [HEADER, riga("612345", "FULL - Acquisto", "ROSSI MARIO"),
              riga("612346", "FULL - Acquisto", "GALLO MARTA")]
    stats: dict = {}
    pratiche = parse_grid_rows(pagina + pagina, stats=stats)
    assert [p.codice for p in pratiche] == ["612345", "612346"]
    assert stats["duplicate"] == 2, stats
    print("OK test_dedup_e_frame")


def test_senza_codice_scartata() -> None:
    """Una riga FULL - Acquisto senza codice nelle prime 4 colonne non si
    potrebbe cercare sul portale: scartata e contata."""
    r = riga("", "FULL - Acquisto", "ROSSI MARIO")
    stats: dict = {}
    assert parse_grid_rows([r], stats=stats) == []
    assert stats["senza_codice"] == 1, stats
    print("OK test_senza_codice_scartata")


def test_header_non_cambia_parser() -> None:
    """Con l'header nelle prime righe parse_rows (file) risolve per nome;
    parse_grid_rows resta sull'ancora Tipologia: stessi risultati sui campi."""
    rows = [HEADER, riga("712345", "FULL - Acquisto", "FERRARI LUCIA", "VIA MAZZINI",
                         "8", "VERONA", "VR")]
    (g,) = parse_grid_rows(rows)
    assert (g.codice, g.intestatario, g.via, g.civico, g.comune, g.provincia) == \
        ("712345", "FERRARI LUCIA", "VIA MAZZINI", "8", "VERONA", "VR"), g
    # Il comportamento di parse_rows sui file non e' cambiato
    (f,) = parse_rows([riga("712345", "FULL - Acquisto", "FERRARI LUCIA", "VIA MAZZINI",
                            "8", "VERONA", "VR")])
    assert f == g
    print("OK test_header_non_cambia_parser")


def test_senza_filtro() -> None:
    rows = [riga("812345", "FULL - Acquisto", "A"), riga("812346", "DSKT - ALTRO", "B")]
    assert len(parse_grid_rows(rows, solo_tipologia=None)) == 2
    print("OK test_senza_filtro")


def test_report_dump_anonimo() -> None:
    """dump_elenco.costruisci_report: con --anonimo restano in chiaro solo le
    celle Tipologia. (dump_elenco importa selenium solo dentro main.)"""
    from dump_elenco import costruisci_report
    griglia = {"rows": [HEADER, riga("912345", "FULL - Acquisto", "ROSSI MARIO")],
               "frames": [{"origine": "main", "righe": 2}], "frame_count": 0}
    rep = costruisci_report(griglia, [], "https://esempio.invalid/x?id=123", anonimo=True)
    celle = rep["righe"][1]["celle"]
    assert "FULL - Acquisto" in celle
    assert "ROSSI MARIO" not in celle and "xxxxx xxxxx" in celle
    assert rep["righe"][1]["col_tipologia"] == 8
    assert rep["parser"]["pratiche"][0]["codice"] == "999999"
    assert rep["parser"]["contatori"]["pratiche"] == 1
    chiaro = costruisci_report(griglia, [], "u", anonimo=False)
    assert chiaro["parser"]["pratiche"][0]["intestatario"] == "ROSSI MARIO"
    print("OK test_report_dump_anonimo")


def main() -> int:
    test_righe_miste()
    test_dedup_e_frame()
    test_senza_codice_scartata()
    test_header_non_cambia_parser()
    test_senza_filtro()
    test_report_dump_anonimo()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
