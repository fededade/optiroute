import React, { useState } from 'react';
import type { Appointment } from '../types';
import type { CloudConfig } from '../services/cloudProtocol';
import type { CloudSettings } from '../services/cloudSettings';
import { cloudPing, cloudStatus, describeCloudFailure } from '../services/cloudSync';
import { replaceCloudData, schedulerFresh, startActivation } from '../services/cloudSyncCore';
import {
  Activity, Check, CircleAlert, CircleCheck, CircleDashed, CircleX, Cloud, CloudDownload, CloudUpload, Copy, Info,
  KeyRound, TriangleAlert, Unplug, type LucideIcon,
} from 'lucide-react';
import { Spinner, ic } from './modal/parts';

// Sezione "Cloud" delle impostazioni del pilota: chiave di accesso, prova del
// collegamento (elenco di controlli con stato), indirizzo del webhook per Retell,
// attivazione su questo browser e scollegamento. Le azioni hanno effetto
// subito (non passano dal "Salva" della modale).

type CheckState = 'ok' | 'ko' | 'info';
interface CloudCheck { id: string; state: CheckState; label: string; detail: string }

const fmtWhen = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

// Controlli del collegamento: ping (senza chiave) + stato (con chiave)
const runCloudChecks = async (key: string): Promise<{ checks: CloudCheck[]; webhookUrl: string | null }> => {
  const checks: CloudCheck[] = [];
  const ping = await cloudPing({});
  if (!ping.ok) {
    checks.push({
      id: 'reach', state: 'ko', label: 'Cloud raggiungibile',
      detail: ping.error.kind === 'offline'
        ? 'Le funzioni /api/cloud non rispondono: girano solo sul deploy Vercel (non nel server di sviluppo locale).'
        : describeCloudFailure(ping.error),
    });
    return { checks, webhookUrl: null };
  }
  const status = ping.data.secretConfigured && key ? await cloudStatus({ key }) : null;

  if (!ping.data.secretConfigured) {
    checks.push({ id: 'key', state: 'ko', label: 'Chiave accettata', detail: 'Su Vercel manca la variabile CRON_SECRET: impostala e rifai il deploy.' });
  } else if (!key) {
    checks.push({ id: 'key', state: 'ko', label: 'Chiave accettata', detail: 'Inserisci la chiave di accesso (il valore di CRON_SECRET su Vercel).' });
  } else if (status && !status.ok && status.error.kind === 'auth') {
    checks.push({ id: 'key', state: 'ko', label: 'Chiave accettata', detail: 'Chiave errata: deve essere identica a CRON_SECRET impostato su Vercel.' });
  } else if (status && status.ok) {
    checks.push({ id: 'key', state: 'ok', label: 'Chiave accettata', detail: 'Il server ha riconosciuto la chiave.' });
  } else {
    checks.push({ id: 'key', state: 'info', label: 'Chiave accettata', detail: status && !status.ok ? describeCloudFailure(status.error) : 'Non verificabile adesso.' });
  }

  checks.push(ping.data.storeConfigured
    ? { id: 'store', state: 'ok', label: 'Database collegato', detail: 'Pratiche e configurazione vengono salvate sul cloud.' }
    : { id: 'store', state: 'ko', label: 'Database collegato', detail: 'Manca il database: collegalo nel pannello Storage del progetto Vercel e rifai il deploy.' });

  if (!status || !status.ok) return { checks, webhookUrl: null };
  const st = status.data;
  checks.push(st.retellConfigured
    ? { id: 'retell', state: 'ok', label: 'Retell configurato', detail: 'Le chiavi per le chiamate sono presenti sul server.' }
    : { id: 'retell', state: 'ko', label: 'Retell configurato', detail: 'Mancano le chiavi Retell sul server: il pilota non potrebbe chiamare.' });
  checks.push(st.timezone?.ok
    ? { id: 'tz', state: 'ok', label: 'Fuso orario del server', detail: `Corretto (${st.timezone.zone}).` }
    : { id: 'tz', state: 'ko', label: 'Fuso orario del server', detail: `Non corretto (${st.timezone?.zone || 'sconosciuto'}): le fasce orarie delle chiamate non sarebbero rispettate.` });
  // Sulle anteprime (Preview) Vercel crea gli Schedules spenti: vanno accesi a mano.
  // In produzione partono accesi. Senza questa indicazione la prova "a browser
  // chiuso" su un'anteprima sembra un guasto.
  const schedulerHelp = st.env === 'preview'
    ? ' Questa è un\'anteprima (Preview): qui Vercel crea lo scheduler spento. Per provare a browser chiuso accendilo da Vercel → Schedules → Environment: Preview → questo ramo → "pilota-automatico" → menu accanto a "Run Schedule" → Enable. In produzione è acceso da solo.'
    : ' Controlla gli Schedules del progetto su Vercel.';
  if (!st.schedulerSeenAt) {
    checks.push({ id: 'scheduler', state: 'ko', label: 'Scheduler visto di recente', detail: `Non ancora visto. Passa ogni 15 minuti fra le 7 e le 21 (può tardare fino a 15 minuti): il primo passaggio arriva in quella fascia. Senza scheduler il pilota avanza solo a browser aperto.${st.env === 'preview' ? schedulerHelp : ''}` });
  } else if (schedulerFresh(st.schedulerSeenAt, Date.now())) {
    checks.push({ id: 'scheduler', state: 'ok', label: 'Scheduler visto di recente', detail: `Ultimo passaggio ${fmtWhen(st.schedulerSeenAt)}: si può chiudere il browser.` });
  } else {
    checks.push({ id: 'scheduler', state: 'ko', label: 'Scheduler visto di recente', detail: `Ultimo passaggio ${fmtWhen(st.schedulerSeenAt)}, da troppo tempo (dovrebbe passare ogni 15 minuti fra le 7 e le 21): a browser chiuso il pilota non avanza.${schedulerHelp}` });
  }
  checks.push(st.webhookSeenAt
    ? { id: 'webhook', state: 'ok', label: 'Avvisi di fine chiamata da Retell', detail: `Ultimo avviso ${fmtWhen(st.webhookSeenAt)}.` }
    : { id: 'webhook', state: 'info', label: 'Avvisi di fine chiamata da Retell (facoltativi)', detail: 'Nessuno ancora: incolla in Retell l\'indirizzo qui sotto per avere gli esiti subito (senza, arrivano al passaggio successivo del motore).' });
  const webhookUrl = st.webhookPath && typeof location !== 'undefined' ? `${location.origin}${st.webhookPath}` : null;
  return { checks, webhookUrl };
};

// Stato di ogni controllo: icona, colore e etichetta leggibile. Il simbolo
// testuale (✓ ✗ ○) resta per le tecnologie assistive e per le prove.
const CHECK_ICON: Record<CheckState, { icon: LucideIcon; symbol: string; cls: string }> = {
  ok: { icon: CircleCheck, symbol: '✓', cls: 'text-emerald-600' },
  ko: { icon: CircleX, symbol: '✗', cls: 'text-rose-600' },
  info: { icon: CircleDashed, symbol: '○', cls: 'text-ink-400' },
};

const checkChip = (c: CloudCheck): { text: string; cls: string } => {
  if (c.state === 'ok') return { text: 'ok', cls: 'chip-success' };
  if (c.state === 'ko') return { text: 'errore', cls: 'chip-danger' };
  return /facoltativ/i.test(c.label) ? { text: 'facoltativo', cls: 'chip-neutral' } : { text: 'da verificare', cls: 'chip-warn' };
};

interface CloudSectionProps {
  cloud: CloudSettings;
  getLocalCloudData: () => { appointments: Appointment[]; config: CloudConfig };
  onActivate: (key: string) => void;
  onDisconnect: () => void;
  onKeySave: (key: string) => void;
  keyDraft: string;
  setKeyDraft: (key: string) => void;
}

type ActivationUi =
  | { step: 'idle' }
  | { step: 'working'; message: string }
  | { step: 'choose'; serverCount: number; localCount: number }
  | { step: 'error'; message: string }
  | { step: 'done'; message: string };

const plural = (n: number) => `${n} ${n === 1 ? 'pratica' : 'pratiche'}`;

const CloudSection: React.FC<CloudSectionProps> = ({ cloud, getLocalCloudData, onActivate, onDisconnect, onKeySave, keyDraft, setKeyDraft }) => {
  const active = cloud.enabled && !!cloud.key;
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<CloudCheck[] | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [act, setAct] = useState<ActivationUi>({ step: 'idle' });
  const key = keyDraft.trim();

  const handleCheck = async () => {
    setChecking(true);
    setChecks(null);
    try {
      const r = await runCloudChecks(key);
      setChecks(r.checks);
      setWebhookUrl(r.webhookUrl);
    } finally {
      setChecking(false);
    }
  };

  const handleCopy = async () => {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copia l\'indirizzo:', webhookUrl);
    }
  };

  const handleActivate = async () => {
    if (!key) { setAct({ step: 'error', message: 'Inserisci prima la chiave di accesso.' }); return; }
    setAct({ step: 'working', message: 'Controllo i dati sul cloud...' });
    const local = getLocalCloudData();
    const out = await startActivation({ key }, { deviceId: cloud.deviceId, ...local });
    if (out.kind === 'error') { setAct({ step: 'error', message: describeCloudFailure(out.error) }); return; }
    if (out.kind === 'choose') { setAct({ step: 'choose', serverCount: out.serverCount, localCount: out.localCount }); return; }
    onActivate(key);
    setAct({
      step: 'done',
      message: out.plan === 'upload'
        ? `Cloud attivo: caricate sul cloud le ${plural(local.appointments.length)} di questo browser.`
        : `Cloud attivo: questo browser usa le ${plural(out.serverCount)} del cloud.`,
    });
  };

  const handleUseCloud = (serverCount: number) => {
    onActivate(key);
    setAct({ step: 'done', message: `Cloud attivo: questo browser usa le ${plural(serverCount)} del cloud.` });
  };

  const handleReplace = async (serverCount: number, localCount: number) => {
    const ok = window.confirm(
      `ATTENZIONE: le ${plural(serverCount)} sul cloud verranno CANCELLATE e sostituite con le ${plural(localCount)} di questo browser.\n\n` +
      'Anche gli esiti e le chiamate registrate dal pilota sul cloud andranno persi, e gli altri dispositivi collegati vedranno i dati di questo browser.\n\nProcedere?'
    );
    if (!ok) return;
    setAct({ step: 'working', message: 'Sostituisco i dati del cloud...' });
    const r = await replaceCloudData({ key }, { deviceId: cloud.deviceId, ...getLocalCloudData() });
    if (!r.ok) { setAct({ step: 'error', message: describeCloudFailure(r.error) }); return; }
    onActivate(key);
    setAct({ step: 'done', message: `Cloud attivo: il cloud ora ha le ${plural(localCount)} di questo browser.` });
  };

  const handleDisconnect = () => {
    const ok = window.confirm(
      'Scollegare questo browser dal cloud?\n\n' +
      'Il pilota CONTINUA a lavorare sul cloud (chiamate, richiami, esiti) con lo scheduler e per gli altri dispositivi collegati.\n' +
      'Su questo browser restano i dati dell\'ultimo scambio e il pilota locale viene spento, per non avere due motori sugli stessi clienti.\n\n' +
      'Per fermare anche il pilota in cloud: prima "Pausa", poi scollega.'
    );
    if (!ok) return;
    onDisconnect();
    setAct({ step: 'done', message: 'Browser scollegato dal cloud. Il pilota locale è spento.' });
  };

  return (
    <section data-testid="cloud-section" className="space-y-5">
      <div>
        <h3 className="section-title mb-1">Cloud: il pilota lavora anche a browser chiuso</h3>
        <p className="text-[13px] leading-5 text-ink-500">
          Pratiche e pilota stanno sul server (Vercel): le chiamate partono anche a PC spento e gli stessi dati si vedono da più computer.
        </p>
      </div>

      {active && (
        <div data-testid="cloud-active" className="callout callout-success py-2.5">
          <Cloud {...ic} className="mt-0.5 shrink-0 text-emerald-600" />
          <p className="font-medium">Cloud attivo su questo browser</p>
        </div>
      )}

      <div>
        <label htmlFor="cloud-key" className="field-label">Chiave di accesso</label>
        <div className="flex flex-wrap gap-2">
          <input
            id="cloud-key"
            type="password"
            autoComplete="off"
            aria-label="Chiave di accesso del cloud"
            value={keyDraft}
            onChange={e => setKeyDraft(e.target.value)}
            placeholder="Il valore di CRON_SECRET impostato su Vercel"
            className="input num min-w-0 flex-1"
          />
          {active && key && key !== cloud.key && (
            <button type="button" onClick={() => onKeySave(key)} className="btn btn-secondary shrink-0">
              <KeyRound {...ic} />
              Usa questa chiave
            </button>
          )}
        </div>
        <p className="field-hint">La stessa chiave serve anche alle chiamate manuali.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleCheck}
          disabled={checking}
          className="btn btn-secondary"
        >
          {checking ? <Spinner /> : <Activity {...ic} />}
          {checking ? 'Verifico...' : 'Prova collegamento'}
        </button>
        {!active ? (
          <button
            type="button"
            onClick={handleActivate}
            disabled={act.step === 'working' || !key}
            className="btn btn-primary"
          >
            <CloudUpload {...ic} />
            Attiva il cloud su questo browser
          </button>
        ) : (
          <button type="button" onClick={handleDisconnect} className="btn btn-danger">
            <Unplug {...ic} />
            Scollega questo browser
          </button>
        )}
      </div>

      {act.step === 'working' && (
        <p role="status" className="flex items-center gap-2 text-[13px] text-ink-600">
          <Spinner />
          {act.message}
        </p>
      )}
      {act.step === 'error' && (
        <div data-testid="cloud-activation-error" role="alert" className="callout callout-danger">
          <CircleAlert {...ic} className="mt-0.5 shrink-0 text-rose-600" />
          <p className="leading-5">{act.message}</p>
        </div>
      )}
      {act.step === 'done' && (
        <div data-testid="cloud-activation-done" role="status" className="callout callout-success">
          <CircleCheck {...ic} className="mt-0.5 shrink-0 text-emerald-600" />
          <p className="leading-5">{act.message}</p>
        </div>
      )}
      {act.step === 'choose' && (
        <div data-testid="cloud-choose" className="rounded-card border border-amber-200 bg-amber-50 p-4">
          <p className="flex items-start gap-2.5 text-sm leading-5 text-amber-900">
            <TriangleAlert {...ic} className="mt-0.5 shrink-0 text-amber-600" />
            <span>
              Sul cloud ci sono già <b className="font-semibold">{plural(act.serverCount)}</b> e questo browser ne ha <b className="font-semibold">{act.localCount}</b>. Quali dati tenere?
            </span>
          </p>
          <div className="mt-3 grid gap-2">
            <button type="button" onClick={() => handleUseCloud(act.serverCount)} className="btn btn-primary h-auto justify-start whitespace-normal py-2.5 text-left">
              <CloudDownload {...ic} className="shrink-0" />
              <span>Usa i dati del cloud ({plural(act.serverCount)}) <span className="font-normal text-ink-300">· consigliato</span></span>
            </button>
            <button
              type="button"
              onClick={() => handleReplace(act.serverCount, act.localCount)}
              className="btn btn-danger h-auto justify-start whitespace-normal py-2.5 text-left"
            >
              <CloudUpload {...ic} className="shrink-0" />
              <span>Sostituisci il cloud con i dati di questo browser ({plural(act.localCount)})</span>
            </button>
            <button type="button" onClick={() => setAct({ step: 'idle' })} className="btn btn-secondary">
              Annulla
            </button>
          </div>
        </div>
      )}

      {checks && (
        <div>
          <h4 className="mb-2 text-[13px] font-medium text-ink-700">Controlli del collegamento</h4>
          <ul data-testid="cloud-checks" className="card divide-y divide-line overflow-hidden shadow-none">
            {checks.map(c => {
              const st = CHECK_ICON[c.state];
              const Icon = st.icon;
              const chip = checkChip(c);
              return (
                <li key={c.id} data-check={c.id} data-state={c.state} className="flex items-start gap-3 px-4 py-3">
                  <Icon size={18} strokeWidth={1.75} aria-hidden="true" className={`mt-px shrink-0 ${st.cls}`} />
                  <span className="sr-only">{st.symbol}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink-900">{c.label}</span>
                    <span className="mt-0.5 block text-xs leading-4 text-ink-500">{c.detail}</span>
                  </span>
                  <span className={`chip ${chip.cls} shrink-0`}>{chip.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {webhookUrl && (
        <div>
          <label htmlFor="cloud-webhook" className="field-label">Indirizzo da incollare in Retell come webhook</label>
          <div className="flex gap-2">
            <input
              id="cloud-webhook"
              readOnly
              value={webhookUrl}
              onFocus={e => e.target.select()}
              data-testid="cloud-webhook"
              className="input num min-w-0 flex-1 bg-slate-50 text-xs"
            />
            <button type="button" onClick={handleCopy} className="btn btn-secondary shrink-0">
              {copied ? <Check {...ic} className="text-emerald-600" /> : <Copy {...ic} />}
              {copied ? 'Copiato' : 'Copia'}
            </button>
          </div>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-ink-400">
        <Info {...ic} size={14} />
        Attivazione e scollegamento hanno effetto subito (non serve "Salva").
      </p>
    </section>
  );
};

export default CloudSection;
