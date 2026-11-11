import React, { useEffect, useId, useRef, useState } from 'react';
import { Bot, ChevronDown, Cloud, CloudOff, Download, Pause, Play, Plug, Settings } from 'lucide-react';
import { nextCallWindowStart, type AutopilotSettings, type AutopilotStats } from '../services/autopilotService';
import type { TabLockState } from '../hooks/useTabLock';
import type { BridgeInboxStatus } from '../hooks/useBridgeInbox';
import { schedulerFresh, type CloudSyncState } from '../services/cloudSyncCore';

// Striscia del pilota automatico: UNA riga sempre visibile sopra il pannello
// di lavoro. Icona e stato, contatori come etichette (in coda, in corso,
// prossima chiamata o fascia chiusa), cloud e bridge, a destra Attiva/Pausa
// e le impostazioni. Le righe secondarie (tieni aperta la scheda, cloud,
// automatismi su un altro dispositivo) compaiono in piccolo solo se servono.

export interface CloudBarInfo {
  mirror: boolean;               // scheda secondaria: sincronizza la scheda principale
  state: CloudSyncState | null;  // stato della sincronizzazione (scheda principale)
  leaseHolder: boolean;          // smistamento automatico e bridge girano su questo dispositivo
}

interface AutopilotBarProps {
  settings: AutopilotSettings;
  stats: AutopilotStats;
  lock: TabLockState;
  introSeen: boolean;
  autoDispatchRunning: boolean;
  bridge: BridgeInboxStatus;
  onEnable: () => void;
  onPause: () => void;
  onOpenSettings: () => void;
  onBridgeSyncNow: () => void;
  cloud?: CloudBarInfo | null;   // presente solo con il cloud attivo
  // Contatore: ogni incremento chiede di attivare il pilota con lo stesso
  // percorso del bottone "Attiva" (finestra di presentazione compresa)
  requestEnable?: number;
  // la finestra "Attivare il pilota automatico?" è aperta (per non duplicare i comandi sotto)
  onIntroOpenChange?: (open: boolean) => void;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// "alle 15:10", "domani alle 09:00", "lun 16/11 alle 09:00"
const whenLabel = (d: Date, now: Date): string => {
  if (isSameDay(d, now)) return `alle ${hhmm(d)}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (isSameDay(d, tomorrow)) return `domani alle ${hhmm(d)}`;
  const weekday = d.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '');
  return `${weekday} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} alle ${hhmm(d)}`;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Colori delle etichette (sistema grafico: .chip-*)
const CLOUD_CHIP_STYLE: Record<string, string> = {
  ok: 'chip-info',
  busy: 'chip-neutral',
  warn: 'chip-warn',
  error: 'chip-danger',
};

// Testo e stile dell'etichetta del cloud
export const cloudChip = (cloud: CloudBarInfo, now: Date): { text: string; style: string; title?: string; down?: boolean } => {
  if (cloud.mirror || !cloud.state) {
    return { text: 'Cloud · sincronizzato dalla scheda principale', style: CLOUD_CHIP_STYLE.ok };
  }
  const s = cloud.state;
  switch (s.phase) {
    case 'starting':
      return { text: 'Cloud · collegamento…', style: CLOUD_CHIP_STYLE.busy };
    case 'sending':
      return { text: 'Cloud · invio in corso…', style: CLOUD_CHIP_STYLE.busy };
    case 'offline': {
      const retry = s.retryAt ? Math.max(0, Math.round((s.retryAt - now.getTime()) / 1000)) : null;
      return {
        text: `Cloud non raggiungibile${s.pending ? ': le modifiche restano qui e partono appena torna' : ': riprovo da solo'}`,
        style: CLOUD_CHIP_STYLE.warn,
        down: true,
        title: [s.error?.message, retry !== null ? `Prossimo tentativo fra ${retry} s` : ''].filter(Boolean).join(' — ') || undefined,
      };
    }
    case 'auth':
      return { text: 'Cloud: chiave errata — correggila in Impostazioni del pilota → Cloud', style: CLOUD_CHIP_STYLE.error, title: s.error?.message, down: true };
    case 'not_configured':
      return {
        text: `Cloud non configurato sul server${s.error?.kind === 'not_configured' ? (s.error.detail === 'store' ? ' (manca il database)' : ' (manca CRON_SECRET)') : ''}`,
        style: CLOUD_CHIP_STYLE.error,
        down: true,
      };
    default:
      return {
        text: `Cloud · sincronizzato${s.lastSyncAt ? ` alle ${hhmm(new Date(s.lastSyncAt))}` : ''}`,
        style: CLOUD_CHIP_STYLE.ok,
      };
  }
};

// "Ultimo passaggio del motore alle 10:31 · 2 chiamate avviate · 1 esito applicato"
// (l'attività è quella dell'ultimo passaggio che ha fatto qualcosa, con la
// sua ora se è un passaggio precedente)
export const cloudTickLine = (state: CloudSyncState | null): string | null => {
  const t = state?.lastTick || state?.status?.lastTick;
  if (!t) return null;
  const at = new Date(t.at);
  if (isNaN(at.getTime())) return null;
  const line = `Ultimo passaggio del motore alle ${hhmm(at)}`;
  const act = state?.lastActivity;
  if (!act) return line;
  const sum = act.summary;
  const parts: string[] = [];
  if (sum.callsLaunched) parts.push(plural(sum.callsLaunched, 'chiamata avviata', 'chiamate avviate'));
  if (sum.outcomesApplied) parts.push(plural(sum.outcomesApplied, 'esito applicato', 'esiti applicati'));
  if (sum.callsFailed) parts.push(plural(sum.callsFailed, 'chiamata non partita', 'chiamate non partite'));
  if (parts.length === 0) return line;
  const actAt = new Date(act.at);
  const sameTick = act.at === t.at || isNaN(actAt.getTime()) || hhmm(actAt) === hhmm(at);
  return `${line} · ${sameTick ? '' : `alle ${hhmm(actAt)}: `}${parts.join(', ')}`;
};

const BRIDGE_CHIP_STYLE: Record<string, string> = {
  ok: 'chip-success',
  checking: 'chip-neutral',
  follower: 'chip-neutral',
  disabled: 'chip-neutral',
  unconfigured: 'chip-neutral border-dashed',
  offline: 'chip-warn',
  login: 'chip-warn',
  token: 'chip-danger',
  invalid: 'chip-danger',
  portal_error: 'chip-danger',
};

const AutopilotBar: React.FC<AutopilotBarProps> = ({
  settings, stats, lock, introSeen, autoDispatchRunning, bridge, onEnable, onPause, onOpenSettings, onBridgeSyncNow, cloud, requestEnable = 0, onIntroOpenChange,
}) => {
  const [showIntro, setShowIntro] = useState(false);
  // Telefono: una riga sola, il resto a comparsa
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const now = new Date();
  const on = settings.enabled;

  const handleEnable = () => {
    if (!introSeen) { setShowIntro(true); return; }
    onEnable();
  };

  const introCb = useRef(onIntroOpenChange);
  introCb.current = onIntroOpenChange;
  useEffect(() => { introCb.current?.(showIntro); }, [showIntro]);

  // Richiesta dall'esterno (es. avviso nella sezione Proposte)
  const lastRequest = useRef(requestEnable);
  useEffect(() => {
    if (requestEnable === lastRequest.current) return;
    lastRequest.current = requestEnable;
    if (!settings.enabled) handleEnable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestEnable]);

  // Cloud: etichetta di stato, ultimo passaggio, si può chiudere il browser?
  const cloudState = cloud?.state || null;
  const chip = cloud ? cloudChip(cloud, now) : null;
  const tickLine = cloud ? cloudTickLine(cloudState) : null;
  const canClose = schedulerFresh(cloudState?.status?.schedulerSeenAt, now.getTime());
  const cloudHint = cloud && on && !cloud.mirror && cloudState && cloudState.phase !== 'starting';
  const cloudLease = cloud && !cloud.mirror && cloudState && !cloud.leaseHolder
    && (cloudState.phase === 'synced' || cloudState.phase === 'sending')
    && ((on && settings.autoDispatch) || bridge.kind !== 'disabled');

  // Etichette di stato del pilota acceso
  let counters: React.ReactNode = null;
  if (on) {
    if (lock === 'follower' && !cloud) {
      counters = null;
    } else if (!stats.windowOpen) {
      counters = (
        <>
          <span className="chip chip-neutral">Fascia chiamate chiusa: riprende {whenLabel(nextCallWindowStart(now, settings), now)}</span>
          {stats.queued > 0 && <span className="chip chip-ai num-chip">In coda {stats.queued}</span>}
        </>
      );
    } else {
      counters = (
        <>
          <span className="chip chip-ai num-chip">In coda {stats.queued}</span>
          <span className={`chip num-chip ${stats.inFlight > 0 ? 'chip-info' : 'chip-neutral'}`}>In corso {stats.inFlight}</span>
          {stats.nextCallAt && (
            <span className="chip chip-neutral">Prossima chiamata {stats.dueNow > 0 ? 'adesso' : whenLabel(stats.nextCallAt, now)}</span>
          )}
        </>
      );
    }
  }

  const secondary: React.ReactNode[] = [];
  if (on && lock === 'leader' && !cloud) {
    secondary.push(<span key="keep">Tieni aperta questa scheda: le chiamate partono da qui.</span>);
  }
  if (tickLine) secondary.push(<span key="tick" data-testid="cloud-tick">{tickLine}</span>);
  if (cloudHint) {
    secondary.push(canClose ? (
      <span key="hint" data-testid="cloud-hint" className="text-emerald-700">Puoi chiudere il browser: il pilota lavora dal cloud.</span>
    ) : (
      <span key="hint" data-testid="cloud-hint" className="text-amber-800">
        Lo scheduler del cloud non è ancora passato: a browser chiuso il pilota non avanzerebbe.
        Tieni aperta questa scheda finché non compare "Puoi chiudere il browser".
      </span>
    ));
  }
  if (cloudLease) {
    secondary.push(<span key="lease" data-testid="cloud-lease">Automatismi attivi su un altro dispositivo (smistamento e bridge).</span>);
  }

  const CloudIcon = chip?.down ? CloudOff : Cloud;

  // Riassunto per il telefono ("3 in coda · 1 in corso") e segnale di avviso
  const summary = !on ? '' : lock === 'follower' && !cloud ? ''
    : !stats.windowOpen ? `fascia chiusa${stats.queued > 0 ? ` · ${stats.queued} in coda` : ''}`
    : `${stats.queued} in coda · ${stats.inFlight} in corso`;
  const bridgeStyle = BRIDGE_CHIP_STYLE[bridge.kind] || '';
  const hasAlert = !!chip?.down || /chip-(warn|danger)/.test(bridge.kind !== 'disabled' ? bridgeStyle : '');
  const hasDetails = on || !!chip || bridge.kind !== 'disabled' || secondary.length > 0;

  return (
    <div data-testid="autopilot-bar" className={`autopilot-strip ${on ? 'autopilot-strip-on' : ''}`}>
      <div className="flex items-start gap-3">
      <div id={detailsId} className="flex-1 min-w-0 flex items-center gap-x-3 gap-y-1.5 flex-wrap min-h-[32px]">
        <span className="flex items-center gap-2 min-w-0 md:shrink-0">
          <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${on ? 'bg-violet-600 text-white' : 'bg-slate-100 text-ink-500'}`}>
            <Bot size={16} strokeWidth={1.75} className={on && lock === 'leader' && stats.windowOpen ? 'animate-pulse' : ''} aria-hidden />
          </span>
          <span className={`text-sm font-semibold max-md:sr-only ${on ? 'text-violet-900' : 'text-ink-700'}`}>
            {!on ? 'Pilota automatico spento'
              : lock === 'follower' && !cloud ? <span className="text-amber-800">Pilota automatico attivo in un'altra scheda</span>
              : `Pilota automatico ${lock === 'follower' ? 'acceso' : 'attivo'}`}
          </span>
          <span className={`md:hidden shrink-0 text-sm font-semibold whitespace-nowrap ${!on ? 'text-ink-700' : lock === 'follower' && !cloud ? 'text-amber-800' : 'text-violet-900'}`} aria-hidden>
            {!on ? 'Pilota spento' : lock === 'follower' && !cloud ? 'Pilota in altra scheda' : 'Pilota attivo'}
          </span>
          {hasDetails && (
            <button
              type="button"
              onClick={() => setDetailsOpen(o => !o)}
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              title={detailsOpen ? 'Nascondi i dettagli del pilota' : 'Mostra i dettagli del pilota (prossima chiamata, bridge, avvisi)'}
              className="md:hidden relative min-w-0 inline-flex items-center gap-1 rounded-md h-7 pl-1 pr-0.5 -ml-0.5 text-xs text-ink-600 hover:bg-slate-100"
              data-testid="autopilot-details-toggle"
            >
              {summary ? <span className="truncate num-chip" data-testid="autopilot-summary">{summary}</span> : <span className="sr-only">Dettagli</span>}
              <ChevronDown size={15} strokeWidth={1.75} className={`shrink-0 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} aria-hidden />
              {hasAlert && !detailsOpen && <span className="absolute top-0.5 right-0 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-surface" aria-label="Avvisi nei dettagli" />}
            </button>
          )}
        </span>

        {on && (
          <span data-testid="autopilot-status" className={`${detailsOpen ? 'flex' : 'max-md:hidden flex'} items-center gap-1.5 flex-wrap`}>
            {counters}
            {autoDispatchRunning && <span className="chip chip-ai">Smistamento in corso…</span>}
          </span>
        )}

        {chip && (
          <span data-testid="cloud-chip" title={chip.title} className={`chip ${chip.style} max-w-full ${detailsOpen ? '' : 'max-md:hidden'}`}>
            <CloudIcon size={13} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span className="truncate">{chip.text}</span>
          </span>
        )}

        {bridge.kind !== 'disabled' && (
          <span className={`inline-flex items-center gap-1 min-w-0 max-w-full ${detailsOpen ? '' : 'max-md:hidden'}`}>
            <span
              data-testid="bridge-chip"
              title={[bridge.message, bridge.detail, bridge.lastResult && bridge.kind !== 'ok' ? `Ultimo import: ${bridge.lastResult}` : '']
                .filter(Boolean).join(' — ') || undefined}
              className={`chip ${BRIDGE_CHIP_STYLE[bridge.kind] || BRIDGE_CHIP_STYLE.checking} min-w-0 max-w-[200px] min-[1440px]:max-w-[320px]`}
            >
              <Plug size={13} strokeWidth={1.75} className="shrink-0" aria-hidden />
              <span className="truncate">{bridge.message}</span>
            </span>
            {lock === 'leader' && bridge.kind !== 'unconfigured' && (
              <button
                type="button"
                onClick={onBridgeSyncNow}
                disabled={bridge.kind === 'checking'}
                title="Scarica ora le pratiche dal bridge"
                aria-label="Scarica ora"
                className="icon-btn h-6 w-6"
              >
                <Download size={14} strokeWidth={1.75} />
              </button>
            )}
          </span>
        )}

        </div>
        <span className="flex items-center gap-1 md:gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onOpenSettings}
            title="Impostazioni del pilota automatico e del bridge"
            aria-label="Impostazioni del pilota automatico e del bridge"
            className="icon-btn"
          >
            <Settings size={17} strokeWidth={1.75} />
          </button>
          {!on ? (
            <button type="button" onClick={handleEnable} className="btn btn-sm bg-violet-600 text-white hover:bg-violet-700">
              <Play size={14} strokeWidth={2} aria-hidden /> Attiva
            </button>
          ) : lock !== 'follower' ? (
            // In una scheda secondaria la pausa non fermerebbe l'altra: si mette in pausa da lì
            <button
              type="button"
              onClick={onPause}
              title="Ferma il pilota: nessuna chiamata parte da sola (la coda resta)"
              className="btn btn-sm btn-secondary text-violet-800 border-violet-200 hover:bg-violet-50 max-[420px]:px-2.5"
            >
              <Pause size={14} strokeWidth={2} aria-hidden /> <span className="max-[420px]:sr-only">Pausa</span>
            </button>
          ) : null}
        </span>
      </div>

      {secondary.length > 0 && (
        <div className={`mt-1 pl-9 flex-col gap-0.5 text-xs text-ink-500 ${detailsOpen ? 'flex' : 'max-md:hidden flex'}`}>
          {secondary}
        </div>
      )}

      {showIntro && (
        <div className="modal-backdrop" onClick={() => setShowIntro(false)}>
          <div className="modal max-w-md" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ap-intro-title">
            <div className="modal-header">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white shrink-0">
                <Bot size={18} strokeWidth={1.75} aria-hidden />
              </span>
              <h3 id="ap-intro-title" className="modal-title self-center">Attivare il pilota automatico?</h3>
            </div>
            <div className="modal-body">
              <ul className="text-sm text-ink-700 space-y-2 list-disc pl-5 leading-relaxed">
                <li>Chiama da solo i clienti dei <b>giri approvati</b> (bottone "Approva e chiama"), richiama chi non risponde e riempie gli slot liberati.</li>
                <li>Chiama solo nella fascia oraria impostata: <b className="num">{settings.callWindowStart}–{settings.callWindowEnd}</b>{settings.callSaturday ? ', anche il sabato' : ', dal lunedì al venerdì'}.</li>
                {cloud ? (
                  <li>Lavora <b>dal cloud</b>: le chiamate partono dal server, anche a browser chiuso (quando lo scheduler è attivo).</li>
                ) : (
                  <li>Funziona <b>finché questa scheda resta aperta</b>: chiudendola le chiamate si fermano.</li>
                )}
              </ul>
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => setShowIntro(false)} className="btn btn-secondary">Annulla</button>
              <button type="button" onClick={() => { setShowIntro(false); onEnable(); }} className="btn bg-violet-600 text-white hover:bg-violet-700">
                Attiva il pilota
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AutopilotBar;
