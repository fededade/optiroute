import React, { useMemo, useRef, useState } from 'react';
import type { Appointment, Coordinates, Technician } from '../types';
import type { AppointmentPatch } from '../services/slotService';
import {
  computeDispatch,
  previewDispatch,
  type DispatchProposal,
} from '../services/dispatchService';
import { ArrowLeft, Calculator, CalendarX, Check, CircleAlert, Route, TriangleAlert, UserX } from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { Field, Stat, StateView, Steps, Switch, ic } from './modal/parts';

// Smistamento automatico delle pratiche "in attesa": assegnazione per zona di
// competenza, distribuzione su più giorni con data e orario ipotizzati.
// L'operatore rivede il piano e lo applica: le pratiche passano in "Proposte"
// e vanno confermate una ad una (o per giornata).

interface DispatchModalProps {
  pending: Appointment[];
  technicians: Technician[];
  fallbackBase: Coordinates | null;
  // Tutte le pratiche correnti: le nuove si inseriscono negli spazi liberi dei
  // giri esistenti senza sovrapporsi né cambiarne gli orari
  existing?: Appointment[];
  onApply: (updates: Appointment[], patches: AppointmentPatch[]) => void;
  onClose: () => void;
}

type Phase = 'setup' | 'computing' | 'result';

const tomorrowStr = (): string => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const formatDay = (iso: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

const DispatchModal: React.FC<DispatchModalProps> = ({ pending, technicians, fallbackBase, existing, onApply, onClose }) => {
  const [phase, setPhase] = useState<Phase>('setup');
  const [startDate, setStartDate] = useState(tomorrowStr());
  const [horizonDays, setHorizonDays] = useState('14');
  const [includeWeekends, setIncludeWeekends] = useState(false);
  const [progress, setProgress] = useState('');
  const [proposal, setProposal] = useState<DispatchProposal | null>(null);
  const [error, setError] = useState('');

  // La finestra deve restare SEMPRE chiudibile, anche a calcolo in corso:
  // alla chiusura il risultato del calcolo (ancora in volo) viene scartato.
  const closedRef = useRef(false);
  const handleClose = () => {
    closedRef.current = true;
    onClose();
  };

  const preview = useMemo(() => previewDispatch(pending, technicians), [pending, technicians]);
  const urgentCount = pending.filter(a => a.urgent).length;

  const handleCompute = async () => {
    const horizon = parseInt(horizonDays, 10);
    if (!startDate) { setError('Indica la data di inizio.'); return; }
    if (isNaN(horizon) || horizon < 1 || horizon > 60) { setError('Orizzonte non valido (1-60 giorni).'); return; }

    setError('');
    setPhase('computing');
    setProgress('Preparazione...');

    try {
      const result = await computeDispatch(
        pending,
        technicians,
        fallbackBase,
        { startDate, horizonDays: horizon, includeWeekends },
        (msg) => { if (!closedRef.current) setProgress(msg); },
        existing ?? [],
        new Date()
      );
      if (closedRef.current) return; // finestra chiusa durante il calcolo
      setProposal(result);
      setPhase('result');
    } catch (err) {
      if (closedRef.current) return;
      console.error('Dispatch error', err);
      setError('Errore durante il calcolo dello smistamento. Riprova.');
      setPhase('setup');
    }
  };

  const handleApply = () => {
    if (!proposal) return;
    onApply(proposal.updates, proposal.patches);
    onClose();
  };

  const proposedCount = proposal
    ? proposal.plans.reduce((acc, p) => acc + p.appointments.length, 0)
    : 0;

  const stepIndex = phase === 'setup' ? 0 : phase === 'computing' ? 1 : 2;
  const planTechs = proposal ? technicians.filter(t => proposal.plans.some(p => p.technician.id === t.id)) : [];
  const dayCount = proposal ? new Set(proposal.plans.map(p => p.date)).size : 0;
  const unscheduledCount = proposal ? proposal.unscheduled.reduce((n, u) => n + u.appointments.length, 0) : 0;

  const footer =
    phase === 'setup' ? (
      <>
        <button type="button" onClick={handleClose} className="btn btn-secondary">
          Annulla
        </button>
        <button type="button" onClick={handleCompute} disabled={pending.length === 0} className="btn btn-primary">
          <Calculator {...ic} />
          Calcola proposta
        </button>
      </>
    ) : phase === 'computing' ? (
      <button type="button" onClick={handleClose} className="btn btn-secondary">
        Annulla calcolo
      </button>
    ) : proposal ? (
      <>
        <button type="button" onClick={() => setPhase('setup')} className="btn btn-ghost mr-auto">
          <ArrowLeft {...ic} />
          Indietro
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={proposedCount === 0 && proposal.updates.length === 0}
          className="btn btn-accent max-sm:flex-1"
        >
          <Check {...ic} />
          Applica: {proposedCount} proposte da confermare
        </button>
      </>
    ) : undefined;

  return (
    // Overlay: il click fuori non chiude durante il calcolo (per evitare
    // chiusure accidentali), ma la X e "Annulla calcolo" restano sempre attivi
    <ModalShell
      icon={Route}
      title="Smista pratiche per zona"
      subtitle="Assegna le pratiche in attesa al tecnico di zona, con data e orario proposti."
      onClose={handleClose}
      dismissible={phase !== 'computing'}
      size="lg"
      toolbar={<Steps steps={['Parametri', 'Calcolo', 'Proposta']} current={stepIndex} />}
      footer={footer}
    >
        {phase === 'setup' && (
          <div className="space-y-5">
            <p className="text-sm leading-6 text-ink-600">
              Le <span className="num font-medium text-ink-900">{pending.length}</span> pratiche <b className="font-semibold text-ink-900">in attesa</b> vengono
              assegnate al tecnico competente per zona e distribuite sui prossimi giorni con data e orario ipotizzati.
              Le proposte andranno poi confermate dall'operatore.
            </p>

            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              {/* Parametri */}
              <div className="space-y-4">
                <h3 className="section-title">Parametri</h3>
                <Field label="Pianifica a partire dal" htmlFor="dispatch-start">
                  <input
                    id="dispatch-start"
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="input num"
                  />
                </Field>
                <Field label="Orizzonte (giorni)" htmlFor="dispatch-horizon" hint="Quanti giorni coprire, da 1 a 60.">
                  <input
                    id="dispatch-horizon"
                    type="number"
                    min="1"
                    max="60"
                    value={horizonDays}
                    onChange={e => setHorizonDays(e.target.value)}
                    className="input num"
                  />
                </Field>
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-control border border-line px-3.5 py-2.5 hover:bg-slate-50">
                  <span className="text-sm font-medium text-ink-900">Includi sabato e domenica</span>
                  <Switch checked={includeWeekends} onChange={e => setIncludeWeekends(e.target.checked)} />
                </label>
              </div>

              {/* Anteprima assegnazioni */}
              <div className="rounded-card border border-line bg-slate-50/60 p-4">
                <h3 className="section-title mb-3">Anteprima assegnazioni</h3>
                {preview.perTechnician.length > 0 ? (
                  <ul className="space-y-2">
                    {preview.perTechnician.map(({ technician, count, urgentCount: u }) => (
                      <li key={technician.id} className="flex items-start gap-2.5 text-sm">
                        <span className="dot mt-1.5 h-2.5 w-2.5" style={{ backgroundColor: technician.color }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink-900">{technician.name}</span>
                          {u > 0 && <span className="block text-xs font-medium text-rose-700">di cui {u} urgenti</span>}
                        </span>
                        <span className="shrink-0 text-ink-600"><span className="num">{count}</span> pratiche</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-500">Nessuna pratica assegnabile a un tecnico.</p>
                )}
                {preview.unassignedCount > 0 && (
                  <div className="callout callout-warn mt-3 py-2.5">
                    <TriangleAlert {...ic} className="mt-0.5 shrink-0 text-amber-600" />
                    <p className="leading-5">
                      <b className="num font-semibold">{preview.unassignedCount}</b> senza tecnico competente
                      {preview.missingProvinceCount > 0 && (
                        <span className="text-xs"> ({preview.missingProvinceCount} senza provincia: la rilevo io durante il calcolo)</span>
                      )}
                    </p>
                  </div>
                )}
                {urgentCount > 0 && (
                  <p className="field-hint mt-3">
                    Le pratiche urgenti vengono pianificate per prime, nei primi giorni utili.
                  </p>
                )}
              </div>
            </div>

            {error && (
              <div role="alert" className="callout callout-danger">
                <CircleAlert {...ic} className="mt-0.5 shrink-0 text-rose-600" />
                <p>{error}</p>
              </div>
            )}
          </div>
        )}

        {phase === 'computing' && (
          <div className="py-8">
            <StateView kind="loading" title="Smistamento in corso...">
              <p className="num text-ink-700">{progress}</p>
              <p className="mt-3 text-xs text-ink-400">
                Chiudendo, la proposta in corso viene scartata: nessuna pratica viene modificata.
              </p>
            </StateView>
          </div>
        )}

        {phase === 'result' && proposal && (
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-2">
              <Stat value={proposedCount} label="proposte" />
              <Stat value={planTechs.length} label={planTechs.length === 1 ? 'tecnico' : 'tecnici'} />
              <Stat value={dayCount} label={dayCount === 1 ? 'giornata' : 'giornate'} />
            </div>

            {proposal.plans.length === 0 && (
              <p className="text-sm text-ink-500">Nessuna proposta generata nell'orizzonte scelto.</p>
            )}

            {/* Piani per tecnico/giorno */}
            {planTechs.map(tech => {
              const plans = proposal.plans.filter(p => p.technician.id === tech.id);
              const n = plans.reduce((acc, p) => acc + p.appointments.length, 0);
              return (
                <section key={tech.id}>
                  <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-900">
                    <span className="dot h-2.5 w-2.5" style={{ backgroundColor: tech.color }} />
                    {tech.name}
                    <span className="num text-xs font-normal text-ink-500">{n} {n === 1 ? 'pratica' : 'pratiche'}</span>
                  </h4>
                  <div className="space-y-2">
                    {plans.map(plan => (
                      <div key={`${tech.id}-${plan.date}`} className="card overflow-hidden shadow-none">
                        <div className="flex items-center justify-between gap-3 border-b border-line bg-slate-50/70 px-3.5 py-2 text-[13px]">
                          <span className="font-medium capitalize text-ink-800">{formatDay(plan.date)}</span>
                          <span className="num text-xs text-ink-500">partenza {plan.workStart}</span>
                        </div>
                        <ul className="divide-y divide-line">
                          {plan.appointments.map(a => (
                            <li key={a.id} className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
                              <span className="num w-[92px] shrink-0 text-ink-600">{a.startTime}-{a.endTime}</span>
                              <span className="min-w-0 flex-1 truncate font-medium text-ink-900">{a.title}</span>
                              {a.urgent && <span className="chip chip-solid-danger h-[18px] px-1.5 text-2xs font-semibold">URGENTE</span>}
                              <span className="hidden max-w-[40%] truncate text-ink-500 sm:inline">{a.comune || a.address.split(',')[0]}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}

            {/* Avvisi: fuori orizzonte e non assegnabili, distinti */}
            {proposal.unscheduled.length > 0 && (
              <div className="callout callout-warn">
                <CalendarX {...ic} className="mt-0.5 shrink-0 text-amber-600" />
                <div className="min-w-0 leading-5">
                  <p className="font-semibold">Non pianificate nell'orizzonte: <span className="num">{unscheduledCount}</span></p>
                  {proposal.unscheduled.map(u => (
                    <p key={u.technician.id} className="mt-1 text-[13px]">
                      {u.technician.name}: {u.appointments.length} {u.appointments.length === 1 ? 'pratica' : 'pratiche'} (aumenta l'orizzonte o riduci il carico)
                    </p>
                  ))}
                </div>
              </div>
            )}
            {proposal.unassigned.length > 0 && (
              <div className="callout callout-danger">
                <UserX {...ic} className="mt-0.5 shrink-0 text-rose-600" />
                <div className="min-w-0 leading-5">
                  <p className="font-semibold">Senza tecnico competente ({proposal.unassigned.length}):</p>
                  <ul className="mt-1.5 space-y-1 text-[13px]">
                    {proposal.unassigned.map(a => (
                      <li key={a.id} className="flex gap-1.5">
                        <span className="text-rose-400" aria-hidden="true">·</span>
                        <span>{a.title} — {a.comune || a.address.split(',')[0]} {a.province ? `(${a.province})` : '(provincia non rilevata)'}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-rose-800/80">Assegnale manualmente (Modifica → Tecnico) o amplia le zone di competenza.</p>
                </div>
              </div>
            )}
          </div>
        )}
    </ModalShell>
  );
};

export default DispatchModal;
