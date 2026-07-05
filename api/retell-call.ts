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
const COMPANY_NAME = process.env.RETELL_COMPANY_NAME || 'Effestudio';
const AGENT_NAME = process.env.RETELL_AGENT_NAME || 'Chiara';
const MANDANTE = process.env.RETELL_MANDANTE || 'Prelios per conto di Banca Intesa';

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

  const { phone, clientName, date, startTime, endTime, address, shortAddress, comune, notes, periziaCode, project, contactPerson, referredBy } = req.body || {};

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

  // Immobile: "comune indirizzo e civico presi dalla perizia"
  const immobile = [comune, shortAddress].filter(Boolean).join(' ').trim() || address || 'indirizzo da comunicare';

  // Frase per la parte "proposta appuntamento"
  const propostaGiorno = dateSpoken ? `per il giorno ${dateSpoken}` : 'in una data da concordare';
  const propostaOra = startTime ? ` alle ore ${startTime}` : '';

  // Presentazione ufficiale (invariata nel testo, con i dati della perizia)
  const presentazione =
    `Buongiorno, sono ${AGENT_NAME}, la contatto per conto di ${COMPANY_NAME}, ` +
    `società incaricata da ${MANDANTE} relativamente alla richiesta di finanziamento ` +
    `per l'immobile sito in ${immobile}. La mia chiamata è finalizzata alla gestione ` +
    `dell'appuntamento per la perizia, che volevamo proporle ${propostaGiorno}${propostaOra}.`;

  // Ready-to-speak Italian script: the Retell agent prompt can simply
  // reference {{call_script}}, or use the granular variables below.
  const callScript = [
    `Sei ${AGENT_NAME}, assistente telefonico di ${COMPANY_NAME}.`,
    ``,
    `## PRESENTAZIONE (usa ESATTAMENTE questo testo, adattando solo i dati tra parentesi):`,
    presentazione,
    ``,
    isReferral
      ? `## CONTESTO: NON stai chiamando l'intestatario. Stai chiamando ${contactPerson}, indicato da ${referredBy || 'l\'intestatario della pratica'} come persona di riferimento per il sopralluogo. Dopo la presentazione, chiarisci che l'appuntamento riguarda l'immobile dell'intestatario${clientName ? ` (${clientName})` : ''} e che ${referredBy || 'l\'intestatario'} ti ha indicato lui/lei come referente da contattare.`
      : `## CONTESTO: stai chiamando l'intestatario della pratica${clientName ? ` (${clientName})` : ''}.`,
    ``,
    `## DATI APPUNTAMENTO:`,
    `- Immobile: ${immobile}`,
    address ? `- Indirizzo completo: ${address}` : null,
    dateSpoken ? `- Giorno proposto: ${dateSpoken}` : `- Giorno: da definire`,
    startTime ? `- Orario proposto: ${startTime}${endTime ? ` (indicativamente fino alle ${endTime})` : ''}` : `- Orario: da definire`,
    periziaCode ? `- Pratica: ${periziaCode}` : null,
    notes ? `- Note interne (NON leggerle al cliente, servono a te): ${notes}` : null,
    ``,
    `## COME GESTIRE LA RISPOSTA:`,
    `- Se accetta giorno e orario proposti: conferma l'appuntamento, ringrazia e saluta.`,
    `- Se chiede un altro giorno o un'altra ora: prendi nota della sua preferenza (giorno e fascia oraria) e comunica che verrà ricontattato per confermare la nuova data. NON garantire tu la nuova data.`,
    `- Se non è interessato / rifiuta / dice che la perizia non serve più: prendi atto cortesemente e chiudi.`,
    `- Se dice che NON è lui la persona giusta da contattare per il sopralluogo (es. va sentito il geometra di cantiere, l'agente immobiliare, un familiare che ha le chiavi): fatti dare NOME, NUMERO DI TELEFONO e RUOLO della persona corretta. RIPETI il numero per conferma. Comunica che contatterai direttamente quella persona.`,
    `- Mantieni sempre un tono cortese e professionale. Non fornire dettagli sull'importo del finanziamento o dati sensibili.`,
    `Ringrazia e saluta prima di chiudere la chiamata.`,
  ].filter(line => line !== null).join('\n');

  const payload: Record<string, unknown> = {
    from_number: RETELL_FROM_NUMBER,
    to_number: toNumber,
    retell_llm_dynamic_variables: {
      company_name: COMPANY_NAME,
      agent_name: AGENT_NAME,
      mandante: MANDANTE,
      presentazione: presentazione,
      immobile: immobile,
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
