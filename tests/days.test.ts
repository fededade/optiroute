import { describe, expect, it } from 'vitest';
import {
  DAY_PALETTE, activeDays, agendaFilter, dayColor, dayCounts, dayNumber, isDayActive, mapDayFilter,
  monthGrid, rangeDays, routeDaysOf, selectSingleDay, toggleDay, type DaySelection,
} from '../src/layout/days';
import { addDays } from '../src/layout/format';
import { appt } from './fixtures';

// Calendario dei giorni e colore per giorno (solo visualizzazione)

const confirmed = (date: string, over = {}) => appt({ status: 'confirmed', date, startTime: '09:00', endTime: '09:20', technicianId: 'tech-1', ...over });
const proposed = (date: string, over = {}) => appt({ status: 'proposed', date, startTime: '10:00', endTime: '10:20', technicianId: 'tech-1', ...over });

describe('dayColor: un colore per ogni giorno', () => {
  it('tavolozza di almeno 10 colori diversi, in esadecimale', () => {
    expect(DAY_PALETTE.length).toBeGreaterThanOrEqual(10);
    expect(new Set(DAY_PALETTE).size).toBe(DAY_PALETTE.length);
    for (const c of DAY_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('stabile: lo stesso giorno ha sempre lo stesso colore', () => {
    expect(dayColor('2026-11-13')).toBe(dayColor('2026-11-13'));
    expect(DAY_PALETTE).toContain(dayColor('2026-11-13'));
  });

  it('usa il numero progressivo del giorno modulo la tavolozza', () => {
    const n = dayNumber('2026-11-13');
    expect(n).toBe(Math.floor(Date.UTC(2026, 10, 13) / 86400000));
    expect(dayColor('2026-11-13')).toBe(DAY_PALETTE[n % DAY_PALETTE.length]);
    expect(dayColor(addDays('2026-11-13', DAY_PALETTE.length))).toBe(dayColor('2026-11-13'));
  });

  it('giorni consecutivi (anche a cavallo di mese, anno e ora legale) hanno colori diversi', () => {
    let d = '2026-01-01';
    for (let i = 0; i < 800; i++) {
      const next = addDays(d, 1);
      expect(dayColor(next)).not.toBe(dayColor(d));
      // e la cella sotto nel calendario (stesso giorno della settimana dopo)
      expect(dayColor(addDays(d, 7))).not.toBe(dayColor(d));
      d = next;
    }
  });

  it('in una settimana tutti i colori sono diversi', () => {
    const week = Array.from({ length: 7 }, (_, i) => dayColor(addDays('2026-11-09', i)));
    expect(new Set(week).size).toBe(7);
  });

  it('senza data o con una data storta: grigio neutro', () => {
    expect(dayColor()).toBe('#646A7B');
    expect(dayColor('domani')).toBe('#646A7B');
  });
});

describe('conteggi per giorno del calendario', () => {
  const all = [
    confirmed('2026-11-12'), confirmed('2026-11-12'), confirmed('2026-11-12', { technicianId: 'tech-2' }),
    proposed('2026-11-12'), proposed('2026-11-13'), proposed('2026-11-13', { technicianId: 'tech-2' }),
    proposed('2026-11-14', { startTime: undefined }),                      // senza ora: non è nel giro
    appt({ status: 'pending', date: '2026-11-12' }),                        // in attesa: non conta
    appt({ status: 'issue', date: '2026-11-12', startTime: '09:00' }),
  ];

  it('confermate e proposte nel giro, per giorno', () => {
    const c = dayCounts(all);
    expect(c.get('2026-11-12')).toEqual({ confirmed: 3, proposed: 1 });
    expect(c.get('2026-11-13')).toEqual({ confirmed: 0, proposed: 2 });
    expect(c.has('2026-11-14')).toBe(false);
    expect(c.has('2026-11-15')).toBe(false);
  });

  it('rispetta il filtro del tecnico', () => {
    const c = dayCounts(all, a => a.technicianId === 'tech-2');
    expect(c.get('2026-11-12')).toEqual({ confirmed: 1, proposed: 0 });
    expect(c.get('2026-11-13')).toEqual({ confirmed: 0, proposed: 1 });
  });
});

describe('selezione dei giorni attivi', () => {
  const day = (d: string): DaySelection => selectSingleDay(d);

  it('un clic: un solo giorno attivo', () => {
    const s = day('2026-11-12');
    expect(activeDays(s)).toEqual(['2026-11-12']);
    expect(isDayActive(s, '2026-11-12')).toBe(true);
    expect(isDayActive(s, '2026-11-13')).toBe(false);
  });

  it('più giorni: ogni clic aggiunge o toglie un giorno, l\'ultimo non si toglie', () => {
    let s = toggleDay(day('2026-11-12'), '2026-11-14');
    s = toggleDay(s, '2026-11-10');
    expect(activeDays(s)).toEqual(['2026-11-10', '2026-11-12', '2026-11-14']);
    expect(s.currentDate).toBe('2026-11-12');   // la data dell'agenda resta quella
    s = toggleDay(s, '2026-11-12');
    expect(activeDays(s)).toEqual(['2026-11-10', '2026-11-14']);
    expect(s.currentDate).toBe('2026-11-10');
    s = toggleDay(toggleDay(s, '2026-11-14'), '2026-11-10');
    expect(activeDays(s)).toEqual(['2026-11-10']);
  });

  it('settimana e mese valgono come tutti i giorni dell\'intervallo', () => {
    const w: DaySelection = { currentDate: '2026-11-12', viewMode: 'week', extraDays: [] };
    expect(activeDays(w)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    expect(isDayActive(w, '2026-11-15')).toBe(true);
    expect(isDayActive(w, '2026-11-16')).toBe(false);
    const m: DaySelection = { currentDate: '2026-02-10', viewMode: 'month', extraDays: [] };
    expect(rangeDays('2026-02-10', 'month')).toHaveLength(28);
    expect(isDayActive(m, '2026-02-28')).toBe(true);
    expect(isDayActive(m, '2026-03-01')).toBe(false);
  });

  it('con "Più giorni" dalla settimana si parte dai suoi 7 giorni', () => {
    const w: DaySelection = { currentDate: '2026-11-12', viewMode: 'week', extraDays: [] };
    const s = toggleDay(w, '2026-11-15');
    expect(s.viewMode).toBe('day');
    expect(activeDays(s)).toHaveLength(6);
    expect(isDayActive(s, '2026-11-15')).toBe(false);
  });

  it('azzera: un giorno solo', () => {
    const s = selectSingleDay('2026-11-11');
    expect(s).toEqual({ currentDate: '2026-11-11', viewMode: 'day', extraDays: [] });
  });

  it('griglia del mese: 42 giorni da lunedì', () => {
    const g = monthGrid(2026, 10); // novembre 2026: il 1° è domenica
    expect(g).toHaveLength(42);
    expect(g[0]).toBe('2026-10-26');
    expect(g[6]).toBe('2026-11-01');
    expect(new Date(`${g[0]}T00:00:00`).getDay()).toBe(1);
  });
});

describe('filtri di Agenda e mappa sui giorni attivi', () => {
  const list = [
    confirmed('2026-11-12', { id: 'c12' }), confirmed('2026-11-13', { id: 'c13' }), confirmed('2026-11-14', { id: 'c14' }),
    proposed('2026-11-12', { id: 'p12' }), proposed('2026-11-14', { id: 'p14' }),
    proposed('2026-11-14', { id: 'pNoTime', startTime: undefined }),
    appt({ id: 'pend', status: 'pending' }), appt({ id: 'iss', status: 'issue' }),
  ];
  const two = toggleDay(selectSingleDay('2026-11-12'), '2026-11-14');

  it('Agenda: le confermate dei soli giorni attivi', () => {
    expect(list.filter(agendaFilter(selectSingleDay('2026-11-13'))).map(a => a.id)).toEqual(['c13']);
    expect(list.filter(agendaFilter(two)).map(a => a.id)).toEqual(['c12', 'c14']);
  });

  it('mappa: giri dei giorni attivi; proposte senza ora e altri stati come prima', () => {
    expect(list.filter(mapDayFilter(two)).map(a => a.id)).toEqual(['c12', 'c14', 'p12', 'p14', 'pNoTime', 'pend', 'iss']);
    expect(list.filter(mapDayFilter(selectSingleDay('2026-11-13'))).map(a => a.id)).toEqual(['c13', 'pNoTime', 'pend', 'iss']);
  });

  it('mappa in Proposte: tutte le proposte, come l\'elenco', () => {
    expect(list.filter(mapDayFilter(selectSingleDay('2026-11-13'), true)).map(a => a.id)).toEqual(['c13', 'p12', 'p14', 'pNoTime', 'pend', 'iss']);
  });

  it('legenda: giorni e numero di sopralluoghi nel giro', () => {
    expect(routeDaysOf(list.filter(mapDayFilter(two)))).toEqual([['2026-11-12', 2], ['2026-11-14', 2]]);
  });
});
