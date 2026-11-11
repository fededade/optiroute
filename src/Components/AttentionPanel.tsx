import React from 'react';
import {
  CircleHelp, Compass, MapPin, Phone, PhoneMissed, PhoneOff, RefreshCw, UserRound, XCircle, ArrowRight, type LucideIcon,
} from 'lucide-react';
import type { AttentionItem, AttentionKind } from '../services/autopilotService';

// "Da gestire": le eccezioni che il pilota non può risolvere da solo,
// raggruppate per tipo, ognuna con un'azione esplicita.

export const KIND_META: Record<AttentionKind, { icon: LucideIcon; label: string; tone: string }> = {
  esito_da_verificare: { icon: CircleHelp, label: 'Esito da verificare', tone: 'text-amber-700 bg-amber-50 border-amber-200' },
  chiamata_non_avviata: { icon: RefreshCw, label: 'Chiamata non partita', tone: 'text-rose-700 bg-rose-50 border-rose-200' },
  irreperibile: { icon: PhoneMissed, label: 'Non raggiungibili', tone: 'text-rose-700 bg-rose-50 border-rose-200' },
  numero_errato: { icon: PhoneOff, label: 'Numero errato', tone: 'text-rose-700 bg-rose-50 border-rose-200' },
  rifiutato: { icon: XCircle, label: 'Rifiutati dal cliente', tone: 'text-rose-700 bg-rose-50 border-rose-200' },
  referente_senza_numero: { icon: UserRound, label: 'Referente senza numero', tone: 'text-sky-700 bg-sky-50 border-sky-200' },
  senza_telefono: { icon: Phone, label: 'Senza telefono', tone: 'text-amber-700 bg-amber-50 border-amber-200' },
  senza_tecnico: { icon: Compass, label: 'Senza tecnico', tone: 'text-amber-700 bg-amber-50 border-amber-200' },
  posizione_approssimativa: { icon: MapPin, label: 'Posizione approssimativa', tone: 'text-amber-700 bg-amber-50 border-amber-200' },
};

const ORDER = Object.keys(KIND_META) as AttentionKind[];

interface AttentionPanelProps {
  items: AttentionItem[];
  onSelect: (item: AttentionItem) => void;   // "Apri pratica"
  onShow?: (item: AttentionItem) => void;    // "Mostra" nell'elenco della sua sezione
  limit?: number;                            // anteprima (Panoramica)
}

const AttentionPanel: React.FC<AttentionPanelProps> = ({ items, onSelect, onShow, limit }) => {
  if (items.length === 0) return null;
  let budget = limit ?? Infinity;

  return (
    <div data-testid="attention-panel" className="space-y-5">
      {ORDER.map(kind => {
        if (budget <= 0) return null;
        const all = items.filter(i => i.kind === kind);
        if (all.length === 0) return null;
        const group = all.slice(0, budget);
        budget -= group.length;
        const meta = KIND_META[kind];
        const Icon = meta.icon;
        return (
          <section key={kind}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-md border ${meta.tone}`}>
                <Icon size={14} strokeWidth={1.75} aria-hidden />
              </span>
              <h4 className="text-[13px] font-semibold text-ink-900">{meta.label}</h4>
              <span className="num text-xs text-ink-500">{all.length}</span>
            </div>
            <ul className="card divide-y divide-line overflow-hidden">
              {group.map(item => (
                <li key={`${item.kind}-${item.id}`} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-900 truncate">{item.title}</p>
                    <p className="text-[13px] text-ink-500 line-clamp-2">{item.detail}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {onShow && (
                      <button type="button" className="btn btn-ghost btn-sm hidden sm:inline-flex" onClick={() => onShow(item)} title="Mostra la scheda nella sua sezione">
                        Mostra
                      </button>
                    )}
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onSelect(item)} title="Apri la pratica">
                      Apri pratica <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
};

export default AttentionPanel;
