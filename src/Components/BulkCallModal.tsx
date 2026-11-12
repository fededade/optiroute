import React, { useRef, useState } from 'react';
import type { AlternativeSlot, Appointment } from '../types';
import { startConfirmationCall } from '../services/callService';
import { Ban, CalendarDays, Check, CircleStop, Clock, HardHat, Phone, PhoneCall, TriangleAlert, X } from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { Spinner, Stat, ic } from './modal/parts';

// Chiamate AI di conferma in blocco: l'operatore seleziona le pratiche
// (tutte quelle con telefono, di default le non ancora chiamate) e le
// chiamate partono in sequenza, con esito per singola pratica.

interface BulkCallModalProps {
  appointments: Appointment[];
  technicianNameById: Record<string, string>;
  // Agenda del giorno (fasce impegnate del giro) da passare all'agente AI
  buildDaySchedule?: (appt: Appointment) => string;
  onClose: () => void;
  // Alternative reali che l'agente potrà offrire (calcolate subito prima di chiamare)
  buildAlternatives?: (appt: Appointment) => AlternativeSlot[];
  // true se la pratica ha già una chiamata in corso (es. partita dal pilota automatico)
  isCallBusy?: (id: string) => boolean;
  onCallStarted: (id: string, alternatives: AlternativeSlot[]) => void;
  onCallResult: (id: string, ok: boolean, callId?: string, error?: string) => void;
}

type Phase = 'preview' | 'running' | 'done';
type ItemOutcome = 'queued' | 'calling' | 'ok' | 'failed' | 'skipped';

interface ItemState {
  outcome: ItemOutcome;
  error?: string;
}

const PAUSE_BETWEEN_CALLS_MS = 1200;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const formatWhen = (a: Appointment): string => {
  if (!a.date) return 'data da definire';
  const day = new Date(`${a.date}T00:00:00`).toLocaleDateString('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
  return a.startTime ? `${day} · ${a.startTime}` : day;
};

const BulkCallModal: React.FC<BulkCallModalProps> = ({
  appointments, technicianNameById, buildDaySchedule, buildAlternatives, isCallBusy, onClose, onCallStarted, onCallResult,
}) => {
  const [phase, setPhase] = useState<Phase>('preview');
  const [selected, setSelected] = useState<Set<string>>(
    // Preselezionate: con telefono e non già chiamate con successo
    () => new Set(appointments.filter(a => a.phone && a.callStatus !== 'called' && a.callStatus !== 'calling').map(a => a.id))
  );
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});
  const cancelRef = useRef(false);

  const callable = appointments.filter(a => a.phone);
  const noPhoneCount = appointments.length - callable.length;
  const selectedCount = selected.size;

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const setItem = (id: string, state: ItemState) =>
    setItemStates(prev => ({ ...prev, [id]: state }));

  const handleStart = async () => {
    const queue = callable.filter(a => selected.has(a.id));
    if (queue.length === 0) return;

    cancelRef.current = false;
    setPhase('running');
    setItemStates(Object.fromEntries(queue.map(a => [a.id, { outcome: 'queued' as ItemOutcome }])));

    for (const appt of queue) {
      if (cancelRef.current) {
        setItem(appt.id, { outcome: 'skipped' });
        continue;
      }

      // Già in chiamata (es. partita dal pilota automatico): niente doppioni
      if (isCallBusy?.(appt.id)) {
        setItem(appt.id, { outcome: 'skipped', error: 'Chiamata già in corso' });
        continue;
      }

      setItem(appt.id, { outcome: 'calling' });
      const alternatives = buildAlternatives?.(appt) ?? [];
      onCallStarted(appt.id, alternatives);

      const technicianName = appt.technicianId ? technicianNameById[appt.technicianId] : undefined;
      const result = await startConfirmationCall(appt, technicianName, buildDaySchedule?.(appt), alternatives);

      if (result.ok) {
        setItem(appt.id, { outcome: 'ok' });
        onCallResult(appt.id, true, result.callId);
      } else {
        setItem(appt.id, { outcome: 'failed', error: result.error });
        onCallResult(appt.id, false, undefined, result.error);
      }

      // Piccola pausa per non inondare il servizio di chiamate
      if (!cancelRef.current && queue[queue.length - 1] !== appt) {
        await wait(PAUSE_BETWEEN_CALLS_MS);
      }
    }

    setPhase('done');
  };

  const okCount = Object.values(itemStates).filter(s => s.outcome === 'ok').length;
  const failedCount = Object.values(itemStates).filter(s => s.outcome === 'failed').length;
  const skippedCount = Object.values(itemStates).filter(s => s.outcome === 'skipped').length;

  const outcomeBadge = (id: string) => {
    const state = itemStates[id];
    if (!state) return null;
    if (state.outcome === 'queued') return <span className="chip chip-neutral shrink-0"><Clock {...ic} size={12} />In coda</span>;
    if (state.outcome === 'calling') return <span className="chip chip-ai shrink-0"><Spinner size={12} />In corso...</span>;
    if (state.outcome === 'ok') return <span className="chip chip-success shrink-0"><Check {...ic} size={12} />Avviata</span>;
    if (state.outcome === 'skipped') return <span className="chip chip-neutral shrink-0 text-ink-500"><Ban {...ic} size={12} />Annullata</span>;
    return <span className="chip chip-danger shrink-0"><X {...ic} size={12} />Fallita</span>;
  };

  const meta = (appt: Appointment, withTech: boolean) => {
    const tech = withTech && appt.technicianId ? technicianNameById[appt.technicianId] : undefined;
    return (
      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-500">
        <span className="inline-flex items-center gap-1"><CalendarDays {...ic} size={12} /><span className="num">{formatWhen(appt)}</span></span>
        <span className="inline-flex items-center gap-1"><Phone {...ic} size={12} /><span className="num">{appt.phone}</span></span>
        {tech && <span className="inline-flex items-center gap-1"><HardHat {...ic} size={12} />{tech}</span>}
      </p>
    );
  };

  const total = Object.keys(itemStates).length;
  const finished = okCount + failedCount + skippedCount;
  const pct = total ? Math.round((finished / total) * 100) : 0;

  const footer = phase === 'preview' ? (
    <>
      <span className="mr-auto text-[13px] text-ink-500 max-sm:hidden">
        <span className="num font-medium text-ink-900">{selectedCount}</span> di <span className="num">{callable.length}</span> selezionate
      </span>
      <button type="button" onClick={onClose} className="btn btn-secondary">
        Annulla
      </button>
      <button type="button" onClick={handleStart} disabled={selectedCount === 0} className="btn btn-accent">
        <Phone {...ic} />
        Avvia {selectedCount} {selectedCount === 1 ? 'chiamata' : 'chiamate'}
      </button>
    </>
  ) : phase === 'running' ? (
    <button type="button" onClick={() => { cancelRef.current = true; }} className="btn btn-danger">
      <CircleStop {...ic} />
      Interrompi (dopo la chiamata in corso)
    </button>
  ) : (
    <button type="button" onClick={onClose} className="btn btn-primary">
      Chiudi
    </button>
  );

  return (
    <ModalShell
      icon={PhoneCall}
      tone="ai"
      title="Chiamate di conferma AI"
      subtitle={phase === 'preview'
        ? 'Seleziona le pratiche da chiamare.'
        : phase === 'running' ? 'Chiamate in partenza, una alla volta.' : 'Invio delle chiamate completato.'}
      onClose={onClose}
      dismissible={phase !== 'running'}
      closeDisabled={phase === 'running'}
      closeHint="Attendi la fine delle chiamate o interrompi"
      size="md"
      footer={footer}
    >
        {phase === 'preview' && (
          <div className="space-y-3">
            <p className="text-sm leading-6 text-ink-600">
              L'operatore AI chiamerà <b className="font-semibold text-ink-900">una alla volta</b> le pratiche selezionate per
              confermare l'appuntamento proposto (data, orario e indirizzo).
            </p>
            <div className="card divide-y divide-line overflow-hidden shadow-none">
              {callable.map(appt => {
                const alreadyCalled = appt.callStatus === 'called';
                const isSel = selected.has(appt.id);
                return (
                  <label key={appt.id} className={`flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors ${isSel ? 'bg-surface' : 'bg-slate-50/60'} hover:bg-slate-50`}>
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(appt.id)}
                      className="checkbox accent-ink-900 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
                        {appt.urgent && <span className="chip chip-solid-danger h-[18px] px-1.5 text-2xs font-semibold">URGENTE</span>}
                        <span className="truncate">{appt.title}</span>
                      </p>
                      {meta(appt, true)}
                    </div>
                    {alreadyCalled && <span className="chip chip-success shrink-0">già chiamato</span>}
                    {appt.callStatus === 'failed' && <span className="chip chip-danger shrink-0">ultima fallita</span>}
                  </label>
                );
              })}
              {callable.length === 0 && (
                <p className="p-4 text-sm text-ink-500">Nessuna pratica con numero di telefono.</p>
              )}
            </div>

            {noPhoneCount > 0 && (
              <div className="callout callout-warn">
                <TriangleAlert {...ic} className="mt-0.5 shrink-0 text-amber-600" />
                <p className="leading-5">
                  {noPhoneCount} {noPhoneCount === 1 ? 'pratica esclusa perché senza numero' : 'pratiche escluse perché senza numero'} di
                  telefono (aggiungilo con il tasto Modifica).
                </p>
              </div>
            )}
          </div>
        )}

        {(phase === 'running' || phase === 'done') && (
          <div className="space-y-4">
            {phase === 'running' ? (
              <div>
                <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-ink-700">Chiamate in corso, una alla volta. Non chiudere questa finestra.</span>
                  <span className="num shrink-0 text-ink-500">{finished}/{total}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={finished} aria-label="Avanzamento delle chiamate">
                  <div className="h-full rounded-full bg-violet-500 transition-[width] duration-300" style={{ width: `${Math.max(pct, 4)}%` }} />
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Stat value={okCount} label="avviate" tone="success" />
                  <Stat value={failedCount} label="fallite" tone={failedCount ? 'danger' : 'neutral'} />
                  <Stat value={skippedCount} label="annullate" />
                </div>
                <p className="text-sm leading-6 text-ink-600">
                  {`Completato: ${okCount} avviate${failedCount ? `, ${failedCount} fallite` : ''}${skippedCount ? `, ${skippedCount} annullate` : ''}. ` +
                    `Gli esiti delle conversazioni compariranno sulle pratiche a fine chiamata, aggiornandone lo stato.`}
                </p>
              </>
            )}

            <div className="card divide-y divide-line overflow-hidden shadow-none">
              {callable.filter(a => itemStates[a.id]).map(appt => (
                <div key={appt.id} className={`flex items-center gap-3 px-3.5 py-2.5 ${itemStates[appt.id]?.outcome === 'calling' ? 'bg-violet-50/50' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{appt.title}</p>
                    {meta(appt, false)}
                    {itemStates[appt.id]?.error && (
                      <p className={`mt-0.5 truncate text-xs ${itemStates[appt.id].outcome === 'failed' ? 'text-rose-700' : 'text-ink-500'}`}>{itemStates[appt.id].error}</p>
                    )}
                  </div>
                  {outcomeBadge(appt.id)}
                </div>
              ))}
            </div>
          </div>
        )}
    </ModalShell>
  );
};

export default BulkCallModal;
