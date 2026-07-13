import type { VercelRequest, VercelResponse } from '@vercel/node';

// Esito di una chiamata Retell (post-call analysis), normalizzato per il frontend.
//
// Sull'agente Retell va configurata la Post-Call Analysis con questi campi
// custom (vedi README — sono accettati anche i vecchi alias):
//   esito_appuntamento     -> confermato | riprogrammare | da_richiamare |
//                             numero_errato | lavori_non_ultimati | annullato |
//                             rifiutato | altro_referente | non_risposto
//   nuova_data_richiesta   -> testo libero (se riprogrammare)
//   nuovo_orario_richiesto -> testo libero (se riprogrammare)
//   data_rientro           -> data richiamo / fine lavori (AAAA-MM-GG o GG/MM)
//   nuovo_referente_nome / nuovo_referente_telefono / nuovo_referente_ruolo
//   note_cliente           -> testo libero

const RETELL_API_KEY = process.env.RETELL_API_KEY || '';

type OutcomeResult =
  | 'confermato' | 'riprogrammare' | 'da_richiamare' | 'numero_errato'
  | 'lavori_non_ultimati' | 'annullato' | 'rifiutato' | 'altro_referente'
  | 'non_risposto' | 'sconosciuto';

const pickString = (obj: Record<string, unknown> | undefined, keys: string[]): string | undefined => {
  if (!obj) return undefined;
  // Case/format-insensitive key lookup (esito_appuntamento vs "Esito Appuntamento")
  const normalized: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    normalized[k.toLowerCase().replace(/[\s-]+/g, '_')] = obj[k];
  }
  for (const key of keys) {
    const v = normalized[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
};

const classifyOutcome = (
  raw: string | undefined,
  inVoicemail: boolean,
  disconnectionReason: string,
  hasNewContact: boolean,
): OutcomeResult => {
  if (raw) {
    const v = raw.toLowerCase();
    // ORDINE IMPORTANTE: l'esito arriva come testo libero dell'LLM, quindi i
    // casi negativi/di spostamento vanno valutati PRIMA del match su "conferm"
    // ("non confermato", "rifiuta di confermare", "da riconfermare con nuova
    // data" NON sono conferme).
    if (v.includes('altro_referente') || v.includes('contattare_altro') || v.includes('altro referente') || v.includes('altra persona') || v.includes('deleg')) return 'altro_referente';
    if (v.includes('riprogramm') || v.includes('sposta') || v.includes('cambi') || v.includes('altro orario') || v.includes('altra data') || v.includes('nuova data') || v.includes('nuovo orario') || v.includes('reschedul')) return 'riprogrammare';
    if (v.includes('richiam') || v.includes('ricontatt') || v.includes('callback')) return 'da_richiamare';
    if (v.includes('numero_errato') || v.includes('wrong') || (v.includes('numero') && (v.includes('errat') || v.includes('sbagliat')))) return 'numero_errato';
    if (v.includes('lavori_non_ultimati') || v.includes('lavor') || v.includes('ultimat') || v.includes('non pronto') || v.includes('cantiere')) return 'lavori_non_ultimati';
    if (v.includes('annull') || v.includes('disdet') || v.includes('non serve') || v.includes('vendita salt')) return 'annullato';
    if (v.includes('rifiut') || v.includes('declin') || v.includes('non vuole') || v.includes('non interessat')) return 'rifiutato';
    if (v.includes('non risp') || v.includes('no_answer') || v.includes('nessuna_risposta') || v.includes('non_raggiunto') || v.includes('segreteria') || v.includes('voicemail') || v.includes('irraggiungibile') || v.includes('occupato')) return 'non_risposto';
    if (/non\s+(ha\s+|è\s+stato\s+|e'\s+stato\s+)?conferm/.test(v)) return 'sconosciuto'; // ambiguo: lo valuta l'operatore
    if (v.includes('conferm')) return 'confermato';
  }
  // Nessun esito esplicito ma l'agente ha raccolto un nuovo contatto:
  // il cliente ha indicato un'altra persona da chiamare
  if (hasNewContact) return 'altro_referente';
  if (inVoicemail || disconnectionReason === 'voicemail_reached' || disconnectionReason === 'machine_detected') return 'non_risposto';
  if (disconnectionReason === 'dial_no_answer' || disconnectionReason === 'dial_busy' || disconnectionReason === 'dial_failed') return 'non_risposto';
  return 'sconosciuto';
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!RETELL_API_KEY) {
    return res.status(500).json({ error: 'RETELL_API_KEY non configurata.' });
  }

  const rawId = typeof req.query.callId === 'string' ? req.query.callId
    : typeof req.query.id === 'string' ? req.query.id : '';
  const callId = rawId.trim();
  if (!callId || !/^[\w-]+$/.test(callId)) {
    return res.status(400).json({ error: 'Parametro callId mancante o non valido.' });
  }

  try {
    const response = await fetch(`https://api.retellai.com/v2/get-call/${encodeURIComponent(callId)}`, {
      headers: { 'Authorization': `Bearer ${RETELL_API_KEY}` },
    });

    const data: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.message || data?.error || `Errore Retell (${response.status})`,
      });
    }

    const callStatus: string = data.call_status || 'unknown';

    // Call not finished yet: report pending, the client keeps polling.
    // NOTA: 'not_connected' è uno stato TERMINALE (occupato/non raggiungibile),
    // quindi NON è pending: prosegue e viene classificato come non_risposto
    // tramite disconnection_reason.
    if (callStatus === 'registered' || callStatus === 'ongoing') {
      return res.status(200).json({ pending: true, callStatus });
    }

    const analysis = data.call_analysis || {};
    const custom: Record<string, unknown> | undefined = analysis.custom_analysis_data;
    const disconnectionReason: string = data.disconnection_reason || '';
    const inVoicemail: boolean = !!data.in_voicemail || analysis.in_voicemail === true;

    // Chiamata mai partita (errore di composizione): esito terminale immediato
    if (callStatus === 'error') {
      const result: OutcomeResult = /invalid_destination|invalid_number/.test(disconnectionReason)
        ? 'numero_errato'
        : 'non_risposto';
      return res.status(200).json({
        pending: false,
        callStatus,
        disconnectionReason,
        outcome: { result, summary: 'Chiamata non riuscita (errore telefonico).' },
      });
    }

    // Analysis may lag a few seconds behind call end
    if (callStatus === 'ended' && !analysis.call_summary && !custom) {
      return res.status(200).json({ pending: true, callStatus, analysisPending: true });
    }

    const rawEsito = pickString(custom, ['esito_appuntamento', 'esito_chiamata', 'esito', 'appointment_outcome', 'outcome']);
    const newContactName = pickString(custom, ['nuovo_referente_nome', 'referente_nome', 'new_contact_name']);
    const newContactPhone = pickString(custom, ['nuovo_referente_telefono', 'referente_telefono', 'new_contact_phone']);
    const newContactRole = pickString(custom, ['nuovo_referente_ruolo', 'referente_ruolo', 'new_contact_role']);
    const result = classifyOutcome(rawEsito, inVoicemail, disconnectionReason, !!newContactPhone);

    return res.status(200).json({
      pending: false,
      callStatus,
      disconnectionReason,
      outcome: {
        result,
        requestedDate: pickString(custom, ['nuova_data_richiesta', 'data_richiesta', 'data_preferita', 'nuova_data', 'requested_date']),
        requestedTime: pickString(custom, ['nuovo_orario_richiesto', 'orario_richiesto', 'orario_preferito', 'requested_time']),
        followUpRaw: pickString(custom, ['data_rientro', 'data_richiamo', 'follow_up_date']),
        clientNotes: pickString(custom, ['note_cliente', 'note', 'client_notes']),
        newContactName,
        newContactPhone,
        newContactRole,
        summary: typeof analysis.call_summary === 'string' ? analysis.call_summary : undefined,
        sentiment: typeof analysis.user_sentiment === 'string' ? analysis.user_sentiment : undefined,
      },
    });
  } catch (error) {
    console.error('call-status error:', error);
    return res.status(500).json({ error: 'Impossibile recuperare lo stato della chiamata.' });
  }
}
