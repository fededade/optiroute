import { afterEach, describe, expect, it } from 'vitest';
import type { Appointment } from '../src/types';
import { applyAppointmentChanges, type AppointmentChange, type CloudConfig } from '../src/services/cloudProtocol';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../src/services/autopilotService';
import {
  CloudSyncEngine,
  PULL_VISIBLE_MS,
  RETRY_DELAYS_MS,
  TICK_INTERVAL_MS,
  planActivation,
  replaceCloudData,
  schedulerFresh,
  stableStringify,
  startActivation,
  type CloudSyncHost,
  type SyncClock,
} from '../src/services/cloudSyncCore';
import { cloudPing, cloudPull, mapHttpError } from '../src/services/cloudSync';
import { P, appt, stop, tech } from './fixtures';

// Sincronizzazione browser <-> cloud con fetch e orologio finti.

const D = '2026-11-13';
const KEY = 'chiave-di-prova';

// --- Orologio finto ---
class FakeClock implements SyncClock {
  t = 1_800_000_000_000;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => { this.timers = this.timers.filter(x => x.id !== h); };
  async advance(ms: number) {
    const target = this.t + ms;
    await flush();
    for (;;) {
      const next = this.timers.filter(x => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter(x => x.id !== next.id);
      this.t = next.at;
      next.fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

// --- Finto server: implementa il contratto in memoria ---
type Mode = 'ok' | 'offline' | 'http404' | 'conflict' | 'server' | 'store_missing';
interface Req { op: string; method: string; body: any; auth: string | null; url: string; keepalive?: boolean }

class FakeCloud {
  appointments: Appointment[] = [];
  config: CloudConfig | null = null;
  rev = 1;
  configRev = 1;
  key = KEY;
  mode: Mode = 'ok';
  holder = 'dev-a';
  requests: Req[] = [];
  gates: Partial<Record<string, Promise<void>>> = {};
  onTick: (() => void) | null = null;

  ops = (op: string) => this.requests.filter(r => r.op === op);

  snapshot(device: string) {
    return {
      rev: this.rev, configRev: this.configRev,
      appointments: JSON.parse(JSON.stringify(this.appointments)),
      config: this.config ? JSON.parse(JSON.stringify(this.config)) : null,
      lease: { holder: device === this.holder, deviceId: this.holder, until: '2030-01-01T00:00:00Z' },
    };
  }

  // Modifica fatta dal motore sul server (es. esito applicato)
  serverEdit(fn: (all: Appointment[]) => Appointment[]) { this.appointments = fn(this.appointments); this.rev += 1; }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, 'http://localhost');
    const op = url.searchParams.get('op') || '';
    const headers = (init.headers || {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ op, method: init.method || 'GET', body, auth: headers.Authorization || null, url: input, keepalive: init.keepalive });
    const gate = this.gates[op];
    if (gate) await gate;
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (this.mode === 'offline') throw new TypeError('Failed to fetch');
    if (this.mode === 'http404') return json(404, { error: 'Le funzioni /api girano solo su Vercel' });
    if (op === 'ping') return json(200, { protocol: 1, secretConfigured: true, storeConfigured: this.mode !== 'store_missing' });
    if (headers.Authorization !== `Bearer ${this.key}`) return json(401, { error: 'auth' });
    if (this.mode === 'store_missing') return json(503, { error: 'store_not_configured' });
    if (this.mode === 'conflict') return json(409, { error: 'conflict' });
    if (this.mode === 'server') return json(500, { error: 'server' });
    const device = url.searchParams.get('device') || body?.device || '';
    switch (op) {
      case 'status':
        return json(200, {
          protocol: 1, env: 'production', storeConfigured: true, retellConfigured: true,
          timezone: { zone: 'Europe/Rome', ok: true }, rev: this.rev, configRev: this.configRev,
          appointmentCount: this.appointments.length, lastTick: null, schedulerSeenAt: null, webhookSeenAt: null,
          webhookPath: '/api/cloud?op=webhook&token=x', serverTime: new Date().toISOString(),
        });
      case 'pull': {
        const rev = Number(url.searchParams.get('rev'));
        const configRev = Number(url.searchParams.get('configRev'));
        const snap = this.snapshot(device);
        if (rev === this.rev && configRev === this.configRev) {
          return json(200, { rev: this.rev, configRev: this.configRev, unchanged: true, lease: snap.lease });
        }
        return json(200, snap);
      }
      case 'push': {
        const changes = body.changes as AppointmentChange[];
        if (changes.length > 0) { this.appointments = applyAppointmentChanges(this.appointments, changes); this.rev += 1; }
        if (body.config && stableStringify(body.config) !== stableStringify(this.config)) { this.config = body.config; this.configRev += 1; }
        return json(200, this.snapshot(device));
      }
      case 'init':
        this.appointments = body.appointments; this.config = body.config; this.rev += 1; this.configRev += 1;
        return json(200, this.snapshot(device));
      case 'tick':
        this.onTick?.();
        return json(200, { summary: { outcomesApplied: 0, callsLaunched: 1, callsFailed: 0, recovered: 0, expired: 0, synced: 0, inFlight: 1, queued: 0, windowOpen: true, pilotEnabled: true, durationMs: 5 }, rev: this.rev, configRev: this.configRev });
    }
    return json(400, { error: 'bad_request' });
  };
}

// Apre un cancello: la richiesta resta "in volo" finché non si chiama release()
const hold = (cloud: FakeCloud, op: string) => {
  let release!: () => void;
  cloud.gates[op] = new Promise<void>(r => { release = r; });
  return () => { delete cloud.gates[op]; release(); };
};

// --- Host finto (come App: ref aggiornati in modo sincrono) ---
const makeConfig = (over: Partial<CloudConfig> = {}): CloudConfig => ({
  technicians: [tech()],
  autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true },
  fallback: { start: '08:30', end: '18:00', base: P.milano },
  ...over,
});

class FakeHost implements CloudSyncHost {
  list: Appointment[];
  config: CloudConfig;
  applied: CloudConfig[] = [];
  engine: CloudSyncEngine | null = null;
  constructor(list: Appointment[], config: CloudConfig) { this.list = list; this.config = config; }
  getAppointments = () => this.list;
  setAppointments = (l: Appointment[]) => { this.list = l; this.engine?.localChanged(); }; // come l'effetto di React
  getConfig = () => this.config;
  applyConfig = (c: CloudConfig) => { this.config = JSON.parse(JSON.stringify(c)); this.applied.push(c); this.engine?.localChanged(); return this.config; };
  edit(fn: (all: Appointment[]) => Appointment[]) { this.list = fn(this.list); this.engine?.localChanged(); }
  editConfig(fn: (c: CloudConfig) => CloudConfig) { this.config = fn(this.config); this.engine?.localChanged(); }
}

const seed = (): Appointment[] => [
  stop('a', D, '09:00', '09:20', P.milano, { status: 'proposed', phone: '+390200000001' }),
  stop('b', D, '10:00', '10:20', P.sesto, { status: 'proposed', phone: '+390200000002' }),
  appt({ id: 'c', technicianId: 'tech-1' }),
];

const engines: CloudSyncEngine[] = [];
afterEach(() => { engines.splice(0).forEach(e => e.destroy()); });

const setup = async (opts: { device?: string; local?: Appointment[]; timers?: boolean } = {}) => {
  const clock = new FakeClock();
  const cloud = new FakeCloud();
  cloud.appointments = seed();
  cloud.config = makeConfig();
  const host = new FakeHost(opts.local ?? JSON.parse(JSON.stringify(seed())), makeConfig());
  const engine = new CloudSyncEngine({
    key: KEY, deviceId: opts.device || 'dev-a', host, fetch: cloud.fetch, clock,
    timers: opts.timers === false ? { tick: false, status: false } : undefined,
  });
  host.engine = engine;
  engines.push(engine);
  engine.start();
  await clock.advance(0);
  return { clock, cloud, host, engine };
};

const byId = (all: Appointment[], id: string) => all.find(a => a.id === id)!;

describe('client HTTP del cloud', () => {
  it('chiave solo nell\'intestazione, mai nell\'URL; ping senza chiave', async () => {
    const cloud = new FakeCloud();
    const pull = await cloudPull({ key: KEY, fetch: cloud.fetch }, { rev: 3, configRev: 2, device: 'dev-a' });
    expect(pull.ok).toBe(true);
    const ping = await cloudPing({ fetch: cloud.fetch });
    expect(ping.ok && ping.data.storeConfigured).toBe(true);
    expect(cloud.requests[0].url).toBe('/api/cloud?op=pull&rev=3&configRev=2&device=dev-a');
    expect(cloud.requests[0].auth).toBe(`Bearer ${KEY}`);
    expect(cloud.requests[1].auth).toBeNull();
    expect(cloud.requests.every(r => !r.url.includes(KEY))).toBe(true);
  });

  it('mappatura degli errori in un tipo unico', () => {
    expect(mapHttpError(401, { error: 'auth' }).kind).toBe('auth');
    expect(mapHttpError(503, { error: 'secret_not_configured' })).toMatchObject({ kind: 'not_configured', detail: 'secret' });
    expect(mapHttpError(503, { error: 'store_not_configured' })).toMatchObject({ kind: 'not_configured', detail: 'store' });
    expect(mapHttpError(409, { error: 'conflict' }).kind).toBe('conflict');
    expect(mapHttpError(404, { error: 'x' }).kind).toBe('offline'); // vite dev
    expect(mapHttpError(500, { error: 'server' }).kind).toBe('server');
    expect(mapHttpError(400, { error: 'bad_request' }).kind).toBe('server');
  });

  it('rete assente e 404 = offline', async () => {
    const cloud = new FakeCloud();
    cloud.mode = 'offline';
    const r1 = await cloudPull({ key: KEY, fetch: cloud.fetch }, { rev: 1, configRev: 1, device: 'd' });
    cloud.mode = 'http404';
    const r2 = await cloudPull({ key: KEY, fetch: cloud.fetch }, { rev: 1, configRev: 1, device: 'd' });
    expect(!r1.ok && r1.error.kind).toBe('offline');
    expect(!r2.ok && r2.error.kind).toBe('offline');
  });
});

describe('CloudSyncEngine', () => {
  it('all\'avvio: pull completo e adozione dell\'elenco del server', async () => {
    const clock = new FakeClock();
    const cloud = new FakeCloud();
    cloud.appointments = seed().map(a => (a.id === 'b' ? { ...a, callStatus: 'called' as const } : a));
    cloud.config = makeConfig({ fallback: { start: '07:00', end: '17:00', base: P.monza } });
    const host = new FakeHost([appt({ id: 'locale' })], makeConfig());
    const engine = new CloudSyncEngine({ key: KEY, deviceId: 'dev-a', host, fetch: cloud.fetch, clock, timers: { tick: false, status: false } });
    host.engine = engine; engines.push(engine);
    engine.start();
    await clock.advance(0);
    expect(cloud.requests[0].url).toContain('rev=-1');
    // l'elenco locale vecchio non viene mandato al server: si adotta il cloud
    expect(host.list.map(a => a.id).sort()).toEqual(['a', 'b', 'c']);
    expect(byId(host.list, 'b').callStatus).toBe('called');
    expect(host.config.fallback.start).toBe('07:00');
    await clock.advance(1000);
    expect(cloud.ops('push')).toHaveLength(0);
    expect(engine.getState().phase).toBe('synced');
  });

  it('modifica locale -> dopo il debounce una push con le SOLE differenze', async () => {
    const { clock, cloud, host } = await setup({ timers: false });
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, status: 'confirmed' as const } : a)));
    await clock.advance(200);
    expect(cloud.ops('push')).toHaveLength(0); // debounce
    await clock.advance(300);
    const pushes = cloud.ops('push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body.changes).toEqual([{ op: 'patch', id: 'a', set: { status: 'confirmed' }, unset: [] }]);
    expect(pushes[0].body.config).toBeUndefined(); // configurazione invariata
    expect(byId(cloud.appointments, 'a').status).toBe('confirmed');
  });

  it('modifiche fatte MENTRE la push è in volo non si perdono e partono subito dopo', async () => {
    const { clock, cloud, host, engine } = await setup({ timers: false });
    const release = hold(cloud, 'push');
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, notes: 'prima' } : a)));
    await clock.advance(500);
    expect(cloud.ops('push')).toHaveLength(1);
    // nel frattempo: un'altra modifica locale e un esito applicato dal motore
    host.edit(all => all.map(a => (a.id === 'b' ? { ...a, notes: 'durante' } : a)));
    cloud.serverEdit(all => all.map(a => (a.id === 'c' ? { ...a, status: 'standby' as const } : a)));
    release();
    await clock.advance(0);
    expect(byId(host.list, 'b').notes).toBe('durante'); // non persa
    expect(byId(host.list, 'a').notes).toBe('prima');
    expect(byId(host.list, 'c').status).toBe('standby'); // arrivata dal server
    const pushes = cloud.ops('push');
    expect(pushes).toHaveLength(2); // la seconda subito dopo la prima
    expect(pushes[1].body.changes).toEqual([{ op: 'patch', id: 'b', set: { notes: 'durante' }, unset: [] }]);
    expect(byId(cloud.appointments, 'b').notes).toBe('durante');
    expect(engine.getState().phase).toBe('synced');
  });

  it('pull con novità del server fuse con modifiche locali non ancora inviate', async () => {
    const { clock, cloud, host } = await setup({ timers: false });
    // il motore applica un esito a "b"
    cloud.serverEdit(all => all.map(a => (a.id === 'b' ? { ...a, status: 'confirmed' as const, callStatus: 'called' as const } : a)));
    const release = hold(cloud, 'pull');
    await clock.advance(PULL_VISIBLE_MS);
    expect(cloud.ops('pull')).toHaveLength(2); // avvio + periodico (in volo)
    // durante il pull l'operatore modifica "a"
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, status: 'confirmed' as const } : a)));
    release();
    await clock.advance(0);
    expect(byId(host.list, 'b').status).toBe('confirmed'); // novità del server
    expect(byId(host.list, 'b').callStatus).toBe('called');
    expect(byId(host.list, 'a').status).toBe('confirmed'); // modifica locale conservata
    await clock.advance(500);
    const pushes = cloud.ops('push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body.changes).toEqual([{ op: 'patch', id: 'a', set: { status: 'confirmed' }, unset: [] }]);
    expect(byId(cloud.appointments, 'b').status).toBe('confirmed');
  });

  it('nessun pull mentre una push è in corso o in attesa del debounce', async () => {
    const { clock, cloud, host } = await setup({ timers: false });
    const pullsBefore = cloud.ops('pull').length;
    // modifiche continue: il debounce non scade, il pull periodico non parte
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, notes: 'x' } : a)));
    const release = hold(cloud, 'push');
    await clock.advance(500); // push in volo
    expect(cloud.ops('push')).toHaveLength(1);
    await clock.advance(PULL_VISIBLE_MS * 3);
    expect(cloud.ops('pull').length).toBe(pullsBefore); // nessun pull durante la push
    release();
    await clock.advance(0);
    await clock.advance(PULL_VISIBLE_MS);
    expect(cloud.ops('pull').length).toBeGreaterThan(pullsBefore);
  });

  it('errori: attese crescenti 2, 5, 15, 30 s tenendo le modifiche, poi ripresa', async () => {
    const { clock, cloud, host, engine } = await setup({ timers: false });
    cloud.mode = 'offline';
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, notes: 'offline' } : a)));
    await clock.advance(400); // debounce: la push parte e fallisce adesso
    expect(engine.getState().phase).toBe('offline');
    expect(engine.getState().pending).toBe(true);
    const count = () => cloud.requests.length;
    const at = count();
    await clock.advance(RETRY_DELAYS_MS[0] - 1);
    expect(count()).toBe(at);
    await clock.advance(1);
    expect(count()).toBe(at + 1);
    await clock.advance(RETRY_DELAYS_MS[1]);
    expect(count()).toBe(at + 2);
    await clock.advance(RETRY_DELAYS_MS[2]);
    expect(count()).toBe(at + 3);
    await clock.advance(RETRY_DELAYS_MS[3]);
    expect(count()).toBe(at + 4);
    await clock.advance(RETRY_DELAYS_MS[3]); // resta a 30 s
    expect(count()).toBe(at + 5);
    // altre modifiche durante il guasto: restano in attesa
    host.edit(all => all.map(a => (a.id === 'b' ? { ...a, notes: 'anche questa' } : a)));
    cloud.mode = 'ok';
    await clock.advance(30000);
    expect(byId(cloud.appointments, 'a').notes).toBe('offline');
    expect(byId(cloud.appointments, 'b').notes).toBe('anche questa');
    expect(engine.getState().phase).toBe('synced');
    expect(engine.getState().pending).toBe(false);
  });

  it('conflitto e errore del server: si riprova', async () => {
    const { clock, cloud, host } = await setup({ timers: false });
    cloud.mode = 'conflict';
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, notes: 'n' } : a)));
    await clock.advance(500);
    cloud.mode = 'server';
    await clock.advance(RETRY_DELAYS_MS[0]);
    cloud.mode = 'ok';
    await clock.advance(RETRY_DELAYS_MS[1]);
    expect(byId(cloud.appointments, 'a').notes).toBe('n');
  });

  it('chiave errata: ci si ferma (nessun altro tentativo) e i dati locali restano', async () => {
    const { clock, cloud, host, engine } = await setup({ timers: false });
    cloud.key = 'altra';
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, notes: 'locale' } : a)));
    await clock.advance(500);
    expect(engine.getState().phase).toBe('auth');
    const n = cloud.requests.length;
    await clock.advance(10 * 60 * 1000);
    expect(cloud.requests.length).toBe(n);
    expect(byId(host.list, 'a').notes).toBe('locale');
  });

  it('server senza database: fermo con "non configurato"', async () => {
    const clock = new FakeClock();
    const cloud = new FakeCloud();
    cloud.mode = 'store_missing';
    const host = new FakeHost(seed(), makeConfig());
    const engine = new CloudSyncEngine({ key: KEY, deviceId: 'dev-a', host, fetch: cloud.fetch, clock });
    engines.push(engine);
    engine.start();
    await clock.advance(0);
    expect(engine.getState().phase).toBe('not_configured');
    expect(engine.getState().error).toMatchObject({ kind: 'not_configured', detail: 'store' });
  });

  it('configurazione: inviata quando cambia qui, adottata dal server senza ping-pong', async () => {
    const { clock, cloud, host } = await setup({ timers: false });
    // cambio locale (es. pausa del pilota)
    host.editConfig(c => ({ ...c, autopilot: { ...c.autopilot, enabled: false } }));
    await clock.advance(500);
    expect(cloud.ops('push')).toHaveLength(1);
    expect(cloud.ops('push')[0].body.config.autopilot.enabled).toBe(false);
    expect(cloud.ops('push')[0].body.changes).toEqual([]);
    expect(cloud.config!.autopilot.enabled).toBe(false);
    // un altro dispositivo aggiunge un tecnico
    cloud.config = { ...cloud.config!, technicians: [...cloud.config!.technicians, tech({ id: 'tech-2', name: 'Tecnico Due' })] };
    cloud.configRev += 1;
    await clock.advance(PULL_VISIBLE_MS);
    expect(host.config.technicians.map(t => t.id)).toEqual(['tech-1', 'tech-2']);
    // adottarla non genera una push (nemmeno con le chiavi in un altro ordine)
    await clock.advance(PULL_VISIBLE_MS * 3);
    expect(cloud.ops('push')).toHaveLength(1);
  });

  it('configurazione cambiata qui E sul server: vince quella locale, una sola push', async () => {
    const { clock, cloud, host } = await setup({ timers: false });
    const release = hold(cloud, 'pull');
    cloud.config = { ...cloud.config!, autopilot: { ...cloud.config!.autopilot, maxAttempts: 5 } };
    cloud.configRev += 1;
    await clock.advance(PULL_VISIBLE_MS);
    host.editConfig(c => ({ ...c, fallback: { ...c.fallback, start: '07:30' } }));
    release();
    await clock.advance(500);
    expect(cloud.ops('push')).toHaveLength(1);
    expect(cloud.config!.fallback.start).toBe('07:30');
    await clock.advance(PULL_VISIBLE_MS * 2);
    expect(cloud.ops('push')).toHaveLength(1);
  });

  it('cloud senza configurazione: si invia quella di questo browser', async () => {
    const clock = new FakeClock();
    const cloud = new FakeCloud();
    cloud.appointments = seed();
    const host = new FakeHost(seed(), makeConfig());
    const engine = new CloudSyncEngine({ key: KEY, deviceId: 'dev-a', host, fetch: cloud.fetch, clock, timers: { tick: false, status: false } });
    host.engine = engine; engines.push(engine);
    engine.start();
    await clock.advance(0);
    expect(cloud.ops('push')).toHaveLength(1);
    expect(stableStringify(cloud.config)).toBe(stableStringify(makeConfig()));
  });

  it('turno degli automatismi: holder solo per il dispositivo che lo ha', async () => {
    const a = await setup({ device: 'dev-a', timers: false });
    expect(a.engine.getState().lease).toMatchObject({ holder: true, deviceId: 'dev-a' });
    const b = await setup({ device: 'dev-b', timers: false });
    expect(b.engine.getState().lease).toMatchObject({ holder: false, deviceId: 'dev-a' });
    // il turno passa: arriva col pull successivo (anche "unchanged")
    b.cloud.holder = 'dev-b';
    await b.clock.advance(PULL_VISIBLE_MS);
    expect(b.engine.getState().lease?.holder).toBe(true);
  });

  it('push che cambia la coda ("Approva e chiama") -> passaggio del motore dopo ~1 s, poi pull', async () => {
    const { clock, cloud, host } = await setup({ timers: false });
    cloud.onTick = () => cloud.serverEdit(all => all.map(a => (a.id === 'a' ? { ...a, autoCall: undefined, callStatus: 'called' as const, callId: 'call-1' } : a)));
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, autoCall: 'approved' as const } : a)));
    await clock.advance(500);
    expect(cloud.ops('push')).toHaveLength(1);
    expect(cloud.ops('tick')).toHaveLength(0);
    await clock.advance(1000);
    expect(cloud.ops('tick')).toHaveLength(1);
    expect(byId(host.list, 'a').callStatus).toBe('called'); // pull subito dopo il passaggio
    expect(byId(host.list, 'a').autoCall).toBeUndefined();
  });

  it('passaggio del motore ogni 30 s mentre la scheda è aperta', async () => {
    const { clock, cloud } = await setup();
    await clock.advance(TICK_INTERVAL_MS * 3);
    expect(cloud.ops('tick')).toHaveLength(3);
    expect(cloud.ops('status').length).toBeGreaterThanOrEqual(1);
  });

  it('chiusura della pagina: push immediata con keepalive', async () => {
    const { clock, cloud, host, engine } = await setup({ timers: false });
    host.edit(all => all.map(a => (a.id === 'a' ? { ...a, notes: 'ultima' } : a)));
    engine.flushNow({ keepalive: true, closing: true });
    await clock.advance(0);
    const pushes = cloud.ops('push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].keepalive).toBe(true);
    expect(pushes[0].body.changes).toEqual([{ op: 'patch', id: 'a', set: { notes: 'ultima' }, unset: [] }]);
  });
});

describe('attivazione del cloud', () => {
  const local = (appointments: Appointment[]) => ({ deviceId: 'dev-a', appointments, config: makeConfig() });

  it('planActivation nei tre casi', () => {
    expect(planActivation(0, 5)).toBe('upload');
    expect(planActivation(0, 0)).toBe('upload');
    expect(planActivation(7, 0)).toBe('adopt');
    expect(planActivation(7, 5)).toBe('choose');
  });

  it('cloud vuoto: si caricano le pratiche di questo browser (init)', async () => {
    const cloud = new FakeCloud();
    const out = await startActivation({ key: KEY, fetch: cloud.fetch }, local(seed()));
    expect(out).toMatchObject({ kind: 'done', plan: 'upload' });
    expect(cloud.ops('init')).toHaveLength(1);
    expect(cloud.ops('init')[0].body.replace).toBe(true);
    expect(cloud.appointments.map(a => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('browser vuoto: si adottano le pratiche del cloud (nessun init)', async () => {
    const cloud = new FakeCloud();
    cloud.appointments = seed();
    const out = await startActivation({ key: KEY, fetch: cloud.fetch }, local([]));
    expect(out).toMatchObject({ kind: 'done', plan: 'adopt', serverCount: 3 });
    expect(cloud.ops('init')).toHaveLength(0);
  });

  it('pratiche su entrambi i lati: decide l\'operatore, con i conteggi', async () => {
    const cloud = new FakeCloud();
    cloud.appointments = seed();
    const out = await startActivation({ key: KEY, fetch: cloud.fetch }, local([appt({ id: 'x' })]));
    expect(out).toEqual({ kind: 'choose', serverCount: 3, localCount: 1 });
    expect(cloud.ops('init')).toHaveLength(0);
    const replaced = await replaceCloudData({ key: KEY, fetch: cloud.fetch }, local([appt({ id: 'x' })]));
    expect(replaced.ok).toBe(true);
    expect(cloud.appointments.map(a => a.id)).toEqual(['x']);
  });

  it('chiave errata: errore chiaro, nessun init', async () => {
    const cloud = new FakeCloud();
    const out = await startActivation({ key: 'sbagliata', fetch: cloud.fetch }, local(seed()));
    expect(out).toMatchObject({ kind: 'error', error: { kind: 'auth' } });
    expect(cloud.ops('init')).toHaveLength(0);
  });

  it('scheduler visto di recente (passa ogni 15 minuti fra le 7 e le 21, ora italiana)', () => {
    // mercoledì 11/11/2026: l'Italia è a UTC+1
    const rome = (hhmm: string, day = '2026-11-11') => Date.parse(`${day}T${hhmm}:00+01:00`);
    const seen = (hhmm: string, day = '2026-11-11') => new Date(rome(hhmm, day)).toISOString();

    expect(schedulerFresh(null, rome('11:00'))).toBe(false);
    // di giorno: visto da poco sì, da oltre un'ora no
    expect(schedulerFresh(seen('10:35'), rome('11:00'))).toBe(true);
    expect(schedulerFresh(seen('10:02'), rome('11:00'))).toBe(true);  // un passaggio saltato è tollerato
    expect(schedulerFresh(seen('09:40'), rome('11:00'))).toBe(false);
    // di notte non passa: basta l'ultimo passaggio della sera
    expect(schedulerFresh(seen('21:50'), rome('23:30'))).toBe(true);
    expect(schedulerFresh(seen('21:50'), rome('03:00', '2026-11-12'))).toBe(true);
    expect(schedulerFresh(seen('21:50'), rome('07:10', '2026-11-12'))).toBe(true);  // il primo del mattino può tardare
    expect(schedulerFresh(seen('18:00'), rome('23:30'))).toBe(false);               // fermo dal pomeriggio
    // al mattino deve ripartire
    expect(schedulerFresh(seen('21:50'), rome('08:30', '2026-11-12'))).toBe(false);
    expect(schedulerFresh(seen('07:05', '2026-11-12'), rome('08:00', '2026-11-12'))).toBe(true);
    // d'estate (UTC+2) gli orari restano quelli italiani
    expect(schedulerFresh('2026-07-15T19:50:00Z', Date.parse('2026-07-15T22:30:00Z'))).toBe(true);  // 21:50 -> 00:30
    expect(schedulerFresh('2026-07-15T16:00:00Z', Date.parse('2026-07-15T22:30:00Z'))).toBe(false); // 18:00 -> 00:30
  });
});
