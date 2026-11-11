import { describe, it } from 'vitest';
import type { AlternativeLabel, Appointment, CallOutcome, CallOutcomeResult, Coordinates, Technician } from '../src/types';
import { computeDispatch } from '../src/services/dispatchService';
import {
  DEFAULT_AUTOPILOT_SETTINGS,
  type AutopilotSettings,
  type PlanningContext,
  alternativesForCall,
  approveForCalling,
  attentionItems,
  autopilotStats,
  cancelAutoCalls,
  expireStaleAutoCalls,
  isCallInFlight,
  nextCallWindowStart,
  nextDueCall,
  reduceCallLaunchResult,
  reduceCallOutcome,
  reduceCallStarted,
  slotStartOf,
} from '../src/services/autopilotService';
import {
  type AppointmentPatch,
  type PlanningFallback,
  LUNCH_MINUTES,
  addDaysStr,
  applyPatches,
  dateAtMinutes,
  getDayRoute,
  isInRoute,
  localDateStr,
  toMin,
  travelMinutes,
} from '../src/services/slotService';
import { workWindowOn } from '../src/services/technicianService';
import { P } from './fixtures';

// Test a invarianti: mondi casuali ma riproducibili (seme fisso), sequenze
// casuali di operazioni del pilota automatico e dello smistamento, verifica
// degli invarianti dopo OGNI passo. Un errore riporta seme e passo: per
// riprodurlo basta `runWorld(<seme>)`.

// --- Generatore pseudo-casuale (mulberry32) ---

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}

class InvariantError extends Error {}

// --- Mondo ---

interface World {
  seed: number;
  technicians: Technician[];
  fallback: PlanningFallback;
  settings: AutopilotSettings;
}

const CENTERS: Coordinates[] = [P.milano, P.monza, P.pavia, P.lodi, P.sesto, P.rho, P.assago];
const START_DAYS = ['2026-11-11', '2026-11-13', '2026-10-21', '2026-10-23', '2026-03-25', '2026-03-27'];
const RESULTS: CallOutcomeResult[] = [
  'confermato', 'riprogrammare', 'da_richiamare', 'numero_errato', 'lavori_non_ultimati',
  'annullato', 'rifiutato', 'altro_referente', 'non_risposto', 'sconosciuto',
];

const jitter = (r: Rng, c: Coordinates, deg: number): Coordinates => ({
  lat: +(c.lat + (r.float() * 2 - 1) * deg).toFixed(5),
  lng: +(c.lng + (r.float() * 2 - 1) * deg).toFixed(5),
});

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const genWorld = (r: Rng, seed: number, today: string): { world: World; all: Appointment[] } => {
  const nTech = r.int(2, 3);
  const technicians: Technician[] = [];
  for (let i = 0; i < nTech; i++) {
    const center = r.pick(CENTERS);
    const unavailability: Technician['unavailability'] = [];
    const nU = r.int(0, 3);
    for (let u = 0; u < nU; u++) {
      const from = addDaysStr(today, r.int(0, 12));
      if (r.chance(0.5)) {
        unavailability.push({ id: `u${u}`, from, to: r.chance(0.3) ? addDaysStr(from, r.int(1, 3)) : undefined, allDay: true });
      } else {
        const morning = r.chance(0.5);
        unavailability.push({
          id: `u${u}`,
          from,
          allDay: false,
          startTime: morning ? r.pick(['07:00', '08:00']) : r.pick(['13:00', '14:30', '16:00']),
          endTime: morning ? r.pick(['10:00', '11:30', '12:30']) : '20:00',
        });
      }
    }
    technicians.push({
      id: `t${i}`,
      name: `Tecnico ${i}`,
      color: '#000000',
      active: true,
      provinces: ['MI'],
      areas: [],
      baseCoords: r.chance(0.8) ? jitter(r, center, 0.03) : undefined,
      workStart: r.pick(['07:30', '08:00', '08:30', '09:00', '09:15']),
      workEnd: r.pick(['16:00', '17:00', '17:45', '18:00', '19:00']),
      unavailability,
    });
  }
  const fallback: PlanningFallback = { start: '08:30', end: '18:00', base: r.chance(0.8) ? P.milano : null };

  const degenerate = r.chance(0.08);
  const settings: AutopilotSettings = {
    ...DEFAULT_AUTOPILOT_SETTINGS,
    enabled: r.chance(0.9),
    callWindowStart: degenerate ? '19:00' : r.pick(['08:00', '09:00', '09:30']),
    callWindowEnd: degenerate ? r.pick(['19:00', '09:00']) : r.pick(['13:00', '18:00', '19:30', '21:00']),
    callSaturday: r.chance(0.4),
    maxAttempts: r.pick([0, 1, 2, 3, 3, 5]),
    retryMinutes: r.pick([0, 15, 60, 120, 120, 240]),
    offerAlternatives: r.chance(0.85),
    backfill: r.chance(0.85),
    minLeadHours: r.pick([0, 1, 3, 3, 6]),
  };

  const all: Appointment[] = [];
  const n = r.int(20, 60);
  for (let i = 0; i < n; i++) {
    const t = r.chance(0.92) ? r.pick(technicians) : undefined;
    const center = t ? t.baseCoords || CENTERS[0] : r.pick(CENTERS);
    const declined = r.chance(0.15)
      ? Array.from(new Set([addDaysStr(today, r.int(1, 8)), addDaysStr(today, r.int(1, 8))]))
      : undefined;
    all.push({
      id: `p${i}`,
      address: `Via Prova ${i}`,
      title: `Pratica ${i}`,
      coords: jitter(r, center, 0.09),
      status: 'pending',
      province: t ? 'MI' : 'ZZ', // senza tecnico: provincia non coperta (nessuna rete)
      technicianId: t?.id,
      urgent: r.chance(0.15) || undefined,
      phone: r.chance(0.85) ? `+3902${String(i).padStart(6, '0')}` : undefined,
      durationMinutes: r.pick([undefined, undefined, undefined, undefined, undefined, 30, 45, 90, 180]),
      followUpDate: r.chance(0.15) ? addDaysStr(today, r.int(0, 8)) : undefined,
      declinedDates: declined,
    });
  }
  return { world: { seed, technicians, fallback, settings }, all };
};

// --- Verifiche ---

const snapshotOf = (v: unknown) => JSON.stringify(v);

// Purezza: gli argomenti (array, oggetti) restano identici
const pure = <T>(label: string, args: unknown[], fn: () => T): T => {
  const before = args.map(snapshotOf);
  const refs = args.map(a => (Array.isArray(a) ? [...a] : null));
  const out = fn();
  args.forEach((a, i) => {
    if (snapshotOf(a) !== before[i]) throw new InvariantError(`${label}: argomento ${i} mutato`);
    const r0 = refs[i];
    if (r0 && Array.isArray(a)) {
      if (a.length !== r0.length || a.some((x, j) => x !== r0[j])) {
        throw new InvariantError(`${label}: array in ingresso ${i} modificato in place`);
      }
    }
  });
  return out;
};

const timeKey = (a: Appointment) => `${a.technicianId}|${a.date}|${a.startTime}|${a.endTime}`;

const NOON = 12 * 60;

const overlaps = (s1: number, e1: number, s2: number, e2: number) => s1 < e2 && s2 < e1;

// Invarianti di stato (2, 3, 4, 8, 9) su TUTTI i giri
const checkState = (all: Appointment[], w: World, now: Date) => {
  const fail = (msg: string) => {
    throw new InvariantError(msg);
  };
  const days = new Set(all.filter(isInRoute).map(a => `${a.technicianId ?? ''}|${a.date}`));
  for (const key of days) {
    const [tid, date] = key.split('|');
    const technicianId = tid || undefined;
    const route = getDayRoute(all, technicianId, date);
    const tech = w.technicians.find(t => t.id === technicianId);
    if (!tech) fail(`tappa senza tecnico nel giro ${key}`);
    const win = workWindowOn(tech!, date);
    if (!win) fail(`tappe nel giro di ${key}: giorno di indisponibilità`);
    const ws = toMin(win!.start), we = toMin(win!.end);
    const base = tech!.baseCoords || w.fallback.base;

    // 9) sequenza 1..n nell'ordine degli orari
    const seq = route.map(s => s.appt.sequenceOrder);
    if (seq.some((v, i) => v !== i + 1)) fail(`sequenza ${key} non 1..n: ${JSON.stringify(seq)}`);

    route.forEach((s, i) => {
      const lunch = s.lunchBefore ? LUNCH_MINUTES : 0;
      // 3) finestra di lavoro
      if (s.start < ws || s.end > we) fail(`${s.id} ${key} ${s.appt.startTime}-${s.appt.endTime} fuori finestra ${win!.start}-${win!.end}`);
      // 2) viaggi e pausa pranzo
      if (i === 0) {
        const min = ws + (base ? travelMinutes(base, s.coords) : 0) + lunch;
        if (s.start < min) fail(`${s.id} ${key}: prima tappa alle ${s.appt.startTime}, prima del viaggio dalla base (${hhmm(min)})`);
      } else {
        const prev = route[i - 1];
        const min = prev.end + travelMinutes(prev.coords, s.coords) + lunch;
        if (s.start < min) {
          fail(`${s.id} ${key}: inizia ${s.appt.startTime}, ma dopo ${prev.id} (fine ${hhmm(prev.end)}) serve ${hhmm(min)}${lunch ? ' (con pausa)' : ''}`);
        }
      }
      // 4) date rifiutate / data di rientro
      if (s.appt.declinedDates?.includes(date)) fail(`${s.id} nel giro in una data rifiutata ${date}`);
      if (s.appt.followUpDate && date < s.appt.followUpDate) fail(`${s.id} nel giro il ${date}, prima del rientro ${s.appt.followUpDate}`);
    });
    // Pausa pranzo: un giro con tappe dalle 12:00 in poi ha un varco di 45'
    // liberi (al netto del viaggio) dalle 12:00 in poi prima di una tappa
    if (route.some(s => s.start >= NOON)) {
      const hasBreak = route.some((s, i) => {
        const arrival = i > 0
          ? route[i - 1].end + travelMinutes(route[i - 1].coords, s.coords)
          : ws + (base ? travelMinutes(base, s.coords) : 0);
        return s.start - Math.max(arrival, NOON) >= LUNCH_MINUTES;
      });
      if (!hasBreak) fail(`giro ${key} con tappe pomeridiane e senza pausa pranzo: ${route.map(s => `${s.id}@${s.appt.startTime}`).join(', ')}`);
    }
  }

  // 8) slot offerti nelle chiamate in corso: non occupati da altri né offerti due volte
  const reserved = all.filter(a => a.offeredAlternatives && isCallInFlight(a, now));
  for (const a of reserved) {
    for (const o of a.offeredAlternatives!) {
      const s = toMin(o.startTime), e = toMin(o.endTime);
      for (const b of all) {
        if (b.id === a.id || b.technicianId !== a.technicianId) continue;
        if (isInRoute(b) && b.date === o.date && overlaps(s, e, toMin(b.startTime!), b.endTime ? toMin(b.endTime) : toMin(b.startTime!) + 20)) {
          fail(`slot ${o.label} ${o.date} ${o.startTime} riservato a ${a.id} occupato da ${b.id}`);
        }
        if (b.offeredAlternatives && isCallInFlight(b, now)) {
          for (const o2 of b.offeredAlternatives) {
            if (o2.date === o.date && overlaps(s, e, toMin(o2.startTime), toMin(o2.endTime))) {
              fail(`slot ${o.date} ${o.startTime} offerto sia a ${a.id} sia a ${b.id}`);
            }
          }
        }
      }
    }
  }
};

// 1) Nessuna tappa nel giro cambia data/orari salvo quelle ammesse
const checkFixed = (before: Appointment[], after: Appointment[], allowed: Set<string>) => {
  const afterById = new Map(after.map(a => [a.id, a]));
  for (const a of before) {
    if (!isInRoute(a) || allowed.has(a.id)) continue;
    const b = afterById.get(a.id);
    if (!b || !isInRoute(b) || timeKey(a) !== timeKey(b)) {
      throw new InvariantError(`tappa ${a.id} (${timeKey(a)}) cambiata in ${b ? (isInRoute(b) ? timeKey(b) : `fuori dal giro, ${b.status}`) : 'assente'}`);
    }
  }
};

// Pratiche entrate nel giro o spostate
const movedIds = (before: Appointment[], after: Appointment[]): string[] => {
  const beforeById = new Map(before.map(a => [a.id, a]));
  return after
    .filter(b => {
      const a = beforeById.get(b.id);
      return isInRoute(b) && (!a || !isInRoute(a) || timeKey(a) !== timeKey(b));
    })
    .map(b => b.id);
};

// --- Simulazione ---

// Copertura: quante volte i casi interessanti si sono davvero verificati
export const coverage = {
  worlds: 0, steps: 0, calls: 0, outcomes: 0, alternativesOffered: 0, alternativesAccepted: 0,
  backfills: 0, advances: 0, incrementalInserts: 0, ignoredOutcomes: 0, dstWorlds: 0,
};

const applyProposal = (all: Appointment[], updates: Appointment[], patches: AppointmentPatch[]) => {
  const byId = new Map(updates.map(u => [u.id, u]));
  return applyPatches(all.map(a => byId.get(a.id) || a), patches);
};

// `trace` (facoltativo) riceve lo stato dopo ogni passo: utile per riprodurre un errore
const runWorld = async (seed: number, trace?: (step: number, op: string, all: Appointment[], now: Date) => void): Promise<void> => {
  const r = new Rng(seed);
  const startDay = r.pick(START_DAYS);
  let now = dateAtMinutes(startDay, r.int(7 * 60, 17 * 60 + 30));
  const today = localDateStr(now);
  const { world: w, all: initial } = genWorld(r, seed, today);
  coverage.worlds += 1;
  if (startDay.startsWith('2026-03') || startDay.startsWith('2026-10')) coverage.dstWorlds += 1;
  let all = initial;
  let step = 0;
  let op = 'init';
  let callSeq = 0;
  let lastOutcome: { id: string; outcome: CallOutcome; callId?: string } | null = null;
  const noAnswer = new Map<string, { slot: string; count: number }>();
  const ctxNow = (): PlanningContext => ({ technicians: w.technicians, fallback: w.fallback, settings: w.settings, now });

  const wrap = (e: unknown): never => {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[seme ${seed}, passo ${step}, operazione ${op}] ${msg}`);
  };

  const dispatch = async () => {
    const pending = all.filter(a => a.status === 'pending');
    if (pending.length === 0) return;
    const params = { startDate: addDaysStr(localDateStr(now), r.int(0, 1)), horizonDays: r.int(2, 10), includeWeekends: r.chance(0.3) };
    const before = all;
    const res = await (async () => {
      const snaps = [pending, w.technicians, all].map(snapshotOf);
      const out = await computeDispatch(pending, w.technicians, w.fallback.base, params, undefined, all, now);
      if ([pending, w.technicians, all].some((x, i) => snapshotOf(x) !== snaps[i])) throw new InvariantError('computeDispatch ha mutato gli argomenti');
      return out;
    })();
    for (const p of res.patches) {
      const k = Object.keys(p.changes).filter(k => !['sequenceOrder', 'travelTimeFromPrev', 'distanceFromPrev'].includes(k));
      if (k.length > 0) throw new InvariantError(`patch di smistamento su ${p.id} tocca ${k.join(',')}`);
    }
    const busyDays = new Set(before.filter(isInRoute).map(a => `${a.technicianId}|${a.date}`));
    coverage.incrementalInserts += res.updates.filter(u => isInRoute(u) && busyDays.has(`${u.technicianId}|${u.date}`)).length;
    all = applyProposal(all, res.updates, res.patches);
    checkFixed(before, all, new Set(pending.map(a => a.id)));
  };

  try {
    // Situazione iniziale: smistamento, parte delle proposte confermate,
    // qualche pratica storica senza orario di fine
    await dispatch();
    all = all.map(a => {
      if (!isInRoute(a)) return a;
      if (r.chance(0.3)) return { ...a, status: 'confirmed' as const };
      if (r.chance(0.05)) return { ...a, endTime: undefined };
      return a;
    });
    checkState(all, w, now);

    const steps = r.int(25, 50);
    for (step = 1; step <= steps; step++) {
      const roll = r.float();
      const ctx = ctxNow();
      const before = all;

      if (roll < 0.1) {
        op = 'smistamento';
        await dispatch();
      } else if (roll < 0.22) {
        op = 'approvazione';
        const ids = all.filter(a => isInRoute(a) && r.chance(0.6)).map(a => a.id);
        all = pure(op, [all, ids], () => approveForCalling(all, ids, now));
        checkFixed(before, all, new Set());
      } else if (roll < 0.55) {
        op = 'chiamata';
        const due = pure('nextDueCall', [all, ctx], () => nextDueCall(all, ctx));
        if (due) {
          // 7) fascia, domenica, slot trascorso, doppia chiamata
          const day = now.getDay();
          const min = now.getHours() * 60 + now.getMinutes();
          if (!w.settings.enabled) throw new InvariantError('chiamata col pilota spento');
          if (day === 0 || (day === 6 && !w.settings.callSaturday)) throw new InvariantError(`chiamata di ${day === 0 ? 'domenica' : 'sabato'}`);
          if (min < toMin(w.settings.callWindowStart) || min >= toMin(w.settings.callWindowEnd)) {
            throw new InvariantError(`chiamata alle ${hhmm(min)} fuori fascia ${w.settings.callWindowStart}-${w.settings.callWindowEnd}`);
          }
          if ((slotStartOf(due)?.getTime() ?? 0) <= now.getTime()) throw new InvariantError(`chiamata per ${due.id}: slot già trascorso`);
          if (isCallInFlight(due, now)) throw new InvariantError(`doppia chiamata a ${due.id}`);
          if (!due.phone) throw new InvariantError(`chiamata a ${due.id} senza telefono`);

          const alts = pure('alternativesForCall', [due, all, ctx], () => alternativesForCall(due, all, ctx));
          const lead = now.getTime() + w.settings.minLeadHours * 3600000;
          for (const o of alts) {
            if (due.declinedDates?.includes(o.date)) throw new InvariantError(`alternativa ${o.label} su data rifiutata ${o.date}`);
            if (due.followUpDate && o.date < due.followUpDate) throw new InvariantError(`alternativa ${o.label} prima del rientro`);
            if (dateAtMinutes(o.date, toMin(o.startTime)).getTime() < lead) throw new InvariantError(`alternativa ${o.label} ${o.date} ${o.startTime} senza anticipo minimo`);
            const t = w.technicians.find(x => x.id === due.technicianId)!;
            const win = workWindowOn(t, o.date);
            if (!win || toMin(o.startTime) < toMin(win.start) || toMin(o.endTime) > toMin(win.end)) {
              throw new InvariantError(`alternativa ${o.label} ${o.date} ${o.startTime} fuori finestra`);
            }
          }
          all = pure('reduceCallStarted', [all, alts], () => reduceCallStarted(all, due.id, alts));
          const ok = r.chance(0.92);
          callSeq += 1;
          coverage.calls += 1;
          if (alts.length > 0) coverage.alternativesOffered += 1;
          all = pure('reduceCallLaunchResult', [all], () =>
            reduceCallLaunchResult(all, due.id, ok ? { ok, callId: `c${callSeq}` } : { ok, error: 'errore' }, now)
          );
          checkFixed(before, all, new Set());
        }
      } else if (roll < 0.8) {
        op = 'esito';
        const inFlight = all.filter(a => a.callStatus === 'called' && a.callId && !a.callOutcome);
        if (inFlight.length > 0) {
          const a = r.pick(inFlight);
          op = `esito su ${a.id}`;
          const result = r.pick(RESULTS);
          const outcome: CallOutcome = { result, receivedAt: now.toISOString() };
          const offers = a.offeredAlternatives || [];
          if (offers.length > 0 && r.chance(0.35)) {
            const o = r.pick(offers);
            if (r.chance(0.6)) outcome.chosenAlternative = o.label as AlternativeLabel;
            else {
              outcome.requestedDate = o.date;
              if (r.chance(0.6)) outcome.requestedTime = o.startTime;
            }
          }
          if (r.chance(0.4)) outcome.followUpDate = addDaysStr(localDateStr(now), r.int(-1, 10));
          if (result === 'altro_referente' && r.chance(0.6)) outcome.newContactPhone = `+3903${r.int(100000, 999999)}`;
          const expected = r.chance(0.85) ? a.callId : r.chance(0.5) ? undefined : 'superata';
          op += ` (${result}${outcome.chosenAlternative ? ` alt ${outcome.chosenAlternative}` : ''}${outcome.requestedDate ? ` req ${outcome.requestedDate} ${outcome.requestedTime ?? ''}` : ''})`;

          const next = pure('reduceCallOutcome', [all, outcome, ctx], () => reduceCallOutcome(all, a.id, outcome, expected, ctx));
          if (expected === 'superata' && next !== all) throw new InvariantError('esito di una chiamata superata applicato');

          // 1) solo la pratica dell'esito e (al massimo) un rimpiazzo cambiano orario
          const moved = movedIds(all, next).filter(id => id !== a.id);
          if (moved.length > 1) throw new InvariantError(`più rimpiazzi in un solo esito: ${moved.join(',')}`);
          coverage.outcomes += 1;
          if (next === all) coverage.ignoredOutcomes += 1;
          const xa = next.find(x => x.id === a.id)!;
          if (xa.callOutcome?.chosenAlternative && isInRoute(xa) && timeKey(xa) !== timeKey(a)) coverage.alternativesAccepted += 1;
          for (const id of moved) {
            coverage.backfills += 1;
            if (isInRoute(all.find(x => x.id === id)!)) coverage.advances += 1;
            const b = next.find(x => x.id === id)!;
            if (b.autoCall !== 'backfill') throw new InvariantError(`${id} spostata senza essere un rimpiazzo`);
            const prev = all.find(x => x.id === id)!;
            if (isInRoute(prev) && !(prev.date! > b.date!)) throw new InvariantError(`rimpiazzo ${id} non anticipato (${prev.date} -> ${b.date})`);
            if (slotStartOf(b)!.getTime() < now.getTime() + w.settings.minLeadHours * 3600000) throw new InvariantError(`rimpiazzo ${id} senza anticipo minimo`);
            if (isCallInFlight(prev, now)) throw new InvariantError(`rimpiazzo ${id} con una chiamata in corso`);
          }
          checkFixed(all, next, new Set([a.id, ...moved]));

          // 6) tetto tentativi per lo stesso slot
          if (next !== all && result === 'non_risposto') {
            const slot = timeKey(a);
            const prevNa = noAnswer.get(a.id);
            const count = prevNa && prevNa.slot === slot ? prevNa.count + 1 : 1;
            noAnswer.set(a.id, { slot, count });
            if (count > Math.max(1, w.settings.maxAttempts)) throw new InvariantError(`${a.id}: ${count} chiamate senza risposta per lo stesso slot`);
          }
          // Esito duplicato: nessun effetto
          if (next !== all) {
            const again = reduceCallOutcome(next, a.id, outcome, a.callId, ctx);
            if (again !== next) throw new InvariantError('esito duplicato applicato due volte');
          }
          lastOutcome = { id: a.id, outcome, callId: a.callId };
          all = next;
        } else if (lastOutcome) {
          op = 'esito ripetuto';
          const lo = lastOutcome;
          const next = reduceCallOutcome(all, lo.id, lo.outcome, lo.callId, ctx);
          checkFixed(all, next, new Set([lo.id, ...movedIds(all, next)]));
          if (movedIds(all, next).filter(id => id !== lo.id).length > 1) throw new InvariantError('esito ripetuto: più rimpiazzi');
          all = next;
        }
      } else if (roll < 0.95) {
        op = 'tempo';
        now = new Date(now.getTime() + r.int(5, 360) * 60000);
        // spesso si salta alla prossima apertura della fascia chiamate
        if (r.chance(0.5)) now = nextCallWindowStart(now, w.settings);
        all = pure('expireStaleAutoCalls', [all], () => expireStaleAutoCalls(all, now));
        checkFixed(before, all, new Set());
      } else {
        op = 'annulla coda';
        const ids = all.filter(a => a.autoCall && r.chance(0.5)).map(a => a.id);
        all = pure(op, [all, ids], () => cancelAutoCalls(all, ids));
        checkFixed(before, all, new Set());
      }

      // Cruscotto: puro e senza eccezioni
      pure('autopilotStats', [all], () => autopilotStats(all, ctxNow()));
      pure('attentionItems', [all], () => attentionItems(all, ctxNow()));
      trace?.(step, op, all, now);
      checkState(all, w, now);
      coverage.steps += 1;
    }

    // 6) Terminazione: nessuno risponde più; la coda deve esaurirsi
    op = 'drenaggio';
    for (let i = 0; i < 3000; i++) {
      step += 1;
      const ctx = ctxNow();
      const flying = all.find(a => a.callStatus === 'called' && a.callId && !a.callOutcome && isCallInFlight(a, now));
      if (flying) {
        const before = all;
        all = reduceCallOutcome(all, flying.id, { result: 'non_risposto', receivedAt: now.toISOString() }, flying.callId, ctx);
        const moved = movedIds(before, all).filter(id => id !== flying.id);
        checkFixed(before, all, new Set([flying.id, ...moved]));
        trace?.(step, op, all, now);
        checkState(all, w, now);
        continue;
      }
      const due = nextDueCall(all, ctx);
      if (due) {
        all = reduceCallStarted(all, due.id, alternativesForCall(due, all, ctx));
        callSeq += 1;
        all = reduceCallLaunchResult(all, due.id, { ok: true, callId: `c${callSeq}` }, now);
        continue;
      }
      if (!all.some(a => a.autoCall)) return; // coda esaurita
      now = new Date(now.getTime() + 30 * 60000);
      all = expireStaleAutoCalls(all, now);
    }
    const stuck = all
      .filter(a => a.autoCall)
      .map(a => `${a.id}:${a.autoCall}/${a.status}/${a.date} ${a.startTime}/tel ${a.phone ? 'sì' : 'no'}/${a.callStatus ?? '-'}/dopo ${a.autoCallNotBefore ?? '-'}`);
    throw new InvariantError(`la coda delle chiamate non si esaurisce (possibile ciclo) alle ${now.toString()}: ${stuck.join('; ')}`);
  } catch (e) {
    wrap(e);
  }
};

const SEEDS = Array.from({ length: 320 }, (_, i) => 1000 + i * 7919);

describe('invarianti su mondi casuali (seme fisso)', () => {
  for (let chunk = 0; chunk < 4; chunk++) {
    const seeds = SEEDS.slice(chunk * 80, chunk * 80 + 80);
    it(`mondi ${seeds[0]}..${seeds[seeds.length - 1]}`, async () => {
      for (const seed of seeds) await runWorld(seed);
    }, 30000);
  }

  // La simulazione deve davvero esercitare i casi critici (altrimenti gli
  // invarianti passerebbero a vuoto)
  it('copertura dei casi', () => {
    const c = coverage;
    const msg = JSON.stringify(c);
    if (c.worlds < 300 || c.calls < 800 || c.outcomes < 500 || c.alternativesOffered < 600 || c.alternativesAccepted < 30 ||
        c.backfills < 60 || c.advances < 40 || c.incrementalInserts < 50 || c.ignoredOutcomes < 40 || c.dstWorlds < 100) {
      throw new Error(`copertura insufficiente: ${msg}`);
    }
    console.log(`invarianti: ${msg}`);
  });
});

export { runWorld };
