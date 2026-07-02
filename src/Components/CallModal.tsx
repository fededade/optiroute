import React, { useState } from 'react';
import type { Appointment } from '../types';
import { startConfirmationCall } from '../services/callService';

interface CallModalProps {
  appointment: Appointment;
  onClose: () => void;
  onCallStarted: (id: string) => void;
  onCallResult: (id: string, ok: boolean, callId?: string) => void;
}

type Phase = 'preview' | 'calling' | 'success' | 'error';

const CallModal: React.FC<CallModalProps> = ({ appointment, onClose, onCallStarted, onCallResult }) => {
  const [phase, setPhase] = useState<Phase>('preview');
  const [errorMessage, setErrorMessage] = useState('');

  const handleCall = async () => {
    setPhase('calling');
    onCallStarted(appointment.id);

    const result = await startConfirmationCall(appointment);

    if (result.ok) {
      setPhase('success');
      onCallResult(appointment.id, true, result.callId);
    } else {
      setPhase('error');
      setErrorMessage(result.error || 'Errore sconosciuto.');
      onCallResult(appointment.id, false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4" onClick={phase !== 'calling' ? onClose : undefined}>
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full"
        onClick={e => e.stopPropagation()}
      >
        {phase === 'preview' && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-2xl">📞</span>
              <h3 className="text-lg font-bold text-slate-800">Chiamata di conferma AI</h3>
            </div>

            <p className="text-sm text-slate-600 mb-4">
              L'operatore AI chiamerà il cliente per confermare l'appuntamento con questi dati:
            </p>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm space-y-1.5 mb-4">
              <p><span className="font-bold text-slate-500">Cliente:</span> {appointment.title}</p>
              <p><span className="font-bold text-slate-500">Telefono:</span> {appointment.phone}</p>
              <p><span className="font-bold text-slate-500">Data:</span> {appointment.date || 'Da definire'}</p>
              <p>
                <span className="font-bold text-slate-500">Orario:</span>{' '}
                {appointment.startTime
                  ? `${appointment.startTime}${appointment.endTime ? ` - ${appointment.endTime}` : ''}`
                  : 'Da definire'}
              </p>
              <p><span className="font-bold text-slate-500">Indirizzo:</span> {appointment.address}</p>
              {appointment.notes && <p><span className="font-bold text-slate-500">Note:</span> {appointment.notes}</p>}
            </div>

            {!appointment.startTime && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded p-2 mb-4">
                ⚠️ L'appuntamento non ha ancora un orario calcolato: l'operatore comunicherà che l'orario
                verrà confermato a breve. Per includere l'orario, esegui prima "Ottimizza".
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                Non chiamare
              </button>
              <button
                onClick={handleCall}
                className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold flex items-center justify-center gap-2"
              >
                📞 Chiama ora
              </button>
            </div>
          </>
        )}

        {phase === 'calling' && (
          <div className="text-center py-4">
            <div className="w-12 h-12 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mx-auto mb-4"></div>
            <h3 className="text-lg font-bold text-slate-800 mb-1">Avvio chiamata...</h3>
            <p className="text-sm text-slate-500">Sto contattando {appointment.title} al numero {appointment.phone}</p>
          </div>
        )}

        {phase === 'success' && (
          <div className="text-center py-4">
            <div className="text-4xl mb-3">✅</div>
            <h3 className="text-lg font-bold text-slate-800 mb-1">Chiamata avviata!</h3>
            <p className="text-sm text-slate-500 mb-4">
              L'operatore AI sta chiamando {appointment.title}. L'esito sarà visibile nella dashboard Retell.
            </p>
            <button
              onClick={onClose}
              className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold"
            >
              Chiudi
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="text-center py-4">
            <div className="text-4xl mb-3">❌</div>
            <h3 className="text-lg font-bold text-slate-800 mb-1">Chiamata non riuscita</h3>
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded p-2 mb-4">{errorMessage}</p>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                Chiudi
              </button>
              <button
                onClick={handleCall}
                className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold"
              >
                Riprova
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CallModal;
