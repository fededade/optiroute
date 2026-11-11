import React from 'react';
import { FileSpreadsheet, Hourglass, Loader2, Plus, Truck } from 'lucide-react';
import type { Appointment } from '../../types';
import PraticaCard from '../PraticaCard';
import { EmptyState } from '../../ui/EmptyState';
import type { Workspace } from '../types';
import { plural } from '../format';

interface PendingSectionProps {
  ws: Workspace;
  items: Appointment[];               // in attesa (filtro tecnico)
  pendingAll: number;                 // tutte le pratiche in attesa (per lo smistamento)
  addressInput: string;
  onAddressInput: (v: string) => void;
  onAddAddress: (e: React.FormEvent) => void;
  isLoading: boolean;
  onDispatch: () => void;
  onImportExcel: () => void;
  onNewPratica: () => void;
}

// Urgenti, poi rientri (con data), poi le altre
const rank = (a: Appointment) => (a.urgent ? 0 : a.followUpDate ? 1 : 2);

const PendingSection: React.FC<PendingSectionProps> = (p) => {
  const { ws } = p;
  const sorted = p.items
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || (x.a.followUpDate || '').localeCompare(y.a.followUpDate || '') || x.i - y.i)
    .map(x => x.a);
  const visible = sorted.filter(ws.matches);
  const urgent = p.items.filter(a => a.urgent).length;

  return (
    <div className="space-y-5">
      <div className="card p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="section-title">{plural(p.items.length, 'pratica da pianificare', 'pratiche da pianificare')}</p>
            <p className="text-xs text-ink-500 mt-0.5">{urgent > 0 ? `${urgent} urgenti in cima, poi i rientri e le altre` : 'Prima i rientri, poi le altre'}</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={p.onDispatch} disabled={p.pendingAll === 0} title="Smista pratiche per zona: propone giorno e orario per tecnico">
            <Truck size={15} strokeWidth={1.75} aria-hidden /> Smista per zona
          </button>
        </div>
        <form onSubmit={p.onAddAddress} className="flex gap-2">
          <label className="flex-1">
            <span className="sr-only">Aggiunta rapida per indirizzo</span>
            <input type="text" value={p.addressInput} onChange={e => p.onAddressInput(e.target.value)} placeholder="Aggiunta rapida: via, civico e comune" className="input" />
          </label>
          <button type="submit" disabled={p.isLoading} className="btn btn-secondary" title="Aggiungi da indirizzo">
            {p.isLoading ? <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <Plus size={15} strokeWidth={1.75} aria-hidden />}
            Aggiungi
          </button>
        </form>
      </div>

      {p.items.length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title="Nessuna pratica in attesa"
          action={<>
            <button type="button" className="btn btn-primary btn-sm" onClick={p.onImportExcel}><FileSpreadsheet size={15} strokeWidth={1.75} aria-hidden /> Importa Excel</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={p.onNewPratica}><Plus size={15} strokeWidth={1.75} aria-hidden /> Nuova pratica</button>
          </>}
        >
          Qui arrivano le pratiche importate o aggiunte a mano, prima di essere smistate nei giri dei tecnici.
        </EmptyState>
      ) : visible.length === 0 ? (
        <p className="text-sm text-ink-500">Nessuna pratica in attesa corrisponde alla ricerca.</p>
      ) : (
        <div className="space-y-3">
          {visible.map(a => <PraticaCard key={a.id} appt={a} ws={ws} />)}
        </div>
      )}
    </div>
  );
};

export default PendingSection;
