import type { Appointment, CallOutcome } from '../types';

// Client for the /api/retell-call serverless endpoint (Retell AI outbound call)
// e per /api/call-status (esito della conversazione via polling).

export interface CallResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

export const startConfirmationCall = async (
  appointment: Appointment,
  technicianName?: string,
  daySchedule?: string
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
        shortAddress: appointment.shortAddress,
        comune: appointment.comune,
        notes: appointment.notes,
        urgent: appointment.urgent === true,
        technicianName: technicianName || undefined,
        periziaCode: appointment.periziaCode,
        project: appointment.project,
        contactPerson: appointment.contactPerson,
        referredBy: appointment.referredBy,
        daySchedule: daySchedule || undefined,
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

export interface CallOutcomePoll {
  pending: boolean;      // true: chiamata/analisi non conclusa, si continua a interrogare
  outcome?: CallOutcome; // presente quando pending === false
  error?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

// Data indicata dal cliente: accetta YYYY-MM-DD, GG/MM/AAAA o GG/MM.
// Senza anno si sceglie la prossima occorrenza futura (un richiamo è sempre avanti).
export const parseFollowUpDate = (raw: string): string | undefined => {
  if (!raw) return undefined;

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const m = parseInt(iso[2], 10);
    const d = parseInt(iso[3], 10);
    const date = new Date(y, m - 1, d);
    if (date.getMonth() === m - 1 && date.getDate() === d) return `${y}-${pad(m)}-${pad(d)}`;
    return undefined;
  }

  const dmy = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(raw);
  if (!dmy) return undefined;
  const d = parseInt(dmy[1], 10);
  const m = parseInt(dmy[2], 10);
  if (d < 1 || d > 31 || m < 1 || m > 12) return undefined;

  const today = new Date();
  let y: number;
  if (dmy[3]) {
    y = parseInt(dmy[3], 10);
    if (y < 100) y += 2000;
  } else {
    y = today.getFullYear();
    const candidate = new Date(y, m - 1, d);
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (candidate < startOfToday) y += 1;
  }
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
};

// Interroga /api/call-status. Su errori transitori (rete, 429, 5xx) ritorna
// pending: il polling riproverà; il taglio a "sconosciuto" dopo la finestra
// massima lo decide il chiamante.
export const fetchCallOutcome = async (callId: string): Promise<CallOutcomePoll> => {
  try {
    const response = await fetch(`/api/call-status?callId=${encodeURIComponent(callId)}`);

    if (!response.ok) {
      return { pending: true, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    if (data.pending || !data.outcome) {
      return { pending: true };
    }

    const o = data.outcome;
    const followUpDate =
      parseFollowUpDate(`${o.followUpRaw || ''}`) ||
      ((o.result === 'da_richiamare' || o.result === 'lavori_non_ultimati')
        ? parseFollowUpDate(`${o.requestedDate || ''}`)
        : undefined);

    const outcome: CallOutcome = {
      result: o.result || 'sconosciuto',
      requestedDate: o.requestedDate || undefined,
      requestedTime: o.requestedTime || undefined,
      followUpDate,
      clientNotes: o.clientNotes || undefined,
      newContactName: o.newContactName || undefined,
      newContactPhone: o.newContactPhone || undefined,
      newContactRole: o.newContactRole || undefined,
      summary: o.summary || undefined,
      sentiment: o.sentiment || undefined,
      receivedAt: new Date().toISOString(),
    };

    return { pending: false, outcome };
  } catch (error) {
    console.error('Call status polling error:', error);
    return { pending: true, error: 'network' }; // transitorio: si riprova
  }
};
