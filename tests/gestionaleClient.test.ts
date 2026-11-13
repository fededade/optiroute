import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Appointment } from '../src/types';
import { applyAppointmentChanges, type AppointmentChange, type CloudConfig } from '../src/services/cloudProtocol';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../src/services/autopilotService';
import { CloudSyncEngine, prepareEmbeddedCloud, type CloudSyncHost, type SyncClock } from '../src/services/cloudSyncCore';
import { cloudStatus } from '../src/services/cloudSync';
import { createSafeStorage } from '../src/services/safeStorage';
import {
  GESTIONALE_CHANNEL,
  GestionaleHost,
  GestionaleHostError,
  candidateParentOrigin,
  hello,
  isFramed,
  requestIdToken,
  type MessageEventLike,
  type WindowLike,
} from '../src/services/gestionaleHost';
import { GestionaleSession, GestionaleSessionError, SESSION_REFRESH_MARGIN_MS, checkParent } from '../src/services/gestionaleSession';
import { fetchBridgeSnapshotViaParent } from '../src/services/bridgeService';
import { P, appt, stop, tech } from './fixtures';

// Lato browser del collegamento con il gestionale: memoria del browser
// bloccata, messaggi con la pagina del gestionale, biglietto di sessione e
// sincronizzazione che non riparte quando il biglietto si rinnova.

const ORIGIN = 'https://gestionale.example';

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
  pending = () => this.timers.length;
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

const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// --- Memoria del browser ---

describe('safeStorage', () => {
  it('memoria bloccata (l\'accesso stesso lancia un errore): si usa una memoria temporanea', () => {
    const s = createSafeStorage(() => { throw new DOMException('Accesso negato', 'SecurityError'); });
    expect(s.mode()).toBe('memory');
    expect(s.getItem('x')).toBeNull();
    s.setItem('x', '1');
    expect(s.getItem('x')).toBe('1');
    s.removeItem('x');
    expect(s.getItem('x')).toBeNull();
  });

  it('memoria che lancia alla lettura: temporanea', () => {
    const s = createSafeStorage(() => ({
      getItem: () => { throw new Error('bloccata'); },
      setItem: () => { throw new Error('bloccata'); },
      removeItem: () => { throw new Error('bloccata'); },
    }));
    expect(s.mode()).toBe('memory');
    s.setItem('k', 'v');
    expect(s.getItem('k')).toBe('v');
  });

  it('memoria funzionante: stesse chiavi di prima, errori di scrittura come prima', () => {
    const map = new Map<string, string>();
    let full = false;
    const native = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { if (full) throw new Error('QuotaExceededError'); map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    };
    const s = createSafeStorage(() => native);
    expect(s.mode()).toBe('native');
    s.setItem('optiroute_appointments_v1', '[]');
    expect(map.get('optiroute_appointments_v1')).toBe('[]');
    full = true;
    expect(() => s.setItem('optiroute_appointments_v1', '[1]')).toThrow(); // i chiamanti già lo gestiscono
    s.removeItem('optiroute_appointments_v1');
    expect(map.size).toBe(0);
  });

  it('senza memoria del browser (server, test)', () => {
    expect(createSafeStorage(() => undefined).mode()).toBe('absent');
  });

  it('i servizi dell\'app si caricano anche con localStorage che lancia', async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Accesso negato', 'SecurityError'); } });
    try {
      vi.resetModules();
      const storage = await import('../src/services/storageService');
      const techs = await import('../src/services/technicianService');
      const cloud = await import('../src/services/cloudSettings');
      expect(storage.loadAppointments()).toEqual([]);
      storage.saveAppointments([appt({ id: 'z' })]);
      expect(storage.loadAppointments().map(a => a.id)).toEqual(['z']);
      expect(techs.loadTechnicians().length).toBeGreaterThan(0);
      const settings = cloud.loadCloudSettings();
      expect(settings.enabled).toBe(false);
      expect(settings.deviceId).toMatch(/^dev-/);
      expect(cloud.loadCloudSettings().deviceId).toBe(settings.deviceId);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      vi.resetModules();
    }
  });
});

// --- Messaggi con la pagina del gestionale ---

class FakeWindow implements WindowLike {
  listeners: ((e: MessageEventLike) => void)[] = [];
  sent: { message: any; targetOrigin: string }[] = [];
  parent: { postMessage: (m: unknown, o: string) => void };
  location: WindowLike['location'];
  document: { referrer: string };
  constructor(readonly clock: FakeClock, opts: { ancestors?: string[]; referrer?: string } = {}) {
    this.parent = { postMessage: (message, targetOrigin) => { this.sent.push({ message, targetOrigin }); } };
    this.location = { origin: 'https://optiroute.example', ancestorOrigins: opts.ancestors ? Object.assign([...opts.ancestors], { length: opts.ancestors.length }) : undefined };
    this.document = { referrer: opts.referrer || '' };
  }
  addEventListener = (_: 'message', l: (e: MessageEventLike) => void) => { this.listeners.push(l); };
  removeEventListener = (_: 'message', l: (e: MessageEventLike) => void) => { this.listeners = this.listeners.filter(x => x !== l); };
  setTimeout = (fn: () => void, ms: number) => this.clock.setTimeout(fn, ms);
  clearTimeout = (h: unknown) => this.clock.clearTimeout(h);
  deliver(data: unknown, origin = ORIGIN, source: unknown = this.parent) {
    for (const l of [...this.listeners]) l({ data, origin, source });
  }
  reply(index: number, result: unknown, over: Record<string, unknown> = {}) {
    const id = this.sent[index].message.id;
    this.deliver({ channel: GESTIONALE_CHANNEL, v: 1, id, ok: true, result, ...over });
  }
}

describe('rilevamento della pagina che contiene l\'app', () => {
  it('isFramed', () => {
    const self: { parent: unknown } = { parent: null };
    self.parent = self;
    expect(isFramed(self)).toBe(false);
    expect(isFramed({ parent: {} })).toBe(true);
  });
  it('origine candidata: ancestorOrigins, poi referrer', () => {
    const clock = new FakeClock();
    expect(candidateParentOrigin(new FakeWindow(clock, { ancestors: [`${ORIGIN}`], referrer: 'https://altro.example/x' }))).toBe(ORIGIN);
    expect(candidateParentOrigin(new FakeWindow(clock, { referrer: `${ORIGIN}/optiroute.html?x=1` }))).toBe(ORIGIN);
    expect(candidateParentOrigin(new FakeWindow(clock, {}))).toBe('');
    expect(candidateParentOrigin(new FakeWindow(clock, { referrer: 'about:blank' }))).toBe('');
  });
});

describe('GestionaleHost: richieste, risposte, eventi', () => {
  const setup = () => {
    const clock = new FakeClock();
    const win = new FakeWindow(clock);
    let n = 0;
    const host = new GestionaleHost({ win, parentOrigin: ORIGIN, timeoutMs: 1000, newId: () => `id-${++n}` });
    return { clock, win, host };
  };

  it('scrive solo al gestionale, con la sua origine, nel formato del contratto', async () => {
    const { win, host } = setup();
    const p = hello(host);
    expect(win.sent).toEqual([{
      message: { channel: GESTIONALE_CHANNEL, v: 1, id: 'id-1', method: 'hello', params: { app: 'optiroute', version: 1 } },
      targetOrigin: ORIGIN,
    }]);
    win.reply(0, { user: { name: 'Anna', email: 'anna@example.com', role: 'Amministratore' }, environment: 'collaudo' });
    expect(await p).toEqual({ user: { name: 'Anna', email: 'anna@example.com', role: 'Amministratore' }, environment: 'collaudo' });
  });

  it('ignora messaggi da altre origini, da altre finestre, di altri canali o con id sconosciuti', async () => {
    const { clock, win, host } = setup();
    let settled = false;
    const p = host.request('token').then(r => { settled = true; return r; });
    const id = win.sent[0].message.id;
    const good = { channel: GESTIONALE_CHANNEL, v: 1, id, ok: true, result: { idToken: 'buono' } };
    win.deliver({ ...good, result: { idToken: 'falso' } }, 'https://altro.example');
    win.deliver({ ...good, result: { idToken: 'falso' } }, ORIGIN, { postMessage() {} });
    win.deliver({ ...good, channel: 'altro', result: { idToken: 'falso' } });
    win.deliver({ ...good, v: 2, result: { idToken: 'falso' } });
    win.deliver({ ...good, id: 'sconosciuto', result: { idToken: 'falso' } });
    win.deliver('testo');
    win.deliver(null);
    await clock.advance(0);
    expect(settled).toBe(false);
    win.deliver(good);
    expect(await p).toEqual({ idToken: 'buono' });
  });

  it('errore del gestionale: codice e messaggio', async () => {
    const { win, host } = setup();
    const p = host.request('metodo-strano');
    win.deliver({ channel: GESTIONALE_CHANNEL, v: 1, id: win.sent[0].message.id, ok: false, error: { code: 'unknown_method', message: 'Metodo sconosciuto' } });
    const err = await p.then(() => null, e => e);
    expect(err).toBeInstanceOf(GestionaleHostError);
    expect(err.code).toBe('unknown_method');
    expect(err.message).toBe('Metodo sconosciuto');
  });

  it('nessuna risposta: timeout; una risposta in ritardo viene ignorata', async () => {
    const { clock, win, host } = setup();
    const p = host.request('bridge.snapshot');
    const caught = p.then(() => null, e => e);
    await clock.advance(1000);
    expect((await caught).code).toBe('timeout');
    expect(() => win.reply(0, { status: 'ok' })).not.toThrow();
  });

  it('richiesta del biglietto di Firebase', async () => {
    const { win, host } = setup();
    const p = requestIdToken(host);
    win.reply(0, { idToken: 'eyJ.x.y' });
    expect(await p).toBe('eyJ.x.y');
    const empty = requestIdToken(host);
    win.reply(1, {});
    await expect(empty).rejects.toBeInstanceOf(GestionaleHostError);
  });

  it('eventi: solo dal gestionale', async () => {
    const { win, host } = setup();
    const seen: unknown[] = [];
    const off = host.on('bridge.updated', d => seen.push(d));
    win.deliver({ channel: GESTIONALE_CHANNEL, v: 1, event: 'bridge.updated', data: {} });
    win.deliver({ channel: GESTIONALE_CHANNEL, v: 1, event: 'bridge.updated', data: {} }, 'https://altro.example');
    win.deliver({ channel: GESTIONALE_CHANNEL, v: 1, event: 'altro', data: {} });
    expect(seen).toEqual([{}]);
    off();
    win.deliver({ channel: GESTIONALE_CHANNEL, v: 1, event: 'bridge.updated', data: {} });
    expect(seen.length).toBe(1);
  });

  it('pratiche del bridge tramite il gestionale', async () => {
    const snapshot = { bridge: 'optiroute-bridge', version: 1, generatedAt: 'x', portals: [], pratiche: [{ codice: 'ISP-1', intestatario: 'Rossi' }] };
    const ask = (result: Record<string, unknown>) => fetchBridgeSnapshotViaParent(async () => result);
    const ok = await ask({ status: 'ok', snapshot });
    expect(ok.ok && ok.snapshot.pratiche[0].codice).toBe('ISP-1');
    expect(await ask({ status: 'offline', message: 'Bridge spento' })).toEqual({ ok: false, error: 'offline', message: 'Bridge spento' });
    expect((await ask({ status: 'inactive' })).ok === false && (await ask({ status: 'inactive' }) as { error: string }).error).toBe('inactive');
    expect((await ask({ status: 'token' }) as { error: string }).error).toBe('token');
    expect((await ask({ status: 'ok', snapshot: { bridge: 'altro' } }) as { error: string }).error).toBe('invalid');
    const timeout = await fetchBridgeSnapshotViaParent(async () => { throw new GestionaleHostError('timeout', 'x'); });
    expect(timeout).toMatchObject({ ok: false, error: 'offline' });
  });
});

// --- Verifica della pagina e biglietto di sessione ---

describe('verifica della pagina con il server', () => {
  it('ammessa, non ammessa, collegamento spento, rete', async () => {
    const urls: string[] = [];
    const fetchWith = (gestionale: unknown) => async (url: string) => { urls.push(url); return json(200, { protocol: 1, secretConfigured: true, storeConfigured: true, gestionale }); };
    expect(await checkParent(ORIGIN, { fetch: fetchWith({ enabled: true, parentAllowed: true }) })).toEqual({ kind: 'allowed' });
    expect(urls[0]).toBe(`/api/cloud?op=ping&parent=${encodeURIComponent(ORIGIN)}`);
    expect(await checkParent(ORIGIN, { fetch: fetchWith({ enabled: true, parentAllowed: false }) })).toEqual({ kind: 'not_allowed' });
    expect(await checkParent(ORIGIN, { fetch: fetchWith({ enabled: false, parentAllowed: false }) })).toEqual({ kind: 'disabled' });
    expect(await checkParent(ORIGIN, { fetch: fetchWith(undefined) })).toEqual({ kind: 'disabled' });
    expect((await checkParent(ORIGIN, { fetch: async () => { throw new TypeError('rete'); } })).kind).toBe('network');
    expect(await checkParent('', { fetch: fetchWith({ enabled: true, parentAllowed: true }) })).toEqual({ kind: 'not_allowed' });
  });
});

// Server finto: biglietti di sessione numerati; solo l'ULTIMO è valido
class FakeServer {
  seq = 0;
  valid = '';
  sessions = 0;
  mode: 'ok' | 'forbidden' | 'not_configured' | 'auth' | 'down' = 'ok';
  ttlMs = 60 * 60 * 1000;
  gate: Promise<void> | null = null;
  constructor(readonly clock: FakeClock) {}
  sessionFetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    if (url.searchParams.get('op') !== 'session') throw new Error(`inatteso ${input}`);
    this.sessions += 1;
    if (this.gate) await this.gate;
    const auth = (init.headers as Record<string, string>).Authorization;
    if (!/^Bearer id-token-\d+$/.test(auth)) return json(401, { error: 'auth' });
    if (this.mode === 'down') throw new TypeError('Failed to fetch');
    if (this.mode === 'forbidden') return json(403, { error: 'forbidden' });
    if (this.mode === 'not_configured') return json(503, { error: 'gestionale_not_configured' });
    if (this.mode === 'auth') return json(401, { error: 'auth' });
    this.seq += 1;
    this.valid = `ors1.sessione-${this.seq}`;
    return json(200, { token: this.valid, expiresAt: new Date(this.clock.now() + this.ttlMs).toISOString(), user: { name: 'Anna Admin', role: 'Amministratore' } });
  };
}

const sessionSetup = () => {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  let ids = 0;
  const getIdToken = vi.fn(async () => `id-token-${++ids}`);
  const session = new GestionaleSession({ getIdToken, fetch: server.sessionFetch, clock });
  return { clock, server, session, getIdToken };
};

describe('GestionaleSession', () => {
  const sessions: GestionaleSession[] = [];
  afterEach(() => { sessions.splice(0).forEach(s => s.destroy()); });

  it('primo accesso: biglietto del gestionale -> biglietto di sessione (solo in memoria)', async () => {
    const t = sessionSetup(); sessions.push(t.session);
    expect(await t.session.start()).toEqual({ name: 'Anna Admin', role: 'Amministratore' });
    expect(t.session.credential.get()).toBe('ors1.sessione-1');
    expect(t.getIdToken).toHaveBeenCalledTimes(1);
  });

  it('si rinnova 5 minuti prima della scadenza, con un biglietto del gestionale fresco', async () => {
    const t = sessionSetup(); sessions.push(t.session);
    await t.session.start();
    await t.clock.advance(t.server.ttlMs - SESSION_REFRESH_MARGIN_MS - 1000);
    expect(t.server.sessions).toBe(1);
    await t.clock.advance(1000);
    expect(t.server.sessions).toBe(2);
    expect(t.getIdToken).toHaveBeenCalledTimes(2);
    expect(t.session.credential.get()).toBe('ors1.sessione-2');
    // e così via
    await t.clock.advance(t.server.ttlMs - SESSION_REFRESH_MARGIN_MS);
    expect(t.session.credential.get()).toBe('ors1.sessione-3');
  });

  it('un rinnovo alla volta', async () => {
    const t = sessionSetup(); sessions.push(t.session);
    await t.session.start();
    let release!: () => void;
    t.server.gate = new Promise(r => { release = r; });
    const a = t.session.refresh();
    const b = t.session.refresh();
    const c = t.session.credential.refresh!();
    release();
    t.server.gate = null;
    expect(await Promise.all([a, b, c])).toEqual(['ok', 'ok', 'ok']);
    expect(t.server.sessions).toBe(2);
  });

  it('errori del primo accesso', async () => {
    for (const [mode, kind] of [['forbidden', 'forbidden'], ['not_configured', 'not_configured'], ['auth', 'auth'], ['down', 'network']] as const) {
      const t = sessionSetup(); sessions.push(t.session);
      t.server.mode = mode;
      const err = await t.session.start().then(() => null, e => e);
      expect(err, mode).toBeInstanceOf(GestionaleSessionError);
      expect(err.kind, mode).toBe(kind);
    }
    // il gestionale non risponde
    const clock = new FakeClock();
    const s = new GestionaleSession({ getIdToken: async () => { throw new GestionaleHostError('timeout', 'x'); }, fetch: async () => json(200, {}), clock });
    sessions.push(s);
    expect((await s.start().then(() => null, e => e)).kind).toBe('network');
  });

  it('rinnovo non riuscito: per la rete si riprova più tardi; accesso negato -> avviso', async () => {
    const t = sessionSetup(); sessions.push(t.session);
    await t.session.start();
    const lost: string[] = [];
    t.session.onLost(e => lost.push(e.kind));
    t.server.mode = 'down';
    expect(await t.session.refresh()).toBe('unavailable');
    expect(t.session.credential.get()).toBe('ors1.sessione-1'); // si tiene quello vecchio
    t.server.mode = 'ok';
    await t.clock.advance(30_000);
    expect(t.session.credential.get()).toBe('ors1.sessione-2');
    t.server.mode = 'forbidden';
    expect(await t.session.refresh()).toBe('denied');
    expect(lost).toEqual(['forbidden']);
  });
});

// --- Sincronizzazione con il biglietto di sessione ---

const config = (): CloudConfig => ({ technicians: [tech()], autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS }, fallback: { start: '08:30', end: '18:00', base: P.milano } });

class FakeCloud extends FakeServer {
  appointments: Appointment[] = [];
  cfg: CloudConfig | null = null;
  rev = 1;
  requests: { op: string; auth: string; url: string }[] = [];
  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, 'http://localhost');
    const op = url.searchParams.get('op') || '';
    if (op === 'session') return this.sessionFetch(input, init);
    const auth = ((init.headers || {}) as Record<string, string>).Authorization || '';
    this.requests.push({ op, auth, url: input });
    if (auth !== `Bearer ${this.valid}` || !this.valid) return json(401, { error: 'auth' });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const snap = () => ({ rev: this.rev, configRev: 1, appointments: this.appointments, config: this.cfg, lease: { holder: true, deviceId: 'dev-a', until: '2030-01-01T00:00:00Z' } });
    switch (op) {
      case 'status': return json(200, { protocol: 1, appointmentCount: this.appointments.length, rev: this.rev, configRev: 1, lastTick: null });
      case 'pull': return json(200, snap());
      case 'push': {
        const changes = body.changes as AppointmentChange[];
        if (changes.length) { this.appointments = applyAppointmentChanges(this.appointments, changes); this.rev += 1; }
        if (body.config) this.cfg = body.config;
        return json(200, snap());
      }
      case 'init': this.appointments = body.appointments; this.cfg = body.config; this.rev += 1; return json(200, snap());
    }
    return json(400, { error: 'bad_request' });
  };
}

class Host implements CloudSyncHost {
  engine: CloudSyncEngine | null = null;
  constructor(public list: Appointment[], public cfg: CloudConfig) {}
  getAppointments = () => this.list;
  setAppointments = (l: Appointment[]) => { this.list = l; this.engine?.localChanged(); };
  getConfig = () => this.cfg;
  applyConfig = (c: CloudConfig) => { this.cfg = c; return c; };
  edit(fn: (l: Appointment[]) => Appointment[]) { this.list = fn(this.list); this.engine?.localChanged(); }
}

describe('cloud con l\'accesso dal gestionale', () => {
  const D = '2026-11-13';

  it('cloud vuoto: lo inizializza questo browser; con dati: vincono quelli del cloud', async () => {
    const clock = new FakeClock();
    const cloud = new FakeCloud(clock);
    const session = new GestionaleSession({ getIdToken: async () => 'id-token-1', fetch: cloud.fetch, clock });
    await session.start();
    const local = [appt({ id: 'locale' })];
    expect(await prepareEmbeddedCloud({ key: '', credential: session.credential, fetch: cloud.fetch }, { deviceId: 'dev-a', appointments: local, config: config() }))
      .toEqual({ ok: true, plan: 'upload' });
    expect(cloud.appointments.map(a => a.id)).toEqual(['locale']);
    expect(await prepareEmbeddedCloud({ key: '', credential: session.credential, fetch: cloud.fetch }, { deviceId: 'dev-a', appointments: [appt({ id: 'altro' })], config: config() }))
      .toEqual({ ok: true, plan: 'adopt' });
    expect(cloud.appointments.map(a => a.id)).toEqual(['locale']);
    session.destroy();
  });

  it('biglietto rinnovato (anche dopo un 401): la sincronizzazione NON riparte e non perde le modifiche', async () => {
    const clock = new FakeClock();
    const cloud = new FakeCloud(clock);
    cloud.appointments = [stop('a', D, '09:00', '09:20', P.milano), appt({ id: 'b' })];
    cloud.cfg = config();
    let ids = 0;
    const session = new GestionaleSession({ getIdToken: async () => `id-token-${++ids}`, fetch: cloud.fetch, clock });
    await session.start();
    const host = new Host([appt({ id: 'solo-qui' })], config());
    const engine = new CloudSyncEngine({ key: '', credential: session.credential, deviceId: 'dev-a', host, fetch: cloud.fetch, clock, timers: { tick: false, status: false } });
    host.engine = engine;
    engine.start();
    await clock.advance(0);
    // primo scaricamento: valgono i dati del cloud
    expect(host.list.map(a => a.id)).toEqual(['a', 'b']);

    // Il server non accetta più il biglietto (es. chiave cambiata): una
    // modifica locale riceve 401, il biglietto si rinnova e la stessa
    // richiesta riparte una volta
    cloud.valid = 'ors1.vecchio-non-valido';
    host.edit(l => l.map(a => (a.id === 'b' ? { ...a, notes: 'nota locale' } : a)));
    await clock.advance(1000);
    expect(cloud.appointments.find(a => a.id === 'b')?.notes).toBe('nota locale');
    expect(cloud.requests.filter(r => r.op === 'push').map(r => r.auth)).toEqual(['Bearer ors1.sessione-1', 'Bearer ors1.sessione-2']);
    expect(engine.getState().phase).toBe('synced');
    expect(engine.getState().pending).toBe(false);

    // rinnovo programmato: nessuna richiesta fallita, nessun nuovo scaricamento completo
    const fullPulls = () => cloud.requests.filter(r => r.op === 'pull' && r.url.includes('rev=-1')).length;
    const before = fullPulls();
    await clock.advance(60 * 60 * 1000);
    expect(session.credential.get()).toBe('ors1.sessione-3');
    host.edit(l => [...l, appt({ id: 'nuova' })]);
    await clock.advance(1000);
    expect(cloud.appointments.map(a => a.id)).toContain('nuova');
    expect(cloud.requests.filter(r => r.auth === 'Bearer ors1.sessione-3').length).toBeGreaterThan(0);
    expect(engine.getState().error).toBeNull();
    expect(fullPulls()).toBe(1); // un solo scaricamento completo: il motore non è mai ripartito
    void before;
    engine.destroy();
    session.destroy();
  });

  it('rinnovo impossibile per la rete: il motore si ferma solo temporaneamente (non "chiave errata")', async () => {
    const clock = new FakeClock();
    const cloud = new FakeCloud(clock);
    const session = new GestionaleSession({ getIdToken: async () => 'id-token-1', fetch: cloud.fetch, clock });
    await session.start();
    cloud.valid = 'altro';
    cloud.mode = 'down';
    const r = await cloudStatus({ key: '', credential: session.credential, fetch: cloud.fetch });
    expect(r.ok === false && r.error.kind).toBe('offline');
    session.destroy();
  });
});
