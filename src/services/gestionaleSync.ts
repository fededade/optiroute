import type { Appointment } from '../types';

// Invio dei sopralluoghi CONFERMATI al gestionale (Firestore, collection
// `optiroute_sync`, via REST). Modulo SENZA chiavi: la destinazione arriva da
// chi chiama (il browser la prende da syncService, il motore lato server
// dalle variabili d'ambiente).

export interface SyncTarget {
  projectId: string;
  apiKey: string;
}

// Un sopralluogo è sincronizzabile SOLO se davvero confermato:
// - è nel giro (confermato, con data e orario calcolati)
// - il cliente ha confermato alla chiamata AI, oppure non c'è telefono
//   (nessuna chiamata possibile: fa fede la conferma dell'operatore)
// Restano fuori: in attesa, stand-by, rifiutati, da riprogrammare,
// non risposto, esiti da verificare e chiamate ancora senza esito.
export const isSyncable = (a: Appointment): boolean => {
  if (a.status !== 'confirmed' || !a.date || !a.startTime) return false;
  if (a.callOutcome?.result === 'confermato') return true;
  if (!a.phone) return true;
  return false;
};

export const getSyncableAppointments = (appointments: Appointment[]): Appointment[] =>
  appointments.filter(isSyncable);

// --- Encoding Firestore REST ---
const fsString = (v: string) => ({ stringValue: v });
const fsInt = (v: number) => ({ integerValue: String(Math.round(v)) });
const fsDouble = (v: number) => ({ doubleValue: v });
const fsBool = (v: boolean) => ({ booleanValue: v });

const toFirestoreFields = (a: Appointment) => {
  const giornoIt = a.date
    ? new Date(`${a.date}T00:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: '2-digit' })
    : '';
  return {
    codice: fsString(a.periziaCode || ''),
    cliente: fsString(a.title),
    telefono: fsString(a.phone || ''),
    referente: fsString(a.contactPerson || ''),
    indirizzo: fsString(a.shortAddress || a.address),
    indirizzo_completo: fsString(a.address),
    comune: fsString(a.comune || ''),
    data: fsString(a.date || ''),
    giorno: fsString(giornoIt),
    ora_inizio: fsString(a.startTime || ''),
    ora_fine: fsString(a.endTime || ''),
    ordine: fsInt(a.sequenceOrder || 0),
    progetto: fsString(a.project || ''),
    note: fsString(a.notes || ''),
    esito: fsString(a.callOutcome?.result || (a.phone ? '' : 'senza_telefono')),
    lat: fsDouble(a.coords.lat),
    lng: fsDouble(a.coords.lng),
    origine: fsString('optiroute'),
    importato: fsBool(false),
    aggiornato_il: fsString(new Date().toISOString()),
  };
};

export interface SyncResult {
  sent: number;
  failed: number;
  errors: string[];
  envName: string;
}

// Upsert di ogni sopralluogo confermato in optiroute_sync/{docId}.
// docId = codice pratica (o id appuntamento se manca), così i re-sync
// aggiornano lo stesso documento invece di duplicare.
export const pushConfirmedToFirestore = async (
  appointments: Appointment[],
  target: SyncTarget,
  envName: string
): Promise<SyncResult> => {
  const syncable = getSyncableAppointments(appointments);
  const result: SyncResult = { sent: 0, failed: 0, errors: [], envName };

  for (const appt of syncable) {
    const docId = (appt.periziaCode || `app_${appt.id}`).replace(/[^\w-]/g, '_');
    const url =
      `https://firestore.googleapis.com/v1/projects/${target.projectId}` +
      `/databases/(default)/documents/optiroute_sync/${docId}?key=${target.apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: toFirestoreFields(appt) }),
      });
      if (response.ok) {
        result.sent++;
      } else {
        const text = await response.text().catch(() => '');
        result.failed++;
        result.errors.push(`${appt.title}: HTTP ${response.status} ${text.slice(0, 120)}`);
      }
    } catch (error: any) {
      result.failed++;
      result.errors.push(`${appt.title}: ${error?.message || 'errore di rete'}`);
    }
  }

  return result;
};
