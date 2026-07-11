import type { Appointment } from '../types';

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
