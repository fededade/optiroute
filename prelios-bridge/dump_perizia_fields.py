"""Strumento diagnostico: mappa i campi di una perizia Prelios aperta.

Serve a individuare DOVE si trova il numero di telefono del cliente
(e qualsiasi altro dato) dentro la perizia: produce un JSON con
  - le pagine raggiungibili dal menu della perizia
  - tutti i campi form (id, name, etichetta, valore) della pagina corrente
    e delle pagine richieste con --page
  - i candidati "telefono" trovati (campi e testo pagina)

USO (dentro il progetto MISI ISP, accanto a run_giro.py):
    python dump_perizia_fields.py 826361
    python dump_perizia_fields.py 826361 --page "Anagrafica" --page "Sopralluogo"
    python dump_perizia_fields.py 826361 --out campi_826361.json

Il login e' quello manuale MFA della pipeline (t01). Il JSON prodotto va
condiviso per finalizzare t05_extract_contacts con i selettori esatti.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from run_giro import (  # riusa la stessa infrastruttura del giro
    PipelineNonDisponibile,
    _crea_contesto,
    _import_pipeline,
    _merge_result,
    _run_tool,
)

RE_PHONE = re.compile(
    r"\b(?:(?:\+|00)39[\s.]?)?(?:3\d{2}(?:[\s./-]?\d{3}){2}\d?|0\d{1,3}[\s./-]?\d{5,8})\b"
)

# JS: elenco delle pagine di menu (input nascosti con parametri XmlForm)
_JS_MENU_PAGES = """
var pages = [];
var inputs = document.querySelectorAll('input[type="text"]');
for (var i = 0; i < inputs.length; i++) {
    var v = inputs[i].value || '';
    if (v.indexOf('XmlForm:') > -1) pages.push(v.substring(0, 200));
}
return pages;
"""

# JS: dump dei campi form del contesto corrente (documento o frame)
_JS_DUMP_FIELDS = """
var out = [];
var els = document.querySelectorAll('input, select, textarea');
for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var id = el.id || '';
    var name = el.name || '';
    if (!id && !name) continue;
    if (id.indexOf('mnu_') === 0 || id.indexOf('bti_') === 0) continue;
    var label = '';
    try {
        if (id) {
            var l = document.querySelector('label[for="' + id + '"]');
            if (l) label = (l.textContent || '').trim();
        }
        if (!label && el.closest) {
            var td = el.closest('td');
            if (td && td.previousElementSibling) {
                label = (td.previousElementSibling.textContent || '').trim();
            }
        }
    } catch (e) {}
    out.push({
        id: id,
        name: name,
        tag: el.tagName,
        type: el.type || '',
        label: (label || el.title || el.placeholder || '').substring(0, 80),
        value: String(el.value || '').substring(0, 120)
    });
}
return out;
"""

_JS_BODY_TEXT = "return document.body ? document.body.innerText.substring(0, 20000) : '';"


def _dump_context(browser) -> tuple[list[dict], str]:
    """Campi form + testo pagina del contesto corrente."""
    fields = browser.execute_js(_JS_DUMP_FIELDS) or []
    body = browser.execute_js(_JS_BODY_TEXT) or ""
    return fields, body


def _dump_page(browser) -> dict:
    """Scansiona documento principale + tutti i frame della pagina corrente."""
    browser.switch_to_default()
    fields, body = _dump_context(browser)
    all_fields = [dict(f, frame="main") for f in fields]
    texts = [body]

    try:
        frame_count = browser.get_frame_count()
    except Exception:
        frame_count = 0

    for i in range(frame_count):
        try:
            browser.switch_to_default()
            browser.switch_to_frame(i)
            fields, body = _dump_context(browser)
            all_fields.extend(dict(f, frame=f"frame_{i}") for f in fields)
            texts.append(body)
        except Exception:
            continue

    browser.switch_to_default()

    # Candidati telefono: nei valori dei campi e nel testo delle pagine
    candidates = []
    for f in all_fields:
        if f.get("value") and RE_PHONE.search(f["value"]):
            candidates.append({"tipo": "campo", **f})
    for text in texts:
        for m in RE_PHONE.finditer(text):
            start = max(0, m.start() - 60)
            candidates.append({
                "tipo": "testo",
                "numero": m.group(0),
                "contesto": text[start:m.end() + 20].replace("\n", " ").strip(),
            })

    return {"fields": all_fields, "phone_candidates": candidates}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dump campi perizia Prelios")
    parser.add_argument("codice", help="Codice perizia (es. 826361)")
    parser.add_argument("--page", action="append", default=[],
                        help="Nome pagina da visitare e scansionare (ripetibile)")
    parser.add_argument("--out", default=None, help="File JSON di output")
    args = parser.parse_args(argv)

    out_path = Path(args.out or f"campi_{args.codice}.json")

    try:
        tools = _import_pipeline()
        ctx = _crea_contesto()
    except PipelineNonDisponibile as e:
        print(f"ERRORE: pipeline MISI non disponibile: {e}", file=sys.stderr)
        print("Copiare questo file dentro il progetto MISI ISP (accanto a "
              "run_giro.py) ed eseguirlo da li'.", file=sys.stderr)
        return 1

    ctx.data.perizia_code = args.codice

    for name in ("LoginTool", "SearchPeriziaTool", "OpenPeriziaTool"):
        result = _run_tool(ctx, tools[name])
        if not getattr(result, "success", False):
            print(f"ERRORE {name}: {getattr(result, 'message', '?')}", file=sys.stderr)
            return 1
        _merge_result(ctx, result)

    browser = ctx.browser
    report: dict = {"perizia": args.codice, "dumps": {}}

    # Pagine di menu disponibili (utile per scegliere i --page dei run successivi)
    browser.switch_to_default()
    try:
        report["pagine_menu"] = browser.execute_js(_JS_MENU_PAGES) or []
    except Exception:
        report["pagine_menu"] = []

    # Pagina corrente (quella su cui atterra l'apertura perizia)
    report["dumps"]["_pagina_corrente"] = _dump_page(browser)

    # Pagine richieste esplicitamente. navigate_and_wait vive su BaseTool:
    # istanziamo un tool leggero solo per riusarne la navigazione.
    if args.page:
        from tools.base_tool import BaseTool  # import qui: esiste solo nel progetto MISI
        from models import ToolResult

        class _NavTool(BaseTool):
            name = "Dump campi"
            tool_id = "t99_dump_fields"
            description = "Navigazione diagnostica"
            phase = 3

            def validate_preconditions(self):
                return True, ""

            def execute(self):
                return ToolResult(True, "n/a")

        nav = _NavTool(ctx)
        for page_name in args.page:
            print(f"Navigazione a '{page_name}'...")
            nav.navigate_and_wait(page_name)
            report["dumps"][page_name] = _dump_page(browser)

    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    n_fields = sum(len(d["fields"]) for d in report["dumps"].values())
    n_cand = sum(len(d["phone_candidates"]) for d in report["dumps"].values())
    print(f"\nScritto {out_path} — {n_fields} campi, {n_cand} candidati telefono, "
          f"{len(report['pagine_menu'])} voci di menu.")
    if n_cand:
        print("Candidati telefono trovati:")
        for d_name, d in report["dumps"].items():
            for c in d["phone_candidates"][:10]:
                where = c.get("id") or c.get("contesto", "")
                print(f"  [{d_name}] {c.get('numero', c.get('value', ''))} <- {where}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
