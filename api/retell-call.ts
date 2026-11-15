import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Retell AI outbound confirmation call.
// Required env vars (Vercel dashboard):
//   RETELL_API_KEY      -> API key from Retell dashboard
//   RETELL_FROM_NUMBER  -> outbound number purchased/imported on Retell (E.164, e.g. +39...)
// Optional:
//   RETELL_AGENT_ID     -> overrides the agent bound to the number
//   RETELL_COMPANY_NAME -> company name spoken by the agent (default: "Effestudio")
//   RETELL_AGENT_NAME   -> operator name spoken by the agent (default: "Chiara")
//   RETELL_MANDANTE     -> chain of principals (default: "Prelios per conto di Banca Intesa")
//   RETELL_API_BASE     -> base dell'API Retell (default https://api.retellai.com; per i test)
//   CRON_SECRET         -> se impostata, l'endpoint richiede Authorization: Bearer <CRON_SECRET>
//                          (o un biglietto di sessione del gestionale, vedi server/auth.ts)
//
// NB: questo file è importato (e impacchettato) anche dal motore lato server
// (server/engine.ts): niente import relativi qui, Vercel non li risolverebbe.

const COMPANY_NAME = process.env.RETELL_COMPANY_NAME || 'Effetre Properties';
const AGENT_NAME = process.env.RETELL_AGENT_NAME || 'Misi';
const MANDANTE = process.env.RETELL_MANDANTE || 'Prelios - Banca Intesa';

// Configurazione Retell, letta al momento della richiesta
export interface RetellEnv {
  apiKey: string;
  fromNumber: string;
  agentId: string;
  apiBase: string;
}

export const retellEnv = (): RetellEnv => ({
  apiKey: process.env.RETELL_API_KEY || '',
  fromNumber: process.env.RETELL_FROM_NUMBER || '',
  agentId: process.env.RETELL_AGENT_ID || '',
  apiBase: (process.env.RETELL_API_BASE || 'https://api.retellai.com').replace(/\/+$/, ''),
});

// Protezione opzionale: con CRON_SECRET impostata serve la chiave oppure un
// biglietto di sessione del gestionale ancora valido (confronti a tempo
// costante sui digest); senza CRON_SECRET l'endpoint resta aperto come prima.
// La verifica del biglietto è la stessa di server/auth.ts (copiata: qui
// niente import relativi); un test controlla che coincidano.
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
const isSessionTokenFor = (token: string, secret: string, nowMs: number): boolean => {
  const m = /^ors1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const exp = parseInt(m[1], 10);
  if (exp * 1000 <= nowMs || exp * 1000 > nowMs + 61 * 60 * 1000) return false;
  const key = createHmac('sha256', secret).update('optiroute-sessione-v1').digest();
  return sameSecret(m[2], createHmac('sha256', key).update(`ors1.${exp}`).digest('base64url'));
};

export const isCallApiAuthorized = (headers: VercelRequest['headers'] | undefined, nowMs: number = Date.now()): boolean => {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return true;
  const raw = headers?.authorization;
  const value = Array.isArray(raw) ? raw[0] || '' : raw || '';
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!m) return false;
  const token = m[1].trim();
  return sameSecret(token, secret) || isSessionTokenFor(token, secret, nowMs);
};

// Normalize to E.164; numbers without prefix are assumed to be Italian (+39)
export const normalizePhone = (raw: string): string | null => {
  let phone = raw.replace(/[\s\-().]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) {
    if (!/^\d{6,15}$/.test(phone)) return null;
    phone = `+39${phone}`;
  }
  return /^\+\d{6,15}$/.test(phone) ? phone : null;
};

const GIORNI_IT = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MESI_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

// "2026-11-12" -> Date locale costruita dalle parti (anno, mese, giorno), senza
// passare da UTC: il giorno della settimana è giusto qualunque sia il fuso del server.
// undefined se la data non esiste (es. 2026-02-30).
const parseIsoDateParts = (isoDate: string): Date | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return undefined;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  return date;
};

// Senza anno: al telefono si dice "martedì 7 luglio", non "... 2026"
export const formatDateItalian = (isoDate?: string): string => {
  if (!isoDate) return '';
  const date = parseIsoDateParts(isoDate);
  if (!date) return isoDate;
  return `${GIORNI_IT[date.getDay()]} ${date.getDate()} ${MESI_IT[date.getMonth()]}`;
};

// Ripulisce l'indirizzo geocodificato "lungo" (Nominatim display_name) in
// "via civico, comune": toglie CAP, "Municipio N", regione, quartieri/frazioni
// e "Italia". Usato solo come fallback quando non abbiamo via+comune separati.
const REGIONI_IT = [
  'abruzzo', 'basilicata', 'calabria', 'campania', 'emilia-romagna',
  'friuli-venezia giulia', 'lazio', 'liguria', 'lombardia', 'marche',
  'molise', 'piemonte', 'puglia', 'sardegna', 'sicilia', 'toscana',
  'trentino-alto adige', 'umbria', "valle d'aosta", 'veneto',
];

const cleanDisplayName = (full: string): string => {
  const parts = full.split(',').map(s => s.trim()).filter(Boolean);
  const kept = parts.filter(p => {
    const pl = p.toLowerCase();
    if (/^\d{4,5}$/.test(p)) return false;      // CAP
    if (pl === 'italia') return false;
    if (/^municipio\b/i.test(p)) return false;
    if (REGIONI_IT.includes(pl)) return false;
    return true;
  });
  // Nominatim IT: [civico, via, ...quartieri/frazioni..., comune].
  // Tieni civico + via + comune, scartando le zone intermedie.
  if (kept.length > 3) {
    return [kept[0], kept[1], kept[kept.length - 1]].filter(Boolean).join(', ');
  }
  return kept.join(', ');
};

// "09:00" -> "9", "09:30" -> "9 e trenta": così il TTS dice "alle nove"
// invece di "alle ore zero nove e zero zero".
export const oraParlata = (hhmm?: string): string => {
  if (!hhmm) return '';
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  if (isNaN(h)) return hhmm;
  if (!m) return `${h}`;
  if (m === 30) return `${h} e mezza`;
  return `${h} e ${m}`;
};

// Nome da PRONUNCIARE: gli export dei portali scrivono i nomi tutti in
// maiuscolo ("FERRO MATTEO", "D'ANGELO ANNA-MARIA"); li riporta a lettere
// iniziali maiuscole. Un nome già scritto con minuscole resta com'è.
export const nomeParlato = (raw?: string): string => {
  const name = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if (!name || name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
};

// Segnaposto usato dall'autopilota quando il cliente ha dato solo un numero
const REFERENTE_SENZA_NOME = 'referente indicato dal cliente';
const PAROLE_INDIRIZZO = /^(via|viale|v\.le|piazza|p\.za|piazzale|corso|c\.so|largo|strada|vicolo|contrada|localit[aà]|loc\.|frazione|fraz\.)\s/i;

// Nome da usare nell'apertura "parlo con ...?", oppure '' se non c'è un nome
// VERO da chiedere. Scarta: il ruolo aggiunto al referente ("Luca Bianchi —
// geometra" -> "Luca Bianchi"), il segnaposto del referente senza nome e il
// titolo della pratica quando è in realtà l'indirizzo (le pratiche senza
// intestatario prendono via e civico come titolo).
export const nomeDaChiamare = (
  raw: unknown,
  luogo: { address?: string; shortAddress?: string; comune?: string } = {},
): string => {
  const name = nomeParlato(
    typeof raw === 'string' ? raw.split(/\s+[—–]\s+/)[0].replace(/\s*\([^)]*\)\s*/g, ' ') : '',
  );
  if (!name) return '';
  const low = name.toLowerCase();
  if (low === REFERENTE_SENZA_NOME) return '';
  if (/\d/.test(name) || PAROLE_INDIRIZZO.test(name)) return '';
  const norm = (v?: string) => (typeof v === 'string' ? v : '').split(',')[0].replace(/\s+/g, ' ').trim().toLowerCase();
  const indirizzi = [norm(luogo.shortAddress), norm(luogo.address)].filter(Boolean);
  if (indirizzi.some(a => low === a || low.startsWith(a) || a.startsWith(low))) return '';
  return name;
};

// --- Slot alternativi (offerti SOLO se il cliente non può nello slot proposto) ---

export type AlternativeLabel = 'A' | 'B' | 'C';

export interface AlternativeSlot {
  label: AlternativeLabel;
  date: string;      // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string;   // HH:MM
}

const MAX_ALTERNATIVES = 3;

const isHHMM = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  const m = /^(\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return false;
  return parseInt(m[1], 10) <= 23 && parseInt(m[2], 10) <= 59;
};

// Validazione difensiva delle alternative arrivate dal client: scarta in
// silenzio gli elementi non validi (mai errore: la chiamata deve partire
// comunque), etichette duplicate comprese, e tiene al massimo 3 slot.
export const parseAlternatives = (raw: unknown): AlternativeSlot[] => {
  if (!Array.isArray(raw)) return [];
  const out: AlternativeSlot[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_ALTERNATIVES) break;
    if (!item || typeof item !== 'object') continue;
    const { label, date, startTime, endTime } = item as Record<string, unknown>;
    const lbl = typeof label === 'string' ? label.trim().toUpperCase() : '';
    if (lbl !== 'A' && lbl !== 'B' && lbl !== 'C') continue;
    if (seen.has(lbl)) continue;
    if (typeof date !== 'string' || !parseIsoDateParts(date)) continue;
    if (!isHHMM(startTime) || !isHHMM(endTime)) continue;
    seen.add(lbl);
    out.push({ label: lbl, date: date.trim(), startTime: startTime.trim(), endTime: endTime.trim() });
  }
  return out;
};

// Testo da pronunciare: "giovedì 12 novembre alle 15 e mezza"
export const formatAlternativeSpoken = (slot: AlternativeSlot): string =>
  `${formatDateItalian(slot.date)} alle ${oraParlata(slot.startTime)}`;

// Corrispondenza lettera -> slot per l'analisi post-chiamata: "A = 2026-11-12 15:30"
export const formatAlternativeKey = (slot: AlternativeSlot): string =>
  `${slot.label} = ${slot.date} ${slot.startTime}`;

// --- Script e variabili dinamiche ---

export interface CallScriptInput {
  clientName?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  address?: string;
  shortAddress?: string;
  comune?: string;
  notes?: string;
  urgent?: boolean | string;
  technicianName?: string;
  periziaCode?: string;
  project?: string;
  contactPerson?: string;
  referredBy?: string;
  daySchedule?: string;
  alternatives?: unknown; // validato con parseAlternatives
}

// Sezione dello script dedicata agli slot alternativi (nessuna riga se non ce ne sono)
export const buildAlternativesSection = (alternatives: AlternativeSlot[]): string[] => {
  if (alternatives.length === 0) return [];
  const spoken = alternatives.map(formatAlternativeSpoken);
  return [
    `## SLOT ALTERNATIVI — usali SOLO se il cliente non può o non vuole il giorno e l'orario proposti:`,
    `Sono disponibilità REALI, già verificate sull'agenda del tecnico: sono le UNICHE che puoi offrire o fissare.`,
    `- Offrile UNA ALLA VOLTA, in quest'ordine, aspettando la risposta prima di passare alla successiva:`,
    ...spoken.map((s, i) => `  ${i + 1}) ${s}`),
    `- Di' al cliente SOLO giorno e ora (es. "Potrebbe andarle bene ${spoken[0]}?"): NON leggere MAI lettere, numeri o etichette delle alternative.`,
    `- Se ne ACCETTA una → confermala esplicitamente ripetendo giorno e ora: "Perfetto, allora le confermo il sopralluogo per <giorno> alle <ora>." Spiega al cliente che è un appuntamento FISSATO: da quel momento l'appuntamento valido è quello (non più quello proposto all'inizio). Ringrazia e saluta.`,
    `- Se chiede un giorno o un orario DIVERSO da questi → non confermarlo e non dire che "dovrebbe essere possibile": proponi le alternative rimaste.`,
    `- Se NESSUNA va bene → NON inventare altre disponibilità e NON promettere orari: chiedi quando preferirebbe (giorno e fascia oraria), prendine nota e di' che verrà ricontattato con una nuova proposta.`,
    ``,
  ];
};

// Nota (non da pronunciare) con la corrispondenza lettera -> slot, così
// l'analisi post-chiamata può compilare alternativa_scelta
export const buildAnalysisNote = (alternatives: AlternativeSlot[]): string[] => {
  if (alternatives.length === 0) return [];
  return [
    `## NOTA PER L'ANALISI POST-CHIAMATA (NON pronunciarla, NON leggerla al cliente):`,
    `- Corrispondenza alternative: ${alternatives.map(formatAlternativeKey).join('; ')}.`,
    `- Se il cliente ha accettato una delle alternative: alternativa_scelta = la sua lettera, esito_appuntamento = confermato, nuova_data_richiesta = data (AAAA-MM-GG) e nuovo_orario_richiesto = ora (HH:MM) dello slot accettato. Altrimenti alternativa_scelta = nessuna.`,
    ``,
  ];
};

// Prepara lo script parlato e le variabili dinamiche Retell (tutte stringhe).
// Funzione pura: dipende solo dall'input e dalla configurazione (env).
export const buildCallData = (input: CallScriptInput): { callScript: string; dynamicVariables: Record<string, string> } => {
  const {
    clientName, date, startTime, endTime, address, shortAddress, comune, notes, urgent,
    technicianName, periziaCode, project, contactPerson, referredBy, daySchedule,
  } = input;
  const alternatives = parseAlternatives(input.alternatives);
  const hasAlternatives = alternatives.length > 0;

  const dateSpoken = formatDateItalian(date);
  const timeSpoken = startTime ? `alle ${oraParlata(startTime)}` : 'in orario da definire';

  const isReferral = !!contactPerson; // stiamo chiamando la persona indicata dal cliente
  const isUrgent = urgent === true || urgent === 'true';

  // Luogo da PRONUNCIARE: solo via, civico e comune (niente CAP/provincia/
  // quartiere/regione). Preferisce i campi separati; altrimenti ripulisce
  // l'indirizzo geocodificato lungo.
  const luogoBreve = (shortAddress || comune)
    ? [shortAddress, comune].filter(Boolean).join(', ')
    : (address ? cleanDisplayName(address) : 'indirizzo da comunicare');

  // Immobile: "di COMUNE in VIA CIVICO" presi dalla perizia
  const luogoImmobile = comune && shortAddress
    ? `di ${comune} in ${shortAddress}`
    : `in ${luogoBreve}`;

  const interlocutore = nomeDaChiamare(isReferral ? contactPerson : clientName, { address, shortAddress, comune });
  const chiCerchiamo = isReferral ? 'la persona di riferimento per il sopralluogo' : 'l\'intestatario della pratica';

  // MOTIVO della chiamata: chi siamo e perché chiamiamo, detto SOLO dopo che
  // l'interlocutore ha risposto (breve: la prima frase non deve durare 15 secondi)
  const motivoChiamata =
    `Sono ${AGENT_NAME} di ${COMPANY_NAME}, per conto di ${MANDANTE}, ` +
    `per la perizia sull'immobile ${luogoImmobile}.`;

  // SPIEGAZIONE del motivo, per chi chiede "di cosa si tratta?" DOPO aver
  // confermato di essere la persona cercata (cita il mutuo: mai a terzi)
  const immobileViaComune = shortAddress && comune ? `${shortAddress} a ${comune}` : luogoBreve;
  const spiegazioneMotivo =
    `La chiamata è relativa alla richiesta di mutuo effettuata per l'immobile di ${immobileViaComune}: ` +
    `per procedere con la lavorazione della perizia è necessario effettuare il sopralluogo interno presso l'immobile.`;

  // Come si svolge il sopralluogo: da dire SOLO se lo chiedono
  const infoSopralluogo =
    `Il sopralluogo si svolge con rilievi fotografici e metrici, con misure a campione. ` +
    `Dura circa 15 minuti se si tratta di un appartamento, circa 25 minuti se si tratta di una villa.`;

  // APERTURA: prima si verifica la persona chiamandola per nome (chi si sente
  // chiamare per nome non riaggancia pensando a un venditore), POI ci si
  // presenta. Senza un nome vero non c'è niente da verificare: presentazione breve.
  const presentazione = interlocutore
    ? `Buongiorno, parlo con ${interlocutore}?`
    : `Buongiorno, s${motivoChiamata.slice(1)} Parlo con ${chiCerchiamo}?`;

  // PROPOSTA: l'operatrice propone, il cliente conferma
  const proposta = (dateSpoken && startTime)
    ? `La chiamavo per proporle la data del sopralluogo del perito: avremmo disponibilità per ${dateSpoken} alle ${oraParlata(startTime)}. Può andarle bene?`
    : `La chiamavo per concordare la data del sopralluogo del perito: prendo nota delle sue disponibilità e verrà ricontattato con la proposta di giorno e orario.`;

  // Gestione dello spostamento: con le alternative si passa agli slot reali;
  // senza, si consulta l'agenda e si prende nota (comportamento storico)
  const gestioneSpostamento: string[] = hasAlternatives
    ? [
        `  * passa agli SLOT ALTERNATIVI (sezione qui sotto): offrili uno alla volta e, se ne accetta uno, fissalo.`,
        `  * NON dare per possibile nessun altro giorno o orario: oltre a quello proposto, le uniche disponibilità sono gli slot alternativi.`,
        `  * se nessuno va bene, prendi SEMPRE nota di giorno e fascia preferiti.`,
      ]
    : [
        `  * consulta l'AGENDA DEL GIORNO qui sotto: se l'orario richiesto CADE in una fascia già impegnata, dillo con garbo (es. "a quell'ora abbiamo già un sopralluogo fissato") e comunica che verrà ricontattato con una proposta alternativa;`,
        `  * se l'orario richiesto NON risulta impegnato: di' che dovrebbe essere possibile, ma che riceverà una conferma definitiva a breve. NON dare MAI il nuovo orario per già fissato: la conferma spetta all'ufficio.`,
        `  * se chiede un ALTRO GIORNO: prendi nota e comunica che verrà ricontattato con la proposta.`,
        `  * in ogni caso prendi SEMPRE nota di giorno e fascia richiesti.`,
      ];

  const agendaFallback = hasAlternatives
    ? 'Nessuna informazione sull\'agenda: in caso di richieste di spostamento usa SOLO gli slot alternativi.'
    : 'Nessuna informazione sull\'agenda: in caso di richieste di spostamento prendi nota e basta.';

  // Ready-to-speak Italian script: the Retell agent prompt can simply
  // reference {{call_script}}, or use the granular variables below.
  const callScript = [
    `Sei ${AGENT_NAME}, assistente telefonica di ${COMPANY_NAME}.`,
    ``,
    `## SEQUENZA DELLA CHIAMATA — rispetta questo ORDINE, senza anticipare domande:`,
    ``,
    `1. APERTURA — appena rispondono, pronuncia ESATTAMENTE questa frase e poi ASPETTA la risposta:`,
    `"${presentazione}"`,
    interlocutore
      ? `   NON presentarti e NON dire perché chiami prima che l'interlocutore abbia risposto: la prima frase serve SOLO a verificare con chi parli.`
      : null,
    ``,
    `2. PRESENTAZIONE E PROPOSTA — quando l'interlocutore conferma di essere la persona giusta, in UN'UNICA risposta:`,
    interlocutore
      ? `   a) presentati e spiega perché chiami: "${motivoChiamata}" — ma se ti sei GIÀ presentata in questa chiamata (perché ha chiesto chi parla o per cosa), NON ripeterlo: passa direttamente al punto b).`
      : `   a) ti sei già presentata nell'apertura: NON ripetere la presentazione.`,
    isReferral
      ? `      CONTESTO REFERENTE — NON stai chiamando l'intestatario: stai chiamando ${interlocutore || 'la persona di riferimento'}, il cui numero ti è stato indicato da ${referredBy || 'l\'intestatario della pratica'} come riferimento per il sopralluogo. Spiega in breve che l'appuntamento riguarda l'immobile dell'intestatario${clientName ? ` (${nomeParlato(clientName)})` : ''} e che sei stata indirizzata a lui/lei.`
      : null,
    `   b) PROPONI l'appuntamento con questa frase (non darlo MAI per già confermato: l'operatrice propone, il cliente conferma):`,
    `"${proposta}"`,
    ``,
    `   Se PRIMA di confermare chiede "chi parla?" o "per cosa?" → rispondi presentandoti: "${motivoChiamata}", poi chiedi di nuovo se parli con ${interlocutore || chiCerchiamo}.`,
    `   Se NON è la persona cercata → ${interlocutore ? `PRIMA presentati e spiega perché chiami ("${motivoChiamata}"), SOLO DOPO` : 'senza ripetere la presentazione,'} chiedi se può passarti ${interlocutore || chiCerchiamo} oppure chi è la persona giusta da contattare per il sopralluogo. NON chiedere nomi o numeri prima di aver spiegato chi sei e perché chiami.`,
    `   Se DOPO aver confermato chi è chiede "di cosa si tratta?" o dice di non aver capito → NON chiedere di nuovo con chi parli (lo sai già): spiega con questa frase "${spiegazioneMotivo}" e poi riprendi la proposta.`,
    `   Il MUTUO citalo SOLO a chi ha confermato di essere ${interlocutore || chiCerchiamo}: a chiunque altro di' solo chi sei e che chiami per la perizia sull'immobile.`,
    ``,
    `3. GESTIONE DELLA RISPOSTA:`,
    `- ACCETTA giorno e orario → ripeti chiaramente data e ora, ringrazia e saluta.`,
    `- È TITUBANTE o chiede di spostare → l'obiettivo è CONSERVARE l'appuntamento proposto: fai UN SOLO tentativo, gentile ma deciso, es.: "Guardi, le dico la verità: ci verrebbe difficile riprogrammare, l'agenda è pressoché piena e spostare il sopralluogo potrebbe allungare i tempi della sua pratica. È sicuro di non riuscire a esserci? In alternativa può anche delegare qualcuno: un familiare, l'agente immobiliare, il geometra...". Se delega qualcuno, raccogli NOME, TELEFONO e RUOLO del delegato (e ripeti il numero per conferma). Se invece insiste per spostare, NON forzare oltre — accondiscendi con garbo e procedi:`,
    ...gestioneSpostamento,
    `- RIFIUTA / la perizia non serve più → prendi atto cortesemente e chiudi.`,
    `- NON è lui la persona da contattare (geometra di cantiere, agente immobiliare, familiare con le chiavi...) → dopo aver spiegato chi sei e perché chiami, fatti dare NOME, NUMERO DI TELEFONO e RUOLO della persona corretta; RIPETI il numero per conferma; comunica che quella persona verrà contattata a breve.`,
    ``,
    `## DOMANDE SUL SOPRALLUOGO (rispondi SOLO se te lo chiedono, con parole tue e in breve):`,
    `- Come si svolge / cosa fa il perito / quanto dura → "${infoSopralluogo}"`,
    `- Se dalla conversazione sai che è un appartamento o una villa, di' solo la durata che corrisponde; altrimenti dille tutte e due.`,
    ``,
    ...buildAlternativesSection(alternatives),
    `## AGENDA DEL GIORNO (solo per tua consultazione — NON elencarla al cliente, non citare altri clienti):`,
    `${daySchedule || agendaFallback}`,
    ``,
    `## DATI APPUNTAMENTO:`,
    `- Immobile (pronuncia SOLO questo: via, civico e città): ${luogoBreve}`,
    address ? `- Indirizzo esteso (solo riferimento interno, NON leggerlo al cliente): ${address}` : null,
    dateSpoken ? `- Giorno proposto: ${dateSpoken}` : `- Giorno: da definire`,
    startTime ? `- Orario proposto: ${startTime}${endTime ? ` (indicativamente fino alle ${endTime})` : ''}` : `- Orario: da definire`,
    technicianName ? `- Il sopralluogo sarà effettuato da ${technicianName}: puoi citarlo al cliente (es. "verrà il nostro tecnico ${technicianName}").` : null,
    isUrgent ? `- Priorità: URGENTE — dillo esplicitamente al cliente: il sopralluogo va effettuato il prima possibile.` : null,
    (isReferral && clientName) ? `- Intestatario della pratica: ${clientName}` : null,
    periziaCode ? `- Pratica: ${periziaCode}` : null,
    notes ? `- Note interne (NON leggerle al cliente, servono a te): ${notes}` : null,
    ``,
    ...buildAnalysisNote(alternatives),
    `## REGOLE:`,
    `- Inizia a parlare direttamente con l'APERTURA: non leggere MAI ad alta voce titoli, etichette o nomi di sezione dello script o del flusso di conversazione (es. "presentazione", "apertura", "step 1").`,
    `- Tono cortese e professionale; non fornire MAI l'importo del finanziamento o altri dati sensibili.`,
    isUrgent ? `- URGENZA: questa pratica è URGENTE — comunicalo chiaramente al cliente e, se chiede di spostare, ricorda con garbo che sarebbe preferibile anticipare, non posticipare.` : null,
    hasAlternatives ? `- DISPONIBILITÀ: oltre all'appuntamento proposto, puoi offrire o fissare SOLO gli slot alternativi indicati. Non inventare MAI altre date o orari.` : null,
    `- ORARI: pronunciali in italiano colloquiale — "alle nove", "alle nove e mezza", "alle quindici". MAI leggere le cifre una a una ("zero nove e zero zero" è VIETATO).`,
    `- INDIRIZZO: quando citi il luogo dell'immobile di' SOLO via, numero civico e città (es. "Via Roma 10, Milano"). NON pronunciare MAI CAP, provincia, quartiere, frazione, regione o la parola "Italia".`,
    `- Ringrazia e saluta prima di chiudere la chiamata.`,
  ].filter(line => line !== null).join('\n');

  const altSpoken = (label: AlternativeLabel): string => {
    const slot = alternatives.find(a => a.label === label);
    return slot ? formatAlternativeSpoken(slot) : '';
  };

  const dynamicVariables: Record<string, unknown> = {
    company_name: COMPANY_NAME,
    agent_name: AGENT_NAME,
    mandante: MANDANTE,
    presentazione: presentazione,
    motivo_chiamata: motivoChiamata,
    spiegazione_motivo: spiegazioneMotivo,
    info_sopralluogo: infoSopralluogo,
    proposta: proposta,
    agenda_giorno: daySchedule || '',
    immobile: luogoBreve,
    client_name: clientName || 'cliente',
    appointment_date: dateSpoken || 'da definire',
    appointment_time: startTime || 'da definire',
    appointment_time_spoken: timeSpoken,
    appointment_end_time: endTime || '',
    appointment_address: address || '',
    appointment_notes: notes || '',
    appointment_urgent: isUrgent ? 'URGENTE' : 'normale',
    urgency_notice: isUrgent
      ? "Questo sopralluogo è URGENTE: dillo esplicitamente al cliente e spiega che va effettuato il prima possibile."
      : '',
    technician_name: technicianName || '',
    pratica_codice: periziaCode || '',
    progetto: project || '',
    contact_person: contactPerson || '',
    referred_by: referredBy || '',
    alternative_disponibili: alternatives.map(formatAlternativeSpoken).join('\n'),
    alternativa_a: altSpoken('A'),
    alternativa_b: altSpoken('B'),
    alternativa_c: altSpoken('C'),
    ha_alternative: hasAlternatives ? 'si' : 'no',
    call_script: callScript,
  };

  // Le variabili dinamiche di Retell devono essere TUTTE stringhe: difesa
  // contro valori non stringa arrivati dal body (es. numeri)
  const stringVariables: Record<string, string> = {};
  for (const [k, v] of Object.entries(dynamicVariables)) {
    stringVariables[k] = typeof v === 'string' ? v : String(v ?? '');
  }

  return { callScript, dynamicVariables: stringVariables };
};

const NOT_CONFIGURED =
  'Chiamate AI non configurate: impostare RETELL_API_KEY e RETELL_FROM_NUMBER nelle variabili d\'ambiente.';

export type RetellCallBody = CallScriptInput & { phone?: unknown };

export type RetellPayloadResult =
  | { ok: true; payload: Record<string, unknown>; toNumber: string }
  | { ok: false; status: number; error: string };

// Payload completo per create-phone-call a partire dagli stessi campi del
// body dell'endpoint. Funzione pura: dipende solo da input e configurazione.
export const buildRetellCallPayload = (body: RetellCallBody, env: RetellEnv = retellEnv()): RetellPayloadResult => {
  const { phone, date, periziaCode, urgent } = body;

  if (!phone) {
    return { ok: false, status: 400, error: 'Numero di telefono mancante.' };
  }

  const toNumber = normalizePhone(String(phone));
  if (!toNumber) {
    return { ok: false, status: 400, error: `Numero di telefono non valido: ${phone}` };
  }

  // Script e variabili dinamiche (alternative comprese: quelle non valide
  // vengono scartate, la chiamata parte comunque)
  const { dynamicVariables } = buildCallData(body);
  const isUrgent = urgent === true || urgent === 'true';

  const payload: Record<string, unknown> = {
    from_number: env.fromNumber,
    to_number: toNumber,
    retell_llm_dynamic_variables: dynamicVariables,
    metadata: {
      source: 'optiroute',
      appointment_date: date || '',
      perizia_code: periziaCode || '',
      urgent: isUrgent,
    },
  };

  if (env.agentId) {
    payload.override_agent_id = env.agentId;
  }
  return { ok: true, payload, toNumber };
};

export type RetellCallResult =
  | { ok: true; callId?: string; callStatus?: string; toNumber: string }
  | { ok: false; status: number; error: string };

// Crea la chiamata su Retell (usata dall'endpoint e dal motore lato server).
// Non lancia eccezioni. Nei log solo lo stato HTTP: mai numeri o dati del cliente.
export const createRetellCall = async (
  body: RetellCallBody,
  opts: { env?: RetellEnv; timeoutMs?: number } = {}
): Promise<RetellCallResult> => {
  const env = opts.env || retellEnv();
  if (!env.apiKey || !env.fromNumber) {
    return { ok: false, status: 500, error: NOT_CONFIGURED };
  }
  const built = buildRetellCallPayload(body, env);
  if (!built.ok) return built;

  const controller = opts.timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  try {
    const response = await fetch(`${env.apiBase}/v2/create-phone-call`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(built.payload),
      signal: controller?.signal,
    });

    const data: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Retell API error:', response.status);
      return {
        ok: false,
        status: response.status,
        error: data?.message || data?.error || `Errore Retell (${response.status})`,
      };
    }

    return { ok: true, callId: data.call_id, callStatus: data.call_status, toNumber: built.toNumber };
  } catch (error) {
    console.error('Retell call error:', controller?.signal.aborted ? 'timeout' : 'errore di rete');
    return { ok: false, status: 500, error: 'Impossibile avviare la chiamata. Riprova.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isCallApiAuthorized(req.headers)) {
    return res.status(401).json({ error: 'auth' });
  }

  const env = retellEnv();
  if (!env.apiKey || !env.fromNumber) {
    return res.status(500).json({ error: NOT_CONFIGURED });
  }

  const body: RetellCallBody = req.body || {};
  const result = await createRetellCall(body, { env });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  return res.status(200).json({
    callId: result.callId,
    callStatus: result.callStatus,
    toNumber: result.toNumber,
  });
}

