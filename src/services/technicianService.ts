import type { Appointment, Coordinates, Technician, TechnicianUnavailability } from '../types';
import { calculateDistance } from '../utils/geo';
import { provinceMatches } from '../utils/provinces';

// Palette per i tecnici (scelta nel form della scheda)
export const TECHNICIAN_COLORS = [
  '#2563eb', '#9333ea', '#059669', '#dc2626',
  '#d97706', '#0891b2', '#db2777', '#65a30d',
];

const TECHNICIANS_KEY = 'optiroute_technicians_v1';

// Configurazione iniziale richiesta:
// - Omar Afifi: province di Milano e Novara
// - Federica Sala: provincia di Pavia, prevalentemente i comuni che gravitano
//   attorno a Stradella, Broni e Varzi entro ~15 km
export const defaultTechnicians = (): Technician[] => [
  {
    id: 'tech-omar',
    name: 'Omar Afifi',
    color: '#2563eb',
    active: true,
    provinces: ['MI', 'NO'],
    areas: [],
    baseAddress: undefined,
    baseCoords: undefined,
    workStart: '08:30',
    workEnd: '18:00',
    unavailability: [],
  },
  {
    id: 'tech-federica',
    name: 'Federica Sala',
    color: '#9333ea',
    active: true,
    provinces: ['PV'],
    areas: [
      { id: 'area-stradella', label: 'Stradella', center: { lat: 45.0748, lng: 9.3005 }, radiusKm: 15 },
      { id: 'area-broni', label: 'Broni', center: { lat: 45.0620, lng: 9.2610 }, radiusKm: 15 },
      { id: 'area-varzi', label: 'Varzi', center: { lat: 44.8230, lng: 9.1980 }, radiusKm: 15 },
    ],
    baseAddress: undefined,
    baseCoords: undefined,
    workStart: '08:30',
    workEnd: '18:00',
    unavailability: [],
  },
];

const safeParse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const loadTechnicians = (): Technician[] => {
  const data = safeParse<Technician[]>(localStorage.getItem(TECHNICIANS_KEY));
  if (!Array.isArray(data) || data.length === 0) return defaultTechnicians();
  return data
    .filter(t => t && t.id && t.name)
    .map(t => ({
      ...t,
      provinces: Array.isArray(t.provinces) ? t.provinces : [],
      areas: Array.isArray(t.areas) ? t.areas : [],
      unavailability: Array.isArray(t.unavailability) ? t.unavailability : [],
      workStart: t.workStart || '08:30',
      workEnd: t.workEnd || '18:00',
      active: t.active !== false,
    }));
};

export const saveTechnicians = (technicians: Technician[]): void => {
  try {
    localStorage.setItem(TECHNICIANS_KEY, JSON.stringify(technicians));
  } catch (e) {
    console.warn('Impossibile salvare i tecnici in locale', e);
  }
};

// --- Matching zona di competenza ---
// 1) Zone circolari (centro+raggio): il match più specifico vince (distanza minima).
//    Coprono anche i comuni appena fuori provincia ma dentro il raggio.
// 2) Province: se una sola corrisponde, assegnata; se più di una, vince il
//    tecnico con base/zona più vicina all'appuntamento.
export const matchTechnician = (
  appt: Pick<Appointment, 'coords' | 'province'>,
  technicians: Technician[]
): Technician | null => {
  const active = technicians.filter(t => t.active);
  if (active.length === 0) return null;

  let areaBest: { tech: Technician; dist: number } | null = null;
  for (const tech of active) {
    for (const area of tech.areas) {
      const dist = calculateDistance(appt.coords, area.center);
      if (dist <= area.radiusKm && (!areaBest || dist < areaBest.dist)) {
        areaBest = { tech, dist };
      }
    }
  }
  if (areaBest) return areaBest.tech;

  const byProvince = active.filter(t => provinceMatches(appt.province, t.provinces));
  if (byProvince.length === 1) return byProvince[0];
  if (byProvince.length > 1) {
    let best: { tech: Technician; dist: number } | null = null;
    for (const tech of byProvince) {
      const refs: Coordinates[] = [
        ...(tech.baseCoords ? [tech.baseCoords] : []),
        ...tech.areas.map(a => a.center),
      ];
      const dist = refs.length
        ? Math.min(...refs.map(r => calculateDistance(appt.coords, r)))
        : Number.MAX_SAFE_INTEGER;
      if (!best || dist < best.dist) best = { tech, dist };
    }
    return best?.tech ?? byProvince[0];
  }

  return null;
};

// --- Indisponibilità ---

const dateInRange = (date: string, from: string, to?: string): boolean => {
  const end = to && to >= from ? to : from;
  return date >= from && date <= end;
};

export const unavailabilityOn = (
  tech: Technician,
  date: string
): TechnicianUnavailability[] =>
  tech.unavailability.filter(u => u.from && dateInRange(date, u.from, u.to));

export const isFullyUnavailable = (tech: Technician, date: string): boolean =>
  unavailabilityOn(tech, date).some(u => u.allDay || (!u.startTime && !u.endTime));

// Finestra di lavoro effettiva del tecnico in una data, tenendo conto delle
// indisponibilità parziali (si sceglie la finestra libera più ampia).
// Ritorna null se il giorno non è lavorabile.
export const workWindowOn = (
  tech: Technician,
  date: string
): { start: string; end: string } | null => {
  if (isFullyUnavailable(tech, date)) return null;

  let start = tech.workStart || '08:30';
  let end = tech.workEnd || '18:00';

  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(n => parseInt(n, 10));
    return (h || 0) * 60 + (m || 0);
  };
  const toStr = (min: number) =>
    `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  let winStart = toMin(start);
  let winEnd = toMin(end);

  for (const u of unavailabilityOn(tech, date)) {
    if (u.allDay || !u.startTime || !u.endTime) continue;
    const uStart = toMin(u.startTime);
    const uEnd = toMin(u.endTime);
    if (uEnd <= winStart || uStart >= winEnd) continue; // fuori dalla finestra

    const before = Math.max(0, uStart - winStart); // minuti liberi prima del blocco
    const after = Math.max(0, winEnd - uEnd);      // minuti liberi dopo il blocco
    if (before >= after) {
      winEnd = Math.min(winEnd, uStart);
    } else {
      winStart = Math.max(winStart, uEnd);
    }
  }

  if (winEnd - winStart < 30) return null; // meno di mezz'ora: giorno non utile
  return { start: toStr(winStart), end: toStr(winEnd) };
};
