import React from 'react';
import type { AttentionItem, AttentionKind } from '../services/autopilotService';

// Riquadro "Da gestire": le eccezioni che il pilota non può risolvere da
// solo, raggruppate per tipo. Un clic porta alla pratica.

const KIND_META: Record<AttentionKind, { icon: string; label: string }> = {
  esito_da_verificare: { icon: '❓', label: 'Esito da verificare' },
  chiamata_non_avviata: { icon: '⚠️', label: 'Chiamata non partita' },
  irreperibile: { icon: '📵', label: 'Non raggiungibili' },
  numero_errato: { icon: '☎️', label: 'Numero errato' },
  rifiutato: { icon: '🚫', label: 'Rifiutati dal cliente' },
  referente_senza_numero: { icon: '👤', label: 'Referente senza numero' },
  senza_telefono: { icon: '📞', label: 'Senza telefono' },
  senza_tecnico: { icon: '🧭', label: 'Senza tecnico' },
  posizione_approssimativa: { icon: '≈', label: 'Posizione approssimativa' },
};

const ORDER = Object.keys(KIND_META) as AttentionKind[];

interface AttentionPanelProps {
  items: AttentionItem[];
  open: boolean;
  onToggle: () => void;
  onSelect: (item: AttentionItem) => void;
}

const AttentionPanel: React.FC<AttentionPanelProps> = ({ items, open, onToggle, onSelect }) => {
  if (items.length === 0) return null;

  return (
    <div data-testid="attention-panel" className="border border-rose-200 rounded-lg overflow-hidden bg-rose-50/40">
      <button
        onClick={onToggle}
        className="w-full px-2.5 py-1.5 flex items-center justify-between text-xs font-bold text-rose-700 uppercase tracking-wider hover:bg-rose-50"
        title={open ? 'Nascondi le cose da gestire' : 'Mostra le cose da gestire'}
      >
        <span>🛎️ Da gestire ({items.length})</span>
        <span className="normal-case font-normal text-rose-400">{open ? 'nascondi ▲' : 'mostra ▼'}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 space-y-2 max-h-64 overflow-y-auto">
          {ORDER.map(kind => {
            const group = items.filter(i => i.kind === kind);
            if (group.length === 0) return null;
            const meta = KIND_META[kind];
            return (
              <div key={kind}>
                <p className="text-[11px] font-bold text-rose-600 mb-0.5">
                  {meta.icon} {meta.label} ({group.length})
                </p>
                <div className="space-y-1">
                  {group.map(item => (
                    <button
                      key={`${item.kind}-${item.id}`}
                      onClick={() => onSelect(item)}
                      className="w-full text-left bg-white border border-rose-100 hover:border-rose-300 rounded px-2 py-1"
                      title="Apri la pratica"
                    >
                      <span className="block text-xs font-semibold text-slate-700 truncate">{item.title}</span>
                      <span className="block text-[11px] text-slate-500 line-clamp-2">{item.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AttentionPanel;
