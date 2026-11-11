import type { AlternativeLabel, AlternativeSlot, Appointment, CallOutcome } from '../types';
import { loadCloudSettings } from './cloudSettings';

// Client for the /api/retell-call serverless endpoint (Retell AI outbound call)
// e per /api/call-status (esito della conversazione via polling).

// Chiave di accesso del cloud (se l'operatore l'ha inserita nelle
// impostazioni): quando sul server è configurata, le API delle chiamate la
// richiedono, così nessun altro può far partire telefonate.
const cloudAuthHeaders = (): Record<string, string> => {
  const key = loadCloudSettings().key;
  return key ? { Authorization: `Bearer ${key}` } : {};
};

export interface CallResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

export const startConfirmationCall = async (
  appointment: Appointment,
  technicianName?: string,
  daySchedule?: string,
  // Slot alternativi reali che l'agente può offrire (e fissare) se il cliente
  // rifiuta la proposta principale
  alternatives?: AlternativeSlot[]
): Promise<CallResult> => {
  if (!appointment.phone) {
    return { ok: false, error: 'Nessun numero di telefono per questo appuntamento.' };
  }

  try {
    const response = await fetch('/api/retell-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cloudAuthHeaders() },
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
        alternatives: alternatives && alternatives.length > 0 ? alternatives : undefined,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      return { ok: false, error: 'Chiave di accesso mancante o errata: inseriscila nelle impostazioni del pilota (⚙ → Cloud).' };
    }
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
    const response = await fetch(`/api/call-status?callId=${encodeURIComponent(callId)}`, {
      headers: cloudAuthHeaders(),
    });

    if (!response.ok) {
      return { pending: true, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    if (data.pending || !data.outcome) {
      return { pending: true };
    }

    return { pending: false, outcome: toCallOutcome(data.outcome) };
  } catch (error) {
    console.error('Call status polling error:', error);
    return { pending: true, error: 'network' }; // transitorio: si riprova
  }
};

// Esito normalizzato di /api/call-status -> CallOutcome dell'app (data di
// rientro interpretata, alternativa scelta validata). Usata dal browser e dal
// motore lato server.
export const toCallOutcome = (o: any, now: Date = new Date()): CallOutcome => {
  // NB: con esito "confermato" (es. alternativa accettata) la data richiesta
  // NON diventa una data di rientro: resta solo in requestedDate
  const followUpDate =
    parseFollowUpDate(`${o.followUpRaw || ''}`) ||
    ((o.result === 'da_richiamare' || o.result === 'lavori_non_ultimati' || o.result === 'riprogrammare')
      ? parseFollowUpDate(`${o.requestedDate || ''}`)
      : undefined);

  // Alternativa accettata in chiamata: solo se è davvero una delle tre etichette
  const chosenAlternative: AlternativeLabel | undefined =
    o.chosenAlternative === 'A' || o.chosenAlternative === 'B' || o.chosenAlternative === 'C'
      ? o.chosenAlternative
      : undefined;

  return {
    result: o.result || 'sconosciuto',
    requestedDate: o.requestedDate || undefined,
    requestedTime: o.requestedTime || undefined,
    chosenAlternative,
    followUpDate,
    clientNotes: o.clientNotes || undefined,
    newContactName: o.newContactName || undefined,
    newContactPhone: o.newContactPhone || undefined,
    newContactRole: o.newContactRole || undefined,
    summary: o.summary || undefined,
    sentiment: o.sentiment || undefined,
    receivedAt: now.toISOString(),
  };
};
