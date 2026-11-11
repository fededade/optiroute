import React, { useState } from 'react';
import { nextCallWindowStart, type AutopilotSettings, type AutopilotStats } from '../services/autopilotService';
import type { TabLockState } from '../hooks/useTabLock';
import type { BridgeInboxStatus } from '../hooks/useBridgeInbox';

// Barra del pilota automatico: sempre visibile sopra l'elenco. Spento: una
// riga compatta con "Attiva". Acceso: stato, contatori, Pausa, impostazioni e
// promemoria di tenere aperta la scheda. In fondo il chip del bridge.

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

const BRIDGE_CHIP_STYLE: Record<string, string> = {
  ok: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  checking: 'text-slate-600 bg-slate-50 border-slate-200',
  follower: 'text-slate-500 bg-slate-50 border-slate-200',
  disabled: 'text-slate-400 bg-white border-slate-200',
  unconfigured: 'text-slate-500 bg-white border-dashed border-slate-300',
  offline: 'text-amber-700 bg-amber-50 border-amber-200',
  login: 'text-amber-800 bg-amber-50 border-amber-300',
  token: 'text-rose-700 bg-rose-50 border-rose-200',
  invalid: 'text-rose-700 bg-rose-50 border-rose-200',
  portal_error: 'text-rose-700 bg-rose-50 border-rose-200',
};

const AutopilotBar: React.FC<AutopilotBarProps> = ({
  settings, stats, lock, introSeen, autoDispatchRunning, bridge, onEnable, onPause, onOpenSettings, onBridgeSyncNow,
}) => {
  const [showIntro, setShowIntro] = useState(false);
  const now = new Date();

  const handleEnable = () => {
    if (!introSeen) { setShowIntro(true); return; }
    onEnable();
  };

  const bridgeChip = bridge.kind !== 'disabled' && (
    <div className="flex items-center gap-1.5 mt-1.5 min-w-0">
      <span
        data-testid="bridge-chip"
        title={[bridge.detail, bridge.lastResult && bridge.kind !== 'ok' ? `Ultimo import: ${bridge.lastResult}` : '']
          .filter(Boolean).join(' — ') || undefined}
        className={`text-[10px] font-bold border px-1.5 py-0.5 rounded truncate ${BRIDGE_CHIP_STYLE[bridge.kind] || BRIDGE_CHIP_STYLE.checking}`}
      >
        🔌 {bridge.message}
      </span>
      {lock === 'leader' && bridge.kind !== 'unconfigured' && (
        <button
          onClick={onBridgeSyncNow}
          disabled={bridge.kind === 'checking'}
          title="Scarica ora le pratiche dal bridge"
          className="shrink-0 text-[10px] font-bold text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 px-1.5 py-0.5 rounded disabled:opacity-50"
        >
          ⬇ Scarica ora
        </button>
      )}
    </div>
  );

  // Testo di stato del pilota acceso
  let statusLine: React.ReactNode;
  if (lock === 'follower') {
    statusLine = <span className="text-amber-700 font-bold">Pilota automatico attivo in un'altra scheda</span>;
  } else if (!stats.windowOpen) {
    statusLine = (
      <span>
        Fascia chiamate chiusa: riprende {whenLabel(nextCallWindowStart(now, settings), now)}
        {stats.queued > 0 ? ` · In coda ${stats.queued}` : ''}
      </span>
    );
  } else {
    const parts = [`In coda ${stats.queued}`, `In corso ${stats.inFlight}`];
    if (stats.nextCallAt) parts.push(`Prossima chiamata ${stats.dueNow > 0 ? 'adesso' : whenLabel(stats.nextCallAt, now)}`);
    statusLine = <span>{parts.join(' · ')}</span>;
  }

  return (
    <div data-testid="autopilot-bar" className={`px-3 py-2 border-b shrink-0 ${settings.enabled ? 'bg-violet-50 border-violet-200' : 'bg-white border-slate-200'}`}>
      {!settings.enabled ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold text-slate-600">🤖 Pilota automatico spento</span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onOpenSettings}
              title="Impostazioni del pilota automatico e del bridge"
              className="text-xs px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              ⚙
            </button>
            <button
              onClick={handleEnable}
              className="text-xs font-bold text-white bg-violet-600 hover:bg-violet-700 px-2.5 py-0.5 rounded"
            >
              Attiva
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-violet-800 flex items-center gap-1.5 min-w-0">
              <span className={lock === 'leader' && stats.windowOpen ? 'animate-pulse' : ''}>🤖</span>
              <span className="truncate">Pilota automatico {lock === 'follower' ? 'acceso' : 'attivo'}</span>
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={onOpenSettings}
                title="Impostazioni del pilota automatico e del bridge"
                className="text-xs px-1.5 py-0.5 rounded border border-violet-200 bg-white text-violet-700 hover:bg-violet-100"
              >
                ⚙
              </button>
              {/* In una scheda secondaria la pausa non fermerebbe l'altra: si mette in pausa da lì */}
              {lock !== 'follower' && (
                <button
                  onClick={onPause}
                  title="Ferma il pilota: nessuna chiamata parte da sola (la coda resta)"
                  className="text-xs font-bold text-violet-700 bg-white border border-violet-300 hover:bg-violet-100 px-2 py-0.5 rounded"
                >
                  ⏸ Pausa
                </button>
              )}
            </div>
          </div>
          <p data-testid="autopilot-status" className="text-[11px] text-violet-900 mt-0.5">
            {statusLine}
            {autoDispatchRunning && <span className="ml-1 text-violet-600">· smistamento in corso...</span>}
          </p>
          {lock === 'leader' && (
            <p className="text-[10px] text-violet-500 mt-0.5">
              Tieni aperta questa scheda: le chiamate partono da qui.
            </p>
          )}
        </>
      )}
      {bridgeChip}

      {showIntro && (
        <div className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4" onClick={() => setShowIntro(false)}>
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-slate-800 mb-3">🤖 Attivare il pilota automatico?</h3>
            <ul className="text-sm text-slate-600 space-y-1.5 mb-4 list-disc pl-5">
              <li>Chiama da solo i clienti dei <b>giri approvati</b> (bottone "Approva e chiama"), richiama chi non risponde e riempie gli slot liberati.</li>
              <li>Chiama solo nella fascia oraria impostata: <b>{settings.callWindowStart}–{settings.callWindowEnd}</b>{settings.callSaturday ? ', anche il sabato' : ', dal lunedì al venerdì'}.</li>
              <li>Funziona <b>finché questa scheda resta aperta</b>: chiudendola le chiamate si fermano.</li>
            </ul>
            <div className="flex gap-2">
              <button
                onClick={() => setShowIntro(false)}
                className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                Annulla
              </button>
              <button
                onClick={() => { setShowIntro(false); onEnable(); }}
                className="flex-1 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold"
              >
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
