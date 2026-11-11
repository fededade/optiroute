import type { Appointment } from '../types';
import {
  diffAppointments,
  rebaseAppointments,
  type AppointmentChange,
  type AutomationLease,
  type CloudConfig,
  type CloudSnapshot,
  type CloudStatus,
  type TickSource,
  type TickSummary,
} from './cloudProtocol';
import {
  cloudInit,
  cloudPull,
  cloudPush,
  cloudStatus,
  cloudTick,
  type CloudClientOptions,
  type CloudFailure,
  type CloudResult,
  type FetchLike,
} from './cloudSync';

// Nucleo della sincronizzazione browser <-> cloud, senza React: dipendenze
// iniettate (fetch, orologio, "host" che legge e scrive lo stato dell'app),
// così si prova con fetch e orologio finti.
//
// Regole:
//  - `base` è l'ultimo elenco ricevuto dal server. Una modifica locale fa
//    partire (dopo un debounce) una push con le sole differenze base -> attuale;
//    alla risposta l'elenco locale diventa rebase(server, inviato, attuale):
//    le modifiche fatte mentre la richiesta era in volo restano.
//  - Una sola richiesta alla volta. Ordine di priorità: primo pull completo,
//    push delle modifiche locali, pull, passaggio del motore, stato.
//  - Mai un pull con modifiche locali in attesa: prima si inviano (la push
//    restituisce comunque lo stato completo del server).
//  - Errori di rete/server/conflitto: si riprova con attese crescenti
//    (2, 5, 15, 30 s), tenendo le modifiche. Chiave errata o server non
//    configurato: ci si ferma e lo si mostra.
//  - Configurazione: inviata quando cambia qui, adottata quando il server ne
//    ha una diversa dall'ultima sincronizzata. Adottarla NON genera una push.

export const PUSH_DEBOUNCE_MS = 400;
export const PULL_VISIBLE_MS = 10000;
export const PULL_HIDDEN_MS = 30000;
export const TICK_INTERVAL_MS = 30000;
export const TICK_AFTER_QUEUE_CHANGE_MS = 1000;
export const STATUS_INTERVAL_MS = 120000;
export const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];
// Lo scheduler di Vercel passa ogni pochi minuti: visto negli ultimi 45
// minuti = si può chiudere il browser
export const SCHEDULER_FRESH_MS = 45 * 60 * 1000;

export interface SyncClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const realClock: SyncClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CloudSyncHost {
  getAppointments: () => Appointment[];
  // Adotta un elenco fuso con quello del server (deve aggiornare subito
  // quello che getAppointments restituisce)
  setAppointments: (list: Appointment[]) => void;
  getConfig: () => CloudConfig;
  // Applica la configurazione del server; restituisce quella effettivamente
  // in uso dopo l'applicazione (es. completata con i default)
  applyConfig: (config: CloudConfig) => CloudConfig | void;
  isVisible?: () => boolean;
}

export type CloudSyncPhase =
  | 'starting'        // primo scaricamento in corso
  | 'synced'          // tutto inviato e ricevuto
  | 'sending'         // invio in corso / modifiche in attesa di invio
  | 'offline'         // non raggiungibile: si riprova
  | 'auth'            // chiave errata: fermo
  | 'not_configured'; // server non configurato: fermo

export interface CloudLastTick {
  at: string;
  source: TickSource;
  summary: TickSummary;
}

export interface CloudSyncState {
  phase: CloudSyncPhase;
  lastSyncAt: number | null;     // ultimo scambio riuscito
  pending: boolean;              // modifiche locali non ancora sul server
  retryAt: number | null;        // prossimo tentativo dopo un errore
  error: CloudFailure | null;    // ultimo errore
  lease: AutomationLease | null; // turno degli automatismi rimasti nel browser
  status: CloudStatus | null;    // ultimo stato del server (op=status)
  lastTick: CloudLastTick | null;      // ultimo passaggio del motore
  lastActivity: CloudLastTick | null;  // ultimo passaggio che ha avviato chiamate o applicato esiti
  rev: number;
  configRev: number;
}

export interface CloudSyncOptions {
  key: string;
  deviceId: string;
  host: CloudSyncHost;
  fetch?: FetchLike;
  clock?: SyncClock;
  onState?: (state: CloudSyncState) => void;
  timers?: { tick?: boolean; status?: boolean }; // passaggi periodici (default: sì)
}

// JSON con le chiavi in ordine: confronto delle configurazioni indipendente
// dall'ordine dei campi (e i campi undefined spariscono, come in rete)
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
};

// Le differenze toccano la coda del pilota? (es. "Approva e chiama")
export const changesTouchQueue = (changes: AppointmentChange[]): boolean =>
  changes.some(c =>
    (c.op === 'put' && !!c.value.autoCall) ||
    (c.op === 'patch' && ('autoCall' in c.set || 'autoCallNotBefore' in c.set || c.unset.includes('autoCall')))
  );

const FATAL: CloudFailure['kind'][] = ['auth', 'not_configured'];

export class CloudSyncEngine {
  private readonly opts: CloudSyncOptions;
  private readonly clock: SyncClock;
  private readonly client: CloudClientOptions;

  private base: Appointment[];          // ultimo elenco del server (prima: elenco locale all'avvio)
  private rev = -1;
  private configRev = -1;
  private lastSyncedConfig: string | null = null;

  private started = false;              // primo pull completato
  private inFlight = false;
  private dirty = false;                // modifiche locali da valutare/inviare
  private pullWanted = false;
  private tickWanted = false;
  private statusWanted = true;
  private nextPushKeepalive = false;
  private fatal = false;
  private destroyed = false;
  private retryIndex = 0;

  private debounceTimer: unknown = null;
  private retryTimer: unknown = null;
  private pollTimer: unknown = null;
  private tickTimer: unknown = null;
  private tickSoonTimer: unknown = null;
  private statusTimer: unknown = null;

  private state: CloudSyncState;

  constructor(opts: CloudSyncOptions) {
    this.opts = opts;
    this.clock = opts.clock || realClock;
    this.client = { key: opts.key, fetch: opts.fetch };
    this.base = opts.host.getAppointments();
    this.state = {
      phase: 'starting', lastSyncAt: null, pending: false, retryAt: null, error: null,
      lease: null, status: null, lastTick: null, lastActivity: null, rev: -1, configRev: -1,
    };
  }

  getState(): CloudSyncState { return this.state; }

  start(): void {
    if (this.destroyed) return;
    this.schedulePoll();
    if (this.opts.timers?.tick !== false) this.scheduleTick();
    if (this.opts.timers?.status !== false) this.scheduleStatus();
    this.pump();
  }

  destroy(): void {
    this.destroyed = true;
    for (const t of [this.debounceTimer, this.retryTimer, this.pollTimer, this.tickTimer, this.tickSoonTimer, this.statusTimer]) {
      if (t !== null) this.clock.clearTimeout(t);
    }
    this.debounceTimer = this.retryTimer = this.pollTimer = this.tickTimer = this.tickSoonTimer = this.statusTimer = null;
  }

  // L'elenco o la configurazione locale sono cambiati
  localChanged(): void {
    if (this.destroyed || this.fatal) return;
    this.dirty = true;
    this.updateState({ pending: this.hasLocalChanges() });
    if (this.debounceTimer !== null) this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      this.pump();
    }, PUSH_DEBOUNCE_MS);
  }

  // Pagina nascosta o in chiusura: le modifiche partono subito, con keepalive
  // (la richiesta sopravvive alla chiusura della pagina)
  flushNow(options: { keepalive?: boolean; closing?: boolean } = {}): void {
    if (this.destroyed || this.fatal || !this.started) return;
    if (!this.hasLocalChanges()) return;
    if (this.debounceTimer !== null) { this.clock.clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.dirty = true;
    if (options.closing && (this.inFlight || this.retryTimer !== null)) {
      // La pagina si sta chiudendo e non si può attendere: invio diretto
      const changes = diffAppointments(this.base, this.opts.host.getAppointments());
      const config = this.configToSend();
      void cloudPush(this.client, { device: this.opts.deviceId, changes, config: config || undefined }, { keepalive: true });
      return;
    }
    if (this.retryTimer !== null) { this.clock.clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.nextPushKeepalive = options.keepalive === true;
    this.pump();
  }

  // Chiede subito un passaggio del motore (poi un pull)
  requestTick(delayMs = 0): void {
    if (this.destroyed || this.fatal) return;
    if (delayMs <= 0) { this.tickWanted = true; this.pump(); return; }
    if (this.tickSoonTimer !== null) this.clock.clearTimeout(this.tickSoonTimer);
    this.tickSoonTimer = this.clock.setTimeout(() => {
      this.tickSoonTimer = null;
      this.tickWanted = true;
      this.pump();
    }, delayMs);
  }

  requestPull(): void {
    if (this.destroyed || this.fatal) return;
    this.pullWanted = true;
    this.pump();
  }

  requestStatus(): void {
    if (this.destroyed || this.fatal) return;
    this.statusWanted = true;
    this.pump();
  }

  // Visibilità cambiata: il ritmo del pull si adegua
  visibilityChanged(): void {
    if (this.destroyed) return;
    this.schedulePoll();
  }

  // --- interno ---

  private configToSend(): CloudConfig | null {
    const config = this.opts.host.getConfig();
    return stableStringify(config) === this.lastSyncedConfig ? null : config;
  }

  private hasLocalChanges(): boolean {
    if (!this.started) return false;
    return diffAppointments(this.base, this.opts.host.getAppointments()).length > 0 || this.configToSend() !== null;
  }

  private updateState(patch: Partial<CloudSyncState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState?.(this.state);
  }

  private schedulePoll(): void {
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    const visible = this.opts.host.isVisible ? this.opts.host.isVisible() : true;
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      this.pullWanted = true;
      this.pump();
      this.schedulePoll();
    }, visible ? PULL_VISIBLE_MS : PULL_HIDDEN_MS);
  }

  private scheduleTick(): void {
    this.tickTimer = this.clock.setTimeout(() => {
      this.tickTimer = null;
      this.tickWanted = true;
      this.pump();
      if (!this.destroyed) this.scheduleTick();
    }, TICK_INTERVAL_MS);
  }

  private scheduleStatus(): void {
    this.statusTimer = this.clock.setTimeout(() => {
      this.statusTimer = null;
      this.statusWanted = true;
      this.pump();
      if (!this.destroyed) this.scheduleStatus();
    }, STATUS_INTERVAL_MS);
  }

  // Sceglie la prossima richiesta (una alla volta)
  private pump(): void {
    if (this.destroyed || this.fatal || this.inFlight || this.retryTimer !== null) return;
    if (!this.started) { void this.run('pull-full'); return; }
    if (this.dirty && this.debounceTimer === null) {
      const changes = diffAppointments(this.base, this.opts.host.getAppointments());
      const config = this.configToSend();
      if (changes.length > 0 || config) { void this.run('push', { changes, config }); return; }
      this.dirty = false;
      this.updateState({ pending: false, phase: this.state.phase === 'sending' ? 'synced' : this.state.phase });
    }
    // Modifiche in attesa del debounce: niente pull adesso
    if (this.debounceTimer !== null) return;
    if (this.pullWanted) { void this.run('pull'); return; }
    if (this.tickWanted) { void this.run('tick'); return; }
    if (this.statusWanted) { void this.run('status'); return; }
  }

  private async run(
    kind: 'pull-full' | 'pull' | 'push' | 'tick' | 'status',
    payload?: { changes: AppointmentChange[]; config: CloudConfig | null }
  ): Promise<void> {
    this.inFlight = true;
    const device = this.opts.deviceId;
    let result: CloudResult<unknown>;
    try {
      if (kind === 'pull-full' || kind === 'pull') {
        const full = kind === 'pull-full';
        this.pullWanted = false;
        result = await cloudPull(this.client, { rev: full ? -1 : this.rev, configRev: full ? -1 : this.configRev, device });
        if (this.destroyed) return;
        if (result.ok) this.applySnapshot(result.data as CloudSnapshot, { initial: full });
      } else if (kind === 'push') {
        const sentList = this.opts.host.getAppointments();
        const { changes, config } = payload!;
        const keepalive = this.nextPushKeepalive;
        this.nextPushKeepalive = false;
        this.dirty = false;
        this.updateState({ phase: 'sending', pending: true });
        result = await cloudPush(this.client, { device, changes, config: config || undefined }, { keepalive });
        if (this.destroyed) return;
        if (result.ok) {
          this.applySnapshot(result.data as CloudSnapshot, { sentList, sentConfig: config });
          // Coda del pilota cambiata (o pilota acceso/spento): il motore
          // lavora subito, non al prossimo passaggio
          const pilotToggled = !!config && config.autopilot?.enabled === true;
          if (changesTouchQueue(changes) || pilotToggled) this.requestTick(TICK_AFTER_QUEUE_CHANGE_MS);
        } else {
          this.dirty = true; // le modifiche restano da inviare
        }
      } else if (kind === 'tick') {
        this.tickWanted = false;
        result = await cloudTick(this.client, { device });
        if (this.destroyed) return;
        if (result.ok) {
          const data = result.data as { summary: TickSummary; rev: number; configRev: number };
          this.noteTick({ at: new Date(this.clock.now()).toISOString(), source: 'browser', summary: data.summary });
          if (data.rev !== this.rev || data.configRev !== this.configRev) this.pullWanted = true;
        }
      } else {
        this.statusWanted = false;
        result = await cloudStatus(this.client);
        if (this.destroyed) return;
        if (result.ok) {
          const status = result.data as CloudStatus;
          this.updateState({ status });
          if (status.lastTick) this.noteTick(status.lastTick);
        }
      }
    } catch (err) {
      result = { ok: false, error: { kind: 'server', status: 0, message: err instanceof Error ? err.message : 'errore' } };
    } finally {
      this.inFlight = false;
    }
    if (this.destroyed) return;

    if (result.ok) {
      this.retryIndex = 0;
      const pending = this.hasLocalChanges();
      if (pending) {
        // Modifiche arrivate mentre la richiesta era in volo: partono subito
        this.dirty = true;
        if (this.debounceTimer !== null) { this.clock.clearTimeout(this.debounceTimer); this.debounceTimer = null; }
      }
      this.updateState({
        phase: pending ? 'sending' : 'synced',
        pending,
        lastSyncAt: this.clock.now(),
        retryAt: null,
        error: null,
      });
      this.pump();
      return;
    }

    const error = result.error;
    if (FATAL.includes(error.kind)) {
      this.fatal = true;
      this.updateState({ phase: error.kind === 'auth' ? 'auth' : 'not_configured', error, retryAt: null, pending: this.hasLocalChanges() });
      this.destroyTimersOnly();
      return;
    }
    // Transitorio: si riprova con attese crescenti, senza perdere nulla
    if (kind === 'pull' || kind === 'pull-full') this.pullWanted = true;
    if (kind === 'tick') this.tickWanted = true;
    if (kind === 'status') this.statusWanted = true;
    const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)];
    this.retryIndex += 1;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, delay);
    this.updateState({ phase: 'offline', error, retryAt: this.clock.now() + delay, pending: this.hasLocalChanges() || kind === 'push' });
  }

  // Passaggio del motore (nostro o visto dal server): si tiene il più recente
  // e il più recente che ha fatto qualcosa (chiamate avviate, esiti applicati)
  private noteTick(tick: CloudLastTick): void {
    const s = tick.summary;
    const active = !!s && (s.callsLaunched > 0 || s.outcomesApplied > 0 || s.callsFailed > 0);
    const patch: Partial<CloudSyncState> = {};
    if (!this.state.lastTick || tick.at >= this.state.lastTick.at) patch.lastTick = tick;
    if (active && (!this.state.lastActivity || tick.at >= this.state.lastActivity.at)) patch.lastActivity = tick;
    if (Object.keys(patch).length > 0) this.updateState(patch);
  }

  private destroyTimersOnly(): void {
    for (const t of [this.debounceTimer, this.retryTimer, this.pollTimer, this.tickTimer, this.tickSoonTimer, this.statusTimer]) {
      if (t !== null) this.clock.clearTimeout(t);
    }
    this.debounceTimer = this.retryTimer = this.pollTimer = this.tickTimer = this.tickSoonTimer = this.statusTimer = null;
  }

  private applySnapshot(
    snap: CloudSnapshot,
    ctx: { initial?: boolean; sentList?: Appointment[]; sentConfig?: CloudConfig | null }
  ): void {
    const host = this.opts.host;
    const patch: Partial<CloudSyncState> = {};
    if (snap.lease !== undefined) patch.lease = snap.lease;

    if (Array.isArray(snap.appointments)) {
      const server = snap.appointments;
      const current = host.getAppointments();
      // push: si riportano le modifiche fatte DOPO l'invio; pull: quelle
      // non ancora inviate (all'avvio: quelle fatte dall'apertura della pagina)
      const from = ctx.sentList || this.base;
      const merged = rebaseAppointments(server, from, current);
      this.base = server;
      if (diffAppointments(current, merged).length > 0) host.setAppointments(merged);
      this.rev = snap.rev;
    } else if (snap.unchanged) {
      this.rev = snap.rev;
    }

    if (snap.config !== undefined) {
      this.configRev = snap.configRev;
      this.handleServerConfig(snap.config, ctx);
    } else if (snap.unchanged) {
      this.configRev = snap.configRev;
    }

    if (ctx.initial) this.started = true;
    patch.rev = this.rev;
    patch.configRev = this.configRev;
    this.updateState(patch);
  }

  private handleServerConfig(serverConfig: CloudConfig | null, ctx: { initial?: boolean; sentConfig?: CloudConfig | null }): void {
    if (ctx.sentConfig) this.lastSyncedConfig = stableStringify(ctx.sentConfig);
    if (!serverConfig) return; // cloud senza configurazione: la nostra partirà con la prossima push
    const serverJson = stableStringify(serverConfig);
    if (serverJson === this.lastSyncedConfig) return;
    const localJson = stableStringify(this.opts.host.getConfig());
    if (ctx.initial || this.lastSyncedConfig === null || localJson === this.lastSyncedConfig) {
      // Nessuna modifica locale in sospeso: si adotta quella del server
      const applied = this.opts.host.applyConfig(serverConfig);
      this.lastSyncedConfig = stableStringify(applied || serverConfig);
    } else {
      // Modificata qui E sul server: vince quella locale (partirà con la
      // prossima push); il riferimento diventa quella del server
      this.lastSyncedConfig = serverJson;
      this.dirty = true;
    }
  }
}

// --- Attivazione del cloud su questo browser ---

export type ActivationPlan =
  | 'upload'  // cloud vuoto: si caricano le pratiche di questo browser (init)
  | 'adopt'   // browser vuoto: si adottano quelle del cloud
  | 'choose'; // entrambi hanno pratiche: decide l'operatore

export const planActivation = (serverCount: number, localCount: number): ActivationPlan => {
  if (serverCount === 0) return 'upload';
  if (localCount === 0) return 'adopt';
  return 'choose';
};

export type ActivationOutcome =
  | { kind: 'done'; plan: 'upload' | 'adopt'; serverCount: number }
  | { kind: 'choose'; serverCount: number; localCount: number }
  | { kind: 'error'; error: CloudFailure };

// Primo passo: guarda il cloud e, se uno dei due lati è vuoto, procede da
// solo (init o adozione). Con pratiche su entrambi i lati restituisce
// 'choose': la scelta è dell'operatore (useCloudData / replaceCloudData).
export const startActivation = async (
  client: CloudClientOptions,
  local: { deviceId: string; appointments: Appointment[]; config: CloudConfig }
): Promise<ActivationOutcome> => {
  const status = await cloudStatus(client);
  if (!status.ok) return { kind: 'error', error: status.error };
  const plan = planActivation(status.data.appointmentCount, local.appointments.length);
  if (plan === 'choose') return { kind: 'choose', serverCount: status.data.appointmentCount, localCount: local.appointments.length };
  if (plan === 'adopt') return { kind: 'done', plan, serverCount: status.data.appointmentCount };
  const init = await cloudInit(client, { device: local.deviceId, appointments: local.appointments, config: local.config });
  if (!init.ok) return { kind: 'error', error: init.error };
  return { kind: 'done', plan, serverCount: local.appointments.length };
};

// Scelta distruttiva (dopo conferma esplicita): il cloud prende i dati di
// questo browser
export const replaceCloudData = async (
  client: CloudClientOptions,
  local: { deviceId: string; appointments: Appointment[]; config: CloudConfig }
): Promise<CloudResult<CloudSnapshot>> =>
  cloudInit(client, { device: local.deviceId, appointments: local.appointments, config: local.config });

// Lo scheduler è passato di recente?
export const schedulerFresh = (seenAt: string | null | undefined, now: number): boolean => {
  if (!seenAt) return false;
  const t = new Date(seenAt).getTime();
  return !isNaN(t) && now - t < SCHEDULER_FRESH_MS;
};
