"""Cattura guidata della struttura di un portale (es. Cerved) — AUTONOMO.

Serve a raccogliere, IN SICUREZZA, le informazioni per costruire un nuovo
adapter di portale senza che lo sviluppatore abbia accesso al portale:
1. apre il Chrome dedicato del bridge (stesso di browser.py);
2. l'operatore fa il login e naviga A MANO (il tool non clicca nulla);
3. a ogni INVIO nel terminale salva una "cattura" della pagina corrente:
   URL, titolo e, per il documento e ogni frame (anche annidati, 2 livelli),
   la struttura delle tabelle (intestazioni + righe campione), i campi form
   (id, name, etichetta, valore) e i controlli cliccabili.

Di DEFAULT i dati sono ANONIMIZZATI (lettere → x, cifre → 9, punteggiatura e
lunghezze preservate: vedi anonimizza.py): le catture mostrano la struttura
ma non nomi/telefoni/indirizzi, e si possono condividere. `--raw` disattiva
l'anonimizzazione (solo per uso locale!).

Output: cartella captures/ (esclusa da git), un JSON per cattura.

USO:
    python capture_portal.py --url https://indirizzo-del-portale
    python capture_portal.py                 # parte da una scheda vuota
    python capture_portal.py --raw           # SENZA anonimizzazione (attenzione)
A ogni richiesta: INVIO = cattura, testo + INVIO = cattura con etichetta
(es. "elenco" o "dettaglio"), q + INVIO = esci.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from anonimizza import anonimizza_cattura

BRIDGE_DIR = Path(__file__).resolve().parent
DEFAULT_OUT_DIR = BRIDGE_DIR / "captures"

# Profondità massima dei frame annidati da esplorare
MAX_PROFONDITA_FRAME = 2

_JS_CATTURA = """
function txt(el) {
    return ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim().substring(0, 200);
}
var out = {url: location.href, titolo: document.title, tabelle: [], campi: [], azioni: []};

var tables = document.querySelectorAll('table');
out.n_tabelle = tables.length;
for (var i = 0; i < tables.length && out.tabelle.length < 60; i++) {
    var t = tables[i];
    var info = {
        indice: i, id: t.id || '', classe: String(t.className || '').substring(0, 80),
        righe: t.rows.length,
        annidata: !!(t.parentElement && t.parentElement.closest && t.parentElement.closest('table')),
        contiene_tabelle: !!t.querySelector('table'),
        intestazioni: [], campione: []
    };
    var ths = t.querySelectorAll('th');
    for (var h = 0; h < ths.length && info.intestazioni.length < 60; h++) {
        if (ths[h].closest('table') === t) info.intestazioni.push(txt(ths[h]).substring(0, 100));
    }
    for (var r = 0; r < t.rows.length && info.campione.length < 15; r++) {
        var row = t.rows[r];
        var celle = [];
        for (var c = 0; c < row.cells.length && c < 40; c++) {
            var cell = row.cells[c];
            celle.push({
                t: cell.querySelector('table') ? '[tabella annidata]' : txt(cell),
                th: cell.tagName === 'TH',
                campo: !!cell.querySelector('input, select, textarea')
            });
        }
        info.campione.push({
            celle: celle, id: row.id || '',
            classe: String(row.className || '').substring(0, 60),
            onclick: String(row.getAttribute('onclick') || '').substring(0, 150)
        });
    }
    out.tabelle.push(info);
}

var els = document.querySelectorAll('input, select, textarea');
for (var k = 0; k < els.length && out.campi.length < 400; k++) {
    var el = els[k];
    if ((el.type || '') === 'hidden' && !el.id && !el.name) continue;
    var label = '', fonte = '', celleRiga = 0;
    try {
        if (el.id) {
            var lab = document.querySelector('label[for="' + el.id + '"]');
            if (lab) { label = txt(lab); fonte = 'label'; }
        }
        if (!label) {
            var td = el.closest ? el.closest('td') : null;
            if (td && td.previousElementSibling) {
                label = txt(td.previousElementSibling); fonte = 'td';
                var trl = td.closest('tr'); celleRiga = trl ? trl.cells.length : 0;
            }
        }
        if (!label && el.title) { label = el.title; fonte = 'title'; }
    } catch (e) {}
    var rr = el.getBoundingClientRect();
    out.campi.push({
        tag: el.tagName, type: el.type || '', id: el.id || '', name: el.name || '',
        label: (label || '').substring(0, 100), label_fonte: fonte, label_celle_riga: celleRiga,
        placeholder: String(el.getAttribute('placeholder') || '').substring(0, 80),
        value: String(el.value || '').substring(0, 200),
        opzioni: el.tagName === 'SELECT' ? el.options.length : null,
        readonly: !!el.readOnly, visibile: rr.width > 0 && rr.height > 0
    });
}

var acts = document.querySelectorAll('a, button, input[type="button"], input[type="submit"], input[type="image"], [onclick]');
for (var a = 0; a < acts.length && out.azioni.length < 300; a++) {
    var ac = acts[a];
    if (ac.tagName === 'TR') continue;  // le righe sono già nel campione tabelle
    var testo = (txt(ac) || ac.value || ac.title || ac.getAttribute('alt') || '') + '';
    out.azioni.push({
        tag: ac.tagName, id: ac.id || '', testo: testo.substring(0, 80),
        href: String(ac.getAttribute('href') || '').substring(0, 150),
        onclick: String(ac.getAttribute('onclick') || '').substring(0, 150),
        in_tabella: !!(ac.closest && ac.closest('td'))
    });
}
out.n_frame = document.querySelectorAll('iframe, frame').length;
return out;
"""


def _entra(browser, percorso: list[int]) -> None:
    browser.switch_to_default()
    for idx in percorso:
        browser.switch_to_frame(idx)


def _cattura_documento(browser, percorso: list[int]) -> dict:
    """Cattura il documento indicato da `percorso` (indici di frame dalla
    radice) e, ricorsivamente, i suoi frame."""
    _entra(browser, percorso)
    try:
        doc = browser.execute_js(_JS_CATTURA) or {}
    except Exception as e:  # noqa: BLE001 — una pagina non leggibile non ferma la cattura
        return {"percorso_frame": percorso, "errore": str(e)[:200]}
    doc["percorso_frame"] = percorso
    doc["frame"] = []
    n = doc.get("n_frame") or 0
    if len(percorso) < MAX_PROFONDITA_FRAME:
        for i in range(n):
            try:
                doc["frame"].append(_cattura_documento(browser, percorso + [i]))
            except Exception as e:  # noqa: BLE001
                doc["frame"].append({"percorso_frame": percorso + [i], "errore": str(e)[:200]})
    return doc


def cattura_pagina(browser) -> dict:
    """Cattura tutte le finestre/schede del Chrome dedicato (l'operatore può
    aver aperto la pratica in una nuova finestra)."""
    driver = browser.driver
    try:
        originale = driver.current_window_handle
    except Exception:
        originale = None
    finestre = []
    for h in list(driver.window_handles):
        try:
            driver.switch_to.window(h)
            finestre.append({"documento": _cattura_documento(browser, [])})
        except Exception as e:  # noqa: BLE001
            finestre.append({"errore": str(e)[:200]})
    if originale:
        try:
            driver.switch_to.window(originale)
            browser.switch_to_default()
        except Exception:
            pass
    return {"quando": datetime.now().isoformat(timespec="seconds"),
            "finestre": finestre}


def _riassunto(doc: dict, livello: int = 0) -> list[str]:
    if "errore" in doc:
        return [f"{'  ' * livello}- frame {doc.get('percorso_frame')}: errore {doc['errore']}"]
    righe = [f"{'  ' * livello}- {doc.get('titolo', '')[:50]!r}: "
             f"{doc.get('n_tabelle', 0)} tabelle, {len(doc.get('campi', []))} campi, "
             f"{len(doc.get('azioni', []))} controlli, {doc.get('n_frame', 0)} frame"]
    for sub in doc.get("frame", []) or []:
        righe += _riassunto(sub, livello + 1)
    return righe


def _nome_file(etichetta: str) -> str:
    base = datetime.now().strftime("cattura_%Y%m%d_%H%M%S")
    pulita = re.sub(r"[^A-Za-z0-9_-]+", "_", etichetta).strip("_")[:40]
    return f"{base}_{pulita}.json" if pulita else f"{base}.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Cattura (anonimizzata) la struttura delle pagine di un portale.")
    parser.add_argument("--url", default=None, help="Pagina da aprire all'avvio")
    parser.add_argument("--raw", action="store_true",
                        help="NON anonimizzare (contiene dati personali: solo uso locale)")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR),
                        help="Cartella delle catture (default: captures/)")
    args = parser.parse_args(argv)

    if args.raw:
        print("ATTENZIONE: --raw attivo. Le catture conterranno DATI PERSONALI "
              "in chiaro (nomi, telefoni, indirizzi): NON condividerle.")

    try:
        from browser import PreliosBrowser
    except ImportError as e:
        print(f"ERRORE: {e}. Installa selenium (pip install selenium).", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    browser = PreliosBrowser()
    try:
        browser.start()
    except Exception as e:  # noqa: BLE001
        print(f"ERRORE avvio browser: {e}", file=sys.stderr)
        return 1

    try:
        if args.url:
            try:
                browser.navigate(args.url)
            except Exception as e:  # noqa: BLE001
                print(f"Navigazione a {args.url} non riuscita ({e}): naviga a mano.")
        print("\nFai il login e naviga A MANO nella finestra Chrome.")
        print("Cattura almeno: l'ELENCO delle pratiche assegnate e il DETTAGLIO "
              "di una pratica (dove stanno telefono/referente).")
        n = 0
        while True:
            try:
                risposta = input("\n[INVIO = cattura | testo+INVIO = cattura con etichetta | q = esci] ")
            except EOFError:
                break
            if risposta.strip().lower() in ("q", "quit", "esci"):
                break
            cattura = cattura_pagina(browser)
            cattura["etichetta"] = risposta.strip()
            if not args.raw:
                cattura = anonimizza_cattura(cattura)
            else:
                cattura["anonimizzata"] = False
            path = out_dir / _nome_file(risposta.strip())
            path.write_text(json.dumps(cattura, indent=2, ensure_ascii=False), encoding="utf-8")
            n += 1
            print(f"Salvata {path}" + ("" if args.raw else " (anonimizzata)"))
            for f in cattura.get("finestre", []):
                if "documento" in f:
                    print("\n".join(_riassunto(f["documento"])))
        print(f"\n{n} catture in {out_dir}.")
        return 0
    finally:
        browser.stop()


if __name__ == "__main__":
    raise SystemExit(main())
