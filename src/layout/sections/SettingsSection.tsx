import React from 'react';
import { Bot, Cloud, House, Loader2, Plug, RefreshCw, Trash2, Users } from 'lucide-react';
import type { Coordinates, Technician } from '../../types';

interface SettingsSectionProps {
  baseLocation: { coords: Coordinates; address: string } | null;
  baseInput: string;
  onBaseInput: (v: string) => void;
  onSetBase: (e: React.FormEvent) => void;
  onClearBase: () => void;
  isLoading: boolean;
  startTime: string;
  endTimeLimit: string;
  onStartTime: (v: string) => void;
  onEndTime: (v: string) => void;
  autopilotOn: boolean;
  bridgeOn: boolean;
  cloudOn: boolean;
  onOpenAutopilotSettings: () => void;
  technicians: Technician[];
  onOpenTech: (id?: string) => void;
  onSyncGestionale: () => void;
  isSyncing: boolean;
  syncHint: string;
  lastSyncInfo: string;
}

const Panel: React.FC<{ title: string; text: string; children: React.ReactNode; testId: string }> = ({ title, text, children, testId }) => (
  <section className="card" data-testid={testId}>
    <div className="px-5 pt-4 pb-3 border-b border-line">
      <h3 className="section-title">{title}</h3>
      <p className="text-xs text-ink-500 mt-0.5">{text}</p>
    </div>
    <div className="px-5 py-4">{children}</div>
  </section>
);

const SettingsSection: React.FC<SettingsSectionProps> = (p) => (
  <div className="settings-grid" data-testid="settings-grid">
    <Panel testId="settings-generale" title="Generale" text="Base e orari usati per il giro senza tecnico e come ripiego quando un tecnico non ha i suoi.">
      <div className="space-y-4">
        <div>
          <span className="field-label">Base generale</span>
          {!p.baseLocation ? (
            <form onSubmit={p.onSetBase} className="flex gap-2">
              <input type="text" value={p.baseInput} onChange={e => p.onBaseInput(e.target.value)} placeholder="Indirizzo della base (es. Piazza Duomo, Milano)" className="input" aria-label="Indirizzo della base generale" />
              <button type="submit" className="btn btn-primary" disabled={p.isLoading}>
                {p.isLoading ? <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden /> : null} Imposta
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-3 rounded-control border border-line bg-slate-50/60 px-3 py-2">
              <House size={16} strokeWidth={1.75} className="text-ink-500 shrink-0" aria-hidden />
              <span className="text-sm text-ink-800 truncate flex-1" title={p.baseLocation.address}>{p.baseLocation.address}</span>
              <button type="button" onClick={p.onClearBase} className="icon-btn hover:text-rose-700" title="Rimuovi la base generale" aria-label="Rimuovi la base generale">
                <Trash2 size={16} strokeWidth={1.75} />
              </button>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 max-w-sm">
          <label>
            <span className="field-label">Inizio giornata</span>
            <input type="time" value={p.startTime} onChange={e => p.onStartTime(e.target.value)} className="input num" />
          </label>
          <label>
            <span className="field-label">Fine giornata</span>
            <input type="time" value={p.endTimeLimit} onChange={e => p.onEndTime(e.target.value)} className="input num" />
          </label>
        </div>
        <p className="field-hint">Ogni tecnico ha i suoi orari nella sua scheda.</p>
      </div>
    </Panel>

    <Panel testId="settings-pilota" title="Pilota automatico, bridge e cloud" text="Fascia oraria delle chiamate, tentativi, smistamento automatico, collegamento al bridge dei portali e al cloud.">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <span className={`chip ${p.autopilotOn ? 'chip-ai' : 'chip-neutral'}`}><Bot size={13} strokeWidth={1.75} aria-hidden /> Pilota {p.autopilotOn ? 'attivo' : 'spento'}</span>
        <span className={`chip ${p.bridgeOn ? 'chip-success' : 'chip-neutral'}`}><Plug size={13} strokeWidth={1.75} aria-hidden /> Bridge {p.bridgeOn ? 'acceso' : 'spento'}</span>
        <span className={`chip ${p.cloudOn ? 'chip-info' : 'chip-neutral'}`}><Cloud size={13} strokeWidth={1.75} aria-hidden /> Cloud {p.cloudOn ? 'collegato' : 'non collegato'}</span>
      </div>
      <button type="button" className="btn btn-secondary" onClick={p.onOpenAutopilotSettings}>
        <Bot size={16} strokeWidth={1.75} aria-hidden /> Apri le impostazioni del pilota
      </button>
    </Panel>

    <Panel testId="settings-tecnici" title="Tecnici" text="Chi fa i sopralluoghi: zone di competenza, base di partenza, orari e indisponibilità.">
      {p.technicians.length > 0 && (
        <ul className="mb-4 divide-y divide-line rounded-control border border-line">
          {p.technicians.map(t => (
            <li key={t.id}>
              <button type="button" className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50" onClick={() => p.onOpenTech(t.id)}>
                <span className="dot h-2.5 w-2.5" style={{ backgroundColor: t.color }} />
                <span className="text-sm font-medium text-ink-900 flex-1 truncate">{t.name}</span>
                {!t.active && <span className="chip chip-neutral">non attivo</span>}
                <span className="num text-xs text-ink-500">{t.workStart}–{t.workEnd}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-secondary" onClick={() => p.onOpenTech()}>
        <Users size={16} strokeWidth={1.75} aria-hidden /> Gestisci tecnici
      </button>
    </Panel>

    <Panel testId="settings-gestionale" title="Gestionale" text="I sopralluoghi confermati vengono inviati al gestionale ogni ora; puoi farlo anche subito.">
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" className="btn btn-secondary" onClick={p.onSyncGestionale} disabled={p.isSyncing}>
          <RefreshCw size={16} strokeWidth={1.75} className={p.isSyncing ? 'animate-spin' : ''} aria-hidden /> {p.isSyncing ? 'Sincronizzazione…' : 'Sincronizza col gestionale'}
        </button>
        <span className="text-xs text-ink-500">{p.lastSyncInfo ? `Ultima: ${p.lastSyncInfo}` : p.syncHint}</span>
      </div>
    </Panel>
  </div>
);

export default SettingsSection;
