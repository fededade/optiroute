"""Anonimizzazione delle catture di pagina (capture_portal.py, dump_elenco.py).

Scopo: una cattura deve mostrare la STRUTTURA di una pagina (tabelle,
intestazioni, campi, etichette) ma non i dati personali, così si può
condividere per costruire/correggere un adapter di portale.

Regola base: lettere → 'x', cifre → '9', tutto il resto (spazi,
punteggiatura, trattini, '@', '/') invariato: lunghezze e formati restano
riconoscibili ("ROSSI MARIO - 333 1234567" → "xxxxx xxxxx - 999 9999999").

Modulo PURO (solo libreria standard): testabile senza browser.
"""

from __future__ import annotations

import copy
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Testi più lunghi di così non sono considerati "etichette" (potrebbero
# essere dati) e vengono anonimizzati anche dove le etichette restano in chiaro.
MAX_ETICHETTA = 40
MAX_INTESTAZIONE = 60
# Righe con più celle di così sono considerate griglie dati, non moduli
MAX_CELLE_MODULO = 6

# NOTA: le etichette brevi (intestazioni <th>, etichette dei campi, testi dei
# controlli fuori dalle tabelle) restano in chiaro perché sono la struttura
# che serve. Un'euristica non può garantire che nessuna di esse sia un dato:
# prima di condividere una cattura, darle comunque un'occhiata.


def anonimizza(testo: object) -> str:
    """Lettere → 'x', cifre → '9', il resto invariato (lunghezza preservata)."""
    if testo is None:
        return ""
    out = []
    for ch in str(testo):
        if ch.isdigit():
            out.append("9")
        elif ch.isalpha():
            out.append("x")
        else:
            out.append(ch)
    return "".join(out)


def solo_cifre(testo: object) -> str:
    """Cifre → '9', lettere invariate (per titoli, id, onclick: la parte
    testuale è struttura, i numeri possono essere codici pratica)."""
    return re.sub(r"\d", "9", "" if testo is None else str(testo))


def etichetta(testo: object, massimo: int = MAX_ETICHETTA) -> str:
    """Le etichette brevi restano in chiaro; quelle lunghe si anonimizzano."""
    s = "" if testo is None else str(testo)
    return s if len(s) <= massimo else anonimizza(s)


def anonimizza_url(url: object) -> str:
    """Schema, host e lettere del percorso restano; cifre del percorso → 9;
    valori della query e frammento anonimizzati (i nomi dei parametri no)."""
    s = "" if url is None else str(url)
    try:
        parti = urlsplit(s)
    except ValueError:
        return anonimizza(s)
    query = urlencode([(k, anonimizza(v))
                       for k, v in parse_qsl(parti.query, keep_blank_values=True)])
    return urlunsplit((parti.scheme, parti.netloc, solo_cifre(parti.path), query,
                       anonimizza(parti.fragment)))


def _anonimizza_documento(doc: dict) -> dict:
    """Applica la politica a un documento/frame catturato (vedi
    capture_portal._JS_CATTURA per la struttura)."""
    doc["url"] = anonimizza_url(doc.get("url"))
    # Il titolo può contenere il nome del cliente: anonimizzato per intero
    doc["titolo"] = anonimizza(doc.get("titolo"))

    for t in doc.get("tabelle", []) or []:
        t["id"] = solo_cifre(t.get("id"))
        t["intestazioni"] = [etichetta(h, MAX_INTESTAZIONE) for h in t.get("intestazioni", []) or []]
        for riga in t.get("campione", []) or []:
            riga["onclick"] = solo_cifre(riga.get("onclick"))
            riga["id"] = solo_cifre(riga.get("id"))
            for cella in riga.get("celle", []) or []:
                if cella.get("th"):
                    cella["t"] = etichetta(cella.get("t"), MAX_INTESTAZIONE)
                else:
                    cella["t"] = anonimizza(cella.get("t"))

    for c in doc.get("campi", []) or []:
        # Etichetta presa dalla cella precedente: in un modulo è un'etichetta,
        # in una griglia dati (righe con molte celle) potrebbe essere un dato.
        if c.get("label_fonte") == "td" and (c.get("label_celle_riga") or 0) > MAX_CELLE_MODULO:
            c["label"] = anonimizza(c.get("label"))
        else:
            c["label"] = etichetta(c.get("label"))
        c["value"] = anonimizza(c.get("value"))
        c["placeholder"] = etichetta(c.get("placeholder"))

    for a in doc.get("azioni", []) or []:
        testo = a.get("testo")
        a["testo"] = anonimizza(testo) if a.get("in_tabella") else etichetta(testo)
        a["href"] = anonimizza_url(a.get("href")) if a.get("href") else ""
        a["onclick"] = solo_cifre(a.get("onclick"))
        a["id"] = solo_cifre(a.get("id"))

    for sub in doc.get("frame", []) or []:
        _anonimizza_documento(sub)
    return doc


def anonimizza_cattura(cattura: dict) -> dict:
    """Copia anonimizzata di una cattura completa
    ({"finestre": [{"documento": {...}}], ...})."""
    out = copy.deepcopy(cattura)
    for finestra in out.get("finestre", []) or []:
        if isinstance(finestra.get("documento"), dict):
            _anonimizza_documento(finestra["documento"])
    out["anonimizzata"] = True
    return out
