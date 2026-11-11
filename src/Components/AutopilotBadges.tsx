import React from 'react';
import {
  Ban, CalendarClock, CheckCircle2, CircleHelp, Clock, HardHat, Loader2, PhoneCall, PhoneMissed, PhoneOff,
  RefreshCw, Repeat, Undo2, UserRound, XCircle, type LucideIcon,
} from 'lucide-react';
import type { AlternativeSlot, Appointment } from '../types';
import { isCallInFlight } from '../services/autopilotService';

// Stato della chiamata sulla scheda della pratica: UNA riga chiara, con
// icona, che unifica coda del pilota, chiamata in corso, esito della
// conversazione, richiamo, rimpiazzo e alternative offerte.

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

const dayLabel = (iso?: string): string =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '') : '';

type Tone = 'success' | 'info' | 'warn' | 'danger' | 'ai' | 'neutral';

export interface CallLine {
  icon: LucideIcon;
  text: string;
  tone: Tone;
  title?: string;
  pulse?: boolean;
}

const TONE_CLASS: Record<Tone, string> = {
  success: 'text-emerald-700',
  info: 'text-sky-700',
  warn: 'text-amber-800',
  danger: 'text-rose-700',
  ai: 'text-violet-700',
  neutral: 'text-ink-600',
};

// Rimpiazzo: resta segnalato anche durante la chiamata, finché è una proposta
export const isBackfill = (appt: Appointment): boolean =>
  appt.autoCall === 'backfill' || (!appt.autoCall && !!appt.backfillOf && appt.status === 'proposed');

// Riga principale: stato della chiamata (null se la pratica non è mai stata chiamata)
export const callLineFor = (appt: Appointment, maxAttempts: number, awaitingOutcome: boolean): CallLine | null => {
  const o = appt.callOutcome;
  const summaryTitle = [o?.summary || appt.callSummary, o?.clientNotes].filter(Boolean).join(' — ') || undefined;

  if (appt.autoCall === 'retry') {
    const n = (appt.callAttempts || 0) + 1;
    return {
      icon: PhoneMissed, tone: 'info',
      text: `Non risponde · Richiamo alle ${hhmm(appt.autoCallNotBefore)} (tentativo ${n} di ${maxAttempts})`,
      title: 'Il cliente non ha risposto: il pilota automatico lo richiamerà da solo',
    };
  }
  if (appt.autoCall) {
    return {
      icon: Clock, tone: 'ai', text: 'In coda: il pilota chiamerà il cliente',
      title: appt.autoCall === 'backfill'
        ? 'Slot liberato da un altro cliente: il pilota automatico chiama questa pratica per occuparlo'
        : 'Giro approvato: il pilota automatico chiamerà il cliente nella fascia oraria',
    };
  }
  if (o) {
    switch (o.result) {
      case 'confermato':
        return { icon: CheckCircle2, tone: 'success', text: 'Confermato dal cliente', title: summaryTitle };
      case 'riprogrammare': {
        const quando = [o.requestedDate, o.requestedTime].filter(Boolean).join(' ');
        return { icon: CalendarClock, tone: 'warn', text: `Da riprogrammare${quando ? `: chiede ${quando}` : ''}`, title: summaryTitle };
      }
      case 'da_richiamare':
        return { icon: CalendarClock, tone: 'warn', text: `Da richiamare${o.followUpDate ? ` il ${dayLabel(o.followUpDate)}` : ''}`, title: summaryTitle };
      case 'numero_errato':
        return { icon: PhoneOff, tone: 'danger', text: 'Numero errato', title: summaryTitle };
      case 'lavori_non_ultimati':
        return { icon: HardHat, tone: 'warn', text: `Lavori da ultimare${o.followUpDate ? ` · fine ${dayLabel(o.followUpDate)}` : ''}`, title: summaryTitle };
      case 'annullato':
        return { icon: Ban, tone: 'neutral', text: 'Annullato dal cliente', title: summaryTitle };
      case 'rifiutato':
        return { icon: XCircle, tone: 'danger', text: 'Rifiutato dal cliente', title: summaryTitle };
      case 'altro_referente':
        return { icon: UserRound, tone: 'info', text: `Da contattare: ${[o.newContactName, o.newContactRole].filter(Boolean).join(' · ') || 'altro referente'}`, title: summaryTitle };
      case 'non_risposto':
        return { icon: PhoneMissed, tone: 'neutral', text: 'Non risponde · da richiamare', title: summaryTitle };
      default:
        return { icon: CircleHelp, tone: 'warn', text: 'Esito da verificare', title: summaryTitle || 'Esito non chiaro: controlla la dashboard Retell' };
    }
  }
  if (appt.callStatus === 'called') {
    return awaitingOutcome
      ? { icon: Loader2, tone: 'info', text: 'Chiamato · esito in arrivo…', pulse: true }
      : { icon: CheckCircle2, tone: 'success', text: 'Chiamato' };
  }
  if (appt.callStatus === 'calling') return { icon: PhoneCall, tone: 'info', text: 'Chiamata in corso…', pulse: true };
  if (appt.callStatus === 'failed') return { icon: RefreshCw, tone: 'danger', text: 'Chiamata non partita', title: appt.callSummary };
  return null;
};

export const CallStatus: React.FC<{ appt: Appointment; maxAttempts: number; awaitingOutcome: boolean }> = ({ appt, maxAttempts, awaitingOutcome }) => {
  const line = callLineFor(appt, maxAttempts, awaitingOutcome);
  const backfill = isBackfill(appt);
  const offered = appt.offeredAlternatives?.length && isCallInFlight(appt, new Date()) ? appt.offeredAlternatives : null;
  if (!line && !backfill && !offered) return null;
  return (
    <div className="space-y-1" data-testid="call-status">
      {backfill && (
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-violet-700"
          title="Slot liberato da un altro cliente: il pilota automatico chiama questa pratica per occuparlo">
          <Repeat size={15} strokeWidth={1.75} className="shrink-0" aria-hidden />
          <span className="truncate">Rimpiazza {appt.backfillOf || 'slot liberato'}</span>
        </p>
      )}
      {line && (
        <p className={`flex items-center gap-1.5 text-[13px] font-medium ${TONE_CLASS[line.tone]}`} title={line.title}>
          <line.icon size={15} strokeWidth={1.75} className={`shrink-0 ${line.pulse ? 'animate-pulse' : ''}`} aria-hidden />
          <span className="min-w-0">{line.text}</span>
        </p>
      )}
      {offered && (
        <p className="flex items-start gap-1.5 text-xs text-ink-500">
          <Undo2 size={14} strokeWidth={1.75} className="shrink-0 mt-px" aria-hidden />
          <span>Alternative offerte: {formatAlternatives(offered)}</span>
        </p>
      )}
    </div>
  );
};
