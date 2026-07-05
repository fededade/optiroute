"""Lettura dell'elenco pratiche (Excel/TSV/CSV) per il bridge Prelios -> OptiRoute.

Modulo STANDALONE: nessuna dipendenza dalla pipeline MISI. L'unica dipendenza
opzionale e' openpyxl (per i file .xlsx): se assente, il modulo degrada alla
lettura di file testuali TSV/CSV senza perdere funzionalita'.

Individuazione colonne:
- se nelle prime righe c'e' una riga di intestazione (contiene "Tipologia"),
  le colonne vengono risolte per NOME (con sinonimi);
- altrimenti si usa un'euristica ANCORATA sulla colonna Tipologia (valori
  tipo "FULL - Acquisto", "FULL - Surroga", "DSKT - ALTRO"): detta T la sua
  posizione, intestatario=T+3, via=T+4, civico=T+5, comune=T+6,
  provincia=T+7, progetto=T-2; il codice pratica e' la cella numerica a
  5-7 cifre nelle prime 4 colonne.

Vengono restituite SOLO le pratiche con tipologia "FULL - Acquisto"
(confronto case-insensitive, spazi collassati), salvo diversa indicazione.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

try:
    import openpyxl  # type: ignore
    HAS_OPENPYXL = True
except ImportError:  # pragma: no cover - dipende dall'ambiente
    openpyxl = None  # type: ignore
    HAS_OPENPYXL = False

# Tipologia da tenere (forma normalizzata: maiuscolo, spazi collassati)
TIPOLOGIA_TARGET = "FULL - ACQUISTO"

# Estensioni che richiedono openpyxl
_EXT_EXCEL = {".xlsx", ".xlsm", ".xltx", ".xltm"}

# Valori riconosciuti come "tipologia" (ancora dell'euristica posizionale)
_RE_TIPOLOGIA = re.compile(r"^(FULL|DSKT)\s*-\s*\S+", re.IGNORECASE)

# Codice pratica/perizia: 5-7 cifre, eventualmente con punto migliaia (810.766)
_RE_CODICE = re.compile(r"^\d{5,7}$")

# Riferimento gestore nelle note: "Rif. Gestore: NOME [telefono] [email]"
_RE_RIF_GESTORE = re.compile(r"Rif\.?\s*Gestore\s*:\s*.+", re.IGNORECASE)

# Offset delle colonne rispetto alla colonna Tipologia (T)
_OFFSET_PROGETTO = -2
_OFFSET_INTESTATARIO = 3
_OFFSET_VIA = 4
_OFFSET_CIVICO = 5
_OFFSET_COMUNE = 6
_OFFSET_PROVINCIA = 7

# Sinonimi per la risoluzione delle colonne via intestazione
_SINONIMI: dict[str, tuple[str, ...]] = {
    "codice": ("codice", "codice pratica", "cod pratica", "codice perizia",
               "cod perizia", "cod immobile", "pratica", "id pratica"),
    "tipologia": ("tipologia", "tipo perizia", "tipologia perizia"),
    "intestatario": ("intestatario", "nominativo", "cliente", "intestatari"),
    "via": ("via", "indirizzo", "ubicazione"),
    "civico": ("civico", "n civ", "nciv", "n civico", "num civico", "nr civico"),
    "comune": ("comune", "citta", "localita"),
    "provincia": ("provincia", "prov", "pr", "sigla prov"),
    "progetto": ("progetto", "prog", "commessa"),
    "note": ("note", "annotazioni", "osservazioni", "note gestore"),
}


@dataclass
class Pratica:
    """Una pratica (perizia) dell'elenco, gia' normalizzata per il giro."""

    codice: str
    intestatario: str
    via: str
    civico: str
    comune: str
    provincia: str
    progetto: str
    note_gestore: str = ""


# === NORMALIZZAZIONE ===

def _cell_str(value: object) -> str:
    """Converte una cella (str/int/float/None) in stringa pulita.

    Gestisce i numerici di Excel: 810766.0 -> '810766'.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def normalizza_tipologia(value: object) -> str:
    """Normalizza una tipologia per il confronto: maiuscolo, spazi collassati,
    trattino uniformato ('full  -Acquisto' -> 'FULL - ACQUISTO')."""
    s = _cell_str(value).upper()
    s = re.sub(r"\s*-\s*", " - ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _norm_header(value: object) -> str:
    """Normalizza un nome di colonna per il matching con i sinonimi."""
    s = _cell_str(value).lower()
    s = re.sub(r"[.:;()\[\]]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _get(row: Sequence, idx: int) -> str:
    """Legge la cella `idx` di `row`, '' se fuori range o negativa."""
    if idx < 0 or idx >= len(row):
        return ""
    return _cell_str(row[idx])


def _estrai_codice(row: Sequence, colonne_max: int = 4) -> str:
    """Cerca il codice pratica: cella numerica a 5-7 cifre nelle prime
    `colonne_max` colonne (accetta anche il formato con punto: 810.766)."""
    for i in range(min(colonne_max, len(row))):
        raw = _cell_str(row[i])
        candidato = raw.replace(".", "").replace(" ", "")
        if _RE_CODICE.match(candidato):
            return candidato
    return ""


def _estrai_rif_gestore(celle: Iterable[object]) -> str:
    """Cerca il pattern 'Rif. Gestore: ...' nelle celle indicate (tipicamente
    l'ultima colonna note). Restituisce il testo del riferimento o ''."""
    for cella in celle:
        testo = _cell_str(cella)
        if not testo:
            continue
        m = _RE_RIF_GESTORE.search(testo)
        if m:
            return re.sub(r"\s+", " ", m.group(0)).strip()
    return ""


# === RISOLUZIONE COLONNE ===

def _trova_header(rows: list[Sequence]) -> int:
    """Cerca una riga di intestazione nelle prime righe (una riga che contiene
    una cella 'Tipologia'). Restituisce l'indice riga, o -1 se assente."""
    for r, row in enumerate(rows[:10]):
        for cell in row:
            if _norm_header(cell) in _SINONIMI["tipologia"]:
                return r
    return -1


def _mappa_colonne(header: Sequence) -> dict[str, int]:
    """Mappa nome-logico -> indice colonna usando i sinonimi noti."""
    mappa: dict[str, int] = {}
    normalizzati = [_norm_header(c) for c in header]
    for logico, sinonimi in _SINONIMI.items():
        for idx, nome in enumerate(normalizzati):
            if nome in sinonimi:
                mappa[logico] = idx
                break
    return mappa


def _trova_colonna_tipologia(row: Sequence) -> int:
    """Indice della cella che 'sembra' una tipologia (FULL - .../DSKT - ...),
    -1 se assente. E' l'ancora dell'euristica posizionale."""
    for i, cell in enumerate(row):
        if _RE_TIPOLOGIA.match(_cell_str(cell)):
            return i
    return -1


# === PARSING RIGHE ===

def _pratica_da_riga_euristica(row: Sequence, col_t: int) -> Pratica:
    """Costruisce una Pratica con gli offset ancorati alla colonna Tipologia."""
    return Pratica(
        codice=_estrai_codice(row),
        intestatario=_get(row, col_t + _OFFSET_INTESTATARIO),
        via=_get(row, col_t + _OFFSET_VIA),
        civico=_get(row, col_t + _OFFSET_CIVICO),
        comune=_get(row, col_t + _OFFSET_COMUNE),
        provincia=_get(row, col_t + _OFFSET_PROVINCIA),
        progetto=_get(row, col_t + _OFFSET_PROGETTO),
        # Le note stanno DOPO le colonne indirizzo: scandiamo dalla fine
        note_gestore=_estrai_rif_gestore(reversed(list(row[col_t + _OFFSET_PROVINCIA + 1:]))),
    )


def _pratica_da_riga_header(row: Sequence, mappa: dict[str, int],
                            col_t: int) -> Pratica:
    """Costruisce una Pratica dalle colonne risolte per nome; per le colonne
    mancanti ripiega sugli offset rispetto alla colonna Tipologia."""

    def campo(nome: str, offset: int) -> str:
        if nome in mappa:
            return _get(row, mappa[nome])
        return _get(row, col_t + offset)

    if "codice" in mappa:
        raw = _get(row, mappa["codice"]).replace(".", "").replace(" ", "")
        codice = raw if _RE_CODICE.match(raw) else _estrai_codice(row)
    else:
        codice = _estrai_codice(row)

    if "note" in mappa:
        note_gestore = _estrai_rif_gestore([_get(row, mappa["note"])])
    else:
        note_gestore = _estrai_rif_gestore(reversed([_cell_str(c) for c in row]))

    return Pratica(
        codice=codice,
        intestatario=campo("intestatario", _OFFSET_INTESTATARIO),
        via=campo("via", _OFFSET_VIA),
        civico=campo("civico", _OFFSET_CIVICO),
        comune=campo("comune", _OFFSET_COMUNE),
        provincia=campo("provincia", _OFFSET_PROVINCIA),
        progetto=campo("progetto", _OFFSET_PROGETTO),
        note_gestore=note_gestore,
    )


def parse_rows(rows: Iterable[Sequence],
               solo_tipologia: str | None = TIPOLOGIA_TARGET) -> list[Pratica]:
    """Trasforma righe grezze (liste di celle) in pratiche filtrate.

    Args:
        rows: righe come sequenze di celle (str/int/float/None).
        solo_tipologia: tipologia normalizzata da tenere (default
            'FULL - ACQUISTO'); None per non filtrare.

    Returns:
        Lista di Pratica nell'ordine di ingresso.
    """
    righe = [list(r) for r in rows]
    header_idx = _trova_header(righe)

    pratiche: list[Pratica] = []

    if header_idx >= 0:
        mappa = _mappa_colonne(righe[header_idx])
        col_t = mappa["tipologia"]  # garantita da _trova_header
        dati = righe[header_idx + 1:]
        for row in dati:
            if not any(_cell_str(c) for c in row):
                continue
            tipologia = normalizza_tipologia(_get(row, col_t))
            if not _RE_TIPOLOGIA.match(tipologia):
                continue  # riga spuria (totali, separatori, ...)
            if solo_tipologia and tipologia != normalizza_tipologia(solo_tipologia):
                continue
            pratiche.append(_pratica_da_riga_header(row, mappa, col_t))
    else:
        for row in righe:
            if not any(_cell_str(c) for c in row):
                continue
            col_t = _trova_colonna_tipologia(row)
            if col_t < 0:
                continue  # riga senza tipologia riconoscibile
            tipologia = normalizza_tipologia(_get(row, col_t))
            if solo_tipologia and tipologia != normalizza_tipologia(solo_tipologia):
                continue
            pratiche.append(_pratica_da_riga_euristica(row, col_t))

    return pratiche


# === LETTURA FILE ===

def _leggi_excel(path: Path) -> list[list[object]]:
    """Legge il primo foglio di un .xlsx con openpyxl (values_only)."""
    if not HAS_OPENPYXL:
        raise RuntimeError(
            f"Il file '{path.name}' e' un Excel ma openpyxl non e' installato. "
            "Installare con 'pip install openpyxl' oppure esportare l'elenco "
            "in formato TSV/CSV e ripassarlo a load_pratiche()."
        )
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        ws = wb.active
        return [list(row) for row in ws.iter_rows(values_only=True)]
    finally:
        wb.close()


def _leggi_testo(path: Path) -> list[list[object]]:
    """Legge un file testuale TSV/CSV rilevando il separatore
    (tab > punto e virgola > virgola)."""
    testo = path.read_text(encoding="utf-8-sig", errors="replace")
    prima_riga = testo.splitlines()[0] if testo.splitlines() else ""
    if "\t" in prima_riga:
        delim = "\t"
    elif ";" in prima_riga:
        delim = ";"
    else:
        delim = ","
    return [list(r) for r in csv.reader(testo.splitlines(), delimiter=delim)]


def load_pratiche(path: str | Path,
                  solo_tipologia: str | None = TIPOLOGIA_TARGET) -> list[Pratica]:
    """Carica l'elenco pratiche da file Excel (.xlsx) o testuale (TSV/CSV).

    Args:
        path: percorso del file elenco.
        solo_tipologia: tipologia da tenere (default 'FULL - ACQUISTO');
            None per non filtrare.

    Returns:
        Lista di Pratica filtrate.

    Raises:
        FileNotFoundError: se il file non esiste.
        RuntimeError: se il file e' Excel e openpyxl non e' disponibile.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Elenco pratiche non trovato: {path}")

    if path.suffix.lower() in _EXT_EXCEL:
        rows = _leggi_excel(path)
    else:
        rows = _leggi_testo(path)

    return parse_rows(rows, solo_tipologia=solo_tipologia)
