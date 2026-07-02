export interface Coordinates {
  lat: number;
  lng: number;
}

export type AppointmentStatus = 'confirmed' | 'pending' | 'standby';

// Status of the AI confirmation call (Retell AI)
export type CallStatus = 'calling' | 'called' | 'failed';

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
  date?: string; // YYYY-MM-DD, relevant if status is 'confirmed'

  // Client & appointment details
  phone?: string;           // Client phone number for the AI confirmation call
  notes?: string;           // Free notes, also passed to the AI operator
  durationMinutes?: number; // Custom appointment duration (default 20)

  // AI call tracking
  callStatus?: CallStatus;
  callId?: string;   // Retell call id
  calledAt?: string; // ISO timestamp of last call attempt
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