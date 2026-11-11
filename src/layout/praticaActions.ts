import { Check, Clock, PauseCircle, Pencil, Phone, RotateCcw, Trash2, type LucideIcon } from 'lucide-react';
import type { Appointment, AppointmentStatus } from '../types';
import type { Workspace } from './types';
import { dayLabel } from './format';

// Azioni di una pratica: UN solo costruttore, usato dalla scheda
// (PraticaCard) e dalla riga della tabella (PraticheTable), così le due
// non possono divergere. Un'azione principale visibile, le altre nel menu.

export const STATUS_META: Record<AppointmentStatus, { label: string; chip: string }> = {
  confirmed: { label: 'Confermata', chip: 'chip-success' },
  proposed: { label: 'Proposta', chip: 'chip-info' },
  pending: { label: 'In attesa', chip: 'chip-warn' },
  issue: { label: 'Problema', chip: 'chip-danger' },
  standby: { label: 'Stand-by', chip: 'chip-neutral' },
  cancelled: { label: 'Annullata', chip: 'chip-neutral' },
};

export const ISSUE_LABEL: Record<string, { label: string; reentry: string }> = {
  wrong_phone: { label: 'Numero errato', reentry: 'Ricontatto' },
  callback: { label: 'Da richiamare', reentry: 'Richiamo' },
  works_pending: { label: 'Lavori da ultimare', reentry: 'Fine lavori' },
};

// Etichetta di stato (per i problemi, il tipo di problema)
export const statusLabel = (a: Appointment): string =>
  a.status === 'issue' && a.issueType ? (ISSUE_LABEL[a.issueType]?.label || STATUS_META.issue.label) : STATUS_META[a.status].label;

export interface PraticaAction {
  key: string;
  label: string;
  icon: LucideIcon;
  title?: string;
  danger?: boolean;
  run: () => void;
}

// Azioni di oggi per ciascuno stato (nessuna aggiunta, nessuna tolta)
export const actionsFor = (a: Appointment, ws: Workspace): { primary: PraticaAction; more: PraticaAction[] } => {
  const edit: PraticaAction = { key: 'edit', label: 'Modifica', icon: Pencil, title: 'Modifica la pratica', run: () => ws.onEdit(a) };
  const call: PraticaAction | null = a.phone && a.callStatus !== 'calling'
    ? { key: 'call', label: 'Chiama', icon: Phone, title: a.status === 'proposed' ? 'Chiama il cliente per conferma (AI)' : 'Chiama il cliente (AI)', run: () => ws.onCall(a) }
    : null;
  const remove: PraticaAction = { key: 'remove', label: 'Elimina', icon: Trash2, danger: true, title: 'Elimina definitivamente la pratica', run: () => ws.onRemove(a.id) };
  const to = (status: AppointmentStatus, label: string, icon: LucideIcon, title?: string): PraticaAction =>
    ({ key: `to-${status}`, label, icon, title, run: () => ws.onStatusChange(a.id, status) });

  switch (a.status) {
    case 'proposed':
      return {
        primary: to('confirmed', 'Conferma', Check, 'Conferma questa proposta'),
        more: [...(call ? [call] : []), edit, to('pending', 'Rifiuta: torna in attesa', RotateCcw, 'Rifiuta la proposta: la pratica torna in attesa')],
      };
    case 'confirmed': {
      const rest = [to('standby', 'Metti in stand-by', PauseCircle), to('pending', 'Torna in attesa', Clock)];
      return call ? { primary: call, more: [edit, ...rest] } : { primary: edit, more: rest };
    }
    case 'pending':
      return {
        primary: edit,
        more: [
          to('confirmed', `Conferma per il ${dayLabel(ws.currentDate)}`, Check, 'Forza la conferma nella data dell\'agenda'),
          to('standby', 'Metti in stand-by', PauseCircle),
          remove,
        ],
      };
    case 'standby':
      return { primary: to('pending', 'Rimetti in attesa', RotateCcw, 'Riattiva: torna tra le pratiche da pianificare'), more: [edit, remove] };
    case 'issue':
      return {
        primary: to('pending', 'Rimetti in attesa', RotateCcw, 'Rimetti in attesa (torna pianificabile)'),
        more: [{ ...edit, label: 'Modifica (categoria, data di rientro)' }, remove],
      };
    case 'cancelled':
    default:
      return { primary: to('pending', 'Ripristina', RotateCcw, 'Ripristina in attesa'), more: [remove] };
  }
};
