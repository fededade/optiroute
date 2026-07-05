"""Tool 05: Estrazione del telefono cliente dalla perizia aperta.

NOTA: questo file va copiato in tools/ del progetto MISI ISP (accanto a
t01_login.py ecc.), perche' importa la pipeline con gli stessi nomi.
"""

import re

from tools.base_tool import BaseTool
from models import ToolResult


# Keyword che identificano campi/etichette a tema telefono (lowercase)
PHONE_KEYWORDS = ("tel", "cell", "phone", "recapito")

# Numeri italiani: mobile (3xx...) ed eventuale fisso (0x...)
RE_MOBILE = re.compile(r"\b(?:\+39\s?)?3\d{2}[\s./-]?\d{6,7}\b")
RE_FISSO = re.compile(r"\b0\d{1,3}[\s./-]?\d{5,8}\b")

# JS: raccoglie candidati telefono nel contesto corrente (documento o frame).
# 1) input/textarea con id/name/title/placeholder/label/etichetta-cella a tema
# 2) celle di tabella con etichetta a tema nella cella precedente
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
// 1. Campi input/textarea
var els = document.querySelectorAll('input, textarea');
for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.type === 'hidden' || el.type === 'button' || el.type === 'submit') continue;
    var meta = (el.id || '') + ' ' + (el.name || '') + ' ' +
               (el.title || '') + ' ' + (el.placeholder || '');
    var labelTxt = '';
    if (el.id) {
        var lb = document.querySelector('label[for="' + el.id + '"]');
        if (lb) labelTxt = lb.textContent || '';
    }
    var prevTxt = '';
    var cell = el.closest ? el.closest('td') : null;
    if (cell && cell.previousElementSibling) {
        prevTxt = cell.previousElementSibling.textContent || '';
    }
    if (hasKw(meta) || hasKw(labelTxt) || hasKw(prevTxt)) {
        var v = (el.value || '').trim();
        if (v) {
            out.push({
                campo: el.id || el.name || 'input',
                etichetta: (labelTxt || prevTxt || meta).trim().substring(0, 60),
                valore: v.substring(0, 120)
            });
        }
    }
}
// 2. Celle di tabella: etichetta a tema -> valore nella cella successiva
var tds = document.querySelectorAll('td, th');
for (var j = 0; j < tds.length; j++) {
    var t = (tds[j].textContent || '').trim();
    if (t && t.length < 40 && hasKw(t)) {
        var next = tds[j].nextElementSibling;
        if (next) {
            var v2 = (next.textContent || '').trim();
            if (v2) {
                out.push({
                    campo: 'cella',
                    etichetta: t.substring(0, 60),
                    valore: v2.substring(0, 120)
                });
            }
        }
    }
}
return out;
"""

# JS di fallback: testo completo del body (solo per la regex mobile,
# la regex fisso sul body genererebbe troppi falsi positivi: date, codici...)
_BODY_TEXT_JS = "return (document.body && document.body.innerText) ? " \
                "document.body.innerText.substring(0, 20000) : '';"


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
        browser = self.ctx.browser

        # ============================================================
        # TODO(TELEFONO CLIENTE): l'utente non ha ancora indicato in quale
        # pagina/campo della perizia si trova il telefono. Quando i selettori
        # esatti saranno noti:
        #   1. navigare alla pagina giusta, es.:
        #        self.navigate_and_wait("NomePaginaAnagrafica")
        #   2. leggere direttamente il campo, es.:
        #        phone = browser.execute_js(
        #            "var el=document.getElementById('Ide_TelefonoCliente');"
        #            "return el ? el.value : null;")
        #   3. rimuovere (o lasciare come fallback) la scansione generica
        #      qui sotto.
        # Fino ad allora il tool fa una ricerca GENERICA best-effort su
        # documento principale + frame.
        # ============================================================

        self._drain_alerts("prima della scansione contatti")

        candidati: list[dict] = []

        # Scansione documento principale
        browser.switch_to_default()
        candidati.extend(self._scan_contesto_corrente("main"))

        # Scansione di tutti i frame (come _switch_to_content_frame)
        frame_count = browser.get_frame_count()
        self.log(f"Scansione contatti in {frame_count} frame...")
        for i in range(frame_count):
            try:
                browser.switch_to_default()
                browser.switch_to_frame(i)
                candidati.extend(self._scan_contesto_corrente(f"frame_{i}"))
            except Exception as e:
                self.log(f"Frame {i}: errore accesso ({e})")
                continue
        browser.switch_to_default()

        # Estrai i numeri validi dai candidati raccolti
        telefoni = self._filtra_numeri(candidati)

        # Fallback: nessun campo a tema trovato -> cerca cellulari nel testo
        if not telefoni:
            self.log("Nessun campo a tema trovato, fallback su testo pagina...")
            telefoni = self._fallback_testo_body()

        if not telefoni:
            self.log("Nessun telefono trovato nella perizia")
            return ToolResult(True, "Telefono non trovato (best-effort)", {
                "client_phone": "",
                "phone_candidates": [],
            })

        # Preferisci i cellulari (piu' utili per contattare il cliente in giro)
        migliore = self._scegli_migliore(telefoni)
        self.log(f"Telefono cliente: {migliore} "
                 f"({len(telefoni)} candidati totali)")

        return ToolResult(True, f"Telefono trovato: {migliore}", {
            "client_phone": migliore,
            "phone_candidates": telefoni,
        })

    # === HELPER ===

    def _scan_contesto_corrente(self, contesto: str) -> list[dict]:
        """Esegue lo scan JS nel contesto corrente (documento o frame)."""
        browser = self.ctx.browser
        try:
            trovati = browser.execute_js(_SCAN_JS) or []
        except Exception as e:
            self.log(f"Scan {contesto} fallito: {e}")
            return []
        for t in trovati:
            t["contesto"] = contesto
        if trovati:
            self.log(f"  {contesto}: {len(trovati)} campi a tema telefono")
        return trovati

    def _filtra_numeri(self, candidati: list[dict]) -> list[dict]:
        """Tiene solo i candidati il cui valore contiene un numero italiano
        valido, deduplicati sul numero normalizzato."""
        visti: set[str] = set()
        validi: list[dict] = []
        for cand in candidati:
            valore = str(cand.get("valore", ""))
            for regex, tipo in ((RE_MOBILE, "mobile"), (RE_FISSO, "fisso")):
                for m in regex.finditer(valore):
                    numero = self._normalizza_numero(m.group(0))
                    if numero in visti:
                        continue
                    visti.add(numero)
                    validi.append({
                        "numero": numero,
                        "tipo": tipo,
                        "campo": cand.get("campo", ""),
                        "etichetta": cand.get("etichetta", ""),
                        "contesto": cand.get("contesto", ""),
                    })
        return validi

    def _fallback_testo_body(self) -> list[dict]:
        """Ultimo tentativo: regex mobile sul testo del body di ogni contesto."""
        browser = self.ctx.browser
        visti: set[str] = set()
        trovati: list[dict] = []

        contesti: list[tuple[str, int | None]] = [("main", None)]
        try:
            browser.switch_to_default()
            contesti += [(f"frame_{i}", i)
                         for i in range(browser.get_frame_count())]
        except Exception:
            pass

        for nome, frame_idx in contesti:
            try:
                browser.switch_to_default()
                if frame_idx is not None:
                    browser.switch_to_frame(frame_idx)
                testo = browser.execute_js(_BODY_TEXT_JS) or ""
            except Exception:
                continue
            for m in RE_MOBILE.finditer(testo):
                numero = self._normalizza_numero(m.group(0))
                if numero in visti:
                    continue
                visti.add(numero)
                trovati.append({
                    "numero": numero,
                    "tipo": "mobile",
                    "campo": "body_text",
                    "etichetta": "",
                    "contesto": nome,
                })
        browser.switch_to_default()
        return trovati

    @staticmethod
    def _normalizza_numero(raw: str) -> str:
        """Normalizza un numero: via separatori e prefisso +39."""
        numero = re.sub(r"[\s./-]", "", raw)
        if numero.startswith("+39"):
            numero = numero[3:]
        return numero

    @staticmethod
    def _scegli_migliore(telefoni: list[dict]) -> str:
        """Sceglie il numero migliore: prima i mobili, poi i fissi,
        a parita' l'ordine di scoperta (campi a tema prima del body)."""
        for t in telefoni:
            if t["tipo"] == "mobile":
                return t["numero"]
        return telefoni[0]["numero"]
