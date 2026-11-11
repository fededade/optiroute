import React, { useState } from 'react';
import type { AutopilotSettings } from '../services/autopilotService';
import { checkBridgeHealth, fetchBridgeSnapshot, type BridgeSettings } from '../services/bridgeService';
import type { Appointment } from '../types';
import type { CloudConfig } from '../services/cloudProtocol';
import type { CloudSettings } from '../services/cloudSettings';
import CloudSection from './CloudSection';

// Impostazioni del pilota automatico e del bridge dei portali. Si modifica
// una bozza: nulla cambia finché non si preme "Salva".

interface AutopilotSettingsModalProps {
  autopilot: AutopilotSettings;
  bridge: BridgeSettings;
  onSave: (autopilot: AutopilotSettings, bridge: BridgeSettings) => void;
  onClose: () => void;
  // Cloud (pilota che lavora anche a browser chiuso)
  cloud: CloudSettings;
  getLocalCloudData: () => { appointments: Appointment[]; config: CloudConfig };
  onCloudActivate: (key: string) => void;   // attiva il cloud su questo browser
  onCloudDisconnect: () => void;            // scollega (pilota locale spento)
  onCloudKeySave: (key: string) => void;    // salva solo la chiave
}

const clampInt = (raw: string, min: number, max: number, fallback: number): number => {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const AutopilotSettingsModal: React.FC<AutopilotSettingsModalProps> = ({
  autopilot, bridge, onSave, onClose, cloud, getLocalCloudData, onCloudActivate, onCloudDisconnect, onCloudKeySave,
}) => {
  const [cloudKeyDraft, setCloudKeyDraft] = useState(cloud.key);
  const [ap, setAp] = useState<AutopilotSettings>(autopilot);
  const [br, setBr] = useState<BridgeSettings>(bridge);
  // Campi numerici come testo durante la digitazione
  const [nums, setNums] = useState({
    maxAttempts: String(autopilot.maxAttempts),
    retryMinutes: String(autopilot.retryMinutes),
    minLeadHours: String(autopilot.minLeadHours),
    dispatchHorizonDays: String(autopilot.dispatchHorizonDays),
  });
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; message: string }>({ state: 'idle', message: '' });
  const [error, setError] = useState('');

  const set = <K extends keyof AutopilotSettings>(key: K, value: AutopilotSettings[K]) => setAp(p => ({ ...p, [key]: value }));

  const handleTest = async () => {
    setTest({ state: 'running', message: 'Verifico il collegamento...' });
    const health = await checkBridgeHealth(br.url);
    if (!health.ok) {
      setTest({
        state: 'error',
        message: health.error === 'offline'
          ? 'Bridge non raggiungibile: avvia il bridge sul PC e controlla l\'indirizzo.'
          : health.message,
      });
      return;
    }
    if (!br.token.trim()) {
      setTest({ state: 'error', message: 'Il bridge risponde, ma manca il token (lo trovi nel terminale del bridge).' });
      return;
    }
    const snap = await fetchBridgeSnapshot(br);
    if (!snap.ok) {
      setTest({ state: 'error', message: snap.error === 'token' ? 'Il bridge risponde, ma il token è errato.' : snap.message });
      return;
    }
    const login = snap.snapshot.portals.find(p => p.status === 'login_required');
    setTest({
      state: 'ok',
      message: `Collegato: ${snap.snapshot.pratiche.length} pratiche disponibili` +
        (login ? ` · login richiesto su ${login.id}: completa l'accesso con MFA nel Chrome del bridge` : ''),
    });
  };

  const handleSave = () => {
    if (ap.callWindowStart >= ap.callWindowEnd) {
      setError('La fascia chiamate deve finire dopo l\'inizio.');
      return;
    }
    const next: AutopilotSettings = {
      ...ap,
      maxAttempts: clampInt(nums.maxAttempts, 1, 10, autopilot.maxAttempts),
      retryMinutes: clampInt(nums.retryMinutes, 15, 24 * 60, autopilot.retryMinutes),
      minLeadHours: clampInt(nums.minLeadHours, 0, 72, autopilot.minLeadHours),
      dispatchHorizonDays: clampInt(nums.dispatchHorizonDays, 1, 60, autopilot.dispatchHorizonDays),
    };
    onSave(next, { ...br, url: br.url.trim() || bridge.url, token: br.token.trim() });
    // La chiave serve anche alle chiamate manuali: si salva pure a cloud spento
    if (cloudKeyDraft.trim() !== cloud.key) onCloudKeySave(cloudKeyDraft.trim());
    onClose();
  };

  const row = 'flex items-center justify-between gap-3 py-1.5';
  const label = 'text-sm text-slate-700';
  const numInput = 'w-20 px-2 py-1 rounded border border-slate-300 text-sm text-right';
  const check = (key: 'callSaturday' | 'offerAlternatives' | 'backfill' | 'autoDispatch' | 'autoApprove', text: React.ReactNode, hint?: string) => (
    <label className={`${row} cursor-pointer`}>
      <span className={label}>
        {text}
        {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
      </span>
      <input type="checkbox" checked={ap[key]} onChange={e => set(key, e.target.checked)} className="rounded shrink-0" />
    </label>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-lg w-full max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3 shrink-0">
          <h3 className="text-lg font-bold text-slate-800">⚙ Pilota automatico</h3>
          <button onClick={onClose} title="Chiudi" className="text-slate-400 hover:text-slate-600 text-xl leading-none px-1">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto pr-1 space-y-4">
          <section>
            <h4 className="text-xs font-bold text-slate-500 uppercase mb-1">Chiamate</h4>
            <div className={row}>
              <span className={label}>Fascia chiamate</span>
              <span className="flex items-center gap-1 text-sm">
                <input aria-label="Inizio fascia chiamate" type="time" value={ap.callWindowStart} onChange={e => set('callWindowStart', e.target.value)} className="px-2 py-1 rounded border border-slate-300" />
                –
                <input aria-label="Fine fascia chiamate" type="time" value={ap.callWindowEnd} onChange={e => set('callWindowEnd', e.target.value)} className="px-2 py-1 rounded border border-slate-300" />
              </span>
            </div>
            {check('callSaturday', 'Chiama anche il sabato', 'La domenica mai.')}
            <div className={row}>
              <span className={label}>Tentativi massimi se non risponde</span>
              <input type="number" min={1} max={10} value={nums.maxAttempts} onChange={e => setNums(n => ({ ...n, maxAttempts: e.target.value }))} className={numInput} />
            </div>
            <div className={row}>
              <span className={label}>Minuti fra un tentativo e l'altro</span>
              <input type="number" min={15} max={1440} value={nums.retryMinutes} onChange={e => setNums(n => ({ ...n, retryMinutes: e.target.value }))} className={numInput} />
            </div>
            {check('offerAlternatives', 'Offri alternative reali se il cliente non può', 'Fino a 3 slot liberi verificati sui giri del tecnico.')}
            {check('backfill', 'Riempi gli slot liberati', 'Chi rifiuta libera lo slot: entra un\'altra pratica e viene chiamata.')}
            <div className={row}>
              <span className={label}>
                Anticipo minimo (ore)
                <span className="block text-[11px] text-slate-400">Non proporre né riempire slot che iniziano prima.</span>
              </span>
              <input type="number" min={0} max={72} value={nums.minLeadHours} onChange={e => setNums(n => ({ ...n, minLeadHours: e.target.value }))} className={numInput} />
            </div>
          </section>

          <section>
            <h4 className="text-xs font-bold text-slate-500 uppercase mb-1">Smistamento</h4>
            {check('autoDispatch', 'Smistamento automatico', 'Le pratiche in attesa con telefono vengono smistate da sole in giri proposti, senza toccare gli orari dei giri esistenti.')}
            <div className={row}>
              <span className={label}>Orizzonte (giorni)</span>
              <input type="number" min={1} max={60} value={nums.dispatchHorizonDays} onChange={e => setNums(n => ({ ...n, dispatchHorizonDays: e.target.value }))} className={numInput} />
            </div>
            {check('autoApprove', 'Chiama senza approvazione')}
            {ap.autoApprove && (
              <p className="text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded p-2">
                ⚠️ Attenzione: i clienti verranno chiamati senza che nessuno abbia guardato i giri proposti.
                Lascialo spento se vuoi controllare i giri e premere "Approva e chiama".
              </p>
            )}
          </section>

          <section>
            <h4 className="text-xs font-bold text-slate-500 uppercase mb-1">Bridge dei portali</h4>
            <p className="text-[11px] text-slate-400 mb-1">
              Il programma sul PC che legge le pratiche dai portali: con il bridge acceso le pratiche arrivano da sole (ogni 5 minuti).
            </p>
            <label className={`${row} cursor-pointer`}>
              <span className={label}>Bridge acceso</span>
              <input type="checkbox" checked={br.enabled} onChange={e => setBr(b => ({ ...b, enabled: e.target.checked }))} className="rounded" />
            </label>
            <div className="space-y-2">
              <div>
                <span className="block text-[11px] font-bold text-slate-500 mb-0.5">Indirizzo</span>
                <input type="text" value={br.url} onChange={e => setBr(b => ({ ...b, url: e.target.value }))} className="w-full px-2 py-1.5 rounded border border-slate-300 text-sm font-mono" />
              </div>
              <div>
                <span className="block text-[11px] font-bold text-slate-500 mb-0.5">Token</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={br.token}
                  onChange={e => setBr(b => ({ ...b, token: e.target.value }))}
                  placeholder="Incolla il token stampato dal bridge"
                  className="w-full px-2 py-1.5 rounded border border-slate-300 text-sm font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTest}
                  disabled={test.state === 'running'}
                  className="text-xs font-bold text-slate-700 border border-slate-300 bg-white hover:bg-slate-50 px-2 py-1 rounded disabled:opacity-50 shrink-0"
                >
                  Prova collegamento
                </button>
                {test.state !== 'idle' && (
                  <span className={`text-xs ${test.state === 'ok' ? 'text-emerald-700' : test.state === 'error' ? 'text-rose-700' : 'text-slate-500'}`}>
                    {test.message}
                  </span>
                )}
              </div>
            </div>
          </section>

          <CloudSection
            cloud={cloud}
            getLocalCloudData={getLocalCloudData}
            onActivate={key => { setCloudKeyDraft(key); onCloudActivate(key); }}
            onDisconnect={() => { set('enabled', false); onCloudDisconnect(); }}
            onKeySave={onCloudKeySave}
            keyDraft={cloudKeyDraft}
            setKeyDraft={setCloudKeyDraft}
          />
        </div>

        {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded p-2 mt-3 shrink-0">{error}</p>}

        <div className="flex gap-2 mt-4 shrink-0">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50">
            Annulla
          </button>
          <button onClick={handleSave} className="flex-1 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold">
            Salva
          </button>
        </div>
      </div>
    </div>
  );
};

export default AutopilotSettingsModal;
