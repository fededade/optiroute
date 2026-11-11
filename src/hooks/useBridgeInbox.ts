import { useCallback, useEffect, useRef, useState } from 'react';
import type { Appointment } from '../types';
import {
  diffBridgeSnapshot,
  fetchBridgeSnapshot,
  type BridgePortal,
  type BridgeSettings,
} from '../services/bridgeService';
import { bridgePraticaToRow, type ImportRow } from './importPratiche';

// Inbox del bridge: le pratiche arrivano da sole. Se il bridge è abilitato e
// c'è il token, all'avvio e ogni 5 minuti (più "Scarica ora") si scarica lo
// snapshot, si importano le pratiche nuove (stesso nucleo dell'import da
// file, ma in silenzio: il risultato compare nel chip) e si riporta il
// telefono sulle pratiche già presenti che non l'avevano. Mai in parallelo a
// un altro import. Il token non compare mai nei log.

export const BRIDGE_POLL_MS = 5 * 60 * 1000;

export type BridgeChipKind =
  | 'disabled'       // bridge spento nelle impostazioni
  | 'unconfigured'   // acceso ma senza token
  | 'follower'       // gli automatismi girano in un'altra scheda
  | 'checking'       // scaricamento in corso
  | 'offline'        // non raggiungibile
  | 'token'          // token errato
  | 'invalid'        // risposta inattesa
  | 'login'          // un portale chiede l'accesso (MFA)
  | 'portal_error'   // un portale in errore
  | 'ok';

export interface BridgeInboxStatus {
  kind: BridgeChipKind;
  message: string;            // testo del chip
  detail?: string;            // tooltip / dettaglio
  lastCheckAt: Date | null;
  lastResult?: string;        // es. "3 nuove pratiche alle 10:32"
  portals: BridgePortal[];
}

export interface BridgeImportOutcome {
  added: number;
  updated: number;
  failed: number;
}

interface UseBridgeInboxOptions {
  settings: BridgeSettings;
  isLeader: boolean;
  appointmentsRef: React.MutableRefObject<Appointment[]>;
  // Import silenzioso delle righe nuove (nucleo comune) + aggiornamenti telefono
  importBridge: (rows: ImportRow[], updates: { id: string; changes: Partial<Appointment> }[]) => Promise<BridgeImportOutcome>;
  isImportBusy: () => boolean;
}

const hhmm = (d: Date) => d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const describeImport = (o: BridgeImportOutcome, at: Date): string => {
  const parts: string[] = [];
  if (o.added > 0) parts.push(plural(o.added, 'nuova pratica', 'nuove pratiche'));
  if (o.updated > 0) parts.push(plural(o.updated, 'telefono arrivato', 'telefoni arrivati'));
  if (o.failed > 0) parts.push(plural(o.failed, 'indirizzo non trovato', 'indirizzi non trovati'));
  return parts.length > 0 ? `${parts.join(', ')} alle ${hhmm(at)}` : `nessuna novità alle ${hhmm(at)}`;
};

const initialStatus = (settings: BridgeSettings): BridgeInboxStatus => ({
  kind: !settings.enabled ? 'disabled' : !settings.token ? 'unconfigured' : 'checking',
  message: !settings.enabled ? 'Bridge spento' : !settings.token ? 'Bridge non configurato' : 'Bridge: collegamento...',
  lastCheckAt: null,
  portals: [],
});

export const useBridgeInbox = ({ settings, isLeader, appointmentsRef, importBridge, isImportBusy }: UseBridgeInboxOptions) => {
  const [status, setStatus] = useState<BridgeInboxStatus>(() => initialStatus(settings));
  const runningRef = useRef(false);
  const lastResultRef = useRef<string | undefined>(undefined);

  const latest = useRef({ settings, importBridge, isImportBusy });
  latest.current = { settings, importBridge, isImportBusy };

  const configured = settings.enabled && !!settings.token.trim();

  const syncNow = useCallback(async (): Promise<void> => {
    const { settings: s, importBridge: doImport, isImportBusy: busy } = latest.current;
    if (!s.enabled || !s.token.trim()) return;
    if (runningRef.current) return;
    if (busy()) {
      // Un altro import è in corso: si riprova fra poco
      setTimeout(() => { void syncNow(); }, 10000);
      return;
    }
    runningRef.current = true;
    setStatus(st => ({ ...st, kind: st.kind === 'ok' ? 'ok' : 'checking', message: st.kind === 'ok' ? st.message : 'Bridge: collegamento...' }));
    try {
      const result = await fetchBridgeSnapshot(s);
      const at = new Date();
      if (!result.ok) {
        const map = {
          offline: { kind: 'offline' as const, message: 'Bridge non raggiungibile: avvia il bridge sul PC' },
          token: { kind: 'token' as const, message: 'Bridge: token errato (controlla le impostazioni)' },
          invalid: { kind: 'invalid' as const, message: 'Bridge: risposta inattesa' },
        }[result.error];
        setStatus({ ...map, detail: result.message, lastCheckAt: at, lastResult: lastResultRef.current, portals: [] });
        return;
      }

      const snapshot = result.snapshot;
      const diff = diffBridgeSnapshot(snapshot, appointmentsRef.current);
      let outcome: BridgeImportOutcome = { added: 0, updated: 0, failed: 0 };
      if (diff.nuove.length > 0 || diff.aggiornamenti.length > 0) {
        // Ricontrollo subito prima di importare (l'utente potrebbe aver
        // avviato un import da file durante lo scaricamento)
        if (busy()) {
          setTimeout(() => { void syncNow(); }, 10000);
          return;
        }
        outcome = await doImport(diff.nuove.map(bridgePraticaToRow), diff.aggiornamenti);
      }
      const done = new Date();
      if (outcome.added + outcome.updated + outcome.failed > 0 || !lastResultRef.current) {
        lastResultRef.current = describeImport(outcome, done);
      }

      const login = snapshot.portals.find(p => p.status === 'login_required');
      const failing = snapshot.portals.find(p => p.status === 'error');
      if (login) {
        setStatus({
          kind: 'login',
          message: `Bridge: login richiesto su ${login.id} — completa l'accesso con MFA nel Chrome del bridge`,
          detail: login.message || undefined,
          lastCheckAt: done,
          lastResult: lastResultRef.current,
          portals: snapshot.portals,
        });
      } else if (failing) {
        setStatus({
          kind: 'portal_error',
          message: `Bridge: errore su ${failing.id}${failing.message ? ` — ${failing.message}` : ''}`,
          detail: failing.message || undefined,
          lastCheckAt: done,
          lastResult: lastResultRef.current,
          portals: snapshot.portals,
        });
      } else {
        setStatus({
          kind: 'ok',
          message: `Bridge collegato · ${lastResultRef.current}`,
          detail: `${snapshot.pratiche.length} pratiche nel bridge · aggiornato alle ${hhmm(done)}`,
          lastCheckAt: done,
          lastResult: lastResultRef.current,
          portals: snapshot.portals,
        });
      }
    } catch (err) {
      console.error('Inbox bridge: errore', err instanceof Error ? err.message : 'sconosciuto');
      setStatus(st => ({ ...st, kind: 'invalid', message: 'Bridge: errore durante l\'import', lastCheckAt: new Date() }));
    } finally {
      runningRef.current = false;
    }
  }, [appointmentsRef]);

  // Stato del chip quando cambiano le impostazioni o il lock
  useEffect(() => {
    if (!settings.enabled) { setStatus(st => ({ ...initialStatus(settings), lastResult: st.lastResult })); return; }
    if (!settings.token.trim()) { setStatus(st => ({ ...initialStatus(settings), lastResult: st.lastResult })); return; }
    if (!isLeader) {
      setStatus(st => ({ ...st, kind: 'follower', message: 'Bridge: gestito dall\'altra scheda' }));
    }
  }, [settings, isLeader]);

  // Avvio + ogni 5 minuti (solo nella scheda che ha il lock)
  useEffect(() => {
    if (!configured || !isLeader) return;
    void syncNow();
    const timer = setInterval(() => { void syncNow(); }, BRIDGE_POLL_MS);
    return () => clearInterval(timer);
  }, [configured, isLeader, settings.url, settings.token, syncNow]);

  return { status, syncNow };
};
