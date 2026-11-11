import '../server/tz';
import { describe, expect, it, vi } from 'vitest';
import type { Appointment } from '../src/types';
import type { CloudConfig } from '../src/services/cloudProtocol';
import { applyAppointmentChanges } from '../src/services/cloudProtocol';
import { DEFAULT_AUTOPILOT_SETTINGS, type AutopilotSettings } from '../src/services/autopilotService';
import { MemoryStore, commit, type Store } from '../server/store';
import {
  INTERRUPTED_LAUNCH_SUMMARY,
  OUTCOME_TIMEOUT_SUMMARY,
  runTick,
  type EngineDeps,
} from '../server/engine';
import { timezoneStatus } from '../server/tz';
import { FALLBACK, P, appt, at, outcome, stop, tech } from './fixtures';
import { FakeRetell } from './serverFakes';

// Motore lato server con Retell finto e orologio finto.
// Mercoledì 11/11/2026, giro di venerdì 13.

const D = '2026-11-13';
const NOW = at('2026-11-11', '10:00');
const X_PHONE = '+390233330000';
const NEAR_PHONE = '+390211111111';

const config = (over: Partial<AutopilotSettings> = {}): CloudConfig => ({
  technicians: [tech()],
  autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true, ...over },
  fallback: FALLBACK,
});

// x in coda nel giro di venerdì, "near" in attesa vicino a x (candidato al rimpiazzo)
const world = (xOver: Partial<Appointment> = {}): Appointment[] => [
  stop('s1', D, '09:00', '09:20', P.milano, { sequenceOrder: 1 }),
  stop('x', D, '10:00', '10:20', P.portaVenezia, {
    title: 'Cliente X',
    sequenceOrder: 2,
    phone: X_PHONE,
    autoCall: 'route',
    callAttempts: 0,
    ...xOver,
  }),
  stop('s3', D, '11:30', '11:50', P.sesto, { sequenceOrder: 3 }),
  appt({ id: 'near', coords: P.portaVenezia, technicianId: 'tech-1', phone: NEAR_PHONE }),
  appt({ id: 'far', coords: P.lodi, technicianId: 'tech-1', phone: '+390222222222' }),
];

// Come toMatchObject, ma un campo atteso `undefined` vale anche "assente"
// (nel database l'elenco viaggia in JSON: i campi undefined spariscono)
const like = (actual: unknown, expected: Record<string, unknown>) => {
  const a = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    if (v === undefined) expect(a[k], k).toBeUndefined();
    else if (v && typeof v === 'object') expect(a[k], k).toMatchObject(v);
    else expect(a[k], k).toEqual(v);
  }
};

interface Harness {
  store: Store;
  retell: FakeRetell;
  deps: EngineDeps;
  clock: { wall: number; now: Date };
  read: () => Promise<Appointment[]>;
  byId: (id: string) => Promise<Appointment>;
}

const setup = async (appointments: Appointment[], cfg: CloudConfig = config()): Promise<Harness> => {
  const store = new MemoryStore('optiroute:test:');
  await store.replaceAppointments(appointments);
  await store.writeConfig(cfg);
  const retell = new FakeRetell();
  const clock = { wall: 1_000_000, now: NOW };
  const deps: EngineDeps = {
    store,
    retell,
    now: () => clock.now,
    clock: () => clock.wall,
    sleep: async ms => { clock.wall += ms; },
  };
  const read = async () => (await store.readAppointments()).appointments!;
  return { store, retell, deps, clock, read, byId: async id => (await read()).find(a => a.id === id)! };
};

describe('fuso orario', () => {
  it('il processo dei test gira in Europe/Rome e l\'autocontrollo passa', () => {
    expect(timezoneStatus()).toEqual({ zone: 'Europe/Rome', ok: true });
    expect(NOW.getHours()).toBe(10);
  });

  it('fuso non valido: nessuna chiamata', async () => {
    const h = await setup(world());
    h.deps.timezone = () => ({ zone: 'UTC', ok: false });
    const summary = await runTick(h.deps, 'scheduler');
    expect(summary.skipped).toBe('timezone');
    expect(h.retell.created).toHaveLength(0);
    expect((await h.byId('x')).callStatus).toBeUndefined();
  });
});

describe('lanci', () => {
  it('nella fascia: chiama la pratica in coda con tecnico, agenda e alternative', async () => {
    const h = await setup(world());
    const summary = await runTick(h.deps, 'scheduler');
    expect(summary).toMatchObject({ callsLaunched: 1, callsFailed: 0, pilotEnabled: true, windowOpen: true, inFlight: 1, queued: 0 });
    expect(summary.error).toBeUndefined();
    expect(h.retell.phonesCalled()).toEqual([X_PHONE]);
    const body = h.retell.created[0].body;
    expect(body).toMatchObject({ clientName: 'Cliente X', date: D, startTime: '10:00', technicianName: 'Tecnico Uno' });
    expect(body.daySchedule).toContain('Fasce già impegnate');
    expect(Array.isArray(body.alternatives)).toBe(true);
    const x = await h.byId('x');
    like(x, { callStatus: 'called', callId: 'call_1', calledAt: NOW.toISOString(), autoCall: undefined });
    expect(x.offeredAlternatives).toEqual(body.alternatives);

    // passaggio successivo: nessun doppione, si interroga l'esito
    const again = await runTick(h.deps, 'scheduler');
    expect(again.callsLaunched).toBe(0);
    expect(h.retell.created).toHaveLength(1);
    expect(h.retell.getCalls).toContain('call_1');
  });

  it('fuori fascia (prima, dopo, domenica) non chiama; all\'apertura sì', async () => {
    const h = await setup(world());
    for (const when of [at('2026-11-11', '08:59'), at('2026-11-11', '19:30'), at('2026-11-08', '11:00')]) {
      h.clock.now = when;
      const s = await runTick(h.deps, 'scheduler');
      expect(s.callsLaunched).toBe(0);
      expect(s.windowOpen).toBe(false);
    }
    expect(h.retell.created).toHaveLength(0);
    h.clock.now = at('2026-11-11', '09:00');
    expect((await runTick(h.deps, 'scheduler')).callsLaunched).toBe(1);
  });

  it('pilota spento: nessun lancio ma gli esiti si applicano', async () => {
    const h = await setup(
      world({ autoCall: undefined, callStatus: 'called', callId: 'c1', calledAt: at('2026-11-11', '09:55').toISOString() }).map(a =>
        a.id === 'near' ? { ...a, status: 'proposed' as const, date: D, startTime: '15:00', endTime: '15:20', autoCall: 'route' as const } : a
      ),
      config({ enabled: false })
    );
    h.retell.lookups.set('c1', { kind: 'done', outcome: { result: 'confermato', summary: 'ok' } });
    const summary = await runTick(h.deps, 'scheduler');
    expect(summary).toMatchObject({ outcomesApplied: 1, callsLaunched: 0, pilotEnabled: false });
    expect(h.retell.created).toHaveLength(0);
    expect(await h.byId('x')).toMatchObject({ status: 'confirmed', callOutcome: { result: 'confermato' }, callSummary: 'ok' });
  });

  it('Retell non configurato: nessun lancio, avviso nel riepilogo', async () => {
    const h = await setup(world());
    h.retell.isConfigured = false;
    const summary = await runTick(h.deps, 'scheduler');
    expect(summary.callsLaunched).toBe(0);
    expect(summary.error).toMatch(/non configurate/);
    expect((await h.byId('x')).autoCall).toBe('route');
  });

  it('lancio rifiutato da Retell: chiamata non avviata, nessun richiamo automatico', async () => {
    const h = await setup(world());
    h.retell.createFailure = 'Errore Retell (402)';
    const summary = await runTick(h.deps, 'scheduler');
    expect(summary).toMatchObject({ callsLaunched: 0, callsFailed: 1 });
    like(await h.byId('x'), { callStatus: 'failed', callSummary: 'Errore Retell (402)', autoCall: undefined });
    h.retell.createFailure = null;
    expect((await runTick(h.deps, 'scheduler')).callsLaunched).toBe(0);
  });
});

describe('esiti', () => {
  it('confermato', async () => {
    const h = await setup(world());
    await runTick(h.deps, 'scheduler');
    h.retell.finish(X_PHONE, { result: 'confermato', summary: 'Confermato dal cliente' });
    h.clock.now = at('2026-11-11', '10:05');
    h.clock.wall += 5 * 60_000;
    const s = await runTick(h.deps, 'webhook'); // sveglia del webhook a fine chiamata
    expect(s.outcomesApplied).toBe(1);
    expect(await h.byId('x')).toMatchObject({ status: 'confirmed', callStatus: 'called', callOutcome: { result: 'confermato' } });
  });

  it('rifiutato: stand-by, rimpiazzo dello slot e chiamata del rimpiazzo nel passaggio successivo', async () => {
    const h = await setup(world());
    await runTick(h.deps, 'scheduler');
    h.retell.finish(X_PHONE, { result: 'rifiutato' });
    h.clock.now = at('2026-11-11', '10:05');
    const s = await runTick(h.deps, 'scheduler');
    expect(s).toMatchObject({ outcomesApplied: 1, callsLaunched: 1 });
    like(await h.byId('x'), { status: 'standby', date: undefined });
    const near = await h.byId('near');
    expect(near).toMatchObject({ status: 'proposed', date: D, backfillOf: 'Cliente X', callStatus: 'called', callId: 'call_2' });
    expect(h.retell.phonesCalled()).toEqual([X_PHONE, NEAR_PHONE]);
  });

  it('alternativa accettata in chiamata: spostata sullo slot scelto e confermata', async () => {
    const h = await setup(world());
    await runTick(h.deps, 'scheduler');
    const offered = (await h.byId('x')).offeredAlternatives!;
    expect(offered.length).toBeGreaterThan(0);
    h.retell.finish(X_PHONE, { result: 'confermato', chosenAlternative: offered[0].label });
    h.clock.now = at('2026-11-11', '10:06');
    await runTick(h.deps, 'scheduler');
    expect(await h.byId('x')).toMatchObject({
      status: 'confirmed',
      date: offered[0].date,
      startTime: offered[0].startTime,
      callOutcome: { result: 'confermato', chosenAlternative: offered[0].label },
    });
  });

  it('non risposto: richiamo all\'orario giusto, non prima', async () => {
    const h = await setup(world());
    await runTick(h.deps, 'scheduler');
    h.retell.finish(X_PHONE, { result: 'non_risposto' });
    h.clock.now = at('2026-11-11', '10:05');
    await runTick(h.deps, 'scheduler');
    const x = await h.byId('x');
    expect(x).toMatchObject({ autoCall: 'retry', callAttempts: 1, callStatus: 'failed' });
    expect(new Date(x.autoCallNotBefore!).getTime()).toBe(at('2026-11-11', '12:05').getTime());

    h.clock.now = at('2026-11-11', '12:04');
    expect((await runTick(h.deps, 'scheduler')).callsLaunched).toBe(0);
    h.clock.now = at('2026-11-11', '12:05');
    expect((await runTick(h.deps, 'scheduler')).callsLaunched).toBe(1);
    expect(h.retell.phonesCalled()).toEqual([X_PHONE, X_PHONE]);
    like(await h.byId('x'), { callId: 'call_2', callOutcome: undefined, callAttempts: 1 });
  });

  it('chiamata senza esito oltre il limite -> sconosciuto; errore transitorio -> niente', async () => {
    const calledAt = at('2026-11-11', '09:10').toISOString(); // 50 minuti prima
    const h = await setup(world({ autoCall: undefined, callStatus: 'called', callId: 'c1', calledAt }));
    h.retell.lookups.set('c1', { kind: 'error', transient: true });
    expect((await runTick(h.deps, 'scheduler')).outcomesApplied).toBe(0);
    expect((await h.byId('x')).callOutcome).toBeUndefined();

    h.retell.lookups.set('c1', { kind: 'pending' });
    expect((await runTick(h.deps, 'scheduler')).outcomesApplied).toBe(1);
    expect(await h.byId('x')).toMatchObject({
      callOutcome: { result: 'sconosciuto', summary: OUTCOME_TIMEOUT_SUMMARY },
      callSummary: OUTCOME_TIMEOUT_SUMMARY,
    });
  });

  it('chiamata ancora in corso entro il limite: si riprova al prossimo passaggio', async () => {
    const h = await setup(world({ autoCall: undefined, callStatus: 'called', callId: 'c1', calledAt: at('2026-11-11', '09:58').toISOString() }));
    expect((await runTick(h.deps, 'scheduler')).outcomesApplied).toBe(0);
    expect((await h.byId('x')).callOutcome).toBeUndefined();
  });
});

describe('recupero dei lanci interrotti', () => {
  it('calling senza callId da più di 3 minuti -> non avviata, senza richiamo; i recenti restano', async () => {
    const all = world({ autoCall: undefined, callStatus: 'calling', callStartedAt: at('2026-11-11', '09:55').toISOString() });
    all.push(stop('y', D, '15:00', '15:20', P.navigli, { phone: '+390244440000', callStatus: 'calling', callStartedAt: at('2026-11-11', '09:59').toISOString() }));
    all.push(stop('z', D, '16:00', '16:20', P.navigli, { phone: '+390255550000', callStatus: 'calling' })); // senza istante
    const h = await setup(all);
    const s = await runTick(h.deps, 'scheduler');
    expect(s.recovered).toBe(2);
    like(await h.byId('x'), { callStatus: 'failed', callSummary: INTERRUPTED_LAUNCH_SUMMARY, autoCall: undefined });
    expect(await h.byId('z')).toMatchObject({ callStatus: 'failed', callSummary: INTERRUPTED_LAUNCH_SUMMARY });
    expect(await h.byId('y')).toMatchObject({ callStatus: 'calling' });
    expect(h.retell.created).toHaveLength(0);
  });

  it('slot trascorsi tolti dalla coda', async () => {
    const h = await setup(world({ date: '2026-11-11', startTime: '09:00', endTime: '09:20' }));
    const s = await runTick(h.deps, 'scheduler');
    expect(s.expired).toBe(1);
    expect((await h.byId('x')).autoCall).toBeUndefined();
    expect(h.retell.created).toHaveLength(0);
  });
});

describe('concorrenza e prudenza', () => {
  it('lock occupato: passaggio saltato, nessuna chiamata', async () => {
    const h = await setup(world());
    expect(await h.store.acquireLock('altro-passaggio', 55_000)).toBe(true);
    const s = await runTick(h.deps, 'scheduler');
    expect(s.skipped).toBe('locked');
    expect(h.retell.created).toHaveLength(0);
    expect((await h.store.readMeta()).lastTick).toBeNull();
  });

  it('due passaggi concorrenti (anche senza lock) non chiamano due volte la stessa pratica', async () => {
    const all = world();
    all.push(stop('y', D, '15:00', '15:20', P.navigli, { phone: '+390244440000', autoCall: 'route' }));
    const h = await setup(all);
    let conflicts = 0;
    const racy = Object.create(h.store) as Store;
    racy.acquireLock = async () => true; // lock scaduto / rotto: resta il compare-and-set
    racy.readAppointments = async () => {
      const r = await h.store.readAppointments();
      await new Promise(resolve => setImmediate(resolve)); // lascia passare l'altro passaggio
      return r;
    };
    racy.writeAppointments = async (rev, list) => {
      const r = await h.store.writeAppointments(rev, list);
      if (r === null) conflicts++;
      return r;
    };
    const deps = { ...h.deps, store: racy };
    const [a, b] = await Promise.all([runTick(deps, 'scheduler'), runTick(deps, 'browser')]);
    expect(conflicts).toBeGreaterThan(0);
    const phones = h.retell.phonesCalled();
    expect(new Set(phones).size).toBe(phones.length);
    expect(phones.sort()).toEqual([X_PHONE, '+390244440000'].sort());
    expect(a.callsLaunched + b.callsLaunched).toBe(2);
  });

  it('una modifica dell\'operatore arrivata durante il passaggio non va persa', async () => {
    const h = await setup(world());
    let injected = false;
    const store = Object.create(h.store) as Store;
    store.writeAppointments = async (rev, list) => {
      if (!injected && list.some(a => a.id === 'x' && a.callStatus === 'calling')) {
        injected = true; // push dell'operatore fra la lettura e la scrittura del motore
        await commit(h.store, all =>
          applyAppointmentChanges(all, [{ op: 'patch', id: 's1', set: { notes: 'citofono rotto' }, unset: [] }])
        );
      }
      return h.store.writeAppointments(rev, list);
    };
    const s = await runTick({ ...h.deps, store }, 'scheduler');
    expect(injected).toBe(true);
    expect(s.callsLaunched).toBe(1);
    expect((await h.byId('s1')).notes).toBe('citofono rotto');
    expect(await h.byId('x')).toMatchObject({ callStatus: 'called', callId: 'call_1' });
    expect(h.retell.created).toHaveLength(1);
  });

  it('budget rispettato (con 1,5 s fra un lancio e l\'altro)', async () => {
    const all = world();
    all.push(stop('y', D, '15:00', '15:20', P.navigli, { phone: '+390244440000', autoCall: 'route' }));
    all.push(stop('z', D, '16:00', '16:20', P.navigli, { phone: '+390255550000', autoCall: 'route' }));
    const h = await setup(all);
    const sleeps: number[] = [];
    h.deps.sleep = async ms => { sleeps.push(ms); h.clock.wall += ms; };
    const s = await runTick(h.deps, 'scheduler', { budgetMs: 2000 });
    expect(s.callsLaunched).toBe(2);
    expect(s.queued).toBe(1);
    expect(sleeps).toEqual([1500, 1500]);
    const rest = await runTick(h.deps, 'scheduler');
    expect(rest.callsLaunched).toBe(1);
  });

  it('webhook: saltato se un passaggio è finito da meno di 3 secondi', async () => {
    const h = await setup(world());
    await runTick(h.deps, 'scheduler');
    h.clock.wall += 1000;
    expect((await runTick(h.deps, 'webhook')).skipped).toBe('recent');
    h.clock.wall += 2500;
    expect((await runTick(h.deps, 'webhook')).skipped).toBeUndefined();
  });

  it('senza stato: no_state', async () => {
    const store = new MemoryStore('optiroute:vuoto:');
    const s = await runTick({ store, retell: new FakeRetell(), now: () => NOW }, 'scheduler');
    expect(s.skipped).toBe('no_state');
  });

  it('errori del database: riepilogo con errore generico, mai eccezioni', async () => {
    const h = await setup(world());
    const broken = Object.create(h.store) as Store;
    let reads = 0;
    // la prima lettura (prima del lock) riesce, poi il database si guasta
    broken.readAppointments = async () => {
      if (reads++ === 0) return h.store.readAppointments();
      throw new Error('boom: Mario Rossi +39...');
    };
    const s = await runTick({ ...h.deps, store: broken }, 'scheduler');
    expect(s.error).toBe('Errore interno del motore');
    expect(h.retell.created).toHaveLength(0);
    // il lock è stato rilasciato
    expect(await h.store.acquireLock('dopo', 1000)).toBe(true);
  });
});

describe('sync col gestionale', () => {
  it('al massimo una volta l\'ora; errori nel riepilogo', async () => {
    const confirmed = stop('c', D, '17:00', '17:20', P.navigli, { status: 'confirmed', callOutcome: outcome('confermato') });
    const h = await setup([...world({ autoCall: undefined }), confirmed]);
    const sync = vi.fn(async (list: Appointment[]) => ({ sent: list.filter(a => a.id === 'c').length, failed: 0, errors: [], envName: 'collaudo' }));
    h.deps.sync = sync;
    expect((await runTick(h.deps, 'scheduler')).synced).toBe(1);
    h.clock.now = at('2026-11-11', '10:30');
    expect((await runTick(h.deps, 'scheduler')).synced).toBe(0);
    expect((await runTick(h.deps, 'webhook')).synced).toBe(0);
    expect(sync).toHaveBeenCalledTimes(1);
    h.clock.now = at('2026-11-11', '11:00');
    sync.mockResolvedValueOnce({ sent: 0, failed: 1, errors: ['x'], envName: 'collaudo' });
    const s = await runTick(h.deps, 'scheduler');
    expect(sync).toHaveBeenCalledTimes(2);
    expect(s.error).toMatch(/1 invii non riusciti/);
    expect((await h.store.readMeta()).lastSync).toMatchObject({ sent: 0, failed: 1 });
  });
});
