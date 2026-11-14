"""Verifica che chi attiva il bridge dal gestionale sia un amministratore.

Il gestionale manda il "token di accesso" (ID token Firebase) dell'utente
collegato. Il bridge NON verifica da solo la firma del token: lo usa per
leggere da Firestore la scheda `personale/<email>` di quell'utente. Se
Firestore accetta il token e la scheda dice che l'utente è "Super
Amministratore" o "Amministratore", l'attivazione è consentita.

La vera garanzia è l'elenco degli indirizzi autorizzati (header Origin, che
un browser non permette di falsificare): vedi bridge_server.py.

Solo libreria standard (urllib). Il token non viene MAI scritto nei log né
nei messaggi d'errore.
"""

from __future__ import annotations

import base64
import json
import re
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import quote

RUOLI_ADMIN = ("Super Amministratore", "Amministratore")
TIMEOUT_SEC = 10
FIRESTORE_URL = ("https://firestore.googleapis.com/v1/projects/{progetto}"
                 "/databases/(default)/documents/personale/{email}")

_RE_PROGETTO = re.compile(r"^[a-z0-9-]{4,40}$")
_LUNGHEZZA_MAX_TOKEN = 8192


@dataclass(frozen=True)
class Utente:
    nome: str
    ruolo: str
    email: str = ""


class ErroreVerifica(Exception):
    """Verifica non superata. `codice` è quello del contratto HTTP:
    'token' (accesso non valido), 'verifica' (Firestore non raggiungibile o
    risposta inattesa), 'ruolo' (utente non amministratore)."""

    def __init__(self, codice: str, descrizione: str, utente: Utente | None = None):
        super().__init__(descrizione)
        self.codice = codice
        self.descrizione = descrizione
        self.utente = utente


def _b64url(parte: str) -> bytes:
    return base64.urlsafe_b64decode(parte + "=" * (-len(parte) % 4))


def leggi_payload(token: str) -> dict:
    """Decodifica (senza verificare la firma) la parte centrale del JWT."""
    if not isinstance(token, str) or not token or len(token) > _LUNGHEZZA_MAX_TOKEN:
        raise ErroreVerifica("token", "token mancante o troppo lungo")
    parti = token.split(".")
    if len(parti) != 3 or not all(parti):
        raise ErroreVerifica("token", "token non nel formato atteso")
    try:
        payload = json.loads(_b64url(parti[1]).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ErroreVerifica("token", "token non leggibile") from None
    if not isinstance(payload, dict):
        raise ErroreVerifica("token", "token non leggibile")
    return payload


def controlla_payload(payload: dict, adesso: float) -> tuple[str, str]:
    """Controlli locali sul contenuto del token. Ritorna (progetto, email)."""
    exp = payload.get("exp")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)) or exp <= adesso:
        raise ErroreVerifica("token", "accesso scaduto")
    if payload.get("email_verified") is not True:
        raise ErroreVerifica("token", "email non verificata")
    progetto = payload.get("aud")
    if not isinstance(progetto, str) or not _RE_PROGETTO.match(progetto):
        raise ErroreVerifica("token", "progetto non valido")
    if payload.get("iss") != f"https://securetoken.google.com/{progetto}":
        raise ErroreVerifica("token", "emittente non valido")
    email = payload.get("email")
    if not isinstance(email, str) or "@" not in email or len(email) > 320:
        raise ErroreVerifica("token", "email mancante")
    return progetto, email.strip().lower()


def _stringa(campi: dict, nome: str) -> str:
    valore = campi.get(nome)
    if isinstance(valore, dict) and isinstance(valore.get("stringValue"), str):
        return valore["stringValue"]
    return ""


def verifica_admin(token: str, apri=None, orologio=time.time,
                   timeout: float = TIMEOUT_SEC) -> Utente:
    """Verifica il token del gestionale e ritorna l'utente amministratore.

    `apri(richiesta, timeout=...)` è urllib.request.urlopen (sostituibile nei
    test); `orologio()` ritorna i secondi Unix attuali.

    Raises:
        ErroreVerifica: con codice 'token', 'verifica' o 'ruolo'.
    """
    apri = apri or urllib.request.urlopen
    progetto, email = controlla_payload(leggi_payload(token), orologio())
    url = FIRESTORE_URL.format(progetto=progetto, email=quote(email, safe=""))
    richiesta = urllib.request.Request(url, method="GET", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    try:
        with apri(richiesta, timeout=timeout) as risposta:
            stato = getattr(risposta, "status", None) or risposta.getcode()
            corpo = risposta.read()
    except urllib.error.HTTPError as e:
        stato = e.code
        try:
            e.close()
        except Exception:  # noqa: BLE001
            pass
        if stato in (401, 403, 404):
            raise ErroreVerifica("token", f"scheda personale non accessibile (HTTP {stato})") from None
        raise ErroreVerifica("verifica", f"risposta inattesa dal gestionale (HTTP {stato})") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as e:
        motivo = getattr(e, "reason", None) or type(e).__name__
        raise ErroreVerifica("verifica", f"gestionale non raggiungibile ({motivo})") from None

    if stato != 200:
        raise ErroreVerifica("verifica", f"risposta inattesa dal gestionale (HTTP {stato})")
    try:
        documento = json.loads(corpo.decode("utf-8"))
        campi = documento.get("fields") or {}
        if not isinstance(campi, dict):
            raise ValueError
    except (ValueError, UnicodeDecodeError, AttributeError):
        raise ErroreVerifica("verifica", "risposta del gestionale non leggibile") from None

    # Il ruolo deve corrispondere ESATTAMENTE a uno dei ruoli amministratore
    utente = Utente(nome=_stringa(campi, "nome").strip(), ruolo=_stringa(campi, "ruolo"),
                    email=email)
    if utente.ruolo not in RUOLI_ADMIN:
        raise ErroreVerifica("ruolo", "l'utente non è un amministratore", utente=utente)
    return utente
