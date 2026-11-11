import { describe, expect, it } from 'vitest';
import type { Appointment } from '../src/types';
import {
  alternativesForCall,
  approveForCalling,
  attentionItems,
  reduceCallLaunchResult,
  reduceCallOutcome,
  reduceCallStarted,
} from '../src/services/autopilotService';
import { calculateSchedule } from '../src/utils/geo';
import { P, appt, at, outcome, planning, stop } from './fixtures';

// Regole di prudenza del pilota automatico: cosa NON fa da solo.

const NOW = at('2026-11-11', '10:00'); // mercoledì
const D = '2026-11-13';
const ON = planning(NOW);
const byId = (all: Appointment[], id: string) => all.find(a => a.id === id)!;

describe('tappe confermate a mano', () => {
  const confirmed = () => stop('c', D, '10:00', '10:20', P.portaVenezia, { status: 'confirmed' });

  it('non entrano nella coda delle chiamate', () => {
    const all = [confirmed(), stop('p', D, '11:00', '11:20', P.sesto)];
    const out = approveForCalling(all, ['c', 'p'], NOW);
    expect(byId(out, 'c').autoCall).toBeUndefined();
    expect(byId(out, 'p').autoCall).toBe('route');
  });

  it('non escono dal giro se non rispondono, nemmeno al tetto dei tentativi', () => {
    const all = [{ ...confirmed(), callStatus: 'called' as const, callId: 'k', callAttempts: 5 }];
    const c = byId(reduceCallOutcome(all, 'c', outcome('non_risposto'), 'k', ON), 'c');
    expect(c).toMatchObject({ status: 'confirmed', date: D, startTime: '10:00', callAttempts: 6 });
    expect(c.autoCall).toBeUndefined();
  });
});

describe('cambio di referente', () => {
  const called = (over: Partial<Appointment> = {}) => [
    stop('r', D, '10:00', '10:20', P.portaVenezia, { title: 'Intestatario', callStatus: 'called', callId: 'k', ...over }),
  ];
  const nuovo = outcome('altro_referente', { newContactName: 'Sig. Bianchi', newContactPhone: '+390299999999' });

  it('il primo viene richiamato da solo', () => {
    const r = byId(reduceCallOutcome(called(), 'r', nuovo, 'k', ON), 'r');
    expect(r).toMatchObject({ phone: '+390299999999', referredBy: 'Intestatario', autoCall: 'route', date: D });
    expect(r.callOutcome).toBeUndefined();
  });

  it('il secondo no: l\'esito resta sulla pratica e va fra le cose da gestire', () => {
    const all = called({ referredBy: 'Intestatario', contactPerson: 'Sig. Bianchi', phone: '+390299999999' });
    const altro = outcome('altro_referente', { newContactName: 'Sig. Verdi', newContactPhone: '+390288888888' });
    const out = reduceCallOutcome(all, 'r', altro, 'k', ON);
    const r = byId(out, 'r');
    expect(r).toMatchObject({ phone: '+390299999999', date: D, startTime: '10:00' });
    expect(r.autoCall).toBeUndefined();
    expect(r.callOutcome?.result).toBe('altro_referente');
    const items = attentionItems(out, ON);
    expect(items.map(i => i.kind)).toEqual(['esito_da_verificare']);
    expect(items[0].detail).toContain('Sig. Verdi');
  });

  it('a pilota spento il numero si aggiorna sempre (comportamento manuale di sempre)', () => {
    const all = called({ referredBy: 'Intestatario' });
    const r = byId(reduceCallOutcome(all, 'r', nuovo, 'k', planning(NOW, { enabled: false })), 'r');
    expect(r.phone).toBe('+390299999999');
    expect(r.autoCall).toBeUndefined();
  });
});

describe('avvio di una nuova chiamata', () => {
  it('dimentica id ed esito della chiamata precedente', () => {
    const all = [
      stop('x', D, '10:00', '10:20', P.milano, {
        callStatus: 'failed',
        callId: 'vecchia',
        calledAt: at('2026-11-11', '09:00').toISOString(),
        callOutcome: outcome('non_risposto'),
        autoCall: 'retry',
      }),
    ];
    const started = byId(reduceCallStarted(all, 'x', []), 'x');
    expect(started).toMatchObject({ callStatus: 'calling' });
    expect([started.callId, started.calledAt, started.callOutcome, started.autoCall]).toEqual([undefined, undefined, undefined, undefined]);
    // l'esito della chiamata vecchia, arrivato in ritardo, non si applica a quella nuova
    const launched = reduceCallLaunchResult(reduceCallStarted(all, 'x', []), 'x', { ok: true, callId: 'nuova' }, NOW);
    expect(reduceCallOutcome(launched, 'x', outcome('rifiutato'), 'vecchia', ON)).toBe(launched);
  });
});

describe('irreperibili e pratiche senza telefono', () => {
  it('un solo tentativo: "1 tentativo"', () => {
    // slot domani alle 9:00, chiamata la sera prima: non c'è più tempo per riprovare
    const now = at('2026-11-12', '19:00');
    const all = [stop('x', D, '09:00', '09:20', P.milano, { callStatus: 'called', callId: 'k' })];
    const x = byId(reduceCallOutcome(all, 'x', outcome('non_risposto'), 'k', planning(now)), 'x');
    expect(x).toMatchObject({ status: 'issue', issueType: 'callback' });
    expect(x.notes).toContain('Non raggiungibile dopo 1 tentativo');
    expect(x.notes).not.toContain('tentativi');
  });

  it('una pratica in attesa senza telefono è fra le cose da gestire', () => {
    const all = [
      appt({ id: 'senza', technicianId: 'tech-1' }),
      appt({ id: 'con', technicianId: 'tech-1', phone: '+390211111111' }),
    ];
    expect(attentionItems(all, ON).map(i => [i.id, i.kind])).toEqual([['senza', 'senza_telefono']]);
  });
});

describe('orari tondi nelle proposte', () => {
  it('calculateSchedule arrotonda per eccesso gli inizi e mette la pausa dalle 12:00', async () => {
    const stops = [
      appt({ id: 'a', coords: P.sesto }),
      appt({ id: 'b', coords: P.monza }),
      appt({ id: 'c', coords: P.bergamo, durationMinutes: 150 }),
      appt({ id: 'd', coords: P.lodi }),
    ];
    const exact = await calculateSchedule(stops, P.milano, 8, 30, 18, 20, { useEstimates: true, startFromBase: true, roundToMinutes: 1 });
    // (5 minuti è il default: vale per smistamento, riordino e ottimizzazione)
    const round = await calculateSchedule(stops, P.milano, 8, 30, 18, 20, { useEstimates: true, startFromBase: true });
    const min = (t?: string) => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
    expect(round.scheduled.length).toBe(exact.scheduled.length);
    for (let i = 0; i < round.scheduled.length; i++) {
      const r = round.scheduled[i], e = exact.scheduled[i];
      expect(min(r.startTime) % 5).toBe(0);
      expect(min(r.startTime)).toBeGreaterThanOrEqual(min(e.startTime)); // mai prima dell'arrivo reale
      if (i > 0) {
        const prev = round.scheduled[i - 1];
        const gap = min(r.startTime) - min(prev.endTime);
        expect(gap).toBeGreaterThanOrEqual((r.travelTimeFromPrev || 0) + (r.hasLunchBreakBefore ? 45 : 0));
      }
    }
    // una sola pausa pranzo, alla prima tappa che inizia dalle 12:00 in poi
    const lunch = round.scheduled.filter(a => a.hasLunchBreakBefore);
    expect(lunch.length).toBe(1);
    expect(min(lunch[0].startTime)).toBeGreaterThanOrEqual(12 * 60 + 45);
  });
});

describe('cambi per il giorno stesso', () => {
  // Oggi (mercoledì 11/11) alle 9:00: un giro per oggi pomeriggio e uno per venerdì
  const today = '2026-11-11';
  const now = at(today, '09:00');
  const world = (): Appointment[] => [
    stop('oggi1', today, '15:00', '15:20', P.milano),
    stop('x', today, '16:00', '16:20', P.portaVenezia, { title: 'Cliente X', callStatus: 'called', callId: 'k' }),
    stop('ven1', D, '10:00', '10:20', P.sesto),
    appt({ id: 'attesa', coords: P.portaVenezia, technicianId: 'tech-1', phone: '+390211111111' }),
  ];

  it('di default niente alternative né rimpiazzi per oggi', () => {
    const ctx = planning(now);
    const all = world();
    const alts = alternativesForCall(byId(all, 'ven1'), all, ctx);
    expect(alts.length).toBeGreaterThan(0);
    expect(alts.some(a => a.date === today)).toBe(false);
    // lo slot di oggi alle 16:00 si libera: nessuno viene aggiunto al giro di oggi
    const out = reduceCallOutcome(all, 'x', outcome('rifiutato'), 'k', ctx);
    expect(byId(out, 'x').status).toBe('standby');
    expect(byId(out, 'attesa')).toMatchObject({ status: 'pending' });
    expect(byId(out, 'attesa').date).toBeUndefined();
  });

  it('con l\'opzione accesa sono ammessi, rispettando l\'anticipo minimo', () => {
    const ctx = planning(now, { sameDayChanges: true });
    const all = world();
    expect(alternativesForCall(byId(all, 'ven1'), all, ctx).some(a => a.date === today)).toBe(true);
    const out = reduceCallOutcome(all, 'x', outcome('rifiutato'), 'k', ctx);
    expect(byId(out, 'attesa')).toMatchObject({ status: 'proposed', date: today, autoCall: 'backfill' });
    // a meno di 3 ore dallo slot nemmeno con l'opzione accesa
    const late = planning(at(today, '14:00'), { sameDayChanges: true });
    const out2 = reduceCallOutcome(all, 'x', outcome('rifiutato'), 'k', late);
    expect(byId(out2, 'attesa').status).toBe('pending');
  });
});
