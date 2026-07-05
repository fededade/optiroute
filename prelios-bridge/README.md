# Prelios Bridge — elenco pratiche → telefoni → OptiRoute

Bridge Python che estende la pipeline MISI ISP (automazione Selenium del
portale Prelios VT-Desktop) per arricchire un elenco di pratiche con i numeri
di telefono dei clienti e produrre un Excel importabile nell'app OptiRoute.

## Cosa fa

1. Legge il file elenco pratiche (Excel `.xlsx` oppure TSV/CSV) e tiene SOLO
   le righe con tipologia **FULL - Acquisto** (confronto case-insensitive,
   spazi collassati; escluse quindi FULL - Surroga, DSKT - ALTRO, ecc.).
2. Per ogni pratica usa la pipeline MISI: login a Prelios (una sola volta),
   ricerca della perizia per codice (t02), apertura (t03) ed estrazione del
   telefono cliente con il nuovo tool `t05_extract_contacts`.
3. Scrive un Excel con le colonne che OptiRoute importa.

Gli errori sulla singola pratica NON fermano il giro: finiscono nella
colonna diagnostica `Esito`.

## File

| File | Cosa fa | Dove copiarlo nel progetto MISI |
|---|---|---|
| `excel_pratiche.py` | Lettura/filtro elenco pratiche (standalone) | root (accanto a `models.py`) |
| `run_giro.py` | Orchestratore CLI del giro | root (accanto a `models.py`) |
| `t05_extract_contacts.py` | Tool estrazione telefono (fase 3, Lettura) | `tools/` (accanto a `t01_login.py`) |
| `test_excel_pratiche.py` | Test puri di `excel_pratiche` | opzionale, ovunque accanto a `excel_pratiche.py` |

`excel_pratiche.py` e `test_excel_pratiche.py` sono completamente standalone:
non importano nulla della pipeline.

## Dipendenze

- Python 3.10+
- `openpyxl` (consigliato): `pip install openpyxl`
  - senza openpyxl il bridge funziona comunque con elenchi **TSV/CSV** in
    ingresso e produce un **CSV** in uscita al posto dell'Excel;
  - per leggere/scrivere `.xlsx` openpyxl e' necessario.
- Per il giro completo: il progetto MISI ISP gia' funzionante
  (Selenium, `models.py`, `js_commands.py`, `tools/`).

## Uso

### 1. Dry-run (senza pipeline, ovunque)

Produce l'Excel filtrato SENZA telefoni: utile per verificare subito che
OptiRoute importi correttamente il file.

```bash
python run_giro.py elenco.xlsx --out giro_arricchito.xlsx --dry-run
```

### 2. Giro completo (dentro il progetto MISI)

Copiare i file come da tabella sopra, poi dalla root del progetto MISI:

```bash
python run_giro.py elenco.xlsx --out giro_arricchito.xlsx
```

Il login puo' richiedere l'intervento manuale (MFA/SSO), come nel resto
della pipeline. Se i moduli MISI non sono importabili, `run_giro.py` esce
con un messaggio che spiega dove copiare i file.

Nota: `_crea_contesto()` in `run_giro.py` prova prima una factory del
progetto (`main.build_context` e simili), poi la costruzione standard
`Config + Browser + ToolContext`. Se il bootstrap del vostro `main.py` e'
diverso, adattare quella singola funzione replicandone le righe di setup.

## TODO — estrazione telefono (t05)

Non e' ancora noto in quale pagina/campo della perizia si trovi il telefono
del cliente. `t05_extract_contacts.py` implementa per ora una ricerca
GENERICA best-effort: scandisce documento principale + tutti i frame
cercando input/celle con id/etichette contenenti `tel`, `cell`, `phone`,
`recapito` e valori che corrispondono a un numero italiano (mobile
`3xx xxxxxxx`, fisso `0x ...`), con fallback sul testo della pagina (solo
mobili). Preferisce i numeri di cellulare.

Quando si sapra' la posizione esatta del campo, inserire navigazione e
selettori nel punto marcato `TODO(TELEFONO CLIENTE)` dentro
`t05_extract_contacts.py` (la scansione generica puo' restare come fallback).

## Formato di output per OptiRoute

Intestazioni ESATTE, nell'ordine:

| Intestatario | Indirizzo | N.Civ. | Comune | Prov. | Telefono | Note | Codice |
|---|---|---|---|---|---|---|---|

- **Codice** = codice pratica/perizia (senza punto migliaia);
- **Note** = progetto + eventuale riferimento gestore estratto dalle note
  dell'elenco (pattern `Rif. Gestore: NOME [telefono] [email]`), separati
  da ` | `;
- **Telefono** = numero normalizzato (senza spazi/separatori, senza +39);
  vuoto in dry-run o se non trovato.

In coda c'e' una colonna extra **Esito** (OK / KO con motivo / DRY-RUN) per
la diagnostica del giro: OptiRoute ignora le colonne che non conosce; se
l'import dovesse lamentarsi, eliminarla a mano dal file.

## Test

```bash
python test_excel_pratiche.py
```

Test puri (niente pytest, niente pipeline, nessun dato reale): filtro
FULL - Acquisto, estrazione campi, euristica posizionale senza header,
parsing con header, riferimento gestore, lettura TSV senza openpyxl.

## Strumento diagnostico

`dump_perizia_fields.py` (da copiare accanto a run_giro.py nel progetto MISI): apre una perizia e produce un JSON con pagine di menu, tutti i campi form (id/etichetta/valore) e i candidati telefono. Uso: `python dump_perizia_fields.py 826361 [--page "NomePagina"]`. Il JSON serve a finalizzare i selettori di t05_extract_contacts.

## Estrazione telefono: FINALIZZATA

`t05_extract_contacts.py` legge il telefono del cliente dalla pagina **Anagrafica Perizia** (quella su cui atterra l'apertura) in questo ordine:

1. **`Imm_Descrizione`** — "Note del Gestore Intesa" (pattern `Nome - 0039333... - istruzioni`): cellulare preferito
2. Campo **"Telefono Mutuatario"** (cercato per etichetta)
3. **`Imm_Note`** — "Note interne per il perito"
4. Campo **"Telefono Richiedente"**
5. Scansione generica della pagina (ultima spiaggia)

I campi **NTM** (Telefono NTM / Riferimento NTM) sono esclusi: sono referenti tecnici, non il cliente. I numeri sono normalizzati a `+39...` e la nota gestore (referente + istruzioni sopralluogo) finisce nella colonna Note dell'output, cosi' arriva fino all'operatore AI in chiamata.

**File aggiuntivo da copiare**: `contact_parse.py` va nella ROOT del progetto MISI (accanto a run_giro.py); `t05_extract_contacts.py` in `tools/`. Test: `python3 test_contact_parse.py`.
