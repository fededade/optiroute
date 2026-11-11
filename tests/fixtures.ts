import type { Appointment, CallOutcome, Coordinates, Technician } from '../src/types';
import type { PlanningFallback } from '../src/services/slotService';
import { DEFAULT_AUTOPILOT_SETTINGS, type AutopilotSettings, type PlanningContext } from '../src/services/autopilotService';

// Dati sintetici: coordinate reali di comuni lombardi, nessun dato personale.
export const P: Record<string, Coordinates> = {
  milano: { lat: 45.4642, lng: 9.19 },
  portaVenezia: { lat: 45.4746, lng: 9.205 },
  cityLife: { lat: 45.4777, lng: 9.1546 },
  navigli: { lat: 45.4520, lng: 9.1760 },
  assago: { lat: 45.408, lng: 9.125 },
  sesto: { lat: 45.5353, lng: 9.2337 },
  cinisello: { lat: 45.5558, lng: 9.2149 },
  segrate: { lat: 45.4904, lng: 9.2955 },
  rho: { lat: 45.528, lng: 9.04 },
  monza: { lat: 45.5845, lng: 9.2744 },
  lodi: { lat: 45.3097, lng: 9.5037 },
  pavia: { lat: 45.1847, lng: 9.1582 },
  bergamo: { lat: 45.6983, lng: 9.6773 },
};

export const tech = (over: Partial<Technician> = {}): Technician => ({
  id: 'tech-1',
  name: 'Tecnico Uno',
  color: '#2563eb',
  active: true,
  provinces: ['MI'],
  areas: [],
  baseCoords: P.milano,
  workStart: '08:30',
  workEnd: '18:00',
  unavailability: [],
  ...over,
});

export const FALLBACK: PlanningFallback = { start: '08:30', end: '18:00', base: P.milano };

let seq = 0;
export const appt = (over: Partial<Appointment> = {}): Appointment => {
  seq += 1;
  return {
    id: over.id || `a${seq}`,
    address: `Via Esempio ${seq}, Milano`,
    title: over.title || `Pratica ${over.id || seq}`,
    coords: P.milano,
    status: 'pending',
    province: 'MI',
    ...over,
  };
};

// Ogni tappa ha un telefono diverso, come nella realtà (il pilota non chiama
// due volte insieme lo stesso numero)
let phoneSeq = 0;
const nextPhone = (): string => {
  phoneSeq += 1;
  return `+39020${String(phoneSeq).padStart(7, '0')}`;
};

// Tappa nel giro
export const stop = (
  id: string,
  date: string,
  start: string,
  end: string,
  coords: Coordinates,
  over: Partial<Appointment> = {}
): Appointment =>
  appt({ id, status: 'proposed', date, startTime: start, endTime: end, coords, technicianId: 'tech-1', phone: nextPhone(), ...over });

export const outcome = (result: CallOutcome['result'], over: Partial<CallOutcome> = {}): CallOutcome => ({
  result,
  receivedAt: '2026-11-11T10:05:00.000Z',
  ...over,
});

// Mercoledì 11/11/2026, ora locale
export const at = (date: string, hhmm: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
};

export const planning = (
  now: Date,
  settings: Partial<AutopilotSettings> = {},
  technicians: Technician[] = [tech()]
): PlanningContext => ({
  technicians,
  fallback: FALLBACK,
  settings: { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true, ...settings },
  now,
});

// Copia profonda + riferimenti, per verificare la purezza
export const snapshot = (all: Appointment[]) => ({
  json: JSON.parse(JSON.stringify(all)),
  refs: [...all],
});
