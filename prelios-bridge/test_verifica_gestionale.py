#!/usr/bin/env python3
"""Test PURI della verifica amministratore (verifica_gestionale.py).

Token SINTETICI (firma finta: il bridge non la controlla, lo fa Firestore),
"Firestore" finto al posto della rete, orologio fisso. Verifica: admin
valido, tecnico, email non verificata, token scaduto, emittente sbagliato,
progetto non valido, Firestore 403/404/500, errore di rete, e che il token
non compaia mai nei messaggi d'errore.

Esecuzione:
    python test_verifica_gestionale.py
"""

from __future__ import annotations

import base64
import io
import json
import sys
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from verifica_gestionale import ErroreVerifica, Utente, verifica_admin  # noqa: E402

ADESSO = 1_800_000_000
PROGETTO = "progetto-di-prova"


def _b64(dati: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(dati).encode()).decode().rstrip("=")


def crea_token(**modifiche) -> str:
    payload = {
        "iss": f"https://securetoken.google.com/{PROGETTO}",
        "aud": PROGETTO,
        "exp": ADESSO + 3600,
        "iat": ADESSO - 60,
        "sub": "utente-di-prova",
        "email": "Mario.Rossi@Esempio.example",
        "email_verified": True,
    }
    payload.update(modifiche)
    payload = {k: v for k, v in payload.items() if v is not None}
    return f"{_b64({'alg': 'RS256'})}.{_b64(payload)}.firma-finta"


def documento(ruolo: str, nome: str = "Mario Rossi") -> dict:
    return {"name": "x", "fields": {"ruolo": {"stringValue": ruolo},
                                    "nome": {"stringValue": nome}}}


class FintoFirestore:
    """Sostituisce urllib.request.urlopen."""

    def __init__(self, stato: int = 200, corpo=None, eccezione: Exception | None = None):
        self.stato = stato
        self.corpo = corpo
        self.eccezione = eccezione
        self.richieste = []

    def __call__(self, richiesta, timeout=None):
        self.richieste.append((richiesta, timeout))
        if self.eccezione is not None:
            raise self.eccezione
        dati = self.corpo if isinstance(self.corpo, bytes) else json.dumps(self.corpo).encode()
        if self.stato != 200:
            raise urllib.error.HTTPError(richiesta.full_url, self.stato, "errore", {},
                                         io.BytesIO(b"{}"))
        risposta = io.BytesIO(dati)
        risposta.status = 200
        risposta.getcode = lambda: 200
        return risposta


def _verifica(token: str, firestore: FintoFirestore):
    return verifica_admin(token, apri=firestore, orologio=lambda: ADESSO)


def _deve_fallire(token: str, firestore: FintoFirestore, codice: str) -> ErroreVerifica:
    try:
        _verifica(token, firestore)
    except ErroreVerifica as e:
        assert e.codice == codice, (e.codice, codice, e.descrizione)
        if len(token) > 8:
            assert token not in str(e) and token not in e.descrizione
        return e
    raise AssertionError(f"verifica superata per errore (atteso {codice})")


def test_admin_valido() -> None:
    for ruolo in ("Super Amministratore", "Amministratore"):
        fs = FintoFirestore(corpo=documento(ruolo))
        token = crea_token()
        utente = _verifica(token, fs)
        assert utente == Utente(nome="Mario Rossi", ruolo=ruolo,
                                email="mario.rossi@esempio.example"), utente
        ((richiesta, timeout),) = fs.richieste
        assert timeout == 10
        assert richiesta.get_method() == "GET"
        assert richiesta.full_url == (
            "https://firestore.googleapis.com/v1/projects/progetto-di-prova/databases/"
            "(default)/documents/personale/mario.rossi%40esempio.example"), richiesta.full_url
        assert richiesta.get_header("Authorization") == f"Bearer {token}"
    print("OK test_admin_valido")


def test_ruolo_non_admin() -> None:
    # Solo i due ruoli esatti: tecnico, maiuscole diverse, spazi, vuoto → no
    for ruolo in ("Tecnico", "amministratore", " Amministratore", "Super amministratore", ""):
        e = _deve_fallire(crea_token(), FintoFirestore(corpo=documento(ruolo)), "ruolo")
        assert e.utente is not None and e.utente.ruolo == ruolo
    # scheda senza campo ruolo
    _deve_fallire(crea_token(), FintoFirestore(corpo={"fields": {}}), "ruolo")
    print("OK test_ruolo_non_admin")


def test_controlli_locali() -> None:
    # Nessuna chiamata a Firestore se il token è già da scartare
    casi = [
        crea_token(email_verified=False),
        crea_token(email_verified="true"),
        crea_token(email_verified=None),
        crea_token(exp=ADESSO - 1),
        crea_token(exp=ADESSO),
        crea_token(exp="domani"),
        crea_token(iss="https://securetoken.google.com/altro-progetto"),
        crea_token(iss="https://altro.example/progetto-di-prova"),
        crea_token(aud="Progetto-Maiuscolo", iss="https://securetoken.google.com/Progetto-Maiuscolo"),
        crea_token(aud="abc", iss="https://securetoken.google.com/abc"),
        crea_token(aud="progetto/../x", iss="https://securetoken.google.com/progetto/../x"),
        crea_token(email=None),
        "non-un-token",
        "a.b",
        "a.!!!.c",
        "",
    ]
    for token in casi:
        fs = FintoFirestore(corpo=documento("Amministratore"))
        _deve_fallire(token, fs, "token")
        assert fs.richieste == [], token
    print("OK test_controlli_locali")


def test_risposte_firestore() -> None:
    for stato in (401, 403, 404):
        _deve_fallire(crea_token(), FintoFirestore(stato=stato), "token")
    for stato in (500, 503, 429):
        _deve_fallire(crea_token(), FintoFirestore(stato=stato), "verifica")
    _deve_fallire(crea_token(), FintoFirestore(corpo=b"non json"), "verifica")
    _deve_fallire(crea_token(), FintoFirestore(corpo={"fields": "x"}), "verifica")
    _deve_fallire(crea_token(),
                  FintoFirestore(eccezione=urllib.error.URLError("rete assente")), "verifica")
    _deve_fallire(crea_token(), FintoFirestore(eccezione=TimeoutError()), "verifica")
    print("OK test_risposte_firestore")


def main() -> int:
    test_admin_valido()
    test_ruolo_non_admin()
    test_controlli_locali()
    test_risposte_firestore()
    print("\nTutti i test superati.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
