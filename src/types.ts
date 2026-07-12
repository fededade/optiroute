export interface Coordinates {
  lat: number;
  lng: number;
}

// 'proposed'  = data/ora ipotizzate dallo smistamento automatico, da confermare.
// 'issue'     = pratica con problematica (numero errato, da richiamare, lavori).
// 'cancelled' = pratica annullata (archivio).
export type AppointmentStatus = 'confirmed' | 'proposed' | 'pending' | 'standby' | 'issue' | 'cancelled';

// Categorie problematiche
export type IssueType = 'wrong_phone' | 'callback' | 'works_pending';

// Status of the AI confirmation call (Retell AI)
export type CallStatus = 'calling' | 'called' | 'failed';

// Esito della conversazione (post-call analysis Retell, via polling):
// determina automaticamente lo stato della pratica.
export type CallOutcomeResult =
  | 'confermato'           // il cliente ha confermato l'appuntamento
  | 'riprogrammare'        // chiede un'altra data/orario
  | 'da_richiamare'        // chiede di essere ricontattato più avanti
  | 'numero_errato'        // il numero non corrisponde al cliente
  | 'lavori_non_ultimati'  // immobile non pronto: sopralluogo rimandato
  | 'annullato'            // il sopralluogo non serve più (pratica annullata)
  | 'rifiutato'            // rifiuta l'appuntamento proposto
  | 'altro_referente'      // indica un'altra persona da contattare
  | 'non_risposto'         // nessuna risposta / segreteria / non raggiungibile
  | 'sconosciuto';         // esito non classificabile: verifica manuale

export interface CallOutcome {
  result: CallOutcomeResult;
  requestedDate?: string;    // data chiesta dal cliente (testo libero dall'AI)
  requestedTime?: string;    // orario chiesto dal cliente
  followUpDate?: string;     // data di rientro normalizzata YYYY-MM-DD, se estraibile
  clientNotes?: string;      // annotazioni raccolte in chiamata
  newContactName?: string;   // referente alternativo indicato dal cliente
  newContactPhone?: string;
  newContactRole?: string;
  summary?: string;          // riassunto AI della conversazione
  sentiment?: string;
  receivedAt: string;        // ISO timestamp di ricezione esito
}

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
  approximate?: boolean; // Indirizzo esatto non trovato: coordinate al centro del comune

  // Problematiche e rientri
  issueType?: IssueType;  // valorizzato quando status === 'issue'
  followUpDate?: string;  // YYYY-MM-DD: data richiamo / fine lavori prevista

  // Dati pratica (perizie MISI/Prelios)
  shortAddress?: string;  // indirizzo breve "via civico" per la chiamata
  periziaCode?: string;   // codice pratica (merge/update in import)
  project?: string;       // progetto/committente della pratica
  contactPerson?: string; // referente alternativo da contattare (nome + ruolo)
  referredBy?: string;    // chi ha indicato il referente (intestatario originario)

  // Client & appointment details
  phone?: string;           // Client phone number for the AI confirmation call
  notes?: string;           // Free notes, also passed to the AI operator
  durationMinutes?: number; // Custom appointment duration (default 20)

  // AI call tracking
  callStatus?: CallStatus;
  callId?: string;   // Retell call id
  calledAt?: string; // ISO timestamp of last call attempt
  callOutcome?: CallOutcome; // esito della conversazione (arriva col polling)
  callSummary?: string;      // riassunto AI della chiamata (copia comoda per la UI)
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
