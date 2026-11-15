"""Stato di ogni perizia sul portale, letto dall'icona «VT» e dalle colonne di data.

L'Elenco Perizie del portale ha, fra le altre, queste colonne (nomi presi
dalla descrizione anonima `elenco_struttura.json` prodotta dal bridge sul
portale vero): Conclusa, Sopralluogo, Valutata, Sospesa, Revoca,
Sospensione, Inoltrata Perizia. Le colonne di data contengono `gg/mm/aaaa`
oppure sono vuote; «Sospesa» e «Revoca» sul portale vero hanno sempre il
testo vuoto (forse un'icona: NON verificato).

Le colonne sono trovate PER NOME nella riga delle intestazioni, mai per
posizione. Se le intestazioni non si trovano o manca una colonna, nessun
campo di stato (comportamento di prima).

Icona di stato: nella colonna «VT» dell'elenco del portale ogni riga ha
un'icona; il nome del file dell'immagine senza estensione è il CODICE dello
stato (EL.gif → EL). Vedi CODICI_ICONA (l'unico punto in cui stanno i
codici). Gli elenchi da file (Excel/TSV) non hanno icone: per loro, e per
le righe del portale in cui l'icona non si legge, vale la regola di prima.

Fase (regole in ordine di precedenza, `oggi` è un parametro):
1. `chiusa`      codice EL, AB, IR, IP o PI (eliminata, abbandonata,
                 incarico rifiutato, perizia inoltrata, perizia inviata),
                 qualunque data ci sia;
2. `chiusa`      Conclusa, Inoltrata Perizia o Revoca non vuote;
   `effettuato`  codice VT o PR (valutata, perizia riaperta), oppure
                 Valutata non vuota, oppure Sopralluogo con data prima di oggi;
   `fissato`     Sopralluogo con data di oggi o successiva;
3. `sospesa`     codice SP, oppure la perizia è fra quelle trovate dalla
                 SECONDA ricerca del portale («Stato Perizia» = sospesa):
                 sono le sospese ADESSO;
4. `da_fissare`  codice IN o AT;
5. codice presente ma non in CODICI_ICONA (stato non riconosciuto) e
   nessuna data che decida: la perizia NON va
   pubblicata né aperta (fase NON_RICONOSCIUTA, mai nello snapshot);
6. icona non letta (elenco da file, o portale cambiato): regola di prima,
   cioè dopo le date `sospesa` se è nella ricerca delle sospese (se quella
   ricerca non è stata possibile, ripiego: colonna Sospensione o Sospesa
   non vuota; una data in Sospensione da sola non basta, la perizia può
   essere stata riattivata), altrimenti `da_fissare`.

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
# Icona «VT» con un codice che non conosco e nessuna data: la perizia NON
# viene pubblicata né aperta (non è una fase del contratto, non esce mai)
NON_RICONOSCIUTA = "non_riconosciuta"

# Codici dell'icona della colonna «VT» (nome del file senza estensione,
# maiuscolo) → (fase, testo di stato, colonna di data da aggiungere al
# testo o ''). È L'UNICO punto in cui stanno.
# Fonte: il file descrittivo del primo giro sul portale vero (198 righe):
# - EL (13) = eliminata: la perizia aperta per la descrizione risultava
#   «Eliminata»;
# - SP (18) = sospesa: coincidono con le 18 della ricerca «Stato Perizia» =
#   Sospesa;
# - IN (9) = incarico accettato (presa in carico, ancora da fare);
# - IP (139) = perizia inoltrata: esattamente le 139 righe con la data
#   «Inoltrata Perizia»;
# - PI (13) = perizia inviata/conclusa: IP + PI = 152 = le righe con la data
#   «Conclusa»;
# - VT (5) = valutata;
# - PR (1) = perizia riaperta dopo la consegna (non da programmare).
# AB, IR e AT NON sono mai stati visti come icona: sono dedotti dai comandi
# della pagina della perizia (ButAction.AB «Abbandona», ButAction.IR
# «Rifiuta») e dalla voce «Attivata» del menu «Stato Perizia».
# Un codice che NON è qui (mai visto finora) senza date: perizia non
# pubblicata (regola 5), contata per codice nel log.
CODICI_ICONA: dict[str, tuple[str, str, str]] = {
    "EL": (CHIUSA, "Eliminata", ""),
    "AB": (CHIUSA, "Abbandonata", ""),
    "IR": (CHIUSA, "Incarico rifiutato", ""),
    "IP": (CHIUSA, "Perizia inoltrata", "inoltrata"),
    "PI": (CHIUSA, "Perizia inviata", "conclusa"),
    "VT": (EFFETTUATO, "Valutata", "valutata"),
    "PR": (EFFETTUATO, "Perizia riaperta", ""),
    "SP": (SOSPESA, "", ""),
    "IN": (DA_FISSARE, "", ""),
    "AT": (DA_FISSARE, "", ""),
}
_RE_CODICE_ICONA = re.compile(r"[A-Z]{1,3}")

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

def codice_icona(valore: object) -> str | None:
    """Codice dell'icona «VT» normalizzato: 1-3 lettere maiuscole; None se
    assente o non valido (= icona non letta)."""
    if not isinstance(valore, str):
        return None
    s = valore.strip().upper()
    return s if _RE_CODICE_ICONA.fullmatch(s) else None


def fase(valori: dict, oggi: date, sospesa_ora: bool | None = None,
         icona: object = None) -> str:
    """Fase della perizia dalle celle di stato (chiavi di COLONNE_STATO;
    chiavi mancanti = celle vuote) e dal codice dell'icona «VT». Vedi le
    regole in testa al modulo.

    sospesa_ora: True/False se è nota la ricerca delle sospese del portale
    (la perizia c'è o non c'è); None se quella ricerca non è stata
    possibile (senza icona: ripiego sulle colonne Sospensione/Sospesa).
    icona: codice dell'icona (es. 'EL'); None = non letta (regola di prima).
    Può ritornare NON_RICONOSCIUTA: perizia da non pubblicare."""
    codice = codice_icona(icona)
    noto = CODICI_ICONA.get(codice or "")
    if noto and noto[0] == CHIUSA:
        return CHIUSA
    if any(_pieno(valori.get(k)) for k in ("conclusa", "inoltrata", "revoca")):
        return CHIUSA
    if noto and noto[0] == EFFETTUATO:   # valutata/riaperta: anche con un sopralluogo futuro
        return EFFETTUATO
    sopralluogo = leggi_data(valori.get("sopralluogo"))
    if _pieno(valori.get("valutata")) or (sopralluogo is not None and sopralluogo < oggi):
        return EFFETTUATO
    if sopralluogo is not None:
        return FISSATO
    if codice is None:   # icona non letta: regola di prima
        if sospesa_ora is None:
            if _pieno(valori.get("sospensione")) or _pieno(valori.get("sospesa")):
                return SOSPESA
        elif sospesa_ora:
            return SOSPESA
        return DA_FISSARE
    if (noto and noto[0] == SOSPESA) or sospesa_ora:
        return SOSPESA
    if noto and noto[0] == DA_FISSARE:
        return DA_FISSARE
    return NON_RICONOSCIUTA


def _con_data(testo: str, valore: object, preposizione: str = "il") -> str:
    d = leggi_data(valore)
    return f"{testo} {preposizione} {_it(d)}" if d else testo


def stato_perizia(valori: dict, oggi: date, sospesa_ora: bool | None = None,
                  icona: object = None) -> dict:
    """Fase, testo per le persone e date ISO di una perizia.

    Returns:
        {"fase", "stato" (max 80, '' per da_fissare), "data_sopralluogo"
         (AAAA-MM-GG o ''), "data_sospensione" (AAAA-MM-GG o '', solo per
         la fase sospesa)}"""
    f = fase(valori, oggi, sospesa_ora, icona)
    sopralluogo = leggi_data(valori.get("sopralluogo"))
    stato = ""
    data_sospensione = ""
    noto = CODICI_ICONA.get(codice_icona(icona) or "")
    if noto and f == noto[0] and f in (CHIUSA, EFFETTUATO):
        stato = _con_data(noto[1], valori.get(noto[2])) if noto[2] else noto[1]
    elif f == CHIUSA:
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
                  sospesa_ora: bool | None = None, icona: object = None) -> dict:
    """stato_perizia per una riga allineata alle intestazioni di `mappa`."""
    valori = {}
    for logico in COLONNE_STATO:
        i = mappa[logico]
        valori[logico] = riga[i] if 0 <= i < len(riga) else None
    return stato_perizia(valori, oggi, sospesa_ora, icona)


def riga_conteggi(fasi: Iterable[str], non_pubblicate: int | None = None) -> str:
    """'Stato sul portale: 4 con sopralluogo fissato, 5 già fatte o chiuse,
    6 sospese, 0 da fissare' (solo conteggi, nessun dato). Con
    `non_pubblicate` (elenco letto dal portale) aggiunge quante perizie non
    sono state pubblicate perché in uno stato non riconosciuto."""
    fasi = list(fasi)
    fissate = sum(1 for f in fasi if f == FISSATO)
    fatte = sum(1 for f in fasi if f in (EFFETTUATO, CHIUSA))
    sospese = sum(1 for f in fasi if f == SOSPESA)
    da_fissare = sum(1 for f in fasi if f == DA_FISSARE)
    riga = (f"Stato sul portale: {fissate} con sopralluogo fissato, {fatte} già "
            f"fatte o chiuse, {sospese} sospese, {da_fissare} da fissare")
    if non_pubblicate is not None:
        riga += f", {int(non_pubblicate)} non pubblicate (stato non riconosciuto)"
    return riga


def riga_non_pubblicate(conteggi: dict[str, int] | None) -> str:
    """'3 perizie non pubblicate perché in uno stato che non conosco (PI: 2,
    XX: 1)', codici dal più frequente; '' se non ce ne sono."""
    voci = sorted(((str(c), int(n)) for c, n in (conteggi or {}).items() if int(n) > 0),
                  key=lambda v: (-v[1], v[0]))
    totale = sum(n for _c, n in voci)
    if not totale:
        return ""
    dettaglio = ", ".join(f"{c}: {n}" for c, n in voci)
    if totale == 1:
        return f"1 perizia non pubblicata perché in uno stato che non conosco ({dettaglio})"
    return (f"{totale} perizie non pubblicate perché in uno stato che non conosco "
            f"({dettaglio})")


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
