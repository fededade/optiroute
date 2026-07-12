import type { VercelRequest, VercelResponse } from '@vercel/node';

// Stato/esito di una chiamata Retell: usato dal polling di OptiRoute per
// applicare automaticamente l'esito (post-call analysis) alla pratica.
// Richiede RETELL_API_KEY (stessa di api/retell-call.ts).

const RETELL_API_KEY = process.env.RETELL_API_KEY || '';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!RETELL_API_KEY) {
    return res.status(500).json({ error: 'RETELL_API_KEY non configurata.' });
  }

  const callId = String(req.query.callId || '');
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(callId)) {
    return res.status(400).json({ error: 'callId mancante o non valido.' });
  }

  try {
    const response = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
    });

    const data: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Retell get-call error:', response.status, data);
      return res.status(response.status).json({
        error: data?.message || data?.error || `Errore Retell (${response.status})`,
      });
    }

    // Risposta compatta: l'interpretazione dell'esito avviene lato client
    return res.status(200).json({
      callStatus: data.call_status,                                // registered | ongoing | ended | error
      analyzed: !!data.call_analysis,                              // la post-call analysis è pronta
      disconnectionReason: data.disconnection_reason || '',
      inVoicemail: data.call_analysis?.in_voicemail === true,
      callSuccessful: data.call_analysis?.call_successful,
      summary: data.call_analysis?.call_summary || '',
      custom: data.call_analysis?.custom_analysis_data || {},
    });
  } catch (error) {
    console.error('Retell call-status error:', error);
    return res.status(500).json({ error: 'Impossibile leggere lo stato della chiamata.' });
  }
}
