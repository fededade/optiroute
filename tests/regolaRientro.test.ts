import { describe, expect, it } from 'vitest';
import type { Appointment, Coordinates, Technician } from '../src/types';
import { computeDispatch, type DispatchParams, type DispatchProposal } from '../src/services/dispatchService';
import { computeAlternativeSlots, resolveAlternative } from '../src/services/alternativesService';
import { reduceCallOutcome } from '../src/services/autopilotService';
import {
  RETURN_TOLERANCE_KM,
  type AppointmentPatch,
  type DayContext,
  type SlotOption,
  allowedByReturnRule,
  applyPatches,
  bestSlot,
  bestSlotForReturn,
  findFeasibleSlots,
  getDayRoute,
  isDraftStop,
  isInRoute,
  removeFromRoute,
  slotSignature,
  toHHMM,
  toMin,
  travelMinutes,
} from '../src/services/slotService';
import { calculateDistance, calculateSchedule, nearestNeighborChain, optimizeRoute } from '../src/utils/geo';
import { FALLBACK, P, appt, at, outcome, planning, stop, tech } from './fixtures';

// Regola del rientro: nel giro di un tecnico l'ULTIMO sopralluogo deve essere
// il più vicino possibile alla base (se finisce tardi, almeno il rientro è breve).

const MON = '2026-11-16';
const TUE = '2026-11-17';
const WED = '2026-11-18';
const params: DispatchParams = { startDate: MON, horizonDays: 5, includeWeekends: false };
const T = tech();
const BASE = P.milano;
const km = (c: Coordinates) => calculateDistance(BASE, c);

const pend = (id: string, coords: Coordinates, over: Partial<Appointment> = {}) =>
  appt({ id, coords, technicianId: 'tech-1', phone: `+3902${id.padEnd(8, '0')}`, ...over });

// Bozza: tappa proposta dallo smistamento e mai toccata
const draft = (id: string, date: string, start: string, end: string, coords: Coordinates, over: Partial<Appointment> = {}) => {
  const s = stop(id, date, start, end, coords, over);
  return { ...s, autoSlot: slotSignature(s) };
};

// Applica una proposta allo stato come fa la UI (updates per intero, poi patches)
const apply = (all: Appointment[], res: DispatchProposal) => {
  const byId = new Map(res.updates.map(u => [u.id, u]));
  const merged = all.map(a => byId.get(a.id) || a);
  for (const u of res.updates) if (!all.some(a => a.id === u.id)) merged.push(u);
  return applyPatches(merged, res.patches);
};

// Tappe nel giro raggruppate per giorno, ordinate per orario
const days = (all: Appointment[]) => {
  const keys = [...new Set(all.filter(isInRoute).map(a => `${a.technicianId}|${a.date}`))].sort();
  return keys.map(k => {
    const [t, d] = k.split('|');
    return { key: k, route: getDayRoute(all, t, d).map(s => s.appt) };
  });
};

// L'ultima tappa per orario ha la distanza minima dalla base
const expectLastNearest = (route: Appointment[], base: Coordinates = BASE) => {
  const d = route.map(a => calculateDistance(base, a.coords));
  expect(d[d.length - 1], `ultima tappa ${route[route.length - 1].id} non è la più vicina`).toBeLessThanOrEqual(Math.min(...d) + 1e-9);
};

const expectNoOverlap = (all: Appointment[]) => {
  for (const { route } of days(all)) {
    const stops = route.map(a => ({ start: toMin(a.startTime!), end: toMin(a.endTime!), coords: a.coords }));
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].start).toBeGreaterThanOrEqual(stops[i - 1].end + travelMinutes(stops[i - 1].coords, stops[i].coords));
    }
    expect(route.map(a => a.sequenceOrder)).toEqual(route.map((_, i) => i + 1));
  }
};

const timeKey = (a: Appointment) => `${a.date} ${a.startTime}-${a.endTime} ${a.technicianId}`;
const DRAFT_FIELDS = ['startTime', 'endTime', 'sequenceOrder', 'travelTimeFromPrev', 'distanceFromPrev', 'hasLunchBreakBefore', 'autoSlot'];
const SEQ_FIELDS = ['sequenceOrder', 'travelTimeFromPrev', 'distanceFromPrev'];

// Generatore deterministico per i casi "a caso"
const lcg = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

describe('giorno nuovo: si finisce sulla tappa più vicina alla base', () => {
  const cases: [string, Appointment[]][] = [
    ['solo normali', ['sesto', 'assago', 'rho', 'navigli', 'segrate', 'monza'].map((c, i) => pend(`n${i}`, P[c]))],
    ['urgente lontana', [pend('u', P.pavia, { urgent: true }), pend('a', P.portaVenezia), pend('b', P.navigli), pend('c', P.sesto)]],
    ['urgente vicina, normali lontane', [pend('u', P.portaVenezia, { urgent: true }), pend('a', P.monza), pend('b', P.rho), pend('c', P.lodi)]],
    [
      'urgenti vicine e lontane, rientrate',
      [
        pend('u1', P.cityLife, { urgent: true }),
        pend('u2', P.bergamo, { urgent: true }),
        pend('r1', P.cinisello, { followUpDate: MON }),
        pend('a', P.navigli),
        pend('b', P.segrate),
        pend('c', P.assago),
      ],
    ],
  ];

  for (const [name, pending] of cases) {
    it(name, async () => {
      const res = await computeDispatch(pending, [T], null, params);
      const after = apply(pending, res);
      expect(res.patches).toEqual([]);
      const planned = days(after);
      expect(planned.length).toBeGreaterThan(0);
      for (const { route } of planned) if (route.length >= 2) expectLastNearest(route);
      expectNoOverlap(after);
      // tutte le pratiche sono collocate o restano in attesa, nessuna persa
      expect(new Set(res.updates.map(u => u.id))).toEqual(new Set(pending.map(a => a.id)));
    });
  }

  it("l'urgente vicina entra nel primo giorno e chiude il giro", async () => {
    const pending = cases[2][1];
    const res = await computeDispatch(pending, [T], null, params);
    const monday = res.plans.find(p => p.date === MON)!.appointments;
    expect(monday[monday.length - 1].id).toBe('u');
    // l'urgente lontana invece apre il giro (si parte dalla più lontana)
    const res2 = await computeDispatch(cases[1][1], [T], null, params);
    expect(res2.plans.find(p => p.date === MON)!.appointments[0].id).toBe('u');
  });

  it('mondi a caso: la garanzia vale in ogni giorno pianificato', async () => {
    const keys = Object.keys(P);
    const rnd = lcg(42);
    let checked = 0;
    for (let w = 0; w < 40; w++) {
      const n = 3 + Math.floor(rnd() * 14);
      const pending = Array.from({ length: n }, (_, i) => {
        const c = P[keys[Math.floor(rnd() * keys.length)]];
        return pend(`w${w}-${i}`, { lat: c.lat + (rnd() - 0.5) * 0.04, lng: c.lng + (rnd() - 0.5) * 0.04 }, {
          urgent: rnd() < 0.2,
          followUpDate: rnd() < 0.15 ? TUE : undefined,
          durationMinutes: rnd() < 0.3 ? 20 + Math.floor(rnd() * 5) * 15 : undefined,
        });
      });
      const t = tech({ workStart: rnd() < 0.5 ? '08:30' : '09:00', workEnd: rnd() < 0.5 ? '18:00' : '13:00' });
      const res = await computeDispatch(pending, [t], null, params);
      const after = apply(pending, res);
      expectNoOverlap(after);
      for (const { route } of days(after)) {
        if (route.length < 2) continue;
        expectLastNearest(route);
        checked += 1;
      }
      for (const a of after.filter(isInRoute)) {
        expect(toMin(a.endTime!)).toBeLessThanOrEqual(toMin(t.workEnd));
        if (a.followUpDate) expect(a.date! >= a.followUpDate).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('senza base nulla cambia: catena del più vicino e overflow come prima', async () => {
    const noBase = tech({ baseCoords: undefined });
    const pending = ['sesto', 'assago', 'rho', 'navigli', 'segrate'].map((c, i) => pend(`x${i}`, P[c]));
    const res = await computeDispatch(pending, [noBase], null, params);
    const chain = nearestNeighborChain(pending, null);
    const expected = await calculateSchedule(chain, null, 8, 30, 18, 20, {
      useEstimates: true,
      startFromBase: true,
      maxEndTimeMinutes: 0,
      roundToMinutes: 5,
    });
    expect(res.updates.filter(u => u.date === MON).map(a => [a.id, a.startTime, a.endTime])).toEqual(
      expected.scheduled.map(a => [a.id, a.startTime, a.endTime])
    );
  });
});

describe('giorno nuovo: scelta per priorità e numero di tappe', () => {
  // Ricostruzione indipendente della regola: si scorre la priorità e ogni
  // pratica entra se, con quelle già scelte e ordinate con optimizeRoute,
  // entrano tutte; chi non entra si salta e non blocca le successive
  const expectedDay = async (priority: Appointment[], t: Technician) => {
    const [sh, sm] = t.workStart.split(':').map(Number);
    const [eh, em] = t.workEnd.split(':').map(Number);
    const chosen: Appointment[] = [];
    let out: (string | undefined)[][] = [];
    for (const a of priority) {
      const r = await calculateSchedule(optimizeRoute([...chosen, a], BASE), BASE, sh, sm, eh, 20, {
        useEstimates: true,
        startFromBase: true,
        maxEndTimeMinutes: em,
        roundToMinutes: 5,
      });
      if (r.overflow.length > 0) continue;
      chosen.push(a);
      out = r.scheduled.map(x => [x.id, x.startTime, x.endTime]);
    }
    return out;
  };

  it('finestra corta: entrano le prime della priorità (urgente lontana compresa), le altre slittano', async () => {
    const t = tech({ workEnd: '11:00' });
    const urgent = pend('u', P.pavia, { urgent: true });
    const normals = ['portaVenezia', 'navigli', 'cityLife', 'segrate', 'sesto'].map((c, i) => pend(`n${i}`, P[c]));
    const pending = [...normals, urgent];
    const res = await computeDispatch(pending, [t], null, params);
    const monday = res.plans.find(p => p.date === MON)!.appointments;
    expect(monday.map(a => a.id)).toContain('u');
    const priority = [urgent, ...nearestNeighborChain(normals, urgent.coords)];
    expect(monday.map(a => [a.id, a.startTime, a.endTime])).toEqual(await expectedDay(priority, t));
    expect(monday.length).toBeLessThan(pending.length);
    expectLastNearest(monday);
    // le altre nei giorni seguenti, nessuna persa
    const placed = res.plans.flatMap(p => p.appointments.map(a => a.id));
    const waiting = res.unscheduled.flatMap(u => u.appointments.map(a => a.id));
    expect(new Set([...placed, ...waiting])).toEqual(new Set(pending.map(a => a.id)));
    expect(placed.length).toBe(new Set(placed).size);
  });

  it('urgenti e rientrate prima delle normali, anche se lontane', async () => {
    const t = tech({ workEnd: '10:30' });
    const pending = [
      pend('n1', P.portaVenezia),
      pend('n2', P.navigli),
      pend('n3', P.cityLife),
      pend('r', P.sesto, { followUpDate: MON }),
      pend('u', P.segrate, { urgent: true }),
    ];
    const res = await computeDispatch(pending, [t], null, params);
    const monday = res.plans.find(p => p.date === MON)!.appointments.map(a => a.id);
    expect(monday).toContain('u');
    expect(monday).toContain('r');
    expect(monday.length).toBeLessThan(5);
  });

  it('il limite delle durate: in 2h30 al massimo due visite da un\'ora', async () => {
    const t = tech({ workEnd: '11:00' });
    const pending = ['portaVenezia', 'navigli', 'cityLife', 'milano'].map((c, i) => pend(`h${i}`, P[c], { durationMinutes: 60 }));
    const res = await computeDispatch(pending, [t], null, params);
    // il limite superiore viene dalle durate; poi decidono i viaggi
    expect(res.plans.find(p => p.date === MON)!.appointments).toHaveLength(2);
    for (const plan of res.plans) expect(plan.appointments.length).toBeLessThanOrEqual(2);
    expect(res.plans.reduce((n, p) => n + p.appointments.length, 0)).toBe(4);
  });

  it('una pratica che non entra non blocca quelle dopo di lei', async () => {
    const t = tech({ workEnd: '09:30' });
    const pending = [pend('u', P.bergamo, { urgent: true }), pend('n', P.portaVenezia)];
    const res = await computeDispatch(pending, [t], null, { ...params, horizonDays: 1 });
    expect(res.plans.map(p => p.appointments.map(a => a.id))).toEqual([['n']]);
    expect(res.unscheduled[0].appointments.map(a => a.id)).toEqual(['u']);
    const u = res.updates.find(a => a.id === 'u')!;
    expect(u).toMatchObject({ status: 'pending', date: undefined, startTime: undefined, endTime: undefined, sequenceOrder: undefined });
  });

  it("una seconda urgente lontana non lascia il giorno mezzo vuoto", async () => {
    // U1 Porta Venezia e U2 Bergamo urgenti; U1+U2 non stanno in 08:30-10:30
    const t = tech({ workEnd: '10:30' });
    const p = { ...params, horizonDays: 2 };
    const pending = [
      pend('U1', P.portaVenezia, { urgent: true }),
      pend('U2', P.bergamo, { urgent: true }),
      pend('N1', P.navigli),
      pend('N2', P.cityLife),
      pend('N3', P.lodi),
      pend('N4', P.pavia),
    ];
    const res = await computeDispatch(pending, [t], null, p);
    const monday = res.plans.find(pl => pl.date === MON)!.appointments;
    expect(monday.map(a => a.id)).toContain('U1');
    expect(monday.map(a => a.id)).not.toContain('U2');
    expect(monday.map(a => a.id)).toEqual(expect.arrayContaining(['N1', 'N2']));
    expectLastNearest(monday);
    expect(res.plans.find(pl => pl.date === TUE)!.appointments.map(a => a.id)).toContain('U2');
    // secondo smistamento con le stesse pratiche rimaste in attesa: nulla cambia
    const all = apply(pending, res);
    const again = await computeDispatch(all.filter(a => a.status === 'pending'), [t], null, p, undefined, all);
    expect(again.patches).toEqual([]);
    expect(again.updates.filter(u => u.status === 'proposed')).toEqual([]);
    expect(again.plans).toEqual([]);
  });
});

describe('slotSignature e isDraftStop', () => {
  const base = () => draft('d', MON, '09:00', '09:20', P.navigli);

  it('firma "data|inizio|tecnico"', () => {
    expect(slotSignature(base())).toBe(`${MON}|09:00|tech-1`);
    expect(slotSignature({ date: MON, startTime: '09:00', technicianId: undefined })).toBe(`${MON}|09:00|`);
  });

  it('bozza: proposta dallo smistamento, nel giro, mai toccata', () => {
    expect(isDraftStop(base())).toBe(true);
  });

  const notDraft: [string, Partial<Appointment>][] = [
    ['confermata', { status: 'confirmed' }],
    ['fuori dal giro', { status: 'pending', date: undefined, startTime: undefined }],
    ['senza autoSlot (versione precedente)', { autoSlot: undefined }],
    ['data cambiata a mano', { date: TUE }],
    ['orario cambiato a mano', { startTime: '09:05' }],
    ['tecnico cambiato a mano', { technicianId: 'tech-2' }],
    ['approvata per la chiamata', { autoCall: 'route' }],
    ['chiamata in corso', { callStatus: 'calling' }],
    ['con id di chiamata', { callId: 'c1' }],
    ['lancio registrato', { callStartedAt: '2026-11-11T09:00:00.000Z' }],
    ['già chiamata', { calledAt: '2026-11-11T09:00:00.000Z' }],
    ['con esito', { callOutcome: outcome('non_risposto') }],
    ['tentativi già fatti', { callAttempts: 1 }],
    ['alternative offerte', { offeredAlternatives: [{ label: 'A', date: TUE, startTime: '10:00', endTime: '10:20' }] }],
    ['rimpiazzo', { backfillOf: 'Cliente X' }],
  ];
  for (const [name, over] of notDraft) {
    it(`non è bozza: ${name}`, () => {
      expect(isDraftStop({ ...base(), ...over })).toBe(false);
    });
  }

  it('tentativi a zero e alternative vuote non contano', () => {
    expect(isDraftStop({ ...base(), callAttempts: 0, offeredAlternatives: [] })).toBe(true);
  });

  it('removeFromRoute azzera la firma', () => {
    const out = removeFromRoute([base()], 'd', { status: 'pending' });
    expect(out[0].autoSlot).toBeUndefined();
  });
});

describe('giorno di sole bozze: si ripianifica da capo', () => {
  const firstRun = async (pending: Appointment[], t: Technician = T) => {
    const res = await computeDispatch(pending, [t], null, params);
    return apply(pending, res);
  };

  it('una pratica nuova più lontana: le bozze slittano, l\'ultima resta la più vicina', async () => {
    let all = await firstRun([pend('a', P.navigli), pend('b', P.cityLife)]);
    expect(all.every(isDraftStop)).toBe(true);
    expect(all.every(a => a.date === MON && a.autoSlot === slotSignature(a))).toBe(true);
    const before = new Map(all.map(a => [a.id, a]));

    const fresh = pend('far', P.sesto);
    all = [...all, fresh];
    const res = await computeDispatch([fresh], [T], null, params, undefined, all);
    // la nuova è un update, le bozze cambiano solo con patch dei campi di pianificazione
    expect(res.updates.map(u => u.id)).toEqual(['far']);
    expect(res.updates[0]).toMatchObject({ status: 'proposed', date: MON });
    expect(res.patches.map(p => p.id).sort()).toEqual(['a', 'b']);
    for (const p of res.patches) {
      expect(Object.keys(p.changes).every(k => DRAFT_FIELDS.includes(k))).toBe(true);
      expect(p.changes.startTime).not.toBe(before.get(p.id)!.startTime);
    }
    // anteprima: il giro vero del giorno
    const plan = res.plans.find(p => p.date === MON)!;
    expect(plan.appointments.map(a => a.id)).toEqual(['far', 'b', 'a']);
    const after = apply(all, res);
    const route = getDayRoute(after, 'tech-1', MON).map(s => s.appt);
    expect(route.map(a => a.id)).toEqual(['far', 'b', 'a']);
    expectLastNearest(route);
    expectNoOverlap(after);
    // le bozze risistemate restano bozze (firma aggiornata)
    expect(route.every(isDraftStop)).toBe(true);
  });

  it('se non entra nessuna pratica nuova il giorno resta com\'è', async () => {
    const t = tech({ workEnd: '10:30' });
    let all = await firstRun([pend('a', P.navigli, { durationMinutes: 30 }), pend('b', P.portaVenezia, { durationMinutes: 30 })], t);
    expect(getDayRoute(all, 'tech-1', MON)).toHaveLength(2);
    const fresh = pend('c', P.sesto, { durationMinutes: 30 });
    all = [...all, fresh];
    const res = await computeDispatch([fresh], [t], null, params, undefined, all);
    expect(res.patches).toEqual([]);
    expect(res.plans.map(p => p.date)).toEqual([TUE]);
    expect(res.updates).toHaveLength(1);
    expect(res.updates[0]).toMatchObject({ id: 'c', date: TUE, status: 'proposed' });
  });

  const modifiers: [string, (a: Appointment) => Appointment][] = [
    ['approvata per la chiamata', a => ({ ...a, autoCall: 'route' })],
    ['confermata', a => ({ ...a, status: 'confirmed' })],
    ['spostata a mano', a => ({ ...a, startTime: toHHMM(toMin(a.startTime!) + 10), endTime: toHHMM(toMin(a.endTime!) + 10) })],
  ];
  for (const [name, modify] of modifiers) {
    it(`con una tappa ${name} nessuna tappa si sposta`, async () => {
      let all = await firstRun([pend('a', P.navigli), pend('b', P.cityLife)]);
      all = all.map(a => (a.id === 'a' ? modify(a) : a));
      const before = new Map(all.map(a => [a.id, timeKey(a)]));
      const fresh = pend('far', P.sesto);
      all = [...all, fresh];
      const res = await computeDispatch([fresh], [T], null, params, undefined, all);
      for (const p of res.patches) expect(Object.keys(p.changes).every(k => SEQ_FIELDS.includes(k))).toBe(true);
      const after = apply(all, res);
      for (const id of ['a', 'b']) expect(timeKey(after.find(x => x.id === id)!)).toBe(before.get(id));
      expect(after.find(x => x.id === 'far')).toMatchObject({ status: 'proposed', date: MON });
      expectNoOverlap(after);
    });
  }

  it('con uno slot riservato a una chiamata in corso il giorno non si ripianifica', async () => {
    let all = await firstRun([pend('a', P.navigli), pend('b', P.cityLife)]);
    const caller = stop('k', WED, '09:00', '09:20', P.portaVenezia, {
      callStatus: 'called',
      callId: 'c1',
      offeredAlternatives: [{ label: 'A', date: MON, startTime: '16:00', endTime: '16:20' }],
    });
    const before = new Map(all.map(a => [a.id, timeKey(a)]));
    const fresh = pend('far', P.sesto);
    all = [...all, caller, fresh];
    const res = await computeDispatch([fresh], [T], null, params, undefined, all, at('2026-11-11', '10:00'));
    const after = apply(all, res);
    for (const id of ['a', 'b']) expect(timeKey(after.find(x => x.id === id)!)).toBe(before.get(id));
    for (const p of res.patches) expect(Object.keys(p.changes).every(k => SEQ_FIELDS.includes(k))).toBe(true);
  });

  it('senza base il giorno di bozze non si ripianifica', async () => {
    const noBase = tech({ baseCoords: undefined });
    let all = await firstRun([pend('a', P.navigli), pend('b', P.cityLife)], noBase);
    const before = new Map(all.map(a => [a.id, timeKey(a)]));
    const fresh = pend('far', P.sesto);
    all = [...all, fresh];
    const res = await computeDispatch([fresh], [noBase], null, params, undefined, all);
    const after = apply(all, res);
    for (const id of ['a', 'b']) expect(timeKey(after.find(x => x.id === id)!)).toBe(before.get(id));
  });

  // Lunedì pieno di bozze (finestra corta): un'urgente nuova ne scalza una
  const displacement = async (horizonDays: number) => {
    const t = tech({ workEnd: '10:00' });
    let all = await firstRun([pend('a', P.navigli), pend('b', P.portaVenezia), pend('c', P.cityLife)], t);
    const mondayBefore = getDayRoute(all, 'tech-1', MON).map(s => s.id);
    const urgent = pend('u', P.segrate, { urgent: true });
    all = [...all, urgent];
    const res = await computeDispatch([urgent], [t], null, { ...params, horizonDays }, undefined, all);
    return { t, all, res, mondayBefore };
  };

  it("bozza scalzata da un'urgente: trova posto un altro giorno (patch con lo slot completo)", async () => {
    const { all, res, mondayBefore } = await displacement(5);
    expect(mondayBefore.length).toBeGreaterThanOrEqual(2);
    const after = apply(all, res);
    const monday = getDayRoute(after, 'tech-1', MON).map(s => s.appt);
    expect(monday.map(a => a.id)).toContain('u');
    const displaced = mondayBefore.filter(id => !monday.some(a => a.id === id));
    expect(displaced.length).toBeGreaterThan(0);
    // l'urgente è l'unico update; le bozze (rimaste o scalzate) solo patch
    expect(res.updates.map(u => u.id)).toEqual(['u']);
    for (const id of displaced) {
      const p = res.patches.find(x => x.id === id)!;
      expect(p.changes).toMatchObject({ status: 'proposed', technicianId: 'tech-1' });
      expect(p.changes.date! > MON).toBe(true);
      expect(p.changes.autoSlot).toBe(slotSignature(p.changes as Appointment));
      expect(Object.keys(p.changes).every(k => [...DRAFT_FIELDS, 'status', 'date', 'technicianId'].includes(k))).toBe(true);
      expect(res.plans.find(pl => pl.date === p.changes.date)!.appointments.map(a => a.id)).toContain(id);
      expect(isDraftStop(after.find(a => a.id === id)!)).toBe(true);
    }
    expect(res.plans.find(p => p.date === MON)!.appointments.map(a => a.id).sort()).toEqual(monday.map(a => a.id).sort());
    expectLastNearest(monday);
    expectNoOverlap(after);
    expect(res.unscheduled).toEqual([]);
  });

  it("l'urgente scalza solo le bozze che non entrano più", async () => {
    let keptWithUrgent = 0;
    for (const workEnd of ['10:00', '10:15', '10:30', '11:00']) {
      const t = tech({ workEnd });
      const first = [pend('a', P.navigli), pend('b', P.portaVenezia), pend('c', P.cityLife), pend('d', P.sesto), pend('e', P.assago)];
      let all = apply(first, await computeDispatch(first, [t], null, params));
      const mondayBefore = getDayRoute(all, 'tech-1', MON).map(s => s.id);
      const urgent = pend('u', P.segrate, { urgent: true });
      all = [...all, urgent];
      const after = apply(all, await computeDispatch([urgent], [t], null, params, undefined, all));
      const monday = getDayRoute(after, 'tech-1', MON).map(s => s.appt);
      expect(monday.map(a => a.id)).toContain('u');
      const [sh, sm] = t.workStart.split(':').map(Number);
      const [eh, em] = t.workEnd.split(':').map(Number);
      const fits = async (list: Appointment[]) =>
        (await calculateSchedule(optimizeRoute(list, BASE), BASE, sh, sm, eh, 20, {
          useEstimates: true, startFromBase: true, maxEndTimeMinutes: em, roundToMinutes: 5,
        })).overflow.length === 0;
      // ogni bozza scalzata davvero non entra più nel giorno risistemato
      const displaced = mondayBefore.filter(id => !monday.some(a => a.id === id));
      for (const id of displaced) expect(await fits([...monday, all.find(a => a.id === id)!]), `${workEnd}: ${id}`).toBe(false);
      keptWithUrgent += monday.filter(a => a.id !== 'u' && mondayBefore.includes(a.id)).length;
      if (workEnd === '10:00') {
        // il caso di Segrate: Porta Venezia con l'urgente non sta in 08:30-10:00
        expect(await fits([urgent, all.find(a => a.id === 'b')!])).toBe(false);
        expect(monday.map(a => a.id)).toEqual(['u']);
      }
    }
    // con finestre più larghe le bozze che entrano restano accanto all'urgente
    expect(keptWithUrgent).toBeGreaterThan(0);
  });

  it('bozza scalzata senza posto nell\'orizzonte: torna in attesa', async () => {
    const { all, res, mondayBefore } = await displacement(1);
    const after = apply(all, res);
    const monday = getDayRoute(after, 'tech-1', MON).map(s => s.id);
    const displaced = mondayBefore.filter(id => !monday.includes(id));
    expect(displaced.length).toBeGreaterThan(0);
    expect(res.updates.map(u => u.id)).toEqual(['u']);
    for (const id of displaced) {
      const p = res.patches.find(x => x.id === id)!;
      expect(p.changes).toEqual({
        status: 'pending',
        date: undefined,
        startTime: undefined,
        endTime: undefined,
        sequenceOrder: undefined,
        travelTimeFromPrev: undefined,
        distanceFromPrev: undefined,
        hasLunchBreakBefore: undefined,
        autoSlot: undefined,
      });
      expect(Object.keys(p.changes)).toContain('autoSlot');
      const a = after.find(x => x.id === id)!;
      expect(a).toMatchObject({ status: 'pending', technicianId: 'tech-1' });
      expect(isInRoute(a)).toBe(false);
    }
    expect(res.unscheduled.flatMap(u => u.appointments.map(a => a.id)).sort()).toEqual([...displaced].sort());
  });

  it('bozza scalzata rispetta date rifiutate e rientro', async () => {
    const t = tech({ workEnd: '10:00' });
    let all = await firstRun([pend('a', P.navigli), pend('b', P.portaVenezia), pend('c', P.cityLife)], t);
    // tutte le bozze hanno rifiutato il martedì: chi viene scalzato va a mercoledì
    all = all.map(a => ({ ...a, declinedDates: [TUE] }));
    const urgent = pend('u', P.segrate, { urgent: true });
    all = [...all, urgent];
    const res = await computeDispatch([urgent], [t], null, params, undefined, all);
    const moved = res.patches.filter(p => p.changes.status === 'proposed' && p.changes.date && p.changes.date !== MON);
    expect(moved.length).toBeGreaterThan(0);
    for (const p of moved) expect(p.changes.date).toBe(WED);
  });
});

describe('idempotenza', () => {
  const rerun = async (all: Appointment[], t: Technician, p: DispatchParams) => {
    const pending = all.filter(a => a.status === 'pending');
    const res = await computeDispatch(pending, [t], null, p, undefined, all);
    expect(res.patches).toEqual([]);
    expect(res.updates.filter(u => u.status === 'proposed')).toEqual([]);
    expect(res.plans).toEqual([]);
    expect(apply(all, res).filter(isInRoute).map(timeKey)).toEqual(all.filter(isInRoute).map(timeKey));
  };

  it('rilanciare sul risultato non sposta niente (pratiche rimaste in attesa comprese)', async () => {
    const t = tech({ workEnd: '11:00' });
    const p = { ...params, horizonDays: 2 };
    const pending = ['portaVenezia', 'navigli', 'cityLife', 'segrate', 'sesto', 'cinisello', 'monza', 'rho', 'assago', 'lodi'].map((c, i) =>
      pend(`i${i}`, P[c], { urgent: i === 4 })
    );
    const res = await computeDispatch(pending, [t], null, p);
    const all = apply(pending, res);
    expect(all.some(a => a.status === 'pending')).toBe(true);
    expect(all.some(isInRoute)).toBe(true);
    await rerun(all, t, p);
  });

  it('mondi a caso (anche finestre corte e urgenti lontane): rilanciare non cambia nulla', async () => {
    const keys = Object.keys(P);
    const rnd = lcg(7);
    const bad: string[] = [];
    let worlds = 0;
    for (let w = 0; w < 400; w++) {
      const point = () => {
        const c = P[keys[Math.floor(rnd() * keys.length)]];
        return { lat: +(c.lat + (rnd() - 0.5) * 0.04).toFixed(4), lng: +(c.lng + (rnd() - 0.5) * 0.04).toFixed(4) };
      };
      const n = 3 + Math.floor(rnd() * 10);
      const pending = Array.from({ length: n }, (_, i) =>
        pend(`w${w}-${i}`, point(), { urgent: rnd() < 0.2 || undefined, durationMinutes: rnd() < 0.2 ? 45 : undefined })
      );
      const t = tech({ workEnd: rnd() < 0.5 ? '18:00' : '12:00' });
      const p = { ...params, horizonDays: 1 + Math.floor(rnd() * 3) };
      let all = apply(pending, await computeDispatch(pending, [t], null, p));
      // a volte arrivano pratiche nuove (anche urgenti) sopra un giro di bozze
      if (rnd() < 0.5) {
        const fresh = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => pend(`w${w}-f${i}`, point(), { urgent: rnd() < 0.5 || undefined }));
        all = [...all, ...fresh];
        all = apply(all, await computeDispatch(all.filter(a => a.status === 'pending'), [t], null, p, undefined, all));
      }
      const again = await computeDispatch(all.filter(a => a.status === 'pending'), [t], null, p, undefined, all);
      worlds += 1;
      if (again.patches.length > 0 || again.updates.some(u => u.status === 'proposed')) bad.push(`mondo ${w}`);
    }
    expect(worlds).toBe(400);
    expect(bad).toEqual([]);
  });

  it('anche dopo una ripianificazione con una bozza scalzata', async () => {
    const t = tech({ workEnd: '10:00' });
    const first = [pend('a', P.navigli), pend('b', P.portaVenezia), pend('c', P.cityLife)];
    let all = apply(first, await computeDispatch(first, [t], null, params));
    const urgent = pend('u', P.segrate, { urgent: true });
    all = [...all, urgent];
    all = apply(all, await computeDispatch([urgent], [t], null, params, undefined, all));
    await rerun(all, t, params);
  });
});

describe('regola del rientro sugli slot in coda', () => {
  const D = '2026-11-13';
  const ctx: DayContext = { windowStart: toMin('08:30'), windowEnd: toMin('18:00'), base: BASE };
  const route = getDayRoute(
    [stop('r1', D, '09:00', '09:20', P.sesto), stop('r2', D, '10:00', '10:20', P.navigli)],
    'tech-1',
    D
  );
  const option = (position: number, start: string, dur = 20): SlotOption => ({
    position,
    start: toMin(start),
    end: toMin(start) + dur,
    detourKm: 0,
    lunchBefore: false,
  });

  it('in mezzo al giro sempre ammessa', () => {
    expect(allowedByReturnRule(option(1, '09:40'), route, ctx, P.bergamo)).toBe(true);
  });

  it('in coda: più vicina alla base dell\'ultima, ammessa anche a fine giornata', () => {
    expect(km(P.portaVenezia)).toBeLessThan(km(P.navigli));
    expect(allowedByReturnRule(option(2, '17:30'), route, ctx, P.portaVenezia)).toBe(true);
  });

  it('in coda e più lontana: ammessa se il rientro sta nella giornata', () => {
    const late = toMin('18:00') - travelMinutes(P.lodi, BASE) - 20; // fine + rientro = 18:00 esatte
    expect(allowedByReturnRule({ ...option(2, '10:40'), start: late, end: late + 20 }, route, ctx, P.lodi)).toBe(true);
    expect(allowedByReturnRule(option(2, '10:40'), route, ctx, P.lodi)).toBe(true);
  });

  it('in coda e più lontana: esclusa se il rientro sfora la fine della giornata', () => {
    const late = toMin('18:00') - travelMinutes(P.lodi, BASE) - 20 + 1;
    expect(allowedByReturnRule({ ...option(2, '10:40'), start: late, end: late + 20 }, route, ctx, P.lodi)).toBe(false);
    expect(allowedByReturnRule(option(2, '17:30'), route, ctx, P.lodi)).toBe(false);
  });

  it('senza base o con il giro vuoto sempre ammessa', () => {
    expect(allowedByReturnRule(option(2, '17:30'), route, { ...ctx, base: null }, P.lodi)).toBe(true);
    expect(allowedByReturnRule(option(0, '17:30'), [], ctx, P.lodi)).toBe(true);
  });

  it(`tolleranza di ${RETURN_TOLERANCE_KM} km sulla distanza dell'ultima`, () => {
    // punti sul meridiano della base, poco più lontani dell'ultima tappa (navigli)
    const at = (extraKm: number): Coordinates => {
      const target = km(P.navigli) + extraKm;
      return { lat: BASE.lat - target / 111.195, lng: BASE.lng };
    };
    expect(allowedByReturnRule(option(2, '17:30'), route, ctx, at(0.4))).toBe(true);
    expect(allowedByReturnRule(option(2, '17:30'), route, ctx, at(0.6))).toBe(false);
  });

  it('bestSlotForReturn: se la nuova è più vicina dell\'ultima preferisce la coda', () => {
    const r = getDayRoute(
      [stop('r1', D, '09:00', '09:20', P.sesto), stop('r2', D, '11:00', '11:20', P.monza)],
      'tech-1',
      D
    );
    const opts = findFeasibleSlots(r, ctx, P.cinisello, 20);
    expect(km(P.cinisello)).toBeLessThan(km(P.monza));
    expect(bestSlot(opts)!.position).toBe(1); // detour minimo: in mezzo
    expect(bestSlotForReturn(opts, r, ctx, P.cinisello)!.position).toBe(2);
  });

  it('bestSlotForReturn: più lontana dell\'ultima, la coda tardi è esclusa', () => {
    const r = getDayRoute(
      [
        stop('r1', D, '09:00', '09:20', P.navigli),
        stop('r2', D, '09:40', '16:00', P.portaVenezia, { durationMinutes: 380, hasLunchBreakBefore: true }),
      ],
      'tech-1',
      D
    );
    const opts = findFeasibleSlots(r, ctx, P.pavia, 20);
    const tail = opts.find(o => o.position === 2)!;
    expect(tail).toBeDefined();
    expect(bestSlot(opts)).toEqual(tail); // senza la regola entrerebbe in coda
    expect(allowedByReturnRule(tail, r, ctx, P.pavia)).toBe(false);
    expect(bestSlotForReturn(opts, r, ctx, P.pavia)).toBeNull();
  });

  it('nello smistamento: in coda a un giro confermato entra solo la più vicina', async () => {
    // giro confermato fino alle 16:30: in coda resta solo spazio a fine giornata
    const existing = [
      stop('e1', MON, '09:00', '09:20', P.sesto, { status: 'confirmed', sequenceOrder: 1 }),
      stop('e2', MON, '09:45', '16:30', P.navigli, { status: 'confirmed', sequenceOrder: 2, durationMinutes: 405 }),
    ];
    const far = pend('far', P.pavia);
    const near = pend('near', P.portaVenezia);
    const res = await computeDispatch([far, near], [T], null, params, undefined, [...existing, far, near]);
    expect(res.updates.find(u => u.id === 'near')).toMatchObject({ date: MON, status: 'proposed' });
    expect(res.updates.find(u => u.id === 'far')!.date).not.toBe(MON);
    const after = apply([...existing, far, near], res);
    expectLastNearest(getDayRoute(after, 'tech-1', MON).map(s => s.appt));
  });
});

describe('alternative e rimpiazzo rispettano la regola', () => {
  const NOW = at('2026-11-11', '10:00');
  const D = '2026-11-12';

  // Giovedì occupato fino alle 16:00: resta solo la coda a fine giornata
  const busyThursday = () => [stop('g1', D, '08:45', '16:00', P.navigli, { durationMinutes: 435, hasLunchBreakBefore: true })];

  it('alternativa lontana in coda a fine giornata: non offerta', () => {
    const target = stop('x', '2026-11-20', '09:00', '09:20', P.pavia);
    const all = [...busyThursday(), target];
    const ctx: DayContext = { windowStart: toMin('08:30'), windowEnd: toMin('18:00'), base: BASE };
    const route = getDayRoute(all, 'tech-1', D, 'x');
    const tail = findFeasibleSlots(route, ctx, P.pavia, 20).find(o => o.position === 1);
    expect(tail).toBeDefined(); // lo slot esisterebbe...
    expect(allowedByReturnRule(tail!, route, ctx, P.pavia)).toBe(false); // ...ma il rientro sfora
    const alts = computeAlternativeSlots(target, all, [T], { now: NOW, fallback: FALLBACK, horizonDays: 7 });
    expect(alts.length).toBeGreaterThan(0);
    expect(alts.map(a => a.date)).not.toContain(D);
  });

  it('alternativa più vicina dell\'ultima tappa: offerta in coda', () => {
    const target = stop('x', '2026-11-20', '09:00', '09:20', P.portaVenezia);
    const all = [...busyThursday(), target];
    const alts = computeAlternativeSlots(target, all, [T], { now: NOW, fallback: FALLBACK, horizonDays: 7 });
    const thursday = alts.find(a => a.date === D);
    expect(thursday).toBeDefined();
    expect(toMin(thursday!.startTime)).toBeGreaterThanOrEqual(toMin('16:00'));
  });

  it('resolveAlternative invariata: uno slot già offerto resta valido anche contro la regola', () => {
    const target = {
      ...stop('x', '2026-11-20', '09:00', '09:20', P.pavia),
      offeredAlternatives: [{ label: 'A' as const, date: D, startTime: '16:55', endTime: '17:15' }],
    };
    const all = [...busyThursday(), target];
    const ctx: DayContext = { windowStart: toMin('08:30'), windowEnd: toMin('18:00'), base: BASE };
    const route = getDayRoute(all, 'tech-1', D, 'x');
    const ok = resolveAlternative(target, 'A', all, [T], FALLBACK, NOW);
    expect(ok).not.toBeNull();
    expect(ok!.date).toBe(D);
    expect(toHHMM(ok!.option.start)).toBe('16:55');
    expect(allowedByReturnRule(ok!.option, route, ctx, P.pavia)).toBe(false); // oggi non verrebbe più offerto
  });

  // Venerdì: x (in coda, 17:20) rifiuta; lo slot liberato è a fine giornata
  const F = '2026-11-13';
  const fridayWorld = (candidates: Appointment[]) => [
    stop('s1', F, '09:00', '09:20', P.milano, { sequenceOrder: 1 }),
    stop('s2', F, '10:00', '10:20', P.portaVenezia, { sequenceOrder: 2 }),
    stop('x', F, '17:20', '17:40', P.segrate, { title: 'Cliente X', sequenceOrder: 3, callStatus: 'called', callId: 'c1' }),
    ...candidates,
  ];
  const ON = planning(NOW);

  it('rimpiazzo: una candidata lontana che rientrerebbe tardi non prende la coda', () => {
    const far = pend('far', P.pavia);
    const all = fridayWorld([far]);
    // senza la regola lo slot ci sarebbe (a fine giornata, rientro oltre le 18:00)
    const ctx: DayContext = { windowStart: toMin('08:30'), windowEnd: toMin('18:00'), base: BASE };
    const route = getDayRoute(all, 'tech-1', F, 'x');
    const opts = findFeasibleSlots(route, ctx, P.pavia, 20, { notBefore: toMin('16:50'), notAfter: toMin('19:20') });
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every(o => !allowedByReturnRule(o, route, ctx, P.pavia))).toBe(true);
    const out = reduceCallOutcome(all, 'x', outcome('rifiutato'), 'c1', ON);
    expect(out.find(a => a.id === 'far')!.status).toBe('pending');
  });

  it('rimpiazzo: una candidata vicina alla base prende la coda', () => {
    const near = pend('near', P.navigli);
    const far = pend('far', P.pavia);
    const out = reduceCallOutcome(fridayWorld([far, near]), 'x', outcome('rifiutato'), 'c1', ON);
    expect(out.find(a => a.id === 'near')).toMatchObject({ status: 'proposed', date: F, autoCall: 'backfill' });
    expect(out.find(a => a.id === 'far')!.status).toBe('pending');
  });
});

// Il campo nuovo viaggia con le patch dello smistamento automatico
describe('patches e campi di pianificazione', () => {
  it('applyPatches porta anche autoSlot (e lo azzera)', () => {
    const d = draft('d', MON, '09:00', '09:20', P.navigli);
    const patches: AppointmentPatch[] = [{ id: 'd', changes: { startTime: '09:30', endTime: '09:50', autoSlot: `${MON}|09:30|tech-1` } }];
    const [moved] = applyPatches([d], patches);
    expect(isDraftStop(moved)).toBe(true);
    const [back] = applyPatches([moved], [{ id: 'd', changes: { status: 'pending', date: undefined, startTime: undefined, autoSlot: undefined } }]);
    expect(back.autoSlot).toBeUndefined();
  });
});
