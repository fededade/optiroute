"""Stato di ogni perizia sul portale, letto dalle colonne di data dell'elenco.

L'Elenco Perizie del portale ha, fra le altre, queste colonne (nomi presi
dalla descrizione anonima `elenco_struttura.json` prodotta dal bridge sul
portale vero): Conclusa, Sopralluogo, Valutata, Sospesa, Revoca,
Sospensione, Inoltrata Perizia. Le colonne di data contengono `gg/mm/aaaa`
oppure sono vuote; «Sospesa» e «Revoca» sul portale vero hanno sempre il
testo vuoto (forse un'icona: NON verificato).

Le colonne sono trovate PER NOME nella riga delle intestazioni, mai per
posizione. Se le intestazioni non si trovano o manca una colonna, nessun
campo di stato (comportamento di prima).

Fase (regole in ordine di precedenza, `oggi` è un parametro):
- `chiusa`      Conclusa, Inoltrata Perizia o Revoca non vuote;
- `effettuato`  Valutata non vuota, oppure Sopralluogo con data prima di oggi;
- `fissato`     Sopralluogo con data di oggi o successiva;
- `sospesa`     la perizia è fra quelle trovate dalla SECONDA ricerca del
                portale («Stato Perizia» = sospesa): sono le sospese ADESSO.
                Se quella ricerca non è stata possibile, ripiego: colonna
                Sospensione (o Sospesa) non vuota. (Una data in Sospensione
                da sola non basta: la perizia può essere stata riattivata.)
- `da_fissare`  altrimenti.

Nota di sospensione: dalla pagina «Sospesi» della perizia (vedi
prelios.leggi_pagina_sospesi): la riga più recente. Se dice «sopralluogo
fissato ... gg/mm/aaaa» e la colonna Sopralluogo è vuota, la perizia vale
`fissato` con quella data (fase_con_nota).

Modulo PURO (solo libreria standard): testabile senza portale.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Iterable, Sequence

# Fasi (contratto §6)
DA_FISSARE = "da_fissare"
FISSATO = "fissato"
EFFETTUATO = "effettuato"
SOSPESA = "sospesa"
CHIUSA = "chiusa"
FASI = (DA_FISSARE, FISSATO, EFFETTUATO, SOSPESA, CHIUSA)
# Perizie che non verranno programmate: il bridge non le apre sul portale
FASI_DA_NON_APRIRE = frozenset({FISSATO, EFFETTUATO, CHIUSA})

STATO_MAX = 80
NOTA_MAX = 600
SEPARATORE_NOTA = " · "

# Nome logico → intestazione normalizzata (vedi norm_intestazione)
COLONNE_STATO: dict[str, str] = {
    "conclusa": "conclusa",
    "sopralluogo": "sopralluogo",
    "valutata": "valutata",
    "sospesa": "sospesa",
    "revoca": "revoca",
    "sospensione": "sospensione",
    "inoltrata": "inoltrata perizia",
}
# Intestazioni della colonna di ancoraggio (Tipologia / Tipo Perizia)
INTESTAZIONI_TIPOLOGIA = ("tipologia", "tipo perizia", "tipologia perizia")

_RE_DATA_IT = re.compile(r"^(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})(?:\s|$)")
_RE_DATA_ISO = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)")


# === INTESTAZIONI ===

def norm_intestazione(valore: object) -> str:
    """'Inoltrata  Perizia' → 'inoltrata perizia', 'N.Civ.' → 'n civ':
    minuscolo, punteggiatura → spazio, spazi collassati."""
    s = "" if valore is None else str(valore).lower()
    s = re.sub(r"[.:;,()\[\]_]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def mappa_colonne_stato(intestazioni: Sequence) -> tuple[dict[str, int] | None, str]:
    """Indici delle colonne di stato e della Tipologia, per NOME.

    Returns:
        (mappa {nome logico: indice, "tipologia": indice}, "") se ci sono
        tutte; (None, motivo) altrimenti."""
    norm = [norm_intestazione(c) for c in intestazioni]
    mappa: dict[str, int] = {}
    for i, n in enumerate(norm):
        if n in INTESTAZIONI_TIPOLOGIA and "tipologia" not in mappa:
            mappa["tipologia"] = i
    if "tipologia" not in mappa:
        return None, "manca la colonna Tipo Perizia"
    mancanti = []
    for logico, nome in COLONNE_STATO.items():
        if nome in norm:
            mappa[logico] = norm.index(nome)
        else:
            mancanti.append(nome.title())
    if mancanti:
        return None, "mancano le colonne " + ", ".join(mancanti)
    return mappa, ""


def trova_intestazioni_stato(righe: Iterable[Sequence],
                             candidati: Iterable[Sequence] = ()) -> tuple[list[str] | None,
                                                                         dict[str, int] | None,
                                                                         str]:
    """Cerca la riga delle intestazioni con le colonne di stato: prima fra i
    `candidati` (righe di celle <th> lette dalla pagina), poi fra le righe.

    Returns:
        (intestazioni, mappa, "") oppure (None, None, motivo)."""
    motivo = "nessuna riga di intestazioni con «Tipo Perizia» trovata"
    for riga in list(candidati) + list(righe):
        celle = ["" if c is None else str(c) for c in riga]
        norm = [norm_intestazione(c) for c in celle]
        if not any(n in INTESTAZIONI_TIPOLOGIA for n in norm):
            continue
        mappa, perche = mappa_colonne_stato(celle)
        if mappa is not None:
            return celle, mappa, ""
        motivo = f"intestazioni trovate ma {perche}"
    return None, None, motivo


# === DATE ===

def leggi_data(valore: object) -> date | None:
    """Data da una cella: 'gg/mm/aaaa' (anche con ora dopo), 'aaaa-mm-gg',
    oppure date/datetime (celle Excel). Valori non validi → None, mai errori."""
    if isinstance(valore, datetime):
        return valore.date()
    if isinstance(valore, date):
        return valore
    s = "" if valore is None else str(valore).strip()
    try:
        m = _RE_DATA_IT.match(s)
        if m:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        m = _RE_DATA_ISO.match(s)
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    return None


def _pieno(valore: object) -> bool:
    if isinstance(valore, (date, datetime)):
        return True
    return bool(re.sub(r"\s+", "", "" if valore is None else str(valore)))


def _it(d: date) -> str:
    return d.strftime("%d/%m/%Y")


# === FASE E STATO ===

def fase(valori: dict, oggi: date, sospesa_ora: bool | None = None) -> str:
    """Fase della perizia dalle celle di stato (chiavi di COLONNE_STATO;
    chiavi mancanti = celle vuote). Vedi le regole in testa al modulo.

    sospesa_ora: True/False se è nota la ricerca delle sospese del portale
    (la perizia c'è o non c'è); None se quella ricerca non è stata
    possibile (ripiego sulle colonne Sospensione/Sospesa)."""
    if any(_pieno(valori.get(k)) for k in ("conclusa", "inoltrata", "revoca")):
        return CHIUSA
    sopralluogo = leggi_data(valori.get("sopralluogo"))
    if _pieno(valori.get("valutata")) or (sopralluogo is not None and sopralluogo < oggi):
        return EFFETTUATO
    if sopralluogo is not None:
        return FISSATO
    if sospesa_ora is None:
        if _pieno(valori.get("sospensione")) or _pieno(valori.get("sospesa")):
            return SOSPESA
    elif sospesa_ora:
        return SOSPESA
    return DA_FISSARE


def _con_data(testo: str, valore: object, preposizione: str = "il") -> str:
    d = leggi_data(valore)
    return f"{testo} {preposizione} {_it(d)}" if d else testo


def stato_perizia(valori: dict, oggi: date, sospesa_ora: bool | None = None) -> dict:
    """Fase, testo per le persone e date ISO di una perizia.

    Returns:
        {"fase", "stato" (max 80, '' per da_fissare), "data_sopralluogo"
         (AAAA-MM-GG o ''), "data_sospensione" (AAAA-MM-GG o '', solo per
         la fase sospesa)}"""
    f = fase(valori, oggi, sospesa_ora)
    sopralluogo = leggi_data(valori.get("sopralluogo"))
    stato = ""
    data_sospensione = ""
    if f == CHIUSA:
        if _pieno(valori.get("conclusa")):
            stato = _con_data("Conclusa", valori.get("conclusa"))
        elif _pieno(valori.get("inoltrata")):
            stato = _con_data("Perizia inoltrata", valori.get("inoltrata"))
        else:
            stato = "Revocata"
    elif f == EFFETTUATO:
        if _pieno(valori.get("valutata")):
            stato = _con_data("Valutata", valori.get("valutata"))
        else:
            stato = f"Sopralluogo del {_it(sopralluogo)}"
    elif f == FISSATO:
        stato = f"Sopralluogo fissato per il {_it(sopralluogo)}"
    elif f == SOSPESA:
        d = leggi_data(valori.get("sospensione"))
        stato = f"Sospesa dal {_it(d)}" if d else "Sospesa"
        data_sospensione = d.isoformat() if d else ""
    return {"fase": f, "stato": stato[:STATO_MAX],
            "data_sopralluogo": sopralluogo.isoformat() if sopralluogo else "",
            "data_sospensione": data_sospensione}


def stato_da_riga(riga: Sequence, mappa: dict[str, int], oggi: date,
                  sospesa_ora: bool | None = None) -> dict:
    """stato_perizia per una riga allineata alle intestazioni di `mappa`."""
    valori = {}
    for logico in COLONNE_STATO:
        i = mappa[logico]
        valori[logico] = riga[i] if 0 <= i < len(riga) else None
    return stato_perizia(valori, oggi, sospesa_ora)


def riga_conteggi(fasi: Iterable[str]) -> str:
    """'Stato sul portale: 4 con sopralluogo fissato, 5 già fatte o chiuse,
    6 sospese, 0 da fissare' (solo conteggi, nessun dato)."""
    fasi = list(fasi)
    fissate = sum(1 for f in fasi if f == FISSATO)
    fatte = sum(1 for f in fasi if f in (EFFETTUATO, CHIUSA))
    sospese = sum(1 for f in fasi if f == SOSPESA)
    da_fissare = sum(1 for f in fasi if f == DA_FISSARE)
    return (f"Stato sul portale: {fissate} con sopralluogo fissato, {fatte} già "
            f"fatte o chiuse, {sospese} sospese, {da_fissare} da fissare")


# === NOTA DI SOSPENSIONE (pagina «Sospesi» della perizia, BEST-EFFORT) ===

def _pulisci(testo: object) -> str:
    return re.sub(r"\s+", " ", "" if testo is None else str(testo)).strip()


def _taglia(testo: str, massimo: int = NOTA_MAX) -> str:
    return testo if len(testo) <= massimo else testo[:massimo - 1].rstrip() + "…"


def nota_da_sospesi(righe: Iterable[dict], motivo: str = "") -> tuple[str, str]:
    """Nota di sospensione dalla griglia della pagina «Sospesi» (solo le
    colonne Data e Note di ogni riga): la riga più recente (data più alta;
    a parità, o senza date valide, la prima). Se il «Motivo Sospensione»
    scelto non è vuoto: «Motivo: … · nota». Max 600 caratteri.

    Returns:
        (nota, data della riga in AAAA-MM-GG o '')."""
    scelta = None
    data_scelta = None
    for r in righe:
        if not isinstance(r, dict):
            continue
        d = leggi_data(r.get("data"))
        if scelta is None or (d is not None and (data_scelta is None or d > data_scelta)):
            scelta, data_scelta = r, d
    nota = _pulisci(scelta.get("note")) if scelta else ""
    motivo = _pulisci(motivo)
    if motivo and not re.fullmatch(r"[-–—_.\s]*", motivo):
        nota = f"Motivo: {motivo}" + (SEPARATORE_NOTA + nota if nota else "")
    return _taglia(nota), data_scelta.isoformat() if data_scelta else ""


_RE_FISSATO_NOTA = re.compile(
    r"sopral+uogo\s+(?:gi[aà]\s+)?fissat[oa]\D{0,25}?(\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{2,4})",
    re.IGNORECASE)


def data_fissata_da_nota(nota: str) -> str:
    """'Sopralluogo fissato in data 17/11/2026' → '2026-11-17'; '' se la
    nota non lo dice (o la data non è valida). Anno a 2 cifre → 20aa."""
    m = _RE_FISSATO_NOTA.search(nota or "")
    if not m:
        return ""
    testo = re.sub(r"\s+", "", m.group(1))
    parti = re.split(r"[/.\-]", testo)
    if len(parti) == 3 and len(parti[2]) == 2:
        testo = f"{parti[0]}/{parti[1]}/20{parti[2]}"
    d = leggi_data(testo)
    return d.isoformat() if d else ""


def fase_con_nota(fase_portale: str, data_sopralluogo: str, nota: str) -> tuple[str, str, str]:
    """Fase finale di una perizia sospesa tenendo conto della nota: se la
    nota più recente dice «sopralluogo fissato» con una data e la colonna
    Sopralluogo è vuota → ('fissato', stato, data). Altrimenti la fase del
    portale invariata, con stato '' (resta quello dell'elenco).

    Returns:
        (fase, stato, data_sopralluogo AAAA-MM-GG)"""
    if fase_portale != SOSPESA or data_sopralluogo:
        return fase_portale, "", data_sopralluogo
    iso = data_fissata_da_nota(nota)
    if not iso:
        return fase_portale, "", data_sopralluogo
    d = date.fromisoformat(iso)
    return FISSATO, f"Sopralluogo fissato per il {_it(d)} (nota di sospensione)"[:STATO_MAX], iso
