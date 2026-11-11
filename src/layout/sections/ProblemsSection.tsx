import React from 'react';
import { CalendarClock, CheckCircle2, HardHat, PhoneOff, type LucideIcon } from 'lucide-react';
import type { Appointment, IssueType } from '../../types';
import PraticaCard from '../PraticaCard';
import { EmptyState } from '../../ui/EmptyState';
import type { Workspace } from '../types';

const META: { type: IssueType; label: string; icon: LucideIcon; hint: string }[] = [
  { type: 'wrong_phone', label: 'Numero errato', icon: PhoneOff, hint: 'Trova il numero giusto e rimetti la pratica in attesa' },
  { type: 'callback', label: 'Da richiamare', icon: CalendarClock, hint: 'Il cliente chiede di essere richiamato più avanti' },
  { type: 'works_pending', label: 'Lavori da ultimare', icon: HardHat, hint: 'Immobile non pronto: si riparte dalla data di fine lavori' },
];

const ProblemsSection: React.FC<{ ws: Workspace; items: Appointment[] }> = ({ ws, items }) => {
  if (items.length === 0) {
    return (
      <EmptyState icon={CheckCircle2} tone="success" title="Nessuna pratica con problemi">
        Qui finiscono le pratiche con un numero errato, da richiamare o con lavori da ultimare. Con la data di rientro, dal giorno prima compare l'avviso per riservare lo slot.
      </EmptyState>
    );
  }
  const visible = items.filter(ws.matches);
  return (
    <div className="space-y-8">
      {META.map(m => {
        const group = visible
          .filter(a => (a.issueType || 'callback') === m.type)
          .sort((a, b) => (a.followUpDate || '9999').localeCompare(b.followUpDate || '9999'));
        const total = items.filter(a => (a.issueType || 'callback') === m.type).length;
        if (total === 0) return null;
        const Icon = m.icon;
        return (
          <section key={m.type}>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border text-rose-700 bg-rose-50 border-rose-200">
                <Icon size={14} strokeWidth={1.75} aria-hidden />
              </span>
              <h4 className="text-[13px] font-semibold text-ink-900">{m.label}</h4>
              <span className="num text-xs text-ink-500">{total}</span>
            </div>
            <p className="text-xs text-ink-500 mb-3 pl-8">{m.hint}</p>
            {group.length === 0 ? (
              <p className="text-sm text-ink-500 pl-8">Nessuna corrisponde alla ricerca.</p>
            ) : (
              <div className="space-y-3">
                {group.map(a => <PraticaCard key={a.id} appt={a} ws={ws} />)}
              </div>
            )}
          </section>
        );
      })}
      <p className="text-xs text-ink-500">
        Imposta la data di rientro (richiamo o fine lavori) da Modifica: dal giorno prima comparirà l'avviso per riservare gli slot.
      </p>
    </div>
  );
};

export default ProblemsSection;
