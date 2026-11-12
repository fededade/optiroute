import { createRetellCall, retellEnv, type RetellCallBody } from '../api/retell-call';
import { fetchRetellCall, isValidCallId, type RawCallOutcome } from '../api/call-status';

// Client Retell del motore: riusa la stessa logica degli endpoint
// api/retell-call (payload e invio) e api/call-status (lettura dell'esito).
// RETELL_API_BASE permette di puntare a un Retell finto (test, strumento locale).

export type CallLaunch = { ok: true; callId: string } | { ok: false; error: string };

export type CallLookup =
  | { kind: 'pending' }
  | { kind: 'done'; outcome: RawCallOutcome }
  | { kind: 'error'; transient: boolean };

export interface RetellClient {
  configured(): boolean;
  createCall(body: RetellCallBody, timeoutMs: number): Promise<CallLaunch>;
  getCall(callId: string, timeoutMs: number): Promise<CallLookup>;
}

export const httpRetellClient: RetellClient = {
  configured: () => {
    const env = retellEnv();
    return !!env.apiKey && !!env.fromNumber;
  },

  async createCall(body, timeoutMs) {
    const r = await createRetellCall(body, { timeoutMs });
    if (!r.ok) return { ok: false, error: r.error };
    // Senza identificativo non si potrebbe mai leggere l'esito: si tratta
    // come chiamata non avviata (niente richiamo automatico)
    if (typeof r.callId !== 'string' || !isValidCallId(r.callId)) {
      return { ok: false, error: 'Risposta di Retell senza identificativo della chiamata.' };
    }
    return { ok: true, callId: r.callId };
  },

  async getCall(callId, timeoutMs) {
    if (!isValidCallId(callId)) return { kind: 'error', transient: false };
    const r = await fetchRetellCall(callId, { timeoutMs });
    if (!r.ok) return { kind: 'error', transient: r.transient };
    if (r.view.pending || !r.view.outcome) return { kind: 'pending' };
    return { kind: 'done', outcome: r.view.outcome };
  },
};
