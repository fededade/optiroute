import { describe, expect, it } from 'vitest';
import { computeAlternativeSlots, resolveAlternative } from '../src/services/alternativesService';
import { dateAtMinutes, toMin } from '../src/services/slotService';
import { FALLBACK, P, at, stop, tech } from './fixtures';

// Mercoledì 11/11/2026 ore 10:00
const NOW = at('2026-11-11', '10:00');
const T = tech();

const world = () => {
  const target = stop('x', '2026-11-12', '09:30', '09:50', P.portaVenezia);
  return [
    target,
    stop('g1', '2026-11-12', '11:30', '11:50', P.sesto),
    stop('g2', '2026-11-13', '09:00', '09:20', P.portaVenezia),
    stop('g3', '2026-11-16', '09:00', '09:20', P.navigli),
    stop('g4', '2026-11-17', '09:00', '09:20', P.cityLife),
    stop('g5', '2026-11-18', '10:00', '10:20', P.segrate),
  ];
};

describe('computeAlternativeSlots', () => {
  it('al massimo 3, date distinte, etichette A/B/C in ordine cronologico, niente weekend', () => {
    const all = world();
    const alts = computeAlternativeSlots(all[0], all, [T], { now: NOW, fallback: FALLBACK });
    expect(alts).toHaveLength(3);
    expect(alts.map(a => a.label)).toEqual(['A', 'B', 'C']);
    const dates = alts.map(a => a.date);
    expect(new Set(dates).size).toBe(3);
    expect([...dates].sort()).toEqual(dates);
    for (const a of alts) {
      const day = new Date(`${a.date}T00:00:00`).getDay();
      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
      expect(toMin(a.endTime) - toMin(a.startTime)).toBe(20);
    }
  });

  it('salta indisponibilità e date rifiutate, rispetta followUpDate', () => {
    const all = world();
    const target = { ...all[0], declinedDates: ['2026-11-16'], followUpDate: '2026-11-12' };
    const t = tech({ unavailability: [{ id: 'u', from: '2026-11-13', allDay: true }] });
    const alts = computeAlternativeSlots(target, all, [t], { now: NOW, fallback: FALLBACK, horizonDays: 7 });
    const dates = alts.map(a => a.date);
    expect(dates).not.toContain('2026-11-13');
    expect(dates).not.toContain('2026-11-16');
    expect(dates).not.toContain('2026-11-11');
    expect(dates.every(d => d >= '2026-11-12')).toBe(true);
    expect(dates.length).toBeGreaterThan(0);
  });

  it('con includeWeekends il sabato è ammesso', () => {
    const all = world();
    const alts = computeAlternativeSlots(all[0], [all[0]], [T], {
      now: at('2026-11-13', '18:00'),
      fallback: FALLBACK,
      horizonDays: 1,
      includeWeekends: true,
    });
    expect(alts.map(a => a.date)).toEqual(['2026-11-14']);
  });

  it('anticipo minimo rispetto ad adesso', () => {
    const all = world();
    const alts = computeAlternativeSlots(all[0], all, [T], { now: NOW, fallback: FALLBACK, horizonDays: 0 });
    expect(alts).toHaveLength(1);
    expect(alts[0].date).toBe('2026-11-11');
    expect(dateAtMinutes(alts[0].date, toMin(alts[0].startTime)).getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 180 * 60000);

    const noLeadRoom = computeAlternativeSlots(all[0], all, [T], {
      now: at('2026-11-11', '16:00'),
      fallback: FALLBACK,
      horizonDays: 0,
    });
    expect(noLeadRoom).toEqual([]);
  });

  it('sul giorno già proposto solo slot ad almeno 2 ore dall\'orario attuale', () => {
    const all = world();
    const alts = computeAlternativeSlots(all[0], all, [T], {
      now: at('2026-11-11', '18:00'),
      fallback: FALLBACK,
      horizonDays: 1,
    });
    expect(alts.map(a => a.date)).toEqual(['2026-11-12']);
    expect(Math.abs(toMin(alts[0].startTime) - toMin('09:30'))).toBeGreaterThanOrEqual(120);
  });

  it('preferisce i giorni in cui il tecnico è già in zona', () => {
    const all = world();
    const alts = computeAlternativeSlots(all[0], all, [T], { now: NOW, fallback: FALLBACK, max: 1 });
    // venerdì 13 il tecnico ha già una tappa nello stesso punto
    expect(alts.map(a => a.date)).toEqual(['2026-11-13']);
  });
});

describe('resolveAlternative', () => {
  it('rivalida lo slot offerto e restituisce null se nel frattempo è occupato', () => {
    const all = world();
    const alts = computeAlternativeSlots(all[0], all, [T], { now: NOW, fallback: FALLBACK });
    const target = { ...all[0], offeredAlternatives: alts };
    const list = [target, ...all.slice(1)];

    const ok = resolveAlternative(target, 'A', list, [T], FALLBACK, NOW);
    expect(ok).not.toBeNull();
    expect(ok!.date).toBe(alts[0].date);
    expect(ok!.option.start).toBe(toMin(alts[0].startTime));

    // un'altra pratica occupa proprio quello slot
    const busy = [
      ...list,
      stop('intrusa', alts[0].date, alts[0].startTime, alts[0].endTime, P.portaVenezia),
    ];
    expect(resolveAlternative(target, 'A', busy, [T], FALLBACK, NOW)).toBeNull();
    expect(resolveAlternative(target, 'C' as const, list, [T], FALLBACK, NOW)?.date).toBe(alts[2].date);
    expect(resolveAlternative({ ...target, offeredAlternatives: undefined }, 'A', list, [T], FALLBACK, NOW)).toBeNull();
  });
});
