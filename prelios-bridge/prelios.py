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


def login(browser: PreliosBrowser, wait_seconds: int = 240, poll: int = 3,
          log=print) -> bool:
    """Naviga a Prelios e attende il login manuale (MFA/SSO).

    Il segnale di 'desktop pronto' è la presenza di `wsTbs`. Ritorna True se il
    VT-Desktop è attivo entro wait_seconds.
    """
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


def search_perizia(browser: PreliosBrowser, code: str, log=print) -> bool:
    """Apre l'elenco perizie, filtra per Cod. Immobile e verifica che la riga
    compaia nella griglia. Ritorna True se trovata (e non in stato EL)."""
    log("Navigazione a Elenco Perizie...")
    if browser.execute_js(_JS_NAV_ELENCO_1) != "navigated":
        browser.execute_js(_JS_NAV_ELENCO_2)
    browser.wait(4)

    field = browser.execute_js(f"""
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
