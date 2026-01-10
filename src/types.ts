export interface Coordinates {
  lat: number;
  lng: number;
}

export type AppointmentStatus = 'confirmed' | 'pending' | 'standby';

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