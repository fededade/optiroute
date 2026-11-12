import React from 'react';
import { BellRing, CalendarClock, CheckCircle2, RotateCcw } from 'lucide-react';
import type { Appointment, IssueType } from '../../types';
import type { AttentionItem } from '../../services/autopilotService';
import AttentionPanel from '../../Components/AttentionPanel';
import { EmptyState } from '../../ui/EmptyState';
import type { Workspace } from '../types';
import { dayTitle } from '../format';

const REENTRY: Record<IssueType, string> = { wrong_phone: 'ricontatto', callback: 'richiamo', works_pending: 'fine lavori' };

interface AttentionSectionProps {
  ws: Workspace;
  items: AttentionItem[];
  followUpAlerts: Appointment[];   // rientri entro domani: slot da riservare
  futureFollowUps: Appointment[];  // rientri e richieste future
  onSelect: (item: AttentionItem) => void;
  onShow: (item: AttentionItem) => void;
  onBackToPending: (id: string) => void;
  onOpenAppt: (a: Appointment) => void;
}

const AttentionSection: React.FC<AttentionSectionProps> = ({ ws, items, followUpAlerts, futureFollowUps, onSelect, onShow, onBackToPending, onOpenAppt }) => {
  const q = ws.query.trim().toLowerCase();
  const visibleItems = q ? items.filter(i => `${i.title} ${i.detail}`.toLowerCase().includes(q)) : items;
  const alerts = followUpAlerts.filter(ws.matches);
  const future = futureFollowUps.filter(ws.matches);

  if (items.length === 0 && followUpAlerts.length === 0 && futureFollowUps.length === 0) {
    return (
      <EmptyState icon={CheckCircle2} tone="success" title="Niente da gestire">
        Qui compaiono le pratiche che il pilota non può risolvere da solo (esiti da verificare, numeri errati, clienti irreperibili…) e i rientri per cui riservare uno slot.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-8">
      {(alerts.length > 0 || future.length > 0) && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border text-amber-700 bg-amber-50 border-amber-200">
              <BellRing size={14} strokeWidth={1.75} aria-hidden />
            </span>
            <h4 className="text-[13px] font-semibold text-ink-900">Slot da riservare</h4>
            <span className="num text-xs text-ink-500">{alerts.length}</span>
          </div>
          {alerts.length > 0 && (
            <>
              <ul className="card divide-y divide-line overflow-hidden">
                {alerts.map(a => {
                  const overdue = a.followUpDate! < ws.todayStr;
                  return (
                    <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="w-[92px] shrink-0">
                        <p className={`text-[13px] font-semibold ${overdue ? 'text-rose-700' : 'text-amber-800'}`}>{dayTitle(a.followUpDate)}</p>
                        {overdue && <p className="text-2xs font-semibold uppercase tracking-wide text-rose-600">scaduta</p>}
                      </div>
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenAppt(a)} title="Apri la pratica">
                        <p className="text-sm font-semibold text-ink-900 truncate">{a.title}</p>
                        <p className="text-[13px] text-ink-500 truncate">{a.status === 'pending' ? 'Richiesta del cliente' : `Rientro: ${REENTRY[a.issueType || 'callback']}`}</p>
                      </button>
                      {a.status === 'issue' && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm shrink-0"
                          onClick={() => onBackToPending(a.id)}
                          title="Rimetti tra le pratiche da pianificare (lo smistamento non proporrà date precedenti al rientro)"
                        >
                          <RotateCcw size={14} strokeWidth={1.75} aria-hidden /> Rimetti in attesa
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-ink-500">
                Tieni slot liberi in quelle date: rimetti le pratiche in attesa e pianificale con Smista o Ottimizza insieme alle ordinarie.
              </p>
            </>
          )}
          {future.length > 0 && (
            <div className={alerts.length > 0 ? 'mt-5' : ''}>
              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-700 mb-2">
                <CalendarClock size={14} strokeWidth={1.75} className="text-ink-400" aria-hidden /> Rientri e richieste future
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {future.map(a => (
                  <li key={a.id}>
                    <button type="button" className="chip chip-neutral h-7 px-2.5 hover:border-slate-300" onClick={() => onOpenAppt(a)} title="Apri la pratica">
                      <span className="font-semibold text-ink-800">{dayTitle(a.followUpDate)}</span>
                      <span className="text-ink-600 max-w-[180px] truncate">{a.title}</span>
                      {a.status === 'pending' && <span className="text-ink-400">· richiesta cliente</span>}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-500">Lo smistamento non proporrà queste pratiche prima della loro data.</p>
            </div>
          )}
        </section>
      )}

      {visibleItems.length > 0 && (
        <AttentionPanel items={visibleItems} onSelect={onSelect} onShow={onShow} />
      )}
      {q && visibleItems.length === 0 && alerts.length === 0 && future.length === 0 && (
        <p className="text-sm text-ink-500">Nessuna voce corrisponde alla ricerca.</p>
      )}
    </div>
  );
};

export default AttentionSection;
