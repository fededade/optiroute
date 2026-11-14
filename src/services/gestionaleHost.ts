// Dialogo con la pagina del gestionale che contiene OptiRoute (contratto v1,
// "messaggi di pagina"). OptiRoute è la pagina INTERNA (iframe): manda
// richieste alla pagina che la contiene e ne riceve risposte ed eventi.
//
// Sicurezza: si scrive solo a `window.parent`, indicando l'origine del
// gestionale già verificata dal server (GET /api/cloud?op=ping&parent=...); si
// accettano solo messaggi che arrivano da `window.parent` E da quell'origine.
// Tutto il resto viene ignorato in silenzio.
//
// Modulo senza React e senza DOM diretto: la finestra è iniettata (test).

export const GESTIONALE_CHANNEL = 'optiroute-gestionale';
export const GESTIONALE_PROTOCOL = 1;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

// Il minimo di `window` che serve qui
export interface MessageEventLike {
  data: unknown;
  origin: string;
  source: unknown;
}
export interface ParentLike {
  postMessage(message: unknown, targetOrigin: string): void;
}
export interface WindowLike {
  parent: unknown;
  location: { origin?: string; ancestorOrigins?: { length: number; [index: number]: string } };
  document?: { referrer?: string };
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// --- Rilevamento ---

// L'app è dentro la pagina di un altro sito (o della stessa origine)?
export const isFramed = (win: { parent: unknown }): boolean => {
  try {
    return win.parent !== win;
  } catch {
    return true;
  }
};

const originOf = (raw: string | undefined): string => {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
};

// Origine "candidata" della pagina che contiene l'app: la dice il browser
// (location.ancestorOrigins, Chrome/Edge/Safari) o, in mancanza, l'indirizzo
// della pagina da cui si è arrivati (document.referrer). Va comunque
// verificata dal server: qui è solo un'ipotesi.
export const candidateParentOrigin = (win: Pick<WindowLike, 'location' | 'document'>): string => {
  try {
    const ancestors = win.location.ancestorOrigins;
    if (ancestors && ancestors.length > 0) {
      const o = originOf(ancestors[0]);
      if (o) return o;
    }
  } catch {
    // ancestorOrigins non leggibile
  }
  return originOf(win.document?.referrer);
};

// --- Messaggi ---

export interface HostError {
  code: string;      // es. "timeout", "unknown_method", o il codice del gestionale
  message: string;   // testo per l'operatore
}

export class GestionaleHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'GestionaleHostError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: GestionaleHostError) => void;
  timer: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

let idSeq = 0;
const defaultId = (): string => {
  idSeq += 1;
  const rnd = Math.random().toString(36).slice(2, 10);
  return `or-${Date.now().toString(36)}-${idSeq}-${rnd}`;
};

export interface GestionaleHostOptions {
  win: WindowLike;
  parentOrigin: string;          // origine verificata dal server
  timeoutMs?: number;
  newId?: () => string;
}

export type HostEventListener = (data: Record<string, unknown>) => void;

export class GestionaleHost {
  private readonly win: WindowLike;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly newId: () => string;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<HostEventListener>>();
  private started = false;
  private readonly onMessage = (event: MessageEventLike) => this.handle(event);

  constructor(opts: GestionaleHostOptions) {
    this.win = opts.win;
    this.origin = opts.parentOrigin;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.newId = opts.newId || defaultId;
  }

  get parentOrigin(): string { return this.origin; }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.win.addEventListener('message', this.onMessage);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.win.removeEventListener('message', this.onMessage);
    for (const [, p] of this.pending) {
      this.win.clearTimeout(p.timer);
      p.reject(new GestionaleHostError('closed', 'Collegamento con il gestionale chiuso.'));
    }
    this.pending.clear();
  }

  // Richiesta alla pagina del gestionale; si risolve con `result`, oppure
  // fallisce con il codice di errore del gestionale o "timeout"
  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    this.start();
    const id = this.newId();
    return new Promise<T>((resolve, reject) => {
      const timer = this.win.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new GestionaleHostError('timeout', 'Il gestionale non ha risposto in tempo.'));
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
      try {
        (this.win.parent as ParentLike).postMessage(
          { channel: GESTIONALE_CHANNEL, v: GESTIONALE_PROTOCOL, id, method, params },
          this.origin
        );
      } catch {
        this.win.clearTimeout(timer);
        this.pending.delete(id);
        reject(new GestionaleHostError('post', 'Impossibile comunicare con il gestionale.'));
      }
    });
  }

  // Evento dalla pagina del gestionale (es. "bridge.updated"); restituisce
  // la funzione per smettere di ascoltarlo
  on(event: string, listener: HostEventListener): () => void {
    this.start();
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return () => { set!.delete(listener); };
  }

  private handle(event: MessageEventLike): void {
    // Solo dalla pagina che ci contiene, e solo dall'origine verificata
    if (event.source !== this.win.parent || event.origin !== this.origin) return;
    const msg = event.data;
    if (!isObject(msg) || msg.channel !== GESTIONALE_CHANNEL || msg.v !== GESTIONALE_PROTOCOL) return;

    if (typeof msg.event === 'string') {
      const data = isObject(msg.data) ? msg.data : {};
      for (const l of this.listeners.get(msg.event) || []) {
        try { l(data); } catch { /* un ascoltatore in errore non blocca gli altri */ }
      }
      return;
    }

    if (typeof msg.id !== 'string') return;
    const p = this.pending.get(msg.id);
    if (!p) return; // risposta sconosciuta o già scaduta: ignorata
    this.pending.delete(msg.id);
    this.win.clearTimeout(p.timer);
    if (msg.ok === true) {
      p.resolve(isObject(msg.result) ? msg.result : {});
    } else {
      const err = isObject(msg.error) ? msg.error : {};
      p.reject(new GestionaleHostError(
        typeof err.code === 'string' && err.code ? err.code : 'error',
        typeof err.message === 'string' && err.message ? err.message : 'Errore dal gestionale.'
      ));
    }
  }
}

// --- Dati delle risposte ---

export interface GestionaleUser {
  name: string;
  email: string;
  role: string;
}

export interface HelloResult {
  user: GestionaleUser;
  environment: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const parseHello = (raw: unknown): HelloResult => {
  const r = isObject(raw) ? raw : {};
  const u = isObject(r.user) ? r.user : {};
  return { user: { name: str(u.name), email: str(u.email), role: str(u.role) }, environment: str(r.environment) };
};

export const hello = async (host: GestionaleHost, timeoutMs?: number): Promise<HelloResult> =>
  parseHello(await host.request('hello', { app: 'optiroute', version: GESTIONALE_PROTOCOL }, { timeoutMs }));

export const requestIdToken = async (host: GestionaleHost): Promise<string> => {
  const r = await host.request<Record<string, unknown>>('token', {});
  const token = str(r.idToken);
  if (!token) throw new GestionaleHostError('token', 'Il gestionale non ha fornito l\'accesso.');
  return token;
};
