"""Diagnostico AUTONOMO: mappa i campi di una perizia Prelios aperta.

Serve se qualche perizia avesse il telefono in un punto diverso dal solito:
apre una perizia e scrive un JSON con tutti i campi form (id, etichetta,
valore) di documento e frame, più i candidati telefono trovati.

NON dipende da MISI. USO (nella cartella del bridge):
    python dump_perizia_fields.py 826361
    python dump_perizia_fields.py 826361 --out campi_826361.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from browser import PreliosBrowser
import prelios

RE_PHONE = re.compile(
    r"\b(?:(?:\+|00)39[\s.]?)?(?:3\d{2}(?:[\s./-]?\d{3}){2}\d?|0\d{1,3}[\s./-]?\d{5,8})\b"
)

_JS_DUMP_FIELDS = """
var out = [];
var els = document.querySelectorAll('input, select, textarea');
for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var id = el.id || '';
    var name = el.name || '';
    if (!id && !name) continue;
    var label = '';
    try {
        var td = el.closest ? el.closest('td') : null;
        if (td && td.previousElementSibling) label = (td.previousElementSibling.textContent || '').trim();
    } catch (e) {}
    out.push({
        id: id, name: name, tag: el.tagName, type: el.type || '',
        label: (label || el.title || '').substring(0, 80),
        value: String(el.value || '').substring(0, 120)
    });
}
return out;
"""

_JS_BODY = "return document.body ? document.body.innerText.substring(0, 20000) : '';"


def _dump_page(browser: PreliosBrowser) -> dict:
    browser.switch_to_default()
    all_fields = [dict(f, frame="main") for f in (browser.execute_js(_JS_DUMP_FIELDS) or [])]
    texts = [browser.execute_js(_JS_BODY) or ""]

    try:
        frame_count = browser.get_frame_count()
    except Exception:
        frame_count = 0
    for i in range(frame_count):
        try:
            browser.switch_to_default()
            browser.switch_to_frame(i)
            all_fields.extend(dict(f, frame=f"frame_{i}")
                              for f in (browser.execute_js(_JS_DUMP_FIELDS) or []))
            texts.append(browser.execute_js(_JS_BODY) or "")
        except Exception:
            continue
    browser.switch_to_default()

    candidates = []
    for f in all_fields:
        if f.get("value") and RE_PHONE.search(f["value"]):
            candidates.append({"tipo": "campo", **f})
    for text in texts:
        for m in RE_PHONE.finditer(text):
            start = max(0, m.start() - 60)
            candidates.append({
                "tipo": "testo", "numero": m.group(0),
                "contesto": text[start:m.end() + 20].replace("\n", " ").strip(),
            })
    return {"fields": all_fields, "phone_candidates": candidates}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dump campi perizia Prelios (autonomo)")
    parser.add_argument("codice", help="Codice perizia (es. 826361)")
    parser.add_argument("--out", default=None, help="File JSON di output")
    parser.add_argument("--user-id", default="8468", help="User ID Prelios")
    args = parser.parse_args(argv)

    out_path = Path(args.out or f"campi_{args.codice}.json")

    browser = PreliosBrowser()
    try:
        browser.start()
    except Exception as e:
        print(f"ERRORE avvio browser: {e}", file=sys.stderr)
        return 1

    try:
        if not prelios.login(browser):
            print("ERRORE: login non completato.", file=sys.stderr)
            return 1
        if not prelios.search_perizia(browser, args.codice):
            print(f"ERRORE: perizia {args.codice} non trovata.", file=sys.stderr)
            return 1
        if not prelios.open_perizia(browser, args.codice, args.user_id):
            print(f"ERRORE: apertura perizia {args.codice} fallita.", file=sys.stderr)
            return 1

        # Prova a portarsi sulla pagina Anagrafica prima del dump
        try:
            browser.switch_to_default()
            browser.execute_js("wsTbs.Url('Anpl_Immobili_Ed_ISP','ISPVL_','','5.284',null);")
            browser.wait(3)
        except Exception:
            pass

        report = {"perizia": args.codice, "dump": _dump_page(browser)}
        out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

        d = report["dump"]
        print(f"\nScritto {out_path} — {len(d['fields'])} campi, "
              f"{len(d['phone_candidates'])} candidati telefono.")
        for c in d["phone_candidates"][:15]:
            where = c.get("id") or c.get("contesto", "")
            print(f"  {c.get('numero', c.get('value', ''))} <- {where}")
        return 0
    finally:
        browser.stop()


if __name__ == "__main__":
    raise SystemExit(main())
