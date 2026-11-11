import { describe, expect, it } from 'vitest';
import type { Appointment } from '../src/types';
import { computeAlternativeSlots } from '../src/services/alternativesService';
import {
  alternativesForCall,
  approveForCalling,
  attentionItems,
  autopilotStats,
  cancelAutoCalls,
  expireStaleAutoCalls,
  isWithinCallWindow,
  nextCallWindowStart,
  nextDueCall,
  reduceCallLaunchResult,
  reduceCallOutcome,
  reduceCallStarted,
  reservedOfferStops,
  DEFAULT_AUTOPILOT_SETTINGS,
} from '../src/services/autopilotService';
import { getDayRoute, isInRoute, toMin, travelMinutes } from '../src/services/slotService';
import { FALLBACK, P, appt, at, outcome, planning, snapshot, stop, tech } from './fixtures';

const NOW = at('2026-11-11', '10:00'); // mercoledì
const D = '2026-11-13';                // venerdì
const MON = '2026-11-16';

// Giro di venerdì con la pratica "x" chiamata (in attesa di esito)
const world = (xOver: Partial<Appointment> = {}): Appointment[] => [
  stop('s1', D, '09:00', '09:20', P.milano, { sequenceOrder: 1 }),
  stop('x', D, '10:00', '10:20', P.portaVenezia, {
    title: 'Cliente X',
    sequenceOrder: 2,
    callStatus: 'called',
    callId: 'c1',
    ...xOver,
  }),
  stop('s3', D, '11:30', '11:50', P.sesto, { sequenceOrder: 3 }),
  appt({ id: 'near', coords: P.portaVenezia, technicianId: 'tech-1', phone: '+390211111111' }),
  appt({ id: 'far', coords: P.lodi, technicianId: 'tech-1', phone: '+390222222222' }),
];

const byId = (all: Appointment[], id: string) => all.find(a => a.id === id)!;
const OFF = planning(NOW, { enabled: false });
const ON = planning(NOW);

const expectFixedTimes = (before: Appointment[], after: Appointment[], ids: string[]) => {
  for (const id of ids) {
    const a = byId(before, id), b = byId(after, id);
    expect([b.date, b.startTime, b.endTime]).toEqual([a.date, a.startTime, a.endTime]);
  }
};

describe('reduceCallOutcome: mappatura esiti (pilota spento)', () => {
  it('guardie: esito già presente o callId diverso', () => {
    const all = world({ callOutcome: outcome('confermato') });
    expect(reduceCallOutcome(all, 'x', outcome('rifiutato'), 'c1', OFF)).toBe(all);
    const all2 = world();
    expect(reduceCallOutcome(all2, 'x', outcome('rifiutato'), 'altro', OFF)).toBe(all2);
    expect(reduceCallOutcome(all2, 'nessuna', outcome('rifiutato'), undefined, OFF)).toBe(all2);
  });

  it('confermato', () => {
    const x = byId(reduceCallOutcome(world({ callAttempts: 2 }), 'x', outcome('confermato', { summary: 'ok' }), 'c1', OFF), 'x');
    expect(x).toMatchObject({ status: 'confirmed', callAttempts: 0, callStatus: 'called', callSummary: 'ok', startTime: '10:00' });
  });

  it('riprogrammare', () => {
    const out = reduceCallOutcome(
      world(),
      'x',
      outcome('riprogrammare', { requestedDate: 'martedì', requestedTime: 'pomeriggio', followUpDate: '2026-11-17' }),
      'c1',
      OFF
    );
    const x = byId(out, 'x');
    expect(x).toMatchObject({ status: 'pending', date: undefined, startTime: undefined, followUpDate: '2026-11-17', declinedDates: [D] });
    expect(x.notes).toContain('Da riprogrammare — richiesta cliente: martedì pomeriggio');
    expect(byId(out, 's3').sequenceOrder).toBe(2);
    expect(byId(out, 'near').status).toBe('pending'); // pilota spento: nessun rimpiazzo
    const y = byId(reduceCallOutcome(world(), 'x', outcome('riprogrammare'), 'c1', OFF), 'x');
    expect(y.notes).toContain('(nessuna preferenza indicata)');
  });

  it('da_richiamare, numero_errato, lavori_non_ultimati, annullato', () => {
    const cb = byId(reduceCallOutcome(world(), 'x', outcome('da_richiamare', { followUpDate: '2026-12-01' }), 'c1', OFF), 'x');
    expect(cb).toMatchObject({ status: 'issue', issueType: 'callback', followUpDate: '2026-12-01', date: undefined });
    const wp = byId(reduceCallOutcome(world(), 'x', outcome('numero_errato'), 'c1', OFF), 'x');
    expect(wp).toMatchObject({ status: 'issue', issueType: 'wrong_phone', date: undefined });
    const lw = byId(reduceCallOutcome(world(), 'x', outcome('lavori_non_ultimati', { followUpDate: '2027-01-10' }), 'c1', OFF), 'x');
    expect(lw).toMatchObject({ status: 'issue', issueType: 'works_pending', followUpDate: '2027-01-10' });
    const an = byId(reduceCallOutcome(world({ issueType: 'callback' }), 'x', outcome('annullato'), 'c1', OFF), 'x');
    expect(an).toMatchObject({ status: 'cancelled', issueType: undefined, date: undefined });
  });

  it('rifiutato: stand-by e data rifiutata', () => {
    const x = byId(reduceCallOutcome(world(), 'x', outcome('rifiutato'), 'c1', OFF), 'x');
    expect(x).toMatchObject({ status: 'standby', declinedDates: [D], date: undefined });
    expect(x.notes).toContain('Rifiutato dal cliente');
  });

  it('altro_referente con e senza numero', () => {
    const o = outcome('altro_referente', { newContactName: 'Referente', newContactRole: 'amministratore', newContactPhone: '+390233333333' });
    const off = byId(reduceCallOutcome(world({ callAttempts: 1 }), 'x', o, 'c1', OFF), 'x');
    expect(off).toMatchObject({
      phone: '+390233333333',
      contactPerson: 'Referente — amministratore',
      referredBy: 'Cliente X',
      callStatus: undefined,
      callId: undefined,
      callOutcome: undefined,
      callAttempts: 0,
      startTime: '10:00',
    });
    expect(off.autoCall).toBeUndefined();
    const on = byId(reduceCallOutcome(world(), 'x', o, 'c1', ON), 'x');
    expect(on.autoCall).toBe('route');
    const noPhone = byId(reduceCallOutcome(world(), 'x', outcome('altro_referente', { newContactName: 'Tizio' }), 'c1', ON), 'x');
    expect(noPhone.callOutcome?.result).toBe('altro_referente');
    expect(noPhone.phone).toBe('+390200000000');
    expect(noPhone.status).toBe('proposed');
  });

  it('sconosciuto e non_risposto (pilota spento): solo esito / tentativi', () => {
    const sc = byId(reduceCallOutcome(world(), 'x', outcome('sconosciuto'), 'c1', OFF), 'x');
    expect(sc).toMatchObject({ status: 'proposed', startTime: '10:00', callOutcome: { result: 'sconosciuto' } });
    const nr = byId(reduceCallOutcome(world({ callAttempts: 5 }), 'x', outcome('non_risposto'), 'c1', OFF), 'x');
    expect(nr).toMatchObject({ status: 'proposed', callStatus: 'failed', callAttempts: 6, startTime: '10:00' });
    expect(nr.autoCall).toBeUndefined();
  });

  it('è puro: l\'array in ingresso e i suoi oggetti restano identici', () => {
    const results = ['confermato', 'riprogrammare', 'rifiutato', 'non_risposto', 'altro_referente', 'annullato'] as const;
    for (const r of results) {
      for (const ctx of [OFF, ON]) {
        const all = world({ callAttempts: 2 });
        const snap = snapshot(all);
        reduceCallOutcome(all, 'x', outcome(r, { newContactPhone: '+39021' }), 'c1', ctx);
        expect(all).toEqual(snap.json);
        all.forEach((a, i) => expect(a).toBe(snap.refs[i]));
      }
    }
  });
});

describe('reduceCallOutcome: alternative accettate', () => {
  const withAlternatives = () => {
    const base = world();
    const alts = computeAlternativeSlots(byId(base, 'x'), base, [tech()], { now: NOW, fallback: FALLBACK });
    expect(alts.length).toBeGreaterThan(0);
    return base.map(a => (a.id === 'x' ? { ...a, offeredAlternatives: alts } : a));
  };

  it('sposta sullo slot scelto, conferma e riempie lo slot lasciato', () => {
    const all = withAlternatives();
    const alt = byId(all, 'x').offeredAlternatives![1];
    const out = reduceCallOutcome(all, 'x', outcome('riprogrammare', { chosenAlternative: 'B' }), 'c1', ON);
    const x = byId(out, 'x');
    expect(x).toMatchObject({
      status: 'confirmed',
      date: alt.date,
      startTime: alt.startTime,
      endTime: alt.endTime,
      callAttempts: 0,
      declinedDates: [D],
      callOutcome: { result: 'confermato', chosenAlternative: 'B' },
    });
    expect(x.notes).toContain('Spostato su richiesta del cliente');
    expect(x.notes).toContain(alt.startTime);
    // slot lasciato: rimpiazzo con la pratica in attesa più vicina
    const near = byId(out, 'near');
    expect(near).toMatchObject({ status: 'proposed', date: D, autoCall: 'backfill', backfillOf: 'Cliente X' });
    expectFixedTimes(all, out, ['s1', 's3']);
  });

  it('alternativa non più libera: da riprogrammare dalla sua data', () => {
    const all = withAlternatives();
    const alt = byId(all, 'x').offeredAlternatives![0];
    const busy = [...all, stop('intrusa', alt.date, alt.startTime, alt.endTime, P.portaVenezia)];
    const x = byId(reduceCallOutcome(busy, 'x', outcome('confermato', { chosenAlternative: 'A' }), 'c1', OFF), 'x');
    expect(x).toMatchObject({ status: 'pending', followUpDate: alt.date, date: undefined, declinedDates: [D] });
    expect(x.callOutcome?.result).toBe('riprogrammare');
    expect(x.notes).toContain('non è più libera');
  });

  it('un\'alternativa non offerta viene ignorata', () => {
    const x = byId(reduceCallOutcome(world(), 'x', outcome('confermato', { chosenAlternative: 'A' }), 'c1', OFF), 'x');
    expect(x).toMatchObject({ status: 'confirmed', date: D, startTime: '10:00' });
  });
});

describe('reduceCallOutcome: tentativi e irreperibili (pilota acceso)', () => {
  it('nuovo tentativo dentro la fascia', () => {
    const x = byId(reduceCallOutcome(world(), 'x', outcome('non_risposto'), 'c1', ON), 'x');
    expect(x).toMatchObject({ autoCall: 'retry', callAttempts: 1, status: 'proposed', startTime: '10:00' });
    expect(new Date(x.autoCallNotBefore!).getTime()).toBe(at('2026-11-11', '12:00').getTime());
  });

  it('nuovo tentativo fuori fascia: riportato all\'apertura successiva', () => {
    const ctx = planning(at('2026-11-11', '18:30'));
    const x = byId(reduceCallOutcome(world(), 'x', outcome('non_risposto'), 'c1', ctx), 'x');
    expect(x.autoCall).toBe('retry');
    expect(new Date(x.autoCallNotBefore!).getTime()).toBe(at('2026-11-12', '09:00').getTime());
  });

  it('irreperibile al tetto dei tentativi: fuori dal giro e rimpiazzo', () => {
    const all = world({ callAttempts: 2 });
    const out = reduceCallOutcome(all, 'x', outcome('non_risposto'), 'c1', ON);
    const x = byId(out, 'x');
    expect(x).toMatchObject({ status: 'issue', issueType: 'callback', callAttempts: 3, date: undefined, autoCall: undefined });
    expect(x.notes).toContain('Non raggiungibile dopo 3 tentativi');
    expect(byId(out, 'near')).toMatchObject({ date: D, autoCall: 'backfill' });
    expect(byId(out, 'far').status).toBe('pending');
  });

  it('irreperibile se il prossimo tentativo cadrebbe troppo a ridosso dello slot', () => {
    // giovedì sera, slot venerdì alle 10:00: il tentativo di venerdì 9:00 è oltre (10:00 − 3h)
    const ctx = planning(at('2026-11-12', '18:30'));
    const x = byId(reduceCallOutcome(world(), 'x', outcome('non_risposto'), 'c1', ctx), 'x');
    expect(x).toMatchObject({ status: 'issue', issueType: 'callback', callAttempts: 1 });
  });
});

describe('reduceCallOutcome: rimpiazzo dello slot liberato', () => {
  it('sceglie la pratica in attesa più vicina e non tocca gli orari esistenti', () => {
    const all = world();
    const out = reduceCallOutcome(all, 'x', outcome('rifiutato'), 'c1', ON);
    const near = byId(out, 'near');
    expect(near).toMatchObject({
      status: 'proposed',
      date: D,
      technicianId: 'tech-1',
      autoCall: 'backfill',
      backfillOf: 'Cliente X',
      callAttempts: 0,
      callStatus: undefined,
    });
    const s = toMin(near.startTime!);
    expect(s).toBeGreaterThanOrEqual(toMin('09:30'));
    expect(s).toBeLessThanOrEqual(toMin('12:00'));
    expectFixedTimes(all, out, ['s1', 's3']);
    const route = getDayRoute(out, 'tech-1', D);
    expect(route.map(r => r.id)).toEqual(['s1', 'near', 's3']);
    expect(route.map(r => r.appt.sequenceOrder)).toEqual([1, 2, 3]);
    for (let i = 1; i < route.length; i++) {
      expect(route[i].start).toBeGreaterThanOrEqual(route[i - 1].end + travelMinutes(route[i - 1].coords, route[i].coords));
    }
  });

  it('privilegia le urgenti', () => {
    const all = [...world(), appt({ id: 'urg', coords: P.cityLife, technicianId: 'tech-1', phone: '+3902', urgent: true })];
    const out = reduceCallOutcome(all, 'x', outcome('rifiutato'), 'c1', ON);
    expect(byId(out, 'urg').date).toBe(D);
    expect(byId(out, 'near').status).toBe('pending');
  });

  it('anticipa una proposta da un giorno successivo e risequenzia quel giorno', () => {
    const all = [
      ...world().filter(a => a.id !== 'near'),
      stop('m1', MON, '09:00', '09:20', P.portaVenezia, { sequenceOrder: 1 }),
      stop('m2', MON, '10:00', '10:20', P.navigli, { sequenceOrder: 2 }),
      stop('m3', MON, '11:00', '11:20', P.cityLife, { sequenceOrder: 3, callOutcome: outcome('confermato') }),
    ];
    const out = reduceCallOutcome(all, 'x', outcome('rifiutato'), 'c1', ON);
    const m1 = byId(out, 'm1');
    expect(m1).toMatchObject({ date: D, autoCall: 'backfill', status: 'proposed' });
    expect(byId(out, 'm2')).toMatchObject({ date: MON, sequenceOrder: 1, startTime: '10:00' });
    expect(byId(out, 'm3')).toMatchObject({ date: MON, sequenceOrder: 2 });
  });

  it('nessun rimpiazzo se lo slot è troppo vicino o senza candidati', () => {
    const close = planning(at('2026-11-13', '08:00'));
    const out = reduceCallOutcome(world(), 'x', outcome('rifiutato'), 'c1', close);
    expect(byId(out, 'near').status).toBe('pending');
    const noBackfill = reduceCallOutcome(world(), 'x', outcome('rifiutato'), 'c1', planning(NOW, { backfill: false }));
    expect(byId(noBackfill, 'near').status).toBe('pending');
    const none = world().filter(a => a.id !== 'near');
    const out2 = reduceCallOutcome(none, 'x', outcome('rifiutato'), 'c1', ON);
    expect(byId(out2, 'far').status).toBe('pending');
  });

  it('chi ha rifiutato una data non viene riproposto per la stessa data', () => {
    // venerdì: x e y nel giro, nessun'altra pratica in attesa
    let state: Appointment[] = [
      stop('x', D, '10:00', '10:20', P.portaVenezia, { title: 'Cliente X', callStatus: 'called', callId: 'c1' }),
      stop('y', D, '11:00', '11:20', P.portaVenezia, { title: 'Cliente Y', callStatus: 'called', callId: 'c2' }),
    ];
    state = reduceCallOutcome(state, 'x', outcome('riprogrammare'), 'c1', ON);
    expect(byId(state, 'x')).toMatchObject({ status: 'pending', declinedDates: [D] });
    state = reduceCallOutcome(state, 'y', outcome('rifiutato'), 'c2', ON);
    // lo slot di y si è liberato ma x (che aveva rifiutato venerdì) non torna su venerdì
    expect(byId(state, 'x')).toMatchObject({ status: 'pending', date: undefined });
    expect(getDayRoute(state, 'tech-1', D)).toEqual([]);

    // controprova: senza la data rifiutata x sarebbe stata scelta
    const control = state.map(a => (a.id === 'x' ? { ...a, declinedDates: undefined } : a));
    const y2 = { ...byId(state, 'y'), status: 'proposed' as const, date: D, startTime: '11:00', endTime: '11:20', callOutcome: undefined, callId: 'c3' };
    const out = reduceCallOutcome(control.map(a => (a.id === 'y' ? y2 : a)), 'y', outcome('rifiutato'), 'c3', ON);
    expect(byId(out, 'x').date).toBe(D);
  });
});

describe('coda delle chiamate', () => {
  const queued = (id: string, reason: 'route' | 'retry' | 'backfill', date: string, start: string, over: Partial<Appointment> = {}) =>
    stop(id, date, start, toHHMMplus20(start), P.milano, { autoCall: reason, ...over });
  const toHHMMplus20 = (s: string) => {
    const m = toMin(s) + 20;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };

  it('fascia oraria e prossima apertura', () => {
    const s = DEFAULT_AUTOPILOT_SETTINGS;
    expect(isWithinCallWindow(at('2026-11-11', '09:00'), s)).toBe(true);
    expect(isWithinCallWindow(at('2026-11-11', '19:30'), s)).toBe(false);
    expect(isWithinCallWindow(at('2026-11-14', '10:00'), s)).toBe(false); // sabato
    expect(isWithinCallWindow(at('2026-11-14', '10:00'), { ...s, callSaturday: true })).toBe(true);
    expect(isWithinCallWindow(at('2026-11-15', '10:00'), { ...s, callSaturday: true })).toBe(false); // domenica mai
    expect(nextCallWindowStart(at('2026-11-11', '07:00'), s).getTime()).toBe(at('2026-11-11', '09:00').getTime());
    expect(nextCallWindowStart(at('2026-11-13', '20:00'), s).getTime()).toBe(at('2026-11-16', '09:00').getTime());
    expect(nextCallWindowStart(at('2026-11-11', '11:00'), s).getTime()).toBe(at('2026-11-11', '11:00').getTime());
  });

  it('nextDueCall: pilota spento o fuori fascia', () => {
    const all = [queued('a', 'route', D, '10:00')];
    expect(nextDueCall(all, OFF)).toBeNull();
    expect(nextDueCall(all, planning(at('2026-11-11', '20:00')))).toBeNull();
    expect(nextDueCall(all, ON)?.id).toBe('a');
  });

  it('nextDueCall: priorità backfill > route > retry, poi data e orario', () => {
    const all = [
      queued('retry', 'retry', D, '09:00'),
      queued('route-late', 'route', D, '11:00'),
      queued('route-early', 'route', D, '10:00'),
      queued('back', 'backfill', MON, '15:00'),
    ];
    expect(nextDueCall(all, ON)?.id).toBe('back');
    expect(nextDueCall(all.filter(a => a.id !== 'back'), ON)?.id).toBe('route-early');
    expect(nextDueCall(all.filter(a => a.autoCall === 'retry'), ON)?.id).toBe('retry');
  });

  it('nextDueCall: tetto chiamate in volo, autoCallNotBefore, senza telefono, slot trascorso', () => {
    const inFlight = [1, 2, 3, 4].map(i =>
      stop(`v${i}`, D, '15:00', '15:20', P.milano, { callStatus: i % 2 ? 'calling' : 'called', callId: `c${i}` })
    );
    const q = queued('a', 'route', D, '10:00');
    expect(nextDueCall([...inFlight, q], ON)).toBeNull();
    expect(nextDueCall([...inFlight.slice(1), q], ON)?.id).toBe('a');
    expect(nextDueCall([...inFlight, q], ON, 5)?.id).toBe('a');

    const later = queued('b', 'retry', D, '10:00', { autoCallNotBefore: at('2026-11-11', '12:00').toISOString() });
    expect(nextDueCall([later], ON)).toBeNull();
    expect(nextDueCall([later], planning(at('2026-11-11', '12:00')))?.id).toBe('b');
    expect(nextDueCall([queued('c', 'route', D, '10:00', { phone: undefined })], ON)).toBeNull();
    expect(nextDueCall([queued('d', 'route', '2026-11-11', '09:00')], ON)).toBeNull();
    // chiamata già conclusa con esito: non è in volo
    const done = stop('e', D, '15:00', '15:20', P.milano, { callStatus: 'called', callId: 'z', callOutcome: outcome('confermato') });
    expect(nextDueCall([...inFlight.slice(1), done, q], ON)?.id).toBe('a');
  });

  it('approveForCalling, cancelAutoCalls, expireStaleAutoCalls', () => {
    const all = [
      stop('ok', D, '10:00', '10:20', P.milano, { callAttempts: 2, autoCallNotBefore: 'x' }),
      stop('nophone', D, '11:00', '11:20', P.milano, { phone: undefined }),
      stop('flying', D, '12:00', '12:20', P.milano, { callStatus: 'calling' }),
      stop('confirmed', D, '13:00', '13:20', P.milano, { callOutcome: outcome('confermato') }),
      appt({ id: 'pending', phone: '+39' }),
      stop('past', '2026-11-10', '10:00', '10:20', P.milano),
    ];
    const out = approveForCalling(all, all.map(a => a.id), NOW);
    expect(byId(out, 'ok')).toMatchObject({ autoCall: 'route', callAttempts: 0, autoCallNotBefore: undefined });
    for (const id of ['nophone', 'flying', 'confirmed', 'pending', 'past']) expect(byId(out, id)).toBe(byId(all, id));

    const cancelled = cancelAutoCalls(out, ['ok']);
    expect(byId(cancelled, 'ok').autoCall).toBeUndefined();

    const stale = expireStaleAutoCalls(
      [queued('old', 'route', '2026-11-10', '10:00'), queued('new', 'route', D, '10:00')],
      NOW
    );
    expect(byId(stale, 'old').autoCall).toBeUndefined();
    expect(byId(stale, 'new').autoCall).toBe('route');
  });

  it('avvio e lancio della chiamata', () => {
    const all = [queued('a', 'retry', D, '10:00', { autoCallNotBefore: 'x', callOutcome: outcome('non_risposto'), callSummary: 's' })];
    const alts = [{ label: 'A' as const, date: MON, startTime: '10:00', endTime: '10:20' }];
    const started = byId(reduceCallStarted(all, 'a', alts), 'a');
    expect(started).toMatchObject({ callStatus: 'calling', autoCall: undefined, autoCallNotBefore: undefined, callOutcome: undefined, callSummary: undefined, offeredAlternatives: alts });
    expect(byId(reduceCallStarted(all, 'a', []), 'a').offeredAlternatives).toBeUndefined();

    const ok = byId(reduceCallLaunchResult([started], 'a', { ok: true, callId: 'r1' }, NOW), 'a');
    expect(ok).toMatchObject({ callStatus: 'called', callId: 'r1', calledAt: NOW.toISOString() });
    const ko = byId(reduceCallLaunchResult([started], 'a', { ok: false, error: 'Numero non valido' }, NOW), 'a');
    expect(ko).toMatchObject({ callStatus: 'failed', calledAt: NOW.toISOString(), callSummary: 'Numero non valido', autoCall: undefined });
  });

  it('autopilotStats', () => {
    const all = [
      queued('a', 'route', D, '10:00'),
      queued('b', 'retry', D, '11:00', { autoCallNotBefore: at('2026-11-11', '12:00').toISOString() }),
      stop('v', D, '15:00', '15:20', P.milano, { callStatus: 'calling' }),
    ];
    const st = autopilotStats(all, ON);
    expect(st).toMatchObject({ queued: 2, inFlight: 1, dueNow: 1, windowOpen: true });
    expect(st.nextCallAt?.getTime()).toBe(NOW.getTime());
    const evening = autopilotStats([all[1]], planning(at('2026-11-11', '20:00')));
    expect(evening.windowOpen).toBe(false);
    expect(evening.nextCallAt?.getTime()).toBe(at('2026-11-12', '09:00').getTime());
    expect(autopilotStats(all, OFF).nextCallAt).toBeNull();
  });

  it('attentionItems', () => {
    const all = [
      stop('sc', D, '10:00', '10:20', P.milano, { callOutcome: outcome('sconosciuto') }),
      stop('ref', D, '11:00', '11:20', P.milano, { callOutcome: outcome('altro_referente', { newContactName: 'Tizio' }) }),
      stop('nophone', D, '12:00', '12:20', P.milano, { phone: undefined }),
      stop('failed', D, '13:00', '13:20', P.milano, { callStatus: 'failed', callSummary: 'errore' }),
      appt({ id: 'notech' }),
      appt({ id: 'approx', technicianId: 'tech-1', approximate: true }),
      appt({ id: 'irr', status: 'issue', issueType: 'callback', notes: 'Non raggiungibile dopo 3 tentativi', callAttempts: 3 }),
      appt({ id: 'wrong', status: 'issue', issueType: 'wrong_phone', technicianId: 'tech-1' }),
      appt({ id: 'fine', status: 'confirmed', technicianId: 'tech-1' }),
    ];
    const items = attentionItems(all, ON);
    const kinds = Object.fromEntries(items.map(i => [i.id, i.kind]));
    expect(kinds).toEqual({
      sc: 'esito_da_verificare',
      ref: 'referente_senza_numero',
      nophone: 'senza_telefono',
      failed: 'chiamata_non_avviata',
      notech: 'senza_tecnico',
      approx: 'posizione_approssimativa',
      irr: 'irreperibile',
      wrong: 'numero_errato',
    });
    expect(items.every(i => i.title && i.detail)).toBe(true);
    expect(isInRoute(all[0])).toBe(true);
  });
});

describe('alternativa dedotta dalla richiesta del cliente', () => {
  const withAlternatives = () => {
    const base = world();
    const alts = computeAlternativeSlots(byId(base, 'x'), base, [tech()], { now: NOW, fallback: FALLBACK });
    expect(alts.length).toBeGreaterThan(1);
    return base.map(a => (a.id === 'x' ? { ...a, offeredAlternatives: alts } : a));
  };

  it('stessa data e orario di uno slot offerto: spostata e confermata', () => {
    const all = withAlternatives();
    const alt = byId(all, 'x').offeredAlternatives![1];
    const out = reduceCallOutcome(
      all,
      'x',
      outcome('riprogrammare', { followUpDate: alt.date, requestedTime: `alle ${alt.startTime.replace(':', '.')}` }),
      'c1',
      ON
    );
    expect(byId(out, 'x')).toMatchObject({
      status: 'confirmed',
      date: alt.date,
      startTime: alt.startTime,
      callOutcome: { result: 'confermato', chosenAlternative: alt.label },
    });
  });

  it('orario diverso da quello offerto: nessuna deduzione, resta da riprogrammare', () => {
    const all = withAlternatives();
    const alt = byId(all, 'x').offeredAlternatives![1];
    const lontano = toMin(alt.startTime) >= 14 * 60 ? '09:00' : '17:00';
    const x = byId(
      reduceCallOutcome(all, 'x', outcome('riprogrammare', { followUpDate: alt.date, requestedTime: lontano }), 'c1', OFF),
      'x'
    );
    expect(x).toMatchObject({ status: 'pending', followUpDate: alt.date });
    expect(x.callOutcome?.result).toBe('riprogrammare');
  });
});

describe('chiamate rimaste senza esito', () => {
  // Chiamate partite un\'ora prima di NOW: oltre il limite, l\'esito non arriverà più
  const stuck = [1, 2, 3, 4].map(i =>
    stop(`v${i}`, D, '15:00', '15:20', P.milano, {
      callStatus: 'called',
      callId: `c${i}`,
      calledAt: at('2026-11-11', '09:00').toISOString(),
    })
  );
  const q = stop('a', D, '10:00', '10:20', P.milano, { autoCall: 'route' });

  it('non bloccano la coda e non contano come in volo', () => {
    expect(nextDueCall([...stuck, q], ON)?.id).toBe('a');
    expect(autopilotStats([...stuck, q], ON).inFlight).toBe(0);
    // le stesse chiamate, partite da poco, bloccano la coda
    const fresh = stuck.map(s => ({ ...s, calledAt: at('2026-11-11', '09:50').toISOString() }));
    expect(nextDueCall([...fresh, q], ON)).toBeNull();
    expect(autopilotStats([...fresh, q], ON).inFlight).toBe(4);
  });

  it('finiscono fra le cose da gestire, come i rifiuti', () => {
    const refused = appt({
      id: 'rif',
      status: 'standby',
      technicianId: 'tech-1',
      callOutcome: outcome('rifiutato'),
    });
    const kinds = Object.fromEntries(attentionItems([stuck[0], refused], ON).map(i => [i.id, i.kind]));
    expect(kinds).toEqual({ v1: 'esito_da_verificare', rif: 'rifiutato' });
  });
});

describe('slot offerti in chiamate in corso', () => {
  const twoCalls = () => {
    // "x" e "y": stesso tecnico, stessa zona, due chiamate una dopo l'altra
    const base = [
      ...world({ callStatus: undefined, callId: undefined }),
      stop('y', D, '14:00', '14:20', P.portaVenezia, { title: 'Cliente Y' }),
    ];
    const altsX = alternativesForCall(byId(base, 'x'), base, ON);
    const afterX = reduceCallLaunchResult(reduceCallStarted(base, 'x', altsX), 'x', { ok: true, callId: 'c1' }, NOW);
    return { base, altsX, afterX };
  };

  it('la seconda chiamata non offre gli slot già offerti nella prima', () => {
    const { base, altsX, afterX } = twoCalls();
    expect(altsX.length).toBeGreaterThan(0);
    const key = (a: { date: string; startTime: string }) => `${a.date} ${a.startTime}`;
    const altsY = alternativesForCall(byId(afterX, 'y'), afterX, ON);
    const taken = new Set(altsX.map(key));
    expect(altsY.some(a => taken.has(key(a)))).toBe(false);
    // senza la prima chiamata in corso gli stessi slot sarebbero stati offerti anche a Y
    const altsYAlone = alternativesForCall(byId(base, 'y'), base, ON);
    expect(altsYAlone.some(a => taken.has(key(a)))).toBe(true);
    // gli slot fantasma non entrano mai nell'elenco delle pratiche
    expect(reservedOfferStops(afterX, NOW).map(s => s.id)).toEqual(altsX.map(a => `x#${a.label}`));
    expect(afterX.some(a => a.id.includes('#'))).toBe(false);
  });

  it('opzione spenta o pratica senza slot: nessuna alternativa', () => {
    const { base } = twoCalls();
    expect(alternativesForCall(byId(base, 'x'), base, planning(NOW, { offerAlternatives: false }))).toEqual([]);
    expect(alternativesForCall(byId(base, 'near'), base, ON)).toEqual([]);
  });

  it('il rimpiazzo non occupa uno slot riservato a una chiamata in corso', () => {
    // "y" è in chiamata con un'alternativa offerta proprio nel varco che "x" sta per liberare
    // (09:35 è esattamente l'inizio che il rimpiazzo sceglierebbe se lo slot fosse libero)
    const reserved = { label: 'A' as const, date: D, startTime: '09:35', endTime: '09:55' };
    const all = [
      ...world(),
      stop('y', MON, '09:00', '09:20', P.portaVenezia, {
        callStatus: 'called',
        callId: 'c2',
        calledAt: NOW.toISOString(),
        offeredAlternatives: [reserved],
      }),
    ];
    const out = reduceCallOutcome(all, 'x', outcome('rifiutato'), 'c1', ON);
    expect(byId(out, 'near')).toMatchObject({ status: 'proposed', date: D, autoCall: 'backfill' });
    for (const a of out) {
      if (a.id === 'y' || !isInRoute(a) || a.date !== D) continue;
      const overlaps = toMin(a.startTime!) < toMin(reserved.endTime) && toMin(a.endTime!) > toMin(reserved.startTime);
      expect(overlaps, `${a.id} ${a.startTime}-${a.endTime}`).toBe(false);
    }
    // e l'alternativa resta confermabile per "y"
    const done = reduceCallOutcome(out, 'y', outcome('riprogrammare', { chosenAlternative: 'A' }), 'c2', ON);
    expect(byId(done, 'y')).toMatchObject({ status: 'confirmed', date: D, startTime: '09:35' });
  });
});
