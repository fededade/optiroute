#!/usr/bin/env python3
"""Test PURI della cache della modalità servizio (bridge_cache.py).

Dati SINTETICI e ANONIMI, file in una cartella temporanea. Copre: pratiche
nuove, gia' risolte con telefono (mai riaperte), senza telefono (ritentate al
massimo una volta al giorno), persistenza dopo riavvio, snapshot nel formato
del contratto HTTP v1, cache corrotta, pulizia delle pratiche vecchie.

Esecuzione:
    python test_bridge_cache.py
"""

from __future__ import annotations

import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_cache import BridgeCache, GIORNI_CONSERVAZIONE  # noqa: E402
from excel_pratiche import Pratica  # noqa: E402

CAMPI_CONTRATTO = {"portal", "codice", "intestatario", "via", "civico", "comune",
                   "provincia", "telefono", "note", "progetto", "tipologia",
                   "esito", "aggiornatoIl"}


def pratica(codice: str, nome: str = "ROSSI MARIO") -> Pratica:
    return Pratica(codice=codice, intestatario=nome, via="VIA ROMA", civico="10",
                   comune="PAVIA", provincia="PV", progetto="PROGETTO X",
                   note_gestore="")


def _tmp() -> Path:
    return Path(tempfile.mkdtemp(prefix="test_bridge_cache_")) / "bridge_cache.json"


def test_nuove_risolte_ritentativo() -> None:
    cache = BridgeCache(_tmp())
    # Mezzogiorno UTC: "stesso giorno" anche in ora locale con qualunque fuso
    t0 = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
    a, b, c = pratica("100001"), pratica("100002", "VERDI ANNA"), pratica("100003")
    cache.aggiorna_elenco("prelios", [a, b, c], adesso=t0)

    # Tutte nuove → tutte da lavorare
    assert [p.codice for p in cache.da_lavorare("prelios", [a, b, c], t0)] == \
        ["100001", "100002", "100003"]

    cache.registra("prelios", a, "+393331234567", "OK", "Mario - 3331234567", adesso=t0)
    cache.registra("prelios", b, "", "OK (telefono non trovato)", adesso=t0)
    cache.registra("prelios", c, "", "KO perizia non trovata", adesso=t0)

    # Stesso giorno: la risolta mai piu', le senza telefono non ancora
    stesso_giorno = t0 + timedelta(minutes=30)
    assert cache.da_lavorare("prelios", [a, b, c], stesso_giorno) == []

    # Giorno dopo: si ritentano solo quelle senza telefono
    domani = t0 + timedelta(days=1)
    assert [p.codice for p in cache.da_lavorare("prelios", [a, b, c], domani)] == \
        ["100002", "100003"]

    # Una pratica nuova comparsa nell'elenco e' subito da lavorare
    d = pratica("100004")
    assert [p.codice for p in cache.da_lavorare("prelios", [a, d], stesso_giorno)] == ["100004"]

    # Lo stesso codice su un altro portale e' un'altra pratica
    assert len(cache.da_lavorare("cerved", [a], stesso_giorno)) == 1
    print("OK test_nuove_risolte_ritentativo")


def test_persistenza_riavvio() -> None:
    path = _tmp()
    t0 = datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc)
    cache = BridgeCache(path)
    a, b = pratica("200001"), pratica("200002")
    cache.aggiorna_elenco("prelios", [a, b], adesso=t0)
    cache.registra("prelios", a, "+393331234567", "OK", adesso=t0)
    cache.set_last_sync("prelios", t0)
    cache.save()

    riavviata = BridgeCache(path).load()
    assert riavviata.last_sync("prelios") == "2026-11-11T09:00:00Z"
    assert [p.codice for p in riavviata.elenco("prelios")] == ["200001", "200002"]
    assert [p.codice for p in riavviata.da_lavorare("prelios", [a, b], t0)] == ["200002"]
    assert riavviata.conteggi("prelios") == (2, 1)
    print("OK test_persistenza_riavvio")


def test_snapshot_contratto() -> None:
    cache = BridgeCache(_tmp())
    t0 = datetime(2026, 11, 11, 9, 29, 41, tzinfo=timezone.utc)
    a = pratica("826361")
    a.note_gestore = "Rif. Gestore: BRUNO STEFANO"
    cache.aggiorna_elenco("prelios", [a, pratica("826362")], adesso=t0)
    cache.registra("prelios", a, "+393331234567", "OK", "Mario Bianchi - 3331234567", adesso=t0)

    snap = cache.snapshot("prelios")
    assert len(snap) == 2
    r = snap[0]
    assert set(r) == CAMPI_CONTRATTO, set(r) ^ CAMPI_CONTRATTO
    assert r["portal"] == "prelios" and r["codice"] == "826361"
    assert r["telefono"] == "+393331234567" and r["esito"] == "OK"
    assert r["tipologia"] == "FULL - Acquisto"
    assert r["aggiornatoIl"] == "2026-11-11T09:29:41Z"
    assert r["note"] == ("PROGETTO X | Rif. Gestore: BRUNO STEFANO | "
                         "Contatto Prelios: Mario Bianchi - 3331234567"), r["note"]
    assert snap[1]["esito"] == "IN ATTESA" and snap[1]["telefono"] == ""
    assert all(isinstance(v, str) for row in snap for v in row.values())

    # Le pratiche uscite dall'elenco non sono piu' esposte
    cache.aggiorna_elenco("prelios", [a], adesso=t0)
    assert [r["codice"] for r in cache.snapshot("prelios")] == ["826361"]
    print("OK test_snapshot_contratto")


def test_anagrafica_aggiornata_telefono_conservato() -> None:
    cache = BridgeCache(_tmp())
    t0 = datetime(2026, 11, 11, 9, 0, tzinfo=timezone.utc)
    a = pratica("300001")
    cache.aggiorna_elenco("prelios", [a], adesso=t0)
    cache.registra("prelios", a, "+393331234567", "OK", adesso=t0)
    a2 = pratica("300001")
    a2.civico = "12"
    cache.aggiorna_elenco("prelios", [a2], adesso=t0 + timedelta(hours=1))
    (r,) = cache.snapshot("prelios")
    assert r["civico"] == "12" and r["telefono"] == "+393331234567"
    print("OK test_anagrafica_aggiornata_telefono_conservato")


def test_cache_corrotta_e_pulizia() -> None:
    path = _tmp()
    path.write_text("{ non e' json", encoding="utf-8")
    cache = BridgeCache(path).load()  # non deve sollevare
    assert cache.data["pratiche"] == {}
    assert path.with_suffix(".json.corrotto").exists()

    t0 = datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc)
    cache.aggiorna_elenco("prelios", [pratica("400001"), pratica("400002")], adesso=t0)
    dopo = t0 + timedelta(days=GIORNI_CONSERVAZIONE + 1)
    cache.aggiorna_elenco("prelios", [pratica("400002")], adesso=dopo)
    assert "prelios:400001" not in cache.data["pratiche"]
    assert "prelios:400002" in cache.data["pratiche"]
    print("OK test_cache_corrotta_e_pulizia")


def main() -> int:
    test_nuove_risolte_ritentativo()
    test_persistenza_riavvio()
    test_snapshot_contratto()
    test_anagrafica_aggiornata_telefono_conservato()
    test_cache_corrotta_e_pulizia()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
