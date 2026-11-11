import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Bell, MoreHorizontal, PhoneOff, UserRound } from 'lucide-react';
import type { Appointment } from '../types';
import { CallStatusInline } from '../Components/AutopilotBadges';
import { Menu, MenuDivider, MenuItem, MenuLabel } from '../ui/Menu';
import type { Workspace } from './types';
import { formatPhone, placeLabel, shortStreet } from './format';
import { STATUS_META, actionsFor, statusLabel } from './praticaActions';
import {
  SORT_LABELS, TABLE_COLUMNS, appointmentText, highlightParts, nextSort, phoneMissing, tableLayoutFor,
  type SortKey, type SortState, type TableLayout,
} from './praticheTable';
import { useElementWidth } from './useUiPrefs';

// Elenco completo delle pratiche: tabella densa quando il pannello è largo,
// righe compatte su due linee quando è stretto (decide la larghezza reale
// del pannello, non dello schermo). Le azioni sono quelle della scheda.

// Testo con le parole cercate evidenziate
export const Hl: React.FC<{ text?: string; q: string }> = ({ text, q }) => {
  if (!text) return null;
  if (!q.trim()) return <>{text}</>;
  return (
    <>
      {highlightParts(text, q).map((p, i) => (p.hit ? <mark key={i} className="hl">{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}
    </>
  );
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join('');

// Clic sulla riga: seleziona (ma non se il clic è su un comando)
const isControl = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('button, a, input, select, textarea, [role="menu"]');

interface RowCommon {
  appt: Appointment;
  ws: Workspace;
  q: string;
}

const StatusCell: React.FC<{ appt: Appointment }> = ({ appt }) => (
  <span className="flex items-center gap-1.5 min-w-0">
    <span className={`chip ${STATUS_META[appt.status].chip} min-w-0`} title={statusLabel(appt)}>
      <span className="truncate">{statusLabel(appt)}</span>
    </span>
    {appt.urgent && (
      <span className="urgent-mark" title="Urgente" aria-label="Urgente" role="img">!</span>
    )}
  </span>
);

const Actions: React.FC<{ appt: Appointment; ws: Workspace }> = ({ appt, ws }) => {
  const { primary, more } = actionsFor(appt, ws);
  const Icon = primary.icon;
  return (
    <span className="flex items-center justify-end gap-0.5">
      <button
        type="button"
        onClick={primary.run}
        title={primary.title || primary.label}
        aria-label={primary.label}
        data-testid="row-primary"
        className={`icon-btn ${primary.key === 'to-confirmed' ? 'text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50' : ''}`}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {more.length > 0 ? (
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
      ) : <span className="w-8" aria-hidden />}
    </span>
  );
};

const rowHandlers = (appt: Appointment, ws: Workspace) => ({
  tabIndex: 0,
  onClick: (e: React.MouseEvent) => { if (!isControl(e.target)) ws.onSelect(appt.id); },
  onDoubleClick: (e: React.MouseEvent) => { if (!isControl(e.target)) ws.onEdit(appt); },
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') { e.preventDefault(); ws.onEdit(appt); }
    else if (e.key === ' ') { e.preventDefault(); ws.onSelect(appt.id); }
  },
});

// --- Riga della tabella larga ---
const TableRow: React.FC<RowCommon & { layout: TableLayout }> = ({ appt, ws, q, layout }) => {
  const tech = ws.techById(appt.technicianId);
  const selected = ws.selectedAppointmentId === appt.id;
  const when = appointmentText(appt);
  const street = shortStreet(appt);
  const place = placeLabel(appt);
  const muted = appt.status === 'cancelled' || appt.status === 'standby';
  return (
    <tr
      id={`appt-${appt.id}`}
      data-testid="pratica-row"
      data-status={appt.status}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${appt.title}, ${statusLabel(appt)}`}
      className={`prow ${selected ? 'prow-selected' : ''} ${appt.urgent ? 'prow-urgent' : ''}`}
      {...rowHandlers(appt, ws)}
    >
      <td><StatusCell appt={appt} /></td>
      <td>
        <span className={`block truncate text-[13px] font-semibold ${muted ? 'text-ink-600' : 'text-ink-950'} ${appt.status === 'cancelled' ? 'line-through decoration-ink-300' : ''}`} title={appt.title}>
          <Hl text={appt.title} q={q} />
        </span>
        {appt.contactPerson && (
          <span className="flex items-center gap-1 text-xs text-ink-500 min-w-0" title={appt.referredBy ? `Indicato da ${appt.referredBy}` : 'Referente da contattare'}>
            <UserRound size={11} strokeWidth={2} className="shrink-0" aria-hidden />
            <span className="truncate"><Hl text={appt.contactPerson} q={q} /></span>
          </span>
        )}
      </td>
      <td title={appt.address}>
        <span className="block truncate text-[13px] text-ink-800"><Hl text={street || '—'} q={q} /></span>
        {place && <span className="block truncate text-xs text-ink-500"><Hl text={place} q={q} /></span>}
      </td>
      <td>
        <span className="block truncate num text-xs text-ink-800" title={appt.periziaCode ? 'Codice pratica' : undefined}>
          {appt.periziaCode ? <Hl text={appt.periziaCode} q={q} /> : <span className="text-ink-400">—</span>}
        </span>
        {appt.project && <span className="block truncate text-xs text-ink-500" title={`Committente / progetto: ${appt.project}`}><Hl text={appt.project} q={q} /></span>}
      </td>
      <td>
        {tech ? (
          <span className="flex items-center gap-1.5 min-w-0 text-[13px] text-ink-800" title={`Tecnico: ${tech.name}`}>
            <span className="dot" style={{ backgroundColor: tech.color }} />
            {layout === 'xl' ? <span className="truncate">{tech.name}</span> : <span className="num text-xs font-semibold">{initials(tech.name)}</span>}
          </span>
        ) : appt.status === 'pending' ? (
          <span className="text-xs font-medium text-amber-800" title="Da assegnare">{layout === 'xl' ? 'Da assegnare' : '—'}</span>
        ) : <span className="text-xs text-ink-400">—</span>}
      </td>
      <td>
        {when.kind === 'slot' ? (
          <>
            <span className="block truncate text-[13px] text-ink-800">{when.day}</span>
            {when.time && <span className="block num text-xs text-ink-500">{when.time}</span>}
          </>
        ) : when.kind === 'followup' ? (
          <span className="block min-w-0" title={`${when.day}: lo smistamento non proporrà date precedenti`}>
            <span className="flex items-center gap-1 text-xs font-medium text-amber-800"><Bell size={12} strokeWidth={2} className="shrink-0" aria-hidden />Rientro</span>
            <span className="block truncate text-[13px] text-ink-800">{when.day.replace(/^Rientro /, '')}</span>
          </span>
        ) : <span className="text-xs text-ink-400">—</span>}
      </td>
      <td>
        {appt.phone ? (
          <span className="block truncate num text-xs text-ink-800" title={appt.phone}><Hl text={formatPhone(appt.phone)} q={q} /></span>
        ) : phoneMissing(appt) ? (
          <span className="chip chip-warn" title="Senza telefono il pilota non può chiamare">
            <PhoneOff size={12} strokeWidth={2} aria-hidden />manca
          </span>
        ) : <span className="text-xs text-ink-400">—</span>}
      </td>
      <td className="overflow-hidden">
        <CallStatusInline appt={appt} maxAttempts={ws.maxAttempts} awaitingOutcome={ws.awaitingOutcome(appt)} />
      </td>
      <td className="!pr-2"><Actions appt={appt} ws={ws} /></td>
    </tr>
  );
};

// --- Riga compatta (pannello stretto) ---
const CompactRow: React.FC<RowCommon & { narrow: boolean }> = ({ appt, ws, q, narrow }) => {
  const tech = ws.techById(appt.technicianId);
  const selected = ws.selectedAppointmentId === appt.id;
  const when = appointmentText(appt);
  const street = shortStreet(appt);
  const place = placeLabel(appt);
  const muted = appt.status === 'cancelled' || appt.status === 'standby';
  const sep = <span className="text-ink-300" aria-hidden>·</span>;
  return (
    <li
      id={`appt-${appt.id}`}
      data-testid="pratica-row"
      data-status={appt.status}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${appt.title}, ${statusLabel(appt)}`}
      className={`prow prow-compact ${selected ? 'prow-selected' : ''} ${appt.urgent ? 'prow-urgent' : ''}`}
      {...rowHandlers(appt, ws)}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <StatusCell appt={appt} />
          <span className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${muted ? 'text-ink-600' : 'text-ink-950'} ${appt.status === 'cancelled' ? 'line-through decoration-ink-300' : ''}`} title={appt.title}>
            <Hl text={appt.title} q={q} />
          </span>
          {when.kind !== 'none' && !narrow && (
            <span className={`shrink-0 text-xs ${when.kind === 'followup' ? 'font-medium text-amber-800' : 'text-ink-700'}`}>
              {when.day}{when.time && <span className="num text-ink-500"> · {when.time}</span>}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 min-w-0 text-xs text-ink-500 whitespace-nowrap overflow-hidden [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]">
          {narrow && when.kind !== 'none' && (
            <><span className={`shrink-0 ${when.kind === 'followup' ? 'font-medium text-amber-800' : 'font-medium text-ink-700'}`}>{when.day}{when.time && <span className="num"> {when.time}</span>}</span>{sep}</>
          )}
          {place && <span className="shrink-0 font-medium text-ink-600"><Hl text={place} q={q} /></span>}
          {place && street && sep}
          {street && <span className="truncate min-w-[3rem]" title={appt.address}><Hl text={street} q={q} /></span>}
          {appt.periziaCode && <>{sep}<span className="num shrink-0"><Hl text={appt.periziaCode} q={q} /></span></>}
          {tech && <>{sep}<span className="inline-flex items-center gap-1 shrink-0" title={`Tecnico: ${tech.name}`}><span className="dot" style={{ backgroundColor: tech.color }} />{tech.name.split(' ')[0]}</span></>}
          {phoneMissing(appt) && <>{sep}<span className="inline-flex items-center gap-1 shrink-0 font-medium text-amber-800" title="Senza telefono il pilota non può chiamare"><PhoneOff size={12} strokeWidth={2} aria-hidden />manca tel.</span></>}
          <CallStatusInline appt={appt} maxAttempts={ws.maxAttempts} awaitingOutcome={ws.awaitingOutcome(appt)} className="ml-auto pl-2 shrink min-w-0" emptyDash={false} />
        </div>
      </div>
      <Actions appt={appt} ws={ws} />
    </li>
  );
};

interface PraticheTableProps {
  rows: Appointment[];          // già filtrate e ordinate
  ws: Workspace;
  query: string;
  sort: SortState;
  onSort: (s: SortState) => void;
}

const PraticheTable: React.FC<PraticheTableProps> = ({ rows, ws, query, sort, onSort }) => {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const layout = width ? tableLayoutFor(width) : 'compact';

  const sortMenu = (
    <Menu
      testId="pratiche-sort"
      title="Ordina l'elenco"
      ariaLabel="Ordina l'elenco"
      buttonClassName="btn btn-ghost btn-sm h-7 px-2 text-xs"
      button={<><ArrowUpDown size={13} strokeWidth={1.75} aria-hidden /> {SORT_LABELS[sort.key]} {sort.dir === 'asc' ? '↑' : '↓'}</>}
      minWidth={200}
    >
      <MenuLabel>Ordina per</MenuLabel>
      {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
        <MenuItem key={k} onSelect={() => onSort(nextSort(sort, k))} trailing={sort.key === k ? <span className="text-xs text-ink-500">{sort.dir === 'asc' ? 'crescente' : 'decrescente'}</span> : undefined}>
          <span className={sort.key === k ? 'font-semibold' : ''}>{SORT_LABELS[k]}</span>
        </MenuItem>
      ))}
      <MenuDivider />
      <MenuItem onSelect={() => onSort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}>Inverti l'ordine</MenuItem>
    </Menu>
  );

  return (
    <div ref={ref} data-testid="pratiche-table" data-layout={layout}>
      {layout === 'compact' ? (
        <div className="card overflow-clip">
          <div className="flex items-center gap-2 px-3 h-9 border-b border-line bg-slate-50/80 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-500">
            <span className="flex-1">Stato · cliente · quando</span>
            {sortMenu}
          </div>
          <ul className="divide-y divide-line" aria-label="Pratiche">
            {rows.map(a => <CompactRow key={a.id} appt={a} ws={ws} q={query} narrow={width < 520} />)}
          </ul>
        </div>
      ) : (
        <div className="card overflow-clip">
          <table className="ptable">
            <colgroup>
              {TABLE_COLUMNS.map(c => <col key={c.id} style={c.width ? { width: c.width[layout] } : undefined} />)}
            </colgroup>
            <thead>
              <tr>
                {TABLE_COLUMNS.map(c => {
                  const active = c.sortKey && sort.key === c.sortKey;
                  const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : c.sortKey ? 'none' : undefined;
                  const label = c.id === 'tecnico' && layout === 'l' ? 'Tecn.' : c.label;
                  return (
                    <th key={c.id} scope="col" aria-sort={ariaSort} className={c.id === 'azioni' ? 'text-right' : ''}>
                      {c.id === 'azioni' ? <span className="sr-only">{c.label}</span> : c.sortKey ? (
                        <button type="button" className={`th-sort ${active ? 'th-sort-active' : ''}`} onClick={() => onSort(nextSort(sort, c.sortKey!))} title={`Ordina per ${c.label.toLowerCase()}`} data-testid={`sort-${c.sortKey}`}>
                          <span className="truncate">{label}</span>
                          {active
                            ? (sort.dir === 'asc' ? <ArrowUp size={12} strokeWidth={2} aria-hidden /> : <ArrowDown size={12} strokeWidth={2} aria-hidden />)
                            : <ArrowUpDown size={12} strokeWidth={1.75} className="th-sort-idle" aria-hidden />}
                        </button>
                      ) : <span className="th-plain">{label}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map(a => <TableRow key={a.id} appt={a} ws={ws} q={query} layout={layout} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default PraticheTable;
