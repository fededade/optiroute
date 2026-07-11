import React, { useState } from 'react';
import type { Technician, TechnicianArea, TechnicianUnavailability } from '../types';
import { geocodeAddress } from '../services/geocodingService';
import { TECHNICIAN_COLORS } from '../services/technicianService';
import { provinceLabel } from '../utils/provinces';

// Gestione dei soggetti che effettuano i sopralluoghi: per ognuno si apre una
// scheda con zone di competenza, punto di partenza, orario di partenza e
// indisponibilità.

interface TechnicianModalProps {
  technicians: Technician[];
  onChange: (technicians: Technician[]) => void;
  onClose: () => void;
  initialOpenId?: string | null;
}

interface TechnicianFormProps {
  technician: Technician;
  onSave: (t: Technician) => void;
  onDelete: (id: string) => void;
  onCollapse: () => void;
}

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const TechnicianForm: React.FC<TechnicianFormProps> = ({ technician, onSave, onDelete, onCollapse }) => {
  const [name, setName] = useState(technician.name);
  const [color, setColor] = useState(technician.color);
  const [active, setActive] = useState(technician.active);
  const [provincesText, setProvincesText] = useState(technician.provinces.join(', '));
  const [areas, setAreas] = useState<TechnicianArea[]>(technician.areas);
  const [baseAddress, setBaseAddress] = useState(technician.baseAddress || '');
  const [workStart, setWorkStart] = useState(technician.workStart);
  const [workEnd, setWorkEnd] = useState(technician.workEnd);
  const [unavailability, setUnavailability] = useState<TechnicianUnavailability[]>(technician.unavailability);

  // Nuova zona circolare
  const [areaPlace, setAreaPlace] = useState('');
  const [areaRadius, setAreaRadius] = useState('15');
  const [isAddingArea, setIsAddingArea] = useState(false);

  // Nuova indisponibilità
  const [unavFrom, setUnavFrom] = useState('');
  const [unavTo, setUnavTo] = useState('');
  const [unavAllDay, setUnavAllDay] = useState(true);
  const [unavStart, setUnavStart] = useState('09:00');
  const [unavEnd, setUnavEnd] = useState('13:00');
  const [unavReason, setUnavReason] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const handleAddArea = async () => {
    const place = areaPlace.trim();
    const radius = parseFloat(areaRadius);
    if (!place) { setError('Indica il comune al centro della zona.'); return; }
    if (isNaN(radius) || radius <= 0) { setError('Raggio non valido.'); return; }

    setIsAddingArea(true);
    setError('');
    try {
      const result = await geocodeAddress(place);
      if (!result) {
        setError(`Comune "${place}" non trovato.`);
        return;
      }
      setAreas(prev => [...prev, {
        id: newId(),
        label: place,
        center: result.coords,
        radiusKm: radius,
      }]);
      setAreaPlace('');
    } finally {
      setIsAddingArea(false);
    }
  };

  const handleAddUnavailability = () => {
    if (!unavFrom) { setError('Indica la data di inizio indisponibilità.'); return; }
    setError('');
    setUnavailability(prev => [...prev, {
      id: newId(),
      from: unavFrom,
      to: unavTo && unavTo >= unavFrom ? unavTo : undefined,
      allDay: unavAllDay,
      startTime: unavAllDay ? undefined : unavStart,
      endTime: unavAllDay ? undefined : unavEnd,
      reason: unavReason.trim() || undefined,
    }]);
    setUnavFrom('');
    setUnavTo('');
    setUnavReason('');
  };

  const handleSave = async () => {
    if (!name.trim()) { setError('Il nome è obbligatorio.'); return; }
    setIsSaving(true);
    setError('');
    try {
      let baseCoords = technician.baseCoords;
      let finalBaseAddress: string | undefined = baseAddress.trim() || undefined;

      const baseChanged = (baseAddress.trim() || '') !== (technician.baseAddress || '');
      if (baseChanged) {
        if (!baseAddress.trim()) {
          baseCoords = undefined;
          finalBaseAddress = undefined;
        } else {
          const result = await geocodeAddress(baseAddress.trim());
          if (!result) {
            setError('Punto di partenza non trovato: verifica l\'indirizzo.');
            setIsSaving(false);
            return;
          }
          baseCoords = result.coords;
          finalBaseAddress = result.displayName;
          setBaseAddress(result.displayName);
        }
      }

      onSave({
        ...technician,
        name: name.trim(),
        color,
        active,
        provinces: provincesText.split(',').map(s => s.trim()).filter(Boolean),
        areas,
        baseAddress: finalBaseAddress,
        baseCoords,
        workStart: workStart || '08:30',
        workEnd: workEnd || '18:00',
        unavailability,
      });
      onCollapse();
    } catch (err) {
      console.error(err);
      setError('Errore durante il salvataggio.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-4">
      {/* Nome, colore, attivo */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Nome</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
            placeholder="Es. Omar Afifi"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Colore</label>
          <div className="flex gap-1.5">
            {TECHNICIAN_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded-full border-2 ${color === c ? 'border-slate-800 scale-110' : 'border-white'}`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-sm font-bold text-slate-600 pb-2 cursor-pointer">
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded" />
          Attivo
        </label>
      </div>

      {/* Zone di competenza */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
        <h4 className="text-xs font-bold text-slate-500 uppercase">Zone di competenza</h4>
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">
            Province (sigla o nome, separate da virgola)
          </label>
          <input
            type="text"
            value={provincesText}
            onChange={e => setProvincesText(e.target.value)}
            placeholder="Es. MI, Novara"
            className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-sm"
          />
          {provincesText.trim() && (
            <p className="text-[11px] text-slate-400 mt-1">
              {provincesText.split(',').map(s => s.trim()).filter(Boolean).map(provinceLabel).join(' · ')}
            </p>
          )}
        </div>

        <div>
          <label className="block text-[11px] text-slate-500 mb-1">
            Comuni entro raggio (es. "Stradella" + 15 km)
          </label>
          {areas.length > 0 && (
            <ul className="space-y-1 mb-2">
              {areas.map(area => (
                <li key={area.id} className="flex items-center justify-between text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1">
                  <span>📍 <b>{area.label}</b> — raggio {area.radiusKm} km</span>
                  <button
                    type="button"
                    onClick={() => setAreas(prev => prev.filter(a => a.id !== area.id))}
                    className="text-red-400 hover:text-red-600 font-bold px-1"
                  >✕</button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={areaPlace}
              onChange={e => setAreaPlace(e.target.value)}
              placeholder="Comune (es. Stradella)"
              className="flex-1 px-3 py-1.5 rounded-lg border border-slate-300 text-sm"
            />
            <input
              type="number"
              value={areaRadius}
              onChange={e => setAreaRadius(e.target.value)}
              min="1"
              max="200"
              className="w-20 px-2 py-1.5 rounded-lg border border-slate-300 text-sm"
              title="Raggio in km"
            />
            <button
              type="button"
              onClick={handleAddArea}
              disabled={isAddingArea}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold disabled:opacity-60"
            >
              {isAddingArea ? '...' : '+ Zona'}
            </button>
          </div>
        </div>
      </div>

      {/* Partenza e orari */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
        <h4 className="text-xs font-bold text-slate-500 uppercase">Partenza e orari</h4>
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">Punto di partenza (indirizzo)</label>
          <input
            type="text"
            value={baseAddress}
            onChange={e => setBaseAddress(e.target.value)}
            placeholder="Es. Via Roma 1, Milano (vuoto = base generale)"
            className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-sm"
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-[11px] text-slate-500 mb-1">Orario di partenza</label>
            <input type="time" value={workStart} onChange={e => setWorkStart(e.target.value)} className="w-full px-2 py-1.5 rounded-lg border border-slate-300 text-sm" />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] text-slate-500 mb-1">Fine giornata</label>
            <input type="time" value={workEnd} onChange={e => setWorkEnd(e.target.value)} className="w-full px-2 py-1.5 rounded-lg border border-slate-300 text-sm" />
          </div>
        </div>
      </div>

      {/* Indisponibilità */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
        <h4 className="text-xs font-bold text-slate-500 uppercase">Indisponibilità</h4>
        {unavailability.length > 0 && (
          <ul className="space-y-1">
            {unavailability.map(u => (
              <li key={u.id} className="flex items-center justify-between text-xs bg-amber-50 border border-amber-200 rounded px-2 py-1">
                <span>
                  🚫 {u.from}{u.to && u.to !== u.from ? ` → ${u.to}` : ''}
                  {u.allDay ? ' (tutto il giorno)' : ` ${u.startTime}-${u.endTime}`}
                  {u.reason ? ` — ${u.reason}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setUnavailability(prev => prev.filter(x => x.id !== u.id))}
                  className="text-red-400 hover:text-red-600 font-bold px-1"
                >✕</button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] text-slate-500 mb-0.5">Dal</label>
            <input type="date" value={unavFrom} onChange={e => setUnavFrom(e.target.value)} className="w-full px-2 py-1 rounded-lg border border-slate-300 text-xs" />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-0.5">Al (opzionale)</label>
            <input type="date" value={unavTo} onChange={e => setUnavTo(e.target.value)} className="w-full px-2 py-1 rounded-lg border border-slate-300 text-xs" />
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" checked={unavAllDay} onChange={e => setUnavAllDay(e.target.checked)} className="rounded" />
          Tutto il giorno
        </label>
        {!unavAllDay && (
          <div className="flex gap-2">
            <input type="time" value={unavStart} onChange={e => setUnavStart(e.target.value)} className="flex-1 px-2 py-1 rounded-lg border border-slate-300 text-xs" />
            <input type="time" value={unavEnd} onChange={e => setUnavEnd(e.target.value)} className="flex-1 px-2 py-1 rounded-lg border border-slate-300 text-xs" />
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={unavReason}
            onChange={e => setUnavReason(e.target.value)}
            placeholder="Motivo (opzionale)"
            className="flex-1 px-3 py-1 rounded-lg border border-slate-300 text-xs"
          />
          <button
            type="button"
            onClick={handleAddUnavailability}
            className="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold"
          >
            + Aggiungi
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded p-2">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Eliminare il tecnico ${technician.name}? Le pratiche assegnate torneranno "da assegnare".`)) {
              onDelete(technician.id);
            }
          }}
          className="px-3 py-2 rounded-lg border border-red-200 text-red-500 text-xs font-bold hover:bg-red-50"
        >
          Elimina
        </button>
        <button
          type="button"
          onClick={onCollapse}
          className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-white"
        >
          Annulla
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-bold"
        >
          {isSaving ? 'Salvataggio...' : 'Salva scheda'}
        </button>
      </div>
    </div>
  );
};

const TechnicianModal: React.FC<TechnicianModalProps> = ({ technicians, onChange, onClose, initialOpenId }) => {
  const [openId, setOpenId] = useState<string | null>(initialOpenId || null);

  const handleSaveTech = (updated: Technician) => {
    onChange(technicians.map(t => (t.id === updated.id ? updated : t)));
  };

  const handleDeleteTech = (id: string) => {
    onChange(technicians.filter(t => t.id !== id));
    setOpenId(null);
  };

  const handleAddTech = () => {
    const usedColors = new Set(technicians.map(t => t.color));
    const color = TECHNICIAN_COLORS.find(c => !usedColors.has(c)) || TECHNICIAN_COLORS[0];
    const tech: Technician = {
      id: newId(),
      name: 'Nuovo tecnico',
      color,
      active: true,
      provinces: [],
      areas: [],
      workStart: '08:30',
      workEnd: '18:00',
      unavailability: [],
    };
    onChange([...technicians, tech]);
    setOpenId(tech.id);
  };

  const zoneSummary = (t: Technician): string => {
    const parts: string[] = [];
    if (t.provinces.length) parts.push(t.provinces.map(provinceLabel).join(', '));
    if (t.areas.length) parts.push(t.areas.map(a => `${a.label} (${a.radiusKm} km)`).join(', '));
    return parts.join(' · ') || 'Nessuna zona configurata';
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-bold text-slate-800">👷 Tecnici e zone di competenza</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none px-1">✕</button>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Le pratiche vengono assegnate automaticamente in base a province e zone.
          Ogni scheda definisce punto di partenza, orario di partenza e indisponibilità.
        </p>

        <div className="space-y-3">
          {technicians.map(tech => (
            <div key={tech.id}>
              {openId === tech.id ? (
                <TechnicianForm
                  technician={tech}
                  onSave={handleSaveTech}
                  onDelete={handleDeleteTech}
                  onCollapse={() => setOpenId(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setOpenId(tech.id)}
                  className={`w-full text-left border rounded-xl p-3 flex items-center gap-3 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 ${tech.active ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-100 opacity-60'}`}
                >
                  <span
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0"
                    style={{ backgroundColor: tech.color }}
                  >
                    {tech.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-bold text-slate-800">
                      {tech.name} {!tech.active && <em className="text-xs font-normal text-slate-400">(non attivo)</em>}
                    </span>
                    <span className="block text-xs text-slate-500 truncate">{zoneSummary(tech)}</span>
                    <span className="block text-[11px] text-slate-400 truncate">
                      🏠 {tech.baseAddress ? tech.baseAddress.split(',')[0] : 'base generale'} · 🕒 {tech.workStart}-{tech.workEnd}
                      {tech.unavailability.length > 0 && ` · 🚫 ${tech.unavailability.length} indisponibilità`}
                    </span>
                  </span>
                  <span className="text-slate-300 text-lg">›</span>
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={handleAddTech}
          className="mt-4 w-full py-2 rounded-lg border-2 border-dashed border-indigo-200 text-indigo-600 text-sm font-bold hover:bg-indigo-50"
        >
          + Aggiungi tecnico
        </button>
      </div>
    </div>
  );
};

export default TechnicianModal;
