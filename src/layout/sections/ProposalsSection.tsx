import React from 'react';
import { ArrowRightLeft, Bot, Check, CircleSlash, Phone, PhoneCall, Route, Truck } from 'lucide-react';
import type { Appointment } from '../../types';
import RouteTimeline from '../RouteTimeline';
import { EmptyState } from '../../ui/EmptyState';
import type { Workspace } from '../types';
import { dayTitle, plural } from '../format';

interface ProposalsSectionProps {
  ws: Workspace;
  items: Appointment[];   // tutte le proposte (filtro tecnico)
  groups: { techId?: string; date: string; items: Appointment[] }[];
  autopilotOn: boolean;
  hideEnableCallout?: boolean;
  queuedCount: number;
  approvableIds: (items: Appointment[]) => string[];
  onApproveAndCall: (ids: string[]) => void;
  onCancelQueued: () => void;
  onConfirmDay: (techId: string | undefined, date: string) => void;
  pendingCount: number;
  onDispatch: () => void;
  onEnableAutopilot: () => void;   // stesso percorso del bottone "Attiva" della striscia
}

const ProposalsSection: React.FC<ProposalsSectionProps> = (p) => {
  const { ws } = p;

  if (p.items.length === 0) {
    return (
      <EmptyState
        icon={Route}
        title="Nessun giro da approvare"
        action={<button type="button" className="btn btn-primary btn-sm" onClick={p.onDispatch} disabled={p.pendingCount === 0}><Truck size={15} strokeWidth={1.75} aria-hidden /> Smista pratiche per zona</button>}
      >
        Lo smistamento propone giorno e orario per ogni tecnico. Qui li controlli, li riordini e li approvi: il pilota chiama i clienti per confermare.
      </EmptyState>
    );
  }

  const approvableAll = p.autopilotOn ? p.approvableIds(p.items) : [];
  const anyPhone = p.items.some(a => a.phone);

  return (
    <div className="space-y-5">
      {!p.autopilotOn && !p.hideEnableCallout && (
        <div className="callout bg-violet-50 border-violet-200 text-violet-950 items-center flex-wrap" data-testid="autopilot-off-callout">
          <Bot size={18} strokeWidth={1.75} className="shrink-0 text-violet-700" aria-hidden />
          <span className="flex-1 min-w-[220px]">Il pilota automatico è spento: accendilo per approvare i giri e far partire da sole le chiamate di conferma.</span>
          <button type="button" className="btn btn-sm bg-violet-600 text-white hover:bg-violet-700" onClick={p.onEnableAutopilot}>
            Attiva il pilota
          </button>
        </div>
      )}
      <div className="card p-4">
        <p className="section-title">{plural(p.items.length, 'tappa proposta', 'tappe proposte')} in {plural(p.groups.length, 'giro', 'giri')}</p>
        <p className="text-xs text-ink-500 mt-0.5 flex items-center gap-1.5">
          <ArrowRightLeft size={13} strokeWidth={1.75} className="shrink-0" aria-hidden /> Trascina una tappa per riordinare il giro: gli orari si ricalcolano subito.
        </p>
        {(approvableAll.length > 0 || anyPhone || (p.autopilotOn && p.queuedCount > 0)) && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {approvableAll.length > 0 && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => p.onApproveAndCall(p.items.map(a => a.id))} title="Approva tutti i giri proposti: il pilota automatico chiamerà i clienti nella fascia oraria">
                <PhoneCall size={15} strokeWidth={1.75} aria-hidden /> Approva e chiama tutti i giri
              </button>
            )}
            {anyPhone && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => ws.onBulkCall(p.items)} title="Avvia la chiamata AI di conferma per tutte le proposte con telefono">
                <Phone size={15} strokeWidth={1.75} aria-hidden /> Chiama tutte
              </button>
            )}
            {p.autopilotOn && p.queuedCount > 0 && (
              <button type="button" className="btn btn-ghost btn-sm text-violet-800" onClick={p.onCancelQueued} title="Toglie dalla coda del pilota le chiamate non ancora partite">
                <CircleSlash size={15} strokeWidth={1.75} aria-hidden /> Annulla chiamate in coda ({p.queuedCount})
              </button>
            )}
          </div>
        )}
      </div>

      {p.groups.map(group => {
        const tech = ws.techById(group.techId);
        const color = tech?.color || '#646A7B';
        const visible = group.items.filter(ws.matches);
        if (visible.length === 0) return null;
        const approvable = p.autopilotOn ? p.approvableIds(group.items) : [];
        const first = group.items[0]?.startTime;
        const last = group.items[group.items.length - 1]?.endTime;
        return (
          <section key={`${group.techId || 'none'}-${group.date}`} className="card overflow-hidden" data-testid="route-group">
            <header className="relative px-4 py-3 border-b border-line">
              <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} aria-hidden />
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink-950">
                  <span className="dot" style={{ backgroundColor: color }} />
                  <span className="truncate">{tech ? tech.name : 'Senza tecnico'}</span>
                  <span className="text-ink-300">·</span>
                  <span>{dayTitle(group.date)}</span>
                </p>
                <p className="text-xs text-ink-500 mt-0.5">
                  {plural(group.items.length, 'tappa', 'tappe')}{first && last ? <> · <span className="num">{first}–{last}</span></> : null}
                  {approvable.length > 0 && <> · <span className="text-violet-700">{plural(approvable.length, 'cliente da chiamare', 'clienti da chiamare')} per confermare il giro</span></>}
                </p>
              </div>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                {approvable.length > 0 && (
                  <button type="button" className="btn btn-accent btn-sm" onClick={() => p.onApproveAndCall(group.items.map(a => a.id))} title="Approva il giro: il pilota automatico chiamerà i clienti uno dopo l'altro">
                    <PhoneCall size={15} strokeWidth={1.75} aria-hidden /> Approva e chiama
                  </button>
                )}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => p.onConfirmDay(group.techId, group.date)} title="Conferma tutte le proposte di questa giornata">
                  <Check size={15} strokeWidth={1.75} aria-hidden /> Conferma giornata
                </button>
                {group.items.some(a => a.phone) && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => ws.onBulkCall(group.items)} title="Chiama tutte le proposte di questa giornata (AI)">
                    <Phone size={15} strokeWidth={1.75} aria-hidden /> Chiama tutte
                  </button>
                )}
              </div>
            </header>
            <div className="px-3 sm:px-4 pt-4 pb-2">
              <RouteTimeline items={visible} ws={ws} color={color} draggable={!ws.isOptimizing} dashed />
            </div>
          </section>
        );
      })}
      {p.groups.every(g => g.items.filter(ws.matches).length === 0) && (
        <p className="text-sm text-ink-500">Nessuna proposta corrisponde alla ricerca.</p>
      )}
    </div>
  );
};

export default ProposalsSection;
