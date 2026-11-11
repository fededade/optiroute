import type { Appointment } from '../src/types';
import {
  CLOUD_API_PATH,
  CLOUD_PROTOCOL_VERSION,
  applyAppointmentChanges,
  type AppointmentChange,
  type AutomationLease,
  type CloudConfig,
  type CloudErrorCode,
  type CloudSnapshot,
  type CloudStatus,
  type TickSource,
} from '../src/services/cloudProtocol';
import { syncConfirmedToGestionale, type SyncResult } from '../src/services/syncService';
import { retellEnv } from '../api/retell-call';
import { headerValue, isAuthorized, isValidWebhookToken, webhookToken } from './auth';
import { ConflictError, StoreError, commit, storeFromEnv, type Store } from './store';
import { runTick, type EngineDeps } from './engine';
import { httpRetellClient, type RetellClient } from './retell';
import { timezoneStatus, type TimezoneStatus } from './tz';

// Endpoint HTTP del pilota in cloud (stile Vercel: req.method, req.query,
// req.headers, req.body; res.status().json(), res.setHeader, res.end).
//  /api/cloud?op=ping|status|pull|push|init|tick|webhook
//  /api/cloud-tick (scheduler di Vercel)
// Contratto dei messaggi: src/services/cloudProtocol.ts.

export interface ApiRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  end(...args: unknown[]): unknown;
}

type Env = Record<string, string | undefined>;

export interface HandlerDeps {
  env: Env;
  store: Store | null;
  now: () => Date;
  clock: () => number;
  retell: RetellClient;
  sync: ((appointments: Appointment[]) => Promise<SyncResult>) | null; // null = sync spenta
  sleep?: (ms: number) => Promise<void>;
  timezone: () => TimezoneStatus;
}

// Sync col gestionale VERO (Firestore). Spenta con OPTIROUTE_SYNC=off e,
// salvo OPTIROUTE_SYNC=on, con l'archivio in memoria (test e sviluppo
// locale): le prove non devono scrivere sul gestionale.
export const syncEnabled = (env: Env, store: Store | null): boolean => {
  if (env.OPTIROUTE_SYNC === 'off') return false;
  if (store?.kind === 'memory') return env.OPTIROUTE_SYNC === 'on';
  return true;
};

export const LEASE_TTL_MS = 90_000;

// Orologio sostituibile SOLO dallo strumento locale (scripts/dev-cloud-server.mjs):
// archivio in memoria e fuori da Vercel.
const defaultNow = (env: Env) => (): Date => {
  const hook = (globalThis as { __optirouteNow?: () => Date }).__optirouteNow;
  if (typeof hook === 'function' && env.OPTIROUTE_STORE === 'memory' && !env.VERCEL_ENV) return hook();
  return new Date();
};

export const defaultDeps = (overrides: Partial<HandlerDeps> = {}): HandlerDeps => {
  const env = overrides.env || process.env;
  const store = 'store' in overrides ? (overrides.store as Store | null) : storeFromEnv(env);
  return {
    env,
    store,
    now: overrides.now || defaultNow(env),
    clock: overrides.clock || Date.now,
    retell: overrides.retell || httpRetellClient,
    sync: 'sync' in overrides
      ? overrides.sync ?? null
      : syncEnabled(env, store)
        ? appointments => syncConfirmedToGestionale(appointments, env.VITE_SYNC_ENV)
        : null,
    sleep: overrides.sleep,
    timezone: overrides.timezone || timezoneStatus,
  };
};

const engineDeps = (d: HandlerDeps, store: Store): EngineDeps => ({
  store,
  now: d.now,
  retell: d.retell,
  sync: d.sync || undefined,
  clock: d.clock,
  sleep: d.sleep,
  timezone: d.timezone,
});

// --- Risposte ---

class HttpError extends Error {
  constructor(readonly status: number, readonly code: CloudErrorCode, message?: string) {
    super(message || code);
  }
}

const send = (res: ApiResponse, status: number, body: unknown) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
};

const fail = (res: ApiResponse, err: unknown, where: string) => {
  if (err instanceof HttpError) {
    send(res, err.status, err.message !== err.code ? { error: err.code, message: err.message } : { error: err.code });
    return;
  }
  if (err instanceof ConflictError) {
    send(res, 409, { error: 'conflict' });
    return;
  }
  const code = err instanceof StoreError ? `database/${err.code}` : err instanceof Error ? err.name : 'sconosciuto';
  console.error(`cloud: errore interno (${where}): ${code}`);
  send(res, 500, { error: 'server' });
};

// --- Lettura della richiesta ---

const queryValue = (req: ApiRequest, name: string): string => {
  const v = req.query?.[name];
  return (Array.isArray(v) ? v[0] : v) || '';
};

const parseBody = (req: ApiRequest): Record<string, unknown> => {
  let body = req.body;
  if (typeof body === 'string' || body instanceof Uint8Array) {
    const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
    if (!text.trim()) return {};
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_request', 'JSON non valido');
    }
  }
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_request', 'Corpo non valido');
  return body as Record<string, unknown>;
};

const DEVICE_RE = /^[\w.:-]{1,128}$/;

const deviceOf = (raw: unknown, required: boolean): string => {
  if (typeof raw === 'string' && DEVICE_RE.test(raw)) return raw;
  if (required || (raw !== undefined && raw !== '')) throw new HttpError(400, 'bad_request', 'device non valido');
  return '';
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isHHMM = (v: unknown) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);

const validConfig = (v: unknown): v is CloudConfig => {
  if (!isObject(v)) return false;
  if (!Array.isArray(v.technicians) || !v.technicians.every(t => isObject(t) && typeof t.id === 'string')) return false;
  if (!isObject(v.autopilot) || typeof v.autopilot.enabled !== 'boolean') return false;
  const f = v.fallback;
  if (!isObject(f) || !isHHMM(f.start) || !isHHMM(f.end)) return false;
  if (f.base !== null && f.base !== undefined && !(isObject(f.base) && typeof f.base.lat === 'number' && typeof f.base.lng === 'number')) {
    return false;
  }
  return true;
};

const validAppointment = (v: unknown): v is Appointment =>
  isObject(v) && typeof v.id === 'string' && !!v.id && isObject(v.coords) && typeof v.status === 'string';

const validChanges = (v: unknown): v is AppointmentChange[] => {
  if (!Array.isArray(v)) return false;
  return v.every(c => {
    if (!isObject(c) || typeof c.id !== 'string' || !c.id) return false;
    if (c.op === 'delete') return true;
    if (c.op === 'put') return validAppointment(c.value) && c.value.id === c.id;
    if (c.op === 'patch') {
      if (!isObject(c.set) || !Array.isArray(c.unset) || !c.unset.every(k => typeof k === 'string')) return false;
      if ('id' in c.set && c.set.id !== c.id) return false;
      return !c.unset.includes('id');
    }
    return false;
  });
};

// --- Turno degli automatismi ---

const leaseFor = async (store: Store, device: string, d: HandlerDeps): Promise<AutomationLease | null> => {
  const nowMs = d.clock();
  if (device) {
    const lease = await store.claimLease(device, nowMs, LEASE_TTL_MS);
    return { holder: lease.deviceId === device, deviceId: lease.deviceId, until: new Date(lease.until).toISOString() };
  }
  const lease = await store.readLease();
  if (!lease || lease.until <= nowMs) return null;
  return { holder: false, deviceId: lease.deviceId, until: new Date(lease.until).toISOString() };
};

const fullSnapshot = async (store: Store, lease: AutomationLease | null): Promise<CloudSnapshot> => {
  const { appointments, rev } = await store.readAppointments();
  const { config, configRev } = await store.readConfig();
  return { rev, configRev, appointments: appointments || [], config, lease };
};

// --- Controlli comuni ---

const requireSecret = (d: HandlerDeps): string => {
  const secret = d.env.CRON_SECRET || '';
  if (!secret) throw new HttpError(503, 'secret_not_configured');
  return secret;
};

const requireStore = (d: HandlerDeps): Store => {
  if (!d.store) throw new HttpError(503, 'store_not_configured');
  return d.store;
};

const authenticate = (req: ApiRequest, d: HandlerDeps): Store => {
  const secret = requireSecret(d);
  if (!isAuthorized(req.headers, secret)) throw new HttpError(401, 'auth');
  return requireStore(d);
};

// --- Operazioni ---

const OPS: Record<string, string> = {
  ping: 'GET',
  status: 'GET',
  pull: 'GET',
  push: 'POST',
  init: 'POST',
  tick: 'POST',
  webhook: 'POST',
};

const intParam = (raw: string): number => (/^\d+$/.test(raw) ? parseInt(raw, 10) : -1);

const runAndSummarize = async (d: HandlerDeps, store: Store, source: TickSource) =>
  runTick(engineDeps(d, store), source);

const handleOp = async (op: string, req: ApiRequest, res: ApiResponse, d: HandlerDeps): Promise<void> => {
  switch (op) {
    case 'ping': {
      send(res, 200, {
        protocol: CLOUD_PROTOCOL_VERSION,
        secretConfigured: !!d.env.CRON_SECRET,
        storeConfigured: !!d.store,
      });
      return;
    }

    case 'status': {
      const store = authenticate(req, d);
      const secret = d.env.CRON_SECRET as string;
      const [{ appointments, rev }, { configRev }, meta] = await Promise.all([
        store.readAppointments(),
        store.readConfig(),
        store.readMeta(),
      ]);
      const retell = retellEnv();
      const status: CloudStatus = {
        protocol: CLOUD_PROTOCOL_VERSION,
        env: d.env.VERCEL_ENV || 'development',
        storeConfigured: true,
        retellConfigured: !!retell.apiKey && !!retell.fromNumber,
        timezone: d.timezone(),
        rev,
        configRev,
        appointmentCount: appointments ? appointments.length : 0,
        lastTick: meta.lastTick,
        schedulerSeenAt: meta.schedulerSeenAt,
        webhookSeenAt: meta.webhookSeenAt,
        webhookPath: `${CLOUD_API_PATH}?op=webhook&token=${webhookToken(secret)}`,
        serverTime: d.now().toISOString(),
      };
      send(res, 200, status);
      return;
    }

    case 'pull': {
      const store = authenticate(req, d);
      const device = deviceOf(queryValue(req, 'device') || undefined, false);
      const lease = await leaseFor(store, device, d);
      const revs = await store.revs();
      const rev = intParam(queryValue(req, 'rev'));
      const configRev = intParam(queryValue(req, 'configRev'));
      if (rev === revs.rev && configRev === revs.configRev) {
        const snapshot: CloudSnapshot = { rev: revs.rev, configRev: revs.configRev, unchanged: true, lease };
        send(res, 200, snapshot);
        return;
      }
      send(res, 200, await fullSnapshot(store, lease));
      return;
    }

    case 'push': {
      const store = authenticate(req, d);
      const body = parseBody(req);
      const device = deviceOf(body.device, true);
      const changes = body.changes === undefined ? [] : body.changes;
      if (!validChanges(changes)) throw new HttpError(400, 'bad_request', 'changes non valido');
      if (body.config !== undefined && !validConfig(body.config)) throw new HttpError(400, 'bad_request', 'config non valida');
      if (changes.length > 0) {
        // Applicate allo stato ATTUALE (con riapplicazione se nel frattempo è cambiato)
        await commit(store, all => applyAppointmentChanges(all, changes));
      }
      if (body.config !== undefined) await store.writeConfig(body.config as CloudConfig);
      const lease = await leaseFor(store, device, d);
      send(res, 200, await fullSnapshot(store, lease));
      return;
    }

    case 'init': {
      const store = authenticate(req, d);
      const body = parseBody(req);
      const device = deviceOf(body.device, true);
      if (body.replace !== true) throw new HttpError(400, 'bad_request', 'replace: true obbligatorio');
      if (!Array.isArray(body.appointments) || !body.appointments.every(validAppointment)) {
        throw new HttpError(400, 'bad_request', 'appointments non valido');
      }
      if (!validConfig(body.config)) throw new HttpError(400, 'bad_request', 'config non valida');
      await store.replaceAppointments(body.appointments);
      await store.writeConfig(body.config);
      const lease = await leaseFor(store, device, d);
      send(res, 200, await fullSnapshot(store, lease));
      return;
    }

    case 'tick': {
      const store = authenticate(req, d);
      const body = parseBody(req);
      const device = deviceOf(body.device, true);
      const lease = await leaseFor(store, device, d);
      const summary = await runAndSummarize(d, store, 'browser');
      const { rev, configRev } = await store.revs();
      send(res, 200, { summary, rev, configRev, lease });
      return;
    }

    case 'webhook': {
      const secret = requireSecret(d);
      if (!isValidWebhookToken(queryValue(req, 'token'), secret)) throw new HttpError(401, 'auth');
      const store = requireStore(d);
      // Il contenuto del webhook non è affidabile: serve solo da sveglia
      let event = '';
      try {
        const body = parseBody(req);
        event = typeof body.event === 'string' ? body.event : '';
      } catch {
        event = '';
      }
      await store.updateMeta({ webhookSeenAt: d.now().toISOString() });
      if (event === 'call_started') {
        send(res, 200, { ok: true, ignored: true });
        return;
      }
      await runAndSummarize(d, store, 'webhook');
      send(res, 200, { ok: true });
      return;
    }
  }
};

export const createCloudHandler = (overrides: Partial<HandlerDeps> = {}) =>
  async function cloudHandler(req: ApiRequest, res: ApiResponse): Promise<void> {
    const op = queryValue(req, 'op');
    try {
      const method = OPS[op];
      if (!method) throw new HttpError(400, 'bad_request');
      if ((req.method || 'GET').toUpperCase() !== method) throw new HttpError(405, 'bad_request', 'Metodo non ammesso');
      await handleOp(op, req, res, defaultDeps(overrides));
    } catch (err) {
      fail(res, err, op || '?');
    }
  };

// /api/cloud-tick: passaggio completo dello scheduler di Vercel (GET o POST,
// Authorization: Bearer <CRON_SECRET> inviata da Vercel stessa)
export const createTickHandler = (overrides: Partial<HandlerDeps> = {}) =>
  async function cloudTickHandler(req: ApiRequest, res: ApiResponse): Promise<void> {
    try {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'bad_request', 'Metodo non ammesso');
      const d = defaultDeps(overrides);
      const store = authenticate(req, d);
      // schedulerSeenAt conferma che lo scheduler di Vercel sta davvero
      // chiamando: un passaggio avviato a mano (curl, prove) non lo aggiorna
      if (/vercel-cron/i.test(headerValue(req.headers, 'user-agent'))) {
        await store.updateMeta({ schedulerSeenAt: d.now().toISOString() });
      }
      const summary = await runAndSummarize(d, store, 'scheduler');
      send(res, 200, { summary });
    } catch (err) {
      fail(res, err, 'cloud-tick');
    }
  };
