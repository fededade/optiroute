import React from 'react';
import {
  CalendarRange, ChevronDown, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Map as MapIcon, MapPinned, Menu as MenuIcon,
  Plug, Plus, RefreshCw, Search, Send, Settings2, Sparkles, Truck, Upload, Users, X,
} from 'lucide-react';
import type { Technician } from '../types';
import { Menu, MenuDivider, MenuItem, MenuLabel } from '../ui/Menu';
import type { ViewMode } from './types';
import { addDays, dayTitle, isoDate } from './format';

// Barra in alto: titolo della sezione, ricerca, filtro tecnico e azioni
// raggruppate in menu con voci testuali. In Agenda anche data e vista.

interface TopBarProps {
  title: string;
  subtitle?: string;
  isAgenda: boolean;
  compact: boolean;          // schermi stretti: bottoni a sola icona
  tight: boolean;            // schermi medi: niente frecce, titolo più stretto
  mobile: boolean;
  onOpenNav: () => void;

  search: string;
  onSearch: (q: string) => void;

  technicians: Technician[];
  selectedTechId: string;
  onSelectTech: (id: string) => void;
  countForTech: (id: string) => number;
  totalCount: number;
  techUnavailable: boolean;
  onOpenTech: (id?: string) => void;

  onNewPratica: () => void;
  onImportExcel: () => void;
  onImportKmz: () => void;
  bridge: { show: boolean; busy: boolean; onSync: () => void };
  pendingCount: number;
  onDispatch: () => void;
  optimizeLabel: string;
  isOptimizing: boolean;
  onOptimize: () => void;
  onExport: () => void;
  onSendReport: () => void;
  isSending: boolean;
  onSyncGestionale: () => void;
  isSyncing: boolean;
  syncHint: string;
  lastSyncInfo: string;

  currentDate: string;
  onDateChange: (d: string) => void;
  viewMode: ViewMode;
  onViewMode: (v: ViewMode) => void;

  mapVisible: boolean;
  onToggleMap: () => void;
}

const ALL = 'all';

const TopBar: React.FC<TopBarProps> = (p) => {
  const tech = p.selectedTechId !== ALL ? p.technicians.find(t => t.id === p.selectedTechId) : undefined;
  const label = (text: string) => (p.compact ? null : <span>{text}</span>);
  const chevron = p.compact || p.tight ? null : <ChevronDown size={15} strokeWidth={1.75} className="text-ink-400 -mr-1" aria-hidden />;

  const searchBox = (
    <label className="relative flex-1 min-w-[160px] max-w-[340px]">
      <span className="sr-only">Cerca</span>
      <Search size={16} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" aria-hidden />
      <input
        type="search"
        value={p.search}
        onChange={e => p.onSearch(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') p.onSearch(''); }}
        placeholder="Cerca cliente, via, codice…"
        className="input pl-9 pr-8 bg-slate-50/70 hover:bg-surface focus:bg-surface"
        data-testid="search"
      />
      {p.search && (
        <button type="button" onClick={() => p.onSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 icon-btn h-6 w-6" title="Cancella la ricerca" aria-label="Cancella la ricerca">
          <X size={14} strokeWidth={2} />
        </button>
      )}
    </label>
  );

  const techMenu = (
    <Menu
      testId="tech-filter"
      align={p.mobile ? 'start' : 'end'}
      minWidth={280}
      title="Filtra per tecnico"
      ariaLabel="Filtra per tecnico"
      buttonClassName={`btn btn-secondary btn-sm ${p.tight ? "max-w-[180px]" : "max-w-[220px]"}`}
      button={<>
        {tech ? <span className="dot" style={{ backgroundColor: tech.color }} /> : <Users size={15} strokeWidth={1.75} className="text-ink-500" aria-hidden />}
        <span className="truncate">{tech ? tech.name : 'Tutti i tecnici'}</span>
        {p.techUnavailable && <span className="dot bg-rose-500" title="Non disponibile nella data dell'agenda" />}
        <ChevronDown size={15} strokeWidth={1.75} className="text-ink-400 -mr-1" aria-hidden />
      </>}
    >
      <MenuLabel>Tecnico</MenuLabel>
      <MenuItem onSelect={() => p.onSelectTech(ALL)} icon={Users} trailing={<span className="num text-xs text-ink-500">{p.totalCount}</span>}>
        <span className={p.selectedTechId === ALL ? 'font-semibold' : ''}>Tutti i tecnici</span>
      </MenuItem>
      {p.technicians.map(t => (
        <MenuItem
          key={t.id}
          onSelect={() => p.onSelectTech(t.id)}
          trailing={<span className="num text-xs text-ink-500" title="In attesa, proposte e confermate da oggi">{p.countForTech(t.id)}</span>}
          hint={p.selectedTechId === t.id ? `${t.baseAddress ? t.baseAddress.split(',')[0] : 'Base generale'} · ${t.workStart}–${t.workEnd}` : undefined}
        >
          <span className="inline-flex items-center gap-2"><span className="dot" style={{ backgroundColor: t.color }} /><span className={p.selectedTechId === t.id ? 'font-semibold' : ''}>{t.name}</span></span>
        </MenuItem>
      ))}
      <MenuDivider />
      {tech && <MenuItem icon={Settings2} onSelect={() => p.onOpenTech(tech.id)}>Apri la scheda di {tech.name.split(' ')[0]}</MenuItem>}
      <MenuItem icon={Users} onSelect={() => p.onOpenTech()}>Gestisci tecnici</MenuItem>
    </Menu>
  );

  const mapButton = !p.mapVisible && (
    <button type="button" onClick={p.onToggleMap} className={p.compact ? 'icon-btn h-9 w-9 shrink-0 border border-line bg-surface' : 'btn btn-secondary btn-sm'} title="Mostra la mappa" aria-label="Mostra la mappa" data-testid="show-map">
      <MapIcon size={16} strokeWidth={1.75} aria-hidden />{label('Mappa')}
    </button>
  );

  const actions = (
    <div className="flex items-center gap-1.5 shrink-0">
      <Menu
        testId="menu-importa"
        title="Importa pratiche"
        ariaLabel="Importa"
        buttonClassName={p.compact ? 'icon-btn h-9 w-9 border border-line bg-surface' : 'btn btn-secondary btn-sm'}
        button={<><Upload size={16} strokeWidth={1.75} aria-hidden />{label('Importa')}{chevron}</>}
      >
        <MenuLabel>Importa pratiche</MenuLabel>
        <MenuItem icon={FileSpreadsheet} onSelect={p.onImportExcel} hint="Elenco pratiche MISI o colonne Indirizzo/Comune">Excel…</MenuItem>
        <MenuItem icon={MapPinned} onSelect={p.onImportKmz} hint="Tutti i livelli della mappa" title="Importa la mappa di Google My Maps (KMZ/KML) con tutti i livelli">Google My Maps (KMZ/KML)…</MenuItem>
        {p.bridge.show && (
          <>
            <MenuDivider />
            <MenuItem icon={Plug} onSelect={p.bridge.onSync} disabled={p.bridge.busy} title="Scarica ora le pratiche dal bridge">Scarica dal bridge ora</MenuItem>
          </>
        )}
      </Menu>
      <Menu
        testId="menu-pianifica"
        title="Pianifica i giri"
        ariaLabel="Pianifica"
        minWidth={290}
        buttonClassName={p.compact ? 'icon-btn h-9 w-9 border border-line bg-surface' : 'btn btn-secondary btn-sm'}
        button={<><Truck size={16} strokeWidth={1.75} aria-hidden />{label('Pianifica')}{chevron}</>}
      >
        <MenuLabel>Pianifica</MenuLabel>
        <MenuItem
          icon={Truck}
          onSelect={p.onDispatch}
          disabled={p.pendingCount === 0}
          hint="Propone giorno e orario per tecnico e zona"
          trailing={<span className="num text-xs text-ink-500">{p.pendingCount}</span>}
        >
          Smista pratiche per zona…
        </MenuItem>
        <MenuItem icon={Sparkles} onSelect={p.onOptimize} disabled={p.isOptimizing} hint="Ordina le tappe e ricalcola gli orari">
          {p.isOptimizing ? 'Calcolo…' : p.optimizeLabel}
        </MenuItem>
      </Menu>
      <Menu
        testId="menu-esporta"
        title="Esporta e sincronizza"
        ariaLabel="Esporta"
        minWidth={300}
        buttonClassName={p.compact ? 'icon-btn h-9 w-9 border border-line bg-surface' : 'btn btn-secondary btn-sm'}
        button={<><Download size={16} strokeWidth={1.75} aria-hidden />{label('Esporta')}{chevron}</>}
      >
        <MenuLabel>Esporta</MenuLabel>
        <MenuItem icon={FileSpreadsheet} onSelect={p.onExport} hint="Le pratiche della vista corrente">Esporta Excel</MenuItem>
        <MenuItem icon={Send} onSelect={p.onSendReport} disabled={p.isSending} hint="Planning della vista corrente">{p.isSending ? 'Invio…' : 'Invia report'}</MenuItem>
        <MenuDivider />
        <MenuItem
          icon={RefreshCw}
          onSelect={p.onSyncGestionale}
          disabled={p.isSyncing}
          title="Invia al gestionale i sopralluoghi confermati (dal cliente o senza telefono) con orario calcolato"
          hint={p.lastSyncInfo ? `Ultima: ${p.lastSyncInfo}` : p.syncHint}
        >
          {p.isSyncing ? 'Sincronizzazione…' : 'Sincronizza col gestionale'}
        </MenuItem>
      </Menu>
      <button type="button" onClick={p.onNewPratica} className={p.compact ? 'btn btn-primary btn-sm px-2.5' : 'btn btn-primary btn-sm'} title="Nuova pratica completa (cliente, telefono, urgenza)" aria-label="Nuova pratica">
        <Plus size={16} strokeWidth={2} aria-hidden />{p.compact ? null : <span>Nuova pratica</span>}
      </button>
      {!p.mobile && mapButton}
    </div>
  );

  const step = (n: number) => {
    const d = p.viewMode === 'month'
      ? (() => { const x = new Date(`${p.currentDate}T00:00:00`); x.setMonth(x.getMonth() + n); return isoDate(x); })()
      : addDays(p.currentDate, p.viewMode === 'week' ? 7 * n : n);
    p.onDateChange(d);
  };

  const agendaBar = p.isAgenda && (
    <div className="flex items-center gap-2 flex-wrap px-4 md:px-6 pb-3">
      <div className="inline-flex items-center rounded-control border border-line bg-surface shadow-card">
        <button type="button" className="icon-btn h-9 rounded-r-none" onClick={() => step(-1)} title="Periodo precedente" aria-label="Periodo precedente"><ChevronLeft size={16} strokeWidth={1.75} /></button>
        <button type="button" className="h-9 px-3 text-sm font-semibold text-ink-800 hover:bg-slate-50 border-x border-line" onClick={() => p.onDateChange(isoDate(new Date()))}>Oggi</button>
        <button type="button" className="icon-btn h-9 rounded-l-none" onClick={() => step(1)} title="Periodo successivo" aria-label="Periodo successivo"><ChevronRight size={16} strokeWidth={1.75} /></button>
      </div>
      <label className="relative">
        <span className="sr-only">Data di riferimento</span>
        <CalendarRange size={15} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" aria-hidden />
        <input type="date" value={p.currentDate} onChange={e => e.target.value && p.onDateChange(e.target.value)} className="input w-[170px] pl-9 num" aria-label="Data di riferimento" />
      </label>
      <span className="text-sm text-ink-500 hidden sm:inline">{dayTitle(p.currentDate)}</span>
      <div className="seg ml-auto" role="tablist" aria-label="Vista">
        {(['day', 'week', 'month'] as ViewMode[]).map(v => (
          <button key={v} type="button" role="tab" aria-selected={p.viewMode === v} className={`seg-item ${p.viewMode === v ? 'seg-item-active' : ''}`} onClick={() => p.onViewMode(v)}>
            {v === 'day' ? 'Giorno' : v === 'week' ? 'Settimana' : 'Mese'}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <header className="bg-surface border-b border-line shrink-0 relative z-[30]">
      <div className="flex items-center gap-3 px-4 md:px-6 min-h-[60px] py-2 flex-wrap">
        {p.mobile && (
          <button type="button" className="icon-btn -ml-1" onClick={p.onOpenNav} title="Apri il menu" aria-label="Apri il menu">
            <MenuIcon size={20} strokeWidth={1.75} />
          </button>
        )}
        <div className={`min-w-0 flex-1 md:flex-none md:shrink-0 ${p.tight ? "md:w-[176px]" : "md:w-[210px]"}`}>
          <h1 className="page-title truncate leading-tight" data-testid="page-title">{p.title}</h1>
          {p.subtitle && <p className="text-xs text-ink-500 truncate">{p.subtitle}</p>}
        </div>
        {!p.mobile && searchBox}
        {!p.mobile && techMenu}
        <div className="md:ml-auto">{actions}</div>
        {p.mobile && (
          <div className="flex items-center gap-2 w-full">
            {searchBox}
            {techMenu}
            {mapButton}
          </div>
        )}
      </div>
      {agendaBar}
    </header>
  );
};

export default TopBar;
