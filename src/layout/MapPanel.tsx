import React, { useState } from 'react';
import { ChevronDown, EyeOff, Layers, X } from 'lucide-react';
import type { Appointment, AppointmentStatus, Coordinates, RouteSummary, Technician } from '../types';
import MapComponent from '../Components/MapComponent';
import type { MapLayers, ViewMode } from './types';
import { dayLabel, dayTitle } from './format';

// Riquadro della mappa: la mappa di sempre, con il controllo "Livelli"
// (sostituisce le vecchie caselle dei filtri di stato), la legenda dei
// tecnici e il bottone per nasconderla.

export const LAYER_META: { key: keyof MapLayers; label: string; color: string }[] = [
  { key: 'confirmed', label: 'Confermate', color: '#059669' },
  { key: 'proposed', label: 'Proposte', color: '#0284c7' },
  { key: 'pending', label: 'In attesa', color: '#f59e0b' },
  { key: 'issues', label: 'Problemi', color: '#e11d48' },
  { key: 'standby', label: 'Stand-by', color: '#64748b' },
  { key: 'cancelled', label: 'Annullate', color: '#94a3b8' },
];

interface MapPanelProps {
  appointments: Appointment[];
  center: Coordinates;
  routeSummary: RouteSummary | null;
  baseLocation: { coords: Coordinates; address: string } | null;
  technicians: Technician[];
  selectedId: string | null;
  onSelectAppointment: (id: string) => void;
  onStatusChange: (id: string, status: AppointmentStatus) => void;
  onRequestCall: (id: string) => void;
  layers: MapLayers;
  layerCounts: Record<keyof MapLayers, number>;
  onToggleLayer: (key: keyof MapLayers, value: boolean) => void;
  currentDate: string;
  viewMode: ViewMode;
  selectedTech: Technician | null;
  onHide: () => void;
  overlay: boolean;   // schermi stretti: la mappa si apre sopra l'elenco
}

const MapPanel: React.FC<MapPanelProps> = (p) => {
  const [layersOpen, setLayersOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const activeTechs = p.technicians.filter(t => t.active);
  const onCount = LAYER_META.filter(l => p.layers[l.key]).length;

  return (
    <div data-testid="map-panel" className={`relative h-full w-full ${p.overlay ? '' : ''}`}>
      <MapComponent
        appointments={p.appointments}
        center={p.center}
        routeSummary={p.routeSummary}
        baseLocation={p.baseLocation}
        technicians={p.technicians}
        onSelectAppointment={p.onSelectAppointment}
        onStatusChange={p.onStatusChange}
        onRequestCall={p.onRequestCall}
        selectedId={p.selectedId}
      />

      {/* In alto a destra: livelli e nascondi */}
      <div className="absolute top-3 right-3 z-[500] flex flex-col items-end gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setLayersOpen(o => !o)}
            className="btn btn-sm btn-secondary shadow-raised"
            aria-expanded={layersOpen}
            data-testid="map-layers"
          >
            <Layers size={15} strokeWidth={1.75} aria-hidden /> Livelli
            <span className="num text-xs text-ink-400">{onCount}/{LAYER_META.length}</span>
          </button>
          <button
            type="button"
            onClick={p.onHide}
            className="btn btn-sm btn-secondary shadow-raised"
            title={p.overlay ? 'Chiudi la mappa' : 'Nascondi la mappa: l\'elenco va a tutta larghezza'}
            aria-label={p.overlay ? 'Chiudi la mappa' : 'Nascondi mappa'}
            data-testid="hide-map"
          >
            {p.overlay ? <X size={15} strokeWidth={1.75} aria-hidden /> : <EyeOff size={15} strokeWidth={1.75} aria-hidden />}
            <span className={p.overlay ? 'sr-only sm:not-sr-only' : ''}>{p.overlay ? 'Chiudi' : 'Nascondi mappa'}</span>
          </button>
        </div>
        {layersOpen && (
          <div className="card shadow-pop p-1.5 w-[220px] animate-pop-in" role="group" aria-label="Cosa mostrare sulla mappa">
            <p className="menu-label">Mostra sulla mappa</p>
            {LAYER_META.map(l => (
              <label key={l.key} className="menu-item cursor-pointer">
                <input type="checkbox" className="checkbox" checked={p.layers[l.key]} onChange={e => p.onToggleLayer(l.key, e.target.checked)} />
                <span className="dot" style={{ backgroundColor: l.color }} />
                <span className="flex-1">{l.label}</span>
                <span className="num text-xs text-ink-500">{p.layerCounts[l.key]}</span>
              </label>
            ))}
            {p.layers.confirmed && (
              <p className="px-2.5 pt-1 pb-1.5 text-xs text-ink-500">
                Confermate: {p.viewMode === 'day' ? dayLabel(p.currentDate) : p.viewMode === 'week' ? 'settimana' : 'mese'} dell'agenda
              </p>
            )}
          </div>
        )}
      </div>

      {/* In basso a sinistra: legenda */}
      <div className={`absolute left-3 z-[500] ${p.routeSummary ? 'bottom-[92px]' : 'bottom-3'}`}>
        <div className="card shadow-raised max-w-[240px] text-xs">
          <button type="button" onClick={() => setLegendOpen(o => !o)} className="w-full flex items-center gap-2 px-3 h-8 text-left" aria-expanded={legendOpen}>
            <span className="eyebrow">Legenda</span>
            <span className="ml-auto text-ink-500 truncate">{p.viewMode === 'day' ? dayTitle(p.currentDate) : p.viewMode === 'week' ? 'Settimana' : 'Mese'}</span>
            <ChevronDown size={14} strokeWidth={1.75} className={`text-ink-400 transition-transform ${legendOpen ? '' : '-rotate-90'}`} aria-hidden />
          </button>
          {legendOpen && (
            <div className="px-3 pb-2.5 space-y-1.5 border-t border-line pt-2">
              {activeTechs.map(t => (
                <p key={t.id} className={`flex items-center gap-2 ${p.selectedTech && p.selectedTech.id !== t.id ? 'opacity-40' : ''}`}>
                  <span className="dot h-2.5 w-2.5" style={{ backgroundColor: t.color }} />
                  <span className="truncate text-ink-800">{t.name}</span>
                </p>
              ))}
              {activeTechs.length === 0 && <p className="text-ink-500">Nessun tecnico attivo</p>}
              <div className="pt-1.5 mt-1 border-t border-line space-y-1 text-ink-500">
                <p className="flex items-center gap-2"><span className="h-0 w-5 border-t-2 border-ink-500" /> Giro confermato</p>
                <p className="flex items-center gap-2"><span className="h-0 w-5 border-t-2 border-dashed border-ink-500" /> Giro proposto</p>
                {p.baseLocation && <p className="flex items-center gap-2 truncate"><span className="h-3 w-3 rounded-[4px] bg-ink-900" /> Base: {p.baseLocation.address.split(',')[0]}</p>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MapPanel;
