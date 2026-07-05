"""Tool 05: Estrazione del telefono cliente dalla perizia aperta.

FONTI (pagina "Anagrafica Perizia", quella su cui atterra t03):
  1. Imm_Descrizione  = "Note del Gestore Intesa"  (fonte PRIMARIA:
     "Nome Cognome - 0039333... - istruzioni per il sopralluogo")
  2. campo etichettato "Telefono Mutuatario" (quando compilato e' il
     numero del cliente)
  3. Imm_Note         = "Note interne per il perito" (fonte secondaria)
  4. campo etichettato "Telefono Richiedente" (fallback)
  I campi NTM (Telefono NTM / Riferimento NTM) sono i referenti tecnici
  intermediari, NON il cliente: vengono ESCLUSI.

NOTA: questo file va copiato in tools/ del progetto MISI ISP (accanto a
t01_login.py ecc.); contact_parse.py va copiato nella root del progetto
(accanto a run_giro.py).
"""

from tools.base_tool import BaseTool
from models import ToolResult

from contact_parse import analizza_nota_gestore, estrai_telefoni

# Campi noti della pagina Anagrafica Perizia (id DOM verificati)
FIELD_NOTE_GESTORE = "Imm_Descrizione"   # Note del Gestore Intesa
FIELD_NOTE_PERITO = "Imm_Note"           # Note interne per il perito

# Etichette dei campi telefono (testo della cella a sinistra dell'input)
LABEL_MUTUATARIO = "telefono mutuatario"
LABEL_RICHIEDENTE = "telefono richiedente"

# Etichette/id da escludere sempre (referenti tecnici, non il cliente)
ESCLUDI_KEYWORD = ("ntm",)


class ExtractContactsTool(BaseTool):
    name = "Estrazione contatti"
    tool_id = "t05_extract_contacts"
    description = "Estrae il telefono del cliente dalla perizia aperta"
    phase = 3  # Lettura

    def validate_preconditions(self) -> tuple[bool, str]:
        if not getattr(self.ctx.data, "perizia_open", False):
            return False, "Perizia non aperta (eseguire prima t03_open_perizia)"
        return True, ""

    def execute(self) -> ToolResult:
        self._drain_alerts("prima dell'estrazione contatti")

        # 0. Assicura di essere sulla pagina "Anagrafica Perizia": è lì che
        #    vivono Imm_Descrizione (Note del Gestore) e Imm_Note. Dopo t03 la
        #    perizia è aperta ma potrebbe mostrare un'altra pagina.
        try:
            self.navigate_and_wait("anagrafica")
        except Exception as e:
            self.log(f"Navigazione alla pagina Anagrafica non riuscita ({e}); "
                     "provo a leggere la pagina corrente")

        # 1. Lettura fonti dalla pagina Anagrafica Perizia
        nota_gestore = self._leggi_campo_per_id(FIELD_NOTE_GESTORE) or ""
        nota_perito = self._leggi_campo_per_id(FIELD_NOTE_PERITO) or ""
        tel_mutuatario = self._leggi_campo_per_etichetta(LABEL_MUTUATARIO) or ""
        tel_richiedente = self._leggi_campo_per_etichetta(LABEL_RICHIEDENTE) or ""

        self.log(f"Note gestore: {len(nota_gestore)} char; "
                 f"note perito: {len(nota_perito)} char; "
                 f"mutuatario: '{tel_mutuatario}'; richiedente: '{tel_richiedente}'")

        gestore = analizza_nota_gestore(nota_gestore)
        perito = analizza_nota_gestore(nota_perito)
        mutuatario = estrai_telefoni(tel_mutuatario)
        richiedente = estrai_telefoni(tel_richiedente)

        # 2. Scelta per priorita' (mobili prima, fonte piu' affidabile prima)
        client_phone = ""
        source = ""
        scelte: list[tuple[str, str, str]] = []  # (numero, tipo, fonte)
        scelte += [(t["numero"], t["tipo"], "note_gestore") for t in gestore["telefoni"]]
        scelte += [(t["numero"], t["tipo"], "telefono_mutuatario") for t in mutuatario]
        scelte += [(t["numero"], t["tipo"], "note_perito") for t in perito["telefoni"]]
        scelte += [(t["numero"], t["tipo"], "telefono_richiedente") for t in richiedente]

        priorita = [
            lambda n, t, f: f == "note_gestore" and t == "mobile",
            lambda n, t, f: f == "telefono_mutuatario",
            lambda n, t, f: f == "note_perito" and t == "mobile",
            lambda n, t, f: f == "note_gestore",   # fisso nelle note gestore
            lambda n, t, f: f == "note_perito",
            lambda n, t, f: f == "telefono_richiedente",
        ]
        for regola in priorita:
            match = next(((n, t, f) for n, t, f in scelte if regola(n, t, f)), None)
            if match:
                client_phone, _, source = match
                break

        # 3. Referente e nota per l'operatore AI (istruzioni sopralluogo)
        contact_name = gestore["nome_contatto"] or perito["nome_contatto"]
        contact_note = (nota_gestore or nota_perito).strip()[:300]

        candidates = [
            {"numero": n, "tipo": t, "fonte": f} for n, t, f in scelte
        ]

        # 4. Ultima spiaggia: scansione generica della pagina (esclusi NTM)
        if not client_phone:
            self.log("Nessun telefono nelle fonti note, scansione generica...")
            generici = self._scan_generico()
            candidates.extend(generici)
            if generici:
                client_phone = generici[0]["numero"]
                source = "scan_generico"

        if not client_phone:
            self.log("Nessun telefono cliente trovato nella perizia")
            return ToolResult(True, "Telefono non trovato (best-effort)", {
                "client_phone": "",
                "contact_name": contact_name,
                "contact_note": contact_note,
                "phone_candidates": candidates,
                "phone_source": "",
            })

        self.log(f"Telefono cliente: {client_phone} (fonte: {source}; "
                 f"{len(candidates)} candidati)")
        return ToolResult(True, f"Telefono trovato: {client_phone}", {
            "client_phone": client_phone,
            "contact_name": contact_name,
            "contact_note": contact_note,
            "phone_candidates": candidates,
            "phone_source": source,
        })

    # === LETTURA CAMPI (documento principale + frame) ===

    def _esegui_ovunque(self, js: str):
        """Esegue il JS nel documento principale e poi in ogni frame,
        restituendo il primo risultato non-nullo."""
        browser = self.ctx.browser
        browser.switch_to_default()
        try:
            value = browser.execute_js(js)
            if value is not None:
                return value
        except Exception:
            pass

        try:
            frame_count = browser.get_frame_count()
        except Exception:
            frame_count = 0

        for i in range(frame_count):
            try:
                browser.switch_to_default()
                browser.switch_to_frame(i)
                value = browser.execute_js(js)
                if value is not None:
                    browser.switch_to_default()
                    return value
            except Exception:
                continue
        browser.switch_to_default()
        return None

    def _leggi_campo_per_id(self, field_id: str) -> str | None:
        """Valore di un campo cercato per id in documento e frame."""
        js = (f"var el = document.getElementById('{field_id}'); "
              f"return el ? (el.value || '') : null;")
        return self._esegui_ovunque(js)

    def _leggi_campo_per_etichetta(self, etichetta: str) -> str | None:
        """Valore dell'input nella cella successiva a quella con l'etichetta
        data (es. 'telefono mutuatario'), come nel layout VT-Desktop."""
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
""" % etichetta.lower()
        return self._esegui_ovunque(js)

    # === SCANSIONE GENERICA (fallback) ===

    _SCAN_JS = """
var KW = ['tel', 'cell', 'phone', 'recapito'];
function hasKw(s) {
    s = (s || '').toLowerCase();
    for (var k = 0; k < KW.length; k++) {
        if (s.indexOf(KW[k]) > -1) return true;
    }
    return false;
}
var out = [];
var els = document.querySelectorAll('input, textarea');
for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.type === 'hidden' || el.type === 'button' || el.type === 'submit') continue;
    var meta = (el.id || '') + ' ' + (el.name || '') + ' ' + (el.title || '');
    var prevTxt = '';
    var cell = el.closest ? el.closest('td') : null;
    if (cell && cell.previousElementSibling) {
        prevTxt = cell.previousElementSibling.textContent || '';
    }
    if (hasKw(meta) || hasKw(prevTxt)) {
        var v = (el.value || '').trim();
        if (v) {
            out.push({
                campo: el.id || el.name || 'input',
                etichetta: prevTxt.trim().substring(0, 60),
                valore: v.substring(0, 120)
            });
        }
    }
}
return out;
"""

    def _scan_generico(self) -> list[dict]:
        """Scansione best-effort dei campi a tema telefono (NTM esclusi)."""
        browser = self.ctx.browser
        raccolti: list[dict] = []

        contesti: list[int | None] = [None]
        browser.switch_to_default()
        try:
            contesti += list(range(browser.get_frame_count()))
        except Exception:
            pass

        for frame_idx in contesti:
            try:
                browser.switch_to_default()
                if frame_idx is not None:
                    browser.switch_to_frame(frame_idx)
                raccolti.extend(browser.execute_js(self._SCAN_JS) or [])
            except Exception:
                continue
        browser.switch_to_default()

        visti: set[str] = set()
        candidati: list[dict] = []
        for c in raccolti:
            descrittore = f"{c.get('campo', '')} {c.get('etichetta', '')}".lower()
            if any(k in descrittore for k in ESCLUDI_KEYWORD):
                continue  # referenti tecnici NTM: non e' il cliente
            for t in estrai_telefoni(str(c.get("valore", ""))):
                if t["numero"] in visti:
                    continue
                visti.add(t["numero"])
                candidati.append({
                    "numero": t["numero"],
                    "tipo": t["tipo"],
                    "fonte": f"scan:{c.get('campo', '')}",
                })
        # Mobili prima
        candidati.sort(key=lambda c: 0 if c["tipo"] == "mobile" else 1)
        return candidati
