import React, { useRef } from 'react';
import { ArrowLeft, FileSpreadsheet, ListFilter, Search, SearchX } from 'lucide-react';
import type { Appointment } from '../../types';
import PraticheTable from '../PraticheTable';
import { EmptyState } from '../../ui/EmptyState';
import type { Workspace } from '../types';
import { plural } from '../format';
import { STATUS_FILTERS, type SortState, type StatusFilter } from '../praticheTable';

// "Tutte le pratiche" e risultati della ricerca globale: la stessa tabella,
// con le pillole per stato (a scelta singola) e il numero di righe.

const PILL_DOT: Record<StatusFilter, string | null> = {
  all: null,
  pending: 'bg-amber-500',
  proposed: 'bg-sky-500',
  confirmed: 'bg-emerald-500',
  issue: 'bg-rose-500',
  standby: 'bg-slate-400',
  cancelled: 'bg-slate-300',
};

interface AllPraticheProps {
  ws: Workspace;
  mode: 'section' | 'search';
  rows: Appointment[];                       // filtrate (stato, ricerca, tecnico) e ordinate
  counts: Record<StatusFilter, number>;      // per pillola (prima del filtro per stato)
  status: StatusFilter;
  onStatus: (s: StatusFilter) => void;
  sort: SortState;
  onSort: (s: SortState) => void;
  query: string;
  onClearSearch: () => void;
  backLabel?: string;                        // sezione da cui è partita la ricerca
  onImportExcel: () => void;
}

const AllPraticheSection: React.FC<AllPraticheProps> = (p) => {
  const groupRef = useRef<HTMLDivElement>(null);
  const label = STATUS_FILTERS.find(f => f.id === p.status)?.label || '';

  // Pillole come gruppo di scelte: frecce sinistra/destra per spostarsi
  const onPillKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = STATUS_FILTERS.findIndex(f => f.id === p.status);
    const next = STATUS_FILTERS[(i + (e.key === 'ArrowRight' ? 1 : STATUS_FILTERS.length - 1)) % STATUS_FILTERS.length];
    p.onStatus(next.id);
    requestAnimationFrame(() => groupRef.current?.querySelector<HTMLButtonElement>(`[data-filter="${next.id}"]`)?.focus());
  };

  const pills = (
    <div ref={groupRef} role="radiogroup" aria-label="Filtra per stato" className="flex flex-wrap items-center gap-1.5" onKeyDown={onPillKey} data-testid="status-pills">
      {STATUS_FILTERS.map(f => {
        const active = p.status === f.id;
        const n = p.counts[f.id];
        return (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-filter={f.id}
            data-testid={`pill-${f.id}`}
            onClick={() => p.onStatus(f.id)}
            className={`pill ${active ? 'pill-active' : ''} ${n === 0 && !active ? 'opacity-60' : ''}`}
          >
            {PILL_DOT[f.id] && <span className={`dot ${PILL_DOT[f.id]}`} aria-hidden />}
            {f.label}
            <span className="pill-count">{n}</span>
          </button>
        );
      })}
    </div>
  );

  const searchBanner = p.mode === 'search' && (
    <div className="flex items-center gap-2 flex-wrap text-[13px] text-ink-600">
      <Search size={15} strokeWidth={1.75} className="text-ink-400 shrink-0" aria-hidden />
      <span className="flex-1 min-w-[200px]">
        <span className="font-semibold text-ink-900">{plural(p.counts.all, 'pratica trovata', 'pratiche trovate')}</span> per «{p.query.trim()}» in tutte le sezioni, in ogni stato e data.
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={p.onClearSearch} data-testid="search-back">
        <ArrowLeft size={14} strokeWidth={1.75} aria-hidden /> {p.backLabel ? `Torna a ${p.backLabel}` : 'Svuota la ricerca'}
      </button>
    </div>
  );

  let body: React.ReactNode;
  if (p.mode === 'search' && p.counts.all === 0) {
    body = (
      <EmptyState
        icon={SearchX}
        title={`Nessuna pratica corrisponde a «${p.query.trim()}»`}
        action={<button type="button" className="btn btn-secondary btn-sm" onClick={p.onClearSearch}>Svuota la ricerca</button>}
      >
        La ricerca guarda tutte le pratiche, in ogni stato e data: cliente, via, comune, codice, telefono, referente e note. Prova con meno parole o con una parte del codice.
      </EmptyState>
    );
  } else if (p.counts.all === 0) {
    body = (
      <EmptyState
        icon={ListFilter}
        title="Nessuna pratica"
        action={<button type="button" className="btn btn-primary btn-sm" onClick={p.onImportExcel}><FileSpreadsheet size={15} strokeWidth={1.75} aria-hidden /> Importa Excel</button>}
      >
        Qui trovi tutte le pratiche in un'unica tabella, in ogni stato: da ordinare, filtrare e aprire.
      </EmptyState>
    );
  } else if (p.rows.length === 0) {
    body = (
      <EmptyState
        icon={ListFilter}
        title={`Nessuna pratica: ${label.toLowerCase()}`}
        action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => p.onStatus('all')}>Mostra tutte</button>}
      >
        {p.mode === 'search' ? `Fra i risultati per «${p.query.trim()}» non ce n'è in questo stato.` : 'Scegli un altro stato qui sopra.'}
      </EmptyState>
    );
  } else {
    body = <PraticheTable rows={p.rows} ws={p.ws} query={p.mode === 'search' ? p.query : ''} sort={p.sort} onSort={p.onSort} />;
  }

  return (
    <div className="space-y-4" data-testid={p.mode === 'search' ? 'search-results' : undefined}>
      {searchBanner}
      {(p.counts.all > 0) && (
        <div className="flex items-center gap-3 flex-wrap">
          {pills}
          <p className="ml-auto text-xs text-ink-500" data-testid="pratiche-count" aria-live="polite">
            {p.status === 'all' ? plural(p.rows.length, 'riga', 'righe') : `${plural(p.rows.length, 'riga', 'righe')} di ${p.counts.all}`}
          </p>
        </div>
      )}
      {body}
    </div>
  );
};

export default AllPraticheSection;
