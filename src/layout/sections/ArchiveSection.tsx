import React from 'react';
import { Archive, Ban, PauseCircle } from 'lucide-react';
import type { Appointment } from '../../types';
import PraticaCard from '../PraticaCard';
import { EmptyState } from '../../ui/EmptyState';
import type { Workspace } from '../types';

const ArchiveSection: React.FC<{ ws: Workspace; standby: Appointment[]; cancelled: Appointment[] }> = ({ ws, standby, cancelled }) => {
  if (standby.length === 0 && cancelled.length === 0) {
    return (
      <EmptyState icon={Archive} title="Archivio vuoto">
        Qui restano le pratiche messe in stand-by e quelle annullate: puoi rimetterle in attesa in ogni momento.
      </EmptyState>
    );
  }
  const block = (title: string, Icon: typeof Archive, items: Appointment[], hint: string) => {
    const visible = items.filter(ws.matches);
    return (
      <section>
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border text-ink-600 bg-slate-50 border-slate-200">
            <Icon size={14} strokeWidth={1.75} aria-hidden />
          </span>
          <h4 className="text-[13px] font-semibold text-ink-900">{title}</h4>
          <span className="num text-xs text-ink-500">{items.length}</span>
        </div>
        <p className="text-xs text-ink-500 mb-3 pl-8">{hint}</p>
        {items.length === 0 ? (
          <p className="text-sm text-ink-400 pl-8">Nessuna.</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-ink-500 pl-8">Nessuna corrisponde alla ricerca.</p>
        ) : (
          <div className="space-y-3">{visible.map(a => <PraticaCard key={a.id} appt={a} ws={ws} />)}</div>
        )}
      </section>
    );
  };
  return (
    <div className="space-y-8">
      {block('Stand-by', PauseCircle, standby, 'Pratiche sospese: non vengono smistate né chiamate')}
      {block('Annullate', Ban, cancelled, 'Sopralluoghi che non servono più')}
    </div>
  );
};

export default ArchiveSection;
