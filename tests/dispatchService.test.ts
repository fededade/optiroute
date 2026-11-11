import { describe, expect, it } from 'vitest';
import type { Appointment } from '../src/types';
import { computeDispatch, type DispatchParams } from '../src/services/dispatchService';
import { applyPatches, getDayRoute, isInRoute, toMin, travelMinutes } from '../src/services/slotService';
import { calculateSchedule, nearestNeighborChain } from '../src/utils/geo';
import { P, appt, stop, tech } from './fixtures';

const MON = '2026-11-16';
const TUE = '2026-11-17';
const WED = '2026-11-18';
const params: DispatchParams = { startDate: MON, horizonDays: 5, includeWeekends: false };
const T = tech();

const pendingBatch = (prefix: string, coords: (keyof typeof P)[], over: Partial<Appointment> = {}) =>
  coords.map((c, i) => appt({ id: `${prefix}${i}`, coords: P[c], technicianId: 'tech-1', ...over }));

// Applica una proposta allo stato (come farà la UI)
const applyProposal = (all: Appointment[], updates: Appointment[], patches: Parameters<typeof applyPatches>[1]) => {
  const byId = new Map(updates.map(u => [u.id, u]));
  const merged = all.map(a => byId.get(a.id) || a);
  for (const u of updates) if (!all.some(a => a.id === u.id)) merged.push(u);
  return applyPatches(merged, patches);
};

// Nessuna sovrapposizione: fra due tappe consecutive c'è almeno il viaggio
const expectNoOverlap = (all: Appointment[]) => {
  const keys = new Set(all.filter(isInRoute).map(a => `${a.technicianId}|${a.date}`));
  for (const k of keys) {
    const [t, d] = k.split('|');
    const route = getDayRoute(all, t, d);
    for (let i = 1; i < route.length; i++) {
      expect(route[i].start).toBeGreaterThanOrEqual(route[i - 1].end + travelMinutes(route[i - 1].coords, route[i].coords));
    }
    expect(route.map(s => s.appt.sequenceOrder)).toEqual(route.map((_, i) => i + 1));
  }
};

describe('computeDispatch', () => {
  it('giorno vuoto: stessi orari dell\'algoritmo precedente', async () => {
    const pending = pendingBatch('p', ['sesto', 'assago', 'rho', 'navigli', 'segrate'], {});
    pending[3].urgent = true;

    // Algoritmo precedente, ricostruito: catena nearest-neighbor + calculateSchedule
    const urgents = nearestNeighborChain(pending.filter(a => a.urgent), P.milano);
    const normals = nearestNeighborChain(pending.filter(a => !a.urgent), urgents[urgents.length - 1].coords);
    const expected = await calculateSchedule([...urgents, ...normals], P.milano, 8, 30, 18, 20, {
      useEstimates: true,
      startFromBase: true,
      maxEndTimeMinutes: 0,
    });

    const res = await computeDispatch(pending, [T], null, params);
    const resWithOthers = await computeDispatch(pending, [T], null, params, undefined, [
      stop('x', MON, '09:00', '09:20', P.milano, { technicianId: 'tech-2' }),
      stop('y', TUE, '09:00', '09:20', P.milano),
    ]);

    const monday = res.updates.filter(u => u.date === MON);
    expect(monday.map(a => [a.id, a.startTime, a.endTime, a.sequenceOrder])).toEqual(
      expected.scheduled.map(a => [a.id, a.startTime, a.endTime, a.sequenceOrder])
    );
    expect(monday.every(a => a.status === 'proposed' && a.technicianId === 'tech-1')).toBe(true);
    expect(resWithOthers.updates.filter(u => u.date === MON)).toEqual(monday);
    expect(res.patches).toEqual([]);
  });

  it('secondo lancio: si inserisce negli spazi senza toccare gli orari esistenti', async () => {
    const first = pendingBatch('f', ['sesto', 'navigli', 'segrate']);
    const r1 = await computeDispatch(first, [T], null, params);
    let state = applyProposal(first, r1.updates, r1.patches);
    // l'operatore conferma una delle tappe
    state = state.map(a => (a.id === 'f1' ? { ...a, status: 'confirmed' as const } : a));
    const before = new Map(state.filter(isInRoute).map(a => [a.id, [a.date, a.startTime, a.endTime]]));

    const second = pendingBatch('s', ['portaVenezia', 'cityLife', 'cinisello', 'assago', 'monza', 'rho', 'lodi', 'pavia']);
    second[6].urgent = true;
    const all = [...state, ...second];
    const r2 = await computeDispatch(second, [T], null, params, undefined, all);

    // le patch riguardano solo tappe esistenti e mai gli orari
    for (const p of r2.patches) {
      expect(before.has(p.id)).toBe(true);
      expect(Object.keys(p.changes).every(k => ['sequenceOrder', 'travelTimeFromPrev', 'distanceFromPrev'].includes(k))).toBe(true);
    }
    const after = applyProposal(all, r2.updates, r2.patches);
    for (const [id, v] of before) {
      const a = after.find(x => x.id === id)!;
      expect([a.date, a.startTime, a.endTime]).toEqual(v);
    }
    // qualcosa è entrato nel lunedì già avviato, e senza sovrapposizioni
    const mondayNew = r2.updates.filter(u => u.date === MON && u.id.startsWith('s'));
    expect(mondayNew.length).toBeGreaterThan(0);
    expectNoOverlap(after);
    // l'urgente entra nel primo giorno utile
    expect(after.find(a => a.id === 's6')!.date).toBe(MON);
    // ogni orario nella finestra di lavoro
    for (const a of after.filter(isInRoute)) {
      expect(toMin(a.startTime!)).toBeGreaterThanOrEqual(toMin('08:30'));
      expect(toMin(a.endTime!)).toBeLessThanOrEqual(toMin('18:00'));
    }
  });

  it('rispetta declinedDates e followUpDate anche con giro esistente', async () => {
    const existing = [stop('e1', MON, '09:30', '09:50', P.sesto, { sequenceOrder: 1 }), stop('e2', TUE, '09:30', '09:50', P.sesto, { sequenceOrder: 1 })];
    const declined = appt({ id: 'd', coords: P.cinisello, technicianId: 'tech-1', declinedDates: [MON] });
    const later = appt({ id: 'l', coords: P.cinisello, technicianId: 'tech-1', followUpDate: WED });
    const pending = [declined, later];
    const res = await computeDispatch(pending, [T], null, params, undefined, [...existing, ...pending]);
    expect(res.updates.find(u => u.id === 'd')!.date).toBe(TUE);
    expect(res.updates.find(u => u.id === 'l')!.date).toBe(WED);

    // stesso vincolo sul giorno vuoto (algoritmo classico)
    const res2 = await computeDispatch(pending, [T], null, params);
    expect(res2.updates.find(u => u.id === 'd')!.date).toBe(TUE);
    expect(res2.updates.find(u => u.id === 'l')!.date).toBe(WED);
  });

  it('ciò che non entra passa ai giorni successivi', async () => {
    // lunedì quasi pieno: resta spazio solo per poche visite
    const existing = [
      stop('e1', MON, '08:45', '09:05', P.milano),
      stop('e2', MON, '10:00', '16:30', P.milano, { durationMinutes: 390 }),
      stop('e3', MON, '17:20', '17:40', P.milano),
    ];
    const pending = pendingBatch('q', ['portaVenezia', 'navigli', 'cityLife', 'segrate']);
    const res = await computeDispatch(pending, [T], null, params, undefined, [...existing, ...pending]);
    const after = applyProposal([...existing, ...pending], res.updates, res.patches);
    expectNoOverlap(after);
    expect(res.updates.some(u => u.date === TUE)).toBe(true);
    expect(after.filter(a => a.date === MON).length).toBeLessThan(3 + pending.length);
  });
});
