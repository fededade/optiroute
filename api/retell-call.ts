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
  return date.toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
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

  const { phone, clientName, date, startTime, endTime, address, shortAddress, comune, notes, periziaCode, project, contactPerson, referredBy, daySchedule } = req.body || {};

  if (!phone) {
    return res.status(400).json({ error: 'Numero di telefono mancante.' });
  }

  const toNumber = normalizePhone(String(phone));
  if (!toNumber) {
    return res.status(400).json({ error: `Numero di telefono non valido: ${phone}` });
  }

  const dateSpoken = formatDateItalian(date);
  const timeSpoken = startTime ? `alle ore ${startTime}` : 'in orario da definire';

  const isReferral = !!contactPerson; // stiamo chiamando la persona indicata dal cliente

  // Immobile: "di COMUNE in VIA CIVICO" presi dalla perizia
  const luogoImmobile = comune && shortAddress
    ? `di ${comune} in ${shortAddress}`
    : `in ${shortAddress || comune || address || 'indirizzo da comunicare'}`;

  const interlocutore = isReferral ? contactPerson : (clientName || '');

  // APERTURA ufficiale: presentazione completa PRIMA, verifica interlocutore DOPO
  const presentazione =
    `Buongiorno, sono ${AGENT_NAME} di ${COMPANY_NAME}, società incaricata per conto di ` +
    `${MANDANTE} per la perizia relativa all'immobile ${luogoImmobile}.` +
    (interlocutore ? ` Parlo con ${interlocutore}?` : ` Parlo con l'intestatario della pratica?`);

  // PROPOSTA: l'operatrice propone, il cliente conferma
  const proposta = (dateSpoken && startTime)
    ? `La chiamavo per proporle la data del sopralluogo del perito: avremmo disponibilità per ${dateSpoken} alle ore ${startTime}. Può andarle bene?`
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
    `- Chiede un ALTRO giorno/ora → consulta l'AGENDA DEL GIORNO qui sotto e rispondi onestamente, poi prendi SEMPRE nota di giorno e fascia richiesti:`,
    `  * se l'orario richiesto CADE in una fascia già impegnata: dillo con garbo (es. "guardi, a quell'ora abbiamo già un sopralluogo fissato") e comunica che verrà ricontattato con una proposta alternativa;`,
    `  * se l'orario richiesto NON risulta impegnato: di' che dovrebbe essere possibile, ma che riceverà una conferma definitiva a breve. NON dare MAI il nuovo orario per già fissato: la conferma spetta all'ufficio.`,
    `  * se chiede un ALTRO GIORNO: prendi nota e comunica che verrà ricontattato con la proposta.`,
    `- RIFIUTA / la perizia non serve più → prendi atto cortesemente e chiudi.`,
    `- NON è lui la persona da contattare (geometra di cantiere, agente immobiliare, familiare con le chiavi...) → fatti dare NOME, NUMERO DI TELEFONO e RUOLO della persona corretta; RIPETI il numero per conferma; comunica che quella persona verrà contattata a breve.`,
    ``,
    `## AGENDA DEL GIORNO (solo per tua consultazione — NON elencarla al cliente, non citare altri clienti):`,
    `${daySchedule || 'Nessuna informazione sull\'agenda: in caso di richieste di spostamento prendi nota e basta.'}`,
    ``,
    `## DATI APPUNTAMENTO:`,
    `- Immobile: ${[comune, shortAddress].filter(Boolean).join(', ') || address}`,
    address ? `- Indirizzo completo: ${address}` : null,
    dateSpoken ? `- Giorno proposto: ${dateSpoken}` : `- Giorno: da definire`,
    startTime ? `- Orario proposto: ${startTime}${endTime ? ` (indicativamente fino alle ${endTime})` : ''}` : `- Orario: da definire`,
    (isReferral && clientName) ? `- Intestatario della pratica: ${clientName}` : null,
    periziaCode ? `- Pratica: ${periziaCode}` : null,
    notes ? `- Note interne (NON leggerle al cliente, servono a te): ${notes}` : null,
    ``,
    `## REGOLE: tono cortese e professionale; non fornire MAI l'importo del finanziamento o altri dati sensibili; ringrazia e saluta prima di chiudere.`,
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
      immobile: [comune, shortAddress].filter(Boolean).join(', ') || address || '',
      client_name: clientName || 'cliente',
      appointment_date: dateSpoken || 'da definire',
      appointment_time: startTime || 'da definire',
      appointment_time_spoken: timeSpoken,
      appointment_end_time: endTime || '',
      appointment_address: address || '',
      appointment_notes: notes || '',
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
