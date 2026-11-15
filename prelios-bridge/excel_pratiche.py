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

Stato sul portale (stato_portale.py): se fra le intestazioni ci sono le
colonne di data dell'Elenco Perizie (Conclusa, Sopralluogo, Valutata,
Sospesa, Revoca, Sospensione, Inoltrata Perizia), ogni pratica riceve fase,
stato e date; altrimenti quei campi restano vuoti (comportamento di prima).
Per l'elenco letto dal portale conta anche l'icona della colonna «VT»
(parse_grid_rows, argomento `icone`); nei file non ci sono icone.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass, fields
from datetime import date
from pathlib import Path
from typing import Iterable, Sequence

try:
    import openpyxl  # type: ignore
    HAS_OPENPYXL = True
except ImportError:  # pragma: no cover - dipende dall'ambiente
    openpyxl = None  # type: ignore
    HAS_OPENPYXL = False

from stato_portale import (NON_RICONOSCIUTA, codice_icona, mappa_colonne_stato,
                           stato_da_riga, trova_intestazioni_stato)

# Tipologia da tenere (forma normalizzata: maiuscolo, spazi collassati)
TIPOLOGIA_TARGET = "FULL - ACQUISTO"

# Estensioni che richiedono openpyxl
_EXT_EXCEL = {".xlsx", ".xlsm", ".xltx", ".xltm"}

# Valori riconosciuti come "tipologia" (ancora dell'euristica posizionale)
_RE_TIPOLOGIA = re.compile(r"^(FULL|DSKT|DRIVE)\s*-\s*\S+", re.IGNORECASE)

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
    # Stato sul portale (vuoti = non noto): vedi stato_portale.py
    fase: str = ""
    stato: str = ""
    data_sopralluogo: str = ""   # AAAA-MM-GG
    data_sospensione: str = ""   # AAAA-MM-GG, solo con fase "sospesa"

    @classmethod
    def da_dict(cls, dati: dict) -> "Pratica":
        """Pratica da un dizionario (cache): le chiavi sconosciute sono
        ignorate, quelle mancanti prendono il valore predefinito (così si
        caricano anche i record scritti dalle versioni precedenti)."""
        nomi = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in dati.items() if k in nomi})

    def con_stato(self, stato: dict) -> "Pratica":
        """Copia nella pratica i campi di stato_portale.stato_perizia."""
        self.fase = stato.get("fase", "")
        self.stato = stato.get("stato", "")
        self.data_sopralluogo = stato.get("data_sopralluogo", "")
        self.data_sospensione = stato.get("data_sospensione", "")
        return self


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


def codice_leggibile(codice: object) -> str:
    """Numero della perizia come lo si legge sul portale, per i messaggi
    della finestra del bridge: '844787' → '844.787' (punto delle migliaia).
    Snapshot e cache tengono il codice com'è: questa è solo la scrittura nei
    messaggi. Un valore che non è fatto di sole cifre resta com'è."""
    s = _cell_str(codice).replace(".", "").replace(" ", "")
    if not s.isdigit() or len(s) < 4:
        return _cell_str(codice)
    gruppi = []
    while s:
        gruppi.insert(0, s[-3:])
        s = s[:-3]
    return ".".join(gruppi)


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
               solo_tipologia: str | None = TIPOLOGIA_TARGET,
               stats: dict | None = None, oggi: date | None = None) -> list[Pratica]:
    """Trasforma righe grezze (liste di celle) in pratiche filtrate.

    Args:
        rows: righe come sequenze di celle (str/int/float/None).
        solo_tipologia: tipologia normalizzata da tenere (default
            'FULL - ACQUISTO'); None per non filtrare.
        stats: se passato, riceve "colonne_stato" ('' se le colonne di
            stato ci sono, altrimenti il motivo).
        oggi: data di riferimento per la fase (default: oggi).

    Returns:
        Lista di Pratica nell'ordine di ingresso.
    """
    righe = [list(r) for r in rows]
    header_idx = _trova_header(righe)

    pratiche: list[Pratica] = []
    oggi = oggi or date.today()
    mappa_stato, motivo_stato = None, "nessuna riga di intestazioni nel file"

    if header_idx >= 0:
        mappa = _mappa_colonne(righe[header_idx])
        col_t = mappa["tipologia"]  # garantita da _trova_header
        mappa_stato, motivo_stato = mappa_colonne_stato(righe[header_idx])
        dati = righe[header_idx + 1:]
        for row in dati:
            if not any(_cell_str(c) for c in row):
                continue
            tipologia = normalizza_tipologia(_get(row, col_t))
            if not _RE_TIPOLOGIA.match(tipologia):
                continue  # riga spuria (totali, separatori, ...)
            if solo_tipologia and tipologia != normalizza_tipologia(solo_tipologia):
                continue
            pratica = _pratica_da_riga_header(row, mappa, col_t)
            if mappa_stato is not None:
                pratica.con_stato(stato_da_riga(row, mappa_stato, oggi))
            pratiche.append(pratica)
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

    if stats is not None:
        stats["colonne_stato"] = "" if mappa_stato is not None else motivo_stato
    return pratiche


def parse_grid_rows(rows: Iterable[Sequence],
                    solo_tipologia: str | None = TIPOLOGIA_TARGET,
                    stats: dict | None = None,
                    intestazioni: Iterable[Sequence] = (),
                    oggi: date | None = None,
                    sospese: set[str] | None = None,
                    icone: Sequence[object] | None = None) -> list[Pratica]:
    """Parsa righe gia' in memoria lette dalla GRIGLIA del portale (non da file).

    Usa SEMPRE l'euristica ancorata alla cella Tipologia (stessi offset e
    stesso filtro FULL - Acquisto di `parse_rows` senza header): le righe
    lette dal DOM possono contenere intestazioni ripetute, righe di layout,
    totali e la stessa griglia vista da piu' frame, quindi la risoluzione per
    nome delle colonne non e' affidabile. In piu' rispetto ai file:
    - le righe senza codice pratica riconoscibile sono scartate (non si
      potrebbero cercare sul portale);
    - deduplica sul codice (tiene la prima occorrenza).

    `load_pratiche`/`parse_rows` NON cambiano comportamento.

    Stato sul portale: la riga delle intestazioni è cercata PER NOME (prima
    fra le righe di celle <th> passate in `intestazioni`, poi fra le righe);
    deve contenere «Tipo Perizia» e tutte le colonne di stato. Una riga dati
    riceve lo stato solo se è allineata alle intestazioni (stesso numero di
    celle e Tipologia nella stessa colonna).

    Args:
        rows: righe come liste di testi delle celle.
        solo_tipologia: tipologia normalizzata da tenere; None per non filtrare.
        stats: se passato, viene riempito con i contatori (righe, con_tipologia,
            altre_tipologie, senza_codice, duplicate, pratiche, senza_stato) e
            con "colonne_stato" ('' se trovate, altrimenti il motivo).
        intestazioni: righe di celle <th> lette dalla pagina (facoltative).
        oggi: data di riferimento per la fase (default: oggi).
        sospese: codici trovati dalla ricerca delle sospese del portale
            (None = ricerca non fatta: ripiego sulla colonna Sospensione).
        icone: codice dell'icona «VT» di ogni riga, ALLINEATO per indice a
            `rows` (None o valore non valido = icona non letta per quella
            riga: regola di prima). None per tutto l'argomento = nessuna
            icona (elenchi da file): regola di prima, senza contarle.
            Le perizie in uno stato non riconosciuto (stato_portale,
            regola 5) NON sono restituite: sono contate per codice in
            stats["non_pubblicate"].
    """
    contatori = {"righe": 0, "con_tipologia": 0, "altre_tipologie": 0,
                 "senza_codice": 0, "duplicate": 0, "pratiche": 0, "senza_stato": 0,
                 "senza_icona": 0}
    conta_icone: dict[str, int] = {}
    non_pubblicate: dict[str, int] = {}
    icone = list(icone) if icone is not None else None
    target = normalizza_tipologia(solo_tipologia) if solo_tipologia else None
    visti: set[str] = set()
    pratiche: list[Pratica] = []
    rows = [list(r) for r in rows]
    oggi = oggi or date.today()
    header, mappa_stato, motivo_stato = trova_intestazioni_stato(rows, intestazioni)

    for indice, row in enumerate(rows):
        row = list(row)
        contatori["righe"] += 1
        if not any(_cell_str(c) for c in row):
            continue
        col_t = _trova_colonna_tipologia(row)
        if col_t < 0:
            continue  # intestazione, riga di layout, totali, paginazione...
        contatori["con_tipologia"] += 1
        icona = None
        if icone is not None:
            icona = codice_icona(icone[indice]) if indice < len(icone) else None
            if icona:
                conta_icone[icona] = conta_icone.get(icona, 0) + 1
        tipologia = normalizza_tipologia(_get(row, col_t))
        if target and tipologia != target:
            contatori["altre_tipologie"] += 1
            continue
        pratica = _pratica_da_riga_euristica(row, col_t)
        if not pratica.codice:
            contatori["senza_codice"] += 1
            continue
        if pratica.codice in visti:
            contatori["duplicate"] += 1
            continue
        visti.add(pratica.codice)
        if mappa_stato is not None:
            if len(row) == len(header) and col_t == mappa_stato["tipologia"]:
                ora = None if sospese is None else pratica.codice in sospese
                if icone is not None and icona is None:
                    contatori["senza_icona"] += 1
                pratica.con_stato(stato_da_riga(row, mappa_stato, oggi, ora, icona))
                if pratica.fase == NON_RICONOSCIUTA:
                    non_pubblicate[icona] = non_pubblicate.get(icona, 0) + 1
                    continue   # né pubblicata né aperta
            else:
                contatori["senza_stato"] += 1
        pratiche.append(pratica)

    contatori["pratiche"] = len(pratiche)
    if stats is not None:
        stats.update(contatori)
        stats["colonne_stato"] = "" if mappa_stato is not None else motivo_stato
        stats["icone"] = conta_icone
        stats["non_pubblicate"] = non_pubblicate
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
    (tab > punto e virgola > virgola).

    Il separatore viene cercato sulla PRIMA riga che ne contiene uno:
    righe vuote o di titolo ("Elenco perizie...") in testa al file non
    devono far degradare il rilevamento a virgola. La decodifica prova
    UTF-8 e ripiega su cp1252 (export ANSI di Excel italiano) per non
    corrompere le lettere accentate di nomi e indirizzi.
    """
    raw = path.read_bytes()
    try:
        testo = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        testo = raw.decode("cp1252", errors="replace")

    delim = ","
    for riga in testo.splitlines():
        if not riga.strip():
            continue
        if "\t" in riga:
            delim = "\t"
            break
        if ";" in riga:
            delim = ";"
            break
        if "," in riga:
            delim = ","
            break
    return [list(r) for r in csv.reader(testo.splitlines(), delimiter=delim)]


def load_pratiche(path: str | Path,
                  solo_tipologia: str | None = TIPOLOGIA_TARGET,
                  stats: dict | None = None) -> list[Pratica]:
    """Carica l'elenco pratiche da file Excel (.xlsx) o testuale (TSV/CSV).

    Args:
        path: percorso del file elenco.
        solo_tipologia: tipologia da tenere (default 'FULL - ACQUISTO');
            None per non filtrare.
        stats: se passato, riceve "colonne_stato" (vedi parse_rows).

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

    return parse_rows(rows, solo_tipologia=solo_tipologia, stats=stats)
