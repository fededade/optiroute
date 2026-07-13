import type { VercelRequest, VercelResponse } from '@vercel/node';

// Retell AI outbound confirmation call.
// Required env vars (Vercel dashboard):
//   RETELL_API_KEY      -> API key from Retell dashboard
//   RETELL_FROM_NUMBER  -> outbound number purchased/imported on Retell (E.164, e.g. +39...)
// Optional:
//   RETELL_AGENT_ID     -> overrides the agent bound to the number
//   RETELL_COMPANY_NAME -> company name spoken by the agent (default: "Effestudio")
//   RETELL_AGENT_NAME   -> operator name spoken by the agent (default: "Chiara")
//   RETELL_MANDANTE     -> chain of principals (default: "Prelios per conto di Banca Intesa")

const RETELL_API_URL = 'https://api.retellai.com/v2/create-phone-call';

const RETELL_API_KEY = process.env.RETELL_API_KEY || '';
const RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER || '';
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID || '';
const COMPANY_NAME = process.env.RETELL_COMPANY_NAME || 'Effetre Properties';
const AGENT_NAME = process.env.RETELL_AGENT_NAME || 'Misi';
const MANDANTE = process.env.RETELL_MANDANTE || 'Prelios - Banca Intesa';

// Normalize to E.164; numbers without prefix are assumed to be Italian (+39)
const normalizePhone = (raw: string): string | null => {
  let phone = raw.replace(/[\s\-().]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) {
    if (!/^\d{6,15}$/.test(phone)) return null;
    phone = `+39${phone}`;
  }
  return /^\+\d{6,15}$/.test(phone) ? phone : null;
};

const formatDateItalian = (isoDate?: string): string => {
  if (!isoDate) return '';
  const date = new Date(`${isoDate}T00:00:00`);
  if (isNaN(date.getTime())) return isoDate;
  // Senza anno: al telefono si dice "martedì 7 luglio", non "... 2026"
  return date.toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
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
const oraParlata = (hhmm?: string): string => {
  if (!hhmm) return '';
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  if (isNaN(h)) return hhmm;
  if (!m) return `${h}`;
  if (m === 30) return `${h} e mezza`;
  return `${h} e ${m}`;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!RETELL_API_KEY || !RETELL_FROM_NUMBER) {
    return res.status(500).json({
      error: 'Chiamate AI non configurate: impostare RETELL_API_KEY e RETELL_FROM_NUMBER nelle variabili d\'ambiente.',
    });
  }

  const { phone, clientName, date, startTime, endTime, address, shortAddress, comune, notes, urgent, technicianName, periziaCode, project, contactPerson, referredBy, daySchedule } = req.body || {};

  if (!phone) {
    return res.status(400).json({ error: 'Numero di telefono mancante.' });
  }

  const toNumber = normalizePhone(String(phone));
  if (!toNumber) {
    return res.status(400).json({ error: `Numero di telefono non valido: ${phone}` });
  }

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

  const interlocutore = isReferral ? contactPerson : (clientName || '');

  // APERTURA ufficiale: presentazione completa PRIMA, verifica interlocutore DOPO
  const presentazione =
    `Buongiorno, sono ${AGENT_NAME} di ${COMPANY_NAME}, società incaricata per conto di ` +
    `${MANDANTE} per la perizia relativa all'immobile ${luogoImmobile}.` +
    (interlocutore ? ` Parlo con ${interlocutore}?` : ` Parlo con l'intestatario della pratica?`);

  // PROPOSTA: l'operatrice propone, il cliente conferma
  const proposta = (dateSpoken && startTime)
    ? `La chiamavo per proporle la data del sopralluogo del perito: avremmo disponibilità per ${dateSpoken} alle ${oraParlata(startTime)}. Può andarle bene?`
    : `La chiamavo per concordare la data del sopralluogo del perito: prendo nota delle sue disponibilità e verrà ricontattato con la proposta di giorno e orario.`;

  // Ready-to-speak Italian script: the Retell agent prompt can simply
  // reference {{call_script}}, or use the granular variables below.
  const callScript = [
    `Sei ${AGENT_NAME}, assistente telefonica di ${COMPANY_NAME}.`,
    ``,
    `## SEQUENZA DELLA CHIAMATA — rispetta questo ORDINE, senza anticipare domande:`,
    ``,
    `1. APERTURA — appena rispondono, pronuncia ESATTAMENTE questa frase:`,
    `"${presentazione}"`,
    `   NON chiedere "con chi ho il piacere di parlare?" a freddo: prima ti presenti e spieghi chi sei e perché chiami, POI verifichi l'interlocutore.`,
    ``,
    isReferral
      ? `2. CONTESTO REFERENTE — NON stai chiamando l'intestatario: stai chiamando ${contactPerson}, indicato da ${referredBy || 'l\'intestatario della pratica'} come persona di riferimento per il sopralluogo. Dopo l'apertura, spiega che l'appuntamento riguarda l'immobile dell'intestatario${clientName ? ` (${clientName})` : ''} e che sei stata indirizzata a lui/lei.`
      : null,
    `${isReferral ? '3' : '2'}. PROPOSTA — quando l'interlocutore ha confermato di essere la persona giusta, PROPONI l'appuntamento. Non darlo MAI per già confermato: l'operatrice propone, il cliente conferma. Usa questa frase:`,
    `"${proposta}"`,
    ``,
    `${isReferral ? '4' : '3'}. GESTIONE DELLA RISPOSTA:`,
    `- ACCETTA giorno e orario → ripeti chiaramente data e ora, ringrazia e saluta.`,
    `- È TITUBANTE o chiede di spostare → l'obiettivo è CONSERVARE l'appuntamento proposto: fai UN SOLO tentativo, gentile ma deciso, es.: "Guardi, le dico la verità: ci verrebbe difficile riprogrammare, l'agenda è pressoché piena e spostare il sopralluogo potrebbe allungare i tempi della sua pratica. È sicuro di non riuscire a esserci? In alternativa può anche delegare qualcuno: un familiare, l'agente immobiliare, il geometra...". Se delega qualcuno, raccogli NOME, TELEFONO e RUOLO del delegato (e ripeti il numero per conferma). Se invece insiste per spostare, NON forzare oltre — accondiscendi con garbo e procedi:`,
    `  * consulta l'AGENDA DEL GIORNO qui sotto: se l'orario richiesto CADE in una fascia già impegnata, dillo con garbo (es. "a quell'ora abbiamo già un sopralluogo fissato") e comunica che verrà ricontattato con una proposta alternativa;`,
    `  * se l'orario richiesto NON risulta impegnato: di' che dovrebbe essere possibile, ma che riceverà una conferma definitiva a breve. NON dare MAI il nuovo orario per già fissato: la conferma spetta all'ufficio.`,
    `  * se chiede un ALTRO GIORNO: prendi nota e comunica che verrà ricontattato con la proposta.`,
    `  * in ogni caso prendi SEMPRE nota di giorno e fascia richiesti.`,
    `- RIFIUTA / la perizia non serve più → prendi atto cortesemente e chiudi.`,
    `- NON è lui la persona da contattare (geometra di cantiere, agente immobiliare, familiare con le chiavi...) → fatti dare NOME, NUMERO DI TELEFONO e RUOLO della persona corretta; RIPETI il numero per conferma; comunica che quella persona verrà contattata a breve.`,
    ``,
    `## AGENDA DEL GIORNO (solo per tua consultazione — NON elencarla al cliente, non citare altri clienti):`,
    `${daySchedule || 'Nessuna informazione sull\'agenda: in caso di richieste di spostamento prendi nota e basta.'}`,
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
    `## REGOLE:`,
    `- Inizia a parlare direttamente con l'APERTURA: non leggere MAI ad alta voce titoli, etichette o nomi di sezione dello script o del flusso di conversazione (es. "presentazione", "apertura", "step 1").`,
    `- Tono cortese e professionale; non fornire MAI l'importo del finanziamento o altri dati sensibili.`,
    isUrgent ? `- URGENZA: questa pratica è URGENTE — comunicalo chiaramente al cliente e, se chiede di spostare, ricorda con garbo che sarebbe preferibile anticipare, non posticipare.` : null,
    `- ORARI: pronunciali in italiano colloquiale — "alle nove", "alle nove e mezza", "alle quindici". MAI leggere le cifre una a una ("zero nove e zero zero" è VIETATO).`,
    `- INDIRIZZO: quando citi il luogo dell'immobile di' SOLO via, numero civico e città (es. "Via Roma 10, Milano"). NON pronunciare MAI CAP, provincia, quartiere, frazione, regione o la parola "Italia".`,
    `- Ringrazia e saluta prima di chiudere la chiamata.`,
  ].filter(line => line !== null).join('\n');

  const payload: Record<string, unknown> = {
    from_number: RETELL_FROM_NUMBER,
    to_number: toNumber,
    retell_llm_dynamic_variables: {
      company_name: COMPANY_NAME,
      agent_name: AGENT_NAME,
      mandante: MANDANTE,
      presentazione: presentazione,
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
      call_script: callScript,
    },
    metadata: {
      source: 'optiroute',
      appointment_date: date || '',
      perizia_code: periziaCode || '',
      urgent: isUrgent,
    },
  };

  if (RETELL_AGENT_ID) {
    payload.override_agent_id = RETELL_AGENT_ID;
  }

  try {
    const response = await fetch(RETELL_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Retell API error:', response.status, data);
      return res.status(response.status).json({
        error: data?.message || data?.error || `Errore Retell (${response.status})`,
      });
    }

    return res.status(200).json({
      callId: data.call_id,
      callStatus: data.call_status,
      toNumber,
    });
  } catch (error) {
    console.error('Retell call error:', error);
    return res.status(500).json({ error: 'Impossibile avviare la chiamata. Riprova.' });
  }
}
