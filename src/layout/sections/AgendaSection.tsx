import React from 'react';
import { ArrowRightLeft, CalendarDays, Phone, Sparkles, TriangleAlert, Route } from 'lucide-react';
import type { Appointment, RouteSummary, Technician } from '../../types';
import PraticaCard from '../PraticaCard';
import RouteTimeline from '../RouteTimeline';
import { EmptyState } from '../../ui/EmptyState';
import type { Workspace } from '../types';
import { cap, dayLabel, dayTitle, longDayLabel, plural } from '../format';

interface AgendaSectionProps {
  ws: Workspace;
  items: Appointment[];                    // confermate nel periodo (filtro tecnico)
  otherDays: [string, number][];           // giornate con confermate fuori dalla vista
  onGoDay: (date: string) => void;
  onOptimize: () => void;
  optimizeLabel: string;
  canDragReorder: boolean;
  routeSummary: RouteSummary | null;
  selectedTech: Technician | null;
  techUnavailable: boolean;
  onOpenProposals: () => void;
  proposedCount: number;
}

const AgendaSection: React.FC<AgendaSectionProps> = (p) => {
  const { ws } = p;
  const sorted = [...p.items].sort((a, b) => {
    if (a.date !== b.date && a.date && b.date) return a.date.localeCompare(b.date);
    return (a.sequenceOrder || 0) - (b.sequenceOrder || 0);
  });
  const visible = sorted.filter(ws.matches);

  const dayChips = p.otherDays.length > 0 && (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-ink-500 mr-1">{ws.viewMode === 'day' ? 'Altre giornate' : 'Giornate'}</span>
      {p.otherDays.map(([day, count]) => (
        <button
          key={day}
          type="button"
          onClick={() => p.onGoDay(day)}
          title={`Vai al giro ${ws.viewMode === 'day' ? 'confermato ' : ''}del ${dayLabel(day)}`}
          className="chip chip-success h-7 px-2.5 hover:bg-emerald-100"
        >
          {dayTitle(day)} <span className="num font-semibold">{count}</span>
        </button>
      ))}
    </div>
  );

  const toolbar = (
    <div className="card p-4">
      <div className="flex items-center gap-3 flex-wrap">
      <div className="min-w-[200px] flex-1">
        <p className="section-title">{plural(p.items.length, 'sopralluogo confermato', 'sopralluoghi confermati')}</p>
        {p.routeSummary && ws.viewMode === 'day' && (
          <p className="text-xs text-ink-500 mt-0.5">
            {p.selectedTech ? `Giro di ${p.selectedTech.name}` : 'Giro senza tecnico'}: <span className="num">{p.routeSummary.totalDistance} km</span> · <span className="num">{p.routeSummary.totalTravelTime} min</span> di guida · fine <span className="num">{p.routeSummary.finalEndTime}</span>
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {p.items.some(a => a.phone) && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => ws.onBulkCall(p.items)} title="Avvia la chiamata AI di conferma per tutte le confermate con telefono">
            <Phone size={15} strokeWidth={1.75} aria-hidden /> Chiama tutte
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={p.onOptimize} disabled={ws.isOptimizing} title="Ordina le tappe e ricalcola gli orari della giornata in agenda">
          <Sparkles size={15} strokeWidth={1.75} aria-hidden /> {ws.isOptimizing ? 'Calcolo…' : 'Ottimizza'}
        </button>
      </div>
      </div>
      {ws.viewMode === 'day' && p.canDragReorder && p.items.length > 1 && (
        <p className="text-xs text-ink-500 mt-2 flex items-center gap-1.5"><ArrowRightLeft size={13} strokeWidth={1.75} className="shrink-0" aria-hidden /> Trascina una tappa per riordinare il giro: orari e mappa si ricalcolano.</p>
      )}
    </div>
  );

  const unavailable = p.selectedTech && p.techUnavailable && (
    <div className="callout callout-danger">
      <TriangleAlert size={16} strokeWidth={1.75} className="shrink-0 mt-0.5" aria-hidden />
      <span>{p.selectedTech.name} non è disponibile {ws.viewMode === 'day' ? 'il' : 'nella data di riferimento,'} {dayLabel(ws.currentDate)}.</span>
    </div>
  );

  let body: React.ReactNode;
  if (p.items.length === 0) {
    body = (
      <EmptyState
        icon={CalendarDays}
        title={ws.viewMode === 'day' ? `Nessun sopralluogo confermato ${longDayLabel(ws.currentDate) ? `per ${longDayLabel(ws.currentDate)}` : ''}` : 'Nessun sopralluogo confermato nel periodo'}
        action={p.proposedCount > 0 ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={p.onOpenProposals}><Route size={15} strokeWidth={1.75} aria-hidden /> Vai alle proposte ({p.proposedCount})</button>
        ) : undefined}
      >
        L'agenda mostra i giri confermati, giorno per giorno. Scegli un'altra data con le frecce o con i giorni qui sopra.
      </EmptyState>
    );
  } else if (visible.length === 0) {
    body = <p className="text-sm text-ink-500">Nessun sopralluogo corrisponde alla ricerca.</p>;
  } else if (ws.viewMode === 'day') {
    // Un giro per tecnico, come linea del tempo
    const groups = new Map<string, Appointment[]>();
    for (const a of visible) {
      const k = a.technicianId || 'none';
      groups.set(k, [...(groups.get(k) || []), a]);
    }
    body = Array.from(groups.entries()).map(([techId, items]) => {
      const tech = ws.techById(techId === 'none' ? undefined : techId);
      const color = tech?.color || '#646A7B';
      const first = items[0]?.startTime;
      const last = items[items.length - 1]?.endTime;
      return (
        <section key={techId} className="card overflow-hidden" data-testid="route-group">
          <header className="relative px-4 py-3 border-b border-line flex items-center gap-3 flex-wrap">
            <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-semibold text-ink-950">
                <span className="dot" style={{ backgroundColor: color }} />
                <span className="truncate">{tech ? tech.name : 'Senza tecnico'}</span>
              </p>
              <p className="text-xs text-ink-500 mt-0.5">
                {plural(items.length, 'tappa', 'tappe')}{first && last ? <> · <span className="num">{first}–{last}</span></> : null}
              </p>
            </div>
            {items.some(a => a.phone) && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => ws.onBulkCall(items)} title="Chiama i clienti di questo giro (AI)">
                <Phone size={15} strokeWidth={1.75} aria-hidden /> Chiama il giro
              </button>
            )}
          </header>
          <div className="px-3 sm:px-4 pt-4 pb-2">
            <RouteTimeline items={items} ws={ws} color={color} draggable={p.canDragReorder} />
          </div>
        </section>
      );
    });
  } else {
    // Settimana / mese: per giorno
    const byDay = new Map<string, Appointment[]>();
    for (const a of visible) byDay.set(a.date || '', [...(byDay.get(a.date || '') || []), a]);
    body = Array.from(byDay.entries()).map(([day, items]) => (
      <section key={day}>
        <div className="flex items-center gap-2 mb-2">
          <button type="button" className="text-sm font-semibold text-ink-900 hover:underline underline-offset-2" onClick={() => p.onGoDay(day)} title="Apri il giorno">
            {cap(longDayLabel(day))}
          </button>
          <span className="num text-xs text-ink-500">{items.length}</span>
          {day === ws.todayStr && <span className="chip chip-brand">Oggi</span>}
        </div>
        <div className="space-y-3">
          {items.map(a => <PraticaCard key={a.id} appt={a} ws={ws} />)}
        </div>
      </section>
    ));
  }

  return (
    <div className="space-y-5">
      {toolbar}
      {dayChips}
      {unavailable}
      {body}
    </div>
  );
};

export default AgendaSection;
