import '../server/tz';
import { describe, expect, it } from 'vitest';
import type { Appointment } from '../src/types';
import type { CloudConfig, CloudSnapshot, CloudStatus } from '../src/services/cloudProtocol';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../src/services/autopilotService';
import { MemoryStore, commit, type Store } from '../server/store';
import { createCloudHandler, createTickHandler, type HandlerDeps } from '../server/http';
import { webhookToken } from '../server/auth';
import { FALLBACK, P, appt, at, stop, tech } from './fixtures';
import { FakeRetell, invoke } from './serverFakes';

// Endpoint /api/cloud e /api/cloud-tick con req/res finti in stile Vercel.

const SECRET = 'segreto-di-prova-0123456789';
const AUTH = { authorization: `Bearer ${SECRET}` };
const D = '2026-11-13';
const NOW = at('2026-11-11', '10:00');
const X_PHONE = '+390233330000';

const CONFIG: CloudConfig = {
  technicians: [tech()],
  autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true },
  fallback: FALLBACK,
};

const APPTS = (): Appointment[] => [
  stop('s1', D, '09:00', '09:20', P.milano, { sequenceOrder: 1 }),
  stop('x', D, '10:00', '10:20', P.portaVenezia, { title: 'Cliente X', sequenceOrder: 2, phone: X_PHONE, autoCall: 'route' }),
  appt({ id: 'near', coords: P.portaVenezia, technicianId: 'tech-1', phone: '+390211111111' }),
];

const make = (over: Partial<HandlerDeps> = {}) => {
  const store = new MemoryStore('optiroute:test:');
  const retell = new FakeRetell();
  const clock = { wall: 5_000_000, now: NOW };
  const deps: Partial<HandlerDeps> = {
    env: { CRON_SECRET: SECRET },
    store,
    retell,
    now: () => clock.now,
    clock: () => clock.wall,
    sleep: async ms => { clock.wall += ms; },
    ...over,
  };
  const cloud = createCloudHandler(deps);
  const tick = createTickHandler(deps);
  const call = (op: string, init: { method?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}) =>
    invoke(cloud, { method: init.method || 'GET', query: { op, ...(init.query || {}) }, headers: init.headers ?? AUTH, body: init.body });
  const init = () => call('init', { method: 'POST', body: { device: 'dev-a', appointments: APPTS(), config: CONFIG, replace: true } });
  return { store: store as Store, retell, clock, cloud, tick, call, init };
};

describe('ping', () => {
  it('senza chiave, solo protocollo e configurazione', async () => {
    const t = make();
    const res = await t.call('ping', { headers: {} });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ protocol: 1, secretConfigured: true, storeConfigured: true, gestionale: { enabled: false, parentAllowed: false } });
    expect(res.headers['cache-control']).toBe('no-store');

    const bare = make({ env: {}, store: null });
    expect((await bare.call('ping', { headers: {} })).body).toEqual({ protocol: 1, secretConfigured: false, storeConfigured: false, gestionale: { enabled: false, parentAllowed: false } });
  });
});

describe('init, pull, push', () => {
  it('init: replace obbligatorio, poi stato completo con turno', async () => {
    const t = make();
    const bad = await t.call('init', { method: 'POST', body: { device: 'dev-a', appointments: APPTS(), config: CONFIG } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toBe('bad_request');

    const res = await t.init();
    expect(res.statusCode).toBe(200);
    const snap = res.body as CloudSnapshot;
    expect(snap.rev).toBe(1);
    expect(snap.configRev).toBe(1);
    expect(snap.appointments!.map(a => a.id)).toEqual(['s1', 'x', 'near']);
    expect(snap.config).toEqual(JSON.parse(JSON.stringify(CONFIG)));
    expect(snap.lease).toEqual({ holder: true, deviceId: 'dev-a', until: new Date(5_000_000 + 90_000).toISOString() });
  });

  it('pull: invariato se rev e configRev coincidono, altrimenti stato completo', async () => {
    const t = make();
    const empty = await t.call('pull');
    expect(empty.body).toEqual({ rev: 0, configRev: 0, appointments: [], config: null, lease: null });

    await t.init();
    const same = await t.call('pull', { query: { rev: '1', configRev: '1', device: 'dev-a' } });
    expect(same.body).toEqual({ rev: 1, configRev: 1, unchanged: true, lease: { holder: true, deviceId: 'dev-a', until: expect.any(String) } });

    const stale = await t.call('pull', { query: { rev: '0', configRev: '1' } });
    expect(stale.body.unchanged).toBeUndefined();
    expect(stale.body.appointments).toHaveLength(3);
    expect(stale.body.lease).toMatchObject({ holder: false, deviceId: 'dev-a' });

    const configOnly = await t.call('pull', { query: { rev: '1', configRev: '0' } });
    expect(configOnly.body.config).toBeTruthy();
  });

  it('push: fusione campo per campo con lo stato ATTUALE', async () => {
    const t = make();
    await t.init();
    // nel frattempo il motore ha registrato una chiamata su x (rev 2)
    await commit(t.store, all => all.map(a => (a.id === 'x' ? { ...a, callStatus: 'called' as const, callId: 'c9' } : a)));
    // il browser, partito dalla rev 1, modifica le note di x e aggiunge una pratica
    const res = await t.call('push', {
      method: 'POST',
      body: {
        device: 'dev-a',
        changes: [
          { op: 'patch', id: 'x', set: { notes: 'citofono rotto' }, unset: [] },
          { op: 'put', id: 'n', value: appt({ id: 'n', technicianId: 'tech-1' }) },
          { op: 'delete', id: 'near' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.rev).toBe(3);
    const x = res.body.appointments.find((a: Appointment) => a.id === 'x');
    expect(x).toMatchObject({ notes: 'citofono rotto', callStatus: 'called', callId: 'c9' });
    expect(res.body.appointments.map((a: Appointment) => a.id)).toEqual(['s1', 'x', 'n']);
  });

  it('push vuoto senza config: nessuna scrittura; con config: nuova configRev', async () => {
    const t = make();
    await t.init();
    const none = await t.call('push', { method: 'POST', body: { device: 'dev-a', changes: [] } });
    expect(none.body).toMatchObject({ rev: 1, configRev: 1 });
    const withConfig = await t.call('push', {
      method: 'POST',
      body: { device: 'dev-a', changes: [], config: { ...CONFIG, autopilot: { ...CONFIG.autopilot, enabled: false } } },
    });
    expect(withConfig.body).toMatchObject({ rev: 1, configRev: 2, config: { autopilot: { enabled: false } } });
  });

  it('push non valido -> 400; conflitti continui -> 409', async () => {
    const t = make();
    await t.init();
    for (const changes of [[{ op: 'boh', id: 'x' }], [{ op: 'patch', id: 'x', set: { id: 'y' }, unset: [] }], 'x']) {
      const res = await t.call('push', { method: 'POST', body: { device: 'dev-a', changes } });
      expect(res.statusCode).toBe(400);
    }
    expect((await t.call('push', { method: 'POST', body: { changes: [] } })).statusCode).toBe(400); // senza device
    expect((await t.call('push', { method: 'POST', body: '{non json' })).statusCode).toBe(400);

    const store = Object.create(t.store) as Store;
    store.writeAppointments = async () => null;
    const busy = make({ store });
    const res = await busy.call('push', {
      method: 'POST',
      body: { device: 'dev-a', changes: [{ op: 'patch', id: 'x', set: { notes: 'n' }, unset: [] }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'conflict' });
  });

  it('turno degli automatismi: uno alla volta, passa alla scadenza', async () => {
    const t = make();
    await t.init();
    const b = await t.call('pull', { query: { device: 'dev-b' } });
    expect(b.body.lease).toMatchObject({ holder: false, deviceId: 'dev-a' });
    t.clock.wall += 60_000;
    expect((await t.call('pull', { query: { rev: '1', configRev: '1', device: 'dev-a' } })).body.lease.holder).toBe(true); // rinnovo
    t.clock.wall += 89_000;
    expect((await t.call('pull', { query: { device: 'dev-b' } })).body.lease).toMatchObject({ holder: false, deviceId: 'dev-a' });
    t.clock.wall += 2000;
    expect((await t.call('pull', { query: { device: 'dev-b' } })).body.lease).toMatchObject({ holder: true, deviceId: 'dev-b' });
  });
});

describe('tick, webhook, cloud-tick, status', () => {
  it('tick dal browser: passaggio del motore e rev aggiornate', async () => {
    const t = make();
    await t.init();
    const res = await t.call('tick', { method: 'POST', body: { device: 'dev-a' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toMatchObject({ callsLaunched: 1, pilotEnabled: true, windowOpen: true });
    expect(res.body.rev).toBe(3); // marcatura + esito del lancio
    expect(res.body.configRev).toBe(1);
    expect(res.body.lease).toMatchObject({ holder: true, deviceId: 'dev-a' });
    expect(t.retell.phonesCalled()).toEqual([X_PHONE]);

    const meta = await t.store.readMeta();
    expect(meta.lastTick?.source).toBe('browser');
  });

  it('webhook: token obbligatorio, call_started ignorato, gli altri eventi svegliano il motore', async () => {
    const t = make();
    await t.init();
    await t.call('tick', { method: 'POST', body: { device: 'dev-a' } });
    const token = webhookToken(SECRET);

    const wrong = await t.call('webhook', { method: 'POST', headers: {}, query: { token: 'x'.repeat(32) }, body: { event: 'call_ended' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toEqual({ error: 'auth' });
    expect((await t.call('webhook', { method: 'POST', headers: {}, body: { event: 'call_ended' } })).statusCode).toBe(401);

    const started = await t.call('webhook', { method: 'POST', headers: {}, query: { token }, body: { event: 'call_started', call: { call_id: 'call_1' } } });
    expect(started.body).toEqual({ ok: true, ignored: true });
    expect((await t.store.readMeta()).webhookSeenAt).toBe(NOW.toISOString());

    // il contenuto non conta: l'esito si rilegge da Retell
    t.retell.finish(X_PHONE, { result: 'confermato' });
    t.clock.wall += 10_000;
    const ended = await t.call('webhook', {
      method: 'POST',
      headers: {},
      query: { token },
      body: JSON.stringify({ event: 'call_analyzed', call: { call_id: 'call_1', call_analysis: { custom_analysis_data: { esito: 'rifiutato' } } } }),
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.body).toEqual({ ok: true });
    const x = (await t.store.readAppointments()).appointments!.find(a => a.id === 'x')!;
    expect(x).toMatchObject({ status: 'confirmed', callOutcome: { result: 'confermato' } });
    expect((await t.store.readMeta()).lastTick?.source).toBe('webhook');
  });

  it('cloud-tick: GET o POST con chiave; schedulerSeenAt solo dallo scheduler di Vercel', async () => {
    const t = make();
    await t.init();
    const manual = await invoke(t.tick, { method: 'GET', headers: AUTH });
    expect(manual.statusCode).toBe(200);
    expect(manual.body.summary).toMatchObject({ callsLaunched: 1 });
    expect((await t.store.readMeta()).schedulerSeenAt).toBeNull();

    t.clock.wall += 60_000;
    const cron = await invoke(t.tick, { method: 'POST', headers: { ...AUTH, 'user-agent': 'vercel-cron/1.0' } });
    expect(cron.statusCode).toBe(200);
    expect((await t.store.readMeta()).schedulerSeenAt).toBe(NOW.toISOString());
    expect((await t.store.readMeta()).lastTick?.source).toBe('scheduler');

    expect((await invoke(t.tick, { method: 'POST', headers: {} })).statusCode).toBe(401);
    expect((await invoke(t.tick, { method: 'PUT', headers: AUTH })).statusCode).toBe(405);
    expect(t.retell.created).toHaveLength(1);
  });

  it('status', async () => {
    const t = make();
    await t.init();
    await t.call('tick', { method: 'POST', body: { device: 'dev-a' } });
    const res = await t.call('status');
    expect(res.statusCode).toBe(200);
    const s = res.body as CloudStatus;
    expect(s).toMatchObject({
      protocol: 1,
      env: 'development',
      storeConfigured: true,
      timezone: { zone: 'Europe/Rome', ok: true },
      rev: 3,
      configRev: 1,
      appointmentCount: 3,
      schedulerSeenAt: null,
      webhookSeenAt: null,
      webhookPath: `/api/cloud?op=webhook&token=${webhookToken(SECRET)}`,
      serverTime: NOW.toISOString(),
    });
    expect(typeof s.retellConfigured).toBe('boolean');
    expect(s.lastTick).toMatchObject({ source: 'browser', at: NOW.toISOString(), summary: { callsLaunched: 1 } });
  });

  it('metodo non ammesso 405, op sconosciuta 400, errori interni 500 senza dettagli', async () => {
    const t = make();
    expect((await t.call('push', { method: 'GET' })).statusCode).toBe(405);
    expect((await t.call('status', { method: 'POST' })).statusCode).toBe(405);
    const unknown = await t.call('boh');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toEqual({ error: 'bad_request' });
    expect((await invoke(t.cloud, { method: 'GET', query: {}, headers: AUTH })).statusCode).toBe(400);

    const broken = Object.create(t.store) as Store;
    broken.readAppointments = async () => { throw new Error('dettaglio riservato'); };
    const res = await make({ store: broken }).call('status');
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'server' });
  });
});
