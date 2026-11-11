"""Cache persistente della modalità servizio (bridge_cache.json).

Ricorda, per ogni pratica di ogni portale, l'ultimo esito del recupero
telefono, così:
- le pratiche già risolte CON telefono non vengono più riaperte sul portale;
- quelle SENZA telefono (non trovato, KO, errore) sono ritentate al massimo
  una volta al giorno;
- un riavvio del bridge non rifà tutto il giro.

Ricorda anche l'ultimo elenco letto per portale, così dopo un riavvio la web
app riceve subito gli ultimi dati noti (mentre si attende il login).

Modulo PURO (solo libreria standard + excel_pratiche): testabile senza
Selenium e senza portale. Contiene dati personali (nomi, telefoni): il file
è nel .gitignore e resta sulla macchina dell'operatore.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from excel_pratiche import Pratica

CACHE_VERSION = 1

# Le pratiche non più viste in nessun elenco da così tanti giorni vengono
# eliminate dalla cache (pulizia dei dati personali non più necessari).
GIORNI_CONSERVAZIONE = 30

TIPOLOGIA_DEFAULT = "FULL - Acquisto"
ESITO_IN_ATTESA = "IN ATTESA"


def iso_utc(quando: datetime | None = None) -> str:
    """'2026-11-11T09:30:00Z' (UTC, secondi)."""
    quando = quando or datetime.now(timezone.utc)
    if quando.tzinfo is None:
        quando = quando.replace(tzinfo=timezone.utc)
    return quando.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(valore: str | None) -> datetime | None:
    if not valore:
        return None
    try:
        return datetime.strptime(valore, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _giorno_locale(quando: datetime) -> str:
    """Giorno di calendario LOCALE (il 'una volta al giorno' segue l'orario
    dell'operatore, non UTC)."""
    if quando.tzinfo is None:
        return quando.date().isoformat()
    return quando.astimezone().date().isoformat()


def componi_note(pratica: Pratica, nota_contatto: str = "") -> str:
    """Note per OptiRoute: progetto | rif. gestore | nota contatto del portale.
    (Stessa composizione della colonna Note dell'Excel del giro classico.)"""
    parti = [p for p in (pratica.progetto, pratica.note_gestore) if p]
    if nota_contatto and all(nota_contatto not in p for p in parti):
        parti.append(f"Contatto Prelios: {nota_contatto[:200]}")
    return " | ".join(parti)


class BridgeCache:
    """Stato persistente: {"version", "pratiche": {chiave: record},
    "elenco": {portale: [codici]}, "lastSync": {portale: iso}}."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.data: dict = self._vuota()

    @staticmethod
    def _vuota() -> dict:
        return {"version": CACHE_VERSION, "pratiche": {}, "elenco": {}, "lastSync": {}}

    @staticmethod
    def chiave(portal: str, codice: str) -> str:
        return f"{portal}:{codice}"

    # --- persistenza ---

    def load(self) -> "BridgeCache":
        """Carica il file se esiste. Un file illeggibile non blocca il bridge:
        viene messo da parte (.corrotto) e si riparte da zero."""
        if not self.path.exists():
            return self
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
                raise ValueError("formato non riconosciuto")
            base = self._vuota()
            base.update({k: data.get(k, base[k]) for k in base})
            self.data = base
        except Exception as e:  # noqa: BLE001 — la cache non deve mai fermare il servizio
            try:
                self.path.replace(self.path.with_suffix(".json.corrotto"))
            except OSError:
                pass
            print(f"ATTENZIONE: cache illeggibile ({e}): riparto da zero.")
            self.data = self._vuota()
        return self

    def save(self) -> None:
        """Scrittura atomica (file temporaneo + replace)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".bridge_cache_", suffix=".tmp",
                                   dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # --- elenco ---

    def aggiorna_elenco(self, portal: str, pratiche: list[Pratica],
                        adesso: datetime | None = None) -> None:
        """Registra l'elenco corrente del portale: aggiorna l'anagrafica delle
        pratiche (senza toccare telefono/esito) e crea quelle nuove."""
        adesso = adesso or datetime.now(timezone.utc)
        ora = iso_utc(adesso)
        codici: list[str] = []
        for p in pratiche:
            if not p.codice or p.codice in codici:
                continue
            codici.append(p.codice)
            k = self.chiave(portal, p.codice)
            rec = self.data["pratiche"].get(k)
            anagrafica = asdict(p)
            if rec is None:
                rec = {"portal": portal, "telefono": "", "esito": ESITO_IN_ATTESA,
                       "notaContatto": "", "ultimoTentativo": None,
                       "ultimoTentativoGiorno": None, "aggiornatoIl": ora}
                self.data["pratiche"][k] = rec
            elif rec.get("pratica") != anagrafica:
                rec["aggiornatoIl"] = ora
            rec["pratica"] = anagrafica
            rec["vistaIl"] = ora
        self.data["elenco"][portal] = codici
        self._pulizia(adesso)

    def _pulizia(self, adesso: datetime) -> None:
        limite = adesso - timedelta(days=GIORNI_CONSERVAZIONE)
        in_elenco = {self.chiave(pt, c) for pt, cs in self.data["elenco"].items() for c in cs}
        for k in list(self.data["pratiche"]):
            if k in in_elenco:
                continue
            vista = _parse_iso(self.data["pratiche"][k].get("vistaIl"))
            if vista is None or vista < limite:
                del self.data["pratiche"][k]

    def elenco(self, portal: str) -> list[Pratica]:
        """Ultimo elenco noto del portale, come Pratica."""
        out = []
        for c in self.data["elenco"].get(portal, []):
            rec = self.data["pratiche"].get(self.chiave(portal, c))
            if rec and isinstance(rec.get("pratica"), dict):
                out.append(Pratica(**rec["pratica"]))
        return out

    # --- cosa lavorare ---

    def da_lavorare(self, portal: str, pratiche: list[Pratica],
                    adesso: datetime | None = None) -> list[Pratica]:
        """Pratiche da aprire sul portale in questo ciclo:
        - mai tentate → sì;
        - già risolte con telefono → no;
        - senza telefono → sì solo se l'ultimo tentativo NON è di oggi."""
        oggi = _giorno_locale(adesso or datetime.now(timezone.utc))
        out: list[Pratica] = []
        for p in pratiche:
            rec = self.data["pratiche"].get(self.chiave(portal, p.codice))
            if rec is None or not rec.get("ultimoTentativoGiorno"):
                out.append(p)
            elif rec.get("telefono"):
                continue
            elif rec["ultimoTentativoGiorno"] != oggi:
                out.append(p)
        return out

    def registra(self, portal: str, pratica: Pratica, telefono: str, esito: str,
                 nota_contatto: str = "", adesso: datetime | None = None) -> None:
        """Salva l'esito di un tentativo. Un telefono già noto non viene
        cancellato da un tentativo successivo andato a vuoto."""
        adesso = adesso or datetime.now(timezone.utc)
        k = self.chiave(portal, pratica.codice)
        rec = self.data["pratiche"].setdefault(k, {"portal": portal})
        rec["pratica"] = asdict(pratica)
        if telefono or not rec.get("telefono"):
            rec["telefono"] = telefono
            rec["esito"] = esito
            rec["notaContatto"] = nota_contatto or rec.get("notaContatto", "")
        rec["ultimoTentativo"] = iso_utc(adesso)
        rec["ultimoTentativoGiorno"] = _giorno_locale(adesso)
        rec["aggiornatoIl"] = iso_utc(adesso)
        rec.setdefault("vistaIl", iso_utc(adesso))

    # --- sync ---

    def set_last_sync(self, portal: str, adesso: datetime | None = None) -> str:
        valore = iso_utc(adesso)
        self.data["lastSync"][portal] = valore
        return valore

    def last_sync(self, portal: str) -> str | None:
        return self.data["lastSync"].get(portal)

    # --- vista per l'HTTP (contratto v1) ---

    def snapshot(self, portal: str) -> list[dict]:
        """Pratiche dell'ultimo elenco del portale nel formato del contratto
        HTTP v1 (campo `pratiche[]`)."""
        out = []
        for c in self.data["elenco"].get(portal, []):
            rec = self.data["pratiche"].get(self.chiave(portal, c))
            if not rec or not isinstance(rec.get("pratica"), dict):
                continue
            p = Pratica(**rec["pratica"])
            out.append({
                "portal": portal,
                "codice": p.codice,
                "intestatario": p.intestatario,
                "via": p.via,
                "civico": p.civico,
                "comune": p.comune,
                "provincia": p.provincia,
                "telefono": rec.get("telefono", "") or "",
                "note": componi_note(p, rec.get("notaContatto", "") or ""),
                "progetto": p.progetto,
                "tipologia": TIPOLOGIA_DEFAULT,
                "esito": rec.get("esito", "") or ESITO_IN_ATTESA,
                "aggiornatoIl": rec.get("aggiornatoIl") or iso_utc(),
            })
        return out

    def conteggi(self, portal: str) -> tuple[int, int]:
        """(pratiche nell'elenco, di cui con telefono)."""
        snap = self.snapshot(portal)
        return len(snap), sum(1 for r in snap if r["telefono"])
