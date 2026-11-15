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
  chiocciola (email), un numero di 6 o più cifre, una data o un valore
  uguale a un nome, indirizzo, nota o telefono delle pratiche appena lette.

Parti aggiunte dopo il secondo giro sul portale vero:
- per ogni colonna, cosa contengono le celle oltre al testo (immagini,
  caselle, link, altri campi, title/classi/sfondo), con i nomi delle
  immagini in chiaro solo se pochi, corti e senza numeri lunghi;
- per i menu di STATO dei filtri le voci in chiaro (fino a 60, corte, senza
  cifre); i numeri di «Trovati» e «Max Righe» se sono solo cifre;
- sezione "perizia": com'è fatta la pagina Anagrafica di UNA perizia
  (campi senza valori, campi con «sosp» con la sola lunghezza del valore,
  comandi del menu).

Parti aggiunte dopo il primo giro con l'icona di stato: in "stato_portale"
i codici dell'icona «VT» con i conteggi, le perizie non pubblicate per
codice, quelle senza icona leggibile e (aggiunta da portals.py) la lettura
della nota: come si è arrivati alla pagina «Sospesi» e se la griglia è
comparsa. Solo conteggi e codici di 1-3 lettere, mai testi delle note.

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
# Menu di STATO (id, name o etichetta con «stato»): voci in chiaro fino a
# tante, ognuna al massimo così lunga e senza cifre
OPZIONI_STATO_MAX = 60
OPZIONI_STATO_MAX_LUNGHEZZA = 40
# Campi del modulo dell'elenco di cui si scrive il numero (solo cifre)
CAMPI_NUMERICI = ("numRecord", "PageSize")
# Contenuto delle celle (immagini, classi...): in chiaro fino a tante voci
CONTENUTO_MAX_VOCI = 8
CONTENUTO_MAX_LUNGHEZZA = 40
# Pagina della perizia: limiti sulle quantità scritte
MAX_CAMPI_PERIZIA = 300
MAX_VOCI_MENU = 120
VOCE_MENU_MAX = 40
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
# Date complete (gg/mm/aaaa, gg.mm.aa, aaaa-mm-gg): vietate nel file, tranne
# nel campo "quando" (ora di scrittura del file)
_RE_DATA_COMPLETA = re.compile(r"\b\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{2,4}\b|"
                               r"\b\d{4}-\d{1,2}-\d{1,2}\b")
CHIAVI_CON_DATA = {"quando"}
# Etichetta tutta maiuscola di più parole ("ROSSI MARIO"): nella pagina della
# perizia potrebbe essere un valore mostrato come testo, non un'etichetta
_RE_MAIUSCOLO = re.compile(r"[A-ZÀ-Ý'’]+(?:\s+[A-ZÀ-Ý'’]+)+")
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
                "forma_etichetta", "forme", "forma_testo"}


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


def forma_se_serve(testo: object, vietati: set[str] = frozenset(), massimo: int = 200) -> str:
    """Il testo (messaggi del bridge) se è sicuro, altrimenti la sua forma."""
    s = re.sub(r"\s+", " ", "" if testo is None else str(testo)).strip()[:massimo]
    return s if testo_sicuro(s, vietati, massimo) and not _RE_DATA_COMPLETA.search(s) else forma(s)


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


_CONTEGGI_CONTENUTO = ("righe", "immagini", "caselle", "caselle_spuntate", "link",
                       "altri_campi", "sfondo_immagine")
_CATEGORIE_CONTENUTO = ("img_file", "img_alt", "img_title", "title", "classi",
                        "colore_sfondo")
CHIAMATA_MAX = 200
_RE_DATA_IN_CHIAMATA = re.compile(r"\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{2,4}|"
                                  r"\d{4}-\d{1,2}-\d{1,2}")


def maschera_chiamata(testo: object) -> str:
    """Chiamata di un comando (onclick/href) scritta per intero, con le
    sequenze di 6 o più cifre → '#' e le date → 'gg/mm/aaaa'."""
    s = re.sub(r"\s+", " ", "" if testo is None else str(testo)).strip()
    s = _RE_DATA_IN_CHIAMATA.sub("gg/mm/aaaa", s)
    s = _RE_6_CIFRE.sub("#", s).replace("@", "?")
    return s[:CHIAMATA_MAX]


def _chiamata_sicura(chiamata: str, vietati: set[str]) -> bool:
    n = _norm(chiamata)
    return not any(len(v) >= 8 and v in n for v in vietati) and not any(
        len(v) >= 6 and re.search(r"['\"]" + re.escape(v) + r"['\"]", n) for v in vietati)


def _chiamate_contenuto(valori: object, vietati: set[str]) -> dict | None:
    """Chiamate onclick/href delle celle: mascherate; le 8 più frequenti in
    chiaro (se non contengono dati delle pratiche) e quante sono in tutto."""
    if not isinstance(valori, dict) or not valori:
        return None
    conta: Counter = Counter()
    for k, v in valori.items():
        if k == "…altri":
            continue
        conta[maschera_chiamata(k)] += int(v) if isinstance(v, (int, float)) else 0
    if not conta:
        return None
    sicure = {k: n for k, n in conta.most_common() if _chiamata_sicura(k, vietati)}
    return {"valori_diversi": len(conta) if "…altri" not in valori else f"più di {len(conta)}",
            "piu_frequenti": dict(list(sicure.items())[:CONTENUTO_MAX_VOCI]),
            "forme": sorted({forma(k) for k in conta if k not in sicure})[:CONTENUTO_MAX_VOCI]}


def _categorie_contenuto(valori: object, vietati: set[str]) -> dict | None:
    """Voci in chiaro (con i conteggi) solo se poche, corte, senza numeri
    lunghi né dati delle pratiche; altrimenti solo quante e le forme."""
    if not isinstance(valori, dict) or not valori:
        return None
    voci = {str(k): v for k, v in valori.items()}
    troppe = "…altri" in voci or len(voci) > CONTENUTO_MAX_VOCI
    sicure = all(testo_sicuro(k, vietati, CONTENUTO_MAX_LUNGHEZZA)
                 and not _RE_DATA_COMPLETA.search(k) for k in voci)
    if not troppe and sicure:
        return {k: int(v) if isinstance(v, (int, float)) else 0 for k, v in voci.items()}
    altri = "…altri" in voci
    return {"valori_diversi": f"più di {len(voci) - 1}" if altri else len(voci),
            "forme": sorted({forma(k) for k in voci if k != "…altri"})[:CONTENUTO_MAX_VOCI]}


def descrivi_contenuto(celle: dict | None, vietati: set[str] = frozenset()) -> dict:
    """Contenuto delle celle oltre al testo, per colonna (chiave = posizione
    rispetto alla Tipologia, come in prelios._JS_STRUTTURA_PAGINA)."""
    out: dict[int, dict] = {}
    for k, s in (celle or {}).items():
        try:
            off = int(k)
        except (TypeError, ValueError):
            continue
        if not isinstance(s, dict):
            continue
        voce: dict = {}
        for n in _CONTEGGI_CONTENUTO:
            try:
                voce[n] = int(s.get(n) or 0)
            except (TypeError, ValueError):
                voce[n] = 0
        for n in _CATEGORIE_CONTENUTO:
            cat = _categorie_contenuto(s.get(n), vietati)
            if cat:
                voce[n] = cat
        chiamate = _chiamate_contenuto(s.get("chiamate"), vietati)
        if chiamate:
            voce["chiamate"] = chiamate
        out[off] = voce
    return out


def descrivi_colonne(rows: Iterable[Sequence], vietati: set[str] = frozenset(),
                     celle: dict | None = None) -> dict:
    """Statistiche per posizione di colonna, con le righe dati allineate
    sulla colonna Tipologia. `celle`: contenuto delle celle oltre al testo
    letto dalla pagina (vedi descrivi_contenuto), aggiunto come "contenuto"."""
    contenuto = descrivi_contenuto(celle, vietati)
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
        if off in contenuto:
            voce["contenuto"] = contenuto[off]
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

def _e_menu_di_stato(c: dict) -> bool:
    """Menu di STATO: id, name o etichetta contengono «stato»
    (es. Imm_StatoValutazione, «Stato Perizia»)."""
    return "stato" in " ".join(str(c.get(k) or "") for k in ("id", "name", "etichetta")).lower()


def _etichetta_sicura(etichetta: str, vietati: set[str], perizia: bool) -> bool:
    """Nella pagina della perizia l'etichetta presa dalla cella precedente
    potrebbe essere un valore mostrato come testo: lì niente cifre e niente
    testi tutti maiuscoli di più parole (come i nomi sul portale)."""
    if not testo_sicuro(etichetta, vietati):
        return False
    if perizia:
        if re.search(r"\d", etichetta) or _RE_MAIUSCOLO.fullmatch(etichetta.strip()):
            return False
        # parte di una nota o di un nome letti dal portale (es. un referente)
        n = _norm(etichetta)
        if len(n) >= 6 and any(n in v for v in vietati):
            return False
    return not _RE_DATA_COMPLETA.search(etichetta)


def descrivi_filtri(controlli: list[dict], vietati: set[str] = frozenset(),
                    perizia: bool = False, massimo: int = MAX_FILTRI) -> list[dict]:
    """Campi del modulo della pagina, senza MAI i valori scritti.

    Menu a tendina in chiaro: quelli di STATO fino a 60 voci corte e senza
    cifre; gli altri fino a 12 voci corte, senza numeri lunghi (con
    `perizia` senza cifre) e che non elencano persone. Per numRecord e
    PageSize (solo nell'elenco) il numero, se è fatto di sole cifre.
    `perizia`: campi della pagina di una perizia (regole più strette sulle
    etichette, "vuoto" anche per i menu)."""
    out: list[dict] = []
    for c in controlli[:massimo]:
        if not isinstance(c, dict):
            continue
        tipo = str(c.get("tipo") or "").lower()[:20]
        voce: dict = {"origine": str(c.get("origine") or "")[:20],
                      "id": _id_sicuro(c.get("id")), "name": _id_sicuro(c.get("name")),
                      "tipo": tipo, "visibile": bool(c.get("visibile"))}
        etichetta = str(c.get("etichetta") or "").strip()
        if etichetta:
            if _etichetta_sicura(etichetta, vietati, perizia):
                voce["etichetta"] = etichetta
            else:
                voce["forma_etichetta"] = forma(etichetta)
        if tipo in ("checkbox", "radio"):
            voce["selezionato"] = bool(c.get("selezionato"))
        elif tipo.startswith("select"):
            opzioni = [str(o or "").strip() for o in (c.get("opzioni") or [])]
            try:
                n = int(c.get("n_opzioni") or len(opzioni))
            except (TypeError, ValueError):
                n = len(opzioni)
            sel = c.get("indice_selezionato")
            sel = sel if isinstance(sel, int) and 0 <= sel < len(opzioni) else None
            voce["n_opzioni"] = n
            persone = bool(_RE_PERSONE.search(" ".join(
                str(c.get(k) or "") for k in ("id", "name", "etichetta"))))
            di_stato = _e_menu_di_stato(c)
            if di_stato and not persone:
                in_chiaro = (n <= OPZIONI_STATO_MAX and len(opzioni) == n
                             and all(testo_sicuro(o, vietati, OPZIONI_STATO_MAX_LUNGHEZZA)
                                     and not re.search(r"\d", o) for o in opzioni))
            else:
                in_chiaro = (not persone and n <= OPZIONI_MAX and len(opzioni) == n
                             and all(testo_sicuro(o, vietati, OPZIONI_MAX_LUNGHEZZA)
                                     and not (perizia and re.search(r"\d", o))
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
            if perizia and "vuoto" in c:
                voce["vuoto"] = bool(c.get("vuoto"))
        else:
            voce["vuoto"] = bool(c.get("vuoto"))
            numero = c.get("numero")
            if (not perizia and (c.get("name") in CAMPI_NUMERICI or c.get("id") in CAMPI_NUMERICI)
                    and isinstance(numero, int) and not isinstance(numero, bool)
                    and 0 <= numero < 1_000_000):
                voce["numero"] = numero
        out.append(voce)
    return out


def _numero_campo(controlli: list[dict], nome: str) -> int | None:
    """Numero letto nel campo numRecord/PageSize (None se non c'è)."""
    for c in controlli or []:
        if isinstance(c, dict) and nome in (c.get("name"), c.get("id")):
            n = c.get("numero")
            if isinstance(n, int) and not isinstance(n, bool) and 0 <= n < 1_000_000:
                return n
    return None


def trovati_sul_portale(pagina: dict) -> tuple[int | None, int | None]:
    """(«Trovati:», «Max Righe:») letti nella pagina dell'elenco."""
    controlli = (pagina or {}).get("controlli") or []
    return _numero_campo(controlli, "numRecord"), _numero_campo(controlli, "PageSize")


# === PAGINA DELLA PERIZIA ===

def descrivi_perizia(grezza: dict | None, vietati: set[str] = frozenset()) -> dict:
    """Descrizione anonima della pagina Anagrafica di UNA perizia (da
    prelios.read_perizia_structure): campi senza valori, campi con «sosp»
    (id, name, etichetta, tipo, vuoto, lunghezza: MAI il valore), comandi
    del menu (testo mascherato se ha cifre o @, primo argomento della
    chiamata)."""
    grezza = grezza or {}
    campi_grezzi = [c for c in (grezza.get("campi") or []) if isinstance(c, dict)]
    campi = descrivi_filtri(campi_grezzi, vietati, perizia=True, massimo=MAX_CAMPI_PERIZIA)
    sosp = []
    for c in campi_grezzi[:MAX_CAMPI_PERIZIA]:
        if not c.get("sosp"):
            continue
        voce = {"origine": str(c.get("origine") or "")[:20], "id": _id_sicuro(c.get("id")),
                "name": _id_sicuro(c.get("name")), "tipo": str(c.get("tipo") or "").lower()[:20],
                "vuoto": bool(c.get("vuoto"))}
        etichetta = str(c.get("etichetta") or "").strip()
        if etichetta:
            if _etichetta_sicura(etichetta, vietati, True):
                voce["etichetta"] = etichetta
            else:
                voce["forma_etichetta"] = forma(etichetta)
        lung = c.get("lunghezza")
        if isinstance(lung, int) and not isinstance(lung, bool):
            voce["lunghezza"] = lung
        sosp.append(voce)
    voci = []
    viste: set[tuple] = set()
    for v in grezza.get("voci_menu") or []:
        if not isinstance(v, dict):
            continue
        testo = re.sub(r"\s+", " ", str(v.get("testo") or "")).strip()[:VOCE_MENU_MAX]
        chiamata = maschera_chiamata(v.get("chiamata"))
        if not _chiamata_sicura(chiamata, vietati):
            chiamata = forma(chiamata)
        voce = {"tag": str(v.get("tag") or "")[:12], "chiamata": chiamata}
        if testo:
            if (re.search(r"\d", testo) or not testo_sicuro(testo, vietati, VOCE_MENU_MAX)):
                voce["forma_testo"] = forma(testo)
            else:
                voce["testo"] = testo
        firma = tuple(sorted(voce.items()))
        if firma in viste:
            continue
        viste.add(firma)
        voci.append(voce)
        if len(voci) >= MAX_VOCI_MENU:
            break
    intestazioni = []
    for r in (grezza.get("intestazioni") or [])[:10]:
        if not isinstance(r, list):
            continue
        celle = []
        for c in r[:40]:
            c = re.sub(r"\s+", " ", str(c or "")).strip()
            celle.append(c if (not c or _etichetta_sicura(c, vietati, True)) else forma(c))
        intestazioni.append(celle)
    note = []
    if not sosp:
        note.append("Nessun campo con «sosp» nell'id, nel name o nell'etichetta.")
    return {
        "descrizione": ("Com'è fatta una pagina della perizia (campi, intestazioni delle "
                        "tabelle e comandi, MAI i valori). Non contiene dati dei clienti."),
        "origini": int(grezza.get("origini") or 0),
        "n_campi": len(campi_grezzi),
        "campi": campi,
        "sospensione_trovata": sosp,
        "intestazioni_tabelle": intestazioni,
        "voci_menu": voci,
        "note": note,
    }


# === DESCRIZIONE COMPLETA ===

_RE_CODICE_ICONA = re.compile(r"[A-Z]{1,3}")


def _conteggi_codici(valori: object) -> dict[str, int]:
    """{codice dell'icona: quante}: solo codici di 1-3 lettere maiuscole
    (nient'altro può finire nel file), dal più frequente."""
    out: dict[str, int] = {}
    if isinstance(valori, dict):
        for k, v in valori.items():
            if isinstance(k, str) and _RE_CODICE_ICONA.fullmatch(k) \
                    and isinstance(v, int) and not isinstance(v, bool):
                out[k] = v
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


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
                    info: dict | None = None, fasi: Iterable[str] | None = None) -> dict:
    """Descrizione anonima dell'elenco appena letto.

    Args:
        righe: righe GREZZE lette dalla griglia (liste di testi delle celle).
        stats: contatori di excel_pratiche.parse_grid_rows.
        info: dati raccolti da prelios.list_assigned (pagine lette, controlli
            di paginazione, struttura della pagina: <th>, campi del modulo,
            contenuto delle celle).
        fasi: fase di ogni pratica FULL - Acquisto (solo per i conteggi).
    """
    stats = stats or {}
    info = info or {}
    righe = [list(r) for r in righe]
    vietati = valori_vietati(righe)
    pagina = info.get("pagina") or {}
    note: list[str] = []

    intestazioni, come = trova_intestazioni(righe, pagina.get("th") or [], vietati)
    colonne = descrivi_colonne(righe, vietati, pagina.get("celle"))
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

    trovati, max_righe = trovati_sul_portale(pagina)
    con_tipologia = int(stats.get("con_tipologia", 0))
    if trovati is not None and trovati > con_tipologia:
        note.append(f"Il portale dice {trovati} perizie («Trovati») ma ne sono state "
                    f"lette {con_tipologia}: forse ci sono più pagine.")

    fasi = [f for f in (fasi or []) if f]
    motivo_stato = stats.get("colonne_stato")
    stato_portale = {
        "colonne_trovate": motivo_stato == "",
        "conteggi_fasi": dict(Counter(fasi)),
        "senza_stato": int(stats.get("senza_stato", 0)),
    }
    if motivo_stato:
        stato_portale["motivo"] = str(motivo_stato)[:200]
    info_sosp = stats.get("stato_info") if isinstance(stats.get("stato_info"), dict) else {}
    if info_sosp:
        stato_portale["sospese_come"] = (
            "ricerca del portale con «Stato Perizia» = sospesa"
            if info_sosp.get("strada") == "ricerca_sospese" else
            "ripiego: colonna «Sospensione» non vuota (la ricerca delle sospese non è riuscita)")
        for k in ("sospese_trovate", "sospese_aggiunte"):
            if isinstance(info_sosp.get(k), int):
                stato_portale[k] = info_sosp[k]
        if info_sosp.get("motivo_ricerca"):
            stato_portale["motivo_ricerca"] = forma_se_serve(info_sosp["motivo_ricerca"], vietati)
        # Icona di stato della colonna «VT»: codici (1-3 lettere) con i conteggi
        if "icone_vt" in info_sosp:
            stato_portale["colonna_vt_trovata"] = bool(info_sosp.get("colonna_vt"))
            stato_portale["icone_vt"] = _conteggi_codici(info_sosp.get("icone_vt"))
            stato_portale["non_pubblicate"] = _conteggi_codici(info_sosp.get("non_pubblicate"))
            stato_portale["perizie_senza_icona"] = int(info_sosp.get("senza_icona") or 0)

    link_pagina = []
    for c in pagina.get("link_pagina") or []:
        if not isinstance(c, dict):
            continue
        testo = str(c.get("testo") or "").strip()
        voce = {"tag": str(c.get("tag") or "")[:12],
                "testo": testo if testo_sicuro(testo, vietati, 10) else forma(testo),
                "chiamata": maschera_chiamata(c.get("chiamata")),
                "origine": str(c.get("origine") or "")[:20]}
        if not _chiamata_sicura(voce["chiamata"], vietati):
            voce["chiamata"] = forma(voce["chiamata"])
        if voce not in link_pagina:
            link_pagina.append(voce)

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
            "trovati_sul_portale": trovati,
            "max_righe": max_righe,
        },
        "stato_portale": stato_portale,
        "paginazione": {"controlli_riconosciuti": controlli,
                        "link_pagina": link_pagina[:40],
                        "nota": "I numeri di pagina sono solo descritti: il bridge non li clicca."},
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


def valori_pratiche(pratiche: Iterable, telefoni: Iterable[str] = (),
                    testi: Iterable[str] = ()) -> set[str]:
    """Intestatari, vie, note e telefoni delle pratiche (normalizzati), con i
    numeri trovati nelle note in più formati. `testi`: altri testi da non
    scrivere mai (note di contatto e di sospensione lette dal portale)."""
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
    for testo in testi:
        aggiungi(testo)
        for parte in re.split(r"\s+·\s+|\s+\|\s+", str(testo or "")):
            aggiungi(parte)
    return out


def controllo_sicurezza(struttura: dict, vietati: set[str] = frozenset()) -> list[str]:
    """Problemi che impediscono di scrivere il file (lista vuota = ok):
    chiocciola, 6+ cifre di fila, date (tranne l'ora di scrittura nel campo
    "quando"), valori uguali (o contenenti, se lunghi) a dati delle
    pratiche. Vale per tutte le parti del file, compresa la sezione
    "perizia". Le forme sono ammesse solo se fatte di x, 9 e punteggiatura."""
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
        if chiave not in CHIAVI_CON_DATA and _RE_DATA_COMPLETA.search(s):
            problemi.append(f"data nel campo '{chiave}'")
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
