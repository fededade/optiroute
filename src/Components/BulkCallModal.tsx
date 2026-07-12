import React, { useRef, useState } from 'react';
import type { Appointment } from '../types';
import { startConfirmationCall } from '../services/callService';

// Chiamate AI di conferma in blocco: l'operatore seleziona le pratiche
// (tutte quelle con telefono, di default le non ancora chiamate) e le
// chiamate partono in sequenza, con esito per singola pratica.

interface BulkCallModalProps {
  appointments: Appointment[];
  technicianNameById: Record<string, string>;
  onClose: () => void;
  onCallStarted: (id: string) => void;
  onCallResult: (id: string, ok: boolean, callId?: string) => void;
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
  appointments, technicianNameById, onClose, onCallStarted, onCallResult,
}) => {
  const [phase, setPhase] = useState<Phase>('preview');
  const [selected, setSelected] = useState<Set<string>>(
    // Preselezionate: con telefono e non già chiamate con successo
    () => new Set(appointments.filter(a => a.phone && a.callStatus !== 'called').map(a => a.id))
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

      setItem(appt.id, { outcome: 'calling' });
      onCallStarted(appt.id);

      const technicianName = appt.technicianId ? technicianNameById[appt.technicianId] : undefined;
      const result = await startConfirmationCall(appt, technicianName);

      if (result.ok) {
        setItem(appt.id, { outcome: 'ok' });
        onCallResult(appt.id, true, result.callId);
      } else {
        setItem(appt.id, { outcome: 'failed', error: result.error });
        onCallResult(appt.id, false);
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

  const OutcomeBadge = ({ id }: { id: string }) => {
    const state = itemStates[id];
    if (!state) return null;
    if (state.outcome === 'queued') return <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">In coda</span>;
    if (state.outcome === 'calling') return <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded animate-pulse shrink-0">📞 In corso...</span>;
    if (state.outcome === 'ok') return <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded shrink-0">✓ Avviata</span>;
    if (state.outcome === 'skipped') return <span className="text-[10px] font-bold text-slate-400 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded shrink-0">Annullata</span>;
    return <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-1.5 py-0.5 rounded shrink-0">✗ Fallita</span>;
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4"
      onClick={phase !== 'running' ? onClose : undefined}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-lg w-full max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1 shrink-0">
          <span className="text-2xl">📞</span>
          <h3 className="text-lg font-bold text-slate-800">Chiamate di conferma AI</h3>
        </div>

        {phase === 'preview' && (
          <>
            <p className="text-sm text-slate-600 mb-3 shrink-0">
              L'operatore AI chiamerà <b>una alla volta</b> le pratiche selezionate per
              confermare l'appuntamento proposto (data, orario e indirizzo).
            </p>

            <div className="flex-1 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100 mb-3">
              {callable.map(appt => {
                const alreadyCalled = appt.callStatus === 'called';
                return (
                  <label key={appt.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selected.has(appt.id)}
                      onChange={() => toggle(appt.id)}
                      className="rounded text-emerald-600 focus:ring-emerald-500 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-800 truncate">
                        {appt.urgent && <span className="text-[10px] font-bold text-white bg-red-600 px-1 rounded mr-1">URGENTE</span>}
                        {appt.title}
                      </p>
                      <p className="text-xs text-slate-400 truncate">
                        {formatWhen(appt)} · 📞 {appt.phone}
                        {appt.technicianId && technicianNameById[appt.technicianId] ? ` · ${technicianNameById[appt.technicianId]}` : ''}
                      </p>
                    </div>
                    {alreadyCalled && (
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded shrink-0">
                        già chiamato
                      </span>
                    )}
                    {appt.callStatus === 'failed' && (
                      <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-1.5 py-0.5 rounded shrink-0">
                        ultima fallita
                      </span>
                    )}
                  </label>
                );
              })}
              {callable.length === 0 && (
                <p className="text-sm text-slate-400 italic p-3">Nessuna pratica con numero di telefono.</p>
              )}
            </div>

            {noPhoneCount > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded p-2 mb-3 shrink-0">
                ⚠️ {noPhoneCount} {noPhoneCount === 1 ? 'pratica esclusa perché senza numero' : 'pratiche escluse perché senza numero'} di
                telefono (aggiungilo con il tasto Modifica).
              </p>
            )}

            <div className="flex gap-2 shrink-0">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                Annulla
              </button>
              <button
                onClick={handleStart}
                disabled={selectedCount === 0}
                className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-bold"
              >
                📞 Avvia {selectedCount} {selectedCount === 1 ? 'chiamata' : 'chiamate'}
              </button>
            </div>
          </>
        )}

        {(phase === 'running' || phase === 'done') && (
          <>
            <p className="text-sm text-slate-600 mb-3 shrink-0">
              {phase === 'running'
                ? 'Chiamate in corso, una alla volta. Non chiudere questa finestra.'
                : `Completato: ${okCount} avviate${failedCount ? `, ${failedCount} fallite` : ''}${skippedCount ? `, ${skippedCount} annullate` : ''}.`}
            </p>

            <div className="flex-1 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100 mb-3">
              {callable.filter(a => itemStates[a.id]).map(appt => (
                <div key={appt.id} className="flex items-center gap-2.5 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800 truncate">{appt.title}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {formatWhen(appt)} · 📞 {appt.phone}
                    </p>
                    {itemStates[appt.id]?.error && (
                      <p className="text-xs text-red-600 truncate">{itemStates[appt.id].error}</p>
                    )}
                  </div>
                  <OutcomeBadge id={appt.id} />
                </div>
              ))}
            </div>

            <div className="flex gap-2 shrink-0">
              {phase === 'running' ? (
                <button
                  onClick={() => { cancelRef.current = true; }}
                  className="flex-1 py-2 rounded-lg border border-red-200 text-sm font-bold text-red-600 hover:bg-red-50"
                >
                  Interrompi (dopo la chiamata in corso)
                </button>
              ) : (
                <button
                  onClick={onClose}
                  className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold"
                >
                  Chiudi
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default BulkCallModal;
