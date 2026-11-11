import { useCallback, useEffect, useRef } from 'react';
import type { Appointment } from '../types';
import { expireStaleAutoCalls, nextDueCall, type PlanningContext } from '../services/autopilotService';

// Motore del pilota automatico delle chiamate. Ogni ~15 secondi (e subito
// quando cambia la coda) toglie dalla coda gli slot già trascorsi e, se c'è
// una pratica da chiamare dentro la fascia oraria, lancia la chiamata con lo
// stesso percorso delle chiamate manuali. Un solo lancio alla volta, almeno
// 1,5 s fra un lancio e l'altro. Lo stato si legge SEMPRE dal ref (aggiornato
// in modo sincrono da `commit`), mai da closure stantie: il passo successivo
// vede già la pratica in chiamata e non può lanciarla due volte.

export const AUTOPILOT_TICK_MS = 15000;
export const AUTOPILOT_LAUNCH_GAP_MS = 1500;

interface UseAutopilotOptions {
  active: boolean;                               // pilota acceso E questa scheda ha il lock
  appointmentsRef: React.MutableRefObject<Appointment[]>;
  commit: (fn: (all: Appointment[]) => Appointment[]) => void;
  getContext: () => PlanningContext;
  launchCall: (appt: Appointment) => Promise<void>;
  queueKey: string;                              // vedi autopilotQueueKey
}

// Chiave della coda: cambia quando una pratica entra/esce dalla coda o
// cambia lo stato della sua chiamata
export const autopilotQueueKey = (all: Appointment[]): string =>
  all
    .filter(a => a.autoCall || a.callStatus === 'calling')
    .map(a => `${a.id}:${a.autoCall || ''}:${a.autoCallNotBefore || ''}:${a.callStatus || ''}:${a.date || ''}:${a.startTime || ''}`)
    .sort()
    .join('|');

export const useAutopilot = ({ active, appointmentsRef, commit, getContext, launchCall, queueKey }: UseAutopilotOptions) => {
  const launchingRef = useRef(false);
  const lastLaunchAtRef = useRef(0);
  const activeRef = useRef(active);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeRef.current = active;

  // Funzioni passate dal chiamante: sempre le ultime
  const launchRef = useRef(launchCall);
  launchRef.current = launchCall;
  const contextRef = useRef(getContext);
  contextRef.current = getContext;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const scheduleStep = useCallback((delayMs: number, step: () => void) => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => { retryTimerRef.current = null; step(); }, delayMs);
  }, []);

  const step = useCallback(async (): Promise<void> => {
    if (!activeRef.current || launchingRef.current) return;

    // 1) Slot già trascorsi: fuori dalla coda
    const ctx = contextRef.current();
    const current = appointmentsRef.current;
    const expired = expireStaleAutoCalls(current, ctx.now);
    if (expired.some((a, i) => a !== current[i])) {
      commitRef.current(all => expireStaleAutoCalls(all, ctx.now));
    }

    // 2) Prossima chiamata dovuta (fascia oraria, tetto chiamate in volo)
    const next = nextDueCall(appointmentsRef.current, ctx);
    if (!next) return;

    const wait = lastLaunchAtRef.current + AUTOPILOT_LAUNCH_GAP_MS - Date.now();
    if (wait > 0) {
      scheduleStep(wait, () => { void step(); });
      return;
    }

    launchingRef.current = true;
    try {
      await launchRef.current(next);
    } catch (err) {
      console.error('Pilota automatico: lancio non riuscito', err);
    } finally {
      lastLaunchAtRef.current = Date.now();
      launchingRef.current = false;
    }
    // Subito la prossima, rispettando la pausa fra i lanci
    scheduleStep(AUTOPILOT_LAUNCH_GAP_MS, () => { void step(); });
  }, [appointmentsRef, scheduleStep]);

  // Battito regolare
  useEffect(() => {
    if (!active) return;
    void step();
    const timer = setInterval(() => { void step(); }, AUTOPILOT_TICK_MS);
    return () => {
      clearInterval(timer);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    };
  }, [active, step]);

  // Subito quando cambia la coda (approvazione, rimpiazzo, richiamo...)
  useEffect(() => {
    if (active) void step();
  }, [active, queueKey, step]);

  return { step };
};
