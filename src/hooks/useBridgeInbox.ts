import { useCallback, useEffect, useRef, useState } from 'react';
import type { Appointment } from '../types';
import {
  diffBridgeSnapshot,
  fetchBridgeSnapshot,
  type BridgeFetchResult,
  type BridgePortal,
  type BridgePratica,
  type BridgeSettings,
} from '../services/bridgeService';
import { mergeExclusions, type ExclusionChange, type GestionaleExclusion } from '../services/gestionaleExclusions';
import { isPortalExcluded, portalExclusions } from '../services/portalState';
import { bridgePraticaToRow, type ImportRow } from './importPratiche';

// Inbox del bridge: le pratiche arrivano da sole. Se il bridge è abilitato e
// c'è il token, all'avvio e ogni 5 minuti (più "Scarica ora") si scarica lo
// snapshot, si importano le pratiche nuove (stesso nucleo dell'import da
// file, ma in silenzio: il risultato compare nel chip) e si riporta il
// telefono sulle pratiche già presenti che non l'avevano. Mai in parallelo a
// un altro import. Il token non compare mai nei log.
// Dentro il gestionale, dopo ogni scaricamento riuscito si tolgono dal
// lavoro le pratiche che il gestionale indica come già concordate, fatte o
// chiuse (anche quando non ci sono pratiche nuove).
// Stato sul portale (contratto §6), in ogni modalità: le pratiche che il
// portale dà già fissate, fatte o chiuse escono dal lavoro (insieme a quelle
// del gestionale) e non si importano; le sospese si importano e, nello
// stesso aggiornamento dell'elenco, prendono lo stato dato dalla nota di
// sospensione (lo smistamento non fa in tempo a proporle).

export const BRIDGE_POLL_MS = 5 * 60 * 1000;

export type BridgeChipKind =
  | 'disabled'       // bridge spento nelle impostazioni
  | 'unconfigured'   // acceso ma senza token
  | 'follower'       // gli automatismi girano in un'altra scheda
  | 'checking'       // scaricamento in corso
  | 'offline'        // non raggiungibile
  | 'inactive'       // (gestionale) bridge avviato ma non attivato
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
  removed?: number;   // tolte perché già nel gestionale
  removedPortal?: number; // tolte perché già fissate, fatte o chiuse sul portale
  suspended?: number; // sospese sul portale (stato dato dalla nota)
  resumed?: number;   // non più sospese sul portale: tornate in attesa
}

interface UseBridgeInboxOptions {
  settings: BridgeSettings;
  isLeader: boolean;
  appointmentsRef: React.MutableRefObject<Appointment[]>;
  // Import silenzioso delle righe nuove (nucleo comune) + aggiornamenti telefono;
  // nello stesso aggiornamento dell'elenco applica le sospensioni del portale
  // (`portal`: le pratiche dello snapshot) e le conta in `suspended`
  importBridge: (
    rows: ImportRow[],
    updates: { id: string; changes: Partial<Appointment> }[],
    portal: BridgePratica[]
  ) => Promise<BridgeImportOutcome>;
  // C'è qualcosa da fare per le sospensioni del portale sulle pratiche di adesso?
  suspensionsPending?: (portal: BridgePratica[]) => boolean;
  isImportBusy: () => boolean;
  // Testo del chip quando gli automatismi girano altrove (default: altra scheda)
  followerMessage?: string;
  // Dentro il gestionale: le pratiche arrivano tramite la pagina del
  // gestionale (indirizzo e token del bridge nelle impostazioni non si usano)
  source?: () => Promise<BridgeFetchResult>;
  // Toglie dal lavoro le pratiche escluse (dal gestionale o dal portale);
  // restituisce quelle tolte
  applyExcluded?: (excluded: GestionaleExclusion[]) => ExclusionChange[];
  // In attesa di un prerequisito (dentro il gestionale: il primo
  // scaricamento dal cloud): niente scaricamenti né import, nemmeno da
  // "Scarica ora" o dall'avviso del gestionale
  waiting?: boolean;
}

const hhmm = (d: Date) => d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const describeImport = (o: BridgeImportOutcome, at: Date): string => {
  const parts: string[] = [];
  if (o.added > 0) parts.push(plural(o.added, 'nuova pratica', 'nuove pratiche'));
  if (o.updated > 0) parts.push(plural(o.updated, 'telefono arrivato', 'telefoni arrivati'));
  if (o.failed > 0) parts.push(plural(o.failed, 'indirizzo non trovato', 'indirizzi non trovati'));
  if (o.removed && o.removed > 0) parts.push(`${plural(o.removed, 'tolta', 'tolte')} perché già nel gestionale`);
  if (o.removedPortal && o.removedPortal > 0) {
    parts.push(o.removedPortal === 1
      ? '1 tolta perché già fissata o chiusa sul portale'
      : `${o.removedPortal} tolte perché già fissate o chiuse sul portale`);
  }
  if (o.suspended && o.suspended > 0) parts.push(plural(o.suspended, 'sospesa sul portale', 'sospese sul portale'));
  if (o.resumed && o.resumed > 0) parts.push(plural(o.resumed, 'tornata in attesa (non più sospesa)', 'tornate in attesa (non più sospese)'));
  return parts.length > 0 ? `${parts.join(', ')} alle ${hhmm(at)}` : `nessuna novità alle ${hhmm(at)}`;
};

const initialStatus = (settings: BridgeSettings, viaParent = false): BridgeInboxStatus => (viaParent
  ? { kind: 'checking', message: 'Bridge: collegamento...', lastCheckAt: null, portals: [] }
  : {
      kind: !settings.enabled ? 'disabled' : !settings.token ? 'unconfigured' : 'checking',
      message: !settings.enabled ? 'Bridge spento' : !settings.token ? 'Bridge non configurato' : 'Bridge: collegamento...',
      lastCheckAt: null,
      portals: [],
    });

export const useBridgeInbox = ({ settings, isLeader, appointmentsRef, importBridge, isImportBusy, followerMessage, source, applyExcluded, suspensionsPending, waiting = false }: UseBridgeInboxOptions) => {
  const viaParent = !!source;
  const [status, setStatus] = useState<BridgeInboxStatus>(() => initialStatus(settings, viaParent));
  const runningRef = useRef(false);
  const lastResultRef = useRef<string | undefined>(undefined);

  const latest = useRef({ settings, importBridge, isImportBusy, source, applyExcluded, suspensionsPending, waiting });
  latest.current = { settings, importBridge, isImportBusy, source, applyExcluded, suspensionsPending, waiting };

  const configured = viaParent || (settings.enabled && !!settings.token.trim());

  const syncNow = useCallback(async (): Promise<void> => {
    const { settings: s, importBridge: doImport, isImportBusy: busy, source: src, applyExcluded: exclude, suspensionsPending: suspensionsDue } = latest.current;
    if (!src && (!s.enabled || !s.token.trim())) return;
    if (latest.current.waiting) return;
    if (runningRef.current) return;
    if (busy()) {
      // Un altro import è in corso: si riprova fra poco
      setTimeout(() => { void syncNow(); }, 10000);
      return;
    }
    runningRef.current = true;
    setStatus(st => ({ ...st, kind: st.kind === 'ok' ? 'ok' : 'checking', message: st.kind === 'ok' ? st.message : 'Bridge: collegamento...' }));
    try {
      const result = src ? await src() : await fetchBridgeSnapshot(s);
      const at = new Date();
      if (!result.ok) {
        const map = src
          ? {
              offline: { kind: 'offline' as const, message: 'Bridge non avviato: avvialo dalla barra del gestionale' },
              inactive: { kind: 'inactive' as const, message: 'Bridge non attivo: attivalo dalla barra del gestionale' },
              token: { kind: 'token' as const, message: 'Bridge: accesso rifiutato (riattivalo dalla barra del gestionale)' },
              invalid: { kind: 'invalid' as const, message: 'Bridge: risposta inattesa' },
            }[result.error]
          : {
              offline: { kind: 'offline' as const, message: 'Bridge non raggiungibile: avvia il bridge sul PC' },
              inactive: { kind: 'offline' as const, message: 'Bridge non raggiungibile: avvia il bridge sul PC' },
              token: { kind: 'token' as const, message: 'Bridge: token errato (controlla le impostazioni)' },
              invalid: { kind: 'invalid' as const, message: 'Bridge: risposta inattesa' },
            }[result.error];
        setStatus({ ...map, detail: result.message, lastCheckAt: at, lastResult: lastResultRef.current, portals: [] });
        return;
      }

      // Nel frattempo si è tornati in attesa (es. sincronizzazione ripartita):
      // niente confronto con un elenco che sta per essere sostituito
      if (latest.current.waiting) return;

      const snapshot = result.snapshot;
      // Pratiche da non lavorare: quelle della pagina del gestionale e quelle
      // che il portale dà già fissate, fatte o chiuse (stessa pratica = una volta)
      const excluded = mergeExclusions(result.excluded || [], portalExclusions(snapshot.pratiche));
      const diff = diffBridgeSnapshot(snapshot, appointmentsRef.current);
      // Le pratiche già fissate, fatte o chiuse sul portale non si importano mai
      const nuove = diff.nuove.filter(p => !isPortalExcluded(p));
      const suspensions = !!suspensionsDue && suspensionsDue(snapshot.pratiche);
      const toImport = nuove.length > 0 || diff.aggiornamenti.length > 0 || suspensions;
      // Ricontrollo subito prima di importare (l'utente potrebbe aver
      // avviato un import da file durante lo scaricamento)
      if (toImport && busy()) {
        setTimeout(() => { void syncNow(); }, 10000);
        return;
      }
      let outcome: BridgeImportOutcome = { added: 0, updated: 0, failed: 0 };
      if (exclude && excluded.length > 0) {
        const removed = exclude(excluded);
        outcome = {
          ...outcome,
          removed: removed.filter(r => r.fonte !== 'portale').length,
          removedPortal: removed.filter(r => r.fonte === 'portale').length,
        };
      }
      if (toImport) {
        const imported = await doImport(nuove.map(bridgePraticaToRow), diff.aggiornamenti, snapshot.pratiche);
        outcome = { ...imported, removed: outcome.removed, removedPortal: outcome.removedPortal };
      }
      const done = new Date();
      if (outcome.added + outcome.updated + outcome.failed + (outcome.removed || 0) + (outcome.removedPortal || 0) + (outcome.suspended || 0) + (outcome.resumed || 0) > 0 || !lastResultRef.current) {
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
          detail: `${result.portalCount !== undefined
            ? `${result.portalCount} pratiche sul portale, ${snapshot.pratiche.length} da programmare`
            : `${snapshot.pratiche.length} pratiche nel bridge`} · aggiornato alle ${hhmm(done)}`,
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
    if (!viaParent && !settings.enabled) { setStatus(st => ({ ...initialStatus(settings), lastResult: st.lastResult })); return; }
    if (!viaParent && !settings.token.trim()) { setStatus(st => ({ ...initialStatus(settings), lastResult: st.lastResult })); return; }
    if (!isLeader) {
      setStatus(st => ({ ...st, kind: 'follower', message: followerMessage || 'Bridge: gestito dall\'altra scheda' }));
    }
  }, [settings, isLeader, followerMessage, viaParent]);

  // Avvio + ogni 5 minuti (solo nella scheda che ha il lock)
  useEffect(() => {
    if (!configured || !isLeader) return;
    void syncNow();
    const timer = setInterval(() => { void syncNow(); }, BRIDGE_POLL_MS);
    return () => clearInterval(timer);
  }, [configured, isLeader, viaParent, viaParent ? '' : settings.url, viaParent ? '' : settings.token, syncNow]);

  return { status, syncNow };
};
