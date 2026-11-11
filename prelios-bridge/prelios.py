"""Operazioni Prelios VT-Desktop, autonome dal progetto MISI.

Login (con MFA manuale), ricerca perizia per codice, apertura e lettura del
telefono cliente. La logica e gli snippet JS sono ripresi dalla pipeline MISI
(t01_login, t02_search_perizia, t03_open_perizia, js_commands) ma qui vivono
in forma indipendente: nessun import del progetto MISI.
"""

from __future__ import annotations

from browser import PreliosBrowser
from contact_parse import analizza_nota_gestore, estrai_telefoni

PRELIOS_URL = "https://perizie.prelios.com/VTSSO/"

# ---------------------------------------------------------------------------
# LOGIN
# ---------------------------------------------------------------------------

_JS_HAS_VT = ("try { return (typeof wsTbs !== 'undefined' && wsTbs !== null); }"
              " catch(e) { return false; }")
_JS_VT_LINK = """
var links = document.querySelectorAll('a');
for (var i = 0; i < links.length; i++) {
    if (links[i].textContent.indexOf('VT-Desktop') !== -1) return true;
}
return false;
"""
_JS_CLICK_VT = """
var links = document.querySelectorAll('a');
for (var i = 0; i < links.length; i++) {
    if (links[i].textContent.indexOf('VT-Desktop') !== -1) { links[i].click(); break; }
}
"""


def is_logged_in(browser: PreliosBrowser) -> bool:
    """True se il VT-Desktop risulta attivo (stesso segnale usato da login:
    `wsTbs` presente e URL su perizie.prelios.com). Non naviga e non solleva:
    qualunque errore (browser chiuso, pagina in caricamento) vale False."""
    try:
        browser.switch_to_default()
        return bool(browser.execute_js(_JS_HAS_VT)) and \
            "perizie.prelios.com" in (browser.current_url or "")
    except Exception:
        return False


def login(browser: PreliosBrowser, wait_seconds: int = 240, poll: int = 3,
          log=print, navigate: bool = True) -> bool:
    """Naviga a Prelios e attende il login manuale (MFA/SSO).

    Il segnale di 'desktop pronto' è la presenza di `wsTbs`. Ritorna True se il
    VT-Desktop è attivo entro wait_seconds.

    navigate=False: non ricarica la pagina di Prelios (usato dalla modalità
    servizio mentre aspetta un nuovo login, per non interrompere l'operatore
    a metà MFA).
    """
    if navigate:
        log("Navigazione a Prelios...")
        browser.navigate(PRELIOS_URL)
        browser.wait(3)

    def safe(js):
        try:
            return browser.execute_js(js)
        except Exception:
            return False

    announced = False
    for _ in range(max(1, wait_seconds // poll)):
        if safe(_JS_HAS_VT) and "perizie.prelios.com" in (browser.current_url or ""):
            log("Login completato — VT-Desktop attivo")
            browser.wait(2)
            return True
        if safe(_JS_VT_LINK):
            log("Pagina di benvenuto — apro il VT-Desktop...")
            safe(_JS_CLICK_VT)
            browser.wait(5)
            continue
        if not announced:
            log("In attesa del login manuale (completa MFA/SSO nella finestra)...")
            announced = True
        browser.wait(poll)

    return False


# ---------------------------------------------------------------------------
# RICERCA PERIZIA
# ---------------------------------------------------------------------------

_JS_NAV_ELENCO_1 = """
var inputs = document.querySelectorAll('input[type="text"]');
for (var i = 0; i < inputs.length; i++) {
    var val = inputs[i].value || '';
    if (val.indexOf('Anpl_Immobili_Fast') > -1) {
        var m = val.match(/XmlForm:(\\S+)\\s+Mnu:(\\S+)\\s+Mnu2:(\\S*)\\s+Mid:(\\S+)/);
        if (m) { wsTbs.Url(m[1], m[2], m[3], m[4], null); return 'navigated'; }
    }
}
return 'not_found';
"""
_JS_NAV_ELENCO_2 = "wsTbs.Url('Anpl_Immobili_Fast_Vl','Find_Fast_','','5.206',null);"


def _apri_elenco_perizie(browser: PreliosBrowser, log=print) -> None:
    """Porta il VT-Desktop sull'Elenco Perizie (link del menu, con ripiego
    sull'URL interno noto)."""
    log("Navigazione a Elenco Perizie...")
    if browser.execute_js(_JS_NAV_ELENCO_1) != "navigated":
        browser.execute_js(_JS_NAV_ELENCO_2)
    browser.wait(4)


def _imposta_filtro_codice(browser: PreliosBrowser, code: str) -> str:
    """Scrive `code` nel filtro Cod. Immobile (campo Imm_ky, con ripiego sul
    primo campo testo in alto). '' svuota il filtro. Ritorna l'id/nome del
    campo usato, oppure 'not_found'."""
    return browser.execute_js(f"""
        var el = document.getElementById('Imm_ky') || document.querySelector('input[name="Imm_ky"]');
        if (!el) {{
            var ins = document.querySelectorAll('input[type="text"]');
            for (var i = 0; i < ins.length; i++) {{
                var r = ins[i].getBoundingClientRect();
                if (r.width > 50 && r.height > 10 && r.top > 60 && r.top < 200) {{ el = ins[i]; break; }}
            }}
        }}
        if (el) {{
            el.value = '{code}';
            el.dispatchEvent(new Event('change', {{bubbles: true}}));
            el.dispatchEvent(new Event('input', {{bubbles: true}}));
            return el.id || el.name || 'found';
        }}
        return 'not_found';
    """)


def search_perizia(browser: PreliosBrowser, code: str, log=print) -> bool:
    """Apre l'elenco perizie, filtra per Cod. Immobile e verifica che la riga
    compaia nella griglia. Ritorna True se trovata (e non in stato EL)."""
    _apri_elenco_perizie(browser, log)

    field = _imposta_filtro_codice(browser, code)
    if field == "not_found":
        log(f"Campo Cod. Immobile non trovato per {code}")
        return False

    browser.execute_js("cmdFindClick();")

    code_np = code.replace(".", "").replace(" ", "")
    check = f"""
        var t1 = '{code}'.replace(/\\s+/g, '');
        var t2 = '{code_np}'.replace(/\\s+/g, '');
        var tds = document.querySelectorAll('td');
        for (var i = 0; i < tds.length; i++) {{
            var x = (tds[i].textContent || '').replace(/\\s+/g, '');
            if (x === t1 || x === t2) return true;
        }}
        return false;
    """
    for _ in range(15):
        browser.wait(1)
        if browser.execute_js(check):
            return True
    log(f"Perizia {code} non trovata nell'elenco")
    return False


# ---------------------------------------------------------------------------
# APERTURA PERIZIA (singolo click)
# ---------------------------------------------------------------------------

def _fmt(code: str) -> str:
    code = code.replace(".", "").replace(" ", "")
    return f"{code[:-3]}.{code[-3:]}" if len(code) > 3 else code


def open_perizia(browser: PreliosBrowser, code: str, user_id: str, log=print) -> bool:
    """Apre la perizia con singolo click (mouseClickObj). MAI doppio click."""
    code_np = code.replace(".", "").replace(" ", "")

    def click(target: str) -> bool:
        return bool(browser.execute_js(f"""
            var tds = document.querySelectorAll('td');
            var row = null;
            for (var i = 0; i < tds.length; i++) {{
                if (tds[i].textContent.trim() === '{target}') {{ row = tds[i].closest('tr'); break; }}
            }}
            if (row) {{ mouseClickObj(row, '{code_np}.{user_id}'); return true; }}
            return false;
        """))

    ok = click(code) or click(_fmt(code)) or (code_np != code and click(code_np))
    if not ok:
        log(f"Riga perizia {code} non trovata nella griglia")
        return False
    browser.wait(4)
    return True


# ---------------------------------------------------------------------------
# ESTRAZIONE TELEFONO
# ---------------------------------------------------------------------------

_FIELD_NOTE_GESTORE = "Imm_Descrizione"   # Note del Gestore Intesa
_FIELD_NOTE_PERITO = "Imm_Note"           # Note interne per il perito
_JS_NAV_ANAGRAFICA = "wsTbs.Url('Anpl_Immobili_Ed_ISP','ISPVL_','','5.284',null);"


def _run_everywhere(browser: PreliosBrowser, js: str):
    """Esegue il JS nel documento e in ogni frame; primo risultato non-nullo."""
    browser.switch_to_default()
    try:
        v = browser.execute_js(js)
        if v is not None:
            return v
    except Exception:
        pass
    try:
        n = browser.get_frame_count()
    except Exception:
        n = 0
    for i in range(n):
        try:
            browser.switch_to_default()
            browser.switch_to_frame(i)
            v = browser.execute_js(js)
            if v is not None:
                browser.switch_to_default()
                return v
        except Exception:
            continue
    browser.switch_to_default()
    return None


def _read_by_id(browser: PreliosBrowser, field_id: str):
    return _run_everywhere(
        browser, f"var el = document.getElementById('{field_id}'); "
                 f"return el ? (el.value || '') : null;"
    )


def _read_by_label(browser: PreliosBrowser, label: str):
    js = """
var target = '%s';
var tds = document.querySelectorAll('td, th');
for (var i = 0; i < tds.length; i++) {
    var t = (tds[i].textContent || '').trim().toLowerCase();
    if (t.length < 40 && t.indexOf(target) > -1) {
        var next = tds[i].nextElementSibling;
        if (next) {
            var inp = next.querySelector('input, textarea');
            if (inp) return inp.value || '';
            var v = (next.textContent || '').trim();
            if (v) return v;
        }
    }
}
return null;
""" % label.lower()
    return _run_everywhere(browser, js)


def extract_phone(browser: PreliosBrowser, log=print) -> tuple[str, str]:
    """Legge il telefono del cliente dalla pagina Anagrafica Perizia.

    Priorità: Note del Gestore (Imm_Descrizione, cellulare) → Telefono
    Mutuatario → Note perito (Imm_Note) → Telefono Richiedente. I campi NTM
    sono ignorati (referenti tecnici, non il cliente).

    Returns:
        (telefono normalizzato +39, nota_contatto) — telefono '' se assente.
    """
    try:
        browser.switch_to_default()
        browser.execute_js(_JS_NAV_ANAGRAFICA)
        browser.wait(3)
    except Exception as e:
        log(f"Navigazione anagrafica non riuscita ({e}); leggo la pagina corrente")

    nota_gestore = _read_by_id(browser, _FIELD_NOTE_GESTORE) or ""
    nota_perito = _read_by_id(browser, _FIELD_NOTE_PERITO) or ""
    tel_mutuatario = _read_by_label(browser, "telefono mutuatario") or ""
    tel_richiedente = _read_by_label(browser, "telefono richiedente") or ""

    gestore = analizza_nota_gestore(nota_gestore)
    perito = analizza_nota_gestore(nota_perito)

    scelte: list[tuple[str, str, str]] = []
    scelte += [(t["numero"], t["tipo"], "note_gestore") for t in gestore["telefoni"]]
    scelte += [(t["numero"], t["tipo"], "telefono_mutuatario") for t in estrai_telefoni(tel_mutuatario)]
    scelte += [(t["numero"], t["tipo"], "note_perito") for t in perito["telefoni"]]
    scelte += [(t["numero"], t["tipo"], "telefono_richiedente") for t in estrai_telefoni(tel_richiedente)]

    priorita = [
        lambda n, t, f: f == "note_gestore" and t == "mobile",
        lambda n, t, f: f == "telefono_mutuatario",
        lambda n, t, f: f == "note_perito" and t == "mobile",
        lambda n, t, f: f == "note_gestore",
        lambda n, t, f: f == "note_perito",
        lambda n, t, f: f == "telefono_richiedente",
    ]
    telefono = ""
    for regola in priorita:
        m = next(((n, t, f) for n, t, f in scelte if regola(n, t, f)), None)
        if m:
            telefono = m[0]
            break

    nota_contatto = (nota_gestore or nota_perito).strip()[:300]
    return telefono, nota_contatto


# ---------------------------------------------------------------------------
# ELENCO PRATICHE ASSEGNATE (lettura automatica della griglia, BEST-EFFORT)
# ---------------------------------------------------------------------------
#
# NON verificato sul portale reale: si assume che l'Elenco Perizie col filtro
# Cod. Immobile vuoto mostri le pratiche assegnate e che le colonne della
# griglia siano le stesse dell'export Excel (ancora sulla cella Tipologia).
# Se qualcosa non torna: `python dump_elenco.py` salva la griglia grezza.

# Righe della griglia: per ogni <tr> i testi delle celle DIRETTE. Le righe che
# contengono tabelle annidate (layout) sono saltate e contate a parte.
_JS_GRID_ROWS = """
var out = {rows: [], layout_rows: 0, tables: document.querySelectorAll('table').length};
var trs = document.querySelectorAll('tr');
for (var i = 0; i < trs.length && out.rows.length < 3000; i++) {
    var tr = trs[i];
    if (tr.querySelector('table')) { out.layout_rows++; continue; }
    var cells = [];
    for (var j = 0; j < tr.cells.length; j++) {
        var t = (tr.cells[j].innerText || tr.cells[j].textContent || '');
        cells.push(t.replace(/\\s+/g, ' ').trim().substring(0, 500));
    }
    if (cells.length) out.rows.push(cells);
}
return out;
"""

# Controlli "pagina successiva": SOLO testi/titoli inequivocabili. Il '»' e il
# '>>' NON sono inclusi (spesso significano "ultima pagina").
# Con argomento 'click' clicca il controllo SOLO se in quel documento ce n'è
# esattamente uno.
_JS_FIND_NEXT = """
var re = /^(pagina\\s+successiva|successiva|succ\\.?|next|next\\s+page|>|\\u203a)$/i;
var sel = 'a, button, input[type="button"], input[type="submit"], input[type="image"], img, span, td, div';
var els = document.querySelectorAll(sel);
var found = [];
for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var clickable = el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'INPUT'
                    || el.onclick || el.getAttribute('onclick');
    if (!clickable) continue;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (el.disabled) continue;
    var labels = [(el.innerText || '').trim(), (el.value || '').trim(),
                  (el.title || '').trim(), (el.getAttribute('alt') || '').trim(),
                  (el.getAttribute('aria-label') || '').trim()];
    for (var k = 0; k < labels.length; k++) {
        if (labels[k] && labels[k].length < 30 && re.test(labels[k])) {
            found.push({el: el, tag: el.tagName, text: labels[k]}); break;
        }
    }
}
if (arguments.length && arguments[0] === 'click') {
    if (found.length === 1) { found[0].el.click(); return 'clicked'; }
    return 'skip';
}
return found.map(function(f) { return {tag: f.tag, text: f.text}; });
"""

MAX_PAGINE = 20


def _collect_everywhere(browser: PreliosBrowser, js: str, *args) -> list[tuple[str, object]]:
    """Esegue il JS nel documento E in ogni frame; ritorna TUTTI i risultati
    come [(origine, valore)] (a differenza di _run_everywhere che si ferma al
    primo non-nullo). Gli errori su un singolo frame sono ignorati."""
    risultati: list[tuple[str, object]] = []
    try:
        browser.switch_to_default()
        risultati.append(("main", browser.execute_js(js, *args)))
    except Exception:
        pass
    try:
        browser.switch_to_default()
        n = browser.get_frame_count()
    except Exception:
        n = 0
    for i in range(n):
        try:
            browser.switch_to_default()
            browser.switch_to_frame(i)
            risultati.append((f"frame_{i}", browser.execute_js(js, *args)))
        except Exception:
            continue
    try:
        browser.switch_to_default()
    except Exception:
        pass
    return risultati


def read_grid(browser: PreliosBrowser) -> dict:
    """Legge tutte le righe <tr> di documento e frame.

    Returns:
        {"rows": [[celle...], ...] (tutte le origini concatenate),
         "frames": [{"origine", "righe", "righe_layout", "tabelle"}],
         "frame_count": numero di frame letti (escluso il documento)}
    """
    rows: list[list[str]] = []
    frames: list[dict] = []
    for origine, val in _collect_everywhere(browser, _JS_GRID_ROWS):
        if not isinstance(val, dict):
            continue
        righe = [[str(c) for c in r] for r in (val.get("rows") or []) if isinstance(r, list)]
        rows.extend(righe)
        frames.append({"origine": origine, "righe": len(righe),
                       "righe_layout": val.get("layout_rows", 0),
                       "tabelle": val.get("tables", 0)})
    return {"rows": rows, "frames": frames,
            "frame_count": sum(1 for f in frames if f["origine"] != "main")}


def find_next_controls(browser: PreliosBrowser) -> list[dict]:
    """Candidati 'pagina successiva' in documento e frame (anche diagnostica)."""
    out: list[dict] = []
    for origine, val in _collect_everywhere(browser, _JS_FIND_NEXT):
        if isinstance(val, list):
            out.extend(dict(c, origine=origine) for c in val if isinstance(c, dict))
    return out


def _conta_righe_tipologia(rows: list[list[str]]) -> int:
    from excel_pratiche import _trova_colonna_tipologia
    return sum(1 for r in rows if _trova_colonna_tipologia(r) >= 0)


def attendi_griglia(browser: PreliosBrowser, max_secondi: int = 20) -> dict:
    """Attende che la griglia si stabilizzi: stesso numero (>0) di righe con
    tipologia per due letture consecutive, o tempo scaduto."""
    ultimo = -1
    griglia: dict = {"rows": [], "frames": [], "frame_count": 0}
    for _ in range(max_secondi):
        browser.wait(1)
        griglia = read_grid(browser)
        n = _conta_righe_tipologia(griglia["rows"])
        if n > 0 and n == ultimo:
            break
        ultimo = n
    return griglia


def apri_elenco_completo(browser: PreliosBrowser, log=print) -> bool:
    """Elenco Perizie con filtro Cod. Immobile vuoto + ricerca. Ritorna False
    se il campo filtro non è stato trovato (la ricerca viene lanciata
    comunque: il filtro potrebbe essere già vuoto)."""
    browser.switch_to_default()
    _apri_elenco_perizie(browser, log)
    campo = _imposta_filtro_codice(browser, "")
    if campo == "not_found":
        log("ATTENZIONE: campo filtro Cod. Immobile (Imm_ky) non trovato: "
            "lancio la ricerca con i filtri correnti.")
    elif campo != "Imm_ky":
        log(f"ATTENZIONE: filtro Imm_ky non trovato, svuotato il campo di "
            f"ripiego '{campo}': verificare l'elenco con dump_elenco.py.")
    browser.execute_js("cmdFindClick();")
    return campo != "not_found"


def list_assigned(browser: PreliosBrowser, log=print,
                  max_pagine: int = MAX_PAGINE) -> list[list[str]]:
    """Legge dal portale le righe GREZZE dell'elenco pratiche (BEST-EFFORT).

    Naviga all'Elenco Perizie, svuota il filtro Cod. Immobile, esegue
    cmdFindClick() e raccoglie da documento e frame tutte le righe <tr> come
    liste di testi. Le righe vanno passate a excel_pratiche.parse_grid_rows
    (stesso parser ad ancora-Tipologia dei file, filtro FULL - Acquisto,
    dedup sul codice).

    Paginazione: segue un controllo "pagina successiva" SOLO se ne esiste
    esattamente uno riconoscibile, fino a `max_pagine`; si ferma appena una
    pagina non porta righe nuove. Altrimenti legge solo la pagina corrente e
    lo scrive chiaramente nel log.
    """
    apri_elenco_completo(browser, log)
    griglia = attendi_griglia(browser)
    righe: list[list[str]] = list(griglia["rows"])
    firme = {tuple(r) for r in righe}
    log(f"Elenco: lette {len(righe)} righe grezze da {len(griglia['frames'])} "
        f"documenti/frame ({_conta_righe_tipologia(righe)} con tipologia).")

    candidati = find_next_controls(browser)
    if len(candidati) != 1:
        motivo = ("nessun controllo 'pagina successiva' riconosciuto"
                  if not candidati else
                  f"{len(candidati)} controlli candidati: ambiguo, non clicco")
        log(f"ATTENZIONE: paginazione NON verificata ({motivo}): letta solo "
            "la pagina corrente. Se le pratiche stanno su più pagine, "
            "controllare con dump_elenco.py.")
        return righe

    pagine = 1
    while pagine < max_pagine:
        cliccato = any(esito == "clicked" for _o, esito in
                       _collect_everywhere(browser, _JS_FIND_NEXT, "click"))
        if not cliccato:
            break
        griglia = attendi_griglia(browser)
        nuove = [r for r in griglia["rows"] if tuple(r) not in firme]
        if not _conta_righe_tipologia(nuove):
            break  # nessuna riga nuova: era l'ultima pagina
        pagine += 1
        righe.extend(nuove)
        firme.update(tuple(r) for r in nuove)
        if len(find_next_controls(browser)) != 1:
            break
    log(f"Paginazione (NON verificata sul portale reale): lette {pagine} "
        f"pagine, {len(righe)} righe grezze in totale."
        + (f" Raggiunto il tetto di {max_pagine} pagine." if pagine >= max_pagine else ""))
    return righe
