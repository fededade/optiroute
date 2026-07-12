import type { VercelRequest, VercelResponse } from '@vercel/node';

// Stato ed esito di una chiamata Retell (per il polling dal frontend).
// Riusa RETELL_API_KEY già configurata per api/retell-call.ts.
//
// Risponde con i soli campi utili all'app:
//   callStatus          -> registered | ongoing | ended | error
//   disconnectionReason -> es. dial_no_answer, voicemail_reached...
//   inVoicemail         -> true se ha risposto la segreteria
//   summary             -> riassunto AI della conversazione
//   custom              -> post-call analysis personalizzata (es. esito_appuntamento)

const RETELL_GET_CALL_URL = 'https://api.retellai.com/v2/get-call';
const RETELL_API_KEY = process.env.RETELL_API_KEY || '';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!RETELL_API_KEY) {
    return res.status(500).json({ error: 'RETELL_API_KEY non configurata.' });
  }

  const callId = typeof req.query.id === 'string' ? req.query.id : '';
  if (!callId || !/^[\w-]{6,128}$/.test(callId)) {
    return res.status(400).json({ error: 'Parametro id (call id) mancante o non valido.' });
  }

  try {
    const response = await fetch(`${RETELL_GET_CALL_URL}/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
    });

    const data: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Retell get-call error:', response.status, data);
      return res.status(response.status).json({
        error: data?.message || data?.error || `Errore Retell (${response.status})`,
      });
    }

    const analysis = data.call_analysis || {};

    return res.status(200).json({
      callStatus: data.call_status || 'registered',
      disconnectionReason: data.disconnection_reason || '',
      inVoicemail: analysis.in_voicemail === true,
      callSuccessful: analysis.call_successful === true,
      userSentiment: analysis.user_sentiment || '',
      summary: analysis.call_summary || '',
      custom: analysis.custom_analysis_data || {},
    });
  } catch (error) {
    console.error('Call status error:', error);
    return res.status(500).json({ error: 'Impossibile leggere lo stato della chiamata.' });
  }
}
