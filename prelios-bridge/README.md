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
   (**best-effort, da verificare**: vedi sotto). Dall'elenco legge anche lo
   **stato** di ogni perizia (sopralluogo fissato, fatto, chiusa, sospesa:
   vedi «Stato delle perizie sul portale»).
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
| `stato_portale.py` | stato di ogni perizia sul portale (fase, date, nota di sospensione) |
| `contact_parse.py` | estrazione telefono/referente dalle note |
| `anonimizza.py` | anonimizzazione delle catture (lettere→x, cifre→9) |
| `dump_perizia_fields.py` | diagnostico (mappa i campi di una perizia) |
| `dump_elenco.py` | diagnostico (struttura grezza della griglia Elenco Perizie) |
| `struttura_elenco.py` | descrizione anonima dell'elenco del portale (`elenco_struttura.json`) |
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
python run_giro.py --serve --max-righe 500       # «Max Righe» dell'elenco (default 200; 0 = non toccarlo)
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
  (stato `error`, da controllare con `dump_elenco.py`);
- le pratiche che sul portale hanno il sopralluogo **già fissato**, **già
  fatto** o sono **chiuse** NON vengono aperte (non verranno programmate);
  se più avanti tornano da fissare o sospese, si aprono allora;
- per le **sospese**, oltre al telefono si legge la nota di sospensione
  (pagina «Sospesi» della perizia). La nota si rilegge quando cambia la
  data di sospensione o dopo 24 ore, al massimo 10 riletture per ciclo
  (prima i telefoni mancanti, poi le note);
- una perizia **sospesa** arriva a OptiRoute solo **dopo il primo
  tentativo di lettura della sua nota** (riuscito o no): così non compare
  prima "senza nota" e poi "con la nota". Quelle non ancora tentate (oltre
  il limite di 10) compaiono al ciclo dopo; il log dice quante sono in
  attesa;
- nei messaggi della finestra il numero della perizia si scrive con il
  puntino (`844.787`), come sul portale; nei dati consegnati a OptiRoute e
  nella cache resta com'è.

### Stato delle perizie sul portale

Dall'elenco il bridge legge, **per nome della colonna** (non per posizione),
le colonne Conclusa, Sopralluogo, Valutata, Sospesa, Revoca, Sospensione e
Inoltrata Perizia e l'**icona di stato** della colonna «VT»: il nome del
file dell'immagine è il codice dello stato (`EL.gif` → `EL`). Per ogni
pratica calcola la `fase`, con queste regole in ordine:

| # | fase | quando |
|---|---|---|
| 1 | `chiusa` | icona `EL` (eliminata), `AB` (abbandonata), `IR` (incarico rifiutato), `IP` (perizia inoltrata) o `PI` (perizia inviata), qualunque data ci sia |
| 2 | `chiusa` | Conclusa, Inoltrata Perizia o Revoca non vuote |
| 2 | `effettuato` | icona `VT` (valutata) o `PR` (perizia riaperta), oppure Valutata non vuota, oppure Sopralluogo con una data passata |
| 2 | `fissato` | Sopralluogo con la data di oggi o futura |
| 3 | `sospesa` | icona `SP`, oppure la perizia è fra le **sospese adesso** (vedi sotto) |
| 4 | `da_fissare` | icona `IN` (incarico accettato) o `AT` |
| 5 | — | icona con un altro codice e nessuna data: la perizia **NON viene consegnata a OptiRoute** né aperta sul portale |
| 6 | come prima | icona non leggibile: date, poi sospese adesso, altrimenti `da_fissare` |

**Da programmare** sono quindi solo le perizie `da_fissare` (icona `IN` o
`AT`) e `sospesa`. Le eliminate non finiscono più fra quelle da fissare.
Le perizie in uno stato già consegnato o chiuso (`IP`, `PI`, `VT`, `PR`)
vengono consegnate come **non da programmare**: chi le aveva già
importate in OptiRoute le vede uscire dal giro. Il significato di questi
codici viene dai conteggi del primo giro vero: le 139 icone `IP` sono
esattamente le righe con la data «Inoltrata Perizia», e `IP` + `PI` (152)
sono esattamente le righe con la data «Conclusa». Le perizie della regola
5 (un codice mai visto) sono contate per codice nel log, per esempio
`3 perizie non pubblicate perché in uno stato che non conosco (XX: 2,
ZZ: 1)`. I codici stanno tutti in un punto solo, `CODICI_ICONA` in
`stato_portale.py`, con la fonte di ognuno. Se per una riga l'icona non si
legge (portale cambiato), per quella vale la regola di prima e compare
UNA riga di avviso nel log per ciclo. Gli elenchi da file (Excel/TSV) non
hanno icone: per loro vale la regola di prima.

**Sospese adesso**: una data nella colonna «Sospensione» non basta (la
perizia può essere stata riattivata). Dopo la lettura normale il bridge fa
una **seconda ricerca** con «Stato Perizia» = la voce che contiene
«sospes» (se ce n'è esattamente una), legge le righe e rimette il menu
vuoto. Le sospese trovate così che non stanno fra le perizie più recenti
vengono aggiunte all'elenco. Se la seconda ricerca non è possibile, il
bridge lo scrive nel log e ripiega sulla colonna «Sospensione» non vuota.

Prima della ricerca il bridge porta «Max Righe» a 200 (`--max-righe`):
il portale mostra solo le perizie più recenti fino a quel numero. Se
«Trovati» è maggiore delle righe lette lo scrive nel log. I numeri di
pagina NON vengono cliccati (sono solo descritti in `elenco_struttura.json`).

Dopo ogni lettura, nella finestra del bridge compare una riga di soli
conteggi, per esempio: `Stato sul portale: 4 con sopralluogo fissato, 5 già
fatte o chiuse, 6 sospese, 0 da fissare, 3 non pubblicate (stato non
riconosciuto)` (l'ultima parte solo per l'elenco letto dal portale). Se
le intestazioni non si trovano o manca una di quelle colonne, lo scrive
nel log e le pratiche restano
senza stato (comportamento di prima). Vale anche per gli elenchi da file
(Excel/TSV) se hanno quelle intestazioni (lì senza seconda ricerca: vale la
colonna «Sospensione»).

**Nota di sospensione**: per le sospese, dopo l'Anagrafica il bridge va
alla pagina «Sospesi» della perizia. Le voci del menu della perizia sono
campi usati come pulsanti: il bridge clicca SOLO quello il cui comando
contiene esattamente il codice di pagina `Anpl_Immobili_Sospesi_ISP`; se
non c'è, fa la stessa navigazione con la chiamata diretta
`wsTbs.Url('Anpl_Immobili_Sospesi_ISP',…)` (come per l'Anagrafica). Non
cerca nulla per testo. Prima del clic ricontrolla che il comando non
contenga nessuno dei comandi che **cambiano lo stato della perizia** o
salvano: «Attiva» (`Anpl_Immobili_Riattiva_ISP`), i pulsanti di stato
(`wsStatoValutazioneButtons…`: «Sospesa», «Riattiva», «Inoltra Perizia»,
«Conclusa», «Abbandona», «Accetta», «Rifiuta»…), «Salva»
(`cmdSaveClick`), «Canc.» (`cmdCancelClick`): quelli non vengono MAI
cliccati, e nei campi non viene scritto niente. Poi aspetta la griglia
(riga di intestazione con «Data», «Note» e «Stato Perizia»; le righe sono
tutte quelle della pagina con lo stesso numero di celle, anche se stanno
in un'altra tabella) e ne legge SOLO le colonne «Data» e «Note»: la nota è quella della riga più
recente, preceduta dal «Motivo Sospensione» scelto. Cognome, nome,
cellulare ed email di chi ha sospeso non vengono letti. Se la nota più
recente dice «sopralluogo fissato» con una data e la colonna Sopralluogo è
vuota, la pratica vale `fissato` con quella data. Se la pagina non si apre
o la griglia non compare, la nota resta vuota e compare UNA riga nel log
per ciclo, che dice come si è arrivati alla pagina (clic o chiamata
diretta) e cosa non si è trovato.

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
    ancora lavorate (`esito: "IN ATTESA"`, telefono vuoto). Solo quando
    noti, in più: `stato` (testo, es. «Sopralluogo fissato per il
    20/11/2026»), `fase` (`da_fissare | fissato | effettuato | sospesa |
    chiusa`), `dataSopralluogo` (`AAAA-MM-GG`) e, solo con `fase: "sospesa"`,
    `sospensione: {"nota": "...", "dal": "AAAA-MM-GG"}` (`dal` può mancare).
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
- descrizione anonima dell'elenco (`elenco_struttura.json`): categorie,
  intestazioni, filtri e controllo finale su griglie e pagine simulate
  (nessun nome, indirizzo, telefono, codice, data o nota nel file);
- stato delle perizie: tabella delle fasi, date non valide, intestazioni in
  ordine diverso o mancanti, seconda ricerca delle sospese e «Max Righe» su
  un portale simulato, nota dalla pagina «Sospesi» simulata (i dati di chi
  ha sospeso non finiscono mai in log, cache, snapshot o descrizione),
  regola "quali aprire", riletture della nota, cache vecchia che si carica;
- icona di stato «VT»: tutti i rami della regola con i codici (e le
  precedenze `EL` > date > `SP` > `IN`), codici sconosciuti non consegnati
  e contati, icona mancante con la regola di prima, sospese consegnate solo
  dopo il primo tentativo di lettura della nota, numero col puntino nei
  messaggi;
- gli script JavaScript nuovi sono stati eseguiti in un Chromium vero su
  pagine finte, fuori dal repository: elenco con le 32 colonne vere e le
  icone (`SP.gif`, `EL.gif`, `IN.gif`…, anche con la colonna «VT» spostata
  o l'intestazione in una tabella a parte), pagina della perizia con le
  voci del menu vere (testi e comandi presi dalla descrizione anonima del
  portale): viene cliccato solo «Sospesi», mai «Attiva», «Sospesa»,
  «Riattiva», «Salva», «Canc.», nemmeno con comandi-trappola; pagina
  «Sospesi»;
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
- **descrizione dell'elenco** (`elenco_struttura.json`): la lettura di
  filtri e intestazioni della pagina è provata solo su pagine simulate;
- **paginazione**: il bridge segue un controllo "pagina successiva" solo se
  ne trova esattamente uno inequivocabile (max 20 pagine), altrimenti legge
  la prima pagina e lo scrive nel log; i numeri di pagina («- 1 2 3 … 15
  +») non vengono cliccati;
- **«Max Righe»** (`PageSize`): che il portale accetti il valore scritto
  dal bridge (con gli eventi change/blur) prima di `cmdFindClick()`;
- **seconda ricerca delle sospese**: la scelta in «Stato Perizia» della
  voce che contiene «sospes», l'attesa della griglia nuova e il ritorno del
  menu al valore vuoto;
- **pagina «Sospesi»**: che il clic sulla voce (o la chiamata diretta)
  apra davvero la pagina, l'attesa della griglia e la lettura di «Data» e
  «Note». La voce e il suo comando sono quelli veri (dalla descrizione
  anonima), ma la griglia è scritta dal video del portale e provata solo su
  pagine finte in un Chromium vero (anche con la testata in una tabella e
  le righe in un'altra, come fa la griglia dell'elenco). Il primo giro vero dirà, in
  `elenco_struttura.json` (`stato_portale.lettura_nota`), come si è
  arrivati alla pagina e se la griglia è comparsa;
- **icona di stato «VT»**: i nomi dei file (`EL.gif`, `SP.gif`…) e le
  intestazioni sono quelli veri, ma la lettura dell'icona è provata solo su
  pagine finte; il significato di `AB`, `IR` e `AT` è dedotto dai comandi
  del portale (mai visti come icona) e quello di `IP`, `PI`, `VT`, `PR` dai
  conteggi delle colonne di data del primo giro (non da un elenco ufficiale
  del portale);
- le altre **colonne a icona** («App 1/2/3», «Sospesa», «Revoca»): il
  bridge non le usa per lo stato; ne descrive solo il contenuto (immagini,
  chiamate) in `elenco_struttura.json`;
- l'ipotesi che la regola delle fasi corrisponda a come il portale usa le
  colonne di data;
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

## Com'è fatto l'elenco del portale (file elenco_struttura.json)

Ogni volta che il bridge legge l'elenco delle pratiche dal portale scrive
anche, nella sua cartella, il file **`elenco_struttura.json`** (riscritto a
ogni lettura, non serve fare niente). È una **descrizione della pagina**,
non dei clienti:

- quando è stato letto e quante righe, quante con una tipologia, quante
  pratiche FULL - Acquisto, quante pagine;
- i **filtri** della pagina (nome del campo, se è vuoto o no, per i menu a
  tendina le voci e quella scelta, per le caselle se sono spuntate) — mai
  quello che c'è scritto dentro un campo;
- i **titoli delle colonne**, se il bridge li riconosce con sicurezza;
- per ogni **colonna**: quanti valori diversi, quanti vuoti, la lunghezza
  massima e la "forma" dei valori (lettere → `x`, cifre → `9`: un nome
  diventa `xxxxx xxxxx`, una data `99/99/9999`);
- per le sole colonne di **stato/categoria** (pochi valori brevi e
  ripetuti, senza numeri lunghi né date) i valori in chiaro con quante
  pratiche ne hanno ciascuno: è da qui che si capisce, per esempio, quali
  pratiche hanno già il sopralluogo fissato o fatto;
- per ogni colonna, cosa c'è nelle celle **oltre al testo** (immagini con
  nome del file/alt/title se pochi, caselle, link, sfondi, chiamate
  `onclick` con i numeri lunghi mascherati): serve per le colonne a icona
  come «VT», «App 1/2/3» e «Sospesa»;
- per il menu **«Stato Perizia»** le voci in chiaro; i numeri di
  «Trovati» e «Max Righe»; i **link delle pagine** (solo descritti);
- come è stato deciso chi è **sospeso** (seconda ricerca o ripiego sulla
  colonna) con i conteggi per fase;
- i **codici dell'icona «VT»** trovati con i conteggi, quante perizie non
  sono state consegnate per codice, quante senza icona leggibile; per la
  **nota di sospensione** del ciclo: quanti tentativi, come si è arrivati
  alla pagina «Sospesi» (clic o chiamata diretta) e se la griglia è
  comparsa (mai i testi delle note);
- la sezione **`perizia`**: com'è fatta la pagina Anagrafica di una
  perizia e, se raggiunta, la pagina «Sospesi» (campi senza valori,
  intestazioni delle tabelle, comandi del menu con la chiamata completa e
  i numeri lunghi mascherati). Se nel ciclo non si apre nessuna perizia, il
  bridge ne apre una (sospesa o da fissare) solo per descriverla, una volta
  per avvio.

**Non contiene dati dei clienti**: nomi, indirizzi, comuni, telefoni,
email, codici, date e note non vengono mai scritti in chiaro. Prima di
salvare, il bridge ricontrolla il file e, se trovasse anche solo una
chiocciola, un numero di 6 o più cifre o un nome/indirizzo/telefono delle
pratiche, **non lo salva** e lo scrive nella finestra del bridge.

Nella finestra del bridge, dopo ogni lettura, compare una riga come:
`Elenco letto: 15 pratiche FULL - Acquisto su 42 righe (descrizione
dell'elenco salvata in elenco_struttura.json, senza dati dei clienti)`.

**Quando mandarlo**: se l'elenco che arriva in OptiRoute non è quello che ti
aspetti (pratiche in più o in meno, pratiche già chiuse, sospese sbagliate,
nota di sospensione vuota — riga «nota di sospensione non letta» nel log),
lascia girare il bridge per un ciclo intero (così il file contiene anche la
sezione `perizia`) e poi manda allo
sviluppatore il file `elenco_struttura.json` che trovi nella cartella del
bridge: serve a capire quali filtri e quali stati usa il portale. Il file
non va nel repository (escluso da git).

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
  escluso da git anche `elenco_struttura.json` (non ha dati dei clienti,
  ma è un file del singolo PC);
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
python test_struttura_elenco.py
python test_stato_portale.py
python test_icona_stato.py
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
