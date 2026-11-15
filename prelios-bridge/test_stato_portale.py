#!/usr/bin/env python3
"""Test PURI dello stato delle perizie sul portale (stato_portale.py e dintorni).

Niente browser vero, niente portale, niente rete. Le griglie riproducono la
STRUTTURA vera dell'Elenco Perizie (le 32 intestazioni, prese dalla
descrizione anonima elenco_struttura.json) ma TUTTI i dati sono INVENTATI:
nomi, indirizzi, codici, date, note e telefoni (+3902555...). Anche gli id
dei campi della pagina della perizia usati qui (txtNotaSospensione,
cboMotivoSosp, ...), i nomi di funzione (apriStati, vaiPagina, riattiva) e
le voci del menu «Stato Perizia» sono INVENTATI: quelli veri non li
conosciamo. Le intestazioni della griglia «Sospesi» sono quelle viste nel
video del portale; i dati delle righe sono finti.

Copre:
- la tabella delle fasi (tutti i rami e le precedenze, con e senza la
  ricerca delle sospese: la riattivata con una data di Sospensione vecchia
  è da fissare) e i testi di stato;
- date non valide (campi assenti, mai errori);
- intestazioni in ordine diverso, mancanti, righe non allineate;
- elenchi da file (TSV/Excel) con e senza quelle intestazioni;
- i campi nuovi dello snapshot e la cache vecchia (versione 1) che si carica;
- quali perizie aprire e le riletture della nota di sospensione;
- il ciclo del servizio (adapter finto) e l'adapter Prelios (funzioni finte);
- «Max Righe» e la seconda ricerca delle sospese (portale finto);
- la nota dalla pagina «Sospesi» (griglia finta) e i dati di chi ha
  sospeso che non escono mai (log, cache, snapshot, descrizione);
- la descrizione anonima estesa (contenuto e chiamate delle celle, link
  delle pagine, menu di stato, Trovati, sezione "perizia") e il suo
  controllo di sicurezza.

Esecuzione:
    python test_stato_portale.py
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import types
from datetime import date, datetime, timedelta, timezone
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
import stato_portale as sp  # noqa: E402
import struttura_elenco as se  # noqa: E402
from bridge_cache import BridgeCache, VERSIONE_LETTURA_SOSPENSIONE  # noqa: E402
from bridge_server import BridgeState  # noqa: E402
from excel_pratiche import Pratica, load_pratiche, parse_grid_rows, parse_rows  # noqa: E402
from portals import PortalAdapter, PreliosAdapter  # noqa: E402
from servizio import MSG_NOTA_NON_TROVATA, _Servizio  # noqa: E402

OGGI = date(2026, 11, 14)

# Le 32 intestazioni dell'Elenco Perizie (struttura vera, nessun dato)
HEADER = ["VT", "E.Sp.", "ID Imm.", "App 1", "App 2", "App 3", "Committente",
          "ID Perizia", "Tipo Perizia", "GG", "GG Totali", "Intestatario", "Indirizzo",
          "N.Civ.", "Comune", "Prov.", "Conclusa", "Assegnata", "Sopralluogo", "Valutata",
          "Data Inserita", "CM - Inserita", "Perizia (Rif.1)", "Perizia (Rif.2)",
          "Perizia (Rif.3)", "Perizia (Rif.4)", "Sospesa", "Revoca", "Inserita",
          "Sospensione", "Inoltrata Perizia", "Note"]
COL = {nome: i for i, nome in enumerate(HEADER)}

# Dati INVENTATI
NOMI = ["ROSSI MARIO", "VERDI ANNA", "BIANCHI LUIGI", "NERI PAOLA", "GALLO MARTA"]
VIE = ["VIA GARIBALDI", "CORSO CAVOUR", "VIA MAZZINI", "PIAZZA DUOMO", "VIA ROMA"]


def riga(i: int, tipologia: str = "FULL - Acquisto", **date_stato: str) -> list[str]:
    """Riga dati con le 32 colonne; date_stato: Conclusa=..., Sopralluogo=...
    (chiavi = intestazioni senza spazi né punti, vedi _CHIAVI)."""
    r = [""] * len(HEADER)
    r[COL["ID Imm."]] = str(700100 + i)
    r[COL["Committente"]] = "01-23456 (BANCA DI PROVA)"
    r[COL["ID Perizia"]] = f"11112222333344{i:02d} - 5555666677778888"
    r[COL["Tipo Perizia"]] = tipologia
    r[COL["GG"]], r[COL["GG Totali"]] = "1", "2"
    r[COL["Intestatario"]] = NOMI[i % len(NOMI)]
    r[COL["Indirizzo"]] = VIE[i % len(VIE)]
    r[COL["N.Civ."]] = str(i + 1)
    r[COL["Comune"]] = "PAVIA" if i % 2 else "VIGEVANO"
    r[COL["Prov."]] = "PV"
    r[COL["Assegnata"]] = "02/11/2026"
    r[COL["Data Inserita"]] = r[COL["CM - Inserita"]] = r[COL["Inserita"]] = "01/11/2026"
    r[COL["Perizia (Rif.1)"]] = f"99990000111122{i:02d}"
    r[COL["Note"]] = f"Rif. Gestore: FONTANA MARCO 3902555{i:04d} gestore{i}@banca.example"
    for chiave, valore in date_stato.items():
        r[COL[_CHIAVI[chiave]]] = valore
    return r


_CHIAVI = {"Conclusa": "Conclusa", "Sopralluogo": "Sopralluogo", "Valutata": "Valutata",
           "Sospesa": "Sospesa", "Revoca": "Revoca", "Sospensione": "Sospensione",
           "Inoltrata": "Inoltrata Perizia"}


def griglia_mista() -> list[list[str]]:
    """Header + una riga per ogni caso; codici 700100.. nell'ordine."""
    return [
        ["Elenco Perizie"],
        HEADER,
        riga(0),                                                 # da_fissare
        riga(1, Sopralluogo="20/11/2026"),                       # fissato
        riga(2, Sopralluogo="14/11/2026"),                       # fissato (oggi)
        riga(3, Sopralluogo="10/11/2026"),                       # effettuato
        riga(4, Valutata="12/11/2026"),                          # effettuato
        riga(5, Conclusa="13/11/2026", Sopralluogo="01/11/2026"),  # chiusa
        riga(6, Sospensione="10/11/2026"),                       # sospesa
        riga(7, Sospesa="X"),                                    # sospesa senza data
        riga(8, Inoltrata="11/11/2026"),                         # chiusa
        riga(9, Revoca="X"),                                     # chiusa
        riga(10, tipologia="FULL - Surroga", Sopralluogo="20/11/2026"),  # altra tipologia
        ["<", "1", ">"],
    ]


# ---------------------------------------------------------------------------
# Fase e stato
# ---------------------------------------------------------------------------

def test_tabella_fasi() -> None:
    f = lambda **v: sp.fase(v, OGGI)  # noqa: E731
    assert f() == "da_fissare"
    assert f(sopralluogo="20/11/2026") == "fissato"
    assert f(sopralluogo="14/11/2026") == "fissato"              # oggi
    assert f(sopralluogo="13/11/2026") == "effettuato"           # ieri
    assert f(valutata="12/11/2026") == "effettuato"
    assert f(valutata="x") == "effettuato"                       # non vuota basta
    assert f(sospensione="10/11/2026") == "sospesa"
    assert f(sospesa="icona") == "sospesa"
    for k in ("conclusa", "inoltrata", "revoca"):
        assert f(**{k: "qualcosa"}) == "chiusa", k
    # Precedenze: chiusa > effettuato > fissato > sospesa > da_fissare
    assert f(conclusa="01/11/2026", valutata="01/11/2026", sopralluogo="20/11/2026",
             sospensione="01/11/2026") == "chiusa"
    assert f(revoca="X", sopralluogo="20/11/2026") == "chiusa"
    assert f(valutata="12/11/2026", sopralluogo="20/11/2026", sospensione="10/11/2026") == "effettuato"
    assert f(sopralluogo="10/11/2026", sospensione="01/11/2026") == "effettuato"
    assert f(sopralluogo="20/11/2026", sospensione="01/11/2026", sospesa="X") == "fissato"
    assert f(sospensione="01/11/2026", sospesa="X") == "sospesa"
    # Spazi soli = vuoto; date in altri formati
    assert f(conclusa="   ", sospensione=" \t") == "da_fissare"
    assert f(sopralluogo="20.11.2026") == "fissato"
    assert f(sopralluogo="2026-11-20") == "fissato"
    assert f(sopralluogo="20/11/2026 10:30") == "fissato"
    assert f(sopralluogo=datetime(2026, 11, 13, 9, 0)) == "effettuato"   # cella Excel
    # La data di riferimento è un parametro
    assert sp.fase({"sopralluogo": "20/11/2026"}, date(2026, 11, 21)) == "effettuato"
    assert sp.FASI_DA_NON_APRIRE == {"fissato", "effettuato", "chiusa"}
    # Con la ricerca delle sospese: conta SOLO quella (sospesa_ora True/False)
    g = lambda ora, **v: sp.fase(v, OGGI, ora)  # noqa: E731
    assert g(True) == "sospesa"
    assert g(False, sospensione="01/10/2026", sospesa="X") == "da_fissare"   # riattivata
    assert g(True, sopralluogo="20/11/2026") == "fissato"                  # date prima
    assert g(True, conclusa="01/11/2026") == "chiusa"
    assert g(True, valutata="01/11/2026") == "effettuato"
    print("OK test_tabella_fasi")


def test_testi_di_stato() -> None:
    s = lambda **v: sp.stato_perizia(v, OGGI)  # noqa: E731
    assert s() == {"fase": "da_fissare", "stato": "", "data_sopralluogo": "",
                   "data_sospensione": ""}
    assert s(conclusa="13/11/2026")["stato"] == "Conclusa il 13/11/2026"
    assert s(inoltrata="11/11/2026")["stato"] == "Perizia inoltrata il 11/11/2026"
    assert s(revoca="X")["stato"] == "Revocata"
    assert s(conclusa="13/11/2026", inoltrata="11/11/2026")["stato"].startswith("Conclusa")
    assert s(valutata="12/11/2026")["stato"] == "Valutata il 12/11/2026"
    r = s(sopralluogo="10/11/2026")
    assert r == {"fase": "effettuato", "stato": "Sopralluogo del 10/11/2026",
                 "data_sopralluogo": "2026-11-10", "data_sospensione": ""}
    r = s(sopralluogo="1/12/2026")
    assert r["stato"] == "Sopralluogo fissato per il 01/12/2026"
    assert r["data_sopralluogo"] == "2026-12-01"
    r = s(sospensione="10/11/2026")
    assert r["stato"] == "Sospesa dal 10/11/2026" and r["data_sospensione"] == "2026-11-10"
    assert s(sospesa="X")["stato"] == "Sospesa" and s(sospesa="X")["data_sospensione"] == ""
    # data di sopralluogo nota anche quando la perizia è chiusa
    assert s(conclusa="13/11/2026", sopralluogo="01/11/2026")["data_sopralluogo"] == "2026-11-01"
    # data di sospensione SOLO con fase sospesa
    assert s(sopralluogo="20/11/2026", sospensione="10/11/2026")["data_sospensione"] == ""
    assert all(len(s(**{k: "13/11/2026"})["stato"]) <= sp.STATO_MAX
               for k in ("conclusa", "valutata", "sospensione", "inoltrata"))
    print("OK test_testi_di_stato")


def test_date_non_valide() -> None:
    for brutta in ("31/02/2026", "99/99/9999", "ieri", "20/11", "2026-13-01", "//", None, 7):
        assert sp.leggi_data(brutta) is None, brutta
    # Conclusa con testo non valido: chiusa ma senza data
    r = sp.stato_perizia({"conclusa": "boh"}, OGGI)
    assert r["fase"] == "chiusa" and r["stato"] == "Conclusa"
    # Sopralluogo non valido: ignorato (nessuna data, regole successive)
    r = sp.stato_perizia({"sopralluogo": "31/02/2026"}, OGGI)
    assert r == {"fase": "da_fissare", "stato": "", "data_sopralluogo": "", "data_sospensione": ""}
    r = sp.stato_perizia({"sopralluogo": "da definire", "sospensione": "31/13/2026"}, OGGI)
    assert r["fase"] == "sospesa" and r["stato"] == "Sospesa" and r["data_sospensione"] == ""
    r = sp.stato_perizia({"valutata": "32/01/2026"}, OGGI)
    assert r["fase"] == "effettuato" and r["stato"] == "Valutata"
    print("OK test_date_non_valide")


# ---------------------------------------------------------------------------
# Griglia del portale e file
# ---------------------------------------------------------------------------

def _per_codice(pratiche: list[Pratica]) -> dict[str, Pratica]:
    return {p.codice: p for p in pratiche}


def test_griglia_con_stato() -> None:
    stats: dict = {}
    pr = _per_codice(parse_grid_rows(griglia_mista(), stats=stats, oggi=OGGI))
    assert stats["colonne_stato"] == "" and stats["senza_stato"] == 0, stats
    assert "700110" not in pr                                    # Surroga esclusa
    attese = {"700100": "da_fissare", "700101": "fissato", "700102": "fissato",
              "700103": "effettuato", "700104": "effettuato", "700105": "chiusa",
              "700106": "sospesa", "700107": "sospesa", "700108": "chiusa",
              "700109": "chiusa"}
    assert {c: p.fase for c, p in pr.items()} == attese
    assert pr["700101"].data_sopralluogo == "2026-11-20"
    assert pr["700101"].stato == "Sopralluogo fissato per il 20/11/2026"
    assert pr["700106"].data_sospensione == "2026-11-10"
    assert pr["700100"].stato == "" and pr["700100"].data_sopralluogo == ""
    # I campi di sempre non cambiano
    assert pr["700100"].intestatario == "ROSSI MARIO" and pr["700100"].comune == "VIGEVANO"
    assert sp.riga_conteggi(p.fase for p in pr.values()) == (
        "Stato sul portale: 2 con sopralluogo fissato, 5 già fatte o chiuse, "
        "2 sospese, 1 da fissare")
    print("OK test_griglia_con_stato")


def test_intestazioni_in_altro_ordine() -> None:
    """Le colonne si trovano PER NOME: un ordine diverso non cambia nulla."""
    ordine = list(range(len(HEADER)))
    # scambia Sopralluogo con Conclusa e sposta Sospensione in fondo
    ordine[COL["Sopralluogo"]], ordine[COL["Conclusa"]] = COL["Conclusa"], COL["Sopralluogo"]
    ordine.remove(COL["Sospensione"])
    ordine.append(COL["Sospensione"])

    def perm(r):
        return [r[i] for i in ordine] if len(r) == len(HEADER) else r

    righe = [perm(r) for r in griglia_mista()]
    pr = _per_codice(parse_grid_rows(righe, oggi=OGGI))
    assert pr["700101"].fase == "fissato" and pr["700105"].fase == "chiusa"
    assert pr["700106"].fase == "sospesa" and pr["700103"].fase == "effettuato"
    # Intestazioni scritte diversamente (maiuscole, punti, spazi)
    h = [x.upper().replace(" ", "  ") + "." for x in HEADER]
    righe = [h] + griglia_mista()[2:]
    assert _per_codice(parse_grid_rows(righe, oggi=OGGI))["700101"].fase == "fissato"
    print("OK test_intestazioni_in_altro_ordine")


def test_intestazioni_mancanti() -> None:
    # 1. nessuna riga di intestazioni: nessun campo di stato
    righe = [r for r in griglia_mista() if r is not HEADER and r != HEADER]
    stats: dict = {}
    pr = parse_grid_rows(righe, stats=stats, oggi=OGGI)
    assert len(pr) == 10 and all(p.fase == "" and p.stato == "" for p in pr)
    assert "Tipo Perizia" in stats["colonne_stato"], stats
    # 2. manca la colonna Sospensione: nessun campo di stato, motivo chiaro
    h = list(HEADER)
    h[COL["Sospensione"]] = "Altro"
    stats = {}
    pr = parse_grid_rows([h] + griglia_mista()[2:], stats=stats, oggi=OGGI)
    assert all(p.fase == "" for p in pr) and "Sospensione" in stats["colonne_stato"], stats
    # 3. intestazioni dalle celle <th> passate a parte (non fra le righe)
    stats = {}
    pr = _per_codice(parse_grid_rows(righe, stats=stats, intestazioni=[HEADER], oggi=OGGI))
    assert stats["colonne_stato"] == "" and pr["700101"].fase == "fissato"
    # 4. riga dati non allineata (una cella in più in testa): niente stato per lei
    storta = [""] + riga(11, Sopralluogo="20/11/2026")
    stats = {}
    pr = _per_codice(parse_grid_rows([HEADER, storta, riga(12)], stats=stats, oggi=OGGI))
    assert pr["700111"].fase == "" and pr["700112"].fase == "da_fissare"
    assert stats["senza_stato"] == 1
    print("OK test_intestazioni_mancanti")


def test_file_con_e_senza_stato() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="test_stato_file_"))
    con = tmp / "elenco.tsv"
    con.write_text("\n".join("\t".join(r) for r in griglia_mista()[1:-1]), encoding="utf-8")
    stats: dict = {}
    pr = _per_codice(load_pratiche(con, stats=stats))
    assert stats["colonne_stato"] == ""
    assert pr["700105"].fase == "chiusa" and pr["700106"].stato == "Sospesa dal 10/11/2026"
    assert pr["700100"].fase == "da_fissare"
    # parse_rows con celle Excel (datetime) e oggi esplicito
    righe = [HEADER, riga(0), riga(1)]
    righe[2][COL["Sopralluogo"]] = datetime(2026, 11, 20)
    pr = _per_codice(parse_rows(righe, oggi=OGGI))
    assert pr["700101"].fase == "fissato" and pr["700101"].data_sopralluogo == "2026-11-20"
    # File senza le intestazioni di stato (export vecchio): niente campi
    vecchio = tmp / "vecchio.tsv"
    vecchio.write_text("Cod. Immobile\tTipologia\tIntestatario\tIndirizzo\n"
                       "700200\tFULL - Acquisto\tROSSI MARIO\tVIA ROMA\n", encoding="utf-8")
    stats = {}
    (p,) = load_pratiche(vecchio, stats=stats)
    assert p.fase == "" and stats["colonne_stato"].startswith("mancano"), stats
    # File senza intestazioni: niente campi
    stats = {}
    pr = parse_rows([r for r in griglia_mista() if r != HEADER], stats=stats)
    assert all(p.fase == "" for p in pr) and stats["colonne_stato"]
    print("OK test_file_con_e_senza_stato")


# ---------------------------------------------------------------------------
# Cache e snapshot
# ---------------------------------------------------------------------------

T0 = datetime(2026, 11, 14, 9, 0, tzinfo=timezone.utc)


def _cache() -> BridgeCache:
    return BridgeCache(Path(tempfile.mkdtemp(prefix="test_stato_cache_")) / "bridge_cache.json")


def test_snapshot_campi_nuovi() -> None:
    cache = _cache()
    pr = parse_grid_rows(griglia_mista(), oggi=OGGI)
    cache.aggiorna_elenco("prelios", pr, adesso=T0)
    snap = {r["codice"]: r for r in cache.snapshot("prelios")}
    # da fissare: nessun campo nuovo tranne la fase
    assert snap["700100"]["fase"] == "da_fissare"
    assert not {"stato", "dataSopralluogo", "sospensione"} & set(snap["700100"])
    r = snap["700101"]
    assert r["fase"] == "fissato" and r["stato"] == "Sopralluogo fissato per il 20/11/2026"
    assert r["dataSopralluogo"] == "2026-11-20" and "sospensione" not in r
    r = snap["700106"]
    assert r["fase"] == "sospesa" and r["sospensione"] == {"nota": "", "dal": "2026-11-10"}
    assert snap["700107"]["sospensione"] == {"nota": ""}          # senza data
    # nota letta → nello snapshot
    p6 = _per_codice(pr)["700106"]
    cache.registra_sospensione("prelios", p6, "cliente da richiamare il 20/11", True, adesso=T0)
    assert cache.snapshot("prelios")[6]["sospensione"]["nota"] == "cliente da richiamare il 20/11"
    # tentativo fallito: resta la nota di prima
    cache.registra_sospensione("prelios", p6, "", False, adesso=T0)
    assert cache.snapshot("prelios")[6]["sospensione"]["nota"] == "cliente da richiamare il 20/11"
    # la pratica non è più sospesa: niente sospensione, nota dimenticata
    p6b = Pratica.da_dict(dict(vars(p6), fase="da_fissare", stato="", data_sospensione=""))
    cache.aggiorna_elenco("prelios", [p6b], adesso=T0)
    (r,) = cache.snapshot("prelios")
    assert r["fase"] == "da_fissare" and "sospensione" not in r
    assert "sospensione" not in cache.data["pratiche"]["prelios:700106"]
    # Il server espone i campi così come sono; /v1/health non cambia
    st = BridgeState()
    st.set_pratiche("prelios", cache.snapshot("prelios"))
    assert st.snapshot()["pratiche"][0]["fase"] == "da_fissare"
    assert set(st.salute()) == {"portali", "pratiche", "intervalloMinuti"}
    print("OK test_snapshot_campi_nuovi")


def test_cache_vecchia_si_carica() -> None:
    """Un bridge_cache.json scritto dalla versione precedente (versione 1,
    record senza i campi nuovi) si carica: telefoni conservati, nessun campo
    di stato nello snapshot, le pratiche già risolte non si riaprono."""
    path = Path(tempfile.mkdtemp(prefix="test_stato_vecchia_")) / "bridge_cache.json"
    vecchio = {
        "version": 1,
        "pratiche": {
            "prelios:700100": {
                "portal": "prelios", "telefono": "+390255500001", "esito": "OK",
                "notaContatto": "", "ultimoTentativo": "2026-11-13T09:00:00Z",
                "ultimoTentativoGiorno": "2026-11-13", "aggiornatoIl": "2026-11-13T09:00:00Z",
                "vistaIl": "2026-11-13T09:00:00Z",
                "pratica": {"codice": "700100", "intestatario": "ROSSI MARIO",
                            "via": "VIA ROMA", "civico": "1", "comune": "PAVIA",
                            "provincia": "PV", "progetto": "P", "note_gestore": ""}},
        },
        "elenco": {"prelios": ["700100"]},
        "lastSync": {"prelios": "2026-11-13T09:00:00Z"},
    }
    path.write_text(json.dumps(vecchio), encoding="utf-8")
    with contextlib.redirect_stdout(io.StringIO()) as out:
        cache = BridgeCache(path).load()
    assert "illeggibile" not in out.getvalue()
    (r,) = cache.snapshot("prelios")
    assert r["telefono"] == "+390255500001"
    assert not {"stato", "fase", "dataSopralluogo", "sospensione"} & set(r)
    assert cache.elenco("prelios")[0].fase == ""
    # Nuovo elenco con stato: telefono conservato, stato aggiunto
    p = _per_codice(parse_grid_rows(griglia_mista(), oggi=OGGI))["700100"]
    cache.aggiorna_elenco("prelios", [p], adesso=T0)
    assert cache.da_lavorare("prelios", [p], adesso=T0) == []
    cache.save()
    di_nuovo = BridgeCache(path).load()
    assert di_nuovo.data["version"] == 1
    (r,) = di_nuovo.snapshot("prelios")
    assert r["telefono"] == "+390255500001" and r["fase"] == "da_fissare"
    # Un record con chiavi sconosciute (versione futura) non rompe nulla
    di_nuovo.data["pratiche"]["prelios:700100"]["pratica"]["campo_futuro"] = "x"
    assert di_nuovo.snapshot("prelios")[0]["codice"] == "700100"
    print("OK test_cache_vecchia_si_carica")


def test_quali_aprire() -> None:
    cache = _cache()
    pr = parse_grid_rows(griglia_mista(), oggi=OGGI)
    cache.aggiorna_elenco("prelios", pr, adesso=T0)
    da_fare = [p.codice for p in cache.da_lavorare("prelios", pr, adesso=T0)]
    # solo da_fissare e sospese
    assert da_fare == ["700100", "700106", "700107"], da_fare
    # una fissata che torna da fissare si apre allora
    p1 = _per_codice(pr)["700101"]
    p1.fase, p1.stato, p1.data_sopralluogo = "da_fissare", "", ""
    assert "700101" in [p.codice for p in cache.da_lavorare("prelios", pr, adesso=T0)]
    # fase sconosciuta (nessuna colonna di stato): come prima
    senza = Pratica(codice="700300", intestatario="X", via="", civico="", comune="",
                    provincia="", progetto="")
    assert cache.da_lavorare("prelios", [senza], adesso=T0) == [senza]
    print("OK test_quali_aprire")


def _sospese(n: int, dal: str = "10/11/2026") -> list[Pratica]:
    righe = [HEADER] + [riga(i, Sospensione=dal) for i in range(n)]
    return parse_grid_rows(righe, oggi=OGGI)


def test_riletture_nota() -> None:
    cache = _cache()
    pr = _sospese(14)
    cache.aggiorna_elenco("prelios", pr, adesso=T0)
    # mai lette: tutte candidate, ma al massimo 10; escluse quelle aperte per il telefono
    lista = cache.sospensioni_da_rileggere("prelios", pr, escludi={"700100"}, adesso=T0)
    assert len(lista) == 10 and "700100" not in [p.codice for p in lista]
    for p in pr:
        cache.registra_sospensione("prelios", p, "nota finta", True, adesso=T0)
    # appena lette: nessuna
    assert cache.sospensioni_da_rileggere("prelios", pr, adesso=T0 + timedelta(hours=23)) == []
    # dopo 24 ore: di nuovo (max 10)
    assert len(cache.sospensioni_da_rileggere("prelios", pr, adesso=T0 + timedelta(hours=25))) == 10
    # data di sospensione cambiata: subito, e prima delle scadute
    cambiate = _sospese(14, dal="13/11/2026")[:2]
    altre = pr[2:]
    lista = cache.sospensioni_da_rileggere("prelios", cambiate + altre,
                                           adesso=T0 + timedelta(hours=1))
    assert [p.codice for p in lista] == ["700100", "700101"], [p.codice for p in lista]
    lista = cache.sospensioni_da_rileggere("prelios", altre + cambiate,
                                           adesso=T0 + timedelta(hours=25))
    assert [p.codice for p in lista[:2]] == ["700100", "700101"] and len(lista) == 10
    # un tentativo fallito conta: niente riapertura a ogni ciclo
    p = _sospese(20)[15]
    cache.registra_sospensione("prelios", p, "", False, adesso=T0)
    assert cache.sospensioni_da_rileggere("prelios", [p], adesso=T0 + timedelta(hours=2)) == []
    # ...ma se a fallire è stato un bridge PRECEDENTE (che leggeva la nota in
    # un altro modo, o non segnava la versione) si ritenta subito: dopo un
    # aggiornamento le note arrivano al primo giro, non dopo 24 ore
    sosp = cache.data["pratiche"][cache.chiave("prelios", p.codice)]["sospensione"]
    assert sosp["versione"] == VERSIONE_LETTURA_SOSPENSIONE and sosp["letta"] is False
    for vecchia in (None, 1, "1", "x", VERSIONE_LETTURA_SOSPENSIONE - 1):
        if vecchia is None:
            sosp.pop("versione", None)
        else:
            sosp["versione"] = vecchia
        assert cache.sospensioni_da_rileggere("prelios", [p], adesso=T0 + timedelta(minutes=5)) == [p], vecchia
    # e passano davanti a quelle scadute, insieme alle mai lette
    lista = cache.sospensioni_da_rileggere("prelios", pr + [p], adesso=T0 + timedelta(hours=25))
    assert lista[0].codice == p.codice and len(lista) == 10, [x.codice for x in lista]
    # riletta dal bridge di adesso (anche se fallisce ancora): si torna alle 24 ore
    cache.registra_sospensione("prelios", p, "", False, adesso=T0 + timedelta(minutes=6))
    assert cache.sospensioni_da_rileggere("prelios", [p], adesso=T0 + timedelta(hours=2)) == []
    # una nota LETTA da un bridge precedente resta valida fino alle 24 ore
    q = pr[5]
    letta = cache.data["pratiche"][cache.chiave("prelios", q.codice)]["sospensione"]
    assert letta["letta"] is True and letta["nota"] == "nota finta"
    letta.pop("versione")
    assert cache.sospensioni_da_rileggere("prelios", [q], adesso=T0 + timedelta(hours=2)) == []
    assert cache.sospensioni_da_rileggere("prelios", [q], adesso=T0 + timedelta(hours=25)) == [q]
    # le non sospese non si rileggono mai
    assert cache.sospensioni_da_rileggere("prelios", parse_grid_rows(
        [HEADER, riga(0)], oggi=OGGI), adesso=T0) == []
    print("OK test_riletture_nota")


# ---------------------------------------------------------------------------
# Ciclo del servizio (adapter finto)
# ---------------------------------------------------------------------------

class AdapterStato(PortalAdapter):
    id = "prelios"
    nome = "Finto"
    supporta_elenco = True
    legge_sospensione = True

    def __init__(self, righe, note=None, non_raggiunte=()):
        self.righe = righe
        self.note = note or {}
        self.non_raggiunte = set(non_raggiunte)   # pagina «Sospesi» non raggiunta
        self.aperte: list[tuple[str, bool]] = []
        self.riletture: list[str] = []
        self.descritte: list[str] = []
        self.richieste = 0
        self.perizia_descritta = False
        self._descritta_una_volta = False

    def is_logged_in(self, browser) -> bool:
        return True

    def list_assigned(self, browser, log=print):
        return parse_grid_rows(self.righe, oggi=OGGI)

    def richiedi_descrizione_perizia(self) -> None:
        self.richieste += 1
        self.perizia_descritta = False

    def _apri(self):
        if not self.perizia_descritta:
            self.perizia_descritta = self._descritta_una_volta = True

    def enrich(self, browser, p, log=print, sospensione=None):
        self.aperte.append((p.codice, sospensione is not None))
        self._apri()
        if sospensione is not None:
            if p.codice in self.non_raggiunte:
                sospensione.update(letta=False, nota="", dal="", esito="non raggiunta")
            else:
                sospensione.update(letta=True, nota=self.note.get(p.codice, ""),
                                   dal="2026-11-12", esito="OK")
        return f"+3902555{p.codice[-4:]}", "OK", ""

    def leggi_sospensione(self, browser, p, log=print):
        self.riletture.append(p.codice)
        self._apri()
        if p.codice in self.non_raggiunte:
            return "", "", "NON LETTA: non raggiunta"
        return self.note.get(p.codice, ""), "2026-11-12", "OK"

    def descrivi_perizia(self, browser, p, log=print):
        self.descritte.append(p.codice)
        self._apri()
        return True

    def ha_descrizione_perizia(self) -> bool:
        return self._descritta_una_volta


def _servizio(adapter, limit=0):
    path = Path(tempfile.mkdtemp(prefix="test_stato_servizio_")) / "bridge_cache.json"
    s = _Servizio(SimpleNamespace(elenco=None, limit=limit, interval=30), adapter,
                  BridgeCache(path), BridgeState())
    s.browser = object()
    s.percorso_struttura = path.parent / se.NOME_FILE
    return s


def _ciclo(s) -> tuple[str, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        esito = s.ciclo()
    return esito, buf.getvalue()


def test_servizio_non_apre_fissate() -> None:
    righe = griglia_mista()
    righe.insert(-1, riga(11, Sospensione="09/11/2026"))
    a = AdapterStato(righe, note={"700106": "cliente da richiamare il 20/11"},
                     non_raggiunte={"700107", "700111"})
    s = _servizio(a)
    esito, out = _ciclo(s)
    assert esito == "ok", out
    assert a.aperte == [("700100", False), ("700106", True), ("700107", True),
                        ("700111", True)], a.aperte
    assert ("Stato sul portale: 2 con sopralluogo fissato, 5 già fatte o chiuse, "
            "3 sospese, 1 da fissare") in out, out
    assert "non aperte perché sul portale il sopralluogo è fissato" in out
    # 700107 e 700111: pagina «Sospesi» non raggiunta → UNA sola riga nel log
    assert out.count(MSG_NOTA_NON_TROVATA) == 1, out
    snap = {r["codice"]: r for r in s.state.snapshot()["pratiche"]}
    # "dal" = data della riga letta nella pagina «Sospesi»
    assert snap["700106"]["sospensione"] == {"nota": "cliente da richiamare il 20/11",
                                             "dal": "2026-11-12"}
    # non raggiunta: nota vuota, "dal" dalla colonna Sospensione
    assert snap["700111"]["sospensione"] == {"nota": "", "dal": "2026-11-09"}
    assert snap["700101"]["fase"] == "fissato" and snap["700101"]["telefono"] == ""
    assert snap["700105"]["stato"] == "Conclusa il 13/11/2026"
    # Secondo ciclo, stesso giorno: niente da aprire, niente note da rileggere
    a.aperte.clear()
    esito, out = _ciclo(s)
    assert esito == "ok" and a.aperte == [] and a.riletture == [], (a.aperte, a.riletture)
    print("OK test_servizio_non_apre_fissate")


def test_servizio_riletture_dopo_telefoni() -> None:
    righe = [HEADER] + [riga(i, Sospensione="10/11/2026") for i in range(13)] + [riga(20)]
    a = AdapterStato(righe, note={f"7001{i:02d}": f"nota finta {i}" for i in range(13)})
    s = _servizio(a)
    # le sospese hanno già il telefono (letto prima): solo riletture della nota
    for p in parse_grid_rows(righe, oggi=OGGI)[:13]:
        s.cache.registra("prelios", p, "+390255500001", "OK")
    esito, out = _ciclo(s)
    assert esito == "ok", out
    assert a.aperte == [("700120", False)], a.aperte          # prima i telefoni...
    assert len(a.riletture) == 10                             # ...poi max 10 note
    assert "note di sospensione da rileggere: 10" in out
    esito, out = _ciclo(s)
    assert len(a.riletture) == 13                             # le altre al ciclo dopo
    # --limit vale per telefoni + note
    a2 = AdapterStato(righe)
    s2 = _servizio(a2, limit=3)
    for p in parse_grid_rows(righe, oggi=OGGI)[:13]:
        s2.cache.registra("prelios", p, "+390255500001", "OK")
    _ciclo(s2)
    assert len(a2.aperte) == 1 and len(a2.riletture) == 2
    print("OK test_servizio_riletture_dopo_telefoni")


def test_servizio_dopo_aggiornamento() -> None:
    # Cache lasciata dal bridge PRECEDENTE: telefoni già letti e, per ogni
    # sospesa, un tentativo di lettura della nota FALLITO da poco (record
    # senza versione). Il bridge aggiornato le rilegge al PRIMO ciclo, senza
    # aspettare le 24 ore del tentativo fallito.
    righe = [HEADER] + [riga(i, Sospensione="10/11/2026") for i in range(3)]
    a = AdapterStato(righe, note={"700100": "chiamare dopo il 19"},
                     non_raggiunte={"700102"})
    s = _servizio(a)
    for p in parse_grid_rows(righe, oggi=OGGI):
        s.cache.registra("prelios", p, "+390255500001", "OK")
        s.cache.registra_sospensione("prelios", p, "", False)
        s.cache.data["pratiche"][s.cache.chiave("prelios", p.codice)]["sospensione"].pop("versione")
    esito, out = _ciclo(s)
    assert esito == "ok", out
    assert a.aperte == [] and sorted(a.riletture) == ["700100", "700101", "700102"], \
        (a.aperte, a.riletture)
    assert "note di sospensione da rileggere: 3" in out, out
    snap = {r["codice"]: r for r in s.state.snapshot()["pratiche"]}
    assert snap["700100"]["sospensione"]["nota"] == "chiamare dopo il 19"
    # Ciclo dopo: quelle lette restano lette; quella che il bridge di ADESSO
    # non ha raggiunto non si riapre a ogni ciclo (si riprova dopo 24 ore)
    a.riletture.clear()
    esito, out = _ciclo(s)
    assert esito == "ok" and a.riletture == [] and a.aperte == [], (a.riletture, a.aperte, out)
    print("OK test_servizio_dopo_aggiornamento")


def test_servizio_descrive_una_perizia() -> None:
    # Tutte già lavorate o non da aprire: si apre UNA perizia solo per
    # descriverla, una volta per avvio (prima le sospese).
    righe = [HEADER, riga(0), riga(1, Sopralluogo="20/11/2026"), riga(2, Sospensione="10/11/2026")]
    a = AdapterStato(righe)
    s = _servizio(a)
    for p in parse_grid_rows(righe, oggi=OGGI):
        s.cache.registra("prelios", p, "+390255500001", "OK")
        s.cache.registra_sospensione("prelios", p, "", True)
    esito, out = _ciclo(s)
    assert esito == "ok" and a.aperte == [] and a.descritte == ["700102"], (a.descritte, out)
    _ciclo(s)
    assert a.descritte == ["700102"]                          # una volta per avvio
    assert a.richieste == 2                                   # ogni ciclo la chiede
    # Con un file elenco non si descrive niente (il file non viene scritto)
    print("OK test_servizio_descrive_una_perizia")


# ---------------------------------------------------------------------------
# Adapter Prelios con funzioni del portale finte
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def _prelios_finto(registro: list[str], nota: str = "nota finta", struttura=None,
                   raggiunta: bool = True):
    nomi = ("search_perizia", "open_perizia", "extract_phone", "apri_anagrafica",
            "leggi_pagina_sospesi", "read_perizia_structure")
    originali = {n: getattr(prelios, n) for n in nomi}
    prelios.search_perizia = lambda b, c, log=print: registro.append(f"cerca {c}") or True
    prelios.open_perizia = lambda b, c, u, log=print: registro.append(f"apri {c}") or True
    prelios.extract_phone = lambda b, log=print: (registro.append("telefono")
                                                  or ("+390255500007", "Mario Finto 0255500007"))
    prelios.apri_anagrafica = lambda b, log=print: registro.append("anagrafica")

    def sospesi(b, log=print):
        registro.append("sospesi")
        if not raggiunta:
            return {"raggiunta": False, "righe": [], "motivo": "", "esito": "non trovata"}
        return {"raggiunta": True, "motivo": "",
                "righe": [{"data": "05/11/2026", "note": "nota vecchia"},
                          {"data": "12/11/2026", "note": nota}], "esito": "OK"}

    prelios.leggi_pagina_sospesi = sospesi
    prelios.read_perizia_structure = lambda b: (registro.append("struttura")
                                                or (struttura or {"campi": [], "voci_menu": [],
                                                                  "origini": 1}))
    try:
        yield
    finally:
        for n, f in originali.items():
            setattr(prelios, n, f)


def test_adapter_prelios() -> None:
    p = _per_codice(parse_grid_rows(griglia_mista(), oggi=OGGI))["700106"]
    a = PreliosAdapter()
    reg: list[str] = []
    with _prelios_finto(reg):
        # telefono come prima (nessuna lettura in più se non richiesta)
        assert a.enrich(None, p) == ("+390255500007", "OK", "Mario Finto 0255500007")
        assert reg == ["cerca 700106", "apri 700106", "telefono"], reg
        # con la sospensione e la descrizione richiesta
        reg.clear()
        a.richiedi_descrizione_perizia()
        sosp: dict = {}
        a.enrich(None, p, sospensione=sosp)
        # la riga più recente della pagina «Sospesi»
        assert sosp == {"letta": True, "nota": "nota finta", "dal": "2026-11-12", "esito": "OK"}
        # Anagrafica descritta, poi «Sospesi» letta e descritta
        assert reg == ["cerca 700106", "apri 700106", "telefono", "struttura", "sospesi",
                       "struttura"], reg
        assert a.perizia_descritta and a.ha_descrizione_perizia()
        assert a._sospesi_grezza is not None
        # la seconda perizia del ciclo non viene descritta
        reg.clear()
        a.enrich(None, p, sospensione={})
        assert "struttura" not in reg
        # solo la nota
        reg.clear()
        assert a.leggi_sospensione(None, p) == ("nota finta", "2026-11-12", "OK")
        assert reg == ["cerca 700106", "apri 700106", "anagrafica", "sospesi"], reg
    # pagina «Sospesi» non raggiunta
    with _prelios_finto(reg, raggiunta=False):
        r = a.leggi_sospensione(None, p)
        assert r[:2] == ("", "") and r[2].startswith("NON LETTA"), r
        sosp = {}
        a.enrich(None, p, sospensione=sosp)
        assert sosp["letta"] is False and sosp["nota"] == ""
    # perizia non trovata
    with _prelios_finto(reg):
        prelios.search_perizia = lambda b, c, log=print: False
        assert a.leggi_sospensione(None, p) == ("", "", "KO perizia non trovata")
    # i testi letti finiscono fra quelli da nascondere
    assert {"nota finta", "+390255500007", "0255500007"} <= a.valori_da_nascondere()
    print("OK test_adapter_prelios")


# ---------------------------------------------------------------------------
# Nota di sospensione da una pagina finta
# ---------------------------------------------------------------------------

def test_nota_da_sospesi() -> None:
    # Righe della griglia «Sospesi» (solo Data e Note), più recenti in alto
    righe = [{"data": "12/11/2026", "note": "  cliente da   richiamare\nil 20/11 "},
             {"data": "05/11/2026", "note": "vecchia"},
             {"data": "12/11/2026", "note": "stesso giorno, seconda"}]
    assert sp.nota_da_sospesi(righe) == ("cliente da richiamare il 20/11", "2026-11-12")
    # la data più alta vince anche se non è in alto
    assert sp.nota_da_sospesi(list(reversed(righe[:2])))[0] == "cliente da richiamare il 20/11"
    assert sp.nota_da_sospesi(righe, "Cliente assente") == (
        "Motivo: Cliente assente · cliente da richiamare il 20/11", "2026-11-12")
    assert sp.nota_da_sospesi([], "Cliente assente") == ("Motivo: Cliente assente", "")
    assert sp.nota_da_sospesi([], "  ") == ("", "")
    assert sp.nota_da_sospesi([{"data": "boh", "note": "x"}, {"data": "", "note": "y"}]) == ("x", "")
    lunga, _ = sp.nota_da_sospesi([{"data": "", "note": "parola " * 200}])
    assert len(lunga) == sp.NOTA_MAX and lunga.endswith("…")
    # «sopralluogo fissato» nella nota
    assert sp.data_fissata_da_nota("Sopralluogo fissato in data 17/11/2026") == "2026-11-17"
    assert sp.data_fissata_da_nota("sopraluogo già fissata per il 3.12.26 ore 10") == "2026-12-03"
    assert sp.data_fissata_da_nota("cliente da richiamare il 20/11") == ""
    assert sp.data_fissata_da_nota("Sopralluogo fissato il 31/02/2026") == ""
    assert sp.fase_con_nota("sospesa", "", "Sopralluogo fissato in data 17/11/2026") == (
        "fissato", "Sopralluogo fissato per il 17/11/2026 (nota di sospensione)", "2026-11-17")
    # colonna Sopralluogo piena o fase diversa: la nota non cambia niente
    assert sp.fase_con_nota("sospesa", "2026-11-20", "Sopralluogo fissato il 17/11/2026")[0] == "sospesa"
    assert sp.fase_con_nota("da_fissare", "", "Sopralluogo fissato il 17/11/2026")[0] == "da_fissare"
    print("OK test_nota_da_sospesi")


def test_fissato_dalla_nota_in_cache() -> None:
    cache = _cache()
    (p,) = parse_grid_rows([HEADER, riga(0, Sospensione="10/11/2026")], oggi=OGGI)
    cache.aggiorna_elenco("prelios", [p], adesso=T0)
    cache.registra_sospensione("prelios", p, "Sopralluogo fissato in data 17/11/2026", True,
                               "2026-11-13", adesso=T0)
    (r,) = cache.snapshot("prelios")
    assert r["fase"] == "fissato" and r["dataSopralluogo"] == "2026-11-17"
    assert "sospensione" not in r and "nota di sospensione" in r["stato"]
    assert cache.da_lavorare("prelios", [p], adesso=T0) == []        # non si apre
    print("OK test_fissato_dalla_nota_in_cache")


class BrowserPagina:
    """Browser finto: risponde agli script della pagina della perizia con
    risposte decise dal test, nel documento e in un frame."""

    def __init__(self, risposte: dict, frame: int = 1):
        self.risposte = risposte      # {script: [risposta documento, frame_0, ...] o callable}
        self.frame = frame
        self.corrente = 0
        self.script: list[str] = []

    def switch_to_default(self):
        self.corrente = 0

    def switch_to_frame(self, i):
        self.corrente = i + 1

    def get_frame_count(self):
        return self.frame

    def wait(self, s):
        pass

    def execute_js(self, js, *args):
        self.script.append(js)
        r = self.risposte.get(js)
        if callable(r):
            return r(self.corrente)
        return r[self.corrente] if isinstance(r, list) else r


# Riga della griglia «Sospesi» come la vedrebbe uno script SBAGLIATO che
# leggesse tutto: dati INVENTATI di chi ha sospeso (non devono mai uscire)
PERSONALE = {"cognome": "TESTAFINTA", "nome": "GIOVANNA", "cellulare": "+390255599999",
             "email": "giovanna.testafinta@banca.example", "key": "KEY-ZZZ"}


def _browser_sospesi(trovata: bool = True, griglia: bool = True,
                     wstbs: bool = True) -> BrowserPagina:
    righe = [dict(PERSONALE, data="12/11/2026", note="cliente da richiamare il 20/11"),
             dict(PERSONALE, data="02/11/2026", note="prima sospensione")]
    return BrowserPagina({
        prelios._JS_CLICCA_SOSPESI: [None, "clicked" if trovata else None],
        # ripiego: chiamata diretta wsTbs.Url (solo nel documento principale)
        prelios._JS_NAV_SOSPESI: ["chiamata" if wstbs else None, None],
        prelios._JS_GRIGLIA_SOSPESI: [
            {"griglia": False, "righe": [], "motivo": "Cliente assente"},
            ({"griglia": True, "righe": righe, "motivo": ""} if griglia else None)],
        prelios._JS_STRUTTURA_PERIZIA: [None, {
            "campi": [{"id": "Note", "name": "", "tipo": "textarea", "etichetta": "Note",
                       "vuoto": False, "sosp": False, "visibile": True}],
            "intestazioni": [["Data", "VT", "Cognome", "Nome", "Cellulare", "Email", "Note",
                              "ID Imm.", "Key", "Stato Perizia"]],
            "voci_menu": [{"tag": "A", "testo": "Riattiva", "chiamata": "riattiva('700106')"}]}],
    })


def test_pagina_sospesi_finta() -> None:
    b = _browser_sospesi()
    r = prelios.leggi_pagina_sospesi(b, log=lambda *_: None, attesa=2)
    assert r == {"raggiunta": True, "motivo": "Cliente assente", "esito": "OK",
                 "arrivo": "clic",
                 "righe": [{"data": "12/11/2026", "note": "cliente da richiamare il 20/11"},
                           {"data": "02/11/2026", "note": "prima sospensione"}]}, r
    assert prelios._JS_CLICCA_SOSPESI in b.script
    assert prelios._JS_NAV_SOSPESI not in b.script          # clic riuscito: niente ripiego
    # voce non trovata: chiamata diretta wsTbs.Url
    b = _browser_sospesi(trovata=False)
    r = prelios.leggi_pagina_sospesi(b, log=print, attesa=2)
    assert r["raggiunta"] and r["arrivo"] == "chiamata diretta", r
    assert prelios._JS_NAV_SOSPESI in b.script
    # né voce né wsTbs: pagina non aperta
    r = prelios.leggi_pagina_sospesi(_browser_sospesi(trovata=False, wstbs=False), log=print,
                                     attesa=2)
    assert not r["raggiunta"] and r["arrivo"] == ""
    assert "Anpl_Immobili_Sospesi_ISP non trovata" in r["esito"]
    assert "pagina «Sospesi» non aperta" in r["esito"], r
    # griglia non comparsa: il motivo dice come si è arrivati e cosa manca
    r = prelios.leggi_pagina_sospesi(_browser_sospesi(griglia=False), log=print, attesa=2)
    assert not r["raggiunta"] and "non comparsa" in r["esito"] and r["arrivo"] == "clic"
    assert "clic sulla voce del menu" in r["esito"] and "«Stato Perizia»" in r["esito"], r
    r = prelios.leggi_pagina_sospesi(_browser_sospesi(trovata=False, griglia=False),
                                     log=print, attesa=2)
    assert "non comparsa" in r["esito"] and "chiamata diretta wsTbs.Url" in r["esito"], r
    # Gli script: un solo clic, SOLO sull'elemento con il codice di pagina,
    # con il controllo esplicito dei comandi vietati; nessuna ricerca per
    # testo, nessun valore scritto, niente identificatori inseriti da fuori
    js = prelios._JS_CLICCA_SOSPESI
    assert js.count(".click(") == 1 and "Anpl_Immobili_Sospesi_ISP" in js
    for vietato in prelios.COMANDI_VIETATI:
        assert f"'{vietato}'" in js, vietato
    assert set(prelios.COMANDI_VIETATI) == {"Riattiva", "wsStatoValutazioneButtons",
                                            "cmdSaveClick", "cmdCancelClick"}
    for testo in ("innerText", "textContent", "'Sospesi'", ".value"):
        assert testo not in js, testo
    nav = prelios._JS_NAV_SOSPESI
    assert "wsTbs.Url('Anpl_Immobili_Sospesi_ISP','ISPVL_','','5.208',null);" in nav
    for js in (nav, prelios._JS_GRIGLIA_SOSPESI, prelios._JS_STRUTTURA_PERIZIA,
               prelios._JS_CLICCA_SOSPESI):
        assert ".value =" not in js and "dispatchEvent" not in js
        assert "%s" not in js and "{}" not in js
    for js in (nav, prelios._JS_GRIGLIA_SOSPESI, prelios._JS_STRUTTURA_PERIZIA):
        assert ".click(" not in js
    print("OK test_pagina_sospesi_finta")


def test_dati_personali_sospesi() -> None:
    """Cognome, nome, cellulare ed email di chi ha sospeso non finiscono MAI
    in log, cache, snapshot o descrizione (anche se uno script li passasse)."""
    a = PreliosAdapter()
    reg: list[str] = []
    log: list[str] = []
    (p,) = parse_grid_rows([HEADER, riga(6, Sospensione="10/11/2026")], oggi=OGGI)
    b = _browser_sospesi()
    with _prelios_finto(reg):
        prelios.leggi_pagina_sospesi = originale_sospesi
        prelios.read_perizia_structure = originale_struttura
        a.richiedi_descrizione_perizia()
        sosp: dict = {}
        a.enrich(b, p, log=log.append, sospensione=sosp)
    assert sosp["nota"] == "Motivo: Cliente assente · cliente da richiamare il 20/11"
    cache = _cache()
    cache.aggiorna_elenco("prelios", [p], adesso=T0)
    cache.registra_sospensione("prelios", p, sosp["nota"], True, sosp["dal"], adesso=T0)
    cache.save()
    a._descrizione = {"note": []}
    tutto = "\n".join([json.dumps(cache.snapshot("prelios"), ensure_ascii=False),
                       cache.path.read_text(encoding="utf-8"), "\n".join(log),
                       json.dumps(sosp, ensure_ascii=False),
                       json.dumps(a.descrizione_elenco(), ensure_ascii=False)])
    for v in PERSONALE.values():
        assert v not in tutto and v.lower() not in tutto.lower(), v
    assert "0255599999" not in tutto
    d = a.descrizione_elenco()["perizia"]["pagina_sospesi"]
    assert d["intestazioni_tabelle"][0][2:6] == ["Cognome", "Nome", "Cellulare", "Email"]
    assert d["voci_menu"][0]["chiamata"] == "riattiva('#')"
    print("OK test_dati_personali_sospesi")


originale_sospesi = prelios.leggi_pagina_sospesi
originale_struttura = prelios.read_perizia_structure


# ---------------------------------------------------------------------------
# Descrizione anonima estesa e sicurezza
# ---------------------------------------------------------------------------

SEGRETI = NOMI + VIE + ["PAVIA", "VIGEVANO", "FONTANA", "@banca", "3902555", "700100",
                        "1111222233334400", "/11/2026", "2026-11", "cliente da richiamare",
                        "Mario Finto", "solo il sabato", "BANCA DI PROVA"]

# Voci INVENTATE del menu «Stato Perizia» (22 come sul portale vero)
STATI_FINTI = [""] + [f"Stato finto {chr(65 + i)}" for i in range(21)]


def _pagina_elenco(trovati: int = 25) -> dict:
    """Struttura come la restituisce _JS_STRUTTURA_PAGINA, con dati finti."""
    controlli = [
        {"origine": "main", "id": "Imm_ky", "name": "idInt", "tipo": "text",
         "etichetta": "Cod. Immobile", "vuoto": True, "visibile": True},
        {"origine": "main", "id": "Imm_StatoValutazione", "name": "idTxt", "tipo": "select",
         "etichetta": "Stato Perizia", "n_opzioni": 22, "opzioni": STATI_FINTI,
         "indice_selezionato": 0, "visibile": True},
        {"origine": "main", "id": "Com_Progetto", "name": "idTxt", "tipo": "select",
         "etichetta": "Progetto", "n_opzioni": 15,
         "opzioni": [f"Progetto {chr(65 + i)}" for i in range(15)],
         "indice_selezionato": 0, "visibile": True},
        {"origine": "main", "id": "", "name": "numRecord", "tipo": "text",
         "etichetta": "Trovati:", "vuoto": False, "numero": trovati, "visibile": True},
        {"origine": "main", "id": "", "name": "PageSize", "tipo": "text",
         "etichetta": "Max Righe:", "vuoto": False, "numero": 20, "visibile": True},
        # un numero in un altro campo non viene mai scritto
        {"origine": "main", "id": "Prv_Sigla", "name": "idTxt", "tipo": "text",
         "etichetta": "Provincia", "vuoto": False, "numero": 27, "visibile": True},
    ]
    vuoto = {"righe": 10, "immagini": 0, "caselle": 0, "caselle_spuntate": 0, "link": 0,
             "altri_campi": 0, "sfondo_immagine": 0, "img_file": {}, "img_alt": {},
             "img_title": {}, "title": {}, "classi": {"cella": 10}, "colore_sfondo": {}}
    celle = {str(i - 8): dict(vuoto) for i in range(len(HEADER))}
    celle["18"] = dict(vuoto, immagini=2, img_file={"ico_sospesa.gif": 2},
                       img_alt={"Sospesa": 2}, img_title={"ROSSI MARIO": 1, "Sospesa": 1})
    celle["-6"] = dict(vuoto, link=10, title={f"Apri {i}": 1 for i in range(10)})
    # nomi di funzione INVENTATI (apriStati, vaiPagina): quelli veri non li conosciamo
    celle["-8"] = dict(vuoto, caselle=10, caselle_spuntate=1,
                       chiamate={f"apriStati('{700100 + i}','8468')": 1 for i in range(10)})
    celle["19"] = dict(vuoto, img_file={f"x{i}.gif": 1 for i in range(20)} | {"…altri": 3})
    return {"th": [{"celle": HEADER, "n_celle_dati": 32, "col_tipologia_dati": 8,
                    "origine": "main"}],
            "controlli": controlli, "controlli_in_griglia": 0, "celle": celle, "origini": 1,
            "link_pagina": [{"tag": "A", "testo": t, "chiamata": f"vaiPagina({n},'123456789')",
                             "origine": "main"}
                            for t, n in (("-", 0), ("1", 1), ("2", 2), ("15", 15), ("+", 16))]}


PERIZIA_FINTA = {   # id INVENTATI
    "origini": 2,
    "campi": [
        {"origine": "frame_0", "id": "txtNotaSospensione", "name": "", "tipo": "textarea",
         "etichetta": "Note sospensione", "vuoto": False, "sosp": True, "lunghezza": 31,
         "visibile": True},
        {"origine": "frame_0", "id": "cboMotivoSosp", "name": "", "tipo": "select",
         "etichetta": "Motivo", "n_opzioni": 3, "opzioni": ["", "Cliente assente", "Altro"],
         "indice_selezionato": 1, "vuoto": False, "sosp": True, "visibile": True},
        {"origine": "frame_0", "id": "txtIntestatario", "name": "", "tipo": "text",
         "etichetta": "ROSSI MARIO", "vuoto": False, "sosp": False, "visibile": True},
        {"origine": "frame_0", "id": "txtRef", "name": "", "tipo": "text",
         "etichetta": "Mario Finto", "vuoto": False, "sosp": False, "visibile": True},
        {"origine": "frame_0", "id": "txtData", "name": "", "tipo": "text",
         "etichetta": "Data 14/11/2026", "vuoto": False, "sosp": False, "visibile": True},
        {"origine": "frame_0", "id": "cboBanca", "name": "", "tipo": "select",
         "etichetta": "Filiale", "n_opzioni": 3, "opzioni": ["", "Filiale 12", "Filiale 34"],
         "indice_selezionato": 2, "vuoto": False, "sosp": False, "visibile": True},
        {"origine": "frame_0", "id": "Imm_Descrizione", "name": "", "tipo": "textarea",
         "etichetta": "Note del Gestore", "vuoto": False, "sosp": False, "visibile": True},
    ],
    "voci_menu": [
        {"origine": "main", "tag": "A", "testo": "Anagrafica",
         "chiamata": "wsTbs.Url('Anpl_Immobili_Ed_ISP','ISPVL_','','5.284',null)"},
        {"origine": "main", "tag": "A", "testo": "Anagrafica",
         "chiamata": "wsTbs.Url('Anpl_Immobili_Ed_ISP','ISPVL_','','5.284',null)"},
        {"origine": "main", "tag": "TD", "testo": "Perizia 700106",
         "chiamata": "apri('700106.8468')"},
        {"origine": "main", "tag": "A", "testo": "Scrivi a gestore6@banca.example",
         "chiamata": "mail('x')"},
        {"origine": "main", "tag": "A", "testo": "ROSSI MARIO",
         "chiamata": "vai('14/11/2026', 'ROSSI MARIO')"},
    ],
}


def _descrizione_completa():
    righe = [["Elenco Perizie"]] + [riga(i, Sospensione="10/11/2026" if i % 3 else "")
                                    for i in range(10)]
    info = {"pagine": 1, "controlli_paginazione": [], "pagina": _pagina_elenco()}
    a = PreliosAdapter()
    log: list[str] = []

    class B:
        def switch_to_default(self): pass
        def switch_to_frame(self, i): pass
        def get_frame_count(self): return 0
        def wait(self, s): pass

        def execute_js(self, js, *args):
            if js is prelios._JS_GRID_ROWS:
                return {"rows": righe, "layout_rows": 0, "tables": 1}
            if js is prelios._JS_FIND_NEXT:
                return [] if not args else "skip"
            if js is prelios._JS_STRUTTURA_PAGINA:
                return info["pagina"]
            if js is prelios._JS_TROVATI:
                return 25
            if js in (prelios._JS_STATO_PERIZIA, prelios._JS_IMPOSTA_PAGESIZE):
                return None          # menu e campo assenti: ripiego
            return "Imm_ky" if "Imm_ky" in js else "navigated"

    pratiche = a.list_assigned(B(), log=log.append)
    a._ricorda("cliente da richiamare il 20/11", "+390255500007", "Mario Finto 0255500007")
    a._perizia_grezza = PERIZIA_FINTA
    return a, pratiche, log


def test_descrizione_estesa() -> None:
    a, pratiche, log = _descrizione_completa()
    # stato letto dalle intestazioni <th> (le righe non hanno l'intestazione)
    assert [p.fase for p in pratiche][:3] == ["da_fissare", "sospesa", "sospesa"]
    assert any("il portale dice 25 perizie ma ne ho lette 10" in r for r in log), log
    d = a.descrizione_elenco()
    assert d["conteggi"]["trovati_sul_portale"] == 25 and d["conteggi"]["max_righe"] == 20
    assert any("forse ci sono più pagine" in n for n in d["note"])
    sp_d = d["stato_portale"]
    assert sp_d["colonne_trovate"] and sp_d["conteggi_fasi"] == {"da_fissare": 4, "sospesa": 6}
    assert sp_d["sospese_come"].startswith("ripiego") and "non trovato" in sp_d["motivo_ricerca"]
    assert any("ricerca delle perizie sospese non possibile" in r for r in log), log
    f = {x["id"] or x["name"]: x for x in d["filtri"]}
    assert f["Imm_StatoValutazione"]["opzioni"] == STATI_FINTI        # menu di stato in chiaro
    assert "opzioni" not in f["Com_Progetto"]                         # 15 voci: troppe
    assert f["numRecord"]["numero"] == 25 and f["PageSize"]["numero"] == 20
    assert "numero" not in f["Prv_Sigla"]
    col = {c["intestazione"]: c for c in d["colonne"]}
    sospesa = col["Sospesa"]["contenuto"]
    assert sospesa["immagini"] == 2 and sospesa["img_file"] == {"ico_sospesa.gif": 2}
    assert sospesa["img_alt"] == {"Sospesa": 2}
    assert "ROSSI MARIO" not in json.dumps(sospesa["img_title"])      # nome → solo forme
    assert sospesa["img_title"]["forme"] == ["xxxxx xxxxx", "xxxxxxx"]
    assert col["ID Imm."]["contenuto"]["link"] == 10
    assert col["ID Imm."]["contenuto"]["title"]["valori_diversi"] == 10
    assert col["VT"]["contenuto"]["caselle_spuntate"] == 1
    assert col["Revoca"]["contenuto"]["img_file"]["valori_diversi"] == "più di 20"
    # sezione perizia
    per = d["perizia"]
    campi = {c["id"]: c for c in per["campi"]}
    assert campi["txtNotaSospensione"]["etichetta"] == "Note sospensione"
    assert campi["txtNotaSospensione"]["vuoto"] is False
    assert campi["cboMotivoSosp"]["opzioni"] == ["", "Cliente assente", "Altro"]
    assert campi["txtIntestatario"]["forma_etichetta"] == "xxxxx xxxxx"
    assert campi["txtRef"]["forma_etichetta"] == "xxxxx xxxxx"        # parte di una nota letta
    assert "etichetta" not in campi["txtData"]
    assert "opzioni" not in campi["cboBanca"]                         # cifre: solo forme
    assert per["sospensione_trovata"] == [
        {"origine": "frame_0", "id": "txtNotaSospensione", "name": "", "tipo": "textarea",
         "vuoto": False, "etichetta": "Note sospensione", "lunghezza": 31},
        {"origine": "frame_0", "id": "cboMotivoSosp", "name": "", "tipo": "select",
         "vuoto": False, "etichetta": "Motivo"}]
    voci = per["voci_menu"]
    # chiamata COMPLETA, solo le sequenze di 6+ cifre e le date mascherate
    assert voci[0] == {"tag": "A", "testo": "Anagrafica",
                       "chiamata": "wsTbs.Url('Anpl_Immobili_Ed_ISP','ISPVL_','','5.284',null)"}
    assert len(voci) == 4                                             # doppione tolto
    assert voci[1]["chiamata"] == "apri('#.8468')" and "testo" not in voci[1]
    assert "testo" not in voci[2] and "testo" not in voci[3]
    assert "ROSSI" not in voci[3]["chiamata"] and "gg/mm" not in voci[3]["chiamata"]
    # chiamate delle celle (VT/App: come si apre «Stati Perizia - Banca»)
    vt = col["VT"]["contenuto"]["chiamate"]
    assert vt["piu_frequenti"] == {"apriStati('#','8468')": 10}, vt
    # link delle pagine: descritti, mai cliccati
    lp = d["paginazione"]["link_pagina"]
    assert [x["testo"] for x in lp] == ["-", "1", "2", "15", "+"]
    assert lp[1]["chiamata"] == "vaiPagina(1,'#')"
    print("OK test_descrizione_estesa")


def test_descrizione_senza_dati_clienti() -> None:
    a, pratiche, _log = _descrizione_completa()
    d = a.descrizione_elenco()
    testo = json.dumps(dict(d, quando=""), ensure_ascii=False)   # "quando" = ora del file
    for s in SEGRETI:
        assert s not in testo, f"dato nel file: {s!r}"
    # Il controllo finale passa con i dati veri delle pratiche...
    vietati = (se.valori_pratiche(pratiche, ["+390255500007"], ["cliente da richiamare il 20/11"])
               | a.valori_da_nascondere())
    assert se.controllo_sicurezza(d, vietati) == []

    # ...e rifiuta qualunque dato infilato nelle parti nuove
    def con(percorso, valore):
        x = json.loads(json.dumps(d))
        nodo = x
        for k in percorso[:-1]:
            nodo = nodo[k]
        nodo[percorso[-1]] = valore
        return se.controllo_sicurezza(x, vietati)

    assert "data" in con(["perizia", "voci_menu", 0, "testo"], "Sopralluogo 20/11/2026")[0]
    assert "data" in con(["perizia", "campi", 0, "etichetta"], "dal 2026-11-10")[0]
    assert con(["perizia", "sospensione_trovata", 0, "etichetta"], "cliente da richiamare il 20/11")
    assert con(["perizia", "campi", 0, "etichetta"], "Mario Finto 0255500007")
    assert con(["colonne", 26, "contenuto", "img_title"], {"VERDI ANNA": 1})
    assert con(["perizia", "voci_menu", 0, "chiamata"], "apri('3902555000'")
    assert con(["stato_portale", "motivo"], "scrivere a x@banca.example")
    # "quando" (ora di scrittura) è ammesso; le forme possono avere 99/99/9999
    assert con(["quando"], "2026-11-14T09:00:00") == []
    assert con(["colonne", 0, "forma_prevalente"], "99/99/9999") == []
    print("OK test_descrizione_senza_dati_clienti")


def test_servizio_scrive_sezione_perizia() -> None:
    """Ciclo vero del servizio con l'adapter Prelios e il portale finto: il
    file contiene la sezione perizia e nessun dato dei clienti."""
    a, _pratiche, _log = _descrizione_completa()
    a.list_assigned = lambda browser, log=print: PreliosAdapter.list_assigned(a, browser, log)
    reg: list[str] = []
    s = _servizio(a)

    class B:
        is_running = True
        def switch_to_default(self): pass
        def switch_to_frame(self, i): pass
        def get_frame_count(self): return 0
        def wait(self, s): pass

        def execute_js(self, js, *args):
            if js is prelios._JS_GRID_ROWS:
                return {"rows": [riga(i, Sospensione="10/11/2026" if i % 3 else "")
                                 for i in range(10)], "layout_rows": 0, "tables": 1}
            if js is prelios._JS_FIND_NEXT:
                return [] if not args else "skip"
            if js is prelios._JS_STRUTTURA_PAGINA:
                return _pagina_elenco()
            return "Imm_ky" if "Imm_ky" in js else "navigated"

    s.browser = B()
    a.is_logged_in = lambda browser: True
    a._perizia_grezza = None
    with _prelios_finto(reg, nota="cliente da richiamare il 20/11", struttura=PERIZIA_FINTA):
        esito, out = _ciclo(s)
    assert esito == "ok", out
    assert "Descrizione della pagina di una perizia aggiunta a elenco_struttura.json" in out, out
    d = json.loads(s.percorso_struttura.read_text(encoding="utf-8"))
    assert d["perizia"]["sospensione_trovata"][0]["id"] == "txtNotaSospensione"
    testo = json.dumps(dict(d, quando=""), ensure_ascii=False)   # "quando" = ora del file
    for x in SEGRETI:
        assert x not in testo, f"dato nel file: {x!r}"
    snap = {r["codice"]: r for r in s.state.snapshot()["pratiche"]}
    assert snap["700101"]["sospensione"]["nota"] == "cliente da richiamare il 20/11"
    print("OK test_servizio_scrive_sezione_perizia")


# ---------------------------------------------------------------------------
# Max Righe e seconda ricerca delle sospese (portale finto)
# ---------------------------------------------------------------------------

class PortaleFinto:
    """Elenco Perizie finto: «Max Righe» (PageSize), «Trovati», menu «Stato
    Perizia» con le voci date e una ricerca che mostra tutte le perizie o
    solo le sospese a seconda del menu."""

    def __init__(self, tutte, sospese, voci_stato, trovati=16258, page_size="20"):
        self.tutte, self.sospese, self.voci = tutte, sospese, voci_stato
        self.trovati, self.page_size = trovati, page_size
        self.filtro = ""
        self.mostra = "niente"
        self.eventi: list[str] = []

    def switch_to_default(self): pass
    def switch_to_frame(self, i): pass
    def get_frame_count(self): return 0
    def wait(self, s): pass

    def execute_js(self, js, *args):
        if js is prelios._JS_GRID_ROWS:
            rows = {"tutte": self.tutte, "sospese": self.sospese}.get(self.mostra, [])
            return {"rows": [HEADER] + rows, "layout_rows": 0, "tables": 1}
        if js is prelios._JS_FIND_NEXT:
            return [] if not args else "skip"
        if js is prelios._JS_STRUTTURA_PAGINA:
            return {"th": [{"celle": HEADER, "n_celle_dati": 32, "col_tipologia_dati": 8}],
                    "controlli": [], "celle": {}}
        if js is prelios._JS_IMPOSTA_PAGESIZE:
            prima, self.page_size = self.page_size, str(args[0])
            self.eventi.append(f"PageSize={args[0]}")
            return prima
        if js is prelios._JS_TROVATI:
            return self.trovati
        if js is prelios._JS_STATO_PERIZIA:
            if args[0] == "sospese":
                n = sum("sospes" in v.lower() for v in self.voci)
                if n != 1:
                    return {"esito": "piu_di_una" if n else "nessuna", "voci": n}
                self.filtro = "sospese"
            else:
                self.filtro = ""
            self.eventi.append(f"stato={self.filtro or 'vuoto'}")
            return {"esito": "ok", "voci": 1}
        if js == "cmdFindClick();":
            self.mostra = "sospese" if self.filtro else "tutte"
            self.eventi.append(f"cerca:{self.mostra}")
            return None
        return "Imm_ky" if "Imm_ky" in js else "navigated"


def test_max_righe_e_ricerca_sospese() -> None:
    tutte = [riga(0),                                            # da fissare
             riga(1, Sospensione="01/10/2026"),                  # RIATTIVATA: data vecchia
             riga(2, Sospensione="10/11/2026"),                  # sospesa adesso
             riga(3, Sopralluogo="20/11/2026", Sospensione="10/11/2026")]  # fissata
    sospese = [riga(2, Sospensione="10/11/2026"),
               riga(3, Sopralluogo="20/11/2026", Sospensione="10/11/2026"),
               riga(9, Sospensione="01/03/2026"),               # vecchia: non fra le recenti
               riga(8, tipologia="FULL - Surroga", Sospensione="01/03/2026")]
    voci = ["", "Assegnata", "Sospesa", "Conclusa"]               # voci INVENTATE
    b = PortaleFinto(tutte, sospese, voci)
    a = PreliosAdapter(max_righe=200)
    log: list[str] = []
    pr = _per_codice(a.list_assigned(b, log=log.append))
    # «Max Righe» impostato PRIMA della prima ricerca; menu rimesso vuoto dopo
    assert b.eventi == ["stato=vuoto", "PageSize=200", "cerca:tutte", "stato=sospese",
                        "cerca:sospese", "stato=vuoto"], b.eventi
    assert any("Max Righe portato a 200 (prima: 20)" in r for r in log), log
    assert any("il portale dice 16258 perizie ma ne ho lette 4" in r for r in log), log
    assert any("Sospese adesso (ricerca «Stato Perizia» = sospesa): 4, di cui 1" in r
               for r in log), log
    # fase con la ricerca: la riattivata (data di Sospensione vecchia) è da fissare
    assert {c: p.fase for c, p in pr.items()} == {
        "700100": "da_fissare", "700101": "da_fissare", "700102": "sospesa",
        "700103": "fissato", "700109": "sospesa"}, {c: p.fase for c, p in pr.items()}
    d = a.descrizione_elenco()["stato_portale"]
    assert d["sospese_come"].startswith("ricerca") and d["sospese_trovate"] == 4
    assert d["sospese_aggiunte"] == 1
    # Max Righe 0: il campo non si tocca
    b = PortaleFinto(tutte, sospese, voci)
    PreliosAdapter(max_righe=0).list_assigned(b, log=lambda *_: None)
    assert not any(e.startswith("PageSize") for e in b.eventi)
    # Due voci con «sospes»: niente seconda ricerca, ripiego sulla colonna
    b = PortaleFinto(tutte, sospese, voci + ["Sospesa banca"])
    log = []
    a = PreliosAdapter()
    pr = _per_codice(a.list_assigned(b, log=log.append))
    assert "cerca:sospese" not in b.eventi
    assert pr["700101"].fase == "sospesa" and "700109" not in pr     # ripiego: colonna
    assert any("ambiguo" in r and "colonna «Sospensione»" in r for r in log), log
    assert a.descrizione_elenco()["stato_portale"]["sospese_come"].startswith("ripiego")
    # Nessuna voce con «sospes»
    b = PortaleFinto(tutte, sospese, ["", "Assegnata"])
    log = []
    PreliosAdapter().list_assigned(b, log=log.append)
    assert any("nessuna voce" in r for r in log), log
    print("OK test_max_righe_e_ricerca_sospese")


def main() -> int:
    test_tabella_fasi()
    test_testi_di_stato()
    test_date_non_valide()
    test_griglia_con_stato()
    test_intestazioni_in_altro_ordine()
    test_intestazioni_mancanti()
    test_file_con_e_senza_stato()
    test_snapshot_campi_nuovi()
    test_cache_vecchia_si_carica()
    test_quali_aprire()
    test_riletture_nota()
    test_servizio_non_apre_fissate()
    test_servizio_riletture_dopo_telefoni()
    test_servizio_dopo_aggiornamento()
    test_servizio_descrive_una_perizia()
    test_adapter_prelios()
    test_nota_da_sospesi()
    test_fissato_dalla_nota_in_cache()
    test_pagina_sospesi_finta()
    test_dati_personali_sospesi()
    test_max_righe_e_ricerca_sospese()
    test_descrizione_estesa()
    test_descrizione_senza_dati_clienti()
    test_servizio_scrive_sezione_perizia()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
