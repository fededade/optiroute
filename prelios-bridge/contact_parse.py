"""Parsing puro dei contatti cliente dalle note della perizia Prelios.

Le "Note del Gestore Intesa" (campo Imm_Descrizione) seguono di solito il
pattern:  "Nome Cognome - 00393331234567 - eventuali istruzioni"
con varianti: prefisso 0039 o +39, numeri a gruppi, "TEL:"/"CELL",
piu' numeri nella stessa nota (ufficio + cellulare), testo in maiuscolo.

Modulo SENZA dipendenze dalla pipeline MISI: usato da t05_extract_contacts
e testabile standalone. Va copiato accanto a run_giro.py nel progetto MISI.
"""

from __future__ import annotations

import re

# Cellulari: 3xx + 6/7 cifre, separatori opzionali, prefisso +39/0039 opzionale
RE_MOBILE = re.compile(r"\b(?:(?:\+|00)39[\s.]?)?3\d{2}(?:[\s./-]?\d{3}){2}\d?\b")
# Fissi: 0 + prefisso, prefisso internazionale opzionale
RE_FISSO = re.compile(r"\b(?:(?:\+|00)39[\s.]?)?0\d{1,3}[\s./-]?\d{5,8}\b")

# Parole da ripulire in coda al nome del referente ("... TEL:", "... CELL")
_RE_CODA_ETICHETTA = re.compile(
    r"(?:TEL(?:EFONO)?|CELL(?:ULARE)?|NUM(?:ERO)?)\.?\s*:?\s*$", re.IGNORECASE
)


def normalizza_numero(raw: str) -> str:
    """Normalizza un numero in formato internazionale +39XXXXXXXXXX."""
    numero = re.sub(r"[\s./-]", "", raw)
    if numero.startswith("0039"):
        numero = "+39" + numero[4:]
    elif not numero.startswith("+"):
        numero = "+39" + numero
    return numero


def estrai_telefoni(testo: str) -> list[dict]:
    """Tutti i numeri di un testo, deduplicati sul numero normalizzato.

    Returns:
        Lista di {"numero": "+39...", "tipo": "mobile"|"fisso",
        "posizione": indice nel testo}, con i mobili prima.
    """
    trovati: list[dict] = []
    visti: set[str] = set()
    for regex, tipo in ((RE_MOBILE, "mobile"), (RE_FISSO, "fisso")):
        for m in regex.finditer(testo or ""):
            numero = normalizza_numero(m.group(0))
            if numero in visti:
                continue
            visti.add(numero)
            trovati.append({"numero": numero, "tipo": tipo, "posizione": m.start()})
    return trovati


def analizza_nota_gestore(testo: str) -> dict:
    """Analizza una nota gestore ed estrae telefono e referente.

    Returns:
        {"telefono": miglior numero ("+39..." o ""),
         "nome_contatto": testo prima del primo numero (referente/istruzioni),
         "telefoni": tutti i candidati}
    """
    testo = (testo or "").strip()
    telefoni = estrai_telefoni(testo)

    telefono = ""
    for t in telefoni:
        if t["tipo"] == "mobile":
            telefono = t["numero"]
            break
    if not telefono and telefoni:
        telefono = telefoni[0]["numero"]

    nome = ""
    if telefoni:
        prima_pos = min(t["posizione"] for t in telefoni)
        prefisso = _RE_CODA_ETICHETTA.sub("", testo[:prima_pos])
        nome = re.sub(r"\s+", " ", prefisso).strip(" -–—:,.;")[:80]

    return {"telefono": telefono, "nome_contatto": nome, "telefoni": telefoni}
