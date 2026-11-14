import { CLOUD_API_PATH, type CloudSessionResponse } from './cloudProtocol';
import { cloudPing, type CloudCredential, type CredentialRefresh, type FetchLike } from './cloudSync';
import { GestionaleHostError } from './gestionaleHost';

// Accesso dal gestionale: il gestionale fornisce il "biglietto" di Firebase
// della persona collegata; il server di OptiRoute lo verifica e rilascia un
// biglietto di sessione valido 60 minuti (POST /api/cloud?op=session).
// Il biglietto di sessione resta SOLO in memoria (mai salvato nel browser),
// si rinnova da solo 5 minuti prima della scadenza e subito se il server
// risponde 401 (un solo rinnovo alla volta). Chi lo usa (sincronizzazione
// del cloud, chiamate) lo legge al momento di ogni richiesta: il rinnovo non
// interrompe nulla.

export const SESSION_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const SESSION_RETRY_MS = 30_000;
export const SESSION_TIMEOUT_MS = 15_000;

// forbidden: non amministratore · not_configured: mancano le variabili sul
// server · auth: biglietto rifiutato · network: rete / gestionale che non risponde
export type SessionFailureKind = 'forbidden' | 'not_configured' | 'auth' | 'network';

export class GestionaleSessionError extends Error {
  constructor(readonly kind: SessionFailureKind, message: string) {
    super(message);
    this.name = 'GestionaleSessionError';
  }
}

export interface SessionUser {
  name: string;
  role: string;
}

export interface SessionClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface GestionaleSessionOptions {
  getIdToken: () => Promise<string>;   // biglietto di Firebase fresco dal gestionale
  fetch?: FetchLike;
  clock?: SessionClock;
  baseUrl?: string;
  refreshMarginMs?: number;
  retryMs?: number;
}

// Richiesta del biglietto di sessione (una volta)
export const requestSession = async (
  idToken: string,
  opts: { fetch?: FetchLike; baseUrl?: string; timeoutMs?: number } = {}
): Promise<CloudSessionResponse> => {
  const fetchImpl: FetchLike | undefined = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) throw new GestionaleSessionError('network', 'Rete non disponibile.');
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? SESSION_TIMEOUT_MS) : undefined;
  let response: Response;
  let data: unknown = null;
  try {
    response = await fetchImpl(`${opts.baseUrl || ''}${CLOUD_API_PATH}?op=session`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${idToken}` },
      signal: controller?.signal,
      cache: 'no-store',
    });
    try { data = await response.json(); } catch { data = null; }
  } catch {
    throw new GestionaleSessionError('network', 'Il server di OptiRoute non è raggiungibile.');
  } finally {
    if (timer) clearTimeout(timer);
  }
  const code = data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
  if (response.status === 403) throw new GestionaleSessionError('forbidden', 'Area riservata agli amministratori.');
  if (response.status === 503 && code === 'gestionale_not_configured') {
    throw new GestionaleSessionError('not_configured', 'Sul server di OptiRoute il collegamento al gestionale non è configurato.');
  }
  if (response.status === 401) throw new GestionaleSessionError('auth', 'Accesso dal gestionale non riconosciuto.');
  const d = data as Partial<CloudSessionResponse> | null;
  if (!response.ok || !d || typeof d.token !== 'string' || !d.token || typeof d.expiresAt !== 'string') {
    throw new GestionaleSessionError('network', `Il server di OptiRoute non ha risposto come previsto (${response.status}).`);
  }
  return {
    token: d.token,
    expiresAt: d.expiresAt,
    user: { name: typeof d.user?.name === 'string' ? d.user.name : '', role: typeof d.user?.role === 'string' ? d.user.role : '' },
  };
};

const toSessionError = (err: unknown): GestionaleSessionError => {
  if (err instanceof GestionaleSessionError) return err;
  if (err instanceof GestionaleHostError && err.code !== 'timeout' && err.code !== 'closed' && err.code !== 'post') {
    return new GestionaleSessionError('auth', err.message);
  }
  return new GestionaleSessionError('network', 'Il gestionale non ha risposto in tempo.');
};

export class GestionaleSession {
  private readonly opts: GestionaleSessionOptions;
  private readonly clock: SessionClock;
  private token = '';
  private expiresAtMs = 0;
  private sessionUser: SessionUser | null = null;
  private inFlight: Promise<CredentialRefresh> | null = null;
  private timer: unknown = null;
  private destroyed = false;
  private readonly lostListeners = new Set<(err: GestionaleSessionError) => void>();

  // Credenziale per il client del cloud e per le chiamate (letta a ogni richiesta)
  readonly credential: CloudCredential = {
    get: () => this.token,
    refresh: () => this.refresh(),
  };

  constructor(opts: GestionaleSessionOptions) {
    this.opts = opts;
    this.clock = opts.clock || realClock;
  }

  get user(): SessionUser | null { return this.sessionUser; }
  get expiresAt(): number { return this.expiresAtMs; }
  current(): string { return this.token; }

  // Primo accesso: errore se non riesce (l'app mostra l'avviso)
  async start(): Promise<SessionUser> {
    try {
      await this.obtain();
    } catch (err) {
      throw toSessionError(err);
    }
    return this.sessionUser as SessionUser;
  }

  // Rinnovo (uno alla volta: chi arriva mentre è in corso aspetta lo stesso)
  refresh(): Promise<CredentialRefresh> {
    if (this.destroyed) return Promise.resolve('denied');
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async (): Promise<CredentialRefresh> => {
      try {
        await this.obtain();
        return 'ok';
      } catch (err) {
        const e = toSessionError(err);
        if (e.kind === 'network') {
          this.schedule(this.opts.retryMs ?? SESSION_RETRY_MS);
          return 'unavailable';
        }
        for (const l of this.lostListeners) l(e);
        return 'denied';
      }
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  // Accesso perso per sempre (es. non più amministratore)
  onLost(listener: (err: GestionaleSessionError) => void): () => void {
    this.lostListeners.add(listener);
    return () => { this.lostListeners.delete(listener); };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.lostListeners.clear();
  }

  private async obtain(): Promise<void> {
    const idToken = await this.opts.getIdToken();
    const session = await requestSession(idToken, { fetch: this.opts.fetch, baseUrl: this.opts.baseUrl });
    if (this.destroyed) return;
    this.token = session.token;
    const exp = new Date(session.expiresAt).getTime();
    this.expiresAtMs = Number.isFinite(exp) ? exp : this.clock.now() + 10 * 60 * 1000;
    this.sessionUser = session.user;
    const margin = this.opts.refreshMarginMs ?? SESSION_REFRESH_MARGIN_MS;
    this.schedule(Math.max(1000, this.expiresAtMs - margin - this.clock.now()));
  }

  private schedule(ms: number): void {
    if (this.destroyed) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, ms);
  }
}

// --- La pagina che contiene l'app è del gestionale? (verifica del server) ---

export type ParentCheck =
  | { kind: 'allowed' }
  | { kind: 'not_allowed' }    // pagina sconosciuta
  | { kind: 'disabled' }       // collegamento al gestionale spento sul server
  | { kind: 'network'; message: string };

export const checkParent = async (parentOrigin: string, opts: { fetch?: FetchLike; baseUrl?: string } = {}): Promise<ParentCheck> => {
  if (!parentOrigin) return { kind: 'not_allowed' };
  const ping = await cloudPing({ fetch: opts.fetch, baseUrl: opts.baseUrl, parent: parentOrigin });
  if (!ping.ok) return { kind: 'network', message: ping.error.message };
  const g = ping.data.gestionale;
  if (!g || !g.enabled) return { kind: 'disabled' };
  return g.parentAllowed ? { kind: 'allowed' } : { kind: 'not_allowed' };
};
