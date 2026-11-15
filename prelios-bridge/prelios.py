"""Operazioni Prelios VT-Desktop, autonome dal progetto MISI.

Login (con MFA manuale), ricerca perizia per codice, apertura e lettura del
telefono cliente. La logica e gli snippet JS sono ripresi dalla pipeline MISI
(t01_login, t02_search_perizia, t03_open_perizia, js_commands) ma qui vivono
in forma indipendente: nessun import del progetto MISI.
"""

from __future__ import annotations

from browser import PreliosBrowser
from contact_parse import analizza_nota_gestore, estrai_telefoni
from excel_pratiche import codice_leggibile

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
        log(f"Campo Cod. Immobile non trovato per {codice_leggibile(code)}")
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
    log(f"Perizia {codice_leggibile(code)} non trovata nell'elenco")
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
        log(f"Riga perizia {codice_leggibile(code)} non trovata nella griglia")
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
# PAGINA DELLA PERIZIA: nota di sospensione e struttura (BEST-EFFORT)
# ---------------------------------------------------------------------------
#
# Dal video del portale: la nota di sospensione sta nella pagina «Sospesi»
# della perizia (voce del menu della perizia). In alto un modulo (Data,
# Stato, Motivo Sospensione, Note, Num Caratteri), sotto una griglia con le
# intestazioni Data | VT | Cognome | Nome | Cellulare | Email | Note |
# ID Imm. | Key | Stato Perizia, righe più recenti in alto.
#
# Dal primo giro sul portale vero (file descrittivo): le voci del menu della
# perizia sono <input> di testo usati come pulsanti, con un onclick; la voce
# «Sospesi» ha onclick wsTbs.Url('Anpl_Immobili_Sospesi_ISP','ISPVL_','',
# '5.208'). Nella stessa pagina ci sono comandi che CAMBIANO LO STATO della
# perizia e non vanno MAI toccati: «Attiva» (Anpl_Immobili_Riattiva_ISP),
# tutti i wsStatoValutazioneButtons.ButAction.* («Sospesa», «Riattiva»,
# «Inoltra Perizia», «Conclusa», «Abbandona», «Accetta», «Rifiuta»...),
# cmdSaveClick() («Salva»), cmdCancelClick() («Canc.»).
#
# NON verificato sul portale reale: che la pagina «Sospesi» si apra così,
# l'attesa della griglia e la sua lettura (intestazioni prese dal video).
#
# Regole: si clicca SOLO l'elemento il cui onclick contiene esattamente il
# codice di pagina Anpl_Immobili_Sospesi_ISP, con un controllo esplicito,
# prima del clic, che l'onclick non contenga nessuno dei comandi vietati;
# se non c'è, la stessa navigazione con la chiamata diretta wsTbs.Url (come
# per l'Anagrafica). Nessuna ricerca per testo, niente scritture nei campi.
# Della griglia si leggono SOLO le colonne «Data» e «Note» (trovate per
# nome): cognome, nome, cellulare ed email di chi ha sospeso non escono mai
# dallo script. Gli script sono FISSI: nessun identificatore preso da fuori
# viene inserito nel JavaScript.

# Etichetta di un campo: <label for>, <label> che lo contiene, testo della
# cella precedente, title/placeholder. Usata dagli script qui sotto.
_JS_ETICHETTA = r"""
function txt(e) {
    try { return ((e && (e.innerText || e.textContent)) || '').replace(/\s+/g, ' ').trim().substring(0, 120); }
    catch (x) { return ''; }
}
function etichettaDi(el) {
    var et = '';
    try {
        if (el.id) {
            var labs = document.getElementsByTagName('label');
            for (var i = 0; i < labs.length; i++) {
                if (labs[i].htmlFor === el.id) { et = txt(labs[i]); break; }
            }
        }
        if (!et && el.closest && el.closest('label')) et = txt(el.closest('label'));
        if (!et && el.closest) {
            var td = el.closest('td');
            var prev = td ? td.previousElementSibling : null;
            if (prev) et = txt(prev);
        }
        if (!et) et = (el.title || el.getAttribute('placeholder') || '').substring(0, 120);
    } catch (x) { }
    return et;
}
function tipoDi(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') return (el.type || 'text').toLowerCase();
    if (tag === 'select') return el.multiple ? 'select-multiple' : 'select';
    return tag;
}
var SALTA = {button: 1, submit: 1, image: 1, reset: 1, file: 1, password: 1};
"""

# Chiamata COMPLETA di un comando (onclick o href javascript:): la prima
# espressione nome(argomenti letterali), es. wsTbs.Url('a','b','','5.284',null).
_JS_CHIAMATA = r"""
var reChiamata = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\((?:[^()'"]|'[^']*'|"[^"]*")*\)/;
function chiamataDi(e) {
    var codice = (e.getAttribute && e.getAttribute('onclick')) || '';
    var href = (e.getAttribute && e.getAttribute('href')) || '';
    if (!codice && href.toLowerCase().indexOf('javascript:') === 0) codice = href.substring(11);
    if (!codice) return '';
    var m = reChiamata.exec(codice);
    return (m ? m[0] : codice).replace(/\s+/g, ' ').trim().substring(0, 200);
}
"""

# Codice della pagina «Sospesi» della perizia e comandi che non si devono
# MAI cliccare (cambiano lo stato della perizia o salvano/cancellano).
PAGINA_SOSPESI = "Anpl_Immobili_Sospesi_ISP"
COMANDI_VIETATI = ("Riattiva", "wsStatoValutazioneButtons", "cmdSaveClick", "cmdCancelClick")

# Clic sulla voce del menu della perizia il cui onclick contiene ESATTAMENTE
# il codice di pagina 'Anpl_Immobili_Sospesi_ISP' (fra apici: non un codice
# più lungo). Fra più elementi preferisce uno visibile. Prima del clic
# ricontrolla che l'onclick NON contenga nessuno dei comandi vietati.
# Ritorna 'clicked', oppure null se in questo documento non c'è.
_JS_CLICCA_SOSPESI = r"""
var VIETATI = ['Riattiva', 'wsStatoValutazioneButtons', 'cmdSaveClick', 'cmdCancelClick'];
var reSospesi = /['"]Anpl_Immobili_Sospesi_ISP['"]/;
function permesso(codice) {
    if (!reSospesi.test(codice)) return false;
    for (var v = 0; v < VIETATI.length; v++) { if (codice.indexOf(VIETATI[v]) >= 0) return false; }
    return true;
}
var els = document.querySelectorAll('[onclick]');
var scelto = null, visibile = false;
for (var i = 0; i < els.length; i++) {
    var codice = els[i].getAttribute('onclick') || '';
    if (!permesso(codice)) continue;
    var r = els[i].getBoundingClientRect();
    var vis = r.width > 0 && r.height > 0;
    if (!scelto || (vis && !visibile)) { scelto = els[i]; visibile = vis; }
}
if (!scelto) return null;
if (!permesso(scelto.getAttribute('onclick') || '')) return null;   // controllo esplicito
scelto.click();
return 'clicked';
"""

# Ripiego se la voce non c'è: la stessa navigazione chiamata direttamente
# (stessa forma usata per l'Anagrafica). Null se wsTbs non c'è.
_JS_NAV_SOSPESI = r"""
if (typeof wsTbs === 'undefined' || !wsTbs || typeof wsTbs.Url !== 'function') return null;
wsTbs.Url('Anpl_Immobili_Sospesi_ISP','ISPVL_','','5.208',null);
return 'chiamata';
"""

# Come si è arrivati alla pagina «Sospesi» (per il log e la descrizione)
ARRIVO_CLIC = "clic"
ARRIVO_CHIAMATA = "chiamata diretta"

# Griglia della pagina «Sospesi»: la riga di intestazione con le celle
# «Data», «Note» e «Stato Perizia». Le righe dati sono TUTTE le righe del
# documento con lo stesso numero di celle, in qualunque tabella (la griglia
# wsGrid può disegnare la testata in una tabella e le righe in un'altra),
# escluse le righe di intestazione e quelle con tabelle annidate, nell'ordine
# del documento; di ognuna si leggono SOLO «Data» e «Note». In più la voce
# scelta del menu «Motivo Sospensione» (se non vuota). Null se la griglia
# non c'è.
_JS_GRIGLIA_SOSPESI = _JS_ETICHETTA + r"""
function norm(s) { return (s || '').toLowerCase().replace(/[.:]/g, ' ').replace(/\s+/g, ' ').trim(); }
function nomiDi(tr) {
    var nomi = [];
    for (var c = 0; c < tr.cells.length; c++) nomi.push(norm(txt(tr.cells[c])));
    return nomi;
}
function eIntestazione(nomi) {
    return nomi.indexOf('data') >= 0 && nomi.indexOf('note') >= 0 && nomi.indexOf('stato perizia') >= 0;
}
var out = {griglia: false, righe: [], motivo: ''};
try {
    var sels = document.querySelectorAll('select');
    for (var s = 0; s < sels.length; s++) {
        var chiave = norm(etichettaDi(sels[s]) + ' ' + (sels[s].id || '') + ' ' + (sels[s].getAttribute('name') || ''));
        if (chiave.indexOf('motivo') < 0) continue;
        var i0 = sels[s].selectedIndex;
        var voce = i0 >= 0 ? txt(sels[s].options[i0]) : '';
        if (voce) { out.motivo = voce; break; }
    }
} catch (e) { }
var trs = document.querySelectorAll('tr');
var testata = null;
for (var r = 0; r < trs.length && !testata; r++) {
    if (!trs[r].cells || !trs[r].cells.length || trs[r].querySelector('table')) continue;
    var n0 = nomiDi(trs[r]);
    if (eIntestazione(n0)) testata = {nomi: n0, tr: trs[r]};
}
if (testata) {
    out.griglia = true;
    var nCelle = testata.nomi.length;
    var iData = testata.nomi.indexOf('data'), iNote = testata.nomi.indexOf('note');
    for (var d = 0; d < trs.length && out.righe.length < 50; d++) {
        var tr = trs[d];
        if (tr === testata.tr || !tr.cells || tr.cells.length !== nCelle || tr.querySelector('table')) continue;
        var tutteTh = true;
        for (var h = 0; h < tr.cells.length; h++) { if (tr.cells[h].tagName !== 'TH') { tutteTh = false; break; } }
        if (tutteTh || eIntestazione(nomiDi(tr))) continue;   // altre righe di intestazione
        var cells = tr.cells;
        var nota = ((cells[iNote].innerText || cells[iNote].textContent || '') + '').replace(/\s+/g, ' ').trim();
        out.righe.push({data: txt(cells[iData]).substring(0, 40), note: nota.substring(0, 2000)});
    }
}
return (out.griglia || out.motivo) ? out : null;
"""

# Struttura della pagina della perizia, SOLO LETTURA e SENZA valori: per ogni
# campo id, name, tipo, etichetta, se è vuoto; per i menu a tendina le voci
# (Python decide se scriverle in chiaro); per i campi con «sosp» la lunghezza
# del valore (mai il valore). "voci_menu": comandi cliccabili con il loro
# testo e la chiamata COMPLETA (es. wsTbs.Url('Anpl_...','...','','5.284',null)).
# "intestazioni": righe di tabella fatte tutte di <th>, oppure con le celle
# «Data» e «Note» (la griglia dei Sospesi): solo i testi di quelle righe.
_JS_STRUTTURA_PERIZIA = _JS_ETICHETTA + _JS_CHIAMATA + r"""
var out = {campi: [], voci_menu: [], intestazioni: []};
try {
    var trs = document.querySelectorAll('tr');
    for (var h = 0; h < trs.length && out.intestazioni.length < 10; h++) {
        var tr = trs[h];
        if (!tr.cells || tr.cells.length < 2 || tr.querySelector('table')) continue;
        var tutteTh = true, celle = [], basso = [];
        for (var q = 0; q < tr.cells.length && q < 40; q++) {
            if (tr.cells[q].tagName !== 'TH') tutteTh = false;
            var tq = txt(tr.cells[q]).substring(0, 60);
            celle.push(tq);
            basso.push(tq.toLowerCase());
        }
        if (tutteTh || (basso.indexOf('data') >= 0 && basso.indexOf('note') >= 0)) out.intestazioni.push(celle);
    }
} catch (e) { out.errore_intestazioni = String(e).substring(0, 100); }
try {
    var els = document.querySelectorAll('input, select, textarea');
    for (var k = 0; k < els.length && out.campi.length < 300; k++) {
        try {
            var el = els[k], tipo = tipoDi(el);
            if (SALTA[tipo]) continue;
            var et = etichettaDi(el);
            var r = el.getBoundingClientRect();
            var c = {id: el.id || '', name: el.getAttribute('name') || '', tipo: tipo,
                     etichetta: et, visibile: r.width > 0 && r.height > 0 && tipo !== 'hidden'};
            var chiave = (c.id + ' ' + c.name + ' ' + et).toLowerCase();
            c.sosp = chiave.indexOf('sosp') >= 0;
            if (tipo === 'checkbox' || tipo === 'radio') {
                c.selezionato = !!el.checked;
            } else if (tipo.indexOf('select') === 0) {
                c.n_opzioni = el.options.length;
                c.opzioni = [];
                for (var o = 0; o < el.options.length && o < 60; o++) c.opzioni.push(txt(el.options[o]) || (el.options[o].text || ''));
                c.indice_selezionato = el.selectedIndex;
                c.vuoto = el.selectedIndex < 0 || !txt(el.options[el.selectedIndex]);
            } else {
                c.vuoto = !(el.value || '').length;
                if (c.sosp) c.lunghezza = (el.value || '').length;
            }
            out.campi.push(c);
        } catch (e2) { }
    }
} catch (e) { out.errore_campi = String(e).substring(0, 100); }
try {
    var cl = document.querySelectorAll('a, button, input[type="button"], input[type="submit"], input[type="image"], [onclick]');
    for (var v = 0; v < cl.length && out.voci_menu.length < 150; v++) {
        try {
            var e4 = cl[v];
            var chiamata = chiamataDi(e4);
            if (!chiamata) continue;
            var testo = txt(e4) || (e4.value || e4.title || e4.getAttribute('alt') || '').trim();
            out.voci_menu.push({tag: e4.tagName, testo: testo.substring(0, 60), chiamata: chiamata});
        } catch (e5) { }
    }
} catch (e) { out.errore_menu = String(e).substring(0, 100); }
return out;
"""


def apri_anagrafica(browser: PreliosBrowser, log=print) -> None:
    """Porta la perizia aperta sulla pagina Anagrafica (come extract_phone)."""
    try:
        browser.switch_to_default()
        browser.execute_js(_JS_NAV_ANAGRAFICA)
        browser.wait(3)
    except Exception as e:
        log(f"Navigazione anagrafica non riuscita ({e}); leggo la pagina corrente")


ATTESA_SOSPESI_SEC = 10


def _righe_sospesi(val: dict) -> list[dict]:
    """Solo "data" e "note" di ogni riga (qualunque altra chiave è scartata)."""
    out = []
    for r in val.get("righe") or []:
        if isinstance(r, dict):
            out.append({"data": str(r.get("data") or "")[:40],
                        "note": str(r.get("note") or "")[:2000]})
    return out


def leggi_pagina_sospesi(browser: PreliosBrowser, log=print,
                         attesa: int = ATTESA_SOSPESI_SEC) -> dict:
    """Dalla perizia aperta: navigazione alla pagina «Sospesi» (clic sulla
    voce del menu con il codice di pagina Anpl_Immobili_Sospesi_ISP, o in
    ripiego la chiamata diretta wsTbs.Url), attesa della griglia, lettura di
    «Data» e «Note» di ogni riga e del «Motivo Sospensione» scelto.
    BEST-EFFORT, NON verificato sul portale.

    Returns:
        {"raggiunta": bool, "righe": [{"data", "note"}], "motivo": str,
         "arrivo": ARRIVO_CLIC | ARRIVO_CHIAMATA | '' (pagina non aperta),
         "esito": 'OK' o motivo del fallimento (dice come si è arrivati e
         cosa non si è trovato)}"""
    vuoto = {"raggiunta": False, "righe": [], "motivo": "", "arrivo": ""}
    arrivo = ""
    problema = ""
    try:
        if _run_everywhere(browser, _JS_CLICCA_SOSPESI) == "clicked":
            arrivo = ARRIVO_CLIC
    except Exception as e:  # noqa: BLE001
        problema = f" (clic non riuscito: {str(e)[:80]})"
    if not arrivo:
        try:
            browser.switch_to_default()
            if browser.execute_js(_JS_NAV_SOSPESI) == "chiamata":
                arrivo = ARRIVO_CHIAMATA
        except Exception as e:  # noqa: BLE001
            problema += f" (chiamata diretta non riuscita: {str(e)[:80]})"
    if not arrivo:
        return dict(vuoto, esito=(f"voce del menu con {PAGINA_SOSPESI} non trovata e wsTbs "
                                  f"non disponibile: pagina «Sospesi» non aperta{problema}"))
    for _ in range(max(1, attesa)):
        browser.wait(1)
        motivo = ""
        griglia = None
        for _origine, val in _collect_everywhere(browser, _JS_GRIGLIA_SOSPESI):
            if not isinstance(val, dict):
                continue
            if not motivo and isinstance(val.get("motivo"), str):
                motivo = val["motivo"].strip()[:120]
            if griglia is None and val.get("griglia") is True:
                griglia = val
        if griglia is not None:
            return {"raggiunta": True, "righe": _righe_sospesi(griglia), "motivo": motivo,
                    "arrivo": arrivo, "esito": "OK"}
    come = (f"pagina aperta con il clic sulla voce del menu con {PAGINA_SOSPESI}"
            if arrivo == ARRIVO_CLIC else
            f"voce del menu con {PAGINA_SOSPESI} non trovata, pagina aperta con la "
            "chiamata diretta wsTbs.Url")
    return dict(vuoto, arrivo=arrivo,
                esito=(f"griglia della pagina «Sospesi» non comparsa ({come}; nessuna "
                       "tabella con le colonne «Data», «Note» e «Stato Perizia»)"))


def read_perizia_structure(browser: PreliosBrowser) -> dict:
    """Struttura GREZZA della pagina corrente della perizia (documento e
    frame), senza valori: da passare a struttura_elenco.descrivi_perizia."""
    campi: list[dict] = []
    voci: list[dict] = []
    intestazioni: list[list[str]] = []
    origini = 0
    for origine, val in _collect_everywhere(browser, _JS_STRUTTURA_PERIZIA):
        if not isinstance(val, dict):
            continue
        origini += 1
        campi.extend(dict(c, origine=origine) for c in (val.get("campi") or [])
                     if isinstance(c, dict))
        voci.extend(dict(c, origine=origine) for c in (val.get("voci_menu") or [])
                    if isinstance(c, dict))
        intestazioni.extend([str(x) for x in r] for r in (val.get("intestazioni") or [])
                            if isinstance(r, list))
    return {"campi": campi, "voci_menu": voci, "intestazioni": intestazioni,
            "origini": origini}


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
# In più, "icone" (ALLINEATO per indice a "rows"): il codice dell'icona della
# cella sotto l'intestazione «VT» (nome del file dell'immagine senza
# estensione, maiuscolo, solo se fatto di 1-3 lettere), null se non c'è.
# Niente altro dalle celle a icona. La colonna si trova PER NOME: la riga di
# intestazione è quella con una cella «VT» e una «Tipo Perizia» (o
# «Tipologia»); vale per le righe della stessa tabella (se la tabella non ha
# intestazione, per l'ultima vista) con lo stesso numero di celle.
# "vt": true se quella riga di intestazione è stata trovata.
_JS_GRID_ROWS = r"""
var out = {rows: [], icone: [], vt: false, layout_rows: 0,
           tables: document.querySelectorAll('table').length};
function nomeCol(t) { return t.toLowerCase().replace(/[.:]/g, ' ').replace(/\s+/g, ' ').trim(); }
function codiceIcona(cell) {
    var imgs = cell.querySelectorAll('img, input[type="image"]');
    for (var m = 0; m < imgs.length; m++) {
        var file = (imgs[m].getAttribute('src') || '').split(/[?#]/)[0].split('/').pop();
        var nome = file.replace(/\.[A-Za-z0-9]+$/, '').toUpperCase();
        if (/^[A-Z]{1,3}$/.test(nome)) return nome;
    }
    return null;
}
var perTabella = [], ultima = null;
function intestazioneDi(tab) {
    for (var k = 0; k < perTabella.length; k++) { if (perTabella[k].t === tab) return perTabella[k].h; }
    return ultima;
}
var trs = document.querySelectorAll('tr');
for (var i = 0; i < trs.length && out.rows.length < 3000; i++) {
    var tr = trs[i];
    if (tr.querySelector('table')) { out.layout_rows++; continue; }
    var cells = [], nomi = [];
    for (var j = 0; j < tr.cells.length; j++) {
        var t = (tr.cells[j].innerText || tr.cells[j].textContent || '');
        t = t.replace(/\s+/g, ' ').trim();
        cells.push(t.substring(0, 500));
        nomi.push(nomeCol(t));
    }
    if (!cells.length) continue;
    var tab = tr.closest ? tr.closest('table') : null;
    var iVT = nomi.indexOf('vt');
    if (iVT >= 0 && (nomi.indexOf('tipo perizia') >= 0 || nomi.indexOf('tipologia') >= 0)) {
        var h = {i: iVT, n: cells.length};
        var nuova = true;
        for (var q = 0; q < perTabella.length; q++) { if (perTabella[q].t === tab) { perTabella[q].h = h; nuova = false; } }
        if (nuova) perTabella.push({t: tab, h: h});
        ultima = h;
        out.vt = true;
    }
    var icona = null;
    var hh = intestazioneDi(tab);
    if (hh && tr.cells.length === hh.n) {
        try { icona = codiceIcona(tr.cells[hh.i]); } catch (e) { icona = null; }
    }
    out.rows.push(cells);
    out.icone.push(icona);
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

# Struttura della pagina dell'elenco, SOLO LETTURA (nessun click, nessun
# valore scritto), per elenco_struttura.json:
# - "th": righe di celle <th> delle tabelle, con numero di celle e posizione
#   della Tipologia della prima riga dati della STESSA tabella (per capire
#   se sono davvero i titoli della griglia);
# - "controlli": campi del modulo (input/select/textarea) FUORI dalle righe
#   dati: id, name, tipo, se è vuoto (MAI il valore), etichetta vicina, voci
#   dei menu a tendina, spunte; per i soli campi numRecord («Trovati:») e
#   PageSize («Max Righe:») il numero, se il valore è fatto solo di cifre;
# - "controlli_in_griglia": quanti campi stanno dentro le righe dati (saltati);
# - "celle": per ogni colonna delle righe dati (chiave = posizione rispetto
#   alla Tipologia) cosa contengono le celle OLTRE al testo: immagini (nome
#   del file, alt, title), caselle, link, altri campi, title e classi della
#   cella, immagine/colore di sfondo. Serve per le colonne a icona
#   («Sospesa», «Revoca»): sul portale vero il loro testo è sempre vuoto.
# Ogni parte è protetta: un elemento strano non ferma la lettura.
_JS_STRUTTURA_PAGINA = """
var reT = /^(FULL|DSKT|DRIVE)\\s*-\\s*\\S+/i;
var out = {th: [], controlli: [], controlli_in_griglia: 0, celle: {}};
function txt(e) {
    try { return ((e && (e.innerText || e.textContent)) || '').replace(/\\s+/g, ' ').trim().substring(0, 120); }
    catch (x) { return ''; }
}
function chiamataDi(e) {
    var codice = (e.getAttribute && e.getAttribute('onclick')) || '';
    var href = (e.getAttribute && e.getAttribute('href')) || '';
    if (!codice && href.toLowerCase().indexOf('javascript:') === 0) codice = href.substring(11);
    return codice.replace(/\\s+/g, ' ').trim().substring(0, 200);
}
function conta(d, v, max) {
    v = (v || '').replace(/\\s+/g, ' ').trim().substring(0, max || 60);
    if (!v) return;
    if (d[v]) d[v]++;
    else if (Object.keys(d).length < 20) d[v] = 1;
    else d['\\u2026altri'] = (d['\\u2026altri'] || 0) + 1;
}
function contenutoCelle(tr, t) {
    for (var c = 0; c < tr.cells.length && c < 80; c++) {
        try {
            var cell = tr.cells[c], k = String(c - t);
            var s = out.celle[k];
            if (!s) {
                s = out.celle[k] = {righe: 0, immagini: 0, caselle: 0, caselle_spuntate: 0,
                                    link: 0, altri_campi: 0, sfondo_immagine: 0,
                                    img_file: {}, img_alt: {}, img_title: {}, title: {},
                                    classi: {}, colore_sfondo: {}, chiamate: {}};
            }
            var cmd = [cell].concat(Array.prototype.slice.call(cell.querySelectorAll('[onclick], a[href]'), 0, 5));
            for (var z = 0; z < cmd.length; z++) conta(s.chiamate, chiamataDi(cmd[z]), 200);
            s.righe++;
            var imgs = cell.querySelectorAll('img, input[type="image"]');
            if (imgs.length) s.immagini++;
            for (var m = 0; m < imgs.length && m < 5; m++) {
                var src = (imgs[m].getAttribute('src') || '').split(/[?#]/)[0].split('/').pop();
                conta(s.img_file, src);
                conta(s.img_alt, imgs[m].getAttribute('alt'));
                conta(s.img_title, imgs[m].getAttribute('title'));
            }
            var box = cell.querySelectorAll('input[type="checkbox"], input[type="radio"]');
            if (box.length) s.caselle++;
            for (var b = 0; b < box.length; b++) { if (box[b].checked) { s.caselle_spuntate++; break; } }
            if (cell.querySelector('a')) s.link++;
            if (cell.querySelector('select, textarea, button, input:not([type="checkbox"]):not([type="radio"]):not([type="image"])')) s.altri_campi++;
            conta(s.title, cell.getAttribute('title'));
            var cl = [cell].concat(Array.prototype.slice.call(cell.querySelectorAll('[class]'), 0, 5));
            for (var q = 0; q < cl.length; q++) conta(s.classi, typeof cl[q].className === 'string' ? cl[q].className : '');
            var st = window.getComputedStyle ? window.getComputedStyle(cell) : null;
            if (st) {
                if (st.backgroundImage && st.backgroundImage !== 'none') s.sfondo_immagine++;
                if (st.backgroundColor && st.backgroundColor !== 'rgba(0, 0, 0, 0)' && st.backgroundColor !== 'transparent') conta(s.colore_sfondo, st.backgroundColor);
            }
        } catch (e3) { }
    }
}
function colTipologia(tr) {
    if (!tr || !tr.cells) return -1;
    for (var j = 0; j < tr.cells.length; j++) { if (reT.test(txt(tr.cells[j]))) return j; }
    return -1;
}
try {
    var tables = document.querySelectorAll('table');
    for (var i = 0; i < tables.length && i < 300 && out.th.length < 20; i++) {
        var rows = tables[i].rows || [];
        var heads = [], nDati = null, tDati = null;
        for (var r = 0; r < rows.length && r < 400; r++) {
            var tr = rows[r];
            if (!tr.cells || !tr.cells.length) continue;
            var tutteTh = true;
            for (var c = 0; c < tr.cells.length; c++) { if (tr.cells[c].tagName !== 'TH') { tutteTh = false; break; } }
            if (tutteTh && tr.cells.length > 1) {
                var celle = [];
                for (var c2 = 0; c2 < tr.cells.length; c2++) celle.push(txt(tr.cells[c2]));
                heads.push(celle);
                continue;
            }
            var t = colTipologia(tr);
            if (t >= 0 && nDati === null) { nDati = tr.cells.length; tDati = t; }
            if (t >= 0) contenutoCelle(tr, t);
        }
        for (var h = 0; h < heads.length; h++) {
            out.th.push({celle: heads[h], n_celle_dati: nDati, col_tipologia_dati: tDati});
        }
    }
} catch (e) { out.errore_th = String(e).substring(0, 100); }
try {
    var els = document.querySelectorAll('input, select, textarea');
    for (var k = 0; k < els.length && out.controlli.length < 150; k++) {
        try {
            var el = els[k];
            var tag = el.tagName.toLowerCase();
            var tipo = tag === 'input' ? (el.type || 'text').toLowerCase() : (tag === 'select' ? (el.multiple ? 'select-multiple' : 'select') : tag);
            if (tipo === 'button' || tipo === 'submit' || tipo === 'image' || tipo === 'reset' || tipo === 'file' || tipo === 'password') continue;
            var riga = el.closest ? el.closest('tr') : null;
            if (riga && colTipologia(riga) >= 0) { out.controlli_in_griglia++; continue; }
            var etichetta = '';
            if (el.id) {
                var lab = document.querySelector('label[for="' + el.id.replace(/"/g, '') + '"]');
                if (lab) etichetta = txt(lab);
            }
            if (!etichetta && el.closest && el.closest('label')) etichetta = txt(el.closest('label'));
            if (!etichetta && el.closest) {
                var td = el.closest('td');
                var prev = td ? td.previousElementSibling : null;
                if (prev) etichetta = txt(prev);
            }
            if (!etichetta) etichetta = (el.title || el.getAttribute('placeholder') || '').substring(0, 120);
            var rect = el.getBoundingClientRect();
            var c = {id: el.id || '', name: el.getAttribute('name') || '', tipo: tipo,
                     etichetta: etichetta, visibile: rect.width > 0 && rect.height > 0 && tipo !== 'hidden'};
            if (tipo === 'checkbox' || tipo === 'radio') {
                c.selezionato = !!el.checked;
            } else if (tag === 'select') {
                c.n_opzioni = el.options.length;
                c.opzioni = [];
                for (var o = 0; o < el.options.length && o < 60; o++) c.opzioni.push(txt(el.options[o]) || (el.options[o].text || ''));
                c.indice_selezionato = el.selectedIndex;
            } else {
                c.vuoto = !(el.value || '').length;
                var nome = el.getAttribute('name') || el.id || '';
                if ((nome === 'numRecord' || nome === 'PageSize') && /^\\s*\\d{1,6}\\s*$/.test(el.value || '')) {
                    c.numero = parseInt(el.value, 10);
                }
            }
            out.controlli.push(c);
        } catch (e2) { }
    }
} catch (e) { out.errore_controlli = String(e).substring(0, 100); }
// Link delle pagine ("- 1 2 3 ... 15 +"): solo descritti, MAI cliccati
out.link_pagina = [];
try {
    var reP = /^(\\d{1,3}|-|\\+|\\u2026|\\.\\.\\.|<<?|>>?)$/;
    var lp = document.querySelectorAll('a, span, td, font, b, input[type="button"]');
    for (var p = 0; p < lp.length && out.link_pagina.length < 40; p++) {
        try {
            var el2 = lp[p];
            var ch = chiamataDi(el2);
            if (!ch) continue;
            var tx = ((el2.innerText || el2.textContent || el2.value || '') + '').replace(/\\s+/g, ' ').trim();
            if (!reP.test(tx)) continue;
            var riga2 = el2.closest ? el2.closest('tr') : null;
            if (riga2 && colTipologia(riga2) >= 0) continue;
            out.link_pagina.push({tag: el2.tagName, testo: tx, chiamata: ch});
        } catch (e6) { }
    }
} catch (e) { out.errore_link_pagina = String(e).substring(0, 100); }
return out;
"""


def read_page_structure(browser: PreliosBrowser) -> dict:
    """Struttura della pagina dell'elenco (documento e frame), SOLO lettura.

    Returns:
        {"th": [...], "controlli": [...], "controlli_in_griglia": n,
         "celle": {...}, "origini": numero di documenti/frame letti}
        Ogni controllo ha in più "origine" ('main' o 'frame_N'). "celle" è
        quello del documento/frame con più righe dati (la griglia è una)."""
    th: list[dict] = []
    controlli: list[dict] = []
    in_griglia = 0
    origini = 0
    celle: dict = {}
    link_pagina: list[dict] = []
    for origine, val in _collect_everywhere(browser, _JS_STRUTTURA_PAGINA):
        if not isinstance(val, dict):
            continue
        origini += 1
        c = val.get("celle")
        if isinstance(c, dict) and isinstance(c.get("0"), dict):
            if int(c["0"].get("righe") or 0) > int((celle.get("0") or {}).get("righe") or 0):
                celle = c
        th.extend(dict(t, origine=origine) for t in (val.get("th") or []) if isinstance(t, dict))
        controlli.extend(dict(c, origine=origine) for c in (val.get("controlli") or [])
                         if isinstance(c, dict))
        link_pagina.extend(dict(c, origine=origine) for c in (val.get("link_pagina") or [])
                           if isinstance(c, dict))
        try:
            in_griglia += int(val.get("controlli_in_griglia") or 0)
        except (TypeError, ValueError):
            pass
    return {"th": th, "controlli": controlli, "controlli_in_griglia": in_griglia,
            "celle": celle, "link_pagina": link_pagina, "origini": origini}


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
         "icone": [codice o None, ...] (allineato per indice a "rows"),
         "colonna_vt": True se l'intestazione «VT» è stata trovata,
         "frames": [{"origine", "righe", "righe_layout", "tabelle"}],
         "frame_count": numero di frame letti (escluso il documento)}
    """
    from stato_portale import codice_icona
    rows: list[list[str]] = []
    icone: list[str | None] = []
    colonna_vt = False
    frames: list[dict] = []
    for origine, val in _collect_everywhere(browser, _JS_GRID_ROWS):
        if not isinstance(val, dict):
            continue
        grezze = val.get("rows") or []
        ic = val.get("icone") if isinstance(val.get("icone"), list) else []
        n = 0
        for i, r in enumerate(grezze):
            if not isinstance(r, list):
                continue
            rows.append([str(c) for c in r])
            icone.append(codice_icona(ic[i]) if i < len(ic) else None)
            n += 1
        colonna_vt = colonna_vt or val.get("vt") is True
        frames.append({"origine": origine, "righe": n,
                       "righe_layout": val.get("layout_rows", 0),
                       "tabelle": val.get("tables", 0)})
    return {"rows": rows, "icone": icone, "colonna_vt": colonna_vt, "frames": frames,
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


def _firme_dati(rows) -> frozenset:
    """Righe dati (con tipologia) come insieme di tuple."""
    from excel_pratiche import _trova_colonna_tipologia
    return frozenset(tuple(r) for r in rows if _trova_colonna_tipologia(r) >= 0)


def _firme_dati_da_firme(firme) -> frozenset:
    return _firme_dati(list(firme))


def attendi_griglia(browser: PreliosBrowser, max_secondi: int = 20,
                    diversa_da: set | None = None) -> dict:
    """Attende che la griglia si stabilizzi: stesso numero (>0) di righe con
    tipologia per due letture consecutive, o tempo scaduto.

    diversa_da: righe di una ricerca precedente; finché le righe dati sono
    ancora le stesse la griglia è considerata non ancora aggiornata."""
    ultimo = -1
    griglia: dict = {"rows": [], "icone": [], "colonna_vt": False, "frames": [],
                     "frame_count": 0}
    vecchie = _firme_dati_da_firme(diversa_da) if diversa_da is not None else None
    for _ in range(max_secondi):
        browser.wait(1)
        griglia = read_grid(browser)
        n = _conta_righe_tipologia(griglia["rows"])
        if vecchie is not None and vecchie and _firme_dati(griglia["rows"]) == vecchie:
            ultimo = -1
            continue
        if n > 0 and n == ultimo:
            break
        ultimo = n
    return griglia


# Campo «Max Righe:» (input name="PageSize") dell'Elenco Perizie: imposta il
# valore passato come ARGOMENTO (mai inserito nel testo dello script) e
# manda change/blur. Ritorna il valore precedente, oppure null se il campo
# non c'è in questo documento.
_JS_IMPOSTA_PAGESIZE = r"""
var el = document.querySelector('input[name="PageSize"]');
if (!el) return null;
var prima = el.value || '';
el.value = String(arguments[0]);
el.dispatchEvent(new Event('input', {bubbles: true}));
el.dispatchEvent(new Event('change', {bubbles: true}));
el.dispatchEvent(new Event('blur', {bubbles: true}));
return prima;
"""

# Numero di «Trovati:» (input name="numRecord"), solo se fatto di cifre.
_JS_TROVATI = r"""
var el = document.querySelector('input[name="numRecord"]');
if (!el) return null;
var v = (el.value || '').replace(/\s+/g, '');
return /^\d{1,7}$/.test(v) ? parseInt(v, 10) : null;
"""

# Menu «Stato Perizia» (select Imm_StatoValutazione): con argomento 'sospese'
# sceglie l'UNICA voce il cui testo contiene «sospes» (il codice non lo
# conosciamo); con 'vuoto' rimette la voce vuota. Manda l'evento change.
# Ritorna {esito: 'ok'|'nessuna'|'piu_di_una'|'nessuna_vuota', voci: n}
# oppure null se il menu non c'è in questo documento.
_JS_STATO_PERIZIA = r"""
var sel = document.getElementById('Imm_StatoValutazione');
if (!sel || !sel.options) return null;
var scelta = -1, n = 0;
for (var i = 0; i < sel.options.length; i++) {
    var t = (sel.options[i].text || '').toLowerCase();
    if (arguments[0] === 'sospese' && t.indexOf('sospes') >= 0) { n++; scelta = i; }
    if (arguments[0] === 'vuoto' && !(sel.options[i].value || '').length && !t.trim()) { n++; if (scelta < 0) scelta = i; }
}
if (arguments[0] === 'sospese' && n !== 1) return {esito: n ? 'piu_di_una' : 'nessuna', voci: n};
if (arguments[0] === 'vuoto' && scelta < 0) return {esito: 'nessuna_vuota', voci: 0};
sel.selectedIndex = scelta;
sel.dispatchEvent(new Event('change', {bubbles: true}));
return {esito: 'ok', voci: n};
"""

MAX_RIGHE_DEFAULT = 200


def imposta_max_righe(browser: PreliosBrowser, valore: int, log=print) -> str | None:
    """Porta «Max Righe:» a `valore` (0 = non toccarlo). Ritorna il valore
    precedente ('' se non leggibile), None se il campo non è stato trovato."""
    if not valore or valore <= 0:
        return None
    prima = None
    for _origine, val in _collect_everywhere(browser, _JS_IMPOSTA_PAGESIZE, int(valore)):
        if val is not None and prima is None:
            prima = str(val)
    if prima is None:
        log("ATTENZIONE: campo «Max Righe» (PageSize) non trovato: resta il valore del portale.")
    else:
        log(f"Max Righe portato a {int(valore)} (prima: {prima or '?'}).")
    return prima


def leggi_trovati(browser: PreliosBrowser) -> int | None:
    """Numero di «Trovati:» della pagina dell'elenco (None se non leggibile)."""
    for _origine, val in _collect_everywhere(browser, _JS_TROVATI):
        if isinstance(val, int) and not isinstance(val, bool):
            return val
    return None


def _stato_perizia(browser: PreliosBrowser, scelta: str) -> dict | None:
    """Esegue _JS_STATO_PERIZIA dove c'è il menu; primo risultato."""
    for _origine, val in _collect_everywhere(browser, _JS_STATO_PERIZIA, scelta):
        if isinstance(val, dict):
            return val
    return None


def apri_elenco_completo(browser: PreliosBrowser, log=print,
                         max_righe: int = 0) -> bool:
    """Elenco Perizie con filtro Cod. Immobile vuoto (e «Max Righe» portato a
    `max_righe`, se > 0) + ricerca. Ritorna False se il campo filtro non è
    stato trovato (la ricerca viene lanciata comunque: il filtro potrebbe
    essere già vuoto)."""
    browser.switch_to_default()
    _apri_elenco_perizie(browser, log)
    campo = _imposta_filtro_codice(browser, "")
    if campo == "not_found":
        log("ATTENZIONE: campo filtro Cod. Immobile (Imm_ky) non trovato: "
            "lancio la ricerca con i filtri correnti.")
    elif campo != "Imm_ky":
        log(f"ATTENZIONE: filtro Imm_ky non trovato, svuotato il campo di "
            f"ripiego '{campo}': verificare l'elenco con dump_elenco.py.")
    # «Stato Perizia» vuoto: la ricerca delle sospese del ciclo prima non
    # deve restare attiva (il portale potrebbe ricordarla)
    _stato_perizia(browser, "vuoto")
    if max_righe:
        imposta_max_righe(browser, max_righe, log)
    browser.switch_to_default()
    browser.execute_js("cmdFindClick();")
    return campo != "not_found"


def cerca_sospese(browser: PreliosBrowser, firme_prima: set, log=print) -> dict:
    """SECONDA ricerca (BEST-EFFORT): «Stato Perizia» = la voce che contiene
    «sospes», ricerca, lettura delle righe, poi il menu torna vuoto.

    Returns:
        {"esito": "ok" | motivo, "righe": [...] (solo con esito ok),
         "icone": [...] (allineato a "righe"), "trovati": n o None}"""
    browser.switch_to_default()
    r = _stato_perizia(browser, "sospese")
    if r is None:
        return {"esito": "menu «Stato Perizia» (Imm_StatoValutazione) non trovato", "righe": []}
    if r.get("esito") != "ok":
        n = r.get("voci", 0)
        return {"esito": (f"{n} voci di «Stato Perizia» contengono «sospes»: ambiguo"
                          if n else "nessuna voce di «Stato Perizia» contiene «sospes»"),
                "righe": []}
    try:
        browser.switch_to_default()
        browser.execute_js("cmdFindClick();")
        griglia = attendi_griglia(browser, diversa_da=firme_prima)
        righe = list(griglia["rows"])
        icone = _icone_allineate(griglia, righe)
        trovati = leggi_trovati(browser)
        esito = "ok" if _firme_dati(righe) != _firme_dati_da_firme(firme_prima) else \
            "la griglia non è cambiata dopo la ricerca delle sospese"
    finally:
        vuoto = _stato_perizia(browser, "vuoto")
        if not vuoto or vuoto.get("esito") != "ok":
            log("ATTENZIONE: «Stato Perizia» non rimesso vuoto dopo la ricerca delle sospese.")
    return {"esito": esito, "righe": righe if esito == "ok" else [],
            "icone": icone if esito == "ok" else [], "trovati": trovati}


def _icone_allineate(griglia: dict, righe: list) -> list:
    """Icone della griglia allineate per indice alle righe (None dove mancano)."""
    icone = list(griglia.get("icone") or [])
    return (icone + [None] * len(righe))[:len(righe)]


def list_assigned(browser: PreliosBrowser, log=print,
                  max_pagine: int = MAX_PAGINE, info: dict | None = None,
                  max_righe: int = 0, cerca_sospese_ora: bool = False) -> list[list[str]]:
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

    Se `info` è un dizionario, viene riempito (SOLO lettura, per
    elenco_struttura.json) con: "pagina" (struttura della prima pagina:
    intestazioni <th> e campi del modulo), "controlli_paginazione",
    "pagine" (pagine lette). Un errore in questa raccolta non ferma la
    lettura dell'elenco.

    max_righe: valore di «Max Righe» impostato prima della ricerca (0 = non
    toccarlo). Se dopo la ricerca le righe sono ancora quante il valore di
    prima e «Trovati» è maggiore, lo scrive nel log.

    cerca_sospese_ora: dopo la lettura fa la SECONDA ricerca (Stato Perizia
    = sospesa, vedi cerca_sospese) e mette in info["sospese"] l'esito e le
    righe trovate (le sospese ADESSO).
    """
    if info is None:
        info = {}
    info["pagine"] = 1
    apri_elenco_completo(browser, log, max_righe=max_righe)
    griglia = attendi_griglia(browser)
    try:
        info["pagina"] = read_page_structure(browser)
    except Exception as e:  # noqa: BLE001 — solo descrizione, mai bloccante
        info["pagina"] = {"errore": str(e)[:200]}
    righe: list[list[str]] = list(griglia["rows"])
    # icona «VT» di ogni riga, allineata per indice a `righe` (anche dopo la
    # paginazione): la usa il parser per lo stato
    icone: list = _icone_allineate(griglia, righe)
    info["icone"] = icone
    info["colonna_vt"] = bool(griglia.get("colonna_vt"))
    firme = {tuple(r) for r in righe}
    n_dati = _conta_righe_tipologia(righe)
    log(f"Elenco: lette {len(righe)} righe grezze da {len(griglia['frames'])} "
        f"documenti/frame ({n_dati} con tipologia).")
    try:
        trovati = leggi_trovati(browser)
    except Exception:  # noqa: BLE001
        trovati = None
    info["trovati"] = trovati
    if trovati is not None and trovati > n_dati:
        log(f"ATTENZIONE: il portale dice {trovati} perizie ma ne ho lette {n_dati}: "
            "forse ci sono più pagine (le più vecchie non sono lette; "
            + (f"Max Righe richiesto: {max_righe})." if max_righe else "Max Righe non toccato)."))

    _segui_paginazione(browser, righe, firme, info, log, max_pagine, icone)

    # La ricerca delle sospese viene DOPO: cambia la griglia mostrata
    if cerca_sospese_ora:
        try:
            info["sospese"] = cerca_sospese(browser, firme, log)
        except Exception as e:  # noqa: BLE001 — si ripiega sulla colonna Sospensione
            info["sospese"] = {"esito": f"errore ({str(e)[:100]})", "righe": []}
    return righe


def _segui_paginazione(browser: PreliosBrowser, righe: list, firme: set, info: dict,
                       log, max_pagine: int, icone: list | None = None) -> None:
    """Segue il controllo "pagina successiva" SOLO se ce n'è esattamente uno
    (mai i numeri di pagina); aggiunge a `righe` le righe nuove (e a
    `icone`, se passato, le loro icone, sempre allineate per indice)."""
    candidati = find_next_controls(browser)
    info["controlli_paginazione"] = candidati
    if len(candidati) != 1:
        motivo = ("nessun controllo 'pagina successiva' riconosciuto"
                  if not candidati else
                  f"{len(candidati)} controlli candidati: ambiguo, non clicco")
        log(f"ATTENZIONE: paginazione NON verificata ({motivo}): letta solo "
            "la pagina corrente. Se le pratiche stanno su più pagine, "
            "controllare con dump_elenco.py.")
        return

    pagine = 1
    while pagine < max_pagine:
        cliccato = any(esito == "clicked" for _o, esito in
                       _collect_everywhere(browser, _JS_FIND_NEXT, "click"))
        if not cliccato:
            break
        griglia = attendi_griglia(browser)
        tutte = list(griglia["rows"])
        icone_pagina = _icone_allineate(griglia, tutte)
        nuove_idx = [i for i, r in enumerate(tutte) if tuple(r) not in firme]
        nuove = [tutte[i] for i in nuove_idx]
        if not _conta_righe_tipologia(nuove):
            break  # nessuna riga nuova: era l'ultima pagina
        pagine += 1
        righe.extend(nuove)
        if icone is not None:
            icone.extend(icone_pagina[i] for i in nuove_idx)
        firme.update(tuple(r) for r in nuove)
        info["pagine"] = pagine
        if len(find_next_controls(browser)) != 1:
            break
    info["pagine"] = pagine
    log(f"Paginazione (NON verificata sul portale reale): lette {pagine} "
        f"pagine, {len(righe)} righe grezze in totale."
        + (f" Raggiunto il tetto di {max_pagine} pagine." if pagine >= max_pagine else ""))
