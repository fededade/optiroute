# Prelios Bridge — app autonoma: portale → telefoni → OptiRoute

Programma Python **indipendente** che legge l'elenco pratiche, entra nel
portale (oggi Prelios), recupera il numero di telefono di ogni cliente e
consegna i dati a OptiRoute: come Excel da importare (giro classico) oppure
direttamente alla web app tramite un piccolo server locale (modalità servizio).

**È un'app a sé**: NON va copiata dentro il progetto MISI e non importa nulla
di MISI. Riusa solo la *logica* di accesso a Prelios (login, ricerca,
apertura, lettura campi), qui riscritta in forma autonoma.

Il **login con MFA resta sempre manuale**: il bridge non lo aggira né lo
automatizza, aspetta che l'operatore lo completi nella finestra Chrome.

## Cosa fa

1. Legge l'elenco pratiche e tiene SOLO le righe con tipologia
   **FULL - Acquisto** (le altre — Surroga, DSKT, ecc. — sono escluse).
   L'elenco viene da un file Excel/TSV esportato dal portale oppure, in
   modalità servizio, può essere letto direttamente dalla griglia del portale
   (**best-effort, da verificare**: vedi sotto).
2. Apre Chrome, ti fa fare il **login Prelios manuale (MFA)**, poi per ogni
   pratica: cerca la perizia, la apre e legge il telefono dalle **Note del
   Gestore** (con i fallback: Telefono Mutuatario, Note perito, Telefono
   Richiedente; i campi NTM sono ignorati).
3. Consegna i dati: Excel con le colonne che OptiRoute importa (giro
   classico) oppure HTTP locale letto dalla web app (modalità servizio).

Gli errori sulla singola pratica NON fermano il giro (finiscono nella colonna
`Esito`).

## File (stanno tutti nella cartella del bridge, insieme)

| File | Ruolo |
|---|---|
| `run_giro.py` | comando principale (giro classico e `--serve`) |
| `servizio.py` | modalità servizio: cicli periodici, login, consegna |
| `bridge_server.py` | server HTTP locale (contratto v1, solo 127.0.0.1) |
| `bridge_cache.py` | cache persistente `bridge_cache.json` |
| `portals.py` | adapter dei portali (Prelios; Cerved registrato ma non configurato) |
| `browser.py` | browser Selenium autonomo (Chrome remote-debugging, porta 9223) |
| `prelios.py` | login + elenco + ricerca + apertura + lettura telefono |
| `excel_pratiche.py` | lettura/filtro elenco (FULL - Acquisto), da file o da griglia |
| `contact_parse.py` | estrazione telefono/referente dalle note |
| `anonimizza.py` | anonimizzazione delle catture (lettere→x, cifre→9) |
| `dump_perizia_fields.py` | diagnostico (mappa i campi di una perizia) |
| `dump_elenco.py` | diagnostico (struttura grezza della griglia Elenco Perizie) |
| `capture_portal.py` | cattura guidata e anonimizzata delle pagine di un portale |
| `test_*.py` | test puri (niente portale, niente rete) |

## Requisiti

- **Python 3.10+**
- **Google Chrome** installato (Windows, macOS o Linux; per un percorso non
  standard impostare la variabile d'ambiente `CHROME_PATH`)
- `pip install selenium openpyxl`
  - senza `openpyxl` legge TSV/CSV e scrive un CSV al posto dell'Excel;
  - `selenium` serve solo per il giro vero (non per il `--dry-run` né per i test).

## Uso — giro classico (invariato)

### 1. Prova a vuoto (senza Prelios) — consigliata come primo test
```bash
python run_giro.py elenco.xlsx --dry-run --out prova.xlsx
```
Filtra le FULL - Acquisto e scrive il file SENZA telefoni.

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
- `--limit N` — lavora solo le prime N pratiche (per un primo test).

## Uso — modalità servizio (consegna diretta alla web app)

```bash
python run_giro.py --serve                       # elenco letto dal portale (best-effort)
python run_giro.py --serve elenco.xlsx           # elenco dal file, riletto a ogni ciclo
python run_giro.py --serve --port 8765 --interval 30 --portal prelios
```

Giornata tipo:
1. **Al mattino** avvii il comando: si apre il Chrome dedicato del bridge.
2. Fai il **login Prelios con MFA** nella finestra (unico passaggio manuale).
3. Da lì il bridge lavora da solo: ogni `--interval` minuti (default 30)
   rilegge l'elenco e recupera il telefono **solo delle pratiche nuove**.
   La web app OptiRoute legge i dati dal bridge senza bisogno di trascinare
   l'Excel.
4. Se la sessione Prelios scade, lo stato passa a `login_required` e il
   bridge **aspetta** un nuovo login (non si chiude). Rifai il login nella
   stessa finestra e riparte.
5. `Ctrl+C` per fermarlo.

Mentre il bridge lavora, **non usare quella finestra Chrome** per altro: è
pilotata dal programma.

Regole dei cicli (cache `bridge_cache.json` nella cartella del bridge):
- le pratiche già risolte **con** telefono non vengono più riaperte;
- quelle **senza** telefono (non trovato, KO, errore) si ritentano al
  massimo **una volta al giorno**;
- la cache sopravvive ai riavvii; le pratiche non più in elenco da 30 giorni
  vengono eliminate;
- se la lettura dell'elenco dal portale restituisce zero pratiche mentre
  l'ultimo elenco noto non era vuoto, l'elenco noto NON viene cancellato
  (stato `error`, da controllare con `dump_elenco.py`).

`--serve --dry-run elenco.xlsx` espone le pratiche del file senza aprire il
portale (telefoni vuoti, cache non scritta): utile per provare la web app.

### Token

Al primo avvio il bridge genera un token casuale, lo salva in
`bridge_token.txt` (cartella del bridge, escluso da git) e lo stampa nel
terminale: **incollalo una volta** nelle impostazioni di OptiRoute. Il token
viene stampato all'avvio e non compare in nessun altro log. Per revocarlo:
cancella `bridge_token.txt` e riavvia (ne verrà generato uno nuovo).

### Contratto HTTP v1 (solo `127.0.0.1`)

- `GET /v1/health` → `200 {"bridge":"optiroute-bridge","version":1}` (senza token)
- `GET /v1/pratiche` con header `X-Bridge-Token` (o `?token=`) → `200`
  `{bridge, version, generatedAt, portals[], pratiche[]}`; token mancante o
  errato → `401 {"error":"token"}`.
  - `portals[]`: `{id, status, lastSync, message}`, con `status` fra
    `starting | login_required | running | ok | error`;
  - `pratiche[]`: `{portal, codice, intestatario, via, civico, comune,
    provincia, telefono, note, progetto, tipologia, esito, aggiornatoIl}`.
    Sono esposte le pratiche dell'ultimo elenco letto, anche quelle non
    ancora lavorate (`esito: "IN ATTESA"`, telefono vuoto).
- CORS: `Access-Control-Allow-Origin` (Origin riflesso, altrimenti `*`),
  `Vary: Origin`; `OPTIONS` → `204` con i permessi del preflight
  (incluso `Access-Control-Allow-Private-Network: true`).

I dati sono personali (nomi, telefoni): il server ascolta solo sul PC
dell'operatore e nessun endpoint li espone senza token.

## Cosa è verificato e cosa NO

Verificato (test automatici, senza portale):
- filtro FULL - Acquisto e parser ad ancora-Tipologia anche su righe di
  griglia sintetiche (intestazioni ripetute, righe di layout, altre
  tipologie, duplicati da più frame);
- regole della cache (nuove / già risolte / ritentativo giornaliero),
  persistenza e cache corrotta;
- ciclo del servizio con portale simulato (solo pratiche nuove, sessione
  persa a metà, elenco vuoto);
- server HTTP: health, 401, token in header e in query, formato della
  risposta, CORS e preflight;
- anonimizzazione delle catture;
- il giro classico `--dry-run` produce lo stesso output di prima.

**NON verificato sul portale reale** (nessun accesso durante lo sviluppo):
- **lettura automatica dell'elenco** (`--serve` senza file): si assume che
  l'Elenco Perizie con il filtro Cod. Immobile vuoto mostri le pratiche
  assegnate e che le colonne della griglia siano quelle dell'export Excel;
- **paginazione**: il bridge segue un controllo "pagina successiva" solo se
  ne trova esattamente uno inequivocabile (max 20 pagine), altrimenti legge
  la prima pagina e lo scrive nel log;
- il rilevamento della sessione scaduta usa lo stesso segnale del login
  (`wsTbs` presente e URL `perizie.prelios.com`).

Per questo il **primo giro va fatto sotto supervisione**:
```bash
python dump_elenco.py                         # griglia grezza in elenco_dump.json (dati in chiaro)
python dump_elenco.py --anonimo --out elenco_dump_anon.json   # versione condivisibile
python run_giro.py --serve --limit 3          # poche pratiche, controllando il log
```
Confronta il numero di pratiche nel log con quelle che vedi nel portale. Se
non tornano, usa il giro con file (`--serve elenco.xlsx`), che resta
pienamente supportato, e manda `elenco_dump_anon.json` per correggere la
mappatura.

## Cerved

**Non ancora implementato.** Il portale è registrato (`--portal cerved`) ma
il bridge si ferma con un messaggio che elenca cosa serve per costruirlo:
URL e tipo di login, struttura dell'elenco delle pratiche assegnate, scheda
pratica con i campi telefono/referente. Nessun URL, selettore o campo è
stato inventato.

Per raccogliere queste informazioni senza condividere dati personali:
```bash
python capture_portal.py --url <indirizzo del portale>
```
Si apre il Chrome dedicato; fai il login e naviga **a mano** (il tool non
clicca nulla). A ogni INVIO nel terminale viene salvata una cattura della
pagina corrente in `captures/` (esclusa da git): URL, titolo e, per il
documento e ogni frame, tabelle (intestazioni e righe campione), campi form
(id, name, etichetta) e controlli cliccabili. Scrivi un'etichetta prima di
INVIO (es. `elenco`, `dettaglio`) per riconoscerle; `q` per uscire.

Di default i testi delle celle e i valori dei campi sono **anonimizzati**
(lettere → `x`, cifre → `9`, lunghezza e punteggiatura preservate). Restano
in chiaro le intestazioni e le etichette brevi, perché sono la struttura che
serve: **dai comunque un'occhiata al file prima di condividerlo**. `--raw`
disattiva l'anonimizzazione (solo per uso locale).

## Diagnostica (se un telefono non viene trovato)
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
- File con dati personali o segreti, tutti esclusi da git: `bridge_cache.json`,
  `bridge_token.txt`, `captures/`, `elenco_dump*.json`, `campi_*.json`.

## Formato di output per OptiRoute (giro classico)

Intestazioni ESATTE, nell'ordine:

| Intestatario | Indirizzo | N.Civ. | Comune | Prov. | Telefono | Note | Codice | Esito |
|---|---|---|---|---|---|---|---|---|

`Esito` è una colonna diagnostica (OK / KO con motivo / DRY-RUN): OptiRoute
ignora le colonne che non conosce.

## Test
```bash
python test_excel_pratiche.py
python test_contact_parse.py
python test_elenco_griglia.py
python test_bridge_cache.py
python test_servizio.py
python test_bridge_server.py
python test_anonimizza.py
```
Test puri (niente portale, niente dati reali, niente pytest): filtro FULL -
Acquisto, estrazione campi, parsing telefono dalle note, anti falsi-positivi,
lettura griglia, cache, ciclo del servizio, server HTTP locale (porta
effimera su 127.0.0.1), anonimizzazione. `test_servizio.py` stampa di
proposito il traceback di una sessione scaduta simulata.
