import React, { useState } from 'react';
import type { Appointment } from '../types';
import type { CloudConfig } from '../services/cloudProtocol';
import type { CloudSettings } from '../services/cloudSettings';
import { cloudPing, cloudStatus, describeCloudFailure } from '../services/cloudSync';
import { replaceCloudData, schedulerFresh, startActivation } from '../services/cloudSyncCore';

// Sezione "Cloud" delle impostazioni del pilota: chiave di accesso, prova del
// collegamento (elenco di controlli ✓/✗), indirizzo del webhook per Retell,
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
  if (!st.schedulerSeenAt) {
    checks.push({ id: 'scheduler', state: 'ko', label: 'Scheduler visto di recente', detail: 'Non ancora visto: il primo passaggio arriva entro 15 minuti dal deploy; senza scheduler il pilota avanza solo a browser aperto.' });
  } else if (schedulerFresh(st.schedulerSeenAt, Date.now())) {
    checks.push({ id: 'scheduler', state: 'ok', label: 'Scheduler visto di recente', detail: `Ultimo passaggio ${fmtWhen(st.schedulerSeenAt)}: si può chiudere il browser.` });
  } else {
    checks.push({ id: 'scheduler', state: 'ko', label: 'Scheduler visto di recente', detail: `Ultimo passaggio ${fmtWhen(st.schedulerSeenAt)}, da troppo tempo: a browser chiuso il pilota non avanza. Controlla i Cron Jobs su Vercel.` });
  }
  checks.push(st.webhookSeenAt
    ? { id: 'webhook', state: 'ok', label: 'Avvisi di fine chiamata da Retell', detail: `Ultimo avviso ${fmtWhen(st.webhookSeenAt)}.` }
    : { id: 'webhook', state: 'info', label: 'Avvisi di fine chiamata da Retell (facoltativi)', detail: 'Nessuno ancora: incolla in Retell l\'indirizzo qui sotto per avere gli esiti subito (senza, arrivano al passaggio successivo del motore).' });
  checks.push(st.gestionaleSyncConfigured
    ? { id: 'gestionale', state: 'ok', label: 'Invio al gestionale dal server', detail: 'I confermati arrivano al gestionale anche a browser chiuso (al massimo ogni ora).' }
    : { id: 'gestionale', state: 'info', label: 'Invio al gestionale dal server (facoltativo)', detail: 'Non configurato: i confermati arrivano al gestionale quando l\'app è aperta. Per farlo anche a browser chiuso servono le variabili GESTIONALE_PROJECT_ID e GESTIONALE_API_KEY su Vercel.' });
  const webhookUrl = st.webhookPath && typeof location !== 'undefined' ? `${location.origin}${st.webhookPath}` : null;
  return { checks, webhookUrl };
};

const CHECK_ICON: Record<CheckState, { icon: string; cls: string }> = {
  ok: { icon: '✓', cls: 'text-emerald-600' },
  ko: { icon: '✗', cls: 'text-rose-600' },
  info: { icon: '○', cls: 'text-slate-400' },
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

  const btn = 'text-xs font-bold px-2 py-1 rounded disabled:opacity-50 shrink-0';
  return (
    <section data-testid="cloud-section">
      <h4 className="text-xs font-bold text-slate-500 uppercase mb-1">☁️ Cloud: il pilota lavora anche a browser chiuso</h4>
      <p className="text-[11px] text-slate-400 mb-1">
        Pratiche e pilota stanno sul server (Vercel): le chiamate partono anche a PC spento e gli stessi dati si vedono da più computer.
      </p>
      {active && (
        <p data-testid="cloud-active" className="text-xs font-bold text-sky-800 bg-sky-50 border border-sky-200 rounded px-2 py-1 mb-2">
          ✓ Cloud attivo su questo browser
        </p>
      )}
      <div className="space-y-2">
        <div>
          <span className="block text-[11px] font-bold text-slate-500 mb-0.5">Chiave di accesso</span>
          <input
            type="password"
            autoComplete="off"
            aria-label="Chiave di accesso del cloud"
            value={keyDraft}
            onChange={e => setKeyDraft(e.target.value)}
            placeholder="Il valore di CRON_SECRET impostato su Vercel"
            className="w-full px-2 py-1.5 rounded border border-slate-300 text-sm font-mono"
          />
          {active && key && key !== cloud.key && (
            <button onClick={() => onKeySave(key)} className={`${btn} mt-1 text-sky-800 border border-sky-300 bg-white hover:bg-sky-50`}>
              Usa questa chiave
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleCheck}
            disabled={checking}
            className={`${btn} text-slate-700 border border-slate-300 bg-white hover:bg-slate-50`}
          >
            {checking ? 'Verifico...' : 'Prova collegamento'}
          </button>
          {!active ? (
            <button
              onClick={handleActivate}
              disabled={act.step === 'working' || !key}
              className={`${btn} text-white bg-sky-600 hover:bg-sky-700`}
            >
              Attiva il cloud su questo browser
            </button>
          ) : (
            <button onClick={handleDisconnect} className={`${btn} text-rose-700 border border-rose-200 bg-white hover:bg-rose-50`}>
              Scollega questo browser
            </button>
          )}
        </div>

        {checks && (
          <ul data-testid="cloud-checks" className="text-xs space-y-1 bg-slate-50 border border-slate-200 rounded p-2">
            {checks.map(c => (
              <li key={c.id} data-check={c.id} data-state={c.state} className="flex gap-1.5 items-start">
                <span className={`font-bold shrink-0 w-3 text-center ${CHECK_ICON[c.state].cls}`}>{CHECK_ICON[c.state].icon}</span>
                <span>
                  <b className="text-slate-700">{c.label}</b>
                  <span className="block text-[11px] text-slate-500">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {webhookUrl && (
          <div>
            <span className="block text-[11px] font-bold text-slate-500 mb-0.5">Indirizzo da incollare in Retell come webhook</span>
            <div className="flex gap-1">
              <input
                readOnly
                value={webhookUrl}
                onFocus={e => e.target.select()}
                data-testid="cloud-webhook"
                className="flex-1 min-w-0 px-2 py-1 rounded border border-slate-300 text-[11px] font-mono bg-slate-50"
              />
              <button onClick={handleCopy} className={`${btn} text-slate-700 border border-slate-300 bg-white hover:bg-slate-50`}>
                {copied ? 'Copiato ✓' : 'Copia'}
              </button>
            </div>
          </div>
        )}

        {act.step === 'working' && <p className="text-xs text-slate-500">{act.message}</p>}
        {act.step === 'error' && (
          <p data-testid="cloud-activation-error" className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{act.message}</p>
        )}
        {act.step === 'done' && (
          <p data-testid="cloud-activation-done" className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">{act.message}</p>
        )}
        {act.step === 'choose' && (
          <div data-testid="cloud-choose" className="text-xs bg-amber-50 border border-amber-300 rounded p-2 space-y-1.5">
            <p className="text-amber-900">
              Sul cloud ci sono già <b>{plural(act.serverCount)}</b> e questo browser ne ha <b>{act.localCount}</b>. Quali dati tenere?
            </p>
            <button onClick={() => handleUseCloud(act.serverCount)} className="w-full text-left px-2 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white font-bold">
              Usa i dati del cloud ({plural(act.serverCount)}) <span className="font-normal">· consigliato</span>
            </button>
            <button
              onClick={() => handleReplace(act.serverCount, act.localCount)}
              className="w-full text-left px-2 py-1.5 rounded border border-rose-300 bg-white hover:bg-rose-50 text-rose-700 font-bold"
            >
              Sostituisci il cloud con i dati di questo browser ({plural(act.localCount)})
            </button>
            <button onClick={() => setAct({ step: 'idle' })} className="w-full px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-600 font-bold">
              Annulla
            </button>
          </div>
        )}
        <p className="text-[10px] text-slate-400">Attivazione e scollegamento hanno effetto subito (non serve "Salva").</p>
      </div>
    </section>
  );
};

export default CloudSection;
