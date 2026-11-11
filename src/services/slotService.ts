import type { Appointment, Coordinates, Technician } from '../types';
import { calculateDistance, estimateTravelTimeMinutes } from '../utils/geo';
import { workWindowOn } from './technicianService';

// Motore degli slot: calcola dove (e a che ora) una pratica può entrare nel
// giro di un tecnico SENZA spostare le tappe già presenti. L'orario di una
// tappa nel giro è stato comunicato al cliente: qui non si tocca mai.
// Tutte le funzioni sono pure (nessuna rete, nessun Date.now(), nessuna
// mutazione degli argomenti): i viaggi sono stimati in linea d'aria come fa
// lo smistamento con `useEstimates`.

export const DEFAULT_DURATION_MIN = 20;
export const LUNCH_MINUTES = 45;
const LUNCH_THRESHOLD_MIN = 12 * 60; // la pausa scatta alla prima tappa raggiunta dalle 12:00

// --- Utilità orari / date ---

export const toMin = (hhmm: string): number => {
  const [h, m] = (hhmm || '').split(':').map(n => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
};

export const toHHMM = (min: number): string => {
  const total = Math.max(0, Math.round(min));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

// Data LOCALE (non UTC) in formato YYYY-MM-DD
export const localDateStr = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const addDaysStr = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
};

// Istante locale corrispondente a una data + minuti da mezzanotte
export const dateAtMinutes = (date: string, minutes: number): Date => {
  const [y, m, d] = date.split('-').map(n => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 0, minutes, 0, 0);
};

export const durationOf = (a: Pick<Appointment, 'durationMinutes'>): number =>
  a.durationMinutes && a.durationMinutes > 0 ? a.durationMinutes : DEFAULT_DURATION_MIN;

// Distanza arrotondata come in calculateSchedule (stime), così i tempi di
// viaggio coincidono con quelli dello smistamento.
const legKm = (from: Coordinates, to: Coordinates): number =>
  parseFloat(calculateDistance(from, to).toFixed(2));

export const travelMinutes = (from: Coordinates, to: Coordinates): number =>
  estimateTravelTimeMinutes(legKm(from, to));

const ceil5 = (min: number): number => Math.ceil(min / 5) * 5;

// --- Giro del giorno ---

export const isInRoute = (a: Appointment): boolean =>
  (a.status === 'confirmed' || a.status === 'proposed') && !!a.date && !!a.startTime;

export interface RouteStop {
  id: string;
  coords: Coordinates;
  start: number;       // minuti da mezzanotte
  end: number;         // minuti da mezzanotte
  lunchBefore: boolean;
  appt: Appointment;
}

const sameTech = (a?: string, b?: string) => (a || undefined) === (b || undefined);

export const toRouteStop = (a: Appointment): RouteStop => {
  const start = toMin(a.startTime || '00:00');
  return {
    id: a.id,
    coords: a.coords,
    start,
    end: a.endTime ? toMin(a.endTime) : start + durationOf(a),
    lunchBefore: !!a.hasLunchBreakBefore,
    appt: a,
  };
};

const byStart = (x: RouteStop, y: RouteStop) =>
  x.start - y.start || (x.appt.sequenceOrder ?? 0) - (y.appt.sequenceOrder ?? 0) || x.id.localeCompare(y.id);

// Tappe del giro di un tecnico in una data, ordinate per orario di inizio
export const getDayRoute = (
  all: Appointment[],
  technicianId: string | undefined,
  date: string,
  excludeId?: string
): RouteStop[] =>
  all
    .filter(a => isInRoute(a) && a.date === date && sameTech(a.technicianId, technicianId) && a.id !== excludeId)
    .map(toRouteStop)
    .sort(byStart);

// --- Contesto del giorno (finestra di lavoro + base) ---

// Orari/base generali dell'app: usati se la pratica non ha tecnico o il
// tecnico non ha una base.
export interface PlanningFallback {
  start: string;              // HH:MM
  end: string;                // HH:MM
  base: Coordinates | null;
}

export interface DayContext {
  windowStart: number;        // minuti da mezzanotte
  windowEnd: number;
  base: Coordinates | null;
}

export const dayContextFor = (
  technician: Technician | undefined,
  date: string,
  fallback: PlanningFallback
): DayContext | null => {
  if (!technician) {
    return { windowStart: toMin(fallback.start), windowEnd: toMin(fallback.end), base: fallback.base };
  }
  const window = workWindowOn(technician, date);
  if (!window) return null; // il tecnico quel giorno non lavora
  return {
    windowStart: toMin(window.start),
    windowEnd: toMin(window.end),
    base: technician.baseCoords || fallback.base,
  };
};

// --- Ricerca degli slot ---

export interface SlotOption {
  start: number;        // minuti da mezzanotte
  end: number;
  position: number;     // indice di inserimento nel giro (0 = prima della prima tappa)
  detourKm: number;     // km aggiuntivi rispetto al giro attuale
  lunchBefore: boolean; // la pausa pranzo cade prima della nuova tappa
}

export interface SlotSearchOptions {
  notBefore?: number;   // inizio minimo (minuti da mezzanotte)
  notAfter?: number;    // inizio massimo (minuti da mezzanotte)
}

// Tutti gli inserimenti fattibili di una tappa nel giro, ordinati per inizio.
// Pausa pranzo coerente con calculateSchedule (45' alla prima tappa raggiunta
// dalle 12:00): se la pausa è già prima di una tappa resta in quel varco; se
// il giro non ha ancora pausa e la nuova tappa si accoda dopo le 12:00, la
// pausa si aggiunge prima della nuova tappa.
export const findFeasibleSlots = (
  route: RouteStop[],
  ctx: DayContext,
  coords: Coordinates,
  durationMin: number,
  opts: SlotSearchOptions = {}
): SlotOption[] => {
  const hasLunch = route.some(s => s.lunchBefore);
  const anyAfterNoon = route.some(s => s.start >= LUNCH_THRESHOLD_MIN);
  const options: SlotOption[] = [];

  for (let p = 0; p <= route.length; p++) {
    const prev = p > 0 ? route[p - 1] : undefined;
    const next = p < route.length ? route[p] : undefined;

    let start = prev
      ? prev.end + travelMinutes(prev.coords, coords)
      : ctx.windowStart + (ctx.base ? travelMinutes(ctx.base, coords) : 0);
    if (opts.notBefore !== undefined) start = Math.max(start, opts.notBefore);
    start = ceil5(start);

    let lunchBefore = false;
    if (!next?.lunchBefore && !hasLunch && !anyAfterNoon && start >= LUNCH_THRESHOLD_MIN) {
      start += LUNCH_MINUTES;
      lunchBefore = true;
    }

    const end = start + durationMin;
    if (end > ctx.windowEnd) continue;
    if (opts.notAfter !== undefined && start > opts.notAfter) continue;
    if (next) {
      const lunchGap = next.lunchBefore ? LUNCH_MINUTES : 0;
      if (end + travelMinutes(coords, next.coords) + lunchGap > next.start) continue;
    }

    const from = prev ? prev.coords : ctx.base;
    const d1 = from ? calculateDistance(from, coords) : 0;
    const d2 = next ? calculateDistance(coords, next.coords) : 0;
    const d3 = from && next ? calculateDistance(from, next.coords) : 0;
    const detourKm = Math.max(0, d1 + d2 - d3);

    options.push({ start, end, position: p, detourKm, lunchBefore });
  }

  return options.sort((x, y) => x.start - y.start || x.position - y.position);
};

// Opzione migliore: detour minimo, a parità inizio più presto
export const bestSlot = (options: SlotOption[]): SlotOption | null => {
  let best: SlotOption | null = null;
  for (const o of options) {
    if (!best || o.detourKm < best.detourKm - 1e-9 || (Math.abs(o.detourKm - best.detourKm) <= 1e-9 && o.start < best.start)) {
      best = o;
    }
  }
  return best;
};

// --- Modifiche alle pratiche ---

export interface AppointmentPatch {
  id: string;
  changes: Partial<Appointment>;
}

export const applyPatches = (all: Appointment[], patches: AppointmentPatch[]): Appointment[] => {
  if (patches.length === 0) return all;
  const byId = new Map<string, Partial<Appointment>>();
  for (const p of patches) byId.set(p.id, { ...(byId.get(p.id) || {}), ...p.changes });
  return all.map(a => {
    const changes = byId.get(a.id);
    return changes ? { ...a, ...changes } : a;
  });
};

// Sequenza e viaggi stimati per tappe già ordinate per inizio
export const sequenceStops = (
  stops: { coords: Coordinates }[],
  base: Coordinates | null
): { sequenceOrder: number; travelTimeFromPrev: number; distanceFromPrev: number }[] =>
  stops.map((s, i) => {
    const from = i > 0 ? stops[i - 1].coords : base;
    if (!from) return { sequenceOrder: i + 1, travelTimeFromPrev: 0, distanceFromPrev: 0 };
    const distance = legKm(from, s.coords);
    return { sequenceOrder: i + 1, travelTimeFromPrev: estimateTravelTimeMinutes(distance), distanceFromPrev: distance };
  });

// Rinumera le tappe del giorno (1..n per orario) e ricalcola i viaggi stimati
// (la prima dalla base, se nota). Gli orari NON cambiano. Le pratiche che non
// cambiano restano lo stesso oggetto.
export const resequenceDay = (
  all: Appointment[],
  technicianId: string | undefined,
  date: string,
  ctx?: { base: Coordinates | null }
): Appointment[] => {
  const route = getDayRoute(all, technicianId, date);
  if (route.length === 0) return all;
  const seq = sequenceStops(route, ctx?.base ?? null);
  const patches: AppointmentPatch[] = [];
  route.forEach((s, i) => {
    const v = seq[i];
    if (
      s.appt.sequenceOrder !== v.sequenceOrder ||
      s.appt.travelTimeFromPrev !== v.travelTimeFromPrev ||
      s.appt.distanceFromPrev !== v.distanceFromPrev
    ) {
      patches.push({ id: s.id, changes: v });
    }
  });
  return applyPatches(all, patches);
};

export interface PlacementTarget {
  date: string;
  option: SlotOption;
  technicianId?: string;
  ctx?: { base: Coordinates | null };     // base del giorno di arrivo (per i viaggi)
  fromCtx?: { base: Coordinates | null }; // base del giorno di partenza, se diverso
}

// Porta la pratica nel giro nello slot indicato (status 'proposed' salvo
// extra.status) e risequenzia il giorno di arrivo e quello di partenza.
export const placeAppointment = (
  all: Appointment[],
  id: string,
  target: PlacementTarget,
  extra: Partial<Appointment> = {}
): Appointment[] => {
  const a = all.find(x => x.id === id);
  if (!a) return all;

  const wasInRoute = isInRoute(a);
  const oldDate = a.date;
  const oldTech = a.technicianId;
  const technicianId = target.technicianId ?? a.technicianId;

  const updated: Appointment = {
    ...a,
    status: 'proposed',
    date: target.date,
    technicianId,
    startTime: toHHMM(target.option.start),
    endTime: toHHMM(target.option.end),
    hasLunchBreakBefore: target.option.lunchBefore,
    ...extra,
  };

  let result = all.map(x => (x.id === id ? updated : x));
  result = resequenceDay(result, technicianId, target.date, target.ctx);
  if (wasInRoute && oldDate && (oldDate !== target.date || !sameTech(oldTech, technicianId))) {
    result = resequenceDay(result, oldTech, oldDate, target.fromCtx ?? target.ctx);
  }
  return result;
};

// Toglie la pratica dal giro (pianificazione azzerata), applica `changes` e
// risequenzia il giorno lasciato.
export const removeFromRoute = (
  all: Appointment[],
  id: string,
  changes: Partial<Appointment>,
  ctx?: { base: Coordinates | null }
): Appointment[] => {
  const a = all.find(x => x.id === id);
  if (!a) return all;

  const wasInRoute = isInRoute(a);
  const updated: Appointment = {
    ...a,
    date: undefined,
    sequenceOrder: undefined,
    startTime: undefined,
    endTime: undefined,
    hasLunchBreakBefore: undefined,
    travelTimeFromPrev: undefined,
    distanceFromPrev: undefined,
    ...changes,
  };

  const result = all.map(x => (x.id === id ? updated : x));
  return wasInRoute && a.date ? resequenceDay(result, a.technicianId, a.date, ctx) : result;
};
