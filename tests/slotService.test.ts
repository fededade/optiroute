import { describe, expect, it } from 'vitest';
import {
  addDaysStr,
  applyPatches,
  dayContextFor,
  durationOf,
  findFeasibleSlots,
  getDayRoute,
  isInRoute,
  localDateStr,
  placeAppointment,
  removeFromRoute,
  resequenceDay,
  toHHMM,
  toMin,
  travelMinutes,
  type DayContext,
} from '../src/services/slotService';
import { calculateDistance } from '../src/utils/geo';
import { FALLBACK, P, appt, snapshot, stop, tech } from './fixtures';

const D = '2026-11-13';
const ctx: DayContext = { windowStart: toMin('08:30'), windowEnd: toMin('18:00'), base: P.milano };
const ceil5 = (n: number) => Math.ceil(n / 5) * 5;

describe('utilità', () => {
  it('orari e date locali', () => {
    expect(toMin('08:30')).toBe(510);
    expect(toHHMM(510)).toBe('08:30');
    expect(toHHMM(725)).toBe('12:05');
    expect(localDateStr(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(addDaysStr('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysStr('2026-03-28', 2)).toBe('2026-03-30'); // cambio ora legale
    expect(durationOf({})).toBe(20);
    expect(durationOf({ durationMinutes: 45 })).toBe(45);
  });

  it('isInRoute e getDayRoute', () => {
    const all = [
      stop('b', D, '11:00', '11:20', P.milano),
      stop('a', D, '09:00', '09:20', P.milano),
      stop('altro-tecnico', D, '10:00', '10:20', P.milano, { technicianId: 'tech-2' }),
      stop('altro-giorno', '2026-11-12', '10:00', '10:20', P.milano),
      appt({ id: 'p', status: 'pending', technicianId: 'tech-1' }),
      stop('senza-fine', D, '15:00', '', P.milano, { endTime: undefined, durationMinutes: 30 }),
    ];
    expect(isInRoute(all[4])).toBe(false);
    const route = getDayRoute(all, 'tech-1', D);
    expect(route.map(s => s.id)).toEqual(['a', 'b', 'senza-fine']);
    expect(route[2].end).toBe(toMin('15:30'));
    expect(getDayRoute(all, 'tech-1', D, 'a').map(s => s.id)).toEqual(['b', 'senza-fine']);
  });

  it('dayContextFor: finestra del tecnico, base di ripiego, giorno non lavorativo', () => {
    const t = tech({ baseCoords: undefined, workStart: '09:00', workEnd: '17:00' });
    expect(dayContextFor(t, D, FALLBACK)).toEqual({ windowStart: 540, windowEnd: 1020, base: P.milano });
    expect(dayContextFor(undefined, D, { start: '08:00', end: '16:00', base: null })).toEqual({
      windowStart: 480,
      windowEnd: 960,
      base: null,
    });
    const off = tech({ unavailability: [{ id: 'u', from: D, allDay: true }] });
    expect(dayContextFor(off, D, FALLBACK)).toBeNull();
  });
});

describe('findFeasibleSlots', () => {
  it('inserisce fra due tappe fisse', () => {
    const route = getDayRoute(
      [stop('a', D, '09:00', '09:20', P.milano), stop('b', D, '11:00', '11:20', P.milano)],
      'tech-1',
      D
    );
    const t = travelMinutes(P.milano, P.assago);
    const between = findFeasibleSlots(route, ctx, P.assago, 20).find(o => o.position === 1);
    expect(between).toBeDefined();
    expect(between!.start).toBe(ceil5(toMin('09:20') + t));
    expect(between!.end).toBe(between!.start + 20);
    expect(between!.end + t).toBeLessThanOrEqual(toMin('11:00'));
    expect(between!.lunchBefore).toBe(false);
    expect(between!.detourKm).toBeGreaterThan(0);
  });

  it('non fattibile se il viaggio verso la tappa successiva non ci sta', () => {
    const route = getDayRoute(
      [stop('a', D, '09:00', '09:20', P.milano), stop('b', D, '10:30', '10:50', P.milano)],
      'tech-1',
      D
    );
    const options = findFeasibleSlots(route, ctx, P.assago, 20);
    expect(options.find(o => o.position === 1)).toBeUndefined();
    // resta possibile solo dopo l'ultima tappa
    expect(options.every(o => o.position === 2)).toBe(true);
  });

  it('preserva la pausa pranzo già nel varco', () => {
    const route = getDayRoute(
      [
        stop('a', D, '11:00', '11:20', P.milano),
        stop('b', D, '13:00', '13:20', P.milano, { hasLunchBreakBefore: true }),
      ],
      'tech-1',
      D
    );
    const t = travelMinutes(P.milano, P.portaVenezia);
    const ok = findFeasibleSlots(route, ctx, P.portaVenezia, 20).find(o => o.position === 1);
    expect(ok).toBeDefined();
    expect(ok!.lunchBefore).toBe(false);
    expect(ok!.end + t + 45).toBeLessThanOrEqual(toMin('13:00'));
    // con 30 minuti di visita la pausa non ci starebbe più
    const tooLong = findFeasibleSlots(route, ctx, P.portaVenezia, 30).find(o => o.position === 1);
    expect(tooLong).toBeUndefined();
  });

  it('aggiunge la pausa pranzo se si accoda dopo le 12:00', () => {
    const route = getDayRoute([stop('a', D, '11:30', '11:50', P.milano)], 'tech-1', D);
    const t = travelMinutes(P.milano, P.portaVenezia);
    const last = findFeasibleSlots(route, ctx, P.portaVenezia, 20).find(o => o.position === 1)!;
    const minStart = ceil5(toMin('11:50') + t);
    expect(minStart).toBeGreaterThanOrEqual(720);
    expect(last.lunchBefore).toBe(true);
    expect(last.start).toBe(minStart + 45);
  });

  // Prima: "nessuna pausa aggiuntiva se il giro ha già tappe dal pomeriggio".
  // Era sbagliato: un giro con tappe pomeridiane ma SENZA pausa segnata (tappe
  // messe a mano, o la tappa con la pausa uscita dal giro) veniva riempito fino
  // a togliere al tecnico il pranzo. Ora la pausa si aggiunge alla nuova tappa
  // dalle 12:00, e una tappa del mattino lascia i 45' prima della pomeridiana.
  it('giro con tappe pomeridiane ma senza pausa: il varco del pranzo non si riempie', () => {
    const route = getDayRoute(
      [stop('a', D, '11:30', '11:50', P.milano), stop('b', D, '14:00', '14:20', P.milano)],
      'tech-1',
      D
    );
    const options = findFeasibleSlots(route, ctx, P.portaVenezia, 20);
    const between = options.find(o => o.position === 1)!;
    expect(between.start).toBeGreaterThanOrEqual(toMin('12:45'));
    expect(between.lunchBefore).toBe(true);
    for (const o of options) if (o.start >= 720) expect(o.lunchBefore).toBe(true);
  });

  it('rispetta la fine della finestra', () => {
    const shortCtx = { ...ctx, windowEnd: toMin('12:00') };
    const route = getDayRoute([stop('a', D, '11:00', '11:20', P.milano)], 'tech-1', D);
    const t = travelMinutes(P.milano, P.portaVenezia);
    const startAfter = ceil5(toMin('11:20') + t);
    const fits = findFeasibleSlots(route, shortCtx, P.portaVenezia, 20).find(o => o.position === 1);
    expect(fits?.end).toBe(startAfter + 20);
    expect(startAfter + 20).toBeLessThanOrEqual(720);
    const dur = 720 - startAfter + 5; // sfora di 5 minuti
    expect(findFeasibleSlots(route, shortCtx, P.portaVenezia, dur).find(o => o.position === 1)).toBeUndefined();
  });

  it('arrotonda per eccesso ai 5 minuti', () => {
    const route = getDayRoute([stop('a', D, '09:00', '09:21', P.milano)], 'tech-1', D);
    const options = findFeasibleSlots(route, ctx, P.navigli, 20);
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o.start % 5).toBe(0);
    const after = options.find(o => o.position === 1)!;
    const raw = toMin('09:21') + travelMinutes(P.milano, P.navigli);
    expect(after.start).toBe(ceil5(raw));
    expect(after.start).toBeGreaterThanOrEqual(raw);
  });

  it('parte dalla base: inizio = apertura + viaggio dalla base', () => {
    const options = findFeasibleSlots([], ctx, P.assago, 20);
    expect(options).toHaveLength(1);
    expect(options[0].start).toBe(ceil5(510 + travelMinutes(P.milano, P.assago)));
    expect(options[0].position).toBe(0);
    // senza base si parte all'apertura
    const noBase = findFeasibleSlots([], { ...ctx, base: null }, P.assago, 20);
    expect(noBase[0].start).toBe(510);
    expect(noBase[0].detourKm).toBe(0);
  });

  it('notBefore / notAfter', () => {
    const options = findFeasibleSlots([], ctx, P.portaVenezia, 20, { notBefore: 603, notAfter: 700 });
    expect(options[0].start).toBe(605);
    expect(findFeasibleSlots([], ctx, P.portaVenezia, 20, { notBefore: 603, notAfter: 600 })).toEqual([]);
  });
});

describe('modifiche al giro', () => {
  const day = () => [
    stop('a', D, '09:00', '09:20', P.milano, { sequenceOrder: 1 }),
    stop('b', D, '11:00', '11:20', P.sesto, { sequenceOrder: 2 }),
    appt({ id: 'n', technicianId: 'tech-1', coords: P.portaVenezia }),
  ];

  it('applyPatches unisce le modifiche e non muta', () => {
    const all = day();
    const snap = snapshot(all);
    const out = applyPatches(all, [
      { id: 'a', changes: { sequenceOrder: 5 } },
      { id: 'a', changes: { notes: 'x' } },
    ]);
    expect(out[0]).toMatchObject({ sequenceOrder: 5, notes: 'x' });
    expect(out[1]).toBe(all[1]);
    expect(all).toEqual(snap.json);
  });

  it('placeAppointment inserisce, risequenzia e non tocca gli orari esistenti', () => {
    const all = day();
    const snap = snapshot(all);
    const route = getDayRoute(all, 'tech-1', D);
    const option = findFeasibleSlots(route, ctx, P.portaVenezia, 20).find(o => o.position === 1)!;
    const out = placeAppointment(all, 'n', { date: D, option, ctx }, { notes: 'inserita' });
    const n = out.find(a => a.id === 'n')!;
    expect(n).toMatchObject({ status: 'proposed', date: D, startTime: toHHMM(option.start), sequenceOrder: 2, notes: 'inserita' });
    const b = out.find(a => a.id === 'b')!;
    expect(b.sequenceOrder).toBe(3);
    expect(b.startTime).toBe('11:00');
    expect(b.distanceFromPrev).toBe(parseFloat(calculateDistance(P.portaVenezia, P.sesto).toFixed(2)));
    expect(b.travelTimeFromPrev).toBe(travelMinutes(P.portaVenezia, P.sesto));
    expect(out.find(a => a.id === 'a')!.travelTimeFromPrev).toBe(travelMinutes(P.milano, P.milano));
    expect(all).toEqual(snap.json);
  });

  it('removeFromRoute azzera la pianificazione e risequenzia il giorno lasciato', () => {
    const all = resequenceDay(day(), 'tech-1', D, ctx);
    const out = removeFromRoute(all, 'a', { status: 'standby' });
    const a = out.find(x => x.id === 'a')!;
    expect(a).toMatchObject({ status: 'standby', date: undefined, startTime: undefined, sequenceOrder: undefined });
    const b = out.find(x => x.id === 'b')!;
    expect(b.sequenceOrder).toBe(1);
    expect(b.startTime).toBe('11:00');
  });
});
