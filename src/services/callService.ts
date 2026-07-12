import type { Appointment, CallOutcome } from '../types';

// Client for the /api/retell-call serverless endpoint (Retell AI outbound call).

export interface CallResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

// --- Esito automatico della chiamata (post-call analysis) ---

export interface CallStatusResponse {
  callStatus: string;            // registered | ongoing | ended | error
  analyzed: boolean;             // post-call analysis pronta
  disconnectionReason?: string;
  inVoicemail?: boolean;
  callSuccessful?: boolean;
  summary?: string;
  custom?: Record<string, unknown>;
}

export interface CallOutcomeResult {
  outcome: CallOutcome;
  followUpDate?: string; // YYYY-MM-DD
  summary?: string;
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

export const fetchCallStatus = async (callId: string): Promise<CallStatusResponse | null> => {
  try {
    const response = await fetch(`/api/retell-call-status?callId=${encodeURIComponent(callId)}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
};

const pad = (n: number) => String(n).padStart(2, '0');

// Data indicata dal cliente: accetta YYYY-MM-DD, GG/MM/AAAA o GG/MM.
// Senza anno si sceglie la prossima occorrenza futura (un richiamo è sempre avanti).
const parseFollowUpDate = (raw: string): string | undefined => {
  if (!raw) return undefined;

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (iso) {
    const [, y, m, d] = iso.map(Number) as unknown as number[];
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

// Interpreta la risposta di /api/retell-call-status.
// Ritorna null finché la chiamata non è conclusa e analizzata (continua il polling).
// Le categorie che spostano la pratica (richiamo/numero errato/lavori/annullata)
// scattano solo dal campo esplicito `esito_chiamata` della post-call analysis
// configurata sull'agente Retell — le euristiche regolano solo il badge.
export const interpretCallOutcome = (s: CallStatusResponse): CallOutcomeResult | null => {
  // Chiamata mai riuscita (errore di composizione)
  if (s.callStatus === 'error') {
    const reason = s.disconnectionReason || '';
    if (/invalid_destination/.test(reason)) return { outcome: 'wrong_phone', summary: s.summary };
    return { outcome: 'no_answer', summary: s.summary };
  }

  if (s.callStatus !== 'ended') return null;  // ancora in corso
  if (!s.analyzed) return null;               // analisi non ancora pronta

  const custom = s.custom || {};
  const esitoRaw = `${custom['esito_chiamata'] ?? custom['esito'] ?? ''}`.toLowerCase().trim();
  const dateRaw = `${custom['data_rientro'] ?? custom['data_richiamo'] ?? ''}`.trim();
  const followUpDate = parseFollowUpDate(dateRaw);

  let outcome: CallOutcome = 'unknown';
  if (/confermat/.test(esitoRaw)) outcome = 'confirmed';
  else if (/richiam|spostare|ricontatt/.test(esitoRaw)) outcome = 'callback';
  else if (/numero|sbagliat|errat/.test(esitoRaw)) outcome = 'wrong_phone';
  else if (/lavor|ultimat|pronto/.test(esitoRaw)) outcome = 'works_pending';
  else if (/annullat/.test(esitoRaw)) outcome = 'cancelled';
  else if (/rispost|segreteria|voicemail/.test(esitoRaw)) outcome = 'no_answer';
  else if (s.inVoicemail) outcome = 'no_answer';
  else if (s.callSuccessful === true) outcome = 'confirmed';

  return { outcome, followUpDate, summary: s.summary };
};
