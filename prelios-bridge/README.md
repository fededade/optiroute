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

## File — DOVE COPIARLI nel progetto MISI ISP

Verificato sul sorgente reale di MISI (config.py → `AppConfig`,
browser_session.py → `BrowserSession`, models.py → `ToolContext`,
`ToolResult.data_updates`).

| File | Dove copiarlo |
|---|---|
| `run_giro.py` | **radice** del progetto (accanto a `config.py`, `models.py`, `browser_session.py`) |
| `excel_pratiche.py` | **radice** |
| `contact_parse.py` | **radice** |
| `dump_perizia_fields.py` | **radice** (diagnostico, opzionale) |
| `t05_extract_contacts.py` | cartella **`tools/`** (accanto a `t01_login.py`) |
| `test_excel_pratiche.py`, `test_contact_parse.py` | radice (opzionali, per i test) |

`excel_pratiche.py`, `contact_parse.py` e i test sono standalone: non
importano nulla della pipeline (girano anche fuori dal progetto MISI).

⚠️ **Chiudi MISI prima di lanciare il bridge**: usano lo stesso Chrome con
remote-debugging (porta 9222), quindi due processi che lo pilotano insieme
darebbero conflitti.

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

All'apertura, il bridge apre (o si collega a) il Chrome con remote-debugging
esattamente come MISI: **fai il login Prelios col tuo MFA come al solito** e
il bridge prosegue da solo, pratica per pratica. Il login viene fatto una
sola volta per tutto il giro.

`_crea_contesto()` in `run_giro.py` costruisce il contesto con
`AppConfig()` + `BrowserSession(...).start()` + `ToolContext(...)`, gli
stessi oggetti del progetto MISI. Se il file del browser non si chiamasse
`browser_session.py`, correggere l'import in cima a quella funzione.

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
