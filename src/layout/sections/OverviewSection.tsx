import React from 'react';
import {
  ArrowRight, BellRing, CalendarDays, CheckCircle2, FileSpreadsheet, Hourglass, MapPinned, PhoneCall, Route, Truck, type LucideIcon,
} from 'lucide-react';
import type { Appointment } from '../../types';
import type { AttentionItem, AutopilotStats } from '../../services/autopilotService';
import { isCallInFlight } from '../../services/autopilotService';
import AttentionPanel from '../../Components/AttentionPanel';
import type { SectionId, Workspace } from '../types';
import { addDays, dayTitle, plural } from '../format';
import { attentionBreakdown } from '../attentionSummary';
import { useElementWidth } from '../useUiPrefs';

interface OverviewProps {
  ws: Workspace;
  all: Appointment[];                 // già filtrate per tecnico
  pendingCount: number;
  proposedCount: number;
  proposedRoutes: number;
  stats: AutopilotStats;
  autopilotOn: boolean;
  attention: AttentionItem[];
  attentionTotal: number;             // voci + slot da riservare
  slotCount: number;                  // slot da riservare per i rientri
  onNavigate: (s: SectionId) => void;
  onOpenDay: (date: string) => void;  // agenda di quel giorno
  onOpenProposals: () => void;
  onAttentionSelect: (item: AttentionItem) => void;
  onAttentionShow: (item: AttentionItem) => void;
  onImportExcel: () => void;
  onImportKmz: () => void;
  onDispatch: () => void;
  empty: boolean;                     // nessuna pratica nell'app
}

const Tile: React.FC<{
  icon: LucideIcon; label: string; value: number | string; hint?: React.ReactNode; tone: string; onClick: () => void; testId: string; alert?: boolean;
}> = ({ icon: Icon, label, value, hint, tone, onClick, testId, alert }) => (
  <button type="button" onClick={onClick} data-testid={testId} className={`tile group ${alert ? 'tile-alert' : ''}`}>
    <span className="flex items-center gap-2 text-[13px] font-medium text-ink-600">
      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${tone}`}><Icon size={15} strokeWidth={1.75} aria-hidden /></span>
      <span className="leading-tight min-w-0">{label}</span>
      <ArrowRight size={14} strokeWidth={1.75} className="ml-auto text-ink-300 group-hover:text-ink-600 transition-colors" aria-hidden />
    </span>
    <span className="num text-[28px] leading-none font-semibold text-ink-950 mt-3">{value}</span>
    {hint && <span className="text-xs text-ink-500 mt-1.5 line-clamp-2">{hint}</span>}
  </button>
);

interface RouteCard {
  key: string;
  techId?: string;
  date: string;
  items: Appointment[];
}

// Tessera larga "Da gestire": il numero e il dettaglio per categoria
const AttentionTile: React.FC<{ total: number; parts: { key: string; text: string }[]; onClick: () => void }> = ({ total, parts, onClick }) => {
  const calm = total === 0;
  return (
    <button type="button" onClick={onClick} data-testid="tile-da-gestire" className={`tile-wide group h-full ${calm ? '' : 'tile-alert bg-gradient-to-br from-rose-50/70 to-surface'}`}>
      <span className="flex items-center gap-2 text-[13px] font-medium text-ink-600">
        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${calm ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
          {calm ? <CheckCircle2 size={15} strokeWidth={1.75} aria-hidden /> : <BellRing size={15} strokeWidth={1.75} aria-hidden />}
        </span>
        <span className="leading-tight min-w-0">Da gestire</span>
        <ArrowRight size={14} strokeWidth={1.75} className="ml-auto text-ink-300 group-hover:text-ink-600 transition-colors" aria-hidden />
      </span>
      <span className="mt-3 flex items-baseline gap-2.5 flex-wrap">
        <span className={`num text-[28px] leading-none font-semibold ${calm ? 'text-ink-950' : 'text-rose-700'}`}>{total}</span>
        <span className="text-xs text-ink-500">{calm ? 'Niente in sospeso' : total === 1 ? 'richiede una decisione' : 'richiedono una decisione'}</span>
      </span>
      {calm ? (
        <span className="text-xs text-ink-500 mt-1.5">Il pilota sta lavorando da solo.</span>
      ) : (
        <span className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-ink-700" data-testid="tile-da-gestire-detail">
          {parts.map(part => (
            <span key={part.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className={`dot h-1.5 w-1.5 ${part.key === 'slot' ? 'bg-amber-500' : 'bg-rose-400'}`} aria-hidden />{part.text}
            </span>
          ))}
        </span>
      )}
    </button>
  );
};

const OverviewSection: React.FC<OverviewProps> = (p) => {
  const { ws } = p;
  const [tilesRef, tilesW] = useElementWidth<HTMLDivElement>();
  // Colonne decise dallo spazio reale: 6 (Da gestire largo 2 + 4 tessere),
  // 4 (Da gestire su tutta la riga + 4) o 2 (Da gestire + 2×2): mai buchi
  const cols = tilesW >= 980 ? 6 : tilesW >= 600 ? 4 : 2;
  const wideSpan = cols === 6 ? 2 : cols;
  const now = new Date();
  const today = ws.todayStr;
  const in7 = addDays(today, 7);
  const confirmedToday = p.all.filter(a => a.status === 'confirmed' && a.date === today).length;
  const confirmedWeek = p.all.filter(a => a.status === 'confirmed' && !!a.date && a.date > today && a.date <= in7).length;

  // Prossimi giri: per tecnico e giorno, da oggi in poi
  const routes: RouteCard[] = (() => {
    const map = new Map<string, RouteCard>();
    for (const a of p.all) {
      if ((a.status !== 'confirmed' && a.status !== 'proposed') || !a.date || a.date < today) continue;
      const key = `${a.technicianId || 'none'}|${a.date}`;
      const r = map.get(key) || { key, techId: a.technicianId, date: a.date, items: [] };
      r.items.push(a);
      map.set(key, r);
    }
    return Array.from(map.values())
      .map(r => ({ ...r, items: r.items.sort((x, y) => (x.startTime || '').localeCompare(y.startTime || '')) }))
      .sort((x, y) => x.date.localeCompare(y.date) || (x.techId || '').localeCompare(y.techId || ''));
  })();

  if (p.empty) {
    const steps = [
      { n: 1, title: 'Importa le pratiche', text: 'Carica l\'elenco Excel delle pratiche o la mappa di Google My Maps.', action: (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={p.onImportExcel}><FileSpreadsheet size={15} strokeWidth={1.75} aria-hidden /> Importa Excel</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={p.onImportKmz}><MapPinned size={15} strokeWidth={1.75} aria-hidden /> Google My Maps</button>
        </div>
      ) },
      { n: 2, title: 'Smista per zona', text: 'OptiRoute propone giorno e orario a ogni tecnico, secondo la sua zona.', action: (
        <button type="button" className="btn btn-secondary btn-sm" onClick={p.onDispatch} disabled={p.pendingCount === 0}><Truck size={15} strokeWidth={1.75} aria-hidden /> Smista pratiche per zona</button>
      ) },
      { n: 3, title: 'Approva e chiama', text: 'Controlla i giri proposti: il pilota automatico chiama i clienti per confermare.', action: (
        <button type="button" className="btn btn-secondary btn-sm" onClick={p.onOpenProposals}><Route size={15} strokeWidth={1.75} aria-hidden /> Vai alle proposte</button>
      ) },
    ];
    return (
      <div className="card p-6 md:p-8">
        <p className="eyebrow text-brand-700">Benvenuto in OptiRoute</p>
        <h2 className="text-2xl font-semibold tracking-tight text-ink-950 mt-1">Organizza i sopralluoghi in tre passi</h2>
        <p className="text-sm text-ink-500 mt-1.5 max-w-xl">Non ci sono ancora pratiche. Parti dall'import: il resto lo prepara OptiRoute, tu approvi.</p>
        <ol className="mt-6 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {steps.map(s => (
            <li key={s.n} className="rounded-card border border-line p-4 flex flex-col gap-2 bg-slate-50/50">
              <span className="num inline-flex h-7 w-7 items-center justify-center rounded-full bg-ink-900 text-white text-sm font-semibold">{s.n}</span>
              <p className="text-sm font-semibold text-ink-950">{s.title}</p>
              <p className="text-[13px] text-ink-500 leading-relaxed flex-1">{s.text}</p>
              <div className="pt-1">{s.action}</div>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const shownRoutes = routes.slice(0, 8);

  return (
    <div className="space-y-8">
      <div ref={tilesRef} className="ov-tiles" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        <div style={{ gridColumn: `span ${wideSpan} / span ${wideSpan}` }}>
          <AttentionTile total={p.attentionTotal} parts={attentionBreakdown(p.attention, p.slotCount)} onClick={() => p.onNavigate('da-gestire')} />
        </div>
        <Tile testId="tile-in-attesa" icon={Hourglass} tone="bg-amber-50 text-amber-700" label="In attesa" value={p.pendingCount} hint="da pianificare" onClick={() => p.onNavigate('in-attesa')} />
        <Tile testId="tile-proposte" icon={Route} tone="bg-sky-50 text-sky-700" label="Proposte" value={p.proposedCount} hint={`da approvare · ${plural(p.proposedRoutes, 'giro', 'giri')}`} onClick={() => p.onNavigate('proposte')} />
        <Tile testId="tile-chiamate" icon={PhoneCall} tone="bg-violet-50 text-violet-700" label="Chiamate" value={p.stats.queued} hint={<>in coda · <span className="num">{p.stats.inFlight}</span> in corso{p.autopilotOn ? '' : ' · pilota spento'}</>} onClick={() => p.onNavigate('proposte')} />
        <Tile testId="tile-confermate" icon={CalendarDays} tone="bg-emerald-50 text-emerald-700" label="Confermate oggi" value={confirmedToday} hint={<><span className="num">{confirmedWeek}</span> nei prossimi 7 giorni</>} onClick={() => p.onOpenDay(today)} />
      </div>

      <section>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="section-title">Prossimi giri</h3>
          <span className="num text-xs text-ink-500">{routes.length}</span>
          <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => p.onNavigate('agenda')}>Apri agenda <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></button>
        </div>
        {shownRoutes.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-ink-500 flex items-center gap-3 flex-wrap">
            <Route size={18} strokeWidth={1.75} className="text-ink-400" aria-hidden />
            <span className="flex-1 min-w-[200px]">Nessun giro in programma da oggi in poi. Smista le pratiche in attesa per creare i giri.</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={p.onDispatch} disabled={p.pendingCount === 0}><Truck size={15} strokeWidth={1.75} aria-hidden /> Smista per zona</button>
          </div>
        ) : (
          <div className="route-cards">
            {shownRoutes.map(r => {
              const tech = ws.techById(r.techId);
              const color = tech?.color || '#646A7B';
              const confirmed = r.items.filter(a => a.status === 'confirmed').length;
              const calling = r.items.filter(a => a.status === 'proposed' && (!!a.autoCall || isCallInFlight(a, now))).length;
              const toCall = r.items.length - confirmed - calling;
              const first = r.items.find(a => a.startTime)?.startTime;
              const last = [...r.items].reverse().find(a => a.endTime)?.endTime;
              const hasProposed = r.items.some(a => a.status === 'proposed');
              const pct = (n: number) => `${(n / r.items.length) * 100}%`;
              return (
                <button
                  type="button"
                  key={r.key}
                  className="card card-hover text-left p-4 relative overflow-hidden"
                  onClick={() => (hasProposed ? p.onOpenProposals() : p.onOpenDay(r.date))}
                  title={hasProposed ? 'Apri le proposte' : 'Apri l\'agenda di quel giorno'}
                >
                  <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} aria-hidden />
                  <span className="flex items-center gap-2">
                    <span className="dot" style={{ backgroundColor: color }} />
                    <span className="text-[13px] font-semibold text-ink-900 truncate">{tech?.name || 'Senza tecnico'}</span>
                    {r.date === today && <span className="chip chip-brand ml-auto">Oggi</span>}
                  </span>
                  <span className="block mt-2 text-[15px] font-semibold text-ink-950">{dayTitle(r.date)}</span>
                  <span className="block mt-0.5 text-xs text-ink-500">
                    {plural(r.items.length, 'tappa', 'tappe')}{first && last ? <> · <span className="num">{first}–{last}</span></> : null}
                  </span>
                  <span className="mt-3 flex h-1.5 rounded-full overflow-hidden bg-slate-100" aria-hidden>
                    <span className="bg-emerald-500" style={{ width: pct(confirmed) }} />
                    <span className="bg-violet-500" style={{ width: pct(calling) }} />
                    <span className="bg-sky-300" style={{ width: pct(toCall) }} />
                  </span>
                  <span className="mt-2 flex items-center gap-3 text-2xs text-ink-500 flex-wrap">
                    <span className="inline-flex items-center gap-1"><span className="dot bg-emerald-500" /><span className="num">{confirmed}</span> confermate</span>
                    {calling > 0 && <span className="inline-flex items-center gap-1"><span className="dot bg-violet-500" /><span className="num">{calling}</span> in chiamata</span>}
                    {toCall > 0 && <span className="inline-flex items-center gap-1"><span className="dot bg-sky-300" /><span className="num">{toCall}</span> da chiamare</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {routes.length > shownRoutes.length && (
          <p className="mt-2 text-xs text-ink-500">{routes.length - shownRoutes.length === 1 ? 'e un altro giro' : `e altri ${routes.length - shownRoutes.length} giri`} in agenda e nelle proposte.</p>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="section-title">Da gestire</h3>
          <span className="num text-xs text-ink-500">{p.attentionTotal}</span>
          {p.attentionTotal > 0 && <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={() => p.onNavigate('da-gestire')}>Vedi tutto <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></button>}
        </div>
        {p.attention.length > 0 ? (
          <AttentionPanel items={p.attention} limit={4} onSelect={p.onAttentionSelect} onShow={p.onAttentionShow} />
        ) : (
          <div className="card px-5 py-4 text-sm text-ink-500">
            {p.attentionTotal > 0 ? 'Ci sono slot da riservare per i rientri: aprili in "Da gestire".' : 'Niente da gestire: il pilota sta lavorando da solo.'}
          </div>
        )}
      </section>
    </div>
  );
};

export default OverviewSection;
