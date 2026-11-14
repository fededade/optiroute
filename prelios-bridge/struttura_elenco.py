"""Descrizione ANONIMA di com'è fatto l'elenco del portale (elenco_struttura.json).

A ogni lettura dell'elenco dal portale il bridge scrive, accanto ai suoi
file, `elenco_struttura.json`: una descrizione della PAGINA (filtri,
colonne, valori delle colonne di stato/categoria, paginazione) che serve a
capire quali pratiche il portale mostra e perché. Il file si può mandare
allo sviluppatore: NON contiene dati dei clienti, per costruzione:

- dei campi di filtro non si scrive MAI il valore, solo se è vuoto;
- delle colonne si scrivono solo conteggi e la "forma" dei valori
  (lettere → x, cifre → 9: "ROSSI MARIO" → "xxxxx xxxxx");
- i valori in chiaro compaiono SOLO per le colonne che sembrano una
  categoria (pochi valori diversi e ripetuti, corti, senza numeri lunghi) e
  mai per le colonne di intestatario e indirizzo;
- prima di scrivere, un controllo finale rifiuta il file se trova una
  chiocciola (email), un numero di 6 o più cifre o un valore uguale a un
  nome, indirizzo, nota o telefono delle pratiche appena lette.

Modulo PURO (solo libreria standard, niente browser): testabile.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence

from excel_pratiche import (_OFFSET_CIVICO, _OFFSET_COMUNE, _OFFSET_INTESTATARIO,
                            _OFFSET_PROVINCIA, _OFFSET_VIA, _norm_header,
                            _trova_colonna_tipologia)

NOME_FILE = "elenco_struttura.json"

# Regole per mostrare in chiaro i valori di una colonna ("categorie")
CATEGORIE_MAX_VALORI = 8
CATEGORIE_MIN_RIGHE = 5
CATEGORIE_MAX_LUNGHEZZA = 30
# Regole per mostrare in chiaro le voci di un menu a tendina dei filtri
OPZIONI_MAX = 12
OPZIONI_MAX_LUNGHEZZA = 30
# Etichette e intestazioni più lunghe di così non sono considerate etichette
ETICHETTA_MAX = 40
# Lunghezza massima di una "forma" (oltre si tronca con …)
FORMA_MAX = 40
# Limiti di sicurezza sulle quantità scritte
MAX_FILTRI = 150
MAX_COLONNE = 60

# Colonne che il parser usa per intestatario e indirizzo (rispetto alla
# colonna Tipologia): MAI valori in chiaro, qualunque cosa contengano.
OFFSET_DATI_CLIENTE = {_OFFSET_INTESTATARIO, _OFFSET_VIA, _OFFSET_CIVICO,
                       _OFFSET_COMUNE, _OFFSET_PROVINCIA}

_RE_4_CIFRE = re.compile(r"\d{4,}")
_RE_6_CIFRE = re.compile(r"\d{6,}")
_RE_DATA = re.compile(r"\d{1,2}\s*[/.\-]\s*\d{1,2}")
# Nomi di menu/campi che di solito elencano PERSONE (periti, utenti...)
_RE_PERSONE = re.compile(r"perit|utent|user|tecnic|gestor|client|nominat|intestat|"
                         r"operat|referent|mutuat|richied|nome|cognom|agent|assegnat",
                         re.IGNORECASE)
# Caratteri che una "forma" può contenere (oltre a x e 9)
_FORMA_PUNTEGGIATURA = set(" -/.,:;()'+_?…")
_RE_FORMA_VALIDA = re.compile(r"[x9 \-/.,:;()'+_?…]*")
# Campi del file che contengono SOLO forme (controllate a parte: le forme
# usano il 9 al posto delle cifre, quindi "9999999999" è lecito lì)
CHIAVI_FORMA = {"forma_prevalente", "forma", "forme_opzioni", "forma_selezionata",
                "forma_etichetta"}


# === FORME E REGOLE ===

def forma(testo: object) -> str:
    """Forma di un valore: lettere → x, cifre → 9, spazi e punteggiatura
    comune invariati, ogni altro simbolo (anche la chiocciola) → '?'.
    Troncata a FORMA_MAX caratteri."""
    out = []
    for ch in "" if testo is None else str(testo):
        if ch.isdigit():
            out.append("9")
        elif ch.isalpha():
            out.append("x")
        elif ch.isspace():
            out.append(" ")
        elif ch in _FORMA_PUNTEGGIATURA:
            out.append(ch)
        else:
            out.append("?")
    s = re.sub(r" +", " ", "".join(out)).strip()
    return s if len(s) <= FORMA_MAX else s[:FORMA_MAX] + "…"


def _norm(testo: object) -> str:
    return re.sub(r"\s+", " ", "" if testo is None else str(testo)).strip().lower()


def testo_sicuro(testo: object, vietati: set[str] = frozenset(),
                 massimo: int = ETICHETTA_MAX) -> bool:
    """True se un testo breve (etichetta, intestazione, voce di menu) si può
    scrivere in chiaro: corto, senza 4 cifre di fila, senza chiocciola,
    diverso dai dati delle pratiche."""
    s = "" if testo is None else str(testo).strip()
    return (len(s) <= massimo and not _RE_4_CIFRE.search(s) and "@" not in s
            and _norm(s) not in vietati)


def _id_sicuro(testo: object) -> str:
    """id/name dei campi: in chiaro (sono nomi tecnici della pagina), ma le
    sequenze di 4+ cifre (potrebbero essere codici pratica) diventano '#'."""
    s = "" if testo is None else str(testo)[:80]
    return _RE_4_CIFRE.sub("#", s).replace("@", "?")


# === COLONNE ===

def _righe_dati(rows: Iterable[Sequence]) -> list[tuple[list[str], int]]:
    """Righe con la cella Tipologia (le righe dati), senza ripetizioni (la
    stessa griglia può essere letta da più frame)."""
    viste: set[tuple] = set()
    out: list[tuple[list[str], int]] = []
    for r in rows:
        celle = ["" if c is None else str(c).strip() for c in r]
        col_t = _trova_colonna_tipologia(celle)
        if col_t < 0:
            continue
        firma = tuple(celle)
        if firma in viste:
            continue
        viste.add(firma)
        out.append((celle, col_t))
    return out


def _e_categoria(valori: list[str], offset: int, vietati: set[str]) -> tuple[bool, str]:
    """Una colonna mostra i suoi valori in chiaro solo se sembra una
    categoria. Ritorna (sì/no, motivo del no)."""
    pieni = [v for v in valori if v]
    distinti = set(pieni)
    if offset in OFFSET_DATI_CLIENTE:
        return False, "colonna di intestatario/indirizzo: mai in chiaro"
    if len(pieni) < CATEGORIE_MIN_RIGHE:
        return False, f"meno di {CATEGORIE_MIN_RIGHE} valori"
    if not distinti or len(distinti) > CATEGORIE_MAX_VALORI:
        return False, f"più di {CATEGORIE_MAX_VALORI} valori diversi"
    if len(distinti) >= len(pieni):
        return False, "ogni riga ha un valore diverso"
    for v in distinti:
        if len(v) > CATEGORIE_MAX_LUNGHEZZA:
            return False, "valori lunghi"
        if _RE_4_CIFRE.search(v) or _RE_DATA.search(v):
            return False, "valori con numeri o date"
        if "@" in v or _norm(v) in vietati:
            return False, "valori che sembrano dati personali"
    return True, ""


def descrivi_colonne(rows: Iterable[Sequence], vietati: set[str] = frozenset()) -> dict:
    """Statistiche per posizione di colonna, con le righe dati allineate
    sulla colonna Tipologia."""
    dati = _righe_dati(rows)
    if not dati:
        return {"righe_dati": 0, "colonna_tipologia": None, "colonne": []}
    t_tipica = Counter(t for _r, t in dati).most_common(1)[0][0]
    per_offset: dict[int, list[str]] = {}
    for celle, col_t in dati:
        for j, v in enumerate(celle):
            per_offset.setdefault(j - col_t, [])
    for celle, col_t in dati:
        for off in per_offset:
            j = col_t + off
            per_offset[off].append(celle[j] if 0 <= j < len(celle) else "")

    colonne = []
    for off in sorted(per_offset)[:MAX_COLONNE]:
        valori = per_offset[off]
        pieni = [v for v in valori if v]
        forme = Counter(forma(v) for v in pieni)
        voce = {
            "posizione": t_tipica + off,
            "rispetto_a_tipologia": off,
            "righe": len(valori),
            "vuoti": len(valori) - len(pieni),
            "valori_diversi": len(set(pieni)),
            "lunghezza_massima": max((len(v) for v in pieni), default=0),
            "forma_prevalente": forme.most_common(1)[0][0] if forme else "",
        }
        if off == 0:
            voce["nota"] = "colonna Tipologia (ancora del parser)"
        ok, motivo = _e_categoria(valori, off, vietati)
        if ok:
            voce["categorie"] = dict(Counter(pieni).most_common())
        else:
            voce["categorie"] = None
            voce["perche_non_in_chiaro"] = motivo
        colonne.append(voce)
    return {"righe_dati": len(dati), "colonna_tipologia": t_tipica, "colonne": colonne}


# === INTESTAZIONI ===

def trova_intestazioni(rows: Iterable[Sequence], candidati_th: list[dict] | None = None,
                       vietati: set[str] = frozenset()) -> tuple[list[str], str]:
    """Titoli delle colonne, SOLO se riconosciuti con sicurezza:
    1. una riga di <th> letta dalla pagina, con lo stesso numero di celle
       delle righe dati oppure con "Tipologia" sopra la colonna Tipologia;
    2. una riga della griglia con lo stesso numero di celle delle righe dati
       e "Tipologia" esattamente sopra la colonna Tipologia.
    Ogni titolo deve essere un'etichetta breve. Altrimenti ([], motivo)."""
    rows = [["" if c is None else str(c).strip() for c in r] for r in rows]
    dati = _righe_dati(rows)
    if not dati:
        return [], "nessuna riga dati con Tipologia: intestazioni non riconoscibili"
    forma_tipica = Counter((len(r), t) for r, t in dati).most_common(1)[0][0]
    n_tipico, t_tipico = forma_tipica

    def accettabile(celle: list[str]) -> bool:
        return bool(celle) and any(celle) and all(testo_sicuro(c, vietati) for c in celle)

    for c in candidati_th or []:
        celle = [str(x or "").strip() for x in (c.get("celle") or [])]
        if not accettabile(celle):
            continue
        norm = [_norm_header(x) for x in celle]
        sopra_t = (c.get("col_tipologia_dati") is not None
                   and 0 <= c["col_tipologia_dati"] < len(norm)
                   and norm[c["col_tipologia_dati"]] == "tipologia")
        if len(celle) == c.get("n_celle_dati") or sopra_t:
            return celle, "da celle di intestazione (<th>) della griglia"

    for r in rows:
        if _trova_colonna_tipologia(r) >= 0 or len(r) != n_tipico:
            continue
        if _norm_header(r[t_tipico]) == "tipologia" and accettabile(r):
            return r, "dalla riga di intestazione della griglia (\"Tipologia\" sopra la colonna Tipologia)"
    return [], ("nessuna riga di intestazione riconosciuta con sicurezza (né celle <th> "
                "né una riga con \"Tipologia\" sopra la colonna Tipologia)")


# === FILTRI ===

def descrivi_filtri(controlli: list[dict], vietati: set[str] = frozenset()) -> list[dict]:
    """Campi del modulo della pagina, senza MAI i valori scritti."""
    out: list[dict] = []
    for c in controlli[:MAX_FILTRI]:
        if not isinstance(c, dict):
            continue
        tipo = str(c.get("tipo") or "").lower()[:20]
        voce: dict = {"origine": str(c.get("origine") or "")[:20],
                      "id": _id_sicuro(c.get("id")), "name": _id_sicuro(c.get("name")),
                      "tipo": tipo, "visibile": bool(c.get("visibile"))}
        etichetta = str(c.get("etichetta") or "").strip()
        if etichetta:
            if testo_sicuro(etichetta, vietati):
                voce["etichetta"] = etichetta
            else:
                voce["forma_etichetta"] = forma(etichetta)
        if tipo in ("checkbox", "radio"):
            voce["selezionato"] = bool(c.get("selezionato"))
        elif tipo.startswith("select"):
            opzioni = [str(o or "").strip() for o in (c.get("opzioni") or [])]
            n = int(c.get("n_opzioni") or len(opzioni))
            sel = c.get("indice_selezionato")
            sel = sel if isinstance(sel, int) and 0 <= sel < len(opzioni) else None
            voce["n_opzioni"] = n
            persone = bool(_RE_PERSONE.search(" ".join(
                str(c.get(k) or "") for k in ("id", "name", "etichetta"))))
            in_chiaro = (not persone and n <= OPZIONI_MAX and len(opzioni) == n
                         and all(testo_sicuro(o, vietati, OPZIONI_MAX_LUNGHEZZA)
                                 for o in opzioni))
            if in_chiaro:
                voce["opzioni"] = opzioni
                voce["selezionata"] = opzioni[sel] if sel is not None else None
            else:
                voce["forme_opzioni"] = [forma(o) for o in opzioni[:OPZIONI_MAX]]
                voce["forma_selezionata"] = forma(opzioni[sel]) if sel is not None else None
                voce["perche_non_in_chiaro"] = (
                    "menu che sembra elencare persone" if persone else
                    "troppe voci, voci lunghe o con numeri")
            voce["indice_selezionato"] = sel
        else:
            voce["vuoto"] = bool(c.get("vuoto"))
        out.append(voce)
    return out


# === DESCRIZIONE COMPLETA ===

def valori_vietati(rows: Iterable[Sequence]) -> set[str]:
    """Nomi e indirizzi presenti nelle righe dati (colonne intestatario,
    via, comune del parser), normalizzati: non devono mai comparire."""
    out: set[str] = set()
    for celle, col_t in _righe_dati(rows):
        for off in (_OFFSET_INTESTATARIO, _OFFSET_VIA, _OFFSET_COMUNE):
            j = col_t + off
            if 0 <= j < len(celle) and len(celle[j].strip()) >= 3:
                out.add(_norm(celle[j]))
    return out


def descrivi_elenco(righe: list[Sequence], stats: dict | None = None,
                    info: dict | None = None) -> dict:
    """Descrizione anonima dell'elenco appena letto.

    Args:
        righe: righe GREZZE lette dalla griglia (liste di testi delle celle).
        stats: contatori di excel_pratiche.parse_grid_rows.
        info: dati raccolti da prelios.list_assigned (pagine lette, controlli
            di paginazione, struttura della pagina: <th> e campi del modulo).
    """
    stats = stats or {}
    info = info or {}
    righe = [list(r) for r in righe]
    vietati = valori_vietati(righe)
    pagina = info.get("pagina") or {}
    note: list[str] = []

    intestazioni, come = trova_intestazioni(righe, pagina.get("th") or [], vietati)
    colonne = descrivi_colonne(righe, vietati)
    if intestazioni and len(intestazioni) == len(colonne["colonne"]) \
            and colonne["colonna_tipologia"] is not None:
        for voce in colonne["colonne"]:
            p = voce["posizione"]
            if 0 <= p < len(intestazioni):
                voce["intestazione"] = intestazioni[p]

    if pagina.get("errore"):
        note.append("Struttura della pagina non letta: " + forma(pagina["errore"])[:80])
    filtri = descrivi_filtri(pagina.get("controlli") or [], vietati)
    note.append("I filtri sono letti DOPO che il bridge ha svuotato \"Cod. Immobile\" "
                "e lanciato la ricerca: gli altri filtri sono come li lascia il portale.")
    if pagina.get("controlli_in_griglia"):
        note.append(f"{pagina['controlli_in_griglia']} campi dentro le righe della "
                    "griglia non sono elencati (non sono filtri).")

    controlli = []
    for c in info.get("controlli_paginazione") or []:
        testo = str(c.get("text") or "")
        controlli.append({"tag": str(c.get("tag") or "")[:12],
                          "testo": testo if testo_sicuro(testo, vietati, 30) else forma(testo),
                          "origine": str(c.get("origine") or "")[:20]})

    return {
        "descrizione": ("Com'è fatto l'elenco del portale (filtri, colonne, valori "
                        "delle colonne di stato). Non contiene dati dei clienti."),
        "quando": datetime.now().isoformat(timespec="seconds"),
        "conteggi": {
            "righe_lette": int(stats.get("righe", len(righe))),
            "righe_con_tipologia": int(stats.get("con_tipologia", 0)),
            "altre_tipologie": int(stats.get("altre_tipologie", 0)),
            "pratiche_full_acquisto": int(stats.get("pratiche", 0)),
            "pagine_lette": int(info.get("pagine", 1) or 1),
        },
        "paginazione": {"controlli_riconosciuti": controlli},
        "intestazioni": intestazioni,
        "intestazioni_come": come,
        "colonna_tipologia": colonne["colonna_tipologia"],
        "righe_dati_analizzate": colonne["righe_dati"],
        "colonne": colonne["colonne"],
        "filtri": filtri,
        "note": note,
    }


# === CONTROLLO FINALE E SCRITTURA ===

def _stringhe(obj, chiave: str = ""):
    """Tutte le stringhe (chiavi comprese) con la chiave in cui stanno."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield "(nome di un campo)", str(k)
            yield from _stringhe(v, str(k))
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _stringhe(v, chiave)
    elif isinstance(obj, str):
        yield chiave, obj


def valori_pratiche(pratiche: Iterable, telefoni: Iterable[str] = ()) -> set[str]:
    """Intestatari, vie, note e telefoni delle pratiche (normalizzati), con i
    numeri trovati nelle note in più formati."""
    from contact_parse import estrai_telefoni
    out: set[str] = set()

    def aggiungi(v: object) -> None:
        s = _norm(v)
        if len(s) >= 3:
            out.add(s)

    for p in pratiche:
        for campo in ("intestatario", "via", "note_gestore"):
            aggiungi(getattr(p, campo, ""))
        for t in estrai_telefoni(getattr(p, "note_gestore", "") or ""):
            aggiungi(t.get("numero"))
            aggiungi(t.get("raw"))
    for t in telefoni:
        aggiungi(t)
        if t and str(t).startswith("+39"):
            aggiungi(str(t)[3:])
    return out


def controllo_sicurezza(struttura: dict, vietati: set[str] = frozenset()) -> list[str]:
    """Problemi che impediscono di scrivere il file (lista vuota = ok):
    chiocciola, 6+ cifre di fila, valori uguali (o contenenti, se lunghi) a
    dati delle pratiche. Le forme sono ammesse solo se fatte di x, 9 e
    punteggiatura."""
    problemi: list[str] = []
    for chiave, s in _stringhe(struttura):
        if "@" in s:
            problemi.append(f"chiocciola (email?) nel campo '{chiave}'")
            continue
        if chiave in CHIAVI_FORMA:
            if not _RE_FORMA_VALIDA.fullmatch(s):
                problemi.append(f"forma non valida nel campo '{chiave}'")
            continue
        if _RE_6_CIFRE.search(s):
            problemi.append(f"numero di 6 o più cifre nel campo '{chiave}'")
            continue
        n = _norm(s)
        if n and (n in vietati or any(len(v) >= 8 and v in n for v in vietati)):
            problemi.append(f"dato di una pratica nel campo '{chiave}'")
    return problemi


def scrivi_struttura(path: str | Path, struttura: dict,
                     vietati: set[str] = frozenset()) -> list[str]:
    """Scrive il file SOLO se il controllo finale passa. Ritorna i problemi
    trovati (lista vuota = scritto). Scrittura atomica (file temporaneo e
    sostituzione)."""
    problemi = controllo_sicurezza(struttura, vietati)
    if problemi:
        return problemi
    path = Path(path)
    testo = json.dumps(struttura, indent=2, ensure_ascii=False)
    fd, tmp = tempfile.mkstemp(prefix=".elenco_struttura_", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(testo)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return []
