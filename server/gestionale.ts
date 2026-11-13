import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

// Collegamento con il gestionale (sito separato con Firebase Authentication).
// OptiRoute viene mostrata dentro una pagina del gestionale; chi la usa si è
// già autenticato lì. Il server riceve il "biglietto" di Firebase (ID token),
// ne controlla la firma con le chiavi pubbliche di Google e poi chiede al
// database del gestionale (Firestore), CON LO STESSO BIGLIETTO, la scheda
// della persona in `personale/{email}`: se la lettura riesce è personale
// autorizzato, e il campo `ruolo` dice se è amministratore.
//
// Configurazione (variabili d'ambiente su Vercel, mai nel codice):
//   GESTIONALE_FIREBASE_PROJECTS  progetti Firebase accettati (separati da virgola)
//   GESTIONALE_ORIGINS            indirizzi delle pagine del gestionale (separati da virgola)
// Collegamento attivo = entrambe impostate E CRON_SECRET impostata.
//
// Nei log non finiscono mai biglietti né indirizzi email.

type Env = Record<string, string | undefined>;

export const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
export const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com';
export const ADMIN_ROLES = ['Super Amministratore', 'Amministratore'];
export const STAFF_CACHE_TTL_MS = 5 * 60 * 1000;
export const STAFF_CACHE_MAX = 500;
export const CLOCK_SKEW_S = 5 * 60;
export const GESTIONALE_TIMEOUT_MS = 10_000;

// --- Configurazione ---

export interface GestionaleSettings {
  projects: string[];
  origins: string[];
  enabled: boolean;
}

const splitList = (raw: string | undefined): string[] =>
  (raw || '').split(',').map(s => s.trim()).filter(Boolean);

// Origine normalizzata ("https://gestionale.example"), '' se non valida
export const normalizeOrigin = (raw: unknown): string => {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
};

const PROJECT_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

export const gestionaleSettings = (env: Env): GestionaleSettings => {
  const projects = [...new Set(splitList(env.GESTIONALE_FIREBASE_PROJECTS).filter(p => PROJECT_RE.test(p)))];
  const origins = [...new Set(splitList(env.GESTIONALE_ORIGINS).map(normalizeOrigin).filter(Boolean))];
  return { projects, origins, enabled: projects.length > 0 && origins.length > 0 && !!env.CRON_SECRET };
};

export const isAllowedOrigin = (settings: GestionaleSettings, origin: unknown): boolean => {
  const o = normalizeOrigin(origin);
  return !!o && settings.origins.includes(o);
};

// --- Errori ---

// Biglietto non valido (firma, scadenza, progetto...) o rifiutato da Firestore
export class GestionaleAuthError extends Error {
  constructor(readonly reason: string) {
    super(`gestionale: ${reason}`);
    this.name = 'GestionaleAuthError';
  }
}

// Google o Firestore non raggiungibili / risposta inattesa
export class GestionaleUnreachableError extends Error {
  constructor(readonly reason: string) {
    super(`gestionale: ${reason}`);
    this.name = 'GestionaleUnreachableError';
  }
}

// --- Rete (iniettabile) ---

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type GestionaleFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<FetchResponseLike>;

const defaultFetch: GestionaleFetch = (url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>;

const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

// --- Biglietto di Firebase (JWT RS256) ---

export interface FirebaseClaims {
  sub: string;
  email: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

const parseJsonPart = (part: string): Record<string, unknown> => {
  if (!part || !B64URL_RE.test(part)) throw new GestionaleAuthError('formato');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new GestionaleAuthError('formato');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GestionaleAuthError('formato');
  return value as Record<string, unknown>;
};

// Legge le tre parti del biglietto SENZA controllarne la firma
export const decodeJwt = (token: string): DecodedJwt => {
  if (typeof token !== 'string' || token.length > 8192) throw new GestionaleAuthError('formato');
  const parts = token.split('.');
  if (parts.length !== 3) throw new GestionaleAuthError('formato');
  if (!B64URL_RE.test(parts[2])) throw new GestionaleAuthError('formato');
  return {
    header: parseJsonPart(parts[0]),
    payload: parseJsonPart(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
};

// Controlli sul contenuto del biglietto. `strict: false` (solo per gli
// emulatori di Firebase in locale) controlla soltanto progetto, scadenza ed
// email verificata.
export const checkFirebaseClaims = (
  payload: Record<string, unknown>,
  projects: string[],
  nowSec: number,
  opts: { strict?: boolean } = {}
): FirebaseClaims => {
  const strict = opts.strict !== false;
  const aud = payload.aud;
  if (typeof aud !== 'string' || !projects.includes(aud)) throw new GestionaleAuthError('progetto');
  const iss = typeof payload.iss === 'string' ? payload.iss : '';
  if (strict && iss !== `https://securetoken.google.com/${aud}`) throw new GestionaleAuthError('emittente');
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSec) throw new GestionaleAuthError('scaduto');
  const iat = typeof payload.iat === 'number' ? payload.iat : NaN;
  if (strict && (!Number.isFinite(iat) || iat > nowSec + CLOCK_SKEW_S)) throw new GestionaleAuthError('emesso nel futuro');
  const sub = payload.sub;
  if (strict && (typeof sub !== 'string' || !sub || sub.length > 128)) throw new GestionaleAuthError('utente');
  if (payload.email_verified !== true) throw new GestionaleAuthError('email non verificata');
  const email = payload.email;
  if (typeof email !== 'string' || !email.trim()) throw new GestionaleAuthError('email');
  return { sub: typeof sub === 'string' ? sub : '', email: email.trim(), aud, iss, exp, iat: Number.isFinite(iat) ? iat : 0 };
};

// Verifica di firma + contenuto con chiavi già note (funzione PURA)
export const verifyFirebaseToken = (
  token: string,
  keys: Map<string, KeyObject>,
  projects: string[],
  nowSec: number
): FirebaseClaims => {
  const jwt = decodeJwt(token);
  if (jwt.header.alg !== 'RS256') throw new GestionaleAuthError('algoritmo');
  const kid = jwt.header.kid;
  const key = typeof kid === 'string' ? keys.get(kid) : undefined;
  if (!key) throw new GestionaleAuthError('chiave sconosciuta');
  let ok = false;
  try {
    ok = cryptoVerify('RSA-SHA256', Buffer.from(jwt.signingInput, 'utf8'), key, jwt.signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new GestionaleAuthError('firma');
  return checkFirebaseClaims(jwt.payload, projects, nowSec);
};

export type VerifyToken = (token: string, projects: string[], nowMs: number) => Promise<FirebaseClaims>;

// Durata della cache delle chiavi da Cache-Control (max-age), fra 1 minuto e 1 giorno
export const maxAgeMs = (cacheControl: string | null): number => {
  const m = /max-age=(\d+)/i.exec(cacheControl || '');
  const seconds = m ? parseInt(m[1], 10) : 3600;
  return Math.min(24 * 3600, Math.max(60, seconds)) * 1000;
};

// Chiavi pubbliche di Google (JWK), in cache come dice Cache-Control. Un
// biglietto con una chiave sconosciuta fa riscaricare le chiavi (al massimo
// una volta al minuto: Google le ruota).
export const createJwksVerifier = (opts: { fetch?: GestionaleFetch; url?: string; timeoutMs?: number } = {}): VerifyToken => {
  const doFetch = opts.fetch || defaultFetch;
  const url = opts.url || FIREBASE_JWKS_URL;
  let cache: { keys: Map<string, KeyObject>; until: number; fetchedAt: number } | null = null;
  let inFlight: Promise<Map<string, KeyObject>> | null = null;

  const download = (nowMs: number): Promise<Map<string, KeyObject>> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let res: FetchResponseLike;
      let body: unknown;
      try {
        res = await withTimeout(signal => doFetch(url, { method: 'GET', signal }), opts.timeoutMs ?? GESTIONALE_TIMEOUT_MS);
        body = await res.json();
      } catch {
        throw new GestionaleUnreachableError('chiavi non raggiungibili');
      }
      if (!res.ok || !body || typeof body !== 'object' || !Array.isArray((body as { keys?: unknown }).keys)) {
        throw new GestionaleUnreachableError('chiavi: risposta inattesa');
      }
      const keys = new Map<string, KeyObject>();
      for (const jwk of (body as { keys: Record<string, unknown>[] }).keys) {
        if (!jwk || typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
        try {
          keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as never, format: 'jwk' }));
        } catch {
          // chiave illeggibile: ignorata
        }
      }
      cache = { keys, until: nowMs + maxAgeMs(res.headers.get('cache-control')), fetchedAt: nowMs };
      return keys;
    })();
    return inFlight.finally(() => { inFlight = null; });
  };

  return async (token, projects, nowMs) => {
    const jwt = decodeJwt(token); // formato prima di qualunque rete
    if (jwt.header.alg !== 'RS256') throw new GestionaleAuthError('algoritmo');
    let keys = cache && cache.until > nowMs ? cache.keys : await download(nowMs);
    const kid = jwt.header.kid;
    if (typeof kid === 'string' && !keys.has(kid) && cache && nowMs - cache.fetchedAt >= 60_000) {
      keys = await download(nowMs);
    }
    return verifyFirebaseToken(token, keys, projects, Math.floor(nowMs / 1000));
  };
};

// --- Scheda del personale (Firestore REST, con il biglietto dell'utente) ---

export interface StaffRecord {
  name: string;
  role: string;
}

const firestoreString = (fields: unknown, name: string): string => {
  const f = fields && typeof fields === 'object' ? (fields as Record<string, unknown>)[name] : undefined;
  const v = f && typeof f === 'object' ? (f as { stringValue?: unknown }).stringValue : undefined;
  return typeof v === 'string' ? v.trim() : '';
};

export const staffDocumentUrl = (baseUrl: string, project: string, email: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/v1/projects/${project}/databases/(default)/documents/personale/${encodeURIComponent(email.toLowerCase())}`;

// 200 -> scheda; 403/404 -> null (non è personale); 401 -> biglietto
// rifiutato; altro / rete -> non raggiungibile
export const lookupStaff = async (
  opts: { fetch?: GestionaleFetch; baseUrl?: string; timeoutMs?: number },
  project: string,
  email: string,
  token: string
): Promise<StaffRecord | null> => {
  const doFetch = opts.fetch || defaultFetch;
  const url = staffDocumentUrl(opts.baseUrl || FIRESTORE_BASE_URL, project, email);
  let res: FetchResponseLike;
  try {
    res = await withTimeout(
      signal => doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal }),
      opts.timeoutMs ?? GESTIONALE_TIMEOUT_MS
    );
  } catch {
    throw new GestionaleUnreachableError('archivio del personale non raggiungibile');
  }
  if (res.status === 401) throw new GestionaleAuthError('rifiutato dal gestionale');
  if (res.status === 403 || res.status === 404) return null;
  if (res.status !== 200) throw new GestionaleUnreachableError(`archivio del personale: HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GestionaleUnreachableError('archivio del personale: risposta non leggibile');
  }
  const fields = body && typeof body === 'object' ? (body as { fields?: unknown }).fields : undefined;
  return { role: firestoreString(fields, 'ruolo'), name: firestoreString(fields, 'nome') };
};

export const isAdminRole = (role: string): boolean => ADMIN_ROLES.includes(role);

// --- Servizio completo: biglietto -> persona ---

export interface GestionaleDeps {
  fetch?: GestionaleFetch;
  verifyToken?: VerifyToken;
  firestoreBaseUrl?: string;
}

export interface GestionaleIdentity {
  name: string;
  role: string;
  admin: boolean;
}

const tokenDigest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export const createGestionaleService = (deps: GestionaleDeps = {}) => {
  const verify = deps.verifyToken || createJwksVerifier({ fetch: deps.fetch });
  // Solo i riscontri positivi, per 5 minuti (mai oltre la scadenza del biglietto)
  const staffCache = new Map<string, { identity: GestionaleIdentity; until: number }>();

  // null = biglietto valido ma la persona non è nel personale
  const identify = async (token: string, projects: string[], nowMs: number): Promise<GestionaleIdentity | null> => {
    const digest = tokenDigest(token);
    const hit = staffCache.get(digest);
    if (hit && hit.until > nowMs) return hit.identity;
    if (hit) staffCache.delete(digest);

    const claims = await verify(token, projects, nowMs);
    const staff = await lookupStaff({ fetch: deps.fetch, baseUrl: deps.firestoreBaseUrl }, claims.aud, claims.email, token);
    if (!staff) return null;
    const identity: GestionaleIdentity = { name: staff.name, role: staff.role, admin: isAdminRole(staff.role) };
    while (staffCache.size >= STAFF_CACHE_MAX) {
      const oldest = staffCache.keys().next().value;
      if (oldest === undefined) break;
      staffCache.delete(oldest);
    }
    staffCache.set(digest, { identity, until: Math.min(nowMs + STAFF_CACHE_TTL_MS, claims.exp * 1000) });
    return identity;
  };

  return { identify, cacheSize: () => staffCache.size };
};

export type GestionaleService = ReturnType<typeof createGestionaleService>;
