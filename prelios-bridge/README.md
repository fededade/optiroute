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

## Avvio con un doppio clic

**La prima volta (una sola volta per PC)**
1. Installa **Python** (3.10 o più recente) da
   <https://www.python.org/downloads/>; su Windows spunta *"Add python.exe
   to PATH"* durante l'installazione. Serve anche **Google Chrome**.
2. Nella cartella del bridge fai doppio clic su **`Installa.bat`**
   (su macOS: dal Terminale `python3 installa_bridge.py`).
3. Il programma installa i componenti che mancano e ti chiede
   l'**indirizzo del gestionale**: incollalo (es.
   `https://gestionale.example/optiroute.html`) e premi Invio; lascia vuoto
   per saltare. Su Windows crea anche l'icona **"OptiRoute Bridge"** sul
   Desktop e il collegamento che permette al pulsante del gestionale di
   accendere il bridge.

**Ogni giorno**
- Doppio clic sull'icona **OptiRoute Bridge** del Desktop (oppure su
  `Avvia bridge.bat` nella cartella; su macOS `avvia-bridge.command`),
  **oppure** il pulsante per avviare il bridge nella pagina OptiRoute del
  gestionale (solo Windows: il browser chiede la conferma ad aprire
  "OptiRoute Bridge").
- Si apre una **finestra nera**: lasciala aperta, è il bridge. Con il doppio
  clic si apre anche la pagina OptiRoute del gestionale.
- Finché un amministratore del gestionale non apre la pagina OptiRoute, la
  finestra dice **"IN ATTESA DI ATTIVAZIONE"**. Appena un amministratore la
  apre, il bridge si attiva da solo, scrive chi lo ha attivato e apre il
  **Chrome del portale**: fai il login (MFA) come sempre.
- Da lì il bridge controlla il portale **ogni 15 minuti** e passa i dati a
  OptiRoute da solo.
- **Per fermarlo**: chiudi la finestra nera (oppure `Ctrl+C` e conferma).

Se il bridge è già acceso, un nuovo doppio clic lo dice (il messaggio resta
visibile qualche secondo) e non ne avvia un secondo; il pulsante del
gestionale, in quel caso, non fa nulla. Se manca un componente il lanciatore lo installa da solo (serve
Internet); se non ci riesce lo spiega e la finestra resta aperta.

## Collegamento con il gestionale

- **Chi può attivarlo**: solo un utente del gestionale con ruolo
  **Super Amministratore** o **Amministratore**. Un tecnico che apre la
  pagina non attiva nulla. Il bridge controlla il ruolo leggendo la scheda
  del personale nel gestionale con l'accesso dell'utente stesso.
- **Da dove**: solo dalle pagine degli indirizzi salvati in
  `bridge_config.json` (il browser dichiara sempre da che sito arriva la
  richiesta e non lo si può falsificare). Qualsiasi altro sito viene
  rifiutato.
- **"In attesa di attivazione"**: il bridge è acceso ma non ha ancora aperto
  il portale e non consegna dati. Si attiva alla prima apertura della pagina
  da parte di un amministratore e resta attivo finché la finestra nera
  resta aperta.
- **Il pulsante "avvia bridge" del gestionale** (solo Windows) usa il
  collegamento `optiroute-bridge://` registrato dall'installazione: Windows
  avvia direttamente Python con `avvia_bridge.py --da-gestionale`, senza
  passare dal Prompt dei comandi. Windows aggiunge in fondo l'indirizzo
  cliccato, ma il programma **non lo usa**: con `--da-gestionale` ignora
  qualunque altra cosa scritta sulla riga di comando e parte sempre con le
  impostazioni normali. Così nessun sito può far eseguire comandi o cambiare
  le impostazioni del bridge. Il pulsante accende soltanto il bridge, che
  poi va comunque attivato da un amministratore. Se il bridge si ferma per
  un errore, la finestra aspetta Invio prima di chiudersi.
- **Niente token da incollare**: quando un amministratore attiva il bridge,
  la pagina del gestionale riceve da sola la chiave di accesso ai dati.
- **Aggiungere un altro indirizzo**: rilancia `Installa.bat` e incolla il
  nuovo indirizzo (quelli già salvati restano), oppure
  `python installa_bridge.py --gestionale https://altro.example`.
- **Tornare indietro**:
  - per togliere l'icona e il collegamento col pulsante:
    `py installa_bridge.py --disinstalla` (configurazione, token e dati
    salvati restano);
  - per tornare alla modalità manuale (token incollato a mano): cancella
    `bridge_config.json`, oppure avvia con `--senza-gestionale`.

Il file `bridge_config.json` sta nella cartella del bridge, non va nel
repository (è nel `.gitignore`) e ha questa forma:
```json
{ "gestionale": ["https://gestionale.example"], "pagina": "/optiroute.html" }
```
Gli indirizzi devono essere `https://` (`http://localhost` e
`http://127.0.0.1` sono ammessi solo per le prove sul proprio PC).

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
| `Installa.bat` / `installa_bridge.py` | installazione (una volta): componenti, indirizzo del gestionale, icona e collegamento (Windows) |
| `Avvia bridge.bat` / `avvia-bridge.command` / `avvia_bridge.py` | avvio con un doppio clic (Windows / macOS) |
| `run_giro.py` | comando principale (giro classico e `--serve`) |
| `servizio.py` | modalità servizio: cicli periodici, login, consegna |
| `bridge_server.py` | server HTTP locale (contratto v1, solo 127.0.0.1) |
| `bridge_config.py` | indirizzi del gestionale (`bridge_config.json`) |
| `verifica_gestionale.py` | controllo che chi attiva sia un amministratore |
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
- `pip install selenium openpyxl` (con il doppio clic li installa da solo)
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

## Uso — modalità servizio da terminale (consegna diretta alla web app)

Per chi preferisce il terminale al doppio clic (fa la stessa cosa):

```bash
python run_giro.py --serve                       # elenco letto dal portale (best-effort)
python run_giro.py --serve elenco.xlsx           # elenco dal file, riletto a ogni ciclo
python run_giro.py --serve --port 8765 --interval 15 --portal prelios
python run_giro.py --serve --gestionale https://gestionale.example   # solo per questa volta
python run_giro.py --serve --senza-gestionale    # modalità manuale anche con bridge_config.json
python avvia_bridge.py --limit 3                 # come il doppio clic, con opzioni in più
```

- Con un gestionale configurato (`bridge_config.json` oppure
  `--gestionale URL`, ripetibile: sostituisce l'elenco del file per quella
  esecuzione) il bridge parte **in attesa di attivazione** e apre Chrome
  solo dopo l'attivazione da parte di un amministratore.
- Senza gestionale (o con `--senza-gestionale`) funziona come sempre:
  stampa il token da incollare a mano in OptiRoute e apre subito Chrome.

Giornata tipo:
1. **Al mattino** avvii il bridge: si apre il Chrome dedicato del bridge
   (in modalità gestionale, dopo l'attivazione).
2. Fai il **login Prelios con MFA** nella finestra (unico passaggio manuale).
3. Da lì il bridge lavora da solo: ogni `--interval` minuti (default **15**)
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

Al primo avvio il bridge genera un token casuale e lo salva in
`bridge_token.txt` (cartella del bridge, escluso da git).
- **Modalità manuale**: il token viene stampato nel terminale: **incollalo
  una volta** nelle impostazioni di OptiRoute.
- **Modalità gestionale**: il token NON viene stampato; la pagina del
  gestionale lo riceve da sola quando un amministratore attiva il bridge.

Il token non compare in nessun log. Per revocarlo: cancella
`bridge_token.txt` e riavvia (ne verrà generato uno nuovo).

### Contratto HTTP v1 (solo `127.0.0.1`)

- `GET /v1/health` (senza token, senza dati personali) → `200`
  `{"bridge":"optiroute-bridge","version":1,"attivazione":…,"portali":[{id,status,lastSync}],"pratiche":<numero>,"intervalloMinuti":15}`
  con `attivazione` fra `non_richiesta` (modalità manuale), `in_attesa`,
  `attivo`. Qui `portali` non contiene mai `message`.
- `POST /v1/attiva` (solo modalità gestionale) con header `Origin` (lo
  mette il browser) e `Authorization: Bearer <accesso del gestionale>`,
  corpo vuoto. Controlli, nell'ordine: modalità manuale →
  `409 {"error":"non_configurato"}`; indirizzo non autorizzato →
  `403 {"error":"origine"}`; accesso mancante, scaduto, email non
  verificata o rifiutato dal gestionale → `401 {"error":"token"}`;
  gestionale non raggiungibile → `502 {"error":"verifica"}`; utente non
  amministratore → `403 {"error":"ruolo"}`. Se tutto va bene →
  `200 {"attivo":true,"token":"<token del bridge>","utente":{"nome","ruolo"}}`.
  Ripetere l'attivazione è innocuo; con lo stesso accesso entro 5 minuti il
  gestionale non viene interrogato di nuovo.
- `GET /v1/pratiche` con header `X-Bridge-Token` (o `?token=`) → `200`
  `{bridge, version, generatedAt, portals[], pratiche[]}`; token mancante o
  errato → `401 {"error":"token"}`; in modalità gestionale prima
  dell'attivazione → `409 {"error":"non_attivo"}`.
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
- il giro classico `--dry-run` produce lo stesso output di prima;
- collegamento col gestionale: indirizzi ammessi/rifiutati, controllo
  amministratore con un gestionale simulato (admin, tecnico, email non
  verificata, accesso scaduto, progetto o emittente sbagliati, errori di
  rete), attivazione via HTTP, attesa dell'attivazione prima di aprire il
  browser, `Ctrl+C` durante l'attesa;
- avvio dal pulsante con argomenti ostili (indirizzi con `&`, opzioni
  aggiunte prima o dopo `--da-gestionale`): vengono tutti ignorati;
- installazione e lanciatore con registro di Windows e pip simulati.

**NON verificato su un PC reale**: i file `.bat` e `.command` (scritti il
più semplici possibile; tutta la logica sta nei file Python, che sono
testati), il collegamento `optiroute-bridge://` aperto da un browser vero e
la lettura del gestionale reale.

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
  `bridge_token.txt`, `captures/`, `elenco_dump*.json`, `campi_*.json`;
  escluso da git anche `bridge_config.json` (indirizzi del gestionale di
  quel PC).
- I file `.bat` devono restare con le fine riga di Windows: il file
  `.gitattributes` alla radice del repository impedisce a git di
  convertirli.

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
python test_bridge_config.py
python test_verifica_gestionale.py
python test_bridge_attivazione.py
python test_avvia_bridge.py
python test_installa_bridge.py
```
Test puri (niente portale, niente dati reali, niente rete esterna, niente
pytest): filtro FULL - Acquisto, estrazione campi, parsing telefono dalle
note, anti falsi-positivi, lettura griglia, cache, ciclo del servizio,
server HTTP locale (porta effimera su 127.0.0.1), anonimizzazione,
collegamento col gestionale (gestionale simulato), lanciatore e
installazione (registro di Windows simulato). `test_servizio.py` stampa di
proposito il traceback di una sessione scaduta simulata.
