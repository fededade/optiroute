import React, { useMemo, useRef, useState } from 'react';
import type { Appointment, Coordinates, Technician } from '../types';
import {
  computeDispatch,
  previewDispatch,
  type DispatchProposal,
} from '../services/dispatchService';

// Smistamento automatico delle pratiche "in attesa": assegnazione per zona di
// competenza, distribuzione su più giorni con data e orario ipotizzati.
// L'operatore rivede il piano e lo applica: le pratiche passano in "Proposte"
// e vanno confermate una ad una (o per giornata).

interface DispatchModalProps {
  pending: Appointment[];
  technicians: Technician[];
  fallbackBase: Coordinates | null;
  onApply: (updates: Appointment[]) => void;
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

const DispatchModal: React.FC<DispatchModalProps> = ({ pending, technicians, fallbackBase, onApply, onClose }) => {
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
        (msg) => { if (!closedRef.current) setProgress(msg); }
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
    onApply(proposal.updates);
    onClose();
  };

  const proposedCount = proposal
    ? proposal.plans.reduce((acc, p) => acc + p.appointments.length, 0)
    : 0;

  return (
    // Overlay: il click fuori non chiude durante il calcolo (per evitare
    // chiusure accidentali), ma la ✕ e "Annulla calcolo" restano sempre attivi
    <div className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4" onClick={phase !== 'computing' ? handleClose : undefined}>
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-2xl w-full max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1 shrink-0">
          <h3 className="text-lg font-bold text-slate-800">🚚 Smista pratiche per zona</h3>
          <button onClick={handleClose} title="Chiudi" className="text-slate-400 hover:text-slate-600 text-xl leading-none px-1">✕</button>
        </div>

        {phase === 'setup' && (
          <div className="overflow-y-auto">
            <p className="text-xs text-slate-500 mb-4">
              Le {pending.length} pratiche <b>in attesa</b> vengono assegnate al tecnico competente
              per zona e distribuite sui prossimi giorni con data e orario ipotizzati.
              Le proposte andranno poi confermate dall'operatore.
            </p>

            {/* Anteprima assegnazioni */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4 space-y-1.5">
              <h4 className="text-xs font-bold text-slate-500 uppercase mb-1">Anteprima assegnazioni</h4>
              {preview.perTechnician.map(({ technician, count, urgentCount: u }) => (
                <p key={technician.id} className="text-sm flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: technician.color }}></span>
                  <b>{technician.name}</b>: {count} pratiche
                  {u > 0 && <span className="text-red-600 font-bold text-xs">di cui {u} urgenti 🔴</span>}
                </p>
              ))}
              {preview.unassignedCount > 0 && (
                <p className="text-sm text-amber-700">
                  ⚠️ <b>{preview.unassignedCount}</b> senza tecnico competente
                  {preview.missingProvinceCount > 0 && (
                    <span className="text-xs"> ({preview.missingProvinceCount} senza provincia: la rilevo io durante il calcolo)</span>
                  )}
                </p>
              )}
              {urgentCount > 0 && (
                <p className="text-[11px] text-slate-500">
                  Le pratiche urgenti vengono pianificate per prime, nei primi giorni utili.
                </p>
              )}
            </div>

            {/* Parametri */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Pianifica a partire dal</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Orizzonte (giorni)</label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={horizonDays}
                  onChange={e => setHorizonDays(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 mb-4 cursor-pointer">
              <input type="checkbox" checked={includeWeekends} onChange={e => setIncludeWeekends(e.target.checked)} className="rounded" />
              Includi sabato e domenica
            </label>

            {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded p-2 mb-3">{error}</p>}

            <div className="flex gap-2">
              <button
                onClick={handleClose}
                className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                Annulla
              </button>
              <button
                onClick={handleCompute}
                disabled={pending.length === 0}
                className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-bold"
              >
                Calcola proposta
              </button>
            </div>
          </div>
        )}

        {phase === 'computing' && (
          <div className="text-center py-10">
            <div className="w-12 h-12 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mx-auto mb-4"></div>
            <h3 className="text-lg font-bold text-slate-800 mb-1">Smistamento in corso...</h3>
            <p className="text-sm text-slate-500">{progress}</p>
            <button
              onClick={handleClose}
              className="mt-6 px-4 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
            >
              Annulla calcolo
            </button>
            <p className="text-[11px] text-slate-400 mt-2">
              Chiudendo, la proposta in corso viene scartata: nessuna pratica viene modificata.
            </p>
          </div>
        )}

        {phase === 'result' && proposal && (
          <>
            <div className="flex-1 overflow-y-auto space-y-4 my-3">
              {proposal.plans.length === 0 && (
                <p className="text-sm text-slate-500 italic">Nessuna proposta generata nell'orizzonte scelto.</p>
              )}

              {/* Piani per tecnico/giorno */}
              {technicians.filter(t => proposal.plans.some(p => p.technician.id === t.id)).map(tech => (
                <div key={tech.id}>
                  <h4 className="text-sm font-bold flex items-center gap-2 mb-2" style={{ color: tech.color }}>
                    <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: tech.color }}></span>
                    {tech.name}
                  </h4>
                  <div className="space-y-2">
                    {proposal.plans.filter(p => p.technician.id === tech.id).map(plan => (
                      <div key={`${tech.id}-${plan.date}`} className="border border-slate-200 rounded-lg overflow-hidden">
                        <div className="bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 flex justify-between">
                          <span className="capitalize">{formatDay(plan.date)}</span>
                          <span className="font-normal text-slate-400">partenza {plan.workStart}</span>
                        </div>
                        <ul className="divide-y divide-slate-100">
                          {plan.appointments.map(a => (
                            <li key={a.id} className="px-3 py-1.5 text-xs flex items-center gap-2">
                              <span className="font-mono text-slate-500 shrink-0">{a.startTime}-{a.endTime}</span>
                              {a.urgent && <span className="text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 px-1 rounded shrink-0">URGENTE</span>}
                              <span className="font-semibold text-slate-700 truncate">{a.title}</span>
                              <span className="text-slate-400 truncate hidden sm:inline">{a.comune || a.address.split(',')[0]}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Avvisi */}
              {proposal.unscheduled.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                  <b>Non pianificate nell'orizzonte:</b>
                  {proposal.unscheduled.map(u => (
                    <p key={u.technician.id} className="mt-1">
                      {u.technician.name}: {u.appointments.length} pratiche (aumenta l'orizzonte o riduci il carico)
                    </p>
                  ))}
                </div>
              )}
              {proposal.unassigned.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                  <b>Senza tecnico competente ({proposal.unassigned.length}):</b>
                  <ul className="mt-1 space-y-0.5">
                    {proposal.unassigned.map(a => (
                      <li key={a.id}>• {a.title} — {a.comune || a.address.split(',')[0]} {a.province ? `(${a.province})` : '(provincia non rilevata)'}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-red-500">Assegnale manualmente (Modifica → Tecnico) o amplia le zone di competenza.</p>
                </div>
              )}
            </div>

            <div className="flex gap-2 shrink-0 pt-2 border-t border-slate-100">
              <button
                onClick={() => setPhase('setup')}
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                ← Indietro
              </button>
              <button
                onClick={handleApply}
                disabled={proposedCount === 0 && proposal.updates.length === 0}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold"
              >
                Applica: {proposedCount} proposte da confermare
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DispatchModal;
