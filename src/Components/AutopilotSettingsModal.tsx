import React, { useState } from 'react';
import type { AutopilotSettings } from '../services/autopilotService';
import { checkBridgeHealth, fetchBridgeSnapshot, type BridgeSettings } from '../services/bridgeService';
import type { Appointment } from '../types';
import type { CloudConfig } from '../services/cloudProtocol';
import type { CloudSettings } from '../services/cloudSettings';
import type { CloudCredential } from '../services/cloudSync';
import CloudSection from './CloudSection';
import {
  Activity, CalendarRange, CircleAlert, CircleCheck, CircleX, Cloud, Phone, Plug, Settings2, TriangleAlert, type LucideIcon,
} from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { Field, SettingGroup, SettingRow, Spinner, Switch, ic } from './modal/parts';

type SettingsTab = 'calls' | 'planning' | 'bridge' | 'cloud';

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
  // Dentro il gestionale: accesso e bridge li gestisce il gestionale
  gestionale?: { user: { name: string; role: string }; credential: CloudCredential } | null;
}

const clampInt = (raw: string, min: number, max: number, fallback: number): number => {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const AutopilotSettingsModal: React.FC<AutopilotSettingsModalProps> = ({
  autopilot, bridge, onSave, onClose, cloud, getLocalCloudData, onCloudActivate, onCloudDisconnect, onCloudKeySave, gestionale,
}) => {
  const embedded = !!gestionale;
  // Dentro il gestionale i campi manuali del bridge restano visibili ma spenti
  const wrapBridgeFields = (fields: React.ReactNode) =>
    embedded ? <fieldset disabled className="min-w-0 space-y-4 opacity-60">{fields}</fieldset> : fields;
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
  // Scheda visibile: il contenuto di tutte resta montato (nascosto), così i
  // valori non si perdono passando da una all'altra
  const [tab, setTab] = useState<SettingsTab>('calls');

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
      message: `Collegato: ${snap.snapshot.pratiche.length} ${snap.snapshot.pratiche.length === 1 ? 'pratica disponibile' : 'pratiche disponibili'}` +
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
    // Dentro il gestionale bridge e chiave non si toccano (restano quelle salvate)
    onSave(next, embedded ? bridge : { ...br, url: br.url.trim() || bridge.url, token: br.token.trim() });
    // La chiave serve anche alle chiamate manuali: si salva pure a cloud spento
    if (!embedded && cloudKeyDraft.trim() !== cloud.key) onCloudKeySave(cloudKeyDraft.trim());
    onClose();
  };

  const numInput = 'input num w-24 shrink-0 text-right';
  const check = (key: 'callSaturday' | 'offerAlternatives' | 'backfill' | 'sameDayChanges' | 'autoDispatch' | 'autoApprove', text: React.ReactNode, hint?: string) => (
    <SettingRow asLabel label={text} hint={hint}>
      <Switch checked={ap[key]} onChange={e => set(key, e.target.checked)} />
    </SettingRow>
  );

  const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
    { id: 'calls', label: 'Chiamate', icon: Phone },
    { id: 'planning', label: 'Pianificazione', icon: CalendarRange },
    { id: 'bridge', label: 'Bridge portali', icon: Plug },
    { id: 'cloud', label: 'Cloud', icon: Cloud },
  ];

  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex(t => t.id === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };

  const tabs = (
    <div role="tablist" aria-label="Sezioni delle impostazioni" onKeyDown={onTabKey} className="flex gap-1 overflow-x-auto px-5 max-sm:px-3">
      {TABS.map(t => {
        const selected = tab === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            id={`settings-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`settings-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={`relative inline-flex h-11 shrink-0 items-center gap-2 px-2.5 text-[13px] font-medium transition-colors sm:px-3 sm:text-sm ${
              selected
                ? 'text-ink-950 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink-900'
                : 'text-ink-500 hover:text-ink-900'
            }`}
          >
            <Icon {...ic} className={`max-sm:hidden ${selected ? 'text-ink-700' : 'text-ink-400'}`} />
            {t.label}
          </button>
        );
      })}
    </div>
  );

  const panel = (id: SettingsTab, children: React.ReactNode) => (
    <div
      role="tabpanel"
      id={`settings-panel-${id}`}
      aria-labelledby={`settings-tab-${id}`}
      hidden={tab !== id}
      className="space-y-5"
    >
      {children}
    </div>
  );

  return (
    <ModalShell
      icon={Settings2}
      tone="ai"
      title="Impostazioni del pilota"
      subtitle="Come e quando il pilota automatico chiama, pianifica e si collega."
      onClose={onClose}
      size="lg"
      toolbar={tabs}
      bodyClassName="modal-body flex-1 min-h-0 max-sm:px-4 sm:basis-[560px]"
      footer={
        <>
          {error && (
            <div role="alert" className="callout callout-danger mr-auto w-full py-2 sm:w-auto sm:flex-1">
              <CircleAlert {...ic} className="mt-0.5 shrink-0 text-rose-600" />
              <p>{error}</p>
            </div>
          )}
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Annulla
          </button>
          <button type="button" onClick={handleSave} className="btn btn-primary min-w-[96px]">
            Salva
          </button>
        </>
      }
    >
          {panel('calls', (
            <>
              <section>
                <h3 className="section-title mb-1">Quando chiamare</h3>
                <p className="mb-3 text-[13px] text-ink-500">Il pilota chiama i clienti solo in questa fascia oraria.</p>
                <SettingGroup>
                  <SettingRow label="Fascia chiamate" hint="Inizio e fine, ora locale.">
                    <span className="flex shrink-0 items-center gap-1.5 text-sm text-ink-400">
                      <input aria-label="Inizio fascia chiamate" type="time" value={ap.callWindowStart} onChange={e => set('callWindowStart', e.target.value)} className="input num w-[128px]" />
                      –
                      <input aria-label="Fine fascia chiamate" type="time" value={ap.callWindowEnd} onChange={e => set('callWindowEnd', e.target.value)} className="input num w-[128px]" />
                    </span>
                  </SettingRow>
                  {check('callSaturday', 'Chiama anche il sabato', 'La domenica mai.')}
                </SettingGroup>
              </section>
              <section>
                <h3 className="section-title mb-3">Se non risponde</h3>
                <SettingGroup>
                  <SettingRow label="Tentativi massimi se non risponde" htmlFor="ap-max-attempts">
                    <input id="ap-max-attempts" type="number" min={1} max={10} value={nums.maxAttempts} onChange={e => setNums(n => ({ ...n, maxAttempts: e.target.value }))} className={numInput} />
                  </SettingRow>
                  <SettingRow label="Minuti fra un tentativo e l'altro" htmlFor="ap-retry-minutes">
                    <input id="ap-retry-minutes" type="number" min={15} max={1440} value={nums.retryMinutes} onChange={e => setNums(n => ({ ...n, retryMinutes: e.target.value }))} className={numInput} />
                  </SettingRow>
                </SettingGroup>
              </section>
              <section>
                <h3 className="section-title mb-3">Se il cliente non può</h3>
                <SettingGroup>
                  {check('offerAlternatives', 'Offri alternative reali se il cliente non può', 'Fino a 3 slot liberi verificati sui giri del tecnico.')}
                  {check('backfill', 'Riempi gli slot liberati', 'Chi rifiuta libera lo slot: entra un\'altra pratica e viene chiamata.')}
                  <SettingRow label="Anticipo minimo (ore)" hint="Non proporre né riempire slot che iniziano prima." htmlFor="ap-min-lead">
                    <input id="ap-min-lead" type="number" min={0} max={72} value={nums.minLeadHours} onChange={e => setNums(n => ({ ...n, minLeadHours: e.target.value }))} className={numInput} />
                  </SettingRow>
                  {check('sameDayChanges', 'Consenti cambi per il giorno stesso', 'Spento: alternative e rimpiazzi valgono solo dal giorno dopo. Accendilo solo se i tecnici vedono in tempo reale le modifiche al giro.')}
                </SettingGroup>
              </section>
            </>
          ))}

          {panel('planning', (
            <section>
              <h3 className="section-title mb-1">Smistamento</h3>
              <p className="mb-3 text-[13px] text-ink-500">Le pratiche in attesa diventano giri proposti, da approvare prima delle chiamate.</p>
              <SettingGroup>
                {check('autoDispatch', 'Smistamento automatico', 'Le pratiche in attesa con telefono vengono smistate da sole in giri proposti, senza toccare gli orari dei giri esistenti.')}
                <SettingRow label="Orizzonte (giorni)" hint="Quanti giorni avanti pianificare." htmlFor="ap-horizon">
                  <input id="ap-horizon" type="number" min={1} max={60} value={nums.dispatchHorizonDays} onChange={e => setNums(n => ({ ...n, dispatchHorizonDays: e.target.value }))} className={numInput} />
                </SettingRow>
                {check('autoApprove', 'Chiama senza approvazione')}
              </SettingGroup>
              {ap.autoApprove && (
                <div className="callout callout-danger mt-3">
                  <TriangleAlert {...ic} className="mt-0.5 shrink-0 text-rose-600" />
                  <p className="leading-5">
                    <b className="font-semibold">Attenzione:</b> i clienti verranno chiamati senza che nessuno abbia guardato i giri proposti.
                    Lascialo spento se vuoi controllare i giri e premere "Approva e chiama".
                  </p>
                </div>
              )}
            </section>
          ))}

          {panel('bridge', (
            <section className="space-y-4">
              <div>
                <h3 className="section-title mb-1">Bridge dei portali</h3>
                <p className="text-[13px] leading-5 text-ink-500">
                  Il programma sul PC che legge le pratiche dai portali: con il bridge acceso le pratiche arrivano da sole (ogni 5 minuti).
                </p>
              </div>
              {embedded && (
                <div data-testid="bridge-gestionale-note" className="callout callout-success">
                  <Plug {...ic} className="mt-0.5 shrink-0 text-emerald-600" />
                  <p className="leading-5">
                    Il bridge è gestito dalla pagina del gestionale: si avvia e si attiva dalla barra in alto del gestionale e le pratiche arrivano da sole.
                    Indirizzo e token qui sotto non servono.
                  </p>
                </div>
              )}
              {wrapBridgeFields(<>
              <SettingGroup>
                <SettingRow asLabel label="Bridge acceso">
                  <Switch checked={embedded ? true : br.enabled} onChange={e => setBr(b => ({ ...b, enabled: e.target.checked }))} />
                </SettingRow>
              </SettingGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Indirizzo" htmlFor="bridge-url">
                  <input id="bridge-url" type="text" value={br.url} onChange={e => setBr(b => ({ ...b, url: e.target.value }))} className="input num" />
                </Field>
                <Field label="Token" htmlFor="bridge-token" hint="Lo trovi nel terminale del bridge.">
                  <input
                    id="bridge-token"
                    type="password"
                    autoComplete="off"
                    value={br.token}
                    onChange={e => setBr(b => ({ ...b, token: e.target.value }))}
                    placeholder="Incolla il token stampato dal bridge"
                    className="input num"
                  />
                </Field>
              </div>
              </>)}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={embedded || test.state === 'running'}
                  className="btn btn-secondary btn-sm"
                >
                  {test.state === 'running' ? <Spinner size={14} /> : <Activity {...ic} size={14} />}
                  Prova collegamento
                </button>
                {test.state !== 'idle' && (
                  <span
                    role="status"
                    className={`inline-flex min-w-0 items-start gap-1.5 text-[13px] leading-5 ${
                      test.state === 'ok' ? 'text-emerald-700' : test.state === 'error' ? 'text-rose-700' : 'text-ink-500'
                    }`}
                  >
                    {test.state === 'ok' && <CircleCheck {...ic} className="mt-0.5 shrink-0" />}
                    {test.state === 'error' && <CircleX {...ic} className="mt-0.5 shrink-0" />}
                    <span>{test.message}</span>
                  </span>
                )}
              </div>
            </section>
          ))}

          {panel('cloud', (
            <CloudSection
              cloud={cloud}
              getLocalCloudData={getLocalCloudData}
              onActivate={key => { setCloudKeyDraft(key); onCloudActivate(key); }}
              onDisconnect={() => { set('enabled', false); onCloudDisconnect(); }}
              onKeySave={onCloudKeySave}
              keyDraft={cloudKeyDraft}
              setKeyDraft={setCloudKeyDraft}
              gestionale={gestionale}
            />
          ))}
    </ModalShell>
  );
};

export default AutopilotSettingsModal;
