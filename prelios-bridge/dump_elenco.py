"""Diagnostico AUTONOMO: struttura grezza della griglia Elenco Perizie Prelios.

Serve a verificare (e correggere) la lettura automatica dell'elenco usata da
`run_giro.py --serve` senza file: fa login, apre l'Elenco Perizie col filtro
Cod. Immobile vuoto, lancia la ricerca e salva in JSON:
- tutte le righe <tr> lette (testi delle celle) di documento e frame;
- numero di frame e righe per frame;
- i controlli di paginazione riconosciuti (testi tipo "successiva", ">");
- cosa ne ricava il parser (contatori + pratiche FULL - Acquisto) e, per
  ogni riga, la colonna in cui ha trovato la Tipologia.

NON clicca la paginazione: fotografa solo la prima pagina.

USO (nella cartella del bridge):
    python dump_elenco.py                       # → elenco_dump.json (dati in chiaro)
    python dump_elenco.py --anonimo --out elenco_dump_anon.json   # condivisibile

Il file in chiaro contiene dati personali: resta sul PC (escluso da git).
Con --anonimo restano in chiaro solo le celle Tipologia (FULL - ..., DSKT - ...),
necessarie per capire la mappatura delle colonne.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from anonimizza import anonimizza
from excel_pratiche import _RE_TIPOLOGIA, _trova_colonna_tipologia, parse_grid_rows


def _cella_anonima(testo: str) -> str:
    return testo if _RE_TIPOLOGIA.match(testo or "") else anonimizza(testo)


def costruisci_report(griglia: dict, controlli: list[dict], url: str,
                      anonimo: bool = False) -> dict:
    """Report JSON dalla griglia letta (separato dal browser: testabile)."""
    rows = griglia.get("rows", [])
    stats: dict = {}
    pratiche = parse_grid_rows(rows, stats=stats)
    righe_out = []
    for r in rows:
        righe_out.append({
            "col_tipologia": _trova_colonna_tipologia(r),
            "n_celle": len(r),
            "celle": [_cella_anonima(c) for c in r] if anonimo else r,
        })
    pratiche_out = []
    for p in pratiche:
        d = {"codice": p.codice, "intestatario": p.intestatario, "via": p.via,
             "civico": p.civico, "comune": p.comune, "provincia": p.provincia,
             "progetto": p.progetto, "note_gestore": p.note_gestore}
        if anonimo:
            d = {k: anonimizza(v) for k, v in d.items()}
        pratiche_out.append(d)
    return {
        "quando": datetime.now().isoformat(timespec="seconds"),
        "url": anonimizza(url) if anonimo else url,
        "anonimizzato": anonimo,
        "frame_count": griglia.get("frame_count", 0),
        "frames": griglia.get("frames", []),
        "controlli_paginazione": controlli,
        "parser": {"contatori": stats, "pratiche": pratiche_out},
        "righe": righe_out,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dump griglia Elenco Perizie Prelios")
    parser.add_argument("--out", default="elenco_dump.json", help="File JSON di output")
    parser.add_argument("--anonimo", action="store_true",
                        help="Anonimizza i testi (lettere→x, cifre→9) tranne la Tipologia")
    args = parser.parse_args(argv)

    from browser import PreliosBrowser
    import prelios

    browser = PreliosBrowser()
    try:
        browser.start()
    except Exception as e:  # noqa: BLE001
        print(f"ERRORE avvio browser: {e}", file=sys.stderr)
        return 1

    try:
        if not prelios.login(browser):
            print("ERRORE: login non completato.", file=sys.stderr)
            return 1
        prelios.apri_elenco_completo(browser)
        griglia = prelios.attendi_griglia(browser)
        controlli = prelios.find_next_controls(browser)
        report = costruisci_report(griglia, controlli, browser.current_url, args.anonimo)

        out = Path(args.out)
        out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        c = report["parser"]["contatori"]
        print(f"\nScritto {out}: {len(report['righe'])} righe grezze, "
              f"{report['frame_count']} frame, {len(controlli)} controlli di paginazione.")
        print(f"Parser: {c.get('con_tipologia', 0)} righe con tipologia, "
              f"{c.get('pratiche', 0)} pratiche FULL - Acquisto, "
              f"{c.get('senza_codice', 0)} senza codice, {c.get('duplicate', 0)} duplicate.")
        if not args.anonimo:
            print("Il file contiene dati personali in chiaro: per condividerlo "
                  "rigeneralo con --anonimo.")
        return 0
    finally:
        browser.stop()


if __name__ == "__main__":
    raise SystemExit(main())
