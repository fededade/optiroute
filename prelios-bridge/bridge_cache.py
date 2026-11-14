"""Cache persistente della modalità servizio (bridge_cache.json).

Ricorda, per ogni pratica di ogni portale, l'ultimo esito del recupero
telefono, così:
- le pratiche già risolte CON telefono non vengono più riaperte sul portale;
- quelle SENZA telefono (non trovato, KO, errore) sono ritentate al massimo
  una volta al giorno;
- un riavvio del bridge non rifà tutto il giro.

Ricorda anche l'ultimo elenco letto per portale, così dopo un riavvio la web
app riceve subito gli ultimi dati noti (mentre si attende il login).

Stato sul portale (stato_portale.py): le pratiche con il sopralluogo già
fissato, già fatto o chiuse NON vengono aperte (non verranno programmate);
per quelle sospese si legge anche la nota di sospensione, riletta quando
cambia la data di sospensione o dopo 24 ore. Il formato del file resta la
versione 1: i record scritti prima non hanno i campi nuovi e restano validi.

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
from stato_portale import FASI_DA_NON_APRIRE, SOSPESA, fase_con_nota

# Versione del formato: i campi nuovi (stato sul portale, nota di
# sospensione) sono facoltativi, quindi resta 1 e i file vecchi si caricano.
CACHE_VERSION = 1

# Nota di sospensione: si rilegge dopo così tante ore (o se cambia la data
# di sospensione); al massimo tante riletture per ciclo (le altre al ciclo dopo).
ORE_RILETTURA_SOSPENSIONE = 24
MAX_RILETTURE_SOSPENSIONE = 10

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
            if p.fase != SOSPESA:
                rec.pop("sospensione", None)  # non più sospesa: nota non più valida
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
                out.append(Pratica.da_dict(rec["pratica"]))
        return out

    # --- cosa lavorare ---

    def da_lavorare(self, portal: str, pratiche: list[Pratica],
                    adesso: datetime | None = None) -> list[Pratica]:
        """Pratiche da aprire sul portale in questo ciclo per il telefono:
        - sopralluogo fissato, già fatto o perizia chiusa → no (non verranno
          programmate; se tornano da fissare o sospese si aprono allora);
        - mai tentate → sì;
        - già risolte con telefono → no;
        - senza telefono → sì solo se l'ultimo tentativo NON è di oggi."""
        oggi = _giorno_locale(adesso or datetime.now(timezone.utc))
        out: list[Pratica] = []
        for p in pratiche:
            rec = self.data["pratiche"].get(self.chiave(portal, p.codice))
            if self._fase(rec, p)[0] in FASI_DA_NON_APRIRE:
                continue
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

    def sospensioni_da_rileggere(self, portal: str, pratiche: list[Pratica],
                                 escludi: set[str] = frozenset(),
                                 adesso: datetime | None = None,
                                 massimo: int = MAX_RILETTURE_SOSPENSIONE) -> list[Pratica]:
        """Pratiche sospese da riaprire SOLO per la nota di sospensione:
        mai lette, data di sospensione cambiata dall'ultima lettura, o ultima
        lettura più vecchia di 24 ore. Prima le mai lette, poi quelle con la
        data cambiata, poi le più vecchie; al massimo `massimo`. `escludi`:
        codici già aperti in questo ciclo per il telefono."""
        adesso = adesso or datetime.now(timezone.utc)
        limite = adesso - timedelta(hours=ORE_RILETTURA_SOSPENSIONE)
        candidati: list[tuple[int, str, Pratica]] = []
        for p in pratiche:
            if p.fase != SOSPESA or p.codice in escludi:
                continue
            rec = self.data["pratiche"].get(self.chiave(portal, p.codice)) or {}
            sosp = rec.get("sospensione") if isinstance(rec.get("sospensione"), dict) else {}
            tentata = _parse_iso(sosp.get("tentataIl"))
            if tentata is None:
                candidati.append((0, "", p))
            elif (sosp.get("dal") or "") != p.data_sospensione:
                candidati.append((1, sosp.get("tentataIl", ""), p))
            elif tentata < limite:
                candidati.append((2, sosp.get("tentataIl", ""), p))
        candidati.sort(key=lambda c: (c[0], c[1]))
        return [p for _o, _t, p in candidati[:max(0, massimo)]]

    def registra_sospensione(self, portal: str, pratica: Pratica, nota: str,
                             letta: bool, data_nota: str = "",
                             adesso: datetime | None = None) -> None:
        """Salva il tentativo di lettura della nota di sospensione (pagina
        «Sospesi»; data_nota = data della riga letta, AAAA-MM-GG). Se la
        pagina non è stata letta resta la nota precedente, ma il tentativo
        conta (si riprova dopo 24 ore o se cambia la data di sospensione)."""
        adesso = adesso or datetime.now(timezone.utc)
        k = self.chiave(portal, pratica.codice)
        rec = self.data["pratiche"].setdefault(k, {"portal": portal})
        prima = rec.get("sospensione") if isinstance(rec.get("sospensione"), dict) else {}
        rec["sospensione"] = {
            "nota": nota if letta else prima.get("nota", ""),
            "dataNota": data_nota if letta else prima.get("dataNota", ""),
            "dal": pratica.data_sospensione,
            "tentataIl": iso_utc(adesso),
            "letta": bool(letta),
        }

    @staticmethod
    def _fase(rec: dict | None, p: Pratica) -> tuple[str, str, str]:
        """(fase, stato, dataSopralluogo) finali: quelle dell'elenco, salvo
        una sospesa la cui nota dice «sopralluogo fissato» con una data."""
        sosp = (rec or {}).get("sospensione")
        nota = str(sosp.get("nota") or "") if isinstance(sosp, dict) else ""
        fase, stato, data = fase_con_nota(p.fase, p.data_sopralluogo, nota)
        return fase, stato or p.stato, data

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
        HTTP v1 (campo `pratiche[]`). I campi dello stato sul portale
        (contratto §6: stato, fase, dataSopralluogo, sospensione) ci sono
        solo quando noti."""
        out = []
        for c in self.data["elenco"].get(portal, []):
            rec = self.data["pratiche"].get(self.chiave(portal, c))
            if not rec or not isinstance(rec.get("pratica"), dict):
                continue
            p = Pratica.da_dict(rec["pratica"])
            riga = {
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
            }
            fase, stato, data_sopralluogo = self._fase(rec, p)
            if stato:
                riga["stato"] = stato
            if fase:
                riga["fase"] = fase
            if data_sopralluogo:
                riga["dataSopralluogo"] = data_sopralluogo
            if fase == SOSPESA:
                sosp = rec.get("sospensione") if isinstance(rec.get("sospensione"), dict) else {}
                riga["sospensione"] = {"nota": str(sosp.get("nota") or "")}
                dal = str(sosp.get("dataNota") or "") or p.data_sospensione
                if dal:
                    riga["sospensione"]["dal"] = dal
            out.append(riga)
        return out

    def testi_letti(self, portal: str) -> list[str]:
        """Note di contatto e di sospensione lette dal portale (per il
        controllo finale di elenco_struttura.json: non devono comparirvi)."""
        out: list[str] = []
        for rec in self.data["pratiche"].values():
            if rec.get("portal") != portal:
                continue
            out.append(str(rec.get("notaContatto") or ""))
            sosp = rec.get("sospensione")
            if isinstance(sosp, dict):
                out.append(str(sosp.get("nota") or ""))
        return [t for t in out if t]

    def conteggi(self, portal: str) -> tuple[int, int]:
        """(pratiche nell'elenco, di cui con telefono)."""
        snap = self.snapshot(portal)
        return len(snap), sum(1 for r in snap if r["telefono"])
