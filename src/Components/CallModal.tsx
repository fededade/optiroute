import React, { useState } from 'react';
import type { AlternativeSlot, Appointment, IssueType } from '../types';
import { startConfirmationCall } from '../services/callService';
import { formatAlternative } from './AutopilotBadges';
import {
  CalendarClock, CalendarDays, CircleAlert, Clock, Construction, HardHat, MapPin, Phone, PhoneOff,
  RotateCw, Shuffle, Siren, StickyNote, TriangleAlert, type LucideIcon,
} from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { StateView, ic } from './modal/parts';

interface CallModalProps {
  appointment: Appointment;
  technicianName?: string; // Nome del tecnico che effettuerà il sopralluogo
  daySchedule?: string;    // Agenda del giorno per l'agente AI (fasce impegnate)
  onClose: () => void;
  // Alternative reali che l'agente potrà offrire (calcolate al momento)
  buildAlternatives?: (appt: Appointment) => AlternativeSlot[];
  onCallStarted: (id: string, alternatives: AlternativeSlot[]) => void;
  onCallResult: (id: string, ok: boolean, callId?: string, error?: string) => void;
  // Esito della telefonata -> categoria problematica (con eventuale data di rientro)
  onMarkIssue?: (id: string, issueType: IssueType, followUpDate?: string) => void;
}

type Phase = 'preview' | 'calling' | 'success' | 'error';

const CallModal: React.FC<CallModalProps> = ({ appointment, technicianName, daySchedule, buildAlternatives, onClose, onCallStarted, onCallResult, onMarkIssue }) => {
  const [phase, setPhase] = useState<Phase>('preview');
  // Anteprima delle alternative (ricalcolate subito prima di chiamare)
  const [previewAlternatives] = useState<AlternativeSlot[]>(() => buildAlternatives?.(appointment) ?? []);
  const [errorMessage, setErrorMessage] = useState('');
  const [outcome, setOutcome] = useState<IssueType | null>(null);
  const [outcomeDate, setOutcomeDate] = useState('');

  const handleCall = async () => {
    setPhase('calling');
    const alternatives = buildAlternatives?.(appointment) ?? [];
    onCallStarted(appointment.id, alternatives);

    const result = await startConfirmationCall(appointment, technicianName, daySchedule, alternatives);

    if (result.ok) {
      setPhase('success');
      onCallResult(appointment.id, true, result.callId);
    } else {
      setPhase('error');
      setErrorMessage(result.error || 'Errore sconosciuto.');
      onCallResult(appointment.id, false, undefined, result.error);
    }
  };

  const OUTCOMES: { value: IssueType; label: string; icon: LucideIcon }[] = [
    { value: 'wrong_phone', label: 'Numero non corretto', icon: PhoneOff },
    { value: 'callback', label: 'Da richiamare', icon: CalendarClock },
    { value: 'works_pending', label: 'Lavori da ultimare', icon: Construction },
  ];

  // Esito della telefonata: un clic e la pratica finisce nella categoria giusta.
  // (Espressione JSX, non componente: un componente interno verrebbe rimontato
  // a ogni render facendo perdere il focus all'input della data.)
  const outcomeSection = !onMarkIssue ? null : (
      <section className="mt-5 rounded-card border border-line bg-slate-50/60 p-4 text-left">
        <h4 className="section-title">Registra esito della telefonata</h4>
        <p className="mt-0.5 text-xs leading-4 text-ink-500">
          La pratica esce dalla pianificazione; se indichi una data, dal giorno prima scatta
          l'alert "Slot da riservare".
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {OUTCOMES.map(o => {
            const active = outcome === o.value;
            const Icon = o.icon;
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={active}
                onClick={() => setOutcome(active ? null : o.value)}
                className={`flex items-center gap-2 rounded-control border px-3 py-2.5 text-left text-[13px] font-medium leading-4 transition-colors sm:flex-col sm:justify-center sm:gap-1.5 sm:px-2 sm:py-3 sm:text-center ${
                  active
                    ? 'border-rose-300 bg-rose-50 text-rose-800 ring-1 ring-inset ring-rose-200'
                    : 'border-line bg-surface text-ink-700 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <Icon {...ic} className={active ? 'shrink-0 text-rose-600' : 'shrink-0 text-ink-400'} />
                {o.label}
              </button>
            );
          })}
        </div>
        {(outcome === 'callback' || outcome === 'works_pending') && (
          <div className="mt-3">
            <label htmlFor="call-outcome-date" className="field-label">
              {outcome === 'callback' ? 'Richiamare il' : 'Fine lavori prevista il'}
            </label>
            <input
              id="call-outcome-date"
              type="date"
              value={outcomeDate}
              onChange={e => setOutcomeDate(e.target.value)}
              className="input num"
            />
          </div>
        )}
        {outcome && (
          <button
            type="button"
            onClick={() => { onMarkIssue(appointment.id, outcome, outcomeDate || undefined); onClose(); }}
            className="btn btn-danger mt-3 w-full"
          >
            Salva esito e sposta in "Problematiche"
          </button>
        )}
      </section>
  );

  const person = appointment.contactPerson || appointment.title;
  const fmtDate = (iso?: string) => {
    if (!iso) return 'Da definire';
    const d = new Date(`${iso}T00:00:00`);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  const time = appointment.startTime
    ? `${appointment.startTime}${appointment.endTime ? ` - ${appointment.endTime}` : ''}`
    : 'Da definire';

  const subtitle =
    phase === 'preview' ? 'L\'operatore AI chiama il cliente e conferma l\'appuntamento.'
    : phase === 'calling' ? 'Chiamata in partenza: attendi qualche secondo.'
    : phase === 'success' ? 'La chiamata è partita: l\'esito arriva da solo sulla pratica.'
    : 'La chiamata non è partita.';

  const footer =
    phase === 'preview' ? (
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">
          Non chiamare
        </button>
        <button type="button" onClick={handleCall} className="btn btn-accent">
          <Phone {...ic} />
          Chiama ora
        </button>
      </>
    ) : phase === 'success' ? (
      <button type="button" onClick={onClose} className="btn btn-primary">
        Chiudi
      </button>
    ) : phase === 'error' ? (
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">
          Chiudi
        </button>
        <button type="button" onClick={handleCall} className="btn btn-accent">
          <RotateCw {...ic} />
          Riprova
        </button>
      </>
    ) : undefined;

  return (
    <ModalShell
      icon={Phone}
      tone="ai"
      title="Chiamata di conferma AI"
      subtitle={subtitle}
      onClose={onClose}
      dismissible={phase !== 'calling'}
      closeDisabled={phase === 'calling'}
      closeHint="Attendi la partenza della chiamata"
      size="md"
      footer={footer}
    >
        {phase === 'preview' && (
          <div className="space-y-4">
            {appointment.urgent && (
              <div className="callout callout-danger">
                <Siren {...ic} className="mt-0.5 shrink-0 text-rose-600" />
                <p className="leading-5">
                  <b className="font-semibold">SOPRALLUOGO URGENTE</b> — l'operatore AI lo dichiarerà esplicitamente al cliente
                  durante la chiamata.
                </p>
              </div>
            )}

            {/* Scheda riepilogativa: chi, quando, dove */}
            <div className="card overflow-hidden shadow-none">
              <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-ink-700">
                  {person.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="eyebrow">{appointment.contactPerson ? 'Da contattare' : 'Cliente'}</p>
                  <p className="truncate text-[15px] font-semibold text-ink-950">{person}</p>
                  <p className="num text-[13px] text-ink-700 sm:hidden">{appointment.phone}</p>
                  {appointment.contactPerson && appointment.referredBy && (
                    <p className="truncate text-xs text-ink-500">indicato da {appointment.referredBy}</p>
                  )}
                </div>
                <span className="num shrink-0 rounded-control border border-line bg-slate-50 px-2.5 py-1 text-[13px] text-ink-800 max-sm:hidden">
                  {appointment.phone}
                </span>
              </div>
              <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2.5 px-4 py-3.5 text-sm">
                {appointment.contactPerson && (
                  <>
                    <dt className="text-ink-500">Intestatario</dt>
                    <dd className="min-w-0 text-ink-900">{appointment.title}</dd>
                  </>
                )}
                {appointment.periziaCode && (
                  <>
                    <dt className="text-ink-500">Pratica</dt>
                    <dd className="num text-ink-900">#{appointment.periziaCode}</dd>
                  </>
                )}
                <dt className="flex items-center gap-1.5 text-ink-500"><CalendarDays {...ic} size={14} />Data</dt>
                <dd className={`first-letter:uppercase ${appointment.date ? 'text-ink-900' : 'text-ink-400'}`}>{fmtDate(appointment.date)}</dd>
                <dt className="flex items-center gap-1.5 text-ink-500"><Clock {...ic} size={14} />Orario</dt>
                <dd className={`num ${appointment.startTime ? 'text-ink-900' : 'text-ink-400'}`}>{time}</dd>
                <dt className="flex items-center gap-1.5 text-ink-500"><MapPin {...ic} size={14} />Indirizzo</dt>
                <dd className="min-w-0 text-ink-900">{appointment.address}</dd>
                {technicianName && (
                  <>
                    <dt className="flex items-center gap-1.5 text-ink-500"><HardHat {...ic} size={14} />Tecnico</dt>
                    <dd className="text-ink-900">{technicianName}</dd>
                  </>
                )}
                {appointment.notes && (
                  <>
                    <dt className="flex items-center gap-1.5 text-ink-500"><StickyNote {...ic} size={14} />Note</dt>
                    <dd className="min-w-0 whitespace-pre-line text-ink-700">{appointment.notes}</dd>
                  </>
                )}
              </dl>
            </div>

            {previewAlternatives.length > 0 && (
              <div data-testid="call-alternatives" className="rounded-card border border-violet-200 bg-violet-50/60 px-4 py-3">
                <p className="flex items-center gap-2 text-[13px] font-medium text-violet-900">
                  <Shuffle {...ic} className="shrink-0 text-violet-600" />
                  Se il cliente non può, l'operatore AI offrirà:
                </p>{' '}
                <ul className="mt-2 grid gap-1.5">
                  {previewAlternatives.map((alt, i) => (
                    <li key={`${alt.date}-${alt.startTime}-${i}`} className="flex items-center gap-2.5 rounded-control bg-surface px-3 py-2 text-sm ring-1 ring-inset ring-violet-100">
                      <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-2xs font-semibold text-violet-700">{alt.label}</span>{' '}
                      <span className="font-medium tabular-nums text-ink-900">{formatAlternative(alt)}</span>{' '}
                      {alt.endTime && <span className="text-xs text-ink-400">fino alle <span className="num">{alt.endTime}</span></span>}{' '}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!appointment.startTime && (
              <div className="callout callout-warn">
                <TriangleAlert {...ic} className="mt-0.5 shrink-0 text-amber-600" />
                <p className="leading-5">
                  L'appuntamento non ha ancora un orario calcolato: l'operatore comunicherà che l'orario
                  verrà confermato a breve. Per includere l'orario, esegui prima "Ottimizza".
                </p>
              </div>
            )}
          </div>
        )}

        {phase === 'calling' && (
          <StateView kind="loading" title="Avvio chiamata...">
            Sto contattando {appointment.title} al numero <span className="num text-ink-700">{appointment.phone}</span>
          </StateView>
        )}

        {phase === 'success' && (
          <>
            <StateView kind="success" title="Chiamata avviata!">
              L'operatore AI sta chiamando {appointment.title}. A fine conversazione l'esito
              comparirà da solo sulla pratica (confermato, da riprogrammare, non risponde...)
              e lo stato si aggiornerà di conseguenza.
            </StateView>
            {outcomeSection}
          </>
        )}

        {phase === 'error' && (
          <>
            <StateView kind="error" title="Chiamata non riuscita" />
            <div role="alert" className="callout callout-danger -mt-2">
              <CircleAlert {...ic} className="mt-0.5 shrink-0 text-rose-600" />
              <p className="leading-5">{errorMessage}</p>
            </div>
            {outcomeSection}
          </>
        )}
    </ModalShell>
  );
};

export default CallModal;
