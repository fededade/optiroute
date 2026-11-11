import type { AlternativeLabel, AlternativeSlot, Appointment, CallOutcome, Technician } from '../types';
import {
  LUNCH_MINUTES,
  type PlanningFallback,
  type SlotOption,
  addDaysStr,
  bestSlot,
  dateAtMinutes,
  dayContextFor,
  durationOf,
  findFeasibleSlots,
  getDayRoute,
  localDateStr,
  toHHMM,
  toMin,
} from './slotService';
import { parseFollowUpDate } from './callService';

// Alternative REALI da offrire in chiamata: slot già verificati sul giro del
// tecnico (senza spostare nessuna tappa), su date diverse, scelti in modo da
// allungare il meno possibile i giri. L'agente AI le propone se il cliente
// rifiuta l'orario principale; all'esito lo slot scelto viene rivalidato.

export interface AlternativeOptions {
  now: Date;
  fallback: PlanningFallback;
  horizonDays?: number;     // giorni esaminati da oggi (default 10)
  includeWeekends?: boolean; // default false
  minLeadMinutes?: number;  // anticipo minimo rispetto ad adesso (default 180)
  max?: number;             // alternative restituite (default 3)
}

const LABELS: AlternativeLabel[] = ['A', 'B', 'C'];
const SAME_DAY_MIN_GAP = 120;   // sul giorno già proposto: almeno 2 ore di differenza
const DAY_DISTANCE_WEIGHT = 0.5; // km equivalenti per ogni giorno di distanza
const EMPTY_DAY_PENALTY = 15;    // aprire un giro per una visita sola è l'ultima scelta
const RESOLVE_TOLERANCE = 5;     // minuti di tolleranza sull'orario offerto

const isWeekend = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00`).getDay();
  return day === 0 || day === 6;
};

const daysBetween = (from: string, to: string): number =>
  Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000);

// Minuti da mezzanotte di `date` a partire dai quali uno slot rispetta
// l'anticipo minimo (0 se tutto il giorno va bene)
const minStartOn = (date: string, now: Date, leadMinutes: number): number => {
  const limit = now.getTime() + leadMinutes * 60000;
  const midnight = dateAtMinutes(date, 0).getTime();
  return Math.max(0, Math.ceil((limit - midnight) / 60000));
};

export const computeAlternativeSlots = (
  appt: Appointment,
  all: Appointment[],
  technicians: Technician[],
  opts: AlternativeOptions
): AlternativeSlot[] => {
  const horizonDays = opts.horizonDays ?? 10;
  const includeWeekends = opts.includeWeekends ?? false;
  const minLead = opts.minLeadMinutes ?? 180;
  const max = Math.min(opts.max ?? 3, LABELS.length);
  if (max <= 0) return [];

  const tech = appt.technicianId ? technicians.find(t => t.id === appt.technicianId) : undefined;
  const today = localDateStr(opts.now);
  const refDate = appt.date || today;
  const currentStart = appt.date && appt.startTime ? toMin(appt.startTime) : null;
  const duration = durationOf(appt);

  const candidates: { date: string; option: SlotOption; score: number }[] = [];

  for (let i = 0; i <= horizonDays; i++) {
    const date = addDaysStr(today, i);
    if (!includeWeekends && isWeekend(date)) continue;
    if (appt.declinedDates?.includes(date)) continue;
    if (appt.followUpDate && date < appt.followUpDate) continue;

    const ctx = dayContextFor(tech, date, opts.fallback);
    if (!ctx) continue; // il tecnico quel giorno non lavora

    const route = getDayRoute(all, appt.technicianId, date, appt.id);
    const notBefore = minStartOn(date, opts.now, minLead);
    const options = findFeasibleSlots(route, ctx, appt.coords, duration, notBefore > 0 ? { notBefore } : {})
      .filter(o => o.start >= notBefore)
      .filter(o => !(date === appt.date && currentStart !== null && Math.abs(o.start - currentStart) < SAME_DAY_MIN_GAP));

    const best = bestSlot(options);
    if (!best) continue;

    const score =
      best.detourKm +
      DAY_DISTANCE_WEIGHT * Math.abs(daysBetween(refDate, date)) +
      (route.length === 0 ? EMPTY_DAY_PENALTY : 0);
    candidates.push({ date, option: best, score });
  }

  return candidates
    .sort((x, y) => x.score - y.score || x.date.localeCompare(y.date))
    .slice(0, max)
    .sort((x, y) => x.date.localeCompare(y.date))
    .map((c, i) => ({
      label: LABELS[i],
      date: c.date,
      startTime: toHHMM(c.option.start),
      endTime: toHHMM(c.option.end),
    }));
};

// Rivalida, al momento dell'esito, che l'alternativa offerta sia ancora
// inseribile nel giro (esclusa la pratica stessa). null se non più libera.
export const resolveAlternative = (
  appt: Appointment,
  label: AlternativeLabel,
  all: Appointment[],
  technicians: Technician[],
  fallback: PlanningFallback,
  now: Date
): { date: string; option: SlotOption } | null => {
  const offered = appt.offeredAlternatives?.find(o => o.label === label);
  if (!offered) return null;

  const tech = appt.technicianId ? technicians.find(t => t.id === appt.technicianId) : undefined;
  const ctx = dayContextFor(tech, offered.date, fallback);
  if (!ctx) return null;

  const offeredStart = toMin(offered.startTime);
  if (dateAtMinutes(offered.date, offeredStart).getTime() <= now.getTime()) return null; // già trascorso

  const route = getDayRoute(all, appt.technicianId, offered.date, appt.id);
  // Un varco che si apre prima dell'orario offerto viene "portato" a
  // quell'orario (notBefore); se lo slot offerto aveva la pausa pranzo prima,
  // il minimo va anticipato della pausa. Si accettano inizi entro ±5 minuti.
  const duration = durationOf(appt);
  const searches = [{}, { notBefore: offeredStart }, { notBefore: offeredStart - LUNCH_MINUTES }];
  const options = searches
    .flatMap(s => findFeasibleSlots(route, ctx, appt.coords, duration, s))
    .filter(o => Math.abs(o.start - offeredStart) <= RESOLVE_TOLERANCE);
  if (options.length === 0) return null;

  // Preferisci l'orario esatto comunicato al cliente, poi il detour minore
  const option = options.sort(
    (x, y) => Math.abs(x.start - offeredStart) - Math.abs(y.start - offeredStart) || x.detourKm - y.detourKm
  )[0];
  return { date: offered.date, option };
};

// Orario in minuti da un testo libero dell'analisi post-chiamata
// ("15:30", "15.30", "alle 15 e 30", "ore 15"); null se non interpretabile.
export const parseTimeText = (text: string | undefined): number | null => {
  if (!text) return null;
  const t = text.toLowerCase();
  const hm = t.match(/\b([01]?\d|2[0-3])\s*(?:[:.,]|\s+e\s+)\s*([0-5]\d)\b/);
  if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  const h = t.match(/\b(?:ore|alle|all[e']?)\s*([01]?\d|2[0-3])\b/) || t.match(/^\s*([01]?\d|2[0-3])\s*$/);
  if (h) return parseInt(h[1], 10) * 60;
  return null;
};

const INFER_TOLERANCE = 45; // minuti fra l'orario richiesto e lo slot offerto

// Alternativa accettata dal cliente. Vale l'etichetta esplicita dell'analisi
// post-chiamata (campo `alternativa_scelta`); se manca, la si deduce dalla
// richiesta del cliente: stessa DATA di uno slot offerto e orario entro 45
// minuti (senza orario basta la data, ma solo se l'esito è una conferma).
// Prudente di proposito: nel dubbio nessuna deduzione, la pratica segue
// l'esito dichiarato (da riprogrammare, da richiamare...).
export const inferChosenAlternative = (
  outcome: Pick<CallOutcome, 'result' | 'chosenAlternative' | 'followUpDate' | 'requestedDate' | 'requestedTime'>,
  offered: AlternativeSlot[] | undefined
): AlternativeLabel | undefined => {
  if (!offered || offered.length === 0) return undefined;
  if (outcome.chosenAlternative) {
    return offered.some(o => o.label === outcome.chosenAlternative) ? outcome.chosenAlternative : undefined;
  }
  if (outcome.result !== 'confermato' && outcome.result !== 'riprogrammare') return undefined;
  // Data richiesta: quella già normalizzata, altrimenti dal testo libero
  const date = outcome.followUpDate || (outcome.requestedDate ? parseFollowUpDate(outcome.requestedDate) : undefined);
  if (!date) return undefined;

  const sameDate = offered.filter(o => o.date === date);
  if (sameDate.length !== 1) return undefined;
  const slot = sameDate[0];

  const requested = parseTimeText(outcome.requestedTime);
  if (requested === null) return outcome.result === 'confermato' ? slot.label : undefined;
  return Math.abs(requested - toMin(slot.startTime)) <= INFER_TOLERANCE ? slot.label : undefined;
};
