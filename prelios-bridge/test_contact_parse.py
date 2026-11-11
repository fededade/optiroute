"""Test puri di contact_parse (nessuna dipendenza dalla pipeline).

Uso: python3 test_contact_parse.py
I casi replicano i PATTERN reali delle "Note del Gestore Intesa" con
dati anonimi.
"""

from contact_parse import analizza_nota_gestore, estrai_telefoni, normalizza_numero


def test_normalizzazione():
    assert normalizza_numero("00393331234567") == "+393331234567"
    assert normalizza_numero("+39 333 123 4567") == "+393331234567"
    assert normalizza_numero("333 123 4567") == "+393331234567"
    assert normalizza_numero("02 1234567") == "+39021234567"
    print("OK test_normalizzazione")


def test_pattern_nome_numero():
    # Pattern classico: "Nome Cognome - 0039... - istruzioni"
    r = analizza_nota_gestore("Mario Bianchi - 00393331234567 - acquista tramite agenzia")
    assert r["telefono"] == "+393331234567", r
    assert r["nome_contatto"] == "Mario Bianchi", r
    print("OK test_pattern_nome_numero")


def test_solo_nome_e_numero():
    r = analizza_nota_gestore("Franco Verdi - 00393351234509")
    assert r["telefono"] == "+393351234509"
    assert r["nome_contatto"] == "Franco Verdi"
    print("OK test_solo_nome_e_numero")


def test_piu_numeri_preferisce_mobile():
    # Ufficio (fisso) + cellulare ripetuto in formati diversi: dedup + mobile
    r = analizza_nota_gestore(
        "Massimo Neri - 00393381234567 - numero dell'ufficio 0212345678 e il "
        "numero di Massimo Neri 3381234567. Se non risponde chiamare l'ufficio."
    )
    assert r["telefono"] == "+393381234567", r
    assert r["nome_contatto"] == "Massimo Neri"
    numeri = {t["numero"] for t in r["telefoni"]}
    assert numeri == {"+393381234567", "+390212345678"}, numeri
    print("OK test_piu_numeri_preferisce_mobile")


def test_maiuscolo_con_tel():
    r = analizza_nota_gestore(
        "PER IL SOPRALLUOGO CONTATTARE SIG.MARIO DELL'AGENZIA IMMOBILIARE "
        "ROSSI TEL: 3336230999"
    )
    assert r["telefono"] == "+393336230999", r
    assert r["nome_contatto"].startswith("PER IL SOPRALLUOGO CONTATTARE SIG.MARIO")
    assert not r["nome_contatto"].rstrip().endswith("TEL:")
    print("OK test_maiuscolo_con_tel")


def test_contattare_cell():
    r = analizza_nota_gestore("Anna Rosa Belli - 00393421234504 - CONTATTARE BELLI CELL 3421234504")
    assert r["telefono"] == "+393421234504"
    assert r["nome_contatto"] == "Anna Rosa Belli"
    assert len(r["telefoni"]) == 1  # stesso numero in due formati: dedup
    print("OK test_contattare_cell")


def test_solo_fisso():
    r = analizza_nota_gestore("chiamare ufficio 02 25060884")
    assert r["telefono"] == "+390225060884", r
    print("OK test_solo_fisso")


def test_niente_falsi_positivi():
    # NDG, ID pratica, importi, date, CAP, coordinate: nessun match
    testo = ("NSG 0005674203441000 ID 0000000001853430 pratica 826361 "
             "importo 85.000,00 del 03/07/2026 cap 20066 lat 45.507226")
    assert estrai_telefoni(testo) == [], estrai_telefoni(testo)
    print("OK test_niente_falsi_positivi")


def test_nota_vuota():
    r = analizza_nota_gestore("")
    assert r == {"telefono": "", "nome_contatto": "", "telefoni": []}
    print("OK test_nota_vuota")


if __name__ == "__main__":
    test_normalizzazione()
    test_pattern_nome_numero()
    test_solo_nome_e_numero()
    test_piu_numeri_preferisce_mobile()
    test_maiuscolo_con_tel()
    test_contattare_cell()
    test_solo_fisso()
    test_niente_falsi_positivi()
    test_nota_vuota()
    print("\nTutti i test superati.")
