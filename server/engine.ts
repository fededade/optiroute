import { randomUUID } from 'node:crypto';
import type { AlternativeSlot, Appointment, CallOutcome } from '../src/types';
import type { CloudConfig, TickSource, TickSummary } from '../src/services/cloudProtocol';
import {
  CALL_OUTCOME_MAX_AGE_MS,
  DEFAULT_AUTOPILOT_SETTINGS,
  alternativesForCall,
  autopilotStats,
  expireStaleAutoCalls,
  isWithinCallWindow,
  nextDueCall,
  reduceCallLaunchResult,
  reduceCallOutcome,
  reduceCallStarted,
  type PlanningContext,
} from '../src/services/autopilotService';
import { toCallOutcome } from '../src/services/callService';
import { buildDaySchedule } from '../src/services/dayScheduleService';
import type { RetellCallBody } from '../api/retell-call';
import { timezoneStatus, type TimezoneStatus } from './tz';
import { ConflictError, StoreError, commit, type Store } from './store';
import type { RetellClient } from './retell';

// Motore del pilota automatico lato server: un "passaggio" (tick) riproduce
// quello che fa il browser (useAutopilot, performAutoCall, polling degli
// esiti, applyCallOutcome) usando gli stessi riduttori PURI. Ogni modifica
// passa da `commit` (compare-and-set sulla rev): una modifica dell'operatore
// arrivata nel mezzo non si perde e una pratica non può essere presa due volte.
// Il passaggio non lancia mai eccezioni: gli errori finiscono nel riepilogo,
// con testi generici (mai dati personali).

export const LOCK_TTL_MS = 55_000;
export const LAUNCH_GAP_MS = 1500;
export const STALE_LAUNCH_MS = 3 * 60_000;     // "calling" senza callId da più di 3 minuti: lancio interrotto
export const RECENT_TICK_MS = 3000;            // webhook: salta se un passaggio è finito da meno di 3 s
export const DEFAULT_BUDGET_MS: Record<TickSource, number> = { scheduler: 40_000, browser: 40_000, webhook: 8000 };

const OUTCOME_CONCURRENCY = 4;
const CREATE_TIMEOUT_MS = 15_000;
const WEBHOOK_MIN_LAUNCH_MS = 3500;            // webhook: budget minimo residuo per avviare una chiamata

export const INTERRUPTED_LAUNCH_SUMMARY = 'Avvio della chiamata interrotto';
export const OUTCOME_TIMEOUT_SUMMARY = 'Esito non ricevuto nei tempi: controlla la dashboard Retell.';

export interface EngineDeps {
  store: Store;
  now: () => Date;                         // ora di calendario (iniettabile nei test)
  retell: RetellClient;
  clock?: () => number;                    // tempo reale per budget e pause (default Date.now)
  sleep?: (ms: number) => Promise<void>;
  timezone?: () => TimezoneStatus;
}

export interface TickOptions {
  budgetMs?: number;
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Configurazione con i valori di default per i campi mancanti
export const planningFrom = (config: CloudConfig, now: Date): PlanningContext => ({
  technicians: Array.isArray(config.technicians) ? config.technicians : [],
  fallback: config.fallback,
  settings: { ...DEFAULT_AUTOPILOT_SETTINGS, ...(config.autopilot || {}) },
  now,
});

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Stesso elenco se nessun elemento è cambiato (evita scritture inutili)
const keepIfSame = (before: Appointment[], after: Appointment[]): Appointment[] =>
  after.length === before.length && after.every((a, i) => a === before[i]) ? before : after;

// 1) Lanci rimasti a metà: "calling" senza callId e avviati da più di 3
// minuti (o senza istante di avvio). Non si sa se il telefono ha squillato:
// niente richiamo automatico, finisce fra le cose da gestire.
export const recoverInterruptedLaunches = (all: Appointment[], now: Date): Appointment[] =>
  keepIfSame(
    all,
    all.map(a => {
      if (a.callStatus !== 'calling' || a.callId) return a;
      const started = a.callStartedAt ? new Date(a.callStartedAt).getTime() : NaN;
      if (Number.isFinite(started) && now.getTime() - started < STALE_LAUNCH_MS) return a;
      return {
        ...a,
        callStatus: 'failed' as const,
        callSummary: INTERRUPTED_LAUNCH_SUMMARY,
        calledAt: now.toISOString(),
        autoCall: undefined,
        autoCallNotBefore: undefined,
      };
    })
  );

const countChanged = (before: Appointment[], after: Appointment[]): number => {
  if (before === after) return 0;
  const byId = new Map(before.map(a => [a.id, a]));
  return after.filter(a => byId.get(a.id) !== a).length;
};

// Pratiche con una chiamata partita e senza esito
const awaitingOutcome = (a: Appointment): boolean =>
  !!a.callId && !a.callOutcome && (a.callStatus === 'called' || a.callStatus === 'calling');

// Body della chiamata: gli stessi campi che invia il browser (callService)
export const callBodyFor = (
  appt: Appointment,
  all: Appointment[],
  config: CloudConfig,
  now: Date,
  alternatives: AlternativeSlot[]
): RetellCallBody => {
  const technicians = Array.isArray(config.technicians) ? config.technicians : [];
  const tech = technicians.find(t => t.id === appt.technicianId);
  return {
    phone: appt.phone,
    clientName: appt.title,
    date: appt.date,
    startTime: appt.startTime,
    endTime: appt.endTime,
    address: appt.address,
    shortAddress: appt.shortAddress,
    comune: appt.comune,
    notes: appt.notes,
    urgent: appt.urgent === true,
    technicianName: tech?.name || undefined,
    periziaCode: appt.periziaCode,
    project: appt.project,
    contactPerson: appt.contactPerson,
    referredBy: appt.referredBy,
    daySchedule: buildDaySchedule(appt, all, technicians, config.fallback, localDay(now)) || undefined,
    alternatives: alternatives.length > 0 ? alternatives : undefined,
  };
};

const emptySummary = (): TickSummary => ({
  outcomesApplied: 0,
  callsLaunched: 0,
  callsFailed: 0,
  recovered: 0,
  expired: 0,
  inFlight: 0,
  queued: 0,
  windowOpen: false,
  pilotEnabled: false,
  durationMs: 0,
});

// Testo d'errore generico per il riepilogo (mai dettagli sensibili)
const errorText = (err: unknown): string => {
  if (err instanceof ConflictError) return 'Troppe modifiche concorrenti: riprova al prossimo passaggio';
  if (err instanceof StoreError) return 'Errore del database';
  return 'Errore interno del motore';
};

const logError = (where: string, err: unknown) => {
  const code = err instanceof StoreError ? err.code : err instanceof Error ? err.name : 'sconosciuto';
  console.error(`pilota cloud: errore (${where}): ${code}`);
};

// Esegue `fn` a gruppi di `limit` in parallelo
const forEachLimited = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>) => {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
};

export const runTick = async (deps: EngineDeps, source: TickSource, opts: TickOptions = {}): Promise<TickSummary> => {
  const clock = deps.clock || Date.now;
  const sleep = deps.sleep || realSleep;
  const started = clock();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS[source];
  const remaining = () => budgetMs - (clock() - started);
  const summary = emptySummary();
  const store = deps.store;
  let record = true; // registra il passaggio nei metadati

  const finish = async (): Promise<TickSummary> => {
    summary.durationMs = Math.max(0, clock() - started);
    if (record) {
      try {
        await store.updateMeta({
          lastTick: { at: deps.now().toISOString(), source, summary },
          lastTickWallMs: clock(),
        });
      } catch (err) {
        logError('metadati', err);
      }
    }
    return summary;
  };

  let config: CloudConfig | null = null;
  try {
    const cfg = await store.readConfig();
    config = cfg.config;
    if (config) {
      const ctx0 = planningFrom(config, deps.now());
      summary.pilotEnabled = ctx0.settings.enabled;
      summary.windowOpen = isWithinCallWindow(ctx0.now, ctx0.settings);
    }

    // 0) Autocontrollo del fuso: con l'ora sbagliata si telefonerebbe fuori fascia
    if (!(deps.timezone || timezoneStatus)().ok) {
      summary.skipped = 'timezone';
      return await finish();
    }
    if (!config) {
      summary.skipped = 'no_state';
      return await finish();
    }
    if (source === 'webhook') {
      const meta = await store.readMeta();
      if (meta.lastTickWallMs !== null && clock() - meta.lastTickWallMs < RECENT_TICK_MS) {
        summary.skipped = 'recent';
        record = false;
        return await finish();
      }
    }
    const initial = await store.readAppointments();
    if (!initial.appointments) {
      summary.skipped = 'no_state';
      return await finish();
    }
  } catch (err) {
    logError('avvio', err);
    summary.error = errorText(err);
    return await finish();
  }

  const owner = `${source}-${randomUUID()}`;
  try {
    if (!(await store.acquireLock(owner, LOCK_TTL_MS))) {
      summary.skipped = 'locked';
      record = false;
      return await finish();
    }
  } catch (err) {
    logError('lock', err);
    summary.error = errorText(err);
    return await finish();
  }

  const cfg = config as CloudConfig;
  try {
    // 1) Lanci interrotti e 2) slot trascorsi tolti dalla coda
    {
      const now = deps.now();
      let recovered = 0;
      let expired = 0;
      await commit(store, all => {
        const rec = recoverInterruptedLaunches(all, now);
        const exp = keepIfSame(rec, expireStaleAutoCalls(rec, now));
        recovered = countChanged(all, rec);
        expired = countChanged(rec, exp);
        return exp;
      });
      summary.recovered = recovered;
      summary.expired = expired;
    }

    // 3) Esiti delle chiamate concluse
    if (deps.retell.configured()) {
      const { appointments } = await store.readAppointments();
      const targets = (appointments || []).filter(awaitingOutcome);
      const found: { id: string; callId: string; outcome: CallOutcome }[] = [];
      await forEachLimited(targets, OUTCOME_CONCURRENCY, async appt => {
        if (remaining() <= 0) return;
        const callId = appt.callId as string;
        const lookup = await deps.retell.getCall(callId, Math.max(1000, Math.min(8000, remaining())));
        const now = deps.now();
        if (lookup.kind === 'done') {
          found.push({ id: appt.id, callId, outcome: toCallOutcome(lookup.outcome, now) });
          return;
        }
        if (lookup.kind === 'error' && lookup.transient) return; // si riprova al prossimo passaggio
        // Ancora in corso (o chiamata sconosciuta a Retell): oltre il limite
        // si chiude a "sconosciuto", come fa il browser
        const since = appt.calledAt || appt.callStartedAt;
        const age = since ? now.getTime() - new Date(since).getTime() : Infinity;
        if (age >= CALL_OUTCOME_MAX_AGE_MS) {
          found.push({
            id: appt.id,
            callId,
            outcome: { result: 'sconosciuto', summary: OUTCOME_TIMEOUT_SUMMARY, receivedAt: now.toISOString() },
          });
        }
      });
      if (found.length > 0) {
        let applied = 0;
        await commit(store, all => {
          applied = 0;
          const ctx = planningFrom(cfg, deps.now());
          let list = all;
          for (const f of found) {
            const next = reduceCallOutcome(list, f.id, f.outcome, f.callId, ctx);
            if (next !== list) applied++;
            list = next;
          }
          return list;
        });
        summary.outcomesApplied = applied;
      }
    }

    // 4) Lanci delle chiamate dovute
    const settings = planningFrom(cfg, deps.now()).settings;
    if (settings.enabled) {
      if (!deps.retell.configured()) {
        const { appointments } = await store.readAppointments();
        if (nextDueCall(appointments || [], planningFrom(cfg, deps.now()))) {
          summary.error = 'Chiamate AI non configurate sul server (RETELL_API_KEY, RETELL_FROM_NUMBER)';
        }
      } else {
        const minRemaining = source === 'webhook' ? WEBHOOK_MIN_LAUNCH_MS : 0;
        let launchedBefore = false;
        while (remaining() > minRemaining) {
          if (launchedBefore) {
            await sleep(LAUNCH_GAP_MS);
            if (remaining() <= minRemaining) break;
          }
          const ts = deps.now();
          let picked: Appointment | null = null;
          let alternatives: AlternativeSlot[] = [];
          // Scelta e marcatura nello stesso compare-and-set: due passaggi
          // concorrenti non possono prendere la stessa pratica
          const marked = await commit(store, all => {
            picked = null;
            alternatives = [];
            const ctx = planningFrom(cfg, ts);
            const next = nextDueCall(all, ctx);
            if (!next) return all;
            picked = next;
            alternatives = alternativesForCall(next, all, ctx);
            return reduceCallStarted(all, next.id, alternatives, ts);
          });
          const chosen = picked as Appointment | null;
          if (!chosen) break;
          const current = marked.appointments.find(a => a.id === chosen.id) || chosen;
          const body = callBodyFor(current, marked.appointments, cfg, ts, alternatives);
          const timeoutMs = source === 'webhook'
            ? Math.max(3000, Math.min(6000, remaining() - 500))
            : CREATE_TIMEOUT_MS;
          const launch = await deps.retell.createCall(body, timeoutMs).catch(
            () => ({ ok: false as const, error: 'Impossibile avviare la chiamata. Riprova.' })
          );
          launchedBefore = true;
          const result = launch.ok ? { ok: true, callId: launch.callId } : { ok: false, error: launch.error };
          // L'esito del lancio va registrato a ogni costo: senza, la pratica
          // resterebbe "in chiamata" fino al recupero (senza richiamo)
          let saved = false;
          for (let attempt = 0; attempt < 3 && !saved; attempt++) {
            try {
              const doneAt = deps.now();
              await commit(store, all => reduceCallLaunchResult(all, chosen.id, result, doneAt));
              saved = true;
            } catch (err) {
              if (attempt === 2) throw err;
              await sleep(300);
            }
          }
          if (launch.ok) summary.callsLaunched++;
          else summary.callsFailed++;
        }
      }
    }
  } catch (err) {
    logError('passaggio', err);
    summary.error = errorText(err);
  } finally {
    try {
      await store.releaseLock(owner);
    } catch (err) {
      logError('rilascio lock', err); // scade da solo dopo LOCK_TTL_MS
    }
  }

  // 5) Fotografia finale per il riepilogo
  try {
    const { appointments } = await store.readAppointments();
    const stats = autopilotStats(appointments || [], planningFrom(cfg, deps.now()));
    summary.inFlight = stats.inFlight;
    summary.queued = stats.queued;
    summary.windowOpen = stats.windowOpen;
  } catch (err) {
    logError('riepilogo', err);
    if (!summary.error) summary.error = errorText(err);
  }
  return await finish();
};
