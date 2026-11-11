import type { Appointment } from '../types';
import {
  CLOUD_API_PATH,
  type AppointmentChange,
  type CloudConfig,
  type CloudInitRequest,
  type CloudPushRequest,
  type CloudSnapshot,
  type CloudStatus,
  type TickSummary,
} from './cloudProtocol';

// Client HTTP del pilota in cloud (/api/cloud?op=...). Ogni richiesta ha un
// timeout; gli errori diventano un unico tipo (CloudFailure) che il resto
// dell'app sa leggere. La chiave viaggia SOLO nell'intestazione Authorization
// e non compare mai nei log né negli URL.

export type CloudFailure =
  // rete assente, timeout, 404 (es. `vite dev`: le funzioni /api non ci sono)
  | { kind: 'offline'; message: string }
  // 401: chiave mancante o errata
  | { kind: 'auth'; message: string }
  // 503: sul server manca CRON_SECRET (secret) o il database (store)
  | { kind: 'not_configured'; detail: 'secret' | 'store'; message: string }
  // 409: troppe modifiche concorrenti, si riprova
  | { kind: 'conflict'; message: string }
  // 400 / 500 / risposta inattesa
  | { kind: 'server'; status: number; message: string };

export type CloudResult<T> = { ok: true; data: T } | { ok: false; error: CloudFailure };

export interface CloudPing {
  protocol: number;
  secretConfigured: boolean;
  storeConfigured: boolean;
}

export interface CloudTickResult {
  summary: TickSummary;
  rev: number;
  configRev: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CloudClientOptions {
  key: string;
  fetch?: FetchLike;     // iniettabile (test)
  timeoutMs?: number;    // default 15 s
  baseUrl?: string;      // default: stessa origine
}

export const CLOUD_TIMEOUT_MS = 15000;

const failure = (error: CloudFailure): CloudResult<never> => ({ ok: false, error });

// Errore HTTP -> CloudFailure
export const mapHttpError = (status: number, body: unknown): CloudFailure => {
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const msg = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message
    : '';
  if (status === 401) return { kind: 'auth', message: 'Chiave di accesso mancante o errata.' };
  if (status === 503 && code === 'secret_not_configured') {
    return { kind: 'not_configured', detail: 'secret', message: 'Sul server manca la chiave (CRON_SECRET).' };
  }
  if (status === 503 && code === 'store_not_configured') {
    return { kind: 'not_configured', detail: 'store', message: 'Sul server manca il database.' };
  }
  if (status === 409) return { kind: 'conflict', message: 'Modifiche concorrenti: si riprova.' };
  if (status === 404) return { kind: 'offline', message: 'Funzioni del cloud non disponibili a questo indirizzo.' };
  // 502/503/504 generici (gateway, avvio a freddo): transitori
  if (status === 502 || status === 503 || status === 504) return { kind: 'offline', message: `Cloud momentaneamente non raggiungibile (${status}).` };
  return { kind: 'server', status, message: msg || (code ? `Errore del cloud: ${String(code)}` : `Errore del cloud (${status}).`) };
};

const doRequest = async <T>(
  opts: CloudClientOptions,
  method: 'GET' | 'POST',
  op: string,
  params: Record<string, string | number> = {},
  body?: unknown,
  extra: { keepalive?: boolean; auth?: boolean } = {}
): Promise<CloudResult<T>> => {
  const fetchImpl: FetchLike | undefined = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) return failure({ kind: 'offline', message: 'Rete non disponibile.' });

  const qs = new URLSearchParams({ op, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const url = `${opts.baseUrl || ''}${CLOUD_API_PATH}?${qs.toString()}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (extra.auth !== false && opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? CLOUD_TIMEOUT_MS) : undefined;
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
      keepalive: extra.keepalive === true ? true : undefined,
      cache: 'no-store',
    });
    let data: unknown = null;
    let parsed = true;
    try {
      data = await response.json();
    } catch {
      parsed = false;
    }
    if (!response.ok) return failure(mapHttpError(response.status, data));
    // 200 ma non JSON (es. la pagina dell'app servita al posto dell'API): il
    // cloud non c'è a questo indirizzo
    if (!parsed || !data || typeof data !== 'object') {
      return failure({ kind: 'offline', message: 'Risposta inattesa: il cloud non sembra attivo a questo indirizzo.' });
    }
    return { ok: true, data: data as T };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return failure({ kind: 'offline', message: aborted ? 'Il cloud non ha risposto in tempo.' : 'Cloud non raggiungibile (rete).' });
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// Senza chiave: il server è raggiungibile e configurato?
export const cloudPing = (opts: Omit<CloudClientOptions, 'key'> & { key?: string }): Promise<CloudResult<CloudPing>> =>
  doRequest<CloudPing>({ ...opts, key: '' }, 'GET', 'ping', {}, undefined, { auth: false });

export const cloudStatus = (opts: CloudClientOptions): Promise<CloudResult<CloudStatus>> =>
  doRequest<CloudStatus>(opts, 'GET', 'status');

// Novità rispetto a rev/configRev (rev -1: elenco completo)
export const cloudPull = (
  opts: CloudClientOptions,
  args: { rev: number; configRev: number; device: string }
): Promise<CloudResult<CloudSnapshot>> =>
  doRequest<CloudSnapshot>(opts, 'GET', 'pull', { rev: args.rev, configRev: args.configRev, device: args.device });

export const cloudPush = (
  opts: CloudClientOptions,
  args: { device: string; changes: AppointmentChange[]; config?: CloudConfig },
  extra: { keepalive?: boolean } = {}
): Promise<CloudResult<CloudSnapshot>> => {
  const body: CloudPushRequest = { device: args.device, changes: args.changes };
  if (args.config) body.config = args.config;
  return doRequest<CloudSnapshot>(opts, 'POST', 'push', {}, body, { keepalive: extra.keepalive });
};

export const cloudInit = (
  opts: CloudClientOptions,
  args: { device: string; appointments: Appointment[]; config: CloudConfig }
): Promise<CloudResult<CloudSnapshot>> => {
  const body: CloudInitRequest = { device: args.device, appointments: args.appointments, config: args.config, replace: true };
  return doRequest<CloudSnapshot>(opts, 'POST', 'init', {}, body);
};

export const cloudTick = (opts: CloudClientOptions, args: { device: string }): Promise<CloudResult<CloudTickResult>> =>
  doRequest<CloudTickResult>(opts, 'POST', 'tick', {}, { device: args.device });

// Testo breve per l'operatore
export const describeCloudFailure = (f: CloudFailure): string => {
  switch (f.kind) {
    case 'offline': return `Cloud non raggiungibile: ${f.message}`;
    case 'auth': return 'Chiave di accesso errata: deve essere uguale a CRON_SECRET impostato su Vercel.';
    case 'not_configured': return f.detail === 'secret'
      ? 'Cloud non configurato: su Vercel manca la variabile CRON_SECRET.'
      : 'Cloud non configurato: su Vercel manca il database.';
    case 'conflict': return 'Modifiche concorrenti sul cloud: riprovo fra poco.';
    case 'server': return `Errore del cloud: ${f.message}`;
  }
};
