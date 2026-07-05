# OptiRoute

Gestione e ottimizzazione giornaliera degli appuntamenti su mappa: inserimento rapido o completo (cliente, telefono, note, durata), import/export Excel, calcolo del percorso ottimale con orari reali di viaggio e **chiamata AI di conferma al cliente tramite Retell AI**.

## Avvio locale

```bash
npm install
npm run dev
```

Build di produzione: `npm run build` (deploy pensato per Vercel, incluse le funzioni in `api/`).

## Funzionalità principali

- **Inserimento appuntamenti**
  - *Aggiunta rapida*: digita un indirizzo e premi `+` (opzionale pulizia AI con Gemini).
  - *Inserimento completo*: pulsante "Nuovo completo" per cliente, telefono, indirizzo, note e durata.
  - *Modifica*: icona matita su qualsiasi appuntamento.
  - *Import Excel*: colonne supportate `Intestatario`, `Indirizzo`, `N.Civ.`, `Comune`, `Prov.` e in più `Telefono` (o `Tel`/`Cellulare`) e `Note`.
- **Persistenza locale**: appuntamenti, base di partenza e orari di lavoro sopravvivono al refresh (localStorage).
- **Ottimizzazione**: percorso "furthest first", orari con traffico (Google Directions con fallback OSRM), pausa pranzo automatica, durata personalizzabile per appuntamento. Le tratte già calcolate sono in cache: ri-ottimizzare o scambiare l'ordine è quasi istantaneo.
- **Chiamata AI di conferma (Retell)**: alla conferma di un appuntamento con numero di telefono si apre la finestra di chiamata; puoi anche avviarla in ogni momento con l'icona 📞 sulla card o dal popup sulla mappa. L'operatore AI riceve tutti i dati dell'appuntamento (cliente, data, orario, indirizzo, note).

## Configurazione chiamate AI (Retell)

1. Crea un account su [Retell AI](https://www.retellai.com) e acquista/importa un numero in uscita.
2. Crea un agente vocale (lingua: italiano) e associalo al numero per le chiamate outbound.
3. Nel prompt dell'agente puoi usare le variabili dinamiche inviate da OptiRoute:
   - `{{call_script}}` — script completo già pronto (saluto, presentazione, dati appuntamento, richiesta di conferma). Il prompt minimo dell'agente può essere semplicemente: *"Segui queste istruzioni: {{call_script}}"*.
   - Oppure le variabili singole: `{{company_name}}`, `{{client_name}}`, `{{appointment_date}}`, `{{appointment_time}}`, `{{appointment_time_spoken}}`, `{{appointment_end_time}}`, `{{appointment_address}}`, `{{appointment_notes}}`, `{{pratica_codice}}`, `{{progetto}}`.
4. Su Vercel (Settings → Environment Variables) imposta:
   - `RETELL_API_KEY` — API key Retell
   - `RETELL_FROM_NUMBER` — numero in uscita in formato E.164 (es. `+39...`)
   - `RETELL_AGENT_ID` — (opzionale) per forzare un agente specifico
   - `RETELL_COMPANY_NAME` — (opzionale) nome aziendale pronunciato dall'operatore

I numeri italiani senza prefisso internazionale vengono normalizzati automaticamente a `+39`.

### Esiti chiamata (Post-Call Analysis) — OBBLIGATORIO per la raccolta esiti

Perché OptiRoute possa leggere l'esito della chiamata (confermato / rifiutato / da riprogrammare) e riorganizzare il giro, configura nell'agente Retell la sezione **Post-Call Analysis** con questi campi personalizzati:

| Nome campo | Tipo | Descrizione da inserire |
|---|---|---|
| `esito_appuntamento` | enum/testo | Uno tra: `confermato`, `rifiutato`, `riprogrammare`, `non_risposto` |
| `nuova_data_richiesta` | testo | Se il cliente chiede di spostare: giorno richiesto (testo libero) |
| `nuovo_orario_richiesto` | testo | Se il cliente chiede di spostare: orario richiesto (testo libero) |
| `note_cliente` | testo | Eventuali note/richieste particolari del cliente |

OptiRoute interroga `GET /api/call-status` (che a sua volta chiama Retell `get-call`) ogni 15 secondi finché l'analisi non è pronta, poi mostra il badge esito sulla card e abilita **"Applica esiti al giro"**.

## Flusso sopralluoghi (pratiche MISI / Prelios)

1. **Importa Excel** con l'elenco pratiche grezzo (export MISI): vengono selezionate **solo** le pratiche `FULL - Acquisto`, geocodificate e messe "In Attesa" con codice pratica e progetto.
2. (Opzionale) Arricchisci i telefoni con il **bridge Prelios** (`prelios-bridge/`): produce un Excel con la colonna `Telefono` che, re-importato, **aggiorna** le pratiche esistenti per codice (nessun duplicato).
3. **Ottimizza** il giro del giorno → sequenza e orari.
4. **Chiama tutti**: l'AI chiama in sequenza i clienti del giro; gli esiti arrivano automaticamente (badge sulle card).
5. **Applica esiti al giro**: i rifiutati e chi chiede un altro giorno escono dal giro (Stand-by con nota), poi ri-ottimizza con i soli confermati.
6. **Ok finale** dell'operatore → **Esporta Excel** (include codice pratica, progetto, esiti) per il caricamento nel database ufficiale.

## Altre variabili d'ambiente

Vedi `.env.example`: `GOOGLE_MAPS_API_KEY` (tempi di viaggio con traffico), `VITE_N8N_WEBHOOK_URL` (invio report via n8n), `VITE_GEMINI_API_KEY` (pulizia AI degli indirizzi, opzionale).
