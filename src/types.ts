export interface Coordinates {
  lat: number;
  lng: number;
}

// 'proposed' = data/ora ipotizzate dallo smistamento automatico,
// in attesa di conferma da parte dell'operatore.
// 'issue' = pratica con problematica (vedi issueType), esclusa dalla pianificazione
// finché non torna "in attesa". 'cancelled' = pratica annullata (solo archivio).
export type AppointmentStatus = 'confirmed' | 'proposed' | 'pending' | 'standby' | 'issue' | 'cancelled';

// Categorie delle pratiche con problematiche
export type IssueType = 'wrong_phone' | 'callback' | 'works_pending';

// Status of the AI confirmation call (Retell AI)
export type CallStatus = 'calling' | 'called' | 'failed';

// Esito della chiamata rilevato automaticamente dalla post-call analysis
// di Retell (o registrato a mano dalla finestra di chiamata).
export type CallOutcome =
  | 'confirmed'      // il cliente ha confermato l'appuntamento
  | 'callback'       // chiede di essere richiamato (followUpDate se indicata)
  | 'wrong_phone'    // numero errato / persona sbagliata
  | 'works_pending'  // immobile non pronto / lavori da ultimare
  | 'cancelled'      // pratica annullata dal cliente
  | 'no_answer'      // nessuna risposta / segreteria
  | 'unknown';       // esito non determinabile: verificare a mano

export interface Appointment {
  id: string;
  address: string;
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
  date?: string; // YYYY-MM-DD, relevant if status is 'confirmed' or 'proposed'

  // Multi-technician management
  technicianId?: string; // Tecnico assegnato (per zona di competenza o manualmente)
  province?: string;     // Sigla provincia (es. "MI"), da Excel o dal geocoding
  comune?: string;       // Comune, quando noto
  urgent?: boolean;      // Tag "urgente": priorità nello smistamento e annuncio in chiamata

  // Gestione problematiche (status === 'issue')
  issueType?: IssueType;  // Categoria della problematica
  followUpDate?: string;  // YYYY-MM-DD: data richiamo / fine lavori prevista. Lo
                          // smistamento non propone mai date precedenti; dal giorno
                          // prima compare l'alert "slot da riservare".

  // Client & appointment details
  phone?: string;           // Client phone number for the AI confirmation call
  notes?: string;           // Free notes, also passed to the AI operator
  durationMinutes?: number; // Custom appointment duration (default 20)

  // AI call tracking
  callStatus?: CallStatus;
  callId?: string;   // Retell call id
  calledAt?: string; // ISO timestamp of last call attempt
  callOutcome?: CallOutcome; // Esito (auto da post-call analysis Retell)
  callSummary?: string;      // Riassunto AI della conversazione
}

// --- Tecnici / soggetti che effettuano i sopralluoghi ---

// Zona circolare di competenza: comuni entro un raggio da un centro
// (es. Stradella, Broni, Varzi entro 15 km).
export interface TechnicianArea {
  id: string;
  label: string;      // Nome leggibile, es. "Stradella"
  center: Coordinates;
  radiusKm: number;
}

// Periodo di indisponibilità (giornata intera o fascia oraria).
export interface TechnicianUnavailability {
  id: string;
  from: string;       // YYYY-MM-DD (inizio)
  to?: string;        // YYYY-MM-DD (fine, opzionale: default = from)
  allDay: boolean;
  startTime?: string; // HH:MM, se non allDay
  endTime?: string;   // HH:MM, se non allDay
  reason?: string;
}

export interface Technician {
  id: string;
  name: string;
  color: string;            // Colore su mappa/badge
  active: boolean;
  provinces: string[];      // Province di competenza (sigla o nome, es. "MI", "Novara")
  areas: TechnicianArea[];  // Zone circolari (centro + raggio km)
  baseAddress?: string;     // Punto di partenza
  baseCoords?: Coordinates;
  workStart: string;        // Orario di partenza dalla base (HH:MM)
  workEnd: string;          // Fine giornata (HH:MM)
  unavailability: TechnicianUnavailability[];
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
  address?: NominatimAddress;
}

// Campi di addressdetails=1 utili per provincia/comune (Italia)
export interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  hamlet?: string;
  county?: string;
  province?: string;
  state_district?: string;
  state?: string;
  postcode?: string;
  country_code?: string;
  'ISO3166-2-lvl6'?: string;
  [key: string]: string | undefined;
}
