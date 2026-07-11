# OptiRoute

Gestione e ottimizzazione degli appuntamenti di sopralluogo su mappa, **multi-tecnico**: inserimento rapido o completo (cliente, telefono, note, durata, urgenza), import/export Excel, smistamento automatico delle pratiche per zona di competenza con proposta di data/orario, calcolo del percorso ottimale con orari reali di viaggio e **chiamata AI di conferma al cliente tramite Retell AI**.

## Avvio locale

```bash
npm install
npm run dev
```

Build di produzione: `npm run build` (deploy pensato per Vercel, incluse le funzioni in `api/`).

## Funzionalità principali

- **Tecnici multipli e zone di competenza** (pulsante "Tecnici" in alto)
  - Ogni tecnico ha una *scheda* con: zone di competenza (province e/o comuni entro un raggio in km), **punto di partenza**, **orario di partenza**, fine giornata e **indisponibilità** (giorni interi o fasce orarie).
  - Preconfigurati: *Omar Afifi* (province di Milano e Novara) e *Federica Sala* (provincia di Pavia, comuni attorno a Stradella/Broni/Varzi entro 15 km). Tutto modificabile dalla scheda.
  - Le pratiche nuove o importate vengono **assegnate automaticamente** al tecnico competente (per provincia da Excel/geocoding, o per raggio dalle zone); assegnazione modificabile a mano dal form di modifica.
  - I chip in alto nella sidebar filtrano liste e mappa per tecnico; i colori di marker e percorsi corrispondono al tecnico.
- **Smistamento automatico ("Smista pratiche per zona")**: le pratiche in attesa vengono distribuite sui prossimi giorni per ogni tecnico, con **data e orario ipotizzati** (rispettando orari, indisponibilità e punto di partenza di ciascuno). Le proposte compaiono nella sezione "Proposte da confermare": l'operatore conferma singolarmente o per giornata intera, oppure rifiuta.
- **Tag "Urgente"** su ogni pratica (checkbox nel form, colonna `Urgente` in import): badge rosso in lista e mappa, priorità nello smistamento (pianificate per prime nei primi giorni utili) e **annuncio esplicito dell'urgenza nella chiamata AI**.
- **Inserimento appuntamenti**
  - *Aggiunta rapida*: digita un indirizzo e premi `+` (opzionale pulizia AI con Gemini).
  - *Inserimento completo*: pulsante "Nuovo completo" per cliente, telefono, indirizzo, note, durata, urgenza e tecnico.
  - *Modifica*: icona matita su qualsiasi appuntamento.
  - *Import Excel*: colonne supportate `Intestatario`, `Indirizzo`, `N.Civ.`, `Comune`, `Prov.` e in più `Telefono` (o `Tel`/`Cellulare`), `Note` e `Urgente` (sì/x/1).
  - *Import da Google My Maps* ("Importa Maps", file `.kmz`/`.kml`): ogni **livello** della mappa viene mappato su una destinazione (confermate con data, in attesa, stand-by, categorie problematiche, annullate) con proposta automatica dal nome del livello (es. "9/07" → confermate al 9 luglio, "annullate" → archivio). Dalle schede vengono estratti intestatari, telefono, riferimento pratica (ISP/CER/…), note, orario ("ore 9:00") e tecnico ("slp Federica"); niente geocoding, le coordinate arrivano dal file. I duplicati vengono saltati.
- **Riordino del giro con drag & drop**: in vista Giorno tieni premuto il clic su una scheda confermata e trascinala su un'altra tappa dello stesso tecnico: sequenza, orari e percorso in mappa si ricalcolano subito.
- **Categorie problematiche**: ogni pratica può essere smistata (dal form di modifica o in automatico dall'import Maps) in 📵 *Numeri non corretti*, 📆 *Da richiamare*, 🚧 *Lavori da ultimare*, oppure segnata *Annullata* (archivio, filtro spento di default). Con **data di rientro** (richiamo concordato / fine lavori): dal giorno prima compare l'alert 🔔 **"Slot da riservare"** in cima alla sidebar, con azione rapida "→ In attesa"; lo smistamento automatico dà priorità alle pratiche rientrate e **non propone mai date precedenti al rientro**.
- **Persistenza locale**: appuntamenti, tecnici, base di partenza e orari di lavoro sopravvivono al refresh (localStorage).
- **Ottimizzazione**: percorso "furthest first", orari con traffico (Google Directions con fallback OSRM), pausa pranzo automatica, durata personalizzabile per appuntamento. Con un tecnico selezionato, "Ottimizza" usa base, orari e indisponibilità della sua scheda. Le tratte già calcolate sono in cache: ri-ottimizzare o scambiare l'ordine è quasi istantaneo.
- **Chiamata AI di conferma (Retell)**: alla conferma di un appuntamento con numero di telefono si apre la finestra di chiamata; puoi anche avviarla in ogni momento con l'icona 📞 sulla card o dal popup sulla mappa. L'operatore AI riceve tutti i dati dell'appuntamento (cliente, data, orario, indirizzo, note, tecnico) e, per le pratiche urgenti, **dichiara esplicitamente l'urgenza durante la chiamata**.

## Configurazione chiamate AI (Retell)

1. Crea un account su [Retell AI](https://www.retellai.com) e acquista/importa un numero in uscita.
2. Crea un agente vocale (lingua: italiano) e associalo al numero per le chiamate outbound.
3. Nel prompt dell'agente puoi usare le variabili dinamiche inviate da OptiRoute:
   - `{{call_script}}` — script completo già pronto (saluto, presentazione, dati appuntamento, eventuale avviso di urgenza, richiesta di conferma). Il prompt minimo dell'agente può essere semplicemente: *"Segui queste istruzioni: {{call_script}}"*.
   - Oppure le variabili singole: `{{company_name}}`, `{{client_name}}`, `{{appointment_date}}`, `{{appointment_time}}`, `{{appointment_time_spoken}}`, `{{appointment_end_time}}`, `{{appointment_address}}`, `{{appointment_notes}}`, `{{appointment_urgent}}` ("URGENTE"/"normale"), `{{urgency_notice}}` (frase pronta sull'urgenza, vuota se non urgente), `{{technician_name}}` (chi effettuerà il sopralluogo).
4. Su Vercel (Settings → Environment Variables) imposta:
   - `RETELL_API_KEY` — API key Retell
   - `RETELL_FROM_NUMBER` — numero in uscita in formato E.164 (es. `+39...`)
   - `RETELL_AGENT_ID` — (opzionale) per forzare un agente specifico
   - `RETELL_COMPANY_NAME` — (opzionale) nome aziendale pronunciato dall'operatore

I numeri italiani senza prefisso internazionale vengono normalizzati automaticamente a `+39`.

## Altre variabili d'ambiente

Vedi `.env.example`: `GOOGLE_MAPS_API_KEY` (tempi di viaggio con traffico), `VITE_N8N_WEBHOOK_URL` (invio report via n8n), `VITE_GEMINI_API_KEY` (pulizia AI degli indirizzi, opzionale).
