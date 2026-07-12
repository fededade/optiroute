# Prelios Bridge — app autonoma: elenco pratiche → telefoni → OptiRoute

Programma Python **indipendente** che legge un elenco pratiche, entra in
Prelios, recupera il numero di telefono di ogni cliente e produce un Excel
importabile in OptiRoute.

**È un'app a sé**: NON va copiata dentro il progetto MISI e non importa nulla
di MISI. Riusa solo la *logica* di accesso a Prelios (login, ricerca,
apertura, lettura campi), qui riscritta in forma autonoma.

## Cosa fa

1. Legge l'elenco pratiche (Excel `.xlsx` o TSV/CSV) e tiene SOLO le righe con
   tipologia **FULL - Acquisto** (le altre — Surroga, DSKT, ecc. — sono escluse).
2. Apre Chrome, ti fa fare il **login Prelios manuale (MFA)**, poi per ogni
   pratica: cerca la perizia, la apre e legge il telefono dalle **Note del
   Gestore** (con i fallback: Telefono Mutuatario, Note perito, Telefono
   Richiedente; i campi NTM sono ignorati).
3. Scrive un Excel con le colonne che OptiRoute importa.

Gli errori sulla singola pratica NON fermano il giro (finiscono nella colonna
`Esito`).

## File (stanno tutti nella cartella del bridge, insieme)

| File | Ruolo |
|---|---|
| `run_giro.py` | comando principale (orchestratore del giro) |
| `browser.py` | browser Selenium autonomo (Chrome remote-debugging, porta 9223) |
| `prelios.py` | login + ricerca + apertura + lettura telefono |
| `excel_pratiche.py` | lettura/filtro elenco (FULL - Acquisto) |
| `contact_parse.py` | estrazione telefono/referente dalle note |
| `dump_perizia_fields.py` | diagnostico (mappa i campi di una perizia) |
| `test_excel_pratiche.py`, `test_contact_parse.py` | test |

Non serve toccare MISI: basta questa cartella.

## Requisiti

- **Python 3.10+**
- **Google Chrome** installato
- `pip install selenium openpyxl`
  - senza `openpyxl` legge TSV/CSV e scrive un CSV al posto dell'Excel;
  - `selenium` serve solo per il giro vero (non per il `--dry-run`).

## Uso

### 1. Prova a vuoto (senza Prelios) — consigliata come primo test
```bash
python run_giro.py elenco.xlsx --dry-run --out prova.xlsx
```
Filtra le FULL - Acquisto e scrive il file SENZA telefoni: verifica che tutto
sia a posto e che OptiRoute importi il formato.

### 2. Giro completo (con Prelios)
```bash
python run_giro.py elenco.xlsx --out giro_arricchito.xlsx
```
Si apre Chrome: **fai il login Prelios (MFA) come al solito**; il bridge
prosegue da solo su tutte le pratiche. A fine giro trovi `giro_arricchito.xlsx`
con la colonna Telefono → trascinalo su "Importa Excel" in OptiRoute.

Opzioni utili:
- `--user-id 8468` — User ID Prelios per l'apertura perizia (default `8468`;
  è lo stesso che usa MISI, in `config.py` alla voce `user_id`).

### 3. Diagnostica (se un telefono non viene trovato)
```bash
python dump_perizia_fields.py 826361 --out campi.json
```
Apre quella perizia e scrive tutti i campi + i candidati telefono in `campi.json`.

## Note

- Il bridge usa un Chrome **dedicato** (porta 9223, profilo `chrome_prelios_bridge`),
  diverso da quello di MISI: puoi anche tenerli aperti insieme.
- Il telefono è normalizzato in formato `+39...`.
- La nota del gestore (referente + istruzioni per il sopralluogo) viene messa
  nella colonna **Note** dell'output, così arriva fino all'operatore AI in
  chiamata dentro OptiRoute.

## Formato di output per OptiRoute

Intestazioni ESATTE, nell'ordine:

| Intestatario | Indirizzo | N.Civ. | Comune | Prov. | Telefono | Note | Codice | Esito |
|---|---|---|---|---|---|---|---|---|

`Esito` è una colonna diagnostica (OK / KO con motivo / DRY-RUN): OptiRoute
ignora le colonne che non conosce.

## Test
```bash
python test_excel_pratiche.py
python test_contact_parse.py
```
Test puri (niente Prelios, niente dati reali): filtro FULL - Acquisto,
estrazione campi, parsing telefono dalle note, anti falsi-positivi.
