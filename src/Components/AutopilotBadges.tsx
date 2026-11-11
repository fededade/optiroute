import React from 'react';
import type { AlternativeSlot, Appointment } from '../types';
import { isCallInFlight } from '../services/autopilotService';

// Badge del pilota automatico sulle card: motivo della coda e alternative
// offerte durante una chiamata in corso.

const pad = (n: number) => String(n).padStart(2, '0');

// "gio 12/11 alle 15:30"
export const formatAlternative = (o: Pick<AlternativeSlot, 'date' | 'startTime'>): string => {
  const d = new Date(`${o.date}T00:00:00`);
  const weekday = d.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '');
  return `${weekday} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} alle ${o.startTime}`;
};

export const formatAlternatives = (alts: AlternativeSlot[] | undefined): string =>
  (alts || []).map(formatAlternative).join(' · ');

const hhmm = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const AutoCallBadge: React.FC<{ appt: Appointment; maxAttempts: number }> = ({ appt, maxAttempts }) => {
  // Il rimpiazzo resta segnalato anche durante la chiamata, finché è una proposta
  const backfill = appt.autoCall === 'backfill' || (!appt.autoCall && !!appt.backfillOf && appt.status === 'proposed');
  if (!appt.autoCall && !backfill) return null;
  if (appt.autoCall === 'retry') {
    const n = (appt.callAttempts || 0) + 1;
    return (
      <span
        title="Il cliente non ha risposto: il pilota automatico lo richiamerà da solo"
        className="text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 px-1 rounded"
      >
        🔁 Richiamo alle {hhmm(appt.autoCallNotBefore)} (tentativo {n} di {maxAttempts})
      </span>
    );
  }
  if (backfill) {
    return (
      <span
        title="Slot liberato da un altro cliente: il pilota automatico chiama questa pratica per occuparlo"
        className="text-[10px] font-bold text-teal-700 bg-teal-50 border border-teal-200 px-1 rounded"
      >
        ♻️ Rimpiazza {appt.backfillOf || 'slot liberato'}
      </span>
    );
  }
  return (
    <span
      title="Giro approvato: il pilota automatico chiamerà il cliente nella fascia oraria"
      className="text-[10px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-1 rounded"
    >
      ⏳ In coda
    </span>
  );
};

// Alternative che l'operatore AI può offrire nella chiamata in corso
export const OfferedAlternatives: React.FC<{ appt: Appointment }> = ({ appt }) => {
  if (!appt.offeredAlternatives?.length || !isCallInFlight(appt, new Date())) return null;
  return (
    <p className="text-[10px] text-slate-500 mt-0.5 w-full">
      In alternativa offre: {formatAlternatives(appt.offeredAlternatives)}
    </p>
  );
};
