"""Bridge Prelios → OptiRoute — programma AUTONOMO.

Legge un elenco pratiche (Excel/TSV/CSV), tiene solo le FULL - Acquisto, entra
in Prelios (login MFA manuale), recupera il telefono di ogni cliente e produce
un Excel con le colonne che OptiRoute importa.

NON dipende dal progetto MISI: porta con sé la propria logica di accesso a
Prelios (browser.py + prelios.py).

USO:
    python run_giro.py elenco.xlsx --out giro_arricchito.xlsx
    python run_giro.py elenco.xlsx --dry-run           # senza Prelios (test)
    python run_giro.py elenco.xlsx --user-id 8468       # override User ID Prelios
"""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

from excel_pratiche import Pratica, load_pratiche

# User ID Prelios di default (per mouseClickObj). Sovrascrivibile da --user-id.
DEFAULT_USER_ID = "8468"

COLONNE_OUTPUT = [
    "Intestatario", "Indirizzo", "N.Civ.", "Comune", "Prov.",
    "Telefono", "Note", "Codice", "Esito",
]


# --- Output ---------------------------------------------------------------

def _componi_note(pratica: Pratica, nota_contatto: str = "") -> str:
    parti = [p for p in (pratica.progetto, pratica.note_gestore) if p]
    if nota_contatto and all(nota_contatto not in p for p in parti):
        parti.append(f"Contatto Prelios: {nota_contatto[:200]}")
    return " | ".join(parti)


def _riga_output(pratica: Pratica, telefono: str, esito: str,
                 nota_contatto: str = "") -> list[str]:
    return [
        pratica.intestatario,
        pratica.via,
        pratica.civico,
        pratica.comune,
        pratica.provincia,
        telefono,
        _componi_note(pratica, nota_contatto),
        pratica.codice,
        esito,
    ]


def scrivi_output(path: Path, righe: list[list[str]]) -> Path:
    """Scrive l'Excel con openpyxl; se manca, degrada a CSV (stesse colonne)."""
    try:
        from openpyxl import Workbook
    except ImportError:
        import csv
        alt = path.with_suffix(".csv")
        with alt.open("w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f, delimiter=";")
            writer.writerow(COLONNE_OUTPUT)
            writer.writerows(righe)
        print(f"ATTENZIONE: openpyxl non installato — scritto CSV: {alt}")
        print("Per l'Excel: pip install openpyxl")
        return alt

    wb = Workbook()
    ws = wb.active
    ws.title = "Giro"
    ws.append(COLONNE_OUTPUT)
    for riga in righe:
        ws.append(riga)
    for col_idx, nome in enumerate(COLONNE_OUTPUT, start=1):
        larghezza = max([len(nome)] + [len(str(r[col_idx - 1])) for r in righe] or [10])
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = min(larghezza + 2, 50)
    wb.save(path)
    return path


# --- Giro -----------------------------------------------------------------

def processa_pratica(browser, pratica: Pratica, user_id: str) -> tuple[str, str, str]:
    """Ricerca → apertura → estrazione telefono per una pratica.

    Returns: (telefono, esito, nota_contatto).
    """
    import prelios

    if not prelios.search_perizia(browser, pratica.codice):
        return "", "KO perizia non trovata", ""
    if not prelios.open_perizia(browser, pratica.codice, user_id):
        return "", "KO apertura fallita", ""

    telefono, nota_contatto = prelios.extract_phone(browser)
    esito = "OK" if telefono else "OK (telefono non trovato)"
    return telefono, esito, nota_contatto


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Arricchisce l'elenco pratiche (FULL - Acquisto) con i "
                    "telefoni da Prelios e produce l'Excel per OptiRoute."
    )
    parser.add_argument("elenco", help="File elenco pratiche (.xlsx/.tsv/.csv)")
    parser.add_argument("--out", default="giro_arricchito.xlsx",
                        help="File Excel di output (default: %(default)s)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Non accede a Prelios: produce l'Excel filtrato "
                             "senza telefoni (test import OptiRoute)")
    parser.add_argument("--user-id", default=DEFAULT_USER_ID,
                        help="User ID Prelios per l'apertura perizia "
                             "(default: %(default)s)")
    args = parser.parse_args(argv)

    pratiche = load_pratiche(args.elenco)
    print(f"Pratiche FULL - Acquisto trovate: {len(pratiche)}")
    if not pratiche:
        print("Niente da fare: nessuna pratica FULL - Acquisto nell'elenco.")
        return 1

    righe: list[list[str]] = []

    if args.dry_run:
        print("Modalità DRY-RUN: nessun accesso a Prelios, telefoni vuoti.")
        righe = [_riga_output(p, "", "DRY-RUN") for p in pratiche]
        out = scrivi_output(Path(args.out), righe)
        print(f"Output scritto: {out} ({len(righe)} righe)")
        return 0

    # Giro completo su Prelios
    try:
        from browser import PreliosBrowser
        import prelios
    except ImportError as e:
        print(f"ERRORE import moduli bridge ({e}). "
              "Assicurati che browser.py, prelios.py, contact_parse.py e "
              "excel_pratiche.py siano nella stessa cartella di run_giro.py.")
        return 2

    browser = PreliosBrowser()
    try:
        browser.start()
    except Exception as e:
        print(f"ERRORE avvio browser ({e}). Chrome è installato? "
              "Selenium presente? (pip install selenium)")
        return 3

    try:
        if not prelios.login(browser):
            print("ERRORE: login non completato entro il tempo limite.")
            return 4
        print("Login effettuato — inizio giro pratiche")

        for i, pratica in enumerate(pratiche, start=1):
            print(f"[{i}/{len(pratiche)}] Pratica {pratica.codice} ({pratica.intestatario})...")
            try:
                telefono, esito, nota = processa_pratica(browser, pratica, args.user_id)
            except Exception as e:  # noqa: BLE001 — il giro deve continuare
                traceback.print_exc()
                telefono, esito, nota = "", f"ERRORE: {e}", ""
            print(f"    -> {esito}" + (f" tel={telefono}" if telefono else ""))
            righe.append(_riga_output(pratica, telefono, esito, nota))
    finally:
        browser.stop()

    out = scrivi_output(Path(args.out), righe)
    print(f"Output scritto: {out} ({len(righe)} righe)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
