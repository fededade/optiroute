export interface Coordinates {
  lat: number;
  lng: number;
}

export type AppointmentStatus = 'confirmed' | 'pending' | 'standby';

// Status of the AI confirmation call (Retell AI)
export type CallStatus = 'calling' | 'called' | 'failed';

// Outcome of the AI confirmation call, extracted from Retell post-call analysis
export type CallOutcomeResult =
  | 'confermato'       // client confirmed the appointment
  | 'rifiutato'        // client declined
  | 'riprogrammare'    // client asked for a different date/time
  | 'altro_referente'  // client indicated another person to contact (geometra, agente...)
  | 'non_risposto'     // no answer / voicemail
  | 'sconosciuto';     // call ended but outcome not classifiable

export interface CallOutcome {
  result: CallOutcomeResult;
  requestedDate?: string;  // free text from the client (e.g. "lunedì prossimo")
  requestedTime?: string;  // free text (e.g. "dopo le 15")
  clientNotes?: string;
  // Referral: the correct person to contact, as reported by the client
  newContactName?: string;
  newContactPhone?: string;
  newContactRole?: string; // es. "geometra di cantiere", "agente immobiliare"
  summary?: string;        // Retell call_summary
  sentiment?: string;      // Positive | Negative | Neutral | Unknown
  receivedAt: string;      // ISO timestamp
}

export interface Appointment {
  id: string;
  address: string;       // indirizzo completo geocodificato (display name)
  shortAddress?: string; // via + civico originali (per il gestionale)
  comune?: string;       // comune originale (per il gestionale)
  title: string;
  coords: Coordinates;
  sequenceOrder?: number;
  startTime?: string; // Formatted HH:MM
  endTime?: string;   // Formatted HH:MM
  travelTimeFromPrev?: number; // In minutes
  distanceFromPrev?: number; // In km
  hasLunchBreakBefore?: boolean; // Indicates if lunch break happens before this appointment

  // New fields for status management
  status: AppointmentStatus;
  date?: string; // YYYY-MM-DD, relevant if status is 'confirmed'

  // Client & appointment details
  phone?: string;           // Client phone number for the AI confirmation call
  notes?: string;           // Free notes, also passed to the AI operator
  durationMinutes?: number; // Custom appointment duration (default 20)

  // Pratica/perizia linkage (MISI / Prelios workflow)
  periziaCode?: string;     // Codice pratica/perizia (e.g. "826361")
  project?: string;         // Progetto/commessa (e.g. "01-09546 (INTESA SANPAOLO)")

  // Referral: when the person to call is NOT the client (intestatario)
  contactPerson?: string;   // chi va contattato (es. "Geom. Bianchi - geometra di cantiere")
  referredBy?: string;      // chi lo ha indicato (di solito l'intestatario)

  // AI call tracking
  callStatus?: CallStatus;
  callId?: string;   // Retell call id
  calledAt?: string; // ISO timestamp of last call attempt
  callOutcome?: CallOutcome; // Result of the confirmation call (post-call analysis)
}

export interface RouteSummary {
  totalDistance: number;
  totalTravelTime: number; // minutes (excluding meetings)
  finalEndTime: string;
}

export interface NominatimResult {
  place_id: number;
  licence: string;
  osm_type: string;
  osm_id: number;
  boundingbox: string[];
  lat: string;
  lon: string;
  display_name: string;
  class: string;
  type: string;
  importance: number;
}