import type { VercelRequest, VercelResponse } from '@vercel/node';

// Retell AI outbound confirmation call.
// Required env vars (Vercel dashboard):
//   RETELL_API_KEY      -> API key from Retell dashboard
//   RETELL_FROM_NUMBER  -> outbound number purchased/imported on Retell (E.164, e.g. +39...)
// Optional:
//   RETELL_AGENT_ID     -> overrides the agent bound to the number
//   RETELL_COMPANY_NAME -> company name spoken by the agent (default: "il nostro ufficio")

const RETELL_API_URL = 'https://api.retellai.com/v2/create-phone-call';

const RETELL_API_KEY = process.env.RETELL_API_KEY || '';
const RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER || '';
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID || '';
const COMPANY_NAME = process.env.RETELL_COMPANY_NAME || 'il nostro ufficio';

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

  const { phone, clientName, date, startTime, endTime, address, notes } = req.body || {};

  if (!phone) {
    return res.status(400).json({ error: 'Numero di telefono mancante.' });
  }

  const toNumber = normalizePhone(String(phone));
  if (!toNumber) {
    return res.status(400).json({ error: `Numero di telefono non valido: ${phone}` });
  }

  const dateSpoken = formatDateItalian(date);
  const timeSpoken = startTime ? `alle ore ${startTime}` : 'in orario da definire';

  // Ready-to-speak Italian script: the Retell agent prompt can simply
  // reference {{call_script}}, or use the granular variables below.
  const callScript = [
    `Sei l'assistente telefonico di ${COMPANY_NAME}.`,
    `Stai chiamando ${clientName || 'un cliente'} per confermare un appuntamento.`,
    `Dettagli dell'appuntamento:`,
    dateSpoken ? `- Data: ${dateSpoken}` : null,
    startTime ? `- Orario di arrivo previsto: ${startTime}${endTime ? ` (fine prevista ${endTime})` : ''}` : `- Orario: da definire, comunica che verrà confermato a breve`,
    address ? `- Indirizzo: ${address}` : null,
    notes ? `- Note: ${notes}` : null,
    ``,
    `Istruzioni: saluta cortesemente, presentati a nome di ${COMPANY_NAME}, verifica di parlare con la persona giusta, ` +
    `comunica data, orario e luogo dell'appuntamento, chiedi conferma della presenza. ` +
    `Se il cliente chiede di spostare l'appuntamento, prendi nota della preferenza e comunica che verrà ricontattato per la nuova data. ` +
    `Ringrazia e saluta prima di chiudere la chiamata.`,
  ].filter(line => line !== null).join('\n');

  const payload: Record<string, unknown> = {
    from_number: RETELL_FROM_NUMBER,
    to_number: toNumber,
    retell_llm_dynamic_variables: {
      company_name: COMPANY_NAME,
      client_name: clientName || 'cliente',
      appointment_date: dateSpoken || 'da definire',
      appointment_time: startTime || 'da definire',
      appointment_time_spoken: timeSpoken,
      appointment_end_time: endTime || '',
      appointment_address: address || '',
      appointment_notes: notes || '',
      call_script: callScript,
    },
    metadata: {
      source: 'optiroute',
      appointment_date: date || '',
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
