# OptiRoute

Gestione e ottimizzazione degli appuntamenti di sopralluogo su mappa, **multi-tecnico**: inserimento rapido o completo (cliente, telefono, note, durata, urgenza), import/export Excel, smistamento automatico delle pratiche per zona di competenza con proposta di data/orario, calcolo del percorso ottimale con orari reali di viaggio e **chiamata AI di conferma al cliente tramite Retell AI**.

## Avvio locale

```bash
npm install
npm run dev
```

Build di produzione: `npm run build` (deploy pensato per Vercel, incluse le funzioni in `api/`).
Test: `npm test` (servizi di pianificazione, pilota automatico, script e esiti delle chiamate).

Prove nel browser: `npm run test:e2e` guida l'app vera con Playwright (cartella `e2e/`): pilota
automatico, client del cloud, prova "a browser chiuso" sui bundle veri delle funzioni, due
schede insieme e il giro di tutte le finestre a 1440 e 390 px. Mappe, geocodifica, Retell e
bridge sono simulati: non esce nessuna richiesta verso servizi veri e non parte nessuna
telefonata. Serve Playwright con Chromium (nelle sessioni cloud di Claude Code c'è già; in
locale `npm i -D playwright` e `npx playwright install chromium`). Dettagli in testa a
`e2e/run-all.sh`.

## Pilota automatico: dal portale alla chiamata

Obiettivo: l'operatore interviene il meno possibile e il giro non resta mai con un buco.

1. **Le pratiche arrivano da sole.** Il bridge dei portali (`prelios-bridge/`, modalità
   `--serve`) gira sul PC dell'operatore: dopo il login al portale (l'MFA resta manuale)
   legge le pratiche assegnate, recupera i telefoni e li espone all'app su
   `http://127.0.0.1:8765`. L'app le scarica ogni 5 minuti, le geocodifica e assegna il
   tecnico. L'import da Excel resta disponibile.
2. **I giri si formano da soli.** Le pratiche in attesa con telefono vengono smistate in giri
   proposti, inserite negli spazi liberi dei giri esistenti senza mai spostare l'orario di
   una tappa già fissata. Le date che un cliente ha rifiutato non gli vengono riproposte.
3. **L'operatore approva il giro**: un clic su "Approva e chiama" nella sezione Proposte (per giro o per tutti).
4. **Il pilota chiama.** Dentro la fascia oraria impostata chiama i clienti uno alla volta.
   - Se il cliente **non può**, l'agente gli offre subito fino a 3 **slot alternativi reali**
     (già verificati sull'agenda del tecnico); se ne accetta uno la pratica viene spostata
     e confermata da sola.
   - Se **rifiuta, rimanda o risulta irreperibile**, lo slot liberato viene **riempito**
     con un'altra pratica (in attesa, o anticipata da un giorno successivo), che viene
     chiamata a sua volta.
   - Chi **non risponde** viene richiamato (di default dopo 2 ore, fino a 3 tentativi,
     e mai a ridosso dell'appuntamento).
5. **Solo le eccezioni arrivano all'operatore**, nella sezione "Da gestire": esiti non
   chiari, numeri errati, irreperibili, rifiuti, pratiche senza telefono o senza tecnico.

Si accende dalla striscia del pilota in cima alla pagina (bottone "Attiva"); dall'ingranaggio si regolano fascia
chiamate, tentativi, alternative, rimpiazzi, anticipo minimo, smistamento automatico e
bridge (indirizzo e token, stampato dal bridge al primo avvio). L'opzione "Chiama senza
approvazione" salta il punto 3: è spenta di default.

Da sapere:
- Senza il cloud il pilota lavora **finché l'app è aperta in una scheda del browser**
  (anche in secondo piano). Con il cloud attivo (sezione sotto) chiamate, richiami, esiti
  e rimpiazzi proseguono anche a browser chiuso. Con più schede aperte gli automatismi
  girano in una sola, per non chiamare due volte lo stesso cliente.
- Alternative e rimpiazzi valgono **dal giorno dopo**: il giro di oggi non viene toccato,
  perché il tecnico è già in strada. L'opzione "Consenti cambi per il giorno stesso" lo
  permette (con l'anticipo minimo), per chi segue il giro in tempo reale.
- A pilota spento l'app funziona come prima: smistamento e chiamate si avviano a mano.
- Per leggere il bridge locale da un sito https serve Chrome o Edge (al primo accesso il
  browser chiede il permesso di raggiungere la rete locale).
- Sull'agente Retell è consigliato aggiungere il campo di analisi `alternativa_scelta`
  (vedi sotto).
- Gli orari proposti sono arrotondati ai 5 minuti.

## Pilota in cloud: anche a browser chiuso

Di base pratiche e pilota vivono nel browser. Attivando il cloud passano sul server
(Vercel): il motore continua a chiamare, richiamare, applicare gli esiti e riempire gli slot
liberati anche con il PC spento, e gli stessi dati si vedono da più computer.

**Attivazione (una volta sola)**

1. **Database**: su Vercel, nel progetto, scheda *Storage* → crea un database **Upstash
   Redis** (piano gratuito) e collegalo al progetto. Scegli una regione europea: conterrà
   nomi e telefoni dei clienti.
2. **Chiave**: in *Settings → Environment Variables* aggiungi `CRON_SECRET` con una chiave
   casuale lunga (almeno 32 caratteri, solo lettere e numeri), per Production e Preview.
3. **Nuovo deploy** (le variabili valgono dal deploy successivo).
4. **Nell'app**: ⚙ del pilota → sezione *Cloud* → incolla la chiave → "Prova collegamento"
   (controlla chiave, database, Retell, fuso orario, scheduler) → "Attiva il cloud su
   questo browser". Il primo browser carica le sue pratiche; gli altri, inserita la chiave,
   le ritrovano.
5. **Facoltativo ma consigliato**: in Retell imposta come webhook l'indirizzo mostrato
   nella stessa sezione. Così a fine chiamata il motore viene avvisato subito, invece di
   aspettare il passaggio successivo.

**Come lavora**

- Lo scheduler di Vercel sveglia il motore **ogni 15 minuti** fra le 7 e le 21 (ora
  italiana), con un ritardo che sul piano gratuito può arrivare a 15 minuti; è la
  frequenza massima di quel piano, con un piano Pro si può scendere modificando
  `schedules` in `vercel.json`. A browser aperto l'app chiede un passaggio ogni
  30 secondi, quindi tutto resta immediato.
- **In produzione lo scheduler parte acceso. Sulle anteprime (Preview) Vercel lo crea
  spento**, perché un ramo di prova non faccia partire lavori veri per sbaglio: lì il
  pilota avanza solo a browser aperto finché non lo accendi da Vercel → *Schedules* →
  *Environment: Preview* → il ramo → `pilota-automatico` → menu accanto a *Run Schedule*
  → *Enable* (o *Enable for 24 Hours*). *Run Schedule* fa un passaggio subito e nella
  cronologia si vede se è andato a buon fine. La sezione Cloud dell'app lo ricorda quando
  rileva di essere su un'anteprima.
- Il motore è lo stesso del browser (stessi riduttori, stessi test). Ogni scrittura è
  protetta: una pratica non può essere chiamata due volte e una modifica dell'operatore
  arrivata nel mezzo non va persa.
- Restano nel browser lo smistamento automatico e l'arrivo delle pratiche dal bridge
  (girano su un solo dispositivo alla volta).
- L'invio dei confermati al gestionale resta al browser, quando è aperto. Per farlo anche
  dal server (al massimo una volta l'ora) aggiungi su Vercel le variabili
  `GESTIONALE_PROJECT_ID` e `GESTIONALE_API_KEY`: nel codice del server non ci sono chiavi.
- "Pausa" ferma i lanci anche sul cloud. "Scollega questo browser" riporta quel browser ai
  soli dati locali, con il pilota locale spento: il motore sul cloud continua.

**Sicurezza**

- Un'unica chiave (`CRON_SECRET`): la usano lo scheduler e l'app, viaggia solo nelle
  intestazioni. Quando è impostata, anche le API delle chiamate (`/api/retell-call`,
  `/api/call-status`) la richiedono: prima chiunque conoscesse l'indirizzo poteva far
  partire telefonate.
- I dati di produzione e quelli delle anteprime (preview) sono separati.
- Nei log del server non finiscono nomi, telefoni o indirizzi.

**Per chi sviluppa**

- Sorgenti in `server/`; le due funzioni `api/cloud.js` e `api/cloud-tick.js` sono bundle
  generati da `npm run build:api` (su Vercel gli import fra file TypeScript non sono
  affidabili) e vanno committati: un test fallisce se non corrispondono ai sorgenti.
- `npm run dev:cloud` avvia un server locale con archivio in memoria e Retell finto per le
  prove (istruzioni in testa a `scripts/dev-cloud-server.mjs`).
- I test non possono raggiungere servizi veri: ogni richiesta di rete non locale è bloccata.

**Non ancora verificato dal vivo**: Upstash e Vercel reali (compreso lo scheduler, che su
Vercel è un servizio in beta) e i webhook di Retell. La sezione Cloud dell'app mostra se
ogni pezzo risponde.

## Interfaccia

- **Navigazione a sinistra**, una sezione per ogni momento del lavoro, ciascuna col suo
  conteggio: *Panoramica* (numeri del giorno e prossimi giri), *Tutte le pratiche*,
  *Da gestire* (solo ciò che richiede una decisione), *In attesa*, *Proposte*, *Agenda*
  (giorno, settimana, mese), *Problemi*, *Archivio*; in fondo *Tecnici* e *Impostazioni*.
- **Barra in alto**: ricerca, filtro per tecnico e i menu *Importa* (Excel, Google My Maps,
  bridge), *Pianifica* (smista per zona, ottimizza il giro), *Esporta* (Excel, report,
  gestionale), più *Nuova pratica*.
- **Striscia del pilota** sotto la barra: stato, chiamate in coda e in corso, prossima
  chiamata, stato di cloud e bridge, Attiva/Pausa e impostazioni.
- **Tutte le pratiche** è la tabella completa: stato, cliente, indirizzo, codice e
  committente, tecnico, appuntamento, telefono (o "manca") ed esito dell'ultima chiamata.
  Si filtra per stato, si ordina per colonna, e ogni riga ha le stesse azioni della scheda.
- **La ricerca cerca ovunque**: nome, indirizzo, comune, codice, telefono, note; i
  risultati arrivano da tutte le sezioni. `/` oppure Ctrl/⌘+K portano nel campo, Esc lo
  svuota.
- **Scheda della pratica**: un'azione principale in evidenza (Conferma, Chiama, Modifica…
  secondo lo stato) e le altre nel menu "Altre azioni". Nei giri le tappe stanno su una
  linea del tempo con orari e tragitti; si riordinano trascinandole.
- **Mappa a fianco**, con i livelli da mostrare per stato; si può nascondere o allargare
  trascinando il divisore. Selezionando una pratica la mappa si sposta per mostrarla.
  "Esporta Excel" e "Invia report" esportano le pratiche mostrate in quel momento.
- Su tablet e telefono la navigazione diventa un menu a scomparsa e la mappa si apre sopra
  l'elenco.

## Funzionalità principali

- **Tecnici multipli e zone di competenza** (voce "Tecnici" della navigazione)
  - Ogni tecnico ha una *scheda* con: zone di competenza (province e/o comuni entro un raggio in km), **punto di partenza**, **orario di partenza**, fine giornata e **indisponibilità** (giorni interi o fasce orarie).
  - Preconfigurati: *Omar Afifi* (province di Milano e Novara) e *Federica Sala* (provincia di Pavia, comuni attorno a Stradella/Broni/Varzi entro 15 km). Tutto modificabile dalla scheda.
  - Le pratiche nuove o importate vengono **assegnate automaticamente** al tecnico competente (per provincia da Excel/geocoding, o per raggio dalle zone); assegnazione modificabile a mano dal form di modifica.
  - Il filtro "Tutti i tecnici" nella barra in alto restringe elenchi e mappa a un tecnico; i colori di segnaposto e percorsi corrispondono al tecnico.
- **Smistamento automatico ("Smista pratiche per zona")**: le pratiche in attesa vengono distribuite sui prossimi giorni per ogni tecnico, con **data e orario ipotizzati** (rispettando orari, indisponibilità e punto di partenza di ciascuno). Se un giorno ha già tappe, le nuove si inseriscono negli spazi liberi senza toccare gli orari esistenti. Le proposte compaiono nella sezione "Proposte": l'operatore conferma singolarmente o per giornata intera, oppure rifiuta.
- **Tag "Urgente"** su ogni pratica (checkbox nel form, colonna `Urgente` in import): badge rosso in lista e mappa, priorità nello smistamento (pianificate per prime nei primi giorni utili) e **annuncio esplicito dell'urgenza nella chiamata AI**.
- **Inserimento appuntamenti**
  - *Aggiunta rapida*: nella sezione "In attesa" digita un indirizzo e premi "Aggiungi" (opzionale pulizia AI con Gemini).
  - *Inserimento completo*: bottone "Nuova pratica" in alto a destra per cliente, telefono, indirizzo, note, durata, urgenza e tecnico.
  - *Modifica*: voce "Modifica" su qualsiasi pratica (azione principale o menu "Altre azioni").
  - *Import Excel*: colonne supportate `Intestatario`, `Indirizzo`, `N.Civ.`, `Comune`, `Prov.` e in più `Telefono` (o `Tel`/`Cellulare`), `Note` e `Urgente` (sì/x/1).
  - *Import da Google My Maps* (menu "Importa" → "Google My Maps", file `.kmz`/`.kml`): ogni **livello** della mappa viene mappato su una destinazione (confermate con data, in attesa, stand-by, categorie problematiche, annullate) con proposta automatica dal nome del livello (es. "9/07" → confermate al 9 luglio, "annullate" → archivio). Dalle schede vengono estratti intestatari, telefono, riferimento pratica (ISP/CER/…), note, orario ("ore 9:00") e tecnico ("slp Federica"); niente geocoding, le coordinate arrivano dal file. I duplicati vengono saltati.
- **Riordino del giro con drag & drop**: in vista Giorno tieni premuto il clic su una scheda confermata e trascinala su un'altra tappa dello stesso tecnico: sequenza, orari e percorso in mappa si ricalcolano subito.
- **Categorie problematiche**: ogni pratica può essere smistata in *Numeri non corretti*, *Da richiamare*, *Lavori da ultimare* (sezione "Problemi"), oppure segnata *Annullata* (sezione "Archivio"). Ci si arriva dal form di modifica, in automatico dall'import Maps, oppure **direttamente dalla finestra di chiamata** ("Registra esito della telefonata": un clic per numero errato, da richiamare o lavori da ultimare, con data di rientro). Con **data di rientro** (richiamo concordato / fine lavori): dal giorno prima compare l'avviso **"Slot da riservare"** nella sezione "Da gestire", con azione rapida "Rimetti in attesa"; lo smistamento automatico dà priorità alle pratiche rientrate e **non propone mai date precedenti al rientro**.
- **Persistenza locale**: appuntamenti, tecnici, base di partenza e orari di lavoro sopravvivono al refresh (localStorage).
- **Ottimizzazione**: percorso "furthest first", orari con traffico (Google Directions con fallback OSRM), pausa pranzo automatica, durata personalizzabile per appuntamento. Con un tecnico selezionato, "Ottimizza" usa base, orari e indisponibilità della sua scheda. Le tratte già calcolate sono in cache: ri-ottimizzare o scambiare l'ordine è quasi istantaneo.
- **Chiamata AI di conferma (Retell)**: alla conferma di un appuntamento con numero di telefono si apre la finestra di chiamata; puoi anche avviarla in ogni momento con "Chiama" sulla scheda della pratica o dal popup sulla mappa, oppure in blocco con "Chiama tutte" sulle proposte smistate. L'operatore AI riceve tutti i dati dell'appuntamento (cliente, data, orario, indirizzo, note, tecnico) e, per le pratiche urgenti, **dichiara esplicitamente l'urgenza durante la chiamata**. A fine conversazione **l'esito torna nell'app e aggiorna da solo lo stato della pratica** (confermata, da riprogrammare, non risponde: vedi sezione dedicata).

## Configurazione chiamate AI (Retell)

1. Crea un account su [Retell AI](https://www.retellai.com) e acquista/importa un numero in uscita.
2. Crea un agente vocale (lingua: italiano) e associalo al numero per le chiamate outbound.
3. Nel prompt dell'agente puoi usare le variabili dinamiche inviate da OptiRoute:
   - `{{call_script}}` — script completo già pronto (saluto, presentazione, dati appuntamento, eventuale avviso di urgenza, richiesta di conferma). Il prompt minimo dell'agente può essere semplicemente: *"Segui queste istruzioni: {{call_script}}"*.
   - Oppure le variabili singole: `{{company_name}}`, `{{client_name}}`, `{{appointment_date}}`, `{{appointment_time}}`, `{{appointment_time_spoken}}`, `{{appointment_end_time}}`, `{{appointment_address}}`, `{{appointment_notes}}`, `{{appointment_urgent}}` ("URGENTE"/"normale"), `{{urgency_notice}}` (frase pronta sull'urgenza, vuota se non urgente), `{{technician_name}}` (chi effettuerà il sopralluogo), `{{alternative_disponibili}}` (slot alternativi in testo parlato, uno per riga; vuota se non ce ne sono), `{{alternativa_a}}`, `{{alternativa_b}}`, `{{alternativa_c}}` (singolo slot parlato o vuota), `{{ha_alternative}}` ("si"/"no").
   - **Slot alternativi in chiamata**: OptiRoute invia fino a 3 slot alternativi già verificati sull'agenda del tecnico. Se il cliente non può nello slot proposto, l'agente li offre uno alla volta e, se ne accetta uno, lo fissa in chiamata (sono le uniche disponibilità che può offrire: non ne inventa altre); l'app poi sposta la pratica da sola. Se nessuno va bene, prende nota della preferenza come prima.
4. Su Vercel (Settings → Environment Variables) imposta:
   - `RETELL_API_KEY` — API key Retell
   - `RETELL_FROM_NUMBER` — numero in uscita in formato E.164 (es. `+39...`)
   - `RETELL_AGENT_ID` — (opzionale) per forzare un agente specifico
   - `RETELL_COMPANY_NAME` — nome della società che chiama (default "Effetre Properties")
   - `RETELL_AGENT_NAME` — nome dell'operatrice AI (default "Misi")
   - `RETELL_MANDANTE` — mandante citato nella presentazione ufficiale (default
     "Prelios - Banca Intesa"): l'apertura è sempre "sono {nome} di {società}, incaricata
     per conto di {mandante} per la perizia relativa all'immobile di ..." — così la
     presentazione è coerente in ogni chiamata

I numeri italiani senza prefisso internazionale vengono normalizzati automaticamente a `+39`.

### Esito automatico della chiamata → stato della pratica

Dopo l'avvio di una chiamata l'app interroga Retell (`api/call-status.ts`, polling ogni ~12
secondi; anche riaprendo l'app più tardi l'esito viene comunque recuperato) e quando la
conversazione è conclusa e analizzata **applica da sola l'esito alla pratica**:

| Esito conversazione | Effetto sulla pratica |
|---|---|
| Confermato | La proposta passa in **Confermate** (data/orario mantenuti) + badge "✅ Confermato dal cliente" |
| Accetta uno slot alternativo offerto in chiamata | La pratica viene spostata sullo slot accettato e passa in **Confermate** (se nel frattempo lo slot non è più libero: da riprogrammare) |
| Chiede un'altra data | Torna **In Attesa** con la richiesta del cliente nelle note + badge "🔁 Da riprogrammare" |
| Da richiamare | Passa in 📆 **Problematiche · Da richiamare**, con la data indicata come rientro (alert + vincoli smistamento) |
| Numero errato | **Problemi · Numeri non corretti** (anche quando Retell segnala numero non componibile) |
| Lavori non ultimati | 🚧 **Problematiche · Lavori da ultimare**, con la data fine lavori come rientro |
| Annullato | Pratica **Annullata** (archivio) |
| Rifiutato | Passa in **Stand-by** + nota |
| Indica un altro referente | Il telefono viene sostituito con quello del referente e la pratica torna in coda chiamate (la nuova chiamata si presenta "per conto di...") |
| Non risponde / segreteria | Stato invariato + indicazione "Non risponde · da richiamare" sulla scheda |
| Esito non chiaro | Stato invariato + badge "❓ Esito da verificare" (riassunto AI nel tooltip) |

**Configurazione necessaria sull'agente Retell** (Dashboard → Agent → *Post-Call Analysis*),
aggiungi questi campi custom:

1. `esito_appuntamento` — tipo *Selector*, opzioni esatte:
   `confermato`, `riprogrammare`, `da_richiamare`, `numero_errato`, `lavori_non_ultimati`,
   `annullato`, `rifiutato`, `altro_referente`, `non_risposto`
   - descrizione suggerita: *"Esito della chiamata di conferma del sopralluogo"*
   - (per compatibilità è accettato anche il vecchio nome `esito_chiamata`)
2. `data_rientro` — tipo *Text* — *"Se il cliente ha indicato quando richiamarlo o quando i
   lavori saranno finiti: AAAA-MM-GG (accettato anche GG/MM); altrimenti vuoto"*
3. `nuova_data_richiesta` e `nuovo_orario_richiesto` — tipo *Text* — data/orario preferiti se
   chiede di riprogrammare (testo libero)
4. `nuovo_referente_nome`, `nuovo_referente_telefono`, `nuovo_referente_ruolo` — tipo *Text* —
   compilati se il cliente indica un'altra persona da contattare
5. `note_cliente` — tipo *Text* — annotazioni utili raccolte in chiamata
6. `alternativa_scelta` — tipo *Selector*, opzioni esatte: `A`, `B`, `C`, `nessuna`
   - descrizione da incollare: *"Se il cliente ha accettato uno degli slot alternativi offerti
     in chiamata, la sua lettera; altrimenti nessuna"*
   - **consigliato ma non indispensabile**: se manca, l'app deduce l'alternativa da sola quando
     data e ora richieste coincidono con uno slot offerto. Per questo, quando il cliente accetta
     un'alternativa, `nuova_data_richiesta` e `nuovo_orario_richiesto` vanno comunque compilati
     con data (AAAA-MM-GG) e ora (HH:MM) dello slot accettato (lo script lo indica già all'analisi,
     con la corrispondenza lettera → slot)
   - accettati anche gli alias `alternativa_accettata`, `alternativa`, `slot_scelto`,
     `chosen_alternative`; valori come "alternativa B" o "opzione c" vengono normalizzati

Lo script inviato all'agente istruisce già l'operatore a chiedere e annotare queste
informazioni. Senza i campi custom l'automazione resta prudente: classifica solo i segnali
certi (segreteria, mancata risposta, numero non componibile) e per il resto mostra
"❓ Esito da verificare" senza toccare lo stato; l'esito si può registrare a mano dalla
finestra di chiamata ("Registra esito della telefonata").


## Pratiche MISI/Prelios e gestionale

- **Import elenco pratiche MISI**: "Importa Excel" accetta anche l'export grezzo dell'elenco
  perizie (Prelios/Intesa): vengono tenute solo le pratiche **FULL - Acquisto**, con codice,
  intestatario, indirizzo, progetto e note gestore. Le pratiche già presenti (stesso codice)
  vengono **aggiornate** (telefono/note/progetto), non duplicate.
- **Bridge dei portali (`prelios-bridge/`)**: app Python separata che entra su Prelios (login
  manuale con MFA), recupera il telefono del cliente per ogni perizia e consegna le pratiche
  all'app: in modalità servizio (`python run_giro.py --serve`) direttamente, senza passaggi
  manuali; oppure come Excel arricchito da importare
  (`python run_giro.py elenco.xlsx --out giro_arricchito.xlsx`). La lettura dell'elenco
  direttamente dal portale non è ancora stata provata sul portale reale: il primo giro va
  fatto sotto supervisione. **Cerved** non è ancora collegato: il bridge ha la struttura
  per aggiungerlo e uno strumento (`capture_portal.py`) per rilevarne le pagine in forma
  anonimizzata. Vedi `prelios-bridge/README.md`.
- **Sync verso il gestionale Effetre**: i sopralluoghi **confermati** (dal cliente in chiamata,
  o senza telefono) con orario calcolato vengono inviati al gestionale (Firestore, collection
  `optiroute_sync`) con "Sincronizza col gestionale" (menu "Esporta" o Impostazioni) e in automatico **ogni ora**. Ambiente di
  default: collaudo; produzione con `VITE_SYNC_ENV=production`.

## Altre variabili d'ambiente

Vedi `.env.example`: `GOOGLE_MAPS_API_KEY` (tempi di viaggio con traffico), `VITE_N8N_WEBHOOK_URL` (invio report via n8n), `VITE_GEMINI_API_KEY` (pulizia AI degli indirizzi, opzionale).
