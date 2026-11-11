import { describe, expect, it } from 'vitest';
import type { AlternativeSlot, Appointment } from '../src/types';
import { computeAlternativeSlots, inferChosenAlternative } from '../src/services/alternativesService';
import { nextDueCall, reduceCallOutcome } from '../src/services/autopilotService';
import { computeDispatch } from '../src/services/dispatchService';
import {
  type DayContext,
  addDaysStr,
  dateAtMinutes,
  findFeasibleSlots,
  getDayRoute,
  placeAppointment,
  removeFromRoute,
  toMin,
  travelMinutes,
} from '../src/services/slotService';
import { P, appt, at, outcome, planning, stop, tech } from './fixtures';

// Test di regressione: uno per ogni bug trovato in revisione. Ognuno fallisce
// sul codice precedente alla correzione.

const NOW = at('2026-11-11', '10:00'); // mercoledì
const D = '2026-11-13';                // venerdì
const MON = '2026-11-16';
const TUE = '2026-11-17';
const ON = planning(NOW);
const byId = (all: Appointment[], id: string) => all.find(a => a.id === id)!;

// Venerdì con la pratica "x" chiamata e in attesa di esito
const friday = (): Appointment[] => [
  stop('s1', D, '09:00', '09:20', P.milano, { sequenceOrder: 1 }),
  stop('x', D, '10:00', '10:20', P.portaVenezia, { title: 'Cliente X', sequenceOrder: 2, callStatus: 'called', callId: 'c1' }),
  stop('s3', D, '11:30', '11:50', P.sesto, { sequenceOrder: 3 }),
];

describe('rimpiazzo dello slot liberato', () => {
  it('non anticipa una proposta prima della sua data di rientro', () => {
    // "late" è proposta lunedì e non può essere vista prima di lunedì (followUpDate)
    const late = stop('late', MON, '10:00', '10:20', P.portaVenezia, { sequenceOrder: 1, followUpDate: MON });
    const out = reduceCallOutcome([...friday(), late], 'x', outcome('rifiutato'), 'c1', ON);
    expect(byId(out, 'late')).toMatchObject({ date: MON, startTime: '10:00' });
    // controprova: senza data di rientro sarebbe stata anticipata
    const ctrl = reduceCallOutcome([...friday(), { ...late, followUpDate: undefined }], 'x', outcome('rifiutato'), 'c1', ON);
    expect(byId(ctrl, 'late').date).toBe(D);
  });

  it('non sceglie una pratica che ha una chiamata in corso', () => {
    const busy = appt({
      id: 'busy', coords: P.portaVenezia, technicianId: 'tech-1', phone: '+390211111111',
      callStatus: 'called', callId: 'c9', calledAt: at('2026-11-11', '09:55').toISOString(),
    });
    const out = reduceCallOutcome([...friday(), busy], 'x', outcome('rifiutato'), 'c1', ON);
    expect(byId(out, 'busy')).toMatchObject({ status: 'pending', callId: 'c9' });
    expect(byId(out, 'busy').date).toBeUndefined();
    expect(byId(out, 'busy').autoCall).toBeUndefined();
  });
});

describe('esito arrivato in ritardo', () => {
  // x: chiamata partita più di 45' fa (non più "in volo"), con l'alternativa A
  // martedì 10:30; y: chiamata in corso a cui è stato offerto lo stesso slot
  const altA: AlternativeSlot = { label: 'A', date: TUE, startTime: '10:30', endTime: '10:50' };
  const state = (): Appointment[] => [
    stop('x', D, '10:00', '10:20', P.portaVenezia, {
      sequenceOrder: 1, callStatus: 'called', callId: 'c1', calledAt: at('2026-11-11', '08:50').toISOString(), offeredAlternatives: [altA],
    }),
    stop('t1', TUE, '09:00', '09:20', P.milano, { sequenceOrder: 1 }),
    stop('y', '2026-11-18', '09:00', '09:20', P.navigli, {
      sequenceOrder: 1, callStatus: 'called', callId: 'c2', calledAt: at('2026-11-11', '09:58').toISOString(), offeredAlternatives: [{ ...altA }],
    }),
  ];

  it('non si prende lo slot offerto a un altro cliente in una chiamata in corso', () => {
    const out = reduceCallOutcome(state(), 'x', outcome('confermato', { chosenAlternative: 'A' }), 'c1', planning(NOW, { backfill: false }));
    const x = byId(out, 'x');
    expect(x.status).toBe('pending');
    expect(x.notes).toContain('non è più libera');
    expect(getDayRoute(out, 'tech-1', TUE).map(s => s.id)).toEqual(['t1']);
    // controprova: senza la chiamata in corso di y lo slot è libero
    const free = state().map(a => (a.id === 'y' ? { ...a, offeredAlternatives: undefined } : a));
    const ok = reduceCallOutcome(free, 'x', outcome('confermato', { chosenAlternative: 'A' }), 'c1', planning(NOW, { backfill: false }));
    expect(byId(ok, 'x')).toMatchObject({ status: 'confirmed', date: TUE, startTime: '10:30' });
  });
});

describe('uscita dal giro', () => {
  it('svuota la coda: al rientro nel giro non parte una chiamata mai approvata', () => {
    // x: chiamata senza esito da oltre 45', rimessa in coda; poi l'esito arriva
    const x = stop('x', D, '10:00', '10:20', P.portaVenezia, {
      callStatus: 'called', callId: 'c1', calledAt: at('2026-11-11', '08:50').toISOString(), autoCall: 'route',
    });
    const out = reduceCallOutcome([x], 'x', outcome('da_richiamare'), 'c1', ON);
    const left = byId(out, 'x');
    expect(left.status).toBe('issue');
    expect(left.autoCall).toBeUndefined();
    // la pratica torna nel giro (smistamento): non deve essere chiamata da sola
    const back = placeAppointment(out, 'x', { date: MON, option: { start: 600, end: 620, position: 0, detourKm: 0, lunchBefore: false } });
    expect(nextDueCall(back, ON)).toBeNull();
    expect(removeFromRoute([x], 'x', { status: 'standby' })[0].autoCall).toBeUndefined();
  });
});

describe('smistamento con chiamate in corso', () => {
  const T = tech();
  const params = { startDate: MON, horizonDays: 1, includeWeekends: false };

  it('non occupa gli slot offerti in una chiamata ancora in corso; la sequenza ignora gli slot riservati', async () => {
    const e1 = stop('e1', MON, '09:00', '09:20', P.milano, { sequenceOrder: 1, travelTimeFromPrev: travelMinutes(P.milano, P.milano), distanceFromPrev: 0 });
    const p = appt({ id: 'p', coords: P.portaVenezia, technicianId: 'tech-1' });
    const first = await computeDispatch([p], [T], null, params, undefined, [e1, p]);
    const placed = first.updates.find(u => u.id === 'p')!;
    expect(placed.date).toBe(MON);

    // lo stesso slot viene offerto a k in una chiamata in corso
    const offer: AlternativeSlot = { label: 'A', date: MON, startTime: placed.startTime!, endTime: placed.endTime! };
    const k = stop('k', TUE, '09:00', '09:20', P.navigli, {
      callStatus: 'called', callId: 'ck', calledAt: at('2026-11-11', '09:58').toISOString(), offeredAlternatives: [offer],
    });
    const res = await computeDispatch([p], [T], null, params, undefined, [e1, k, p], NOW);
    const again = res.updates.find(u => u.id === 'p')!;
    if (again.date === MON) {
      const s = toMin(again.startTime!), e = toMin(again.endTime!);
      expect(s >= toMin(offer.endTime) || e <= toMin(offer.startTime)).toBe(true);
    }
    // sequenza solo sulle tappe vere: e1 e p (se inserita) = 1..n
    const seqs = [...res.updates.filter(u => u.date === MON).map(u => u.sequenceOrder), ...res.patches.map(x => x.changes.sequenceOrder)];
    for (const s of seqs) if (s !== undefined) expect(s).toBeLessThanOrEqual(2);

    // chiamata ormai senza esito da oltre 45': lo slot torna libero
    const late = await computeDispatch([p], [T], null, params, undefined, [e1, k, p], at('2026-11-11', '11:00'));
    expect(late.updates.find(u => u.id === 'p')!.startTime).toBe(placed.startTime);
  });
});

describe('pausa pranzo', () => {
  const ctx: DayContext = { windowStart: toMin('08:30'), windowEnd: toMin('18:00'), base: P.milano };

  it('tappa del mattino in un giro senza pausa segnata: lascia i 45\' prima della pomeridiana', () => {
    // la tappa con la pausa (12:15-12:35) è uscita dal giro: restano 11:00 e 13:10
    const route = getDayRoute(
      [stop('a', D, '11:00', '11:20', P.milano), stop('b', D, '13:10', '13:30', P.milano)],
      'tech-1',
      D
    );
    // visita di 60': prima entrava 11:25-12:25 e dalle 12:30 alle 13:10 il
    // tecnico aveva solo 40' (pranzo perso)
    const options = findFeasibleSlots(route, ctx, P.milano, 60).filter(o => o.position === 1);
    expect(options).toEqual([]);
    // con 20' la visita entra e i 45' restano
    const short = findFeasibleSlots(route, ctx, P.milano, 20).find(o => o.position === 1)!;
    expect(13 * 60 + 10 - Math.max(short.end + travelMinutes(P.milano, P.milano), 720)).toBeGreaterThanOrEqual(45);
  });

  it('tappa dalle 12:00 in un giro senza pausa segnata: la pausa si aggiunge', () => {
    const route = getDayRoute(
      [stop('a', D, '11:40', '12:00', P.milano), stop('b', D, '15:00', '15:20', P.milano)],
      'tech-1',
      D
    );
    const between = findFeasibleSlots(route, ctx, P.milano, 20).find(o => o.position === 1)!;
    expect(between.lunchBefore).toBe(true);
    expect(between.start).toBeGreaterThanOrEqual(toMin('12:00') + travelMinutes(P.milano, P.milano) + 45);
  });
});

describe('findFeasibleSlots: tappe fuori finestra o sovrapposte', () => {
  it('mai prima dell\'inizio della finestra, anche dopo una tappa del mattino', () => {
    // indisponibile fino alle 11:00 (registrata dopo che il giro aveva la tappa delle 8:45)
    const ctx: DayContext = { windowStart: toMin('11:00'), windowEnd: toMin('18:00'), base: P.milano };
    const route = getDayRoute([stop('a', D, '08:45', '09:05', P.milano)], 'tech-1', D);
    const options = findFeasibleSlots(route, ctx, P.portaVenezia, 20);
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o.start).toBeGreaterThanOrEqual(toMin('11:00'));
  });

  it('dopo tappe sovrapposte (messe a mano) si parte dalla fine più tarda', () => {
    const ctx: DayContext = { windowStart: toMin('08:30'), windowEnd: toMin('18:00'), base: P.milano };
    const route = getDayRoute(
      [stop('lunga', D, '09:00', '11:00', P.milano, { durationMinutes: 120 }), stop('dentro', D, '09:30', '09:50', P.milano)],
      'tech-1',
      D
    );
    const after = findFeasibleSlots(route, ctx, P.milano, 20).find(o => o.position === 2)!;
    expect(after.start).toBeGreaterThanOrEqual(toMin('11:00'));
  });
});

describe('alternative nel giorno del cambio d\'ora', () => {
  // Primo giorno del 2026 in cui, nel fuso locale, l'ora si porta avanti
  // (nessuno in UTC: il test vale comunque)
  const springForward = (() => {
    for (let i = 0; i < 365; i++) {
      const d = addDaysStr('2026-01-01', i);
      if (dateAtMinutes(d, 720).getTime() - dateAtMinutes(d, 0).getTime() < 720 * 60000) return d;
    }
    return '2026-03-29';
  })();

  it('rispetta l\'anticipo minimo in ora locale', () => {
    const now = dateAtMinutes(springForward, 9 * 60); // 09:00 locali
    const x = appt({ id: 'x', coords: P.milano, phone: '+3902' });
    const alts = computeAlternativeSlots(x, [x], [], {
      now,
      fallback: { start: '08:30', end: '18:00', base: null },
      includeWeekends: true,
      horizonDays: 0,
      minLeadMinutes: 180,
    });
    expect(alts.length).toBe(1);
    const start = dateAtMinutes(alts[0].date, toMin(alts[0].startTime)).getTime();
    expect(start).toBeGreaterThanOrEqual(now.getTime() + 180 * 60000);
  });
});

describe('alternativa dedotta nella stessa data della proposta', () => {
  const offered: AlternativeSlot[] = [
    { label: 'A', date: '2026-11-12', startTime: '15:00', endTime: '15:20' },
    { label: 'B', date: D, startTime: '14:00', endTime: '14:20' },
  ];

  it('"confermo venerdì" senza orario conferma la proposta, non l\'alternativa', () => {
    const current = { date: D, startTime: '10:00' };
    expect(inferChosenAlternative(outcome('confermato', { requestedDate: D }), offered, current)).toBeUndefined();
    expect(inferChosenAlternative(outcome('confermato', { requestedDate: D, requestedTime: '14:00' }), offered, current)).toBe('B');
    expect(inferChosenAlternative(outcome('confermato', { requestedDate: D, requestedTime: '10:00' }), offered, current)).toBeUndefined();
    // senza slot corrente resta il comportamento precedente
    expect(inferChosenAlternative(outcome('confermato', { requestedDate: D }), offered)).toBe('B');

    const all = friday().map(a => (a.id === 'x' ? { ...a, offeredAlternatives: offered } : a));
    const x = byId(reduceCallOutcome(all, 'x', outcome('confermato', { requestedDate: D }), 'c1', ON), 'x');
    expect(x).toMatchObject({ status: 'confirmed', date: D, startTime: '10:00' });
  });
});
