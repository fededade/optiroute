import React, { useEffect, useState } from 'react';
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

// Bordo rosso spesso per le pratiche urgenti, tratteggiato per le proposte
const markerBorder = (urgent?: boolean, proposed?: boolean): string => {
  const color = urgent ? '#dc2626' : 'white';
  const style = proposed ? 'dashed' : 'solid';
  const width = urgent ? '3px' : '2px';
  return `border: ${width} ${style} ${color};`;
};

const createScheduledIcon = (number: number, color: string, urgent?: boolean, proposed?: boolean) => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: ${color}; ${proposed ? 'opacity: 0.85;' : ''} width: 28px; height: 28px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; font-weight: bold; ${markerBorder(urgent, proposed)} box-shadow: 0 2px 4px rgba(0,0,0,0.3); font-size: 14px;">${number || '?'}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -10]
  });
};

const createPendingIcon = (urgent?: boolean) => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: ${urgent ? '#dc2626' : '#f59e0b'}; width: 24px; height: 24px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
      ${urgent
        ? `<span style="font-weight:bold; font-size: 13px;">!</span>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z" clip-rule="evenodd" /></svg>`}
    </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -10]
  });
};

const createStandbyIcon = () => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: #94a3b8; width: 20px; height: 20px; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3"><path fill-rule="evenodd" d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z" clip-rule="evenodd" /></svg>
    </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10]
  });
};

const createBaseIcon = (color: string = '#ef4444') => {
  return L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color: ${color}; width: 32px; height: 32px; border-radius: 8px; color: white; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5"><path d="M11.47 3.84a.75.75 0 0 1 1.06 0l8.632 8.632a.75.75 0 0 1-1.06 1.06l-.353-.353v6.321a2.25 2.25 0 0 1-2.25 2.25H13.5a.75.75 0 0 1-.75-.75V15a.75.75 0 0 0-.75-.75h-2.25a.75.75 0 0 0-.75.75v5.25a.75.75 0 0 1-.75.75H4.5A2.25 2.25 0 0 1 2.25 19.5V9.18l-.353.353a.75.75 0 0 1-1.06-1.06l8.632-8.632Z" /></svg>
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
}

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
  onRequestCall
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
    if (appt.status === 'confirmed' || appt.status === 'proposed') {
        return createScheduledIcon(
          appt.sequenceOrder || 0,
          colorFor(appt),
          appt.urgent,
          appt.status === 'proposed'
        );
    } else if (appt.status === 'standby') {
        return createStandbyIcon();
    } else {
        return createPendingIcon(appt.urgent);
    }
  };

  const statusLabel = (s: AppointmentStatus): string =>
    s === 'confirmed' ? 'Confermato' : s === 'proposed' ? 'Proposto' : s === 'standby' ? 'Stand-by' : 'In attesa';

  return (
    <div className="flex flex-col h-full w-full rounded-xl overflow-hidden shadow-lg border border-slate-200 bg-white">
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
          <FitBounds appointments={appointments} baseLocation={baseLocation} />

          {baseLocation && (
            <Marker
              position={[baseLocation.coords.lat, baseLocation.coords.lng]}
              icon={createBaseIcon()}
            >
              <Popup>
                <div className="font-sans text-sm">
                  <strong className="block text-red-600">Base Generale</strong>
                  <p className="mt-1">{baseLocation.address}</p>
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
                <div className="font-sans text-sm">
                  <strong className="block" style={{ color: tech.color }}>Partenza: {tech.name}</strong>
                  <p className="mt-1">{tech.baseAddress}</p>
                  <p className="text-xs text-slate-500 mt-1">🕒 {tech.workStart} - {tech.workEnd}</p>
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
                    <div className="font-sans text-sm">
                    <div className="flex items-center justify-between mb-1 gap-2">
                            <strong className="block" style={{ color: isScheduled ? markerColor : '#475569' }}>
                                {isScheduled && appt.sequenceOrder ? `${appt.sequenceOrder}. ` : ''}{appt.title}
                            </strong>
                    </div>
                    <div className="flex gap-1 flex-wrap mb-1">
                      {appt.urgent && (
                        <span className="text-[10px] font-bold text-white bg-red-600 px-1.5 py-0.5 rounded">URGENTE</span>
                      )}
                      {appt.status === 'proposed' && (
                        <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded">
                          {statusLabel(appt.status)}: da confermare
                        </span>
                      )}
                      {tech && (
                        <span className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded" style={{ backgroundColor: tech.color }}>
                          {tech.name}
                        </span>
                      )}
                    </div>
                    <p className="mt-1">{appt.address}</p>
                    {appt.approximate && (
                      <p className="mt-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                        ≈ Posizione approssimativa: pin al centro del comune (indirizzo esatto non trovato)
                      </p>
                    )}
                    {appt.phone && <p className="mt-1 text-xs text-slate-500">📞 {appt.phone}</p>}

                    {isScheduled && appt.startTime && (
                        <div className="mt-2 text-xs bg-slate-100 p-1 rounded">
                        🕒 {appt.startTime} - {appt.endTime} <br/>
                        {appt.date && <span className="font-bold" style={{ color: markerColor }}>{appt.date}</span>}
                        </div>
                    )}

                    <div className="mt-3 pt-2 border-t border-slate-200 flex flex-wrap gap-1 justify-center">
                        {appt.status !== 'confirmed' && (
                            <button
                                onClick={() => onStatusChange(appt.id, 'confirmed')}
                                className="bg-blue-600 text-white text-[10px] px-2 py-1 rounded hover:bg-blue-700 transition-colors"
                            >
                                Conferma
                            </button>
                        )}
                        {appt.status !== 'pending' && (
                            <button
                                onClick={() => onStatusChange(appt.id, 'pending')}
                                className="bg-orange-500 text-white text-[10px] px-2 py-1 rounded hover:bg-orange-600 transition-colors"
                            >
                                In Attesa
                            </button>
                        )}
                        {appt.status !== 'standby' && (
                            <button
                                onClick={() => onStatusChange(appt.id, 'standby')}
                                className="bg-slate-500 text-white text-[10px] px-2 py-1 rounded hover:bg-slate-600 transition-colors"
                            >
                                Stand-by
                            </button>
                        )}
                        {appt.phone && onRequestCall && (
                            <button
                                onClick={() => onRequestCall(appt.id)}
                                className="bg-emerald-600 text-white text-[10px] px-2 py-1 rounded hover:bg-emerald-700 transition-colors"
                            >
                                📞 Chiama (AI)
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
        <div className="bg-white border-t border-slate-200 px-6 py-4 z-10">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Riepilogo Percorso (Confermati)</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="flex flex-col">
              <span className="text-xs text-slate-500 mb-1">Distanza Totale</span>
              <span className="text-lg md:text-xl font-bold text-slate-800">{routeSummary.totalDistance} <span className="text-sm font-normal text-slate-400">km</span></span>
            </div>
            <div className="flex flex-col border-l border-slate-100 pl-4">
              <span className="text-xs text-slate-500 mb-1">Tempo Guida</span>
              <span className="text-lg md:text-xl font-bold text-indigo-600">{routeSummary.totalTravelTime} <span className="text-sm font-normal text-slate-400">min</span></span>
            </div>
            <div className="flex flex-col border-l border-slate-100 pl-4">
              <span className="text-xs text-slate-500 mb-1">Fine Giornata</span>
              <span className="text-lg md:text-xl font-bold text-emerald-600">{routeSummary.finalEndTime}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MapComponent;
