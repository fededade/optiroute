#!/usr/bin/env python3
"""Orchestratore CLI del bridge Prelios -> OptiRoute.

Legge l'elenco pratiche (solo tipologia FULL - Acquisto), per ogni pratica usa
la pipeline MISI ISP (login una sola volta, poi ricerca perizia, apertura,
estrazione telefono con t05) e scrive un Excel importabile in OptiRoute con
le colonne: Intestatario, Indirizzo, N.Civ., Comune, Prov., Telefono, Note,
Codice (piu' una colonna Esito diagnostica).

Uso:
    python run_giro.py elenco.xlsx --out giro_arricchito.xlsx
    python run_giro.py elenco.xlsx --out giro.xlsx --dry-run   # senza pipeline

Questo file e excel_pratiche.py vanno copiati nella ROOT del progetto MISI
ISP; t05_extract_contacts.py va copiato in tools/. In --dry-run funziona
ovunque, senza pipeline (utile per testare l'import in OptiRoute).
"""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

# Rende importabile excel_pratiche anche se run_giro e' lanciato da altrove
sys.path.insert(0, str(Path(__file__).resolve().parent))

from excel_pratiche import Pratica, load_pratiche  # noqa: E402

# Intestazioni ESATTE attese dall'import di OptiRoute (non rinominarle).
# "Esito" e' una colonna extra diagnostica: OptiRoute la ignora; in caso di
# problemi di import, eliminarla a mano dal file.
COLONNE_OUTPUT = ["Intestatario", "Indirizzo", "N.Civ.", "Comune", "Prov.",
                  "Telefono", "Note", "Codice", "Esito"]

MSG_PIPELINE_ASSENTE = (
    "ERRORE: moduli della pipeline MISI ISP non importabili ({dettaglio}).\n"
    "Copiare questi file DENTRO il progetto MISI ISP:\n"
    "  - run_giro.py ed excel_pratiche.py nella root del progetto\n"
    "    (accanto a models.py e js_commands.py)\n"
    "  - t05_extract_contacts.py dentro tools/ (accanto a t01_login.py)\n"
    "e rilanciare da li'. In alternativa usare --dry-run per produrre\n"
    "comunque l'Excel filtrato senza telefoni."
)


class PipelineNonDisponibile(RuntimeError):
    """La pipeline MISI ISP non e' importabile da questo ambiente."""


# === IMPORT LAZY DELLA PIPELINE MISI ===

def _import_pipeline() -> dict:
    """Importa i moduli della pipeline MISI ISP (lazy, solo se non --dry-run).

    Returns:
        Dizionario {nome: classe} con i tool necessari.

    Raises:
        PipelineNonDisponibile: se i moduli non sono presenti.
    """
    try:
        from tools.t01_login import LoginTool
        from tools.t02_search_perizia import SearchPeriziaTool
        from tools.t03_open_perizia import OpenPeriziaTool
    except ImportError as e:
        raise PipelineNonDisponibile(str(e)) from e

    # t05 puo' stare in tools/ (posizione consigliata) o accanto a run_giro
    try:
        from tools.t05_extract_contacts import ExtractContactsTool
    except ImportError:
        try:
            from t05_extract_contacts import ExtractContactsTool
        except ImportError as e:
            raise PipelineNonDisponibile(
                f"t05_extract_contacts non trovato ({e}); "
                "copiarlo in tools/ del progetto MISI"
            ) from e

    return {
        "LoginTool": LoginTool,
        "SearchPeriziaTool": SearchPeriziaTool,
        "OpenPeriziaTool": OpenPeriziaTool,
        "ExtractContactsTool": ExtractContactsTool,
    }


def _crea_contesto():
    """Costruisce il ToolContext della pipeline MISI e avvia il browser.

    Replica il setup reale di MISI ISP:
      - AppConfig()               (config.py)
      - BrowserSession(...).start()  (browser_session.py) — apre/collega
        il Chrome con remote debugging su cui farai il login MFA
      - ToolContext(browser, data, config, logger)  (models.py)
    """
    try:
        import logging
        from models import ToolContext, PeriziaData
        from config import AppConfig
        from browser_session import BrowserSession
    except ImportError as e:
        raise PipelineNonDisponibile(
            f"moduli MISI non trovati ({e}). Copiare run_giro.py, "
            "excel_pratiche.py e contact_parse.py nella cartella RADICE del "
            "progetto MISI (accanto a config.py, models.py, browser_session.py)."
        ) from e

    try:
        config = AppConfig()
        browser = BrowserSession(
            headless=config.headless,
            chrome_driver_path=config.chrome_driver_path,
            page_load_timeout=config.page_load_timeout,
            element_wait_timeout=config.element_wait_timeout,
            download_dir=str(config.downloads_dir),
        )
        browser.start()
        logger = logging.getLogger("prelios_bridge")
        return ToolContext(
            browser=browser,
            data=PeriziaData(),
            config=config,
            logger=logger,
        )
    except Exception as e:
        raise PipelineNonDisponibile(
            f"impossibile avviare il browser/contesto MISI ({e}). "
            "Assicurati che MISI non sia gia' aperto (usano lo stesso Chrome) "
            "e che Chrome sia installato."
        ) from e


# === ESECUZIONE TOOL ===

def _merge_result(ctx, result) -> None:
    """Riversa result.data_updates dentro ctx.data (come fa il runner MISI).

    NB: il campo di ToolResult si chiama `data_updates` (non `data`).
    """
    for key, value in (getattr(result, "data_updates", None) or {}).items():
        setattr(ctx.data, key, value)


def _run_tool(ctx, tool_cls):
    """Istanzia ed esegue un tool: precondizioni + execute + merge dati.

    Returns:
        (ok, messaggio) — ok False se precondizioni o execute falliscono.
    """
    tool = tool_cls(ctx)
    ok, msg = tool.validate_preconditions()
    if not ok:
        return False, f"{tool.tool_id}: precondizioni non soddisfatte ({msg})"
    result = tool.execute()
    _merge_result(ctx, result)
    if not result.success:
        return False, f"{tool.tool_id}: {result.message}"
    return True, result.message


def _format_codice(codice: str) -> str:
    """Formatta il codice come nella griglia Prelios: 810766 -> '810.766'."""
    return f"{codice[:-3]}.{codice[-3:]}" if len(codice) > 3 else codice


def processa_pratica(ctx, tools: dict, pratica: Pratica) -> tuple[str, str, str]:
    """Lavora una singola pratica: ricerca, apertura, estrazione telefono.

    Returns:
        (telefono, esito, nota_contatto) — telefono '' se non trovato;
        esito 'OK' o motivo KO; nota_contatto = nota gestore Prelios con
        referente/istruzioni per il sopralluogo (utile all'operatore AI).
    """
    # Imposta il codice e azzera i flag della pratica precedente
    ctx.data.perizia_code = pratica.codice
    ctx.data.perizia_code_formatted = _format_codice(pratica.codice)
    ctx.data.perizia_found = False
    ctx.data.perizia_open = False
    ctx.data.client_phone = ""
    ctx.data.contact_name = ""
    ctx.data.contact_note = ""

    for tool_cls in (tools["SearchPeriziaTool"], tools["OpenPeriziaTool"],
                     tools["ExtractContactsTool"]):
        ok, msg = _run_tool(ctx, tool_cls)
        if not ok:
            return "", f"KO {msg}", ""

    telefono = getattr(ctx.data, "client_phone", "") or ""
    nota_contatto = (getattr(ctx.data, "contact_note", "") or "").strip()
    esito = "OK" if telefono else "OK (telefono non trovato)"
    return telefono, esito, nota_contatto


# === OUTPUT EXCEL ===

def _componi_note(pratica: Pratica, nota_contatto: str = "") -> str:
    """Note per OptiRoute: progetto + riferimento gestore + nota contatto
    Prelios (referente e istruzioni sopralluogo, letta dalla perizia)."""
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
    """Scrive l'Excel di output con openpyxl; se openpyxl manca, degrada a
    CSV (stesse colonne) avvisando l'utente. Restituisce il percorso scritto."""
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
    # Larghezze colonne leggibili (best-effort)
    for col_idx, nome in enumerate(COLONNE_OUTPUT, start=1):
        larghezza = max(
            [len(nome)] + [len(str(r[col_idx - 1])) for r in righe] or [10]
        )
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = \
            min(larghezza + 2, 50)
    wb.save(path)
    return path


# === MAIN ===

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Arricchisce l'elenco pratiche (FULL - Acquisto) con i "
                    "telefoni da Prelios e produce l'Excel per OptiRoute."
    )
    parser.add_argument("elenco", help="File elenco pratiche (.xlsx/.tsv/.csv)")
    parser.add_argument("--out", default="giro_arricchito.xlsx",
                        help="File Excel di output (default: %(default)s)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Non usa la pipeline: produce l'Excel filtrato "
                             "senza telefoni (test import OptiRoute)")
    args = parser.parse_args(argv)

    # 1. Carica e filtra le pratiche (solo FULL - Acquisto)
    pratiche = load_pratiche(args.elenco)
    print(f"Pratiche FULL - Acquisto trovate: {len(pratiche)}")
    if not pratiche:
        print("Niente da fare: nessuna pratica FULL - Acquisto nell'elenco.")
        return 1

    righe: list[list[str]] = []

    if args.dry_run:
        # 2a. Dry-run: nessuna pipeline, telefoni vuoti
        print("Modalita' DRY-RUN: nessun accesso a Prelios, telefoni vuoti.")
        righe = [_riga_output(p, "", "DRY-RUN") for p in pratiche]
    else:
        # 2b. Giro completo con la pipeline MISI
        try:
            tools = _import_pipeline()
            ctx = _crea_contesto()
        except PipelineNonDisponibile as e:
            print(MSG_PIPELINE_ASSENTE.format(dettaglio=e))
            return 2

        # Login UNA SOLA volta per tutto il giro
        ok, msg = _run_tool(ctx, tools["LoginTool"])
        if not ok:
            print(f"ERRORE login: {msg}")
            return 3
        print("Login effettuato — inizio giro pratiche")

        # Per-pratica: gli errori NON fermano il giro (finiscono in Esito)
        for i, pratica in enumerate(pratiche, start=1):
            print(f"[{i}/{len(pratiche)}] Pratica {pratica.codice} "
                  f"({pratica.intestatario})...")
            try:
                telefono, esito, nota_contatto = processa_pratica(ctx, tools, pratica)
            except Exception as e:  # noqa: BLE001 — il giro deve continuare
                traceback.print_exc()
                telefono, esito, nota_contatto = "", f"ERRORE: {e}", ""
            print(f"    -> {esito}" + (f" tel={telefono}" if telefono else ""))
            righe.append(_riga_output(pratica, telefono, esito, nota_contatto))

    # 3. Scrivi l'Excel per OptiRoute
    out = scrivi_output(Path(args.out), righe)
    print(f"Output scritto: {out} ({len(righe)} righe)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
