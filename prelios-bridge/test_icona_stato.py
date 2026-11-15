#!/usr/bin/env python3
"""Test PURI dell'icona di stato «VT», della nota di sospensione e dei
numeri col puntino (stato_portale.py, excel_pratiche.py, portals.py,
bridge_cache.py, servizio.py).

Niente browser vero, niente portale, niente rete. Le griglie hanno le 32
intestazioni vere dell'Elenco Perizie e i codici di stato visti sul
portale (EL, SP, IN, IP, PI...), ma TUTTI i dati sono INVENTATI (stessi
generatori di test_stato_portale.py).

Copre:
- la regola `fase` con i codici (tutti i rami, comprese le precedenze
  EL > date > SP > IN, il codice sconosciuto e l'icona non letta);
- il codice sconosciuto non pubblicato e contato per codice (log e riga
  dei conteggi), l'icona mancante con la regola di prima e UNA riga di
  avviso;
- lettura delle icone dalla griglia (allineate per indice, anche da più
  frame) e descrizione anonima (codici, non pubblicate, lettura della nota);
- snapshot senza le sospese di cui non si è ancora tentata la nota;
- il numero della perizia col puntino nei messaggi (snapshot e cache no).

Esecuzione:
    python test_icona_stato.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# test_stato_portale prepara il segnaposto di browser.py (Selenium) e i
# generatori di righe finte: si riusano.
import test_stato_portale as tsp  # noqa: E402
from test_stato_portale import (HEADER, OGGI, T0, AdapterStato, PortaleFinto,  # noqa: E402
                                _cache, _ciclo, _per_codice, _servizio, riga)

import prelios  # noqa: E402
import stato_portale as sp  # noqa: E402
import struttura_elenco as se  # noqa: E402
from excel_pratiche import codice_leggibile, parse_grid_rows  # noqa: E402
from portals import PreliosAdapter  # noqa: E402


# ---------------------------------------------------------------------------
# Regola fase con i codici
# ---------------------------------------------------------------------------

def test_fase_con_icona() -> None:
    f = lambda icona, ora=None, **v: sp.fase(v, OGGI, ora, icona)  # noqa: E731
    # 1. EL / AB / IR / IP / PI → chiusa, prima di tutto (date e ricerca sospese)
    for codice in ("EL", "AB", "IR", "IP", "PI"):
        assert f(codice) == "chiusa", codice
        assert f(codice, True, sopralluogo="20/11/2026") == "chiusa", codice
    assert f("EL", sopralluogo="20/11/2026") == "chiusa"           # EL > date
    assert f("EL", True) == "chiusa"                               # EL > ricerca sospese
    assert f("el") == "chiusa"                                     # minuscolo normalizzato
    # 2. le date valgono per qualunque codice (anche sconosciuto)
    assert f("XX", conclusa="01/11/2026") == "chiusa"
    assert f("ZZ", inoltrata="01/11/2026") == "chiusa"
    assert f("XX", valutata="12/11/2026") == "effettuato"
    assert f("XX", sopralluogo="10/11/2026") == "effettuato"
    assert f("XX", sopralluogo="20/11/2026") == "fissato"
    assert f("SP", sopralluogo="20/11/2026") == "fissato"          # date > SP
    assert f("IN", sopralluogo="14/11/2026") == "fissato"          # oggi
    #    VT / PR → effettuato (anche con un sopralluogo futuro), ma le date
    #    di chiusura vincono
    for codice in ("VT", "PR"):
        assert f(codice) == "effettuato", codice
        assert f(codice, sopralluogo="20/11/2026") == "effettuato", codice
        assert f(codice, True) == "effettuato", codice
        assert f(codice, conclusa="13/11/2026") == "chiusa", codice
    # 3. SP o ricerca delle sospese → sospesa
    assert f("SP") == "sospesa"
    assert f("SP", False) == "sospesa"                             # l'icona basta
    assert f("IN", True) == "sospesa"                              # SP/ricerca > IN
    assert f("XX", True) == "sospesa"
    # 4. IN / AT → da fissare (anche con una data vecchia di Sospensione)
    assert f("IN") == "da_fissare" and f("AT") == "da_fissare"
    assert f("IN", None, sospensione="01/10/2026", sospesa="X") == "da_fissare"
    assert f("IN", False) == "da_fissare"
    # 5. codice presente ma sconosciuto e nessuna data → non pubblicata
    for codice in ("XX", "Q", "ZZZ"):
        assert f(codice) == sp.NON_RICONOSCIUTA, codice
    assert f("XX", None, sospensione="10/11/2026") == sp.NON_RICONOSCIUTA
    assert sp.NON_RICONOSCIUTA not in sp.FASI
    # 6. icona non letta (o non valida): regola di prima
    for nessuna in (None, "", "ABCD", "S1", "SP.gif", 7):
        assert f(nessuna) == "da_fissare", nessuna
        assert f(nessuna, None, sospensione="10/11/2026") == "sospesa"
        assert f(nessuna, False, sospensione="10/11/2026") == "da_fissare"
        assert f(nessuna, True) == "sospesa"
    # Testi di stato
    s = lambda icona, **v: sp.stato_perizia(v, OGGI, None, icona)  # noqa: E731
    assert s("EL")["stato"] == "Eliminata" and s("AB")["stato"] == "Abbandonata"
    assert s("IR")["stato"] == "Incarico rifiutato"
    r = s("EL", conclusa="13/11/2026", sopralluogo="01/11/2026")
    assert r["fase"] == "chiusa" and r["stato"] == "Eliminata"
    assert r["data_sopralluogo"] == "2026-11-01"
    assert s("SP", sospensione="10/11/2026") == {
        "fase": "sospesa", "stato": "Sospesa dal 10/11/2026", "data_sopralluogo": "",
        "data_sospensione": "2026-11-10"}
    assert s("IN") == {"fase": "da_fissare", "stato": "", "data_sopralluogo": "",
                       "data_sospensione": ""}
    assert s("XX", conclusa="13/11/2026")["stato"] == "Conclusa il 13/11/2026"
    assert s("IP", inoltrata="11/11/2026", conclusa="13/11/2026")["stato"] == (
        "Perizia inoltrata il 11/11/2026")
    assert s("IP")["stato"] == "Perizia inoltrata"
    assert s("PI", conclusa="13/11/2026")["stato"] == "Perizia inviata il 13/11/2026"
    assert s("VT", valutata="12/11/2026")["stato"] == "Valutata il 12/11/2026"
    r = s("VT", sopralluogo="20/11/2026")
    assert r["fase"] == "effettuato" and r["stato"] == "Valutata"
    assert r["data_sopralluogo"] == "2026-11-20"
    assert s("PR") == {"fase": "effettuato", "stato": "Perizia riaperta", "data_sopralluogo": "",
                       "data_sospensione": ""}
    # I codici stanno in UN punto solo
    assert set(sp.CODICI_ICONA) == {"EL", "AB", "IR", "IP", "PI", "VT", "PR", "SP", "IN",
                                    "AT"}
    print("OK test_fase_con_icona")


# ---------------------------------------------------------------------------
# Griglia con le icone
# ---------------------------------------------------------------------------

def _griglia_icone():
    """(righe, icone) allineate per indice: codici 700100.. nell'ordine."""
    righe_icone = [
        (["Elenco Perizie"], None),
        (HEADER, None),
        (riga(0), "IN"),                                     # da fissare
        (riga(1), "EL"),                                     # eliminata
        (riga(2), "ZZ"),                                     # sconosciuto: fuori
        (riga(3), "XX"),                                     # sconosciuto: fuori
        (riga(4, Sopralluogo="20/11/2026"), "ZZ"),           # sconosciuto ma fissato
        (riga(5, Sospensione="10/11/2026"), "SP"),           # sospesa
        (riga(6, Sospensione="10/11/2026"), None),           # icona non letta: come prima
        (riga(7), "ZZ"),                                     # sconosciuto: fuori
        (riga(8, tipologia="FULL - Surroga"), "ZZ"),         # altra tipologia
        (riga(9, Valutata="12/11/2026"), "VT"),              # valutata
        (riga(10, Conclusa="13/11/2026"), "PI"),             # perizia inviata
        (riga(11), "PR"),                                    # perizia riaperta
        (riga(12), "IP"),                                    # perizia inoltrata (senza date)
        (["<", "1", ">"], None),
    ]
    return [r for r, _i in righe_icone], [i for _r, i in righe_icone]


def test_griglia_con_icone() -> None:
    righe, icone = _griglia_icone()
    stats: dict = {}
    pr = _per_codice(parse_grid_rows(righe, stats=stats, oggi=OGGI, icone=icone))
    assert {c: p.fase for c, p in pr.items()} == {
        "700100": "da_fissare", "700101": "chiusa", "700104": "fissato",
        "700105": "sospesa", "700106": "sospesa", "700109": "effettuato",
        "700110": "chiusa", "700111": "effettuato", "700112": "chiusa"}, pr
    assert pr["700101"].stato == "Eliminata"
    assert pr["700109"].stato == "Valutata il 12/11/2026"
    assert pr["700110"].stato == "Perizia inviata il 13/11/2026"
    assert pr["700111"].stato == "Perizia riaperta"
    assert pr["700112"].stato == "Perizia inoltrata"
    # non pubblicate contate per codice; icone contate su tutte le righe dati
    assert stats["non_pubblicate"] == {"ZZ": 2, "XX": 1}
    assert stats["icone"] == {"IN": 1, "EL": 1, "ZZ": 4, "XX": 1, "SP": 1, "VT": 1,
                              "PI": 1, "PR": 1, "IP": 1}
    assert stats["senza_icona"] == 1 and stats["pratiche"] == 9
    assert sp.riga_non_pubblicate(stats["non_pubblicate"]) == (
        "3 perizie non pubblicate perché in uno stato che non conosco (ZZ: 2, XX: 1)")
    assert sp.riga_non_pubblicate({"ZZ": 1}) == (
        "1 perizia non pubblicata perché in uno stato che non conosco (ZZ: 1)")
    assert sp.riga_non_pubblicate({}) == ""
    assert sp.riga_conteggi([p.fase for p in pr.values()], 3) == (
        "Stato sul portale: 1 con sopralluogo fissato, 5 già fatte o chiuse, 2 sospese, "
        "1 da fissare, 3 non pubblicate (stato non riconosciuto)")
    # senza icone (elenco da file o script vecchio): regola di prima, niente conteggi
    stats = {}
    vecchio = _per_codice(parse_grid_rows(righe, stats=stats, oggi=OGGI))
    assert len(vecchio) == 12 and vecchio["700101"].fase == "da_fissare"
    assert stats["senza_icona"] == 0 and stats["non_pubblicate"] == {} and stats["icone"] == {}
    # lista di icone più corta delle righe: le mancanti valgono come non lette
    stats = {}
    corte = _per_codice(parse_grid_rows(righe, stats=stats, oggi=OGGI, icone=icone[:4]))
    assert corte["700101"].fase == "chiusa" and corte["700102"].fase == "da_fissare"
    assert stats["senza_icona"] == 10, stats      # 12 FULL - Acquisto, 2 con l'icona
    print("OK test_griglia_con_icone")


def test_read_grid_icone() -> None:
    """read_grid: icone allineate per indice alle righe, da documento e frame;
    codici normalizzati (solo 1-3 lettere)."""
    class B:
        corrente = 0
        def switch_to_default(self): self.corrente = 0
        def switch_to_frame(self, i): self.corrente = i + 1
        def get_frame_count(self): return 2

        def execute_js(self, js, *args):
            assert js is prelios._JS_GRID_ROWS
            return [
                {"rows": [HEADER, riga(0), riga(1), "non una riga", riga(2)],
                 "icone": [None, "sp", "IP1", None, "EL"], "vt": True},
                {"rows": [riga(3)]},                         # script senza icone
                None,
            ][self.corrente]

    g = prelios.read_grid(B())
    assert len(g["rows"]) == 5 and g["colonna_vt"] is True
    assert g["icone"] == [None, "SP", None, "EL", None], g["icone"]
    assert g["frames"][0]["righe"] == 4 and g["frames"][1]["righe"] == 1
    print("OK test_read_grid_icone")


class PortaleIcone(PortaleFinto):
    """Elenco finto che restituisce anche le icone «VT» (per indice)."""

    def __init__(self, tutte, icone, sospese=(), icone_sospese=(), **kw):
        super().__init__(tutte, list(sospese), ["", "Assegnata", "Sospesa"], **kw)
        self.icone = list(icone)
        self.icone_sospese = list(icone_sospese)

    def execute_js(self, js, *args):
        if js is prelios._JS_GRID_ROWS:
            if self.mostra == "tutte":
                return {"rows": [HEADER] + self.tutte, "icone": [None] + self.icone,
                        "vt": True}
            if self.mostra == "sospese":
                return {"rows": [HEADER] + self.sospese,
                        "icone": [None] + self.icone_sospese, "vt": True}
        return super().execute_js(js, *args)


def test_adapter_non_pubblicate() -> None:
    tutte = [riga(0), riga(1), riga(2), riga(3), riga(4), riga(5, Sospensione="10/11/2026")]
    icone = ["IN", "EL", "ZZ", "ZZ", "XX", "SP"]
    b = PortaleIcone(tutte, icone, sospese=[riga(5, Sospensione="10/11/2026")],
                     icone_sospese=["SP"])
    a = PreliosAdapter()
    log: list[str] = []
    pr = _per_codice(a.list_assigned(b, log=log.append))
    assert {c: p.fase for c, p in pr.items()} == {
        "700100": "da_fissare", "700101": "chiusa", "700105": "sospesa"}, pr
    assert a.non_pubblicate == {"ZZ": 2, "XX": 1}
    assert ("3 perizie non pubblicate perché in uno stato che non conosco (ZZ: 2, XX: 1)"
            in log), log
    assert not any("icona di stato" in r for r in log), log
    d = a.descrizione_elenco()
    st = d["stato_portale"]
    assert st["icone_vt"] == {"ZZ": 2, "EL": 1, "IN": 1, "SP": 1, "XX": 1}, st
    assert st["non_pubblicate"] == {"ZZ": 2, "XX": 1} and st["perizie_senza_icona"] == 0
    assert st["colonna_vt_trovata"] is True
    assert se.controllo_sicurezza(d, se.valori_vietati([HEADER] + tutte)) == []
    # Icone non lette (portale cambiato): regola di prima e UNA riga di avviso
    b = PortaleIcone(tutte, [None] * 6, sospese=[riga(5, Sospensione="10/11/2026")],
                     icone_sospese=[None])
    a = PreliosAdapter()
    log = []
    pr = _per_codice(a.list_assigned(b, log=log.append))
    assert len(pr) == 6 and pr["700101"].fase == "da_fissare" and pr["700105"].fase == "sospesa"
    avvisi = [r for r in log if "icona di stato della colonna «VT» non letta" in r]
    assert len(avvisi) == 1 and "per 6 perizie" in avvisi[0], log
    assert a.non_pubblicate == {}
    # Lo script vecchio (nessuna icona, nessuna «VT»): stesso ripiego
    log = []
    pr = PreliosAdapter().list_assigned(PortaleFinto(tutte, [], ["", "Sospesa"]),
                                        log=log.append)
    assert len(pr) == 6
    assert any("intestazione «VT» non trovata" in r for r in log), log
    print("OK test_adapter_non_pubblicate")


# ---------------------------------------------------------------------------
# Servizio: non pubblicate, sospese in attesa della nota, numeri col puntino
# ---------------------------------------------------------------------------

class AdapterIcone(AdapterStato):
    """Adapter finto che legge l'elenco con le icone, come quello vero."""

    def __init__(self, righe, icone, **kw):
        super().__init__(righe, **kw)
        self.icone = icone
        self.non_pubblicate = None

    def list_assigned(self, browser, log=print):
        stats: dict = {}
        pr = parse_grid_rows(self.righe, oggi=OGGI, icone=self.icone, stats=stats)
        self.non_pubblicate = stats["non_pubblicate"]
        return pr


def test_servizio_con_icone() -> None:
    righe, icone = _griglia_icone()
    a = AdapterIcone(righe, icone, note={"700105": "nota finta"})
    s = _servizio(a)
    esito, out = _ciclo(s)
    assert esito == "ok", out
    # EL/IP/PI/VT/PR non aperte; ZZ/XX senza date né aperte né pubblicate
    aperte = [c for c, _s in a.aperte]
    assert aperte == ["700100", "700105", "700106"], a.aperte
    assert ("Stato sul portale: 1 con sopralluogo fissato, 5 già fatte o chiuse, 2 sospese, "
            "1 da fissare, 3 non pubblicate (stato non riconosciuto)") in out, out
    snap = {r["codice"]: r for r in s.state.snapshot()["pratiche"]}
    assert set(snap) == {"700100", "700101", "700104", "700105", "700106", "700109",
                         "700110", "700111", "700112"}
    assert snap["700101"]["fase"] == "chiusa" and snap["700101"]["stato"] == "Eliminata"
    assert snap["700112"]["fase"] == "chiusa" and snap["700112"]["stato"] == "Perizia inoltrata"
    assert snap["700111"]["fase"] == "effettuato"
    # numero col puntino nei messaggi, com'è nello snapshot
    assert "Pratica 700.100 (" in out and "Pratica 700100" not in out, out
    assert "[nota" not in out
    # una perizia da fissare che passa a IP (inoltrata) resta pubblicata, ma
    # come chiusa: chi l'aveva importata la toglie dal giro
    icone2 = list(icone)
    icone2[2] = "IP"                                         # 700100: IN → IP
    a.icone = icone2
    a.aperte.clear()
    esito, out = _ciclo(s)
    snap = {r["codice"]: r for r in s.state.snapshot()["pratiche"]}
    assert snap["700100"]["fase"] == "chiusa" and snap["700100"]["telefono"], snap["700100"]
    assert a.aperte == []
    # tutte le perizie non pubblicate: non è un elenco vuoto "sospetto"
    a2 = AdapterIcone([HEADER, riga(2), riga(3)], [None, "ZZ", "ZZ"])
    s2 = _servizio(a2)
    s2.cache.aggiorna_elenco("prelios", parse_grid_rows([HEADER, riga(0)], oggi=OGGI))
    esito, out = _ciclo(s2)
    assert esito == "ok" and "Elenco letto dal portale vuoto" not in out, out
    assert s2.state.snapshot()["pratiche"] == []
    print("OK test_servizio_con_icone")


def test_snapshot_attende_la_nota() -> None:
    # cache: con attendi_nota la sospesa compare solo dopo il primo tentativo
    cache = _cache()
    pr = parse_grid_rows([HEADER, riga(0), riga(1, Sospensione="10/11/2026"),
                          riga(2, Sospensione="10/11/2026")], oggi=OGGI)
    cache.aggiorna_elenco("prelios", pr, adesso=T0)
    assert [r["codice"] for r in cache.snapshot("prelios")] == ["700100", "700101", "700102"]
    assert [r["codice"] for r in cache.snapshot("prelios", attendi_nota=True)] == ["700100"]
    assert cache.sospese_in_attesa_nota("prelios") == 2
    assert cache.conteggi("prelios", attendi_nota=True) == (1, 0)
    # tentativo FALLITO: conta, la sospesa compare (con nota vuota)
    cache.registra_sospensione("prelios", pr[1], "", False, adesso=T0)
    snap = {r["codice"]: r for r in cache.snapshot("prelios", attendi_nota=True)}
    assert set(snap) == {"700100", "700101"} and snap["700101"]["sospensione"]["nota"] == ""
    cache.registra_sospensione("prelios", pr[2], "nota finta", True, adesso=T0)
    assert len(cache.snapshot("prelios", attendi_nota=True)) == 3
    assert cache.sospese_in_attesa_nota("prelios") == 0

    # servizio: 13 sospese con il telefono già noto, max 10 note per ciclo
    righe = [HEADER] + [riga(i, Sospensione="10/11/2026") for i in range(13)] + [riga(20)]
    a = AdapterStato(righe, note={f"7001{i:02d}": f"nota finta {i}" for i in range(13)})
    s = _servizio(a)
    for p in parse_grid_rows(righe, oggi=OGGI)[:13]:
        s.cache.registra("prelios", p, "+390255500001", "OK")
    pubblicate: list[set] = []
    originale = s.state.set_pratiche

    def registra_pubblicazione(pid, righe_snap):
        pubblicate.append({r["codice"]: r for r in righe_snap})
        originale(pid, righe_snap)

    s.state.set_pratiche = registra_pubblicazione
    esito, out = _ciclo(s)
    assert esito == "ok" and len(a.riletture) == 10
    # nessuna sospesa è MAI pubblicata senza un tentativo di lettura della nota
    for snap in pubblicate:
        for c, r in snap.items():
            if r.get("fase") == "sospesa":
                assert c in a.riletture, (c, len(pubblicate))
    assert pubblicate[0].keys() == {"700120"}                       # prima: nessuna sospesa
    assert len(pubblicate[-1]) == 11                                # 10 lette + la da fissare
    assert "Sospese in attesa della lettura della nota" in out and ": 3." in out, out
    assert "Ciclo completato: 11 pratiche" in out, out
    esito, out = _ciclo(s)
    assert len(s.state.snapshot()["pratiche"]) == 14
    assert "Sospese in attesa della lettura della nota" not in out
    print("OK test_snapshot_attende_la_nota")


def test_descrizione_lettura_nota() -> None:
    """La descrizione dice come si è arrivati alla pagina «Sospesi» e se la
    griglia è comparsa (solo conteggi, mai testi delle note)."""
    a = PreliosAdapter()
    a.list_assigned(PortaleIcone([riga(5, Sospensione="10/11/2026")], ["SP"]),
                    log=lambda *_: None)
    assert "lettura_nota" not in a.descrizione_elenco()["stato_portale"]
    (p,) = parse_grid_rows([HEADER, riga(5, Sospensione="10/11/2026")], oggi=OGGI)
    reg: list[str] = []
    with tsp._prelios_finto(reg):
        prelios.leggi_pagina_sospesi = tsp.originale_sospesi
        # 1. clic riuscito, griglia comparsa
        a.leggi_sospensione(tsp._browser_sospesi(), p, log=lambda *_: None)
        # 2. chiamata diretta, griglia non comparsa
        a.leggi_sospensione(tsp._browser_sospesi(trovata=False, griglia=False), p,
                            log=lambda *_: None)
        # 3. pagina non aperta
        r = a.leggi_sospensione(tsp._browser_sospesi(trovata=False, wstbs=False), p,
                                log=lambda *_: None)
    assert r[2].startswith("NON LETTA") and "non aperta" in r[2]
    d = a.descrizione_elenco()
    assert d["stato_portale"]["lettura_nota"] == {
        "tentativi": 3, "arrivo_con_clic": 1, "arrivo_con_chiamata_diretta": 1,
        "pagina_non_aperta": 1, "griglia_comparsa": 1, "griglia_non_comparsa": 1}
    testo = json.dumps(d, ensure_ascii=False)
    assert "cliente da richiamare" not in testo and "TESTAFINTA" not in testo
    # un nuovo ciclo riparte da zero
    a.list_assigned(PortaleIcone([riga(5, Sospensione="10/11/2026")], ["SP"]),
                    log=lambda *_: None)
    assert "lettura_nota" not in a.descrizione_elenco()["stato_portale"]
    print("OK test_descrizione_lettura_nota")


def test_avviso_nota_dice_come() -> None:
    """La riga di avviso (una per ciclo) dice come si è arrivati alla pagina
    «Sospesi» e cosa non si è trovato."""
    righe = [HEADER, riga(6, Sospensione="10/11/2026"), riga(7, Sospensione="10/11/2026")]

    class A(AdapterStato):
        def enrich(self, browser, p, log=print, sospensione=None):
            sospensione.update(letta=False, nota="", dal="", esito=(
                "griglia della pagina «Sospesi» non comparsa (pagina aperta con il clic "
                "sulla voce del menu con Anpl_Immobili_Sospesi_ISP; nessuna tabella)"))
            return "", "OK (telefono non trovato)", ""

    s = _servizio(A(righe))
    esito, out = _ciclo(s)
    righe_avviso = [r for r in out.splitlines() if tsp.MSG_NOTA_NON_TROVATA in r]
    assert len(righe_avviso) == 1, out
    assert "clic sulla voce del menu con Anpl_Immobili_Sospesi_ISP" in righe_avviso[0]
    print("OK test_avviso_nota_dice_come")


def test_numero_col_puntino() -> None:
    assert codice_leggibile("844787") == "844.787"
    assert codice_leggibile("84478") == "84.478"
    assert codice_leggibile("1234567") == "1.234.567"
    assert codice_leggibile("844.787") == "844.787"
    assert codice_leggibile(844787) == "844.787"
    assert codice_leggibile("") == "" and codice_leggibile("abc") == "abc"
    assert codice_leggibile("123") == "123"
    # messaggi di prelios.py (ricerca e apertura della perizia)
    log: list[str] = []

    class B:
        def switch_to_default(self): pass
        def wait(self, s): pass
        def execute_js(self, js, *args): return None

    assert prelios.search_perizia(B(), "844787", log=log.append) is False
    assert prelios.open_perizia(B(), "844787", "8468", log=log.append) is False
    assert log == ["Navigazione a Elenco Perizie...",
                   "Perizia 844.787 non trovata nell'elenco",
                   "Riga perizia 844.787 non trovata nella griglia"], log
    # snapshot e cache NON cambiano
    cache = _cache()
    (p,) = parse_grid_rows([HEADER, riga(0)], oggi=OGGI)
    cache.aggiorna_elenco("prelios", [p], adesso=T0)
    assert cache.snapshot("prelios")[0]["codice"] == "700100"
    assert list(cache.data["pratiche"]) == ["prelios:700100"]
    print("OK test_numero_col_puntino")


def main() -> int:
    test_fase_con_icona()
    test_griglia_con_icone()
    test_read_grid_icone()
    test_adapter_non_pubblicate()
    test_servizio_con_icone()
    test_snapshot_attende_la_nota()
    test_descrizione_lettura_nota()
    test_avviso_nota_dice_come()
    test_numero_col_puntino()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
