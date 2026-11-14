#!/usr/bin/env python3
"""Test PURI della descrizione anonima dell'elenco (elenco_struttura.json).

Niente browser vero, niente portale, niente rete: griglie SINTETICHE con
nomi, indirizzi, telefoni, codici, date e note inventati, e un browser
FINTO che risponde agli script della pagina. Verifica che:
- le colonne di stato/categoria siano riconosciute e contate;
- nomi, indirizzi, telefoni, codici, date e note non compaiano MAI nel file;
- le intestazioni siano tenute solo se riconosciute con sicurezza;
- i filtri non riportino mai i valori scritti, e i menu a tendina siano in
  chiaro solo se corti e non elencano persone;
- il controllo finale rifiuti telefoni, email e dati delle pratiche;
- un errore nella descrizione non fermi la lettura dell'elenco;
- il ciclo del servizio scriva il file (adapter e browser finti).

Esecuzione:
    python test_struttura_elenco.py
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import types
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

# prelios.py importa browser.py, che richiede Selenium: nei test basta un
# segnaposto (il browser vero non viene mai usato).
try:
    import browser  # noqa: F401
except ImportError:
    finto = types.ModuleType("browser")
    finto.PreliosBrowser = object
    sys.modules["browser"] = finto

import prelios  # noqa: E402
import struttura_elenco as se  # noqa: E402
from bridge_cache import BridgeCache  # noqa: E402
from bridge_server import BridgeState  # noqa: E402
from excel_pratiche import parse_grid_rows  # noqa: E402
from portals import PreliosAdapter  # noqa: E402
from servizio import _Servizio  # noqa: E402

HEADER = ["Stato", "", "Cod. Immobile", "Fase", "", "", "Progetto", "NDG",
          "Tipologia", "", "", "Intestatario", "Indirizzo", "N.Civ.",
          "Comune", "Prov.", "", "Data", "Note"]

# Dati personali INVENTATI: non devono mai comparire nel file
NOMI = ["ROSSI MARIO", "VERDI ANNA", "BIANCHI LUIGI", "NERI PAOLA"]
VIE = ["VIA GARIBALDI", "CORSO CAVOUR", "VIA MAZZINI", "PIAZZA DUOMO"]
STATI = ["ASSEGNATA", "SOPRALLUOGO FISSATO", "SOPRALLUOGO ESEGUITO"]
FASI = ["DA CONTATTARE", "APPUNTAMENTO", "CHIUSA"]
COMUNI = ["PAVIA", "VIGEVANO"]


def riga(i: int, tipologia: str = "FULL - Acquisto") -> list[str]:
    """Riga dati nel layout dell'export (Tipologia in colonna 8)."""
    return [STATI[i % 3], "", str(515100 + i), FASI[i % 3], "", "", "PROGETTO X",
            f"88{i:08d}", tipologia, "0", "0", NOMI[i % 4], VIE[i % 4], str(i + 1),
            COMUNI[i % 2], "PV", "", f"{(i % 28) + 1:02d}/07/2026",
            f"Rif. Gestore: FONTANA MARCO 34876543{i:02d} marco{i}@banca.example"]


def griglia(n: int = 12, con_header: bool = True) -> list[list[str]]:
    rows = [["Elenco Perizie"]]
    if con_header:
        rows.append(HEADER)
    rows += [riga(i, "FULL - Acquisto" if i % 4 else "FULL - Surroga") for i in range(n)]
    rows += [["<", "1", "2", ">"], ["Totale righe: 12"]]
    return rows


def segreti(rows: list[list[str]]) -> list[str]:
    """Tutti i testi personali presenti nella griglia sintetica."""
    out: list[str] = []
    for r in rows:
        if len(r) == len(HEADER) and r is not HEADER and r[0] != "Stato":
            out += [r[2], r[7], r[11], r[12], r[14], r[17], r[18]]
    out += ["FONTANA", "@banca", "34876543", "515100", "/07/2026"]
    return out


def assert_nessun_segreto(testo: str, lista: list[str]) -> None:
    for s in lista:
        assert s not in testo, f"dato personale nel file: {s!r}"


FILTRI = [
    {"origine": "frame_0", "id": "Imm_ky", "name": "Imm_ky", "tipo": "text",
     "etichetta": "Cod. Immobile", "vuoto": True, "visibile": True},
    # Anche se il raccoglitore passasse un valore, non deve finire nel file
    {"origine": "frame_0", "id": "txtNominativo", "name": "Nom", "tipo": "text",
     "etichetta": "Nominativo", "vuoto": False, "value": "SEGRETO ROSSI", "visibile": True},
    {"origine": "frame_0", "id": "cboStato", "name": "Stato", "tipo": "select",
     "etichetta": "Stato perizia", "n_opzioni": 4,
     "opzioni": ["Tutti", "Assegnata", "Sopralluogo fissato", "Eseguita"],
     "indice_selezionato": 0, "visibile": True},
    {"origine": "frame_0", "id": "cboPerito", "name": "Perito", "tipo": "select",
     "etichetta": "Perito", "n_opzioni": 3,
     "opzioni": ["", "ROSSI MARIO", "GALLO MARTA"], "indice_selezionato": 1,
     "visibile": True},
    {"origine": "frame_0", "id": "cboAnno", "name": "Anno", "tipo": "select",
     "etichetta": "Periodo", "n_opzioni": 3,
     "opzioni": ["2024", "2025", "2026"], "indice_selezionato": 2, "visibile": True},
    {"origine": "frame_0", "id": "cboTanti", "name": "Prov", "tipo": "select",
     "etichetta": "Provincia", "n_opzioni": 20,
     "opzioni": [f"P{chr(65 + i)}" for i in range(20)], "indice_selezionato": 0,
     "visibile": True},
    {"origine": "frame_0", "id": "chkSoloMie", "name": "SoloMie", "tipo": "checkbox",
     "etichetta": "Solo le mie", "selezionato": True, "visibile": True},
    {"origine": "main", "id": "chk_515077", "name": "sel_515077", "tipo": "checkbox",
     "etichetta": "", "selezionato": False, "visibile": True},
]


def info_finta(th=None, controlli=None) -> dict:
    return {"pagine": 1,
            "controlli_paginazione": [{"tag": "A", "text": "successiva", "origine": "frame_0"}],
            "pagina": {"th": th or [], "controlli": controlli if controlli is not None else FILTRI,
                       "controlli_in_griglia": 12, "origini": 2}}


def descrivi(rows, info=None) -> dict:
    stats: dict = {}
    parse_grid_rows(rows, stats=stats)
    return se.descrivi_elenco(rows, stats, info or info_finta())


# ---------------------------------------------------------------------------

def test_categorie_riconosciute() -> None:
    rows = griglia()
    d = descrivi(rows)
    col = {c["posizione"]: c for c in d["colonne"]}
    assert d["colonna_tipologia"] == 8
    assert col[0]["categorie"] == {"ASSEGNATA": 4, "SOPRALLUOGO FISSATO": 4,
                                   "SOPRALLUOGO ESEGUITO": 4}, col[0]
    assert col[3]["categorie"] == {"DA CONTATTARE": 4, "APPUNTAMENTO": 4, "CHIUSA": 4}
    assert col[8]["categorie"] == {"FULL - Acquisto": 9, "FULL - Surroga": 3}
    assert col[0]["intestazione"] == "Stato" and col[8]["intestazione"] == "Tipologia"
    # Nome (4 valori ripetuti!) e comune: colonne del cliente, mai in chiaro
    assert col[11]["categorie"] is None and col[11]["valori_diversi"] == 4
    assert col[14]["categorie"] is None
    assert set(col[11]["forma_prevalente"]) <= {"x", " "}
    # Codice, NDG, data, note: solo forme
    assert col[2]["categorie"] is None and col[2]["forma_prevalente"] == "999999"
    assert col[17]["categorie"] is None and col[17]["forma_prevalente"] == "99/99/9999"
    assert col[18]["categorie"] is None and col[18]["forma_prevalente"].endswith("…")
    c = d["conteggi"]
    assert c["righe_lette"] == len(rows) and c["righe_con_tipologia"] == 12
    assert c["pratiche_full_acquisto"] == 9 and c["pagine_lette"] == 1
    assert d["paginazione"]["controlli_riconosciuti"][0]["testo"] == "successiva"
    print("OK test_categorie_riconosciute")


def test_nessun_dato_personale() -> None:
    rows = griglia()
    d = descrivi(rows)
    testo = json.dumps(d, ensure_ascii=False)
    assert_nessun_segreto(testo, segreti(rows) + ["SEGRETO", "GALLO MARTA"])
    assert "ROSSI" not in testo and "PAVIA" not in testo and "VIGEVANO" not in testo
    # e il controllo finale lo conferma
    pratiche = parse_grid_rows(rows)
    assert se.controllo_sicurezza(d, se.valori_pratiche(pratiche, ["+393331234567"])) == []
    print("OK test_nessun_dato_personale")


def test_poche_righe_niente_categorie() -> None:
    d = descrivi(griglia(n=3))
    assert all(c["categorie"] is None for c in d["colonne"])
    print("OK test_poche_righe_niente_categorie")


def test_intestazioni_solo_se_affidabili() -> None:
    # 1. riga di intestazione con "Tipologia" sopra la Tipologia: tenuta
    d = descrivi(griglia())
    assert d["intestazioni"] == HEADER
    # 2. nessuna intestazione: lista vuota con il motivo
    d = descrivi(griglia(con_header=False))
    assert d["intestazioni"] == [] and "nessuna" in d["intestazioni_come"]
    # 3. riga simile ma "Tipologia" spostata: NON tenuta
    sbagliata = list(HEADER)
    sbagliata[8], sbagliata[9] = "", "Tipologia"
    rows = [sbagliata] + griglia(con_header=False)
    assert descrivi(rows)["intestazioni"] == []
    # 4. celle <th> con lo stesso numero di colonne: tenute
    th = [{"celle": HEADER, "n_celle_dati": len(HEADER), "col_tipologia_dati": 8}]
    d = descrivi(griglia(con_header=False), info_finta(th=th))
    assert d["intestazioni"] == HEADER and "<th>" in d["intestazioni_come"]
    # 5. <th> che non corrispondono alla griglia (altre tabelle): scartate
    th = [{"celle": ["Menu", "Aiuto"], "n_celle_dati": None, "col_tipologia_dati": None}]
    assert descrivi(griglia(con_header=False), info_finta(th=th))["intestazioni"] == []
    # 6. <th> con un testo lungo o un dato (nome di una pratica): scartate
    lunga = list(HEADER)
    lunga[18] = "Note del gestore con un testo molto lungo che non è un titolo"
    th = [{"celle": lunga, "n_celle_dati": len(HEADER), "col_tipologia_dati": 8}]
    assert descrivi(griglia(con_header=False), info_finta(th=th))["intestazioni"] == []
    con_nome = list(HEADER)
    con_nome[0] = "ROSSI MARIO"
    th = [{"celle": con_nome, "n_celle_dati": len(HEADER), "col_tipologia_dati": 8}]
    assert descrivi(griglia(con_header=False), info_finta(th=th))["intestazioni"] == []
    print("OK test_intestazioni_solo_se_affidabili")


def test_filtri() -> None:
    d = descrivi(griglia())
    f = {x["id"]: x for x in d["filtri"]}
    assert f["Imm_ky"] == {"origine": "frame_0", "id": "Imm_ky", "name": "Imm_ky",
                           "tipo": "text", "visibile": True, "etichetta": "Cod. Immobile",
                           "vuoto": True}
    assert f["txtNominativo"]["vuoto"] is False and "value" not in f["txtNominativo"]
    stato = f["cboStato"]
    assert stato["opzioni"] == ["Tutti", "Assegnata", "Sopralluogo fissato", "Eseguita"]
    assert stato["selezionata"] == "Tutti" and stato["n_opzioni"] == 4
    perito = f["cboPerito"]
    assert "opzioni" not in perito and perito["forme_opzioni"] == ["", "xxxxx xxxxx", "xxxxx xxxxx"]
    assert perito["forma_selezionata"] == "xxxxx xxxxx"
    anno = f["cboAnno"]
    assert "opzioni" not in anno and anno["forme_opzioni"] == ["9999", "9999", "9999"]
    tanti = f["cboTanti"]
    assert "opzioni" not in tanti and len(tanti["forme_opzioni"]) == se.OPZIONI_MAX
    assert f["chkSoloMie"]["selezionato"] is True and "vuoto" not in f["chkSoloMie"]
    assert "chk_#" in f and f["chk_#"]["name"] == "sel_#"
    testo = json.dumps(d["filtri"], ensure_ascii=False)
    assert "SEGRETO" not in testo and "515077" not in testo and "2026" not in testo
    print("OK test_filtri")


def test_controllo_sicurezza() -> None:
    base = descrivi(griglia())
    pratiche = parse_grid_rows(griglia())
    vietati = se.valori_pratiche(pratiche, ["+393331234567"])
    assert se.controllo_sicurezza(base, vietati) == []

    def con(chiave_valore) -> list[str]:
        d = json.loads(json.dumps(base))
        d["note"].append(chiave_valore)
        return se.controllo_sicurezza(d, vietati)

    assert con("chiamare 3331234567") and "6 o più cifre" in con("tel 3331234567")[0]
    assert "chiocciola" in con("scrivere a mario@banca.example")[0]
    assert "dato di una pratica" in con("Verdi Anna")[0]
    assert "dato di una pratica" in con("corso cavour")[0]
    assert con(pratiche[0].note_gestore)
    # Un dato della pratica come categoria (chiave di un dizionario)
    d = json.loads(json.dumps(base))
    d["colonne"][0]["categorie"] = {"NERI PAOLA": 5}
    assert se.controllo_sicurezza(d, vietati)
    # Telefono noto solo dalla cache, scritto senza +39
    d = json.loads(json.dumps(base))
    d["note"].append("33312 34567")
    assert se.controllo_sicurezza(d, se.valori_pratiche([], ["+393331234567"])) == []
    d["note"].append("3331234567")
    assert se.controllo_sicurezza(d, se.valori_pratiche([], ["+393331234567"]))
    # Le forme possono avere tanti 9, ma solo x/9/punteggiatura
    d = json.loads(json.dumps(base))
    d["colonne"][0]["forma_prevalente"] = "9999999999"
    assert se.controllo_sicurezza(d, vietati) == []
    d["colonne"][0]["forma_prevalente"] = "ROSSI 3331234567"
    assert se.controllo_sicurezza(d, vietati)

    # scrivi_struttura: rifiuta e NON scrive
    tmp = Path(tempfile.mkdtemp(prefix="test_struttura_")) / se.NOME_FILE
    d = json.loads(json.dumps(base))
    d["note"].append("mario@banca.example")
    assert se.scrivi_struttura(tmp, d, vietati) and not tmp.exists()
    assert se.scrivi_struttura(tmp, base, vietati) == [] and tmp.exists()
    assert json.loads(tmp.read_text(encoding="utf-8"))["conteggi"]["righe_con_tipologia"] == 12
    print("OK test_controllo_sicurezza")


# ---------------------------------------------------------------------------
# Browser finto per prelios.list_assigned
# ---------------------------------------------------------------------------

class BrowserFinto:
    """Risponde agli script di prelios.py: griglia, paginazione, struttura."""

    def __init__(self, rows, struttura=None, struttura_errore=False):
        self.rows = rows
        self.struttura = struttura
        self.struttura_errore = struttura_errore
        self.script: list[str] = []
        self.is_running = True
        self.current_url = "https://perizie.prelios.com/x"

    def switch_to_default(self):
        pass

    def switch_to_frame(self, i):
        pass

    def get_frame_count(self):
        return 0

    def wait(self, s):
        pass

    def execute_js(self, js, *args):
        self.script.append(js)
        if js is prelios._JS_GRID_ROWS:
            return {"rows": self.rows, "layout_rows": 0, "tables": 1}
        if js is prelios._JS_FIND_NEXT:
            return [] if not args else "skip"
        if js is prelios._JS_STRUTTURA_PAGINA:
            if self.struttura_errore:
                raise RuntimeError("script fallito")
            return self.struttura
        if "Imm_ky" in js:
            return "Imm_ky"
        return "navigated"


def test_list_assigned_raccoglie_struttura() -> None:
    rows = griglia()
    struttura = {"th": [], "controlli": FILTRI, "controlli_in_griglia": 3}
    b = BrowserFinto(rows, struttura)
    info: dict = {}
    righe = prelios.list_assigned(b, log=lambda *_: None, info=info)
    assert righe == rows
    assert info["pagine"] == 1 and info["controlli_paginazione"] == []
    assert len(info["pagina"]["controlli"]) == len(FILTRI)
    assert info["pagina"]["controlli"][0]["origine"] == "main"
    # Lo script della struttura è di sola lettura: niente click, niente valori scritti
    js = prelios._JS_STRUTTURA_PAGINA
    assert ".click(" not in js and ".value =" not in js and "dispatchEvent" not in js
    print("OK test_list_assigned_raccoglie_struttura")


def test_errore_descrizione_non_ferma_elenco() -> None:
    log: list[str] = []
    # 1. lo script della pagina fallisce: l'elenco si legge lo stesso
    b = BrowserFinto(griglia(), struttura_errore=True)
    a = PreliosAdapter()
    pratiche = a.list_assigned(b, log=log.append)
    assert len(pratiche) == 9
    assert a.descrizione_elenco()["filtri"] == []
    # 2. la costruzione della descrizione fallisce: elenco intatto, descrizione None
    originale = se.descrivi_elenco

    def rotta(*_a, **_k):
        raise ValueError("descrizione rotta")

    se.descrivi_elenco = rotta
    try:
        pratiche = a.list_assigned(BrowserFinto(griglia(), {}), log=log.append)
    finally:
        se.descrivi_elenco = originale
    assert len(pratiche) == 9 and a.descrizione_elenco() is None
    assert any("descrizione dell'elenco non preparata" in r for r in log)
    print("OK test_errore_descrizione_non_ferma_elenco")


# ---------------------------------------------------------------------------
# Ciclo del servizio
# ---------------------------------------------------------------------------

class AdapterFinto(PreliosAdapter):
    """PreliosAdapter vero per l'elenco (con browser finto), telefoni finti."""

    def is_logged_in(self, browser) -> bool:
        return True

    def enrich(self, browser, p, log=print):
        return "+393331234567", "OK", ""


def _servizio(adapter, browser):
    tmp = Path(tempfile.mkdtemp(prefix="test_struttura_servizio_"))
    args = SimpleNamespace(elenco=None, limit=0, interval=30)
    s = _Servizio(args, adapter, BridgeCache(tmp / "bridge_cache.json"), BridgeState())
    s.browser = browser
    s.percorso_struttura = tmp / se.NOME_FILE
    return s


def _ciclo(s) -> tuple[str, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        esito = s.ciclo()
    return esito, buf.getvalue()


def test_servizio_scrive_file() -> None:
    rows = griglia()
    s = _servizio(AdapterFinto(), BrowserFinto(rows, {"th": [], "controlli": FILTRI}))
    esito, out = _ciclo(s)
    assert esito == "ok", out
    assert s.percorso_struttura.exists()
    testo = s.percorso_struttura.read_text(encoding="utf-8")
    assert_nessun_segreto(testo, segreti(rows) + ["SEGRETO", "+39333"])
    d = json.loads(testo)
    assert d["conteggi"]["pratiche_full_acquisto"] == 9
    assert ("Elenco letto: 9 pratiche FULL - Acquisto su 16 righe (descrizione "
            "dell'elenco salvata in elenco_struttura.json, senza dati dei clienti)") in out, out
    # Secondo ciclo: il file viene riscritto (telefoni ora in cache)
    prima = d["quando"]
    esito, out = _ciclo(s)
    assert esito == "ok" and "salvata in elenco_struttura.json" in out
    assert json.loads(s.percorso_struttura.read_text(encoding="utf-8"))["quando"] >= prima
    print("OK test_servizio_scrive_file")


def test_servizio_errori_descrizione_non_fermano_ciclo() -> None:
    # descrizione che solleva
    a = AdapterFinto()
    a.descrizione_elenco = lambda: (_ for _ in ()).throw(RuntimeError("guasto"))
    s = _servizio(a, BrowserFinto(griglia(), {}))
    esito, out = _ciclo(s)
    assert esito == "ok" and "descrizione dell'elenco non salvata" in out, out
    assert not s.percorso_struttura.exists()
    assert len(s.state.snapshot()["pratiche"]) == 9
    # descrizione con un dato personale: rifiutata dal controllo finale
    a = AdapterFinto()
    lista = a.list_assigned

    def con_dato(browser, log=print):
        pratiche = lista(browser, log=log)
        a._descrizione["note"].append("ROSSI MARIO")
        return pratiche

    a.list_assigned = con_dato
    s = _servizio(a, BrowserFinto(griglia(), {}))
    esito, out = _ciclo(s)
    assert esito == "ok" and "NON salvata" in out, out
    assert not s.percorso_struttura.exists()
    # cartella non scrivibile: il ciclo prosegue
    s = _servizio(AdapterFinto(), BrowserFinto(griglia(), {}))
    s.percorso_struttura = s.percorso_struttura.parent / "manca" / se.NOME_FILE
    esito, out = _ciclo(s)
    assert esito == "ok" and "non salvata" in out, out
    print("OK test_servizio_errori_descrizione_non_fermano_ciclo")


def main() -> int:
    test_categorie_riconosciute()
    test_nessun_dato_personale()
    test_poche_righe_niente_categorie()
    test_intestazioni_solo_se_affidabili()
    test_filtri()
    test_controllo_sicurezza()
    test_list_assigned_raccoglie_struttura()
    test_errore_descrizione_non_ferma_elenco()
    test_servizio_scrive_file()
    test_servizio_errori_descrizione_non_fermano_ciclo()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
