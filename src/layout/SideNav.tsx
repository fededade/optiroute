import React from 'react';
import {
  Archive, BellRing, CalendarDays, Hourglass, LayoutDashboard, ListChecks, PanelLeftClose, PanelLeftOpen, Route, Settings,
  TriangleAlert, Users, X, type LucideIcon,
} from 'lucide-react';
import type { SectionId } from './types';

// Navigazione laterale scura: le sezioni dell'app con i contatori.

export interface NavCounts {
  pratiche: number;
  daGestire: number;
  inAttesa: number;
  proposte: number;
  agenda: number;
  problemi: number;
  archivio: number;
}

export const NAV_ITEMS: { id: SectionId; label: string; icon: LucideIcon; count?: keyof NavCounts; alert?: boolean }[] = [
  { id: 'panoramica', label: 'Panoramica', icon: LayoutDashboard },
  { id: 'pratiche', label: 'Tutte le pratiche', icon: ListChecks, count: 'pratiche' },
  { id: 'da-gestire', label: 'Da gestire', icon: BellRing, count: 'daGestire', alert: true },
  { id: 'in-attesa', label: 'In attesa', icon: Hourglass, count: 'inAttesa' },
  { id: 'proposte', label: 'Proposte', icon: Route, count: 'proposte' },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays, count: 'agenda' },
  { id: 'problemi', label: 'Problemi', icon: TriangleAlert, count: 'problemi' },
  { id: 'archivio', label: 'Archivio', icon: Archive, count: 'archivio' },
];

interface SideNavProps {
  section: SectionId;
  counts: NavCounts;
  collapsed: boolean;
  mobile: boolean;        // telefono: barra a scomparsa
  mobileOpen: boolean;
  onNavigate: (s: SectionId) => void;
  onOpenTechnicians: () => void;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
}

const SideNav: React.FC<SideNavProps> = ({ section, counts, collapsed, mobile, mobileOpen, onNavigate, onOpenTechnicians, onToggleCollapsed, onCloseMobile }) => {
  const narrow = collapsed && !mobile;

  const item = (id: SectionId | null, label: string, Icon: LucideIcon, onClick: () => void, count?: number, alert?: boolean) => {
    const active = id !== null && id === section;
    const showCount = count !== undefined && count > 0;
    return (
      <button
        key={label}
        type="button"
        onClick={onClick}
        data-testid={id ? `nav-${id}` : undefined}
        aria-current={active ? 'page' : undefined}
        title={narrow ? `${label}${showCount ? ` (${count})` : ''}` : undefined}
        aria-label={narrow ? label : undefined}
        className={`nav-item w-full ${active ? 'nav-item-active' : ''} ${narrow ? 'justify-center px-0' : ''}`}
      >
        <span className="relative shrink-0">
          <Icon size={18} strokeWidth={1.75} className={active ? 'text-brand-300' : ''} aria-hidden />
          {narrow && showCount && (
            <span className={`absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full text-[10px] leading-4 font-semibold text-center tabular-nums ${alert ? 'bg-rose-500 text-white' : 'bg-ink-600 text-white'}`}>
              {count! > 99 ? '99+' : count}
            </span>
          )}
        </span>
        {!narrow && <span className="truncate">{label}</span>}
        {!narrow && count !== undefined && (
          <span data-testid={id ? `count-${id}` : undefined} className={`nav-count ${alert && count > 0 ? 'nav-count-alert' : ''} ${count === 0 ? 'opacity-50' : ''}`}>
            {count}
          </span>
        )}
        {narrow && count !== undefined && <span data-testid={id ? `count-${id}` : undefined} className="sr-only">{count}</span>}
      </button>
    );
  };

  const nav = (
    <nav
      aria-label="Sezioni"
      className={`h-full bg-ink-900 text-white flex flex-col shrink-0 transition-[width] duration-200 ${mobile ? `w-[264px] ${mobileOpen ? 'shadow-pop' : ''}` : narrow ? 'w-[68px]' : 'w-[232px]'}`}
    >
      <div className={`h-[60px] flex items-center gap-2.5 shrink-0 ${narrow ? 'justify-center px-2' : 'px-4'}`}>
        <img src="/Logo.png" alt="" className="h-8 w-8 rounded-lg object-cover ring-1 ring-white/10 shrink-0" />
        {!narrow && (
          <div className="min-w-0 leading-tight">
            <p className="text-[15px] font-semibold tracking-tight">OptiRoute</p>
            <p className="text-2xs text-ink-400">Sopralluoghi</p>
          </div>
        )}
        {mobile && (
          <button type="button" className="ml-auto icon-btn text-ink-300 hover:bg-white/10 hover:text-white" onClick={onCloseMobile} title="Chiudi il menu" aria-label="Chiudi il menu">
            <X size={18} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div className={`flex-1 overflow-y-auto py-2 space-y-0.5 ${narrow ? 'px-2.5' : 'px-3'}`}>
        {NAV_ITEMS.map(n => item(n.id, n.label, n.icon, () => onNavigate(n.id), n.count ? counts[n.count] : undefined, n.alert))}
      </div>

      <div className={`py-3 space-y-0.5 border-t border-white/10 ${narrow ? 'px-2.5' : 'px-3'}`}>
        {item(null, 'Tecnici', Users, onOpenTechnicians)}
        {item('impostazioni', 'Impostazioni', Settings, () => onNavigate('impostazioni'))}
        {!mobile && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={`nav-item w-full text-ink-400 ${narrow ? 'justify-center px-0' : ''}`}
            title={narrow ? 'Espandi la barra' : 'Riduci la barra a sole icone'}
            aria-label={narrow ? 'Espandi la barra' : 'Riduci la barra a sole icone'}
          >
            {narrow ? <PanelLeftOpen size={18} strokeWidth={1.75} aria-hidden /> : <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden />}
            {!narrow && <span>Riduci</span>}
          </button>
        )}
      </div>
    </nav>
  );

  if (!mobile) return nav;
  return (
    <div className={`fixed inset-0 z-[1100] ${mobileOpen ? '' : 'pointer-events-none'}`} aria-hidden={!mobileOpen}>
      <div className={`absolute inset-0 bg-ink-950/50 transition-opacity ${mobileOpen ? 'opacity-100' : 'opacity-0'}`} onClick={onCloseMobile} />
      <div className={`absolute inset-y-0 left-0 transition-transform duration-200 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {nav}
      </div>
    </div>
  );
};

export default SideNav;
