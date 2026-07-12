import type { Appointment, CallOutcome } from '../types';

// Client for the /api/retell-call serverless endpoint (Retell AI outbound call).

export interface CallResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

export const startConfirmationCall = async (
  appointment: Appointment,
  technicianName?: string
): Promise<CallResult> => {
  if (!appointment.phone) {
    return { ok: false, error: 'Nessun numero di telefono per questo appuntamento.' };
  }

  try {
    const response = await fetch('/api/retell-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: appointment.phone,
        clientName: appointment.title,
        date: appointment.date,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        address: appointment.address,
        notes: appointment.notes,
        urgent: appointment.urgent === true,
        technicianName: technicianName || undefined,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { ok: false, error: data?.error || `Errore server (${response.status})` };
    }

    return { ok: true, callId: data.callId };
  } catch (error) {
    console.error('Call service error:', error);
    return { ok: false, error: 'Errore di rete: impossibile contattare il server delle chiamate.' };
  }
};

// --- Esito chiamata (polling di /api/call-status) ---

export interface CallStatusInfo {
  ended: boolean;            // la chiamata è terminata (esito disponibile)
  outcome?: CallOutcome;
  preferredDate?: string;    // preferenza del cliente se chiede di spostare
  summary?: string;          // riassunto AI della conversazione
}

// Traduce l'analisi post-chiamata Retell in un esito per la pratica.
// Priorità al campo personalizzato "esito_appuntamento" (configurato
// sull'agente, vedi README); in mancanza usa segnali standard
// (segreteria, mancata risposta) e altrimenti chiede verifica manuale.
const mapOutcome = (d: any): { outcome: CallOutcome; preferredDate?: string; summary?: string } => {
  const custom = d.custom || {};
  const esito = `${custom.esito_appuntamento ?? custom.esito ?? ''}`.toLowerCase();
  const preferredRaw = `${custom.data_preferita ?? custom.nuova_data ?? ''}`.trim();
  const preferredDate = preferredRaw && preferredRaw.toLowerCase() !== 'null' ? preferredRaw : undefined;
  const summary = typeof d.summary === 'string' && d.summary ? d.summary : undefined;

  let outcome: CallOutcome = 'unclear';
  if (esito.includes('conferm')) outcome = 'confirmed';
  else if (esito.includes('riprogramm') || esito.includes('sposta') || esito.includes('rimand')) outcome = 'reschedule';
  else if (esito.includes('rifiut') || esito.includes('annull') || esito.includes('disdet')) outcome = 'declined';
  else if (esito.includes('non_raggiunto') || esito.includes('non raggiunto') || esito.includes('segreteria')) outcome = 'no_answer';
  else if (d.inVoicemail === true) outcome = 'no_answer';
  else if (['dial_no_answer', 'dial_busy', 'dial_failed', 'voicemail_reached', 'machine_detected'].includes(d.disconnectionReason)) {
    outcome = 'no_answer';
  }

  return { outcome, preferredDate, summary };
};

export const fetchCallStatus = async (callId: string): Promise<CallStatusInfo | null> => {
  try {
    const response = await fetch(`/api/call-status?id=${encodeURIComponent(callId)}`);
    if (!response.ok) return null;
    const data = await response.json();

    if (data.callStatus === 'error') {
      return { ended: true, outcome: 'no_answer', summary: data.summary || 'Chiamata non riuscita (errore telefonico).' };
    }
    if (data.callStatus !== 'ended') {
      return { ended: false }; // ancora in corso: si continua il polling
    }
    return { ended: true, ...mapOutcome(data) };
  } catch (error) {
    console.error('Call status polling error:', error);
    return null; // errore di rete transitorio: riproverà il prossimo giro
  }
};
