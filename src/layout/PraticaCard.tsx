import React, { useState } from 'react';
import {
  Bell, Check, ChevronRight, Clock, GripVertical, Hash, MapPin, MoreHorizontal, PauseCircle, Pencil, Phone,
  RotateCcw, Sparkles, Trash2, UserRound, type LucideIcon,
} from 'lucide-react';
import type { Appointment, AppointmentStatus } from '../types';
import { CallStatus } from '../Components/AutopilotBadges';
import { Menu, MenuItem } from '../ui/Menu';
import type { Workspace } from './types';
import { dayLabel, placeLabel, shortStreet } from './format';

// La scheda della pratica: un solo componente, con varianti.
// Gerarchia: orario/stato · cliente · indirizzo · etichette · stato della
// chiamata · telefono e note · riassunto AI. Un'azione principale visibile,
// tutte le altre nel menu "Altro".

export const STATUS_META: Record<AppointmentStatus, { label: string; chip: string }> = {
  confirmed: { label: 'Confermata', chip: 'chip-success' },
  proposed: { label: 'Proposta', chip: 'chip-info' },
  pending: { label: 'In attesa', chip: 'chip-warn' },
  issue: { label: 'Problema', chip: 'chip-danger' },
  standby: { label: 'Stand-by', chip: 'chip-neutral' },
  cancelled: { label: 'Annullata', chip: 'chip-neutral' },
};

const ISSUE_LABEL: Record<string, { label: string; reentry: string }> = {
  wrong_phone: { label: 'Numero errato', reentry: 'Ricontatto' },
  callback: { label: 'Da richiamare', reentry: 'Richiamo' },
  works_pending: { label: 'Lavori da ultimare', reentry: 'Fine lavori' },
};

interface Action {
  key: string;
  label: string;
  icon: LucideIcon;
  title?: string;
  danger?: boolean;
  run: () => void;
}

// Azioni di oggi per ciascuno stato (nessuna aggiunta, nessuna tolta)
const actionsFor = (a: Appointment, ws: Workspace): { primary: Action; more: Action[] } => {
  const edit: Action = { key: 'edit', label: 'Modifica', icon: Pencil, title: 'Modifica la pratica', run: () => ws.onEdit(a) };
  const call: Action | null = a.phone && a.callStatus !== 'calling'
    ? { key: 'call', label: 'Chiama', icon: Phone, title: a.status === 'proposed' ? 'Chiama il cliente per conferma (AI)' : 'Chiama il cliente (AI)', run: () => ws.onCall(a) }
    : null;
  const remove: Action = { key: 'remove', label: 'Elimina', icon: Trash2, danger: true, title: 'Elimina definitivamente la pratica', run: () => ws.onRemove(a.id) };
  const to = (status: AppointmentStatus, label: string, icon: LucideIcon, title?: string): Action =>
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

interface PraticaCardProps {
  appt: Appointment;
  ws: Workspace;
  // 'card' = scheda autonoma; 'stop' = tappa dentro un giro (orario a sinistra, fuori dalla scheda)
  variant?: 'card' | 'stop';
  draggable?: boolean;
  showDate?: boolean;
}

const PraticaCard: React.FC<PraticaCardProps> = ({ appt, ws, variant = 'card', draggable = false, showDate = false }) => {
  const [notesOpen, setNotesOpen] = useState(false);
  const tech = ws.techById(appt.technicianId);
  const { primary, more } = actionsFor(appt, ws);
  const selected = ws.selectedAppointmentId === appt.id;
  const street = shortStreet(appt);
  const place = placeLabel(appt);
  const o = appt.callOutcome;
  const summary = o?.summary || appt.callSummary;
  const longNotes = !!appt.notes && (appt.notes.length > 110 || appt.notes.includes('\n'));
  const scheduled = (appt.status === 'confirmed' || appt.status === 'proposed') && !!appt.startTime;
  const muted = appt.status === 'cancelled' || appt.status === 'standby';

  const onCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, summary, [role="menu"]')) return;
    ws.onSelect(appt.id);
  };

  const PrimaryIcon = primary.icon;

  return (
    <article
      id={`appt-${appt.id}`}
      data-testid="pratica-card"
      data-status={appt.status}
      draggable={draggable}
      onDragStart={draggable ? (e) => ws.onDragStart(e, appt.id) : undefined}
      onDragOver={(e) => ws.onDragOver(e, appt.id)}
      onDrop={(e) => ws.onDrop(e, appt.id)}
      onDragEnd={ws.onDragEnd}
      onClick={onCardClick}
      aria-selected={selected}
      className={[
        'pratica group relative bg-surface border rounded-card transition-[box-shadow,border-color,opacity] duration-150',
        variant === 'card' ? 'p-4 shadow-card' : 'p-3.5',
        selected ? 'border-brand-400 ring-2 ring-brand-300/60 shadow-raised' : 'border-line hover:border-slate-300 hover:shadow-raised',
        ws.dragOverId === appt.id ? 'ring-2 ring-sky-400 border-sky-400' : '',
        ws.dragId === appt.id ? 'opacity-40' : '',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        appt.urgent ? 'pratica-urgent' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        {draggable && (
          <span className="drag-handle" title="Trascina per riordinare il giro" aria-hidden>
            <GripVertical size={16} strokeWidth={1.75} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {/* (1) orario o stato */}
          {(variant === 'card' || !scheduled) && (
            <div className="flex items-center gap-2 mb-1 min-h-[22px] flex-wrap">
              {scheduled ? (
                <span className="num text-[13px] font-semibold text-ink-900">{appt.startTime}–{appt.endTime}</span>
              ) : (
                <span className={`chip ${STATUS_META[appt.status].chip}`}>
                  {appt.status === 'issue' && appt.issueType ? ISSUE_LABEL[appt.issueType]?.label : STATUS_META[appt.status].label}
                </span>
              )}
              {(showDate || (scheduled && variant === 'card')) && appt.date && (
                <span className="text-xs text-ink-500">{dayLabel(appt.date)}</span>
              )}
              {scheduled && appt.status === 'proposed' && variant === 'card' && <span className="chip chip-info">Proposta</span>}
            </div>
          )}

          {/* (2) cliente */}
          <h4 className={`text-[15px] font-semibold leading-snug tracking-tight break-words ${muted ? 'text-ink-600' : 'text-ink-950'} ${appt.status === 'cancelled' ? 'line-through decoration-ink-300' : ''}`}>
            {appt.title}
          </h4>
        </div>

        {/* Azioni */}
        <div className="flex items-center gap-1 shrink-0 -mr-1 -my-1">
          <button
            type="button"
            onClick={primary.run}
            title={primary.title}
            aria-label={primary.label}
            className={`btn btn-sm ${primary.key === 'to-confirmed' ? 'btn-secondary text-emerald-700' : 'btn-secondary'}`}
          >
            <PrimaryIcon size={15} strokeWidth={1.75} aria-hidden />
            <span className="pratica-action-label">{primary.label}</span>
          </button>
          {more.length > 0 && (
            <Menu
              button={<MoreHorizontal size={18} strokeWidth={1.75} aria-hidden />}
              buttonClassName="icon-btn"
              title="Altre azioni"
              ariaLabel={`Altre azioni per ${appt.title}`}
              minWidth={230}
            >
              {more.map(a => (
                <MenuItem key={a.key} icon={a.icon} onSelect={a.run} title={a.title} danger={a.danger}>{a.label}</MenuItem>
              ))}
            </Menu>
          )}
        </div>
      </div>

      <div className={draggable ? 'pl-[22px]' : ''}>

          {/* (3) indirizzo breve e comune */}
          {(street || place) && (
            <p className="mt-0.5 text-[13px] text-ink-500 truncate" title={appt.address}>
              {street}{street && place ? ' · ' : ''}{place}
            </p>
          )}

          {/* (4) etichette */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 empty:hidden">
            {appt.urgent && <span className="chip chip-solid-danger font-semibold tracking-wide">URGENTE</span>}
            {tech && variant === 'card' ? (
              <span className="chip chip-neutral" title={`Tecnico: ${tech.name}`}>
                <span className="dot" style={{ backgroundColor: tech.color }} />{tech.name}
              </span>
            ) : !tech && appt.status === 'pending' ? (
              <span className="chip chip-warn">Da assegnare</span>
            ) : null}
            {appt.periziaCode && (
              <span className="chip chip-neutral num" title={appt.project ? `Progetto: ${appt.project}` : 'Codice pratica'}>
                <Hash size={12} strokeWidth={2} aria-hidden />{appt.periziaCode}
              </span>
            )}
            {appt.approximate && (
              <span className="chip chip-warn" title="Indirizzo esatto non trovato sulle mappe: la pratica è posizionata al centro del comune. Correggi l'indirizzo con Modifica per il punto esatto.">
                <MapPin size={12} strokeWidth={2} aria-hidden />Posizione approssimativa
              </span>
            )}
            {appt.followUpDate && (appt.status === 'issue' || appt.status === 'pending') && (
              <span className="chip chip-warn" title="Data di rientro: lo smistamento non proporrà date precedenti">
                <Bell size={12} strokeWidth={2} aria-hidden />
                {appt.status === 'issue' ? ISSUE_LABEL[appt.issueType || 'callback'].reentry : 'Rientro'} {dayLabel(appt.followUpDate)}
              </span>
            )}
            {appt.contactPerson && (
              <span className="chip chip-neutral max-w-full" title={appt.referredBy ? `Indicato da ${appt.referredBy}` : 'Referente da contattare'}>
                <UserRound size={12} strokeWidth={2} aria-hidden /><span className="truncate">{appt.contactPerson}</span>
              </span>
            )}
          </div>

          {/* (5) stato della chiamata */}
          <div className="mt-2 empty:hidden">
            <CallStatus appt={appt} maxAttempts={ws.maxAttempts} awaitingOutcome={ws.awaitingOutcome(appt)} />
          </div>

          {/* (6) telefono, note, riassunto AI */}
          {appt.phone && (
            <p className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-700">
              <Phone size={14} strokeWidth={1.75} className="text-ink-400" aria-hidden />
              <span className="num">{appt.phone}</span>
            </p>
          )}
          {appt.notes && (
            <div className="mt-1.5 text-[13px] text-ink-500 leading-relaxed">
              <p className={`whitespace-pre-line ${notesOpen ? '' : 'line-clamp-2'}`}>{appt.notes}</p>
              {longNotes && (
                <button type="button" className="text-xs font-medium text-ink-700 hover:text-ink-950 underline-offset-2 hover:underline" onClick={() => setNotesOpen(v => !v)}>
                  {notesOpen ? 'mostra meno' : 'mostra tutto'}
                </button>
              )}
            </div>
          )}
          {summary && (
            <details className="mt-2 group/sum">
              <summary className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-700 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <ChevronRight size={14} strokeWidth={2} className="transition-transform group-open/sum:rotate-90" aria-hidden />
                <Sparkles size={13} strokeWidth={1.75} aria-hidden /> Riassunto della chiamata
              </summary>
              <p className="mt-1.5 text-[13px] text-ink-600 leading-relaxed bg-violet-50/60 border border-violet-100 rounded-control px-3 py-2">
                {summary}
                {o?.clientNotes && <><br /><span className="text-ink-500">Note del cliente: {o.clientNotes}</span></>}
              </p>
            </details>
          )}
      </div>
    </article>
  );
};

export default PraticaCard;
