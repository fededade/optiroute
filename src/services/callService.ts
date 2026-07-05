import type { Appointment, CallOutcome } from '../types';

// Client for the /api/retell-call and /api/call-status serverless endpoints.

export interface CallResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

export const startConfirmationCall = async (appointment: Appointment): Promise<CallResult> => {
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
        shortAddress: appointment.shortAddress,
        comune: appointment.comune,
        notes: appointment.notes,
        periziaCode: appointment.periziaCode,
        project: appointment.project,
        contactPerson: appointment.contactPerson,
        referredBy: appointment.referredBy,
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

// Poll the outcome of a finished call. Returns:
//  - { pending: true }            call still in progress / analysis not ready
//  - { pending: false, outcome }  final outcome available
//  - { error }                    unrecoverable error (stop polling)
export interface CallOutcomePoll {
  pending: boolean;
  outcome?: CallOutcome;
  error?: string;
}

export const fetchCallOutcome = async (callId: string): Promise<CallOutcomePoll> => {
  try {
    const response = await fetch(`/api/call-status?callId=${encodeURIComponent(callId)}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // Errori transitori (rate limit, gateway/serverless 5xx): continua il
      // polling invece di congelare l'esito a "sconosciuto".
      if (response.status === 429 || response.status >= 500) {
        return { pending: true };
      }
      return { pending: false, error: data?.error || `Errore server (${response.status})` };
    }

    if (data.pending) return { pending: true };

    const o = data.outcome || {};
    return {
      pending: false,
      outcome: {
        result: o.result || 'sconosciuto',
        requestedDate: o.requestedDate,
        requestedTime: o.requestedTime,
        clientNotes: o.clientNotes,
        newContactName: o.newContactName,
        newContactPhone: o.newContactPhone,
        newContactRole: o.newContactRole,
        summary: o.summary,
        sentiment: o.sentiment,
        receivedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.error('Call outcome poll error:', error);
    // Network hiccup: keep polling
    return { pending: true };
  }
};
