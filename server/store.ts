import { gunzipSync, gzipSync } from 'node:zlib';
import type { Appointment } from '../src/types';
import type { CloudConfig, TickSource, TickSummary } from '../src/services/cloudProtocol';

// Archivio del pilota in cloud: elenco pratiche, configurazione, metadati,
// lock del passaggio e turno degli automatismi. Un'unica implementazione
// (RedisStore) su un client Redis minimo; due client:
//  - UpstashStore: Upstash Redis via REST (integrazione Marketplace Vercel)
//  - MemoryStore:  emulatore in memoria (test e sviluppo locale)
// Le chiavi hanno un prefisso per ambiente (optiroute:<VERCEL_ENV>:...),
// così un'anteprima non tocca mai i dati di produzione.

// --- Errori ---

export type StoreErrorCode = 'network' | 'timeout' | 'auth' | 'http' | 'redis' | 'data';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// Troppe modifiche concorrenti: il compare-and-set non è riuscito
export class ConflictError extends Error {
  constructor() {
    super('conflict');
    this.name = 'ConflictError';
  }
}

// --- Client Redis minimo ---

export type RedisArg = string | number;

export interface RedisClient {
  command(args: RedisArg[]): Promise<unknown>;
  pipeline(commands: RedisArg[][]): Promise<unknown[]>;
}

// Script Lua (EVAL). L'emulatore in memoria li riconosce dal testo.

// KEYS: dati, rev — ARGV: rev attesa, valore. Scrive e incrementa la rev solo
// se è quella attesa; altrimenti -1.
export const CAS_SCRIPT = [
  "local cur = tonumber(redis.call('GET', KEYS[2]) or '0')",
  'if cur ~= tonumber(ARGV[1]) then return -1 end',
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return redis.call('INCR', KEYS[2])",
].join('\n');

// KEYS: dati, rev — ARGV: valore. Scrittura incondizionata + nuova rev.
export const REPLACE_SCRIPT = [
  "redis.call('SET', KEYS[1], ARGV[1])",
  "return redis.call('INCR', KEYS[2])",
].join('\n');

// KEYS: lock — ARGV: proprietario. Rilascia solo il proprio lock.
export const UNLOCK_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "  return redis.call('DEL', KEYS[1])",
  'end',
  'return 0',
].join('\n');

// KEYS: turno — ARGV: dispositivo, adesso (ms), scadenza (ms), ttl (ms).
// Il turno passa a chi lo chiede se è libero, scaduto o già suo; restituisce
// il turno risultante "dispositivo|scadenza".
export const LEASE_SCRIPT = [
  "local cur = redis.call('GET', KEYS[1])",
  'if cur then',
  "  local sep = string.find(cur, '|', 1, true)",
  '  if sep then',
  '    local holder = string.sub(cur, 1, sep - 1)',
  '    local untilMs = tonumber(string.sub(cur, sep + 1)) or 0',
  '    if holder ~= ARGV[1] and untilMs > tonumber(ARGV[2]) then return cur end',
  '  end',
  'end',
  "local v = ARGV[1] .. '|' .. ARGV[3]",
  "redis.call('SET', KEYS[1], v, 'PX', ARGV[4])",
  'return v',
].join('\n');

// --- Client REST di Upstash ---

export interface UpstashOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class UpstashRestClient implements RedisClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: UpstashOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new StoreError('timeout', 'Database: tempo scaduto');
      throw new StoreError('network', 'Database: errore di rete');
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      throw new StoreError('auth', 'Database: credenziali non valide');
    }
    const data: any = await response.json().catch(() => null);
    if (!response.ok) {
      // Upstash risponde 400 con { error } per i comandi errati
      if (data && typeof data.error === 'string') throw new StoreError('redis', `Database: ${data.error}`);
      throw new StoreError('http', `Database: HTTP ${response.status}`);
    }
    if (data === null) throw new StoreError('http', 'Database: risposta non valida');
    return data;
  }

  async command(args: RedisArg[]): Promise<unknown> {
    const data: any = await this.post('', args.map(String));
    if (data && typeof data.error === 'string') throw new StoreError('redis', `Database: ${data.error}`);
    return data?.result ?? null;
  }

  async pipeline(commands: RedisArg[][]): Promise<unknown[]> {
    const data: any = await this.post('/pipeline', commands.map(c => c.map(String)));
    if (!Array.isArray(data)) throw new StoreError('http', 'Database: risposta non valida');
    return data.map((item: any) => {
      if (item && typeof item.error === 'string') throw new StoreError('redis', `Database: ${item.error}`);
      return item?.result ?? null;
    });
  }
}

// --- Emulatore in memoria (stessi comandi e script del client REST) ---

interface MemoryEntry {
  value: string | Map<string, string>;
  expiresAt?: number;
}

export class MemoryRedis implements RedisClient {
  private readonly data = new Map<string, MemoryEntry>();

  private entry(key: string): MemoryEntry | undefined {
    const e = this.data.get(key);
    if (e && e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private getString(key: string): string | null {
    const e = this.entry(key);
    if (!e) return null;
    if (typeof e.value !== 'string') throw new StoreError('redis', 'WRONGTYPE');
    return e.value;
  }

  private set(key: string, value: string, opts: { nx?: boolean; px?: number } = {}): string | null {
    if (opts.nx && this.entry(key)) return null;
    this.data.set(key, { value, expiresAt: opts.px !== undefined ? Date.now() + opts.px : undefined });
    return 'OK';
  }

  private incr(key: string): number {
    const cur = this.getString(key);
    const n = (cur === null ? 0 : parseInt(cur, 10)) + 1;
    if (!Number.isFinite(n)) throw new StoreError('redis', 'ERR value is not an integer');
    const e = this.entry(key);
    this.data.set(key, { value: String(n), expiresAt: e?.expiresAt });
    return n;
  }

  // Esegue i comandi in modo sincrono: ogni comando (e ogni script) è
  // atomico come in Redis.
  exec(raw: RedisArg[]): unknown {
    const args = raw.map(String);
    const name = (args[0] || '').toUpperCase();
    switch (name) {
      case 'GET':
        return this.getString(args[1]);
      case 'MGET':
        return args.slice(1).map(k => this.getString(k));
      case 'SET': {
        const opts: { nx?: boolean; px?: number } = {};
        for (let i = 3; i < args.length; i++) {
          const o = args[i].toUpperCase();
          if (o === 'NX') opts.nx = true;
          else if (o === 'PX') opts.px = parseInt(args[++i], 10);
          else throw new StoreError('redis', `ERR opzione SET non supportata: ${o}`);
        }
        return this.set(args[1], args[2], opts);
      }
      case 'DEL': {
        let n = 0;
        for (const k of args.slice(1)) if (this.entry(k) && this.data.delete(k)) n++;
        return n;
      }
      case 'INCR':
        return this.incr(args[1]);
      case 'PTTL': {
        const e = this.entry(args[1]);
        if (!e) return -2;
        return e.expiresAt === undefined ? -1 : Math.max(0, e.expiresAt - Date.now());
      }
      case 'HSET': {
        let e = this.entry(args[1]);
        if (!e) {
          e = { value: new Map() };
          this.data.set(args[1], e);
        }
        if (typeof e.value === 'string') throw new StoreError('redis', 'WRONGTYPE');
        let added = 0;
        for (let i = 2; i + 1 < args.length; i += 2) {
          if (!e.value.has(args[i])) added++;
          e.value.set(args[i], args[i + 1]);
        }
        return added;
      }
      case 'HGETALL': {
        const e = this.entry(args[1]);
        if (!e) return [];
        if (typeof e.value === 'string') throw new StoreError('redis', 'WRONGTYPE');
        return [...e.value.entries()].flat();
      }
      case 'FLUSHALL':
        this.data.clear();
        return 'OK';
      case 'EVAL':
        return this.evalScript(args);
      default:
        throw new StoreError('redis', `ERR comando sconosciuto '${name}'`);
    }
  }

  private evalScript(args: string[]): unknown {
    const script = args[1];
    const numKeys = parseInt(args[2], 10);
    const keys = args.slice(3, 3 + numKeys);
    const argv = args.slice(3 + numKeys);
    if (script === CAS_SCRIPT) {
      const cur = parseInt(this.getString(keys[1]) ?? '0', 10);
      if (cur !== Number(argv[0])) return -1;
      this.set(keys[0], argv[1]);
      return this.incr(keys[1]);
    }
    if (script === REPLACE_SCRIPT) {
      this.set(keys[0], argv[0]);
      return this.incr(keys[1]);
    }
    if (script === UNLOCK_SCRIPT) {
      if (this.getString(keys[0]) === argv[0]) return this.exec(['DEL', keys[0]]);
      return 0;
    }
    if (script === LEASE_SCRIPT) {
      const cur = this.getString(keys[0]);
      if (cur) {
        const sep = cur.indexOf('|');
        if (sep >= 0) {
          const holder = cur.slice(0, sep);
          const untilMs = Number(cur.slice(sep + 1)) || 0;
          if (holder !== argv[0] && untilMs > Number(argv[1])) return cur;
        }
      }
      const v = `${argv[0]}|${argv[2]}`;
      this.set(keys[0], v, { px: parseInt(argv[3], 10) });
      return v;
    }
    throw new StoreError('redis', 'NOSCRIPT script non riconosciuto dall\'emulatore');
  }

  async command(args: RedisArg[]): Promise<unknown> {
    return this.exec(args);
  }

  async pipeline(commands: RedisArg[][]): Promise<unknown[]> {
    return commands.map(c => this.exec(c));
  }

  clear(): void {
    this.data.clear();
  }
}

// --- Store ---

export interface LastTick {
  at: string;
  source: TickSource;
  summary: TickSummary;
}

export interface CloudMeta {
  lastTick: LastTick | null;
  schedulerSeenAt: string | null;
  webhookSeenAt: string | null;
  // Fine dell'ultimo passaggio in tempo reale (ms): serve a saltare i
  // passaggi del webhook troppo ravvicinati
  lastTickWallMs: number | null;
}

export interface LeaseRecord {
  deviceId: string;
  until: number; // ms epoch
}

export interface StoreRevs {
  rev: number;
  configRev: number;
}

export interface Store {
  readonly kind: 'upstash' | 'memory';
  readonly prefix: string;
  revs(): Promise<StoreRevs>;
  // Elenco pratiche e la sua rev, letti insieme (MGET: atomico).
  // appointments null = mai inizializzato.
  readAppointments(): Promise<{ appointments: Appointment[] | null; rev: number }>;
  // Compare-and-set: nuova rev, oppure null se nel frattempo la rev è cambiata
  writeAppointments(expectedRev: number, appointments: Appointment[]): Promise<number | null>;
  replaceAppointments(appointments: Appointment[]): Promise<number>;
  readConfig(): Promise<{ config: CloudConfig | null; configRev: number }>;
  writeConfig(config: CloudConfig): Promise<number>;
  readMeta(): Promise<CloudMeta>;
  updateMeta(patch: Partial<CloudMeta>): Promise<void>;
  acquireLock(owner: string, ttlMs: number): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
  // Chiede (o rinnova) il turno per `deviceId`: restituisce il turno risultante
  claimLease(deviceId: string, nowMs: number, ttlMs: number): Promise<LeaseRecord>;
  readLease(): Promise<LeaseRecord | null>;
}

// Compressione dell'elenco: JSON -> gzip -> base64 (può pesare centinaia di KB)
export const encodeAppointments = (appointments: Appointment[]): string =>
  gzipSync(Buffer.from(JSON.stringify(appointments), 'utf8')).toString('base64');

export const decodeAppointments = (raw: string): Appointment[] => {
  try {
    const parsed = JSON.parse(gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error('non è un elenco');
    return parsed as Appointment[];
  } catch {
    throw new StoreError('data', 'Database: elenco pratiche illeggibile');
  }
};

const toInt = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
};

const parseJson = <T>(raw: unknown): T | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const parseLease = (raw: unknown): LeaseRecord | null => {
  if (typeof raw !== 'string') return null;
  const sep = raw.indexOf('|');
  if (sep < 0) return null;
  const until = Number(raw.slice(sep + 1));
  return Number.isFinite(until) ? { deviceId: raw.slice(0, sep), until } : null;
};

const META_FIELDS: (keyof CloudMeta)[] = ['lastTick', 'schedulerSeenAt', 'webhookSeenAt', 'lastTickWallMs'];

export const keyPrefix = (vercelEnv?: string): string => `optiroute:${vercelEnv || 'development'}:`;

export class RedisStore implements Store {
  readonly kind: 'upstash' | 'memory';
  readonly prefix: string;
  protected readonly redis: RedisClient;

  constructor(redis: RedisClient, kind: 'upstash' | 'memory', prefix: string) {
    this.redis = redis;
    this.kind = kind;
    this.prefix = prefix;
  }

  protected k(name: string): string {
    return `${this.prefix}${name}`;
  }

  async revs(): Promise<StoreRevs> {
    const [rev, configRev] = (await this.redis.command(['MGET', this.k('rev'), this.k('configRev')])) as unknown[];
    return { rev: toInt(rev), configRev: toInt(configRev) };
  }

  async readAppointments(): Promise<{ appointments: Appointment[] | null; rev: number }> {
    const [raw, rev] = (await this.redis.command(['MGET', this.k('appointments'), this.k('rev')])) as unknown[];
    return {
      appointments: typeof raw === 'string' && raw ? decodeAppointments(raw) : null,
      rev: toInt(rev),
    };
  }

  async writeAppointments(expectedRev: number, appointments: Appointment[]): Promise<number | null> {
    const r = toInt(
      await this.redis.command([
        'EVAL', CAS_SCRIPT, 2, this.k('appointments'), this.k('rev'), expectedRev, encodeAppointments(appointments),
      ])
    );
    return r < 0 ? null : r;
  }

  async replaceAppointments(appointments: Appointment[]): Promise<number> {
    return toInt(
      await this.redis.command(['EVAL', REPLACE_SCRIPT, 2, this.k('appointments'), this.k('rev'), encodeAppointments(appointments)])
    );
  }

  async readConfig(): Promise<{ config: CloudConfig | null; configRev: number }> {
    const [raw, rev] = (await this.redis.command(['MGET', this.k('config'), this.k('configRev')])) as unknown[];
    return { config: parseJson<CloudConfig>(raw), configRev: toInt(rev) };
  }

  async writeConfig(config: CloudConfig): Promise<number> {
    return toInt(
      await this.redis.command(['EVAL', REPLACE_SCRIPT, 2, this.k('config'), this.k('configRev'), JSON.stringify(config)])
    );
  }

  async readMeta(): Promise<CloudMeta> {
    const flat = (await this.redis.command(['HGETALL', this.k('meta')])) as unknown;
    const map = new Map<string, string>();
    if (Array.isArray(flat)) {
      for (let i = 0; i + 1 < flat.length; i += 2) map.set(String(flat[i]), String(flat[i + 1]));
    } else if (flat && typeof flat === 'object') {
      for (const [k, v] of Object.entries(flat)) map.set(k, String(v));
    }
    return {
      lastTick: parseJson<LastTick>(map.get('lastTick')),
      schedulerSeenAt: map.get('schedulerSeenAt') || null,
      webhookSeenAt: map.get('webhookSeenAt') || null,
      lastTickWallMs: map.get('lastTickWallMs') ? toInt(map.get('lastTickWallMs')) : null,
    };
  }

  async updateMeta(patch: Partial<CloudMeta>): Promise<void> {
    const args: RedisArg[] = ['HSET', this.k('meta')];
    for (const field of META_FIELDS) {
      if (!(field in patch)) continue;
      const v = patch[field];
      args.push(
        field,
        v === null || v === undefined ? '' : typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v)
      );
    }
    if (args.length > 2) await this.redis.command(args);
  }

  async acquireLock(owner: string, ttlMs: number): Promise<boolean> {
    const r = await this.redis.command(['SET', this.k('lock'), owner, 'NX', 'PX', ttlMs]);
    return r === 'OK';
  }

  async releaseLock(owner: string): Promise<void> {
    await this.redis.command(['EVAL', UNLOCK_SCRIPT, 1, this.k('lock'), owner]);
  }

  async claimLease(deviceId: string, nowMs: number, ttlMs: number): Promise<LeaseRecord> {
    const r = await this.redis.command(['EVAL', LEASE_SCRIPT, 1, this.k('lease'), deviceId, nowMs, nowMs + ttlMs, ttlMs]);
    const lease = parseLease(r);
    if (!lease) throw new StoreError('data', 'Database: turno illeggibile');
    return lease;
  }

  async readLease(): Promise<LeaseRecord | null> {
    return parseLease(await this.redis.command(['GET', this.k('lease')]));
  }
}

export class UpstashStore extends RedisStore {
  constructor(opts: UpstashOptions, prefix: string) {
    super(new UpstashRestClient(opts), 'upstash', prefix);
  }
}

export class MemoryStore extends RedisStore {
  constructor(prefix: string, redis: MemoryRedis = new MemoryRedis()) {
    super(redis, 'memory', prefix);
  }
}

// Emulatore condiviso dal processo: i due bundle (api/cloud.js e
// api/cloud-tick.js) sono moduli separati ma devono vedere gli stessi dati.
export const sharedMemoryRedis = (): MemoryRedis => {
  const g = globalThis as { __optirouteMemoryRedis?: MemoryRedis };
  if (!g.__optirouteMemoryRedis) g.__optirouteMemoryRedis = new MemoryRedis();
  return g.__optirouteMemoryRedis;
};

type Env = Record<string, string | undefined>;

// Archivio configurato dalle variabili d'ambiente (null = nessun database).
// Ordine: memoria (solo fuori da Vercel, se richiesta esplicitamente),
// UPSTASH_REDIS_REST_*, KV_REST_API_*.
export const storeFromEnv = (env: Env = process.env): Store | null => {
  const prefix = keyPrefix(env.VERCEL_ENV);
  if (env.OPTIROUTE_STORE === 'memory' && !env.VERCEL_ENV) {
    return new MemoryStore(prefix, sharedMemoryRedis());
  }
  const url = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }
    : env.KV_REST_API_URL && env.KV_REST_API_TOKEN
      ? { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN }
      : null;
  return url ? new UpstashStore(url, prefix) : null;
};

// --- Commit: riduttore puro + compare-and-set con riapplicazione ---

export const COMMIT_MAX_ATTEMPTS = 5;

export interface CommitResult {
  appointments: Appointment[];
  rev: number;
  changed: boolean;
}

// Rilegge lo stato, applica `fn` (PURA: può essere chiamata più volte) e
// prova il compare-and-set; se la rev è cambiata rilegge e riapplica. Se
// `fn` restituisce lo stesso elenco non si scrive nulla.
export const commit = async (
  store: Store,
  fn: (all: Appointment[]) => Appointment[],
  maxAttempts = COMMIT_MAX_ATTEMPTS
): Promise<CommitResult> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { appointments, rev } = await store.readAppointments();
    const current = appointments || [];
    const next = fn(current);
    if (next === current) return { appointments: current, rev, changed: false };
    const newRev = await store.writeAppointments(rev, next);
    if (newRev !== null) return { appointments: next, rev: newRev, changed: true };
  }
  throw new ConflictError();
};
