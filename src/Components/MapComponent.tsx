import React, { useEffect, useState } from 'react';
import { Bell, Check, Clock, Hash, House, MapPin, PauseCircle, Phone, Sparkles } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline } from 'react-leaflet';
import * as L from 'leaflet';
import type { Appointment, Coordinates, RouteSummary, AppointmentStatus, Technician } from '../types';
import { getFullRouteGeometry } from '../services/routingService';

const iconUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png';
const iconRetinaUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png';
const shadowUrl = 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
    iconUrl: iconUrl,
    iconRetinaUrl: iconRetinaUrl,
    shadowUrl: shadowUrl,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41]
});

L.Marker.prototype.options.icon = DefaultIcon;

const DATE_COLORS = [
    '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981',
    '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#f43f5e'
];

const getColorForDate = (dateStr?: string): string => {
    if (!dateStr) return '#3b82f6';
    let hash = 0;
    for (let i = 0; i < dateStr.length; i++) {
        hash = dateStr.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % DATE_COLORS.length;
    return DATE_COLORS[index];
};

// Segnaposto della scheda selezionata: anello oro (colore del marchio)
const SELECTED_RING = 'box-shadow: 0 0 0 3px #fff, 0 0 0 6px #DDAE49, 0 4px 10px rgba(18,20,26,0.35);';
const BASE_SHADOW = 'box-shadow: 0 1px 3px rgba(18,20,26,0.35);';

// Bordo rosso spesso per le pratiche urgenti, tratteggiato per le proposte
const markerBorder = (urgent?: boolean, proposed?: boolean): string => {
  const color = urgent ? '#e11d48' : 'white';
  const style = proposed ? 'dashed' : 'solid';
  const width = urgent ? '3px' : '2px';
  return `border: ${width} ${style} ${color};`;
};

const createScheduledIcon = (number: number, color: string, urgent?: boolean, proposed?: boolean, selected?: boolean) => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: ${color}; ${proposed ? 'opacity: 0.88;' : ''} width: 28px; height: 28px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; font-weight: 600; font-family: 'JetBrains Mono', ui-monospace, monospace; ${markerBorder(urgent, proposed)} ${selected ? SELECTED_RING : BASE_SHADOW} font-size: 13px;">${number || '?'}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -10]
  });
};

const createPendingIcon = (urgent?: boolean, selected?: boolean) => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: ${urgent ? '#e11d48' : '#f59e0b'}; width: 24px; height: 24px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid white; ${selected ? SELECTED_RING : BASE_SHADOW}">
      ${urgent
        ? `<span style="font-weight:bold; font-size: 13px;">!</span>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z" clip-rule="evenodd" /></svg>`}
    </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -10]
  });
};

const createIssueIcon = (selected?: boolean) => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: #e11d48; width: 24px; height: 24px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid white; ${selected ? SELECTED_RING : BASE_SHADOW}"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -10]
  });
};

const createCancelledIcon = (selected?: boolean) => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: #94a3b8; opacity: 0.85; width: 18px; height: 18px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid white; ${selected ? SELECTED_RING : BASE_SHADOW}"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -8]
  });
};

const createStandbyIcon = (selected?: boolean) => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: #64748b; width: 20px; height: 20px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid white; ${selected ? SELECTED_RING : BASE_SHADOW}">
       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path fill-rule="evenodd" d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z" clip-rule="evenodd" /></svg>
    </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10]
  });
};

const createBaseIcon = (color: string = '#1B1E26') => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: ${color}; width: 30px; height: 30px; border-radius: 9px; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid white; ${BASE_SHADOW}">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M11.47 3.84a.75.75 0 0 1 1.06 0l8.632 8.632a.75.75 0 0 1-1.06 1.06l-.353-.353v6.321a2.25 2.25 0 0 1-2.25 2.25H13.5a.75.75 0 0 1-.75-.75V15a.75.75 0 0 0-.75-.75h-2.25a.75.75 0 0 0-.75.75v5.25a.75.75 0 0 1-.75.75H4.5A2.25 2.25 0 0 1 2.25 19.5V9.18l-.353.353a.75.75 0 0 1-1.06-1.06l8.632-8.632Z" /></svg>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -34]
  });
};

interface MapComponentProps {
  appointments: Appointment[];
  center: Coordinates;
  routeSummary?: RouteSummary | null;
  baseLocation?: { coords: Coordinates; address: string } | null;
  technicians?: Technician[];
  onSelectAppointment: (id: string) => void;
  onStatusChange: (id: string, status: AppointmentStatus) => void;
  onRequestCall?: (id: string) => void;
  selectedId?: string | null;   // scheda selezionata: segnaposto evidenziato
}

// La mappa si adatta quando il suo riquadro cambia misura (divisore,
// mappa nascosta/mostrata, barra laterale richiusa)
const AutoResize: React.FC = () => {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
};

const ChangeView: React.FC<{ center: Coordinates; zoom: number }> = ({ center, zoom }) => {
  const map = useMap();
  useEffect(() => {
    map.setView([center.lat, center.lng], zoom);
  }, [center, zoom, map]);
  return null;
};

const FitBounds: React.FC<{ appointments: Appointment[]; baseLocation?: any }> = ({ appointments, baseLocation }) => {
  const map = useMap();
  useEffect(() => {
    const points: [number, number][] = appointments.map(a => [a.coords.lat, a.coords.lng]);
    if (baseLocation) {
      points.push([baseLocation.coords.lat, baseLocation.coords.lng]);
    }

    if (points.length > 1) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [appointments, baseLocation, map]);
  return null;
};

interface TechRoute {
  key: string;
  color: string;
  positions: [number, number][];
  dashed: boolean;
}

const MapComponent: React.FC<MapComponentProps> = ({
  appointments,
  center,
  routeSummary,
  baseLocation,
  technicians = [],
  onSelectAppointment,
  onStatusChange,
  onRequestCall,
  selectedId,
}) => {
  const [techRoutes, setTechRoutes] = useState<TechRoute[]>([]);

  const techById = (id?: string): Technician | undefined =>
    id ? technicians.find(t => t.id === id) : undefined;

  // Colore del marker: tecnico assegnato, altrimenti colore per data (legacy)
  const colorFor = (appt: Appointment): string => {
    const tech = techById(appt.technicianId);
    if (tech) return tech.color;
    return getColorForDate(appt.date);
  };

  useEffect(() => {
    let cancelled = false;

    const fetchRoutes = async () => {
      // Percorsi separati per (tecnico, giorno): ogni tecnico parte dalla
      // propria base (se impostata), altrimenti dalla base generale.
      const scheduled = appointments.filter(
        a => (a.status === 'confirmed' || a.status === 'proposed') && a.date
      );

      const groups = new Map<string, Appointment[]>();
      for (const a of scheduled) {
        const key = `${a.technicianId || 'none'}|${a.date}|${a.status === 'proposed' ? 'p' : 'c'}`;
        const g = groups.get(key) || [];
        g.push(a);
        groups.set(key, g);
      }

      const results: TechRoute[] = [];

      for (const [key, group] of groups) {
        if (group.length < 1) continue;
        const sorted = [...group].sort((a, b) => (a.sequenceOrder || 999) - (b.sequenceOrder || 999));

        const [techId, , statusFlag] = key.split('|');
        const tech = techById(techId !== 'none' ? techId : undefined);
        const startCoords = tech?.baseCoords || baseLocation?.coords;

        const waypoints: Coordinates[] = [];
        if (startCoords) waypoints.push(startCoords);
        sorted.forEach(a => waypoints.push(a.coords));

        if (waypoints.length < 2) continue;

        let positions: [number, number][] | null = null;
        try {
          positions = await getFullRouteGeometry(waypoints);
        } catch {
          positions = null;
        }
        if (!positions || positions.length === 0) {
          positions = waypoints.map(w => [w.lat, w.lng] as [number, number]);
        }

        results.push({
          key,
          color: tech?.color || '#6366f1',
          positions,
          dashed: statusFlag === 'p',
        });

        if (cancelled) return;
      }

      if (!cancelled) setTechRoutes(results);
    };

    fetchRoutes();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointments, baseLocation, technicians]);

  const getIcon = (appt: Appointment) => {
    const selected = appt.id === selectedId;
    if (appt.status === 'confirmed' || appt.status === 'proposed') {
        return createScheduledIcon(
          appt.sequenceOrder || 0,
          colorFor(appt),
          appt.urgent,
          appt.status === 'proposed',
          selected
        );
    } else if (appt.status === 'standby') {
        return createStandbyIcon(selected);
    } else if (appt.status === 'issue') {
        return createIssueIcon(selected);
    } else if (appt.status === 'cancelled') {
        return createCancelledIcon(selected);
    } else {
        return createPendingIcon(appt.urgent, selected);
    }
  };

  const statusLabel = (s: AppointmentStatus): string =>
    s === 'confirmed' ? 'Confermato' : s === 'proposed' ? 'Proposto' : s === 'standby' ? 'Stand-by'
      : s === 'issue' ? 'Problematica' : s === 'cancelled' ? 'Annullata' : 'In attesa';

  const issueLabel = (t?: string): string =>
    t === 'wrong_phone' ? 'Numero non corretto'
      : t === 'works_pending' ? 'Lavori da ultimare'
      : 'Da richiamare';

  const statusChip = (s: AppointmentStatus): string =>
    s === 'confirmed' ? 'chip-success' : s === 'proposed' ? 'chip-info' : s === 'pending' ? 'chip-warn'
      : s === 'issue' ? 'chip-danger' : 'chip-neutral';

  const dayOf = (iso?: string): string =>
    iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '') : '';

  return (
    <div className="flex flex-col h-full w-full rounded-card overflow-hidden border border-line bg-surface shadow-card">
      <div className="flex-1 relative min-h-0">
        <MapContainer
          center={[center.lat, center.lng]}
          zoom={13}
          scrollWheelZoom={true}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ChangeView center={center} zoom={13} />
          <AutoResize />
          <FitBounds appointments={appointments} baseLocation={baseLocation} />

          {baseLocation && (
            <Marker
              position={[baseLocation.coords.lat, baseLocation.coords.lng]}
              icon={createBaseIcon()}
            >
              <Popup>
                <div className="map-popup">
                  <p className="eyebrow flex items-center gap-1.5"><House size={12} strokeWidth={2} aria-hidden /> Base generale</p>
                  <p className="mt-1 text-[13px] text-ink-800">{baseLocation.address}</p>
                </div>
              </Popup>
            </Marker>
          )}

          {/* Basi dei tecnici */}
          {technicians.filter(t => t.active && t.baseCoords).map(tech => (
            <Marker
              key={`base-${tech.id}`}
              position={[tech.baseCoords!.lat, tech.baseCoords!.lng]}
              icon={createBaseIcon(tech.color)}
            >
              <Popup>
                <div className="map-popup">
                  <p className="eyebrow flex items-center gap-1.5"><span className="dot" style={{ backgroundColor: tech.color }} /> Partenza di {tech.name}</p>
                  <p className="mt-1 text-[13px] text-ink-800">{tech.baseAddress}</p>
                  <p className="mt-1 text-xs text-ink-500 flex items-center gap-1"><Clock size={12} strokeWidth={1.75} aria-hidden /><span className="num">{tech.workStart}–{tech.workEnd}</span></p>
                </div>
              </Popup>
            </Marker>
          ))}

          {appointments.map((appt) => {
             const tech = techById(appt.technicianId);
             const isScheduled = appt.status === 'confirmed' || appt.status === 'proposed';
             const markerColor = isScheduled ? colorFor(appt) : '#475569';
             return (
                <Marker
                key={appt.id}
                position={[appt.coords.lat, appt.coords.lng]}
                icon={getIcon(appt)}
                eventHandlers={{
                    click: () => onSelectAppointment(appt.id)
                }}
                >
                <Popup>
                  <div className="map-popup">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {isScheduled && appt.startTime ? (
                        <span className="num text-[13px] font-semibold text-ink-900">{appt.startTime}–{appt.endTime}</span>
                      ) : (
                        <span className={`chip ${statusChip(appt.status)}`}>{appt.status === 'issue' ? issueLabel(appt.issueType) : statusLabel(appt.status)}</span>
                      )}
                      {isScheduled && appt.date && <span className="text-xs text-ink-500">{dayOf(appt.date)}</span>}
                      {appt.status === 'proposed' && <span className="chip chip-info">Da confermare</span>}
                    </div>
                    <p className="mt-1.5 text-[15px] font-semibold leading-snug text-ink-950">
                      {isScheduled && appt.sequenceOrder ? <span className="num mr-1" style={{ color: markerColor }}>{appt.sequenceOrder}.</span> : null}{appt.title}
                    </p>
                    <p className="mt-0.5 text-[13px] text-ink-500">{appt.address}</p>
                    {(appt.urgent || tech || appt.periziaCode) && (
                      <div className="mt-2 flex gap-1.5 flex-wrap">
                        {appt.urgent && <span className="chip chip-solid-danger">URGENTE</span>}
                        {tech && <span className="chip chip-neutral"><span className="dot" style={{ backgroundColor: tech.color }} />{tech.name}</span>}
                        {appt.periziaCode && <span className="chip chip-neutral num"><Hash size={11} strokeWidth={2} aria-hidden />{appt.periziaCode}</span>}
                      </div>
                    )}
                    {appt.approximate && (
                      <p className="mt-2 text-xs text-amber-800 flex items-start gap-1.5">
                        <MapPin size={13} strokeWidth={1.75} className="shrink-0 mt-px" aria-hidden />
                        Posizione approssimativa: al centro del comune (indirizzo esatto non trovato)
                      </p>
                    )}
                    {appt.phone && <p className="mt-2 text-[13px] text-ink-700 flex items-center gap-1.5"><Phone size={13} strokeWidth={1.75} className="text-ink-400" aria-hidden /><span className="num">{appt.phone}</span></p>}
                    {appt.followUpDate && appt.status === 'issue' && (
                      <p className="mt-1 text-xs font-medium text-amber-800 flex items-center gap-1.5"><Bell size={13} strokeWidth={1.75} aria-hidden />Rientra il {dayOf(appt.followUpDate)}</p>
                    )}
                    {appt.callSummary && (
                      <p className="mt-2 text-xs text-ink-600 flex items-start gap-1.5 bg-violet-50/70 border border-violet-100 rounded-lg px-2 py-1.5">
                        <Sparkles size={13} strokeWidth={1.75} className="shrink-0 mt-px text-violet-600" aria-hidden />{appt.callSummary}
                      </p>
                    )}

                    <div className="mt-3 pt-2.5 border-t border-line flex flex-wrap gap-1.5">
                        {appt.status !== 'confirmed' && (
                            <button type="button" onClick={() => onStatusChange(appt.id, 'confirmed')} className="btn btn-sm btn-primary h-7 px-2.5 text-xs">
                                <Check size={13} strokeWidth={2} aria-hidden /> Conferma
                            </button>
                        )}
                        {appt.phone && onRequestCall && (
                            <button type="button" onClick={() => onRequestCall(appt.id)} className="btn btn-sm btn-secondary h-7 px-2.5 text-xs">
                                <Phone size={13} strokeWidth={1.75} aria-hidden /> Chiama
                            </button>
                        )}
                        {appt.status !== 'pending' && (
                            <button type="button" onClick={() => onStatusChange(appt.id, 'pending')} className="btn btn-sm btn-secondary h-7 px-2.5 text-xs">
                                <Clock size={13} strokeWidth={1.75} aria-hidden /> In attesa
                            </button>
                        )}
                        {appt.status !== 'standby' && (
                            <button type="button" onClick={() => onStatusChange(appt.id, 'standby')} className="btn btn-sm btn-ghost h-7 px-2.5 text-xs">
                                <PauseCircle size={13} strokeWidth={1.75} aria-hidden /> Stand-by
                            </button>
                        )}
                    </div>
                  </div>
                </Popup>
                </Marker>
            );
          })}

          {techRoutes.map(route => (
            <Polyline
              key={route.key}
              positions={route.positions}
              color={route.color}
              weight={4}
              opacity={route.dashed ? 0.55 : 0.8}
              dashArray={route.dashed ? '8 8' : undefined}
            />
          ))}
        </MapContainer>
      </div>

      {routeSummary && (
        <div className="bg-surface border-t border-line px-4 py-3 z-10" data-testid="route-summary">
          <p className="eyebrow mb-2">Riepilogo del giro confermato</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col">
              <span className="text-xs text-ink-500">Distanza</span>
              <span className="num text-lg font-semibold text-ink-950">{routeSummary.totalDistance} <span className="text-xs font-normal text-ink-400">km</span></span>
            </div>
            <div className="flex flex-col border-l border-line pl-3">
              <span className="text-xs text-ink-500">Guida</span>
              <span className="num text-lg font-semibold text-ink-950">{routeSummary.totalTravelTime} <span className="text-xs font-normal text-ink-400">min</span></span>
            </div>
            <div className="flex flex-col border-l border-line pl-3">
              <span className="text-xs text-ink-500">Fine giornata</span>
              <span className="num text-lg font-semibold text-emerald-700">{routeSummary.finalEndTime}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MapComponent;
