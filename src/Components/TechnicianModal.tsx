import React, { useState } from 'react';
import type { Technician, TechnicianArea, TechnicianUnavailability } from '../types';
import { geocodeAddress } from '../services/geocodingService';
import { TECHNICIAN_COLORS } from '../services/technicianService';
import { provinceLabel } from '../utils/provinces';
import { Ban, CalendarOff, ChevronRight, CircleAlert, Clock, House, MapPin, MapPinned, Plus, Trash2, UserRound, Users, X } from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { Field, Section, Spinner, Switch, ic } from './modal/parts';

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

const initials = (name: string): string =>
  name.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();

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

  const fid = (k: string) => `tech-${technician.id}-${k}`;
  const provinceList = provincesText.split(',').map(s => s.trim()).filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Intestazione della scheda */}
      <div className="flex items-center gap-3 border-b border-line px-6 py-4 max-sm:px-4">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        >
          {initials(name || technician.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink-950">{name || technician.name}</p>
          <p className="text-xs text-ink-500">{active ? 'Attivo: riceve pratiche nello smistamento' : 'Non attivo: escluso dallo smistamento'}</p>
        </div>
        <span className={`chip ${active ? 'chip-success' : 'chip-neutral'}`}>{active ? 'Attivo' : 'Non attivo'}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-sm:px-4">
        {/* Dati */}
        <Section title="Dati" icon={UserRound}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
            <Field label="Nome" htmlFor={fid('name')}>
              <input
                id={fid('name')}
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="input"
                placeholder="Es. Omar Afifi"
              />
            </Field>
            <Field label="Colore">
              <div className="flex h-9 items-center gap-1.5">
                {TECHNICIAN_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    aria-pressed={color === c}
                    className={`h-6 w-6 rounded-full ring-offset-2 ring-offset-surface transition-shadow ${color === c ? 'ring-2 ring-ink-900' : 'hover:ring-2 hover:ring-slate-300'}`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
              </div>
            </Field>
          </div>
          <label className="mt-4 flex cursor-pointer items-center justify-between gap-3 rounded-control border border-line px-3.5 py-2.5 hover:bg-slate-50">
            <span>
              <span className="block text-sm font-medium text-ink-900">Attivo</span>
              <span className="block text-xs text-ink-500">Se spento, il tecnico non riceve nuove pratiche.</span>
            </span>
            <Switch checked={active} onChange={e => setActive(e.target.checked)} />
          </label>
        </Section>

        {/* Zone di competenza */}
        <Section title="Zone di competenza" icon={MapPinned} description="Le pratiche vengono assegnate in base a province e comuni entro un raggio.">
          <Field
            label="Province (sigla o nome, separate da virgola)"
            htmlFor={fid('provinces')}
          >
            <input
              id={fid('provinces')}
              type="text"
              value={provincesText}
              onChange={e => setProvincesText(e.target.value)}
              placeholder="Es. MI, Novara"
              className="input"
            />
          </Field>
          {provinceList.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {provinceList.map((p, i) => <span key={`${p}-${i}`} className="chip chip-neutral">{provinceLabel(p)}</span>)}
            </div>
          )}

          <div className="mt-5">
            <span className="field-label">Comuni entro raggio (es. "Stradella" + 15 km)</span>
            {areas.length > 0 && (
              <ul className="mb-2.5 divide-y divide-line overflow-hidden rounded-control border border-line">
                {areas.map(area => (
                  <li key={area.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                    <MapPin {...ic} className="shrink-0 text-ink-400" />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink-900">{area.label}</span>
                    <span className="num text-xs text-ink-500">raggio {area.radiusKm} km</span>
                    <button
                      type="button"
                      onClick={() => setAreas(prev => prev.filter(a => a.id !== area.id))}
                      className="icon-btn h-7 w-7 hover:bg-rose-50 hover:text-rose-700"
                      title={`Rimuovi ${area.label}`}
                      aria-label={`Rimuovi la zona ${area.label}`}
                    >
                      <X {...ic} size={14} />
                    </button>
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
                aria-label="Comune al centro della zona"
                className="input min-w-0 flex-1"
              />
              <div className="relative w-24 shrink-0">
                <input
                  type="number"
                  value={areaRadius}
                  onChange={e => setAreaRadius(e.target.value)}
                  min="1"
                  max="200"
                  className="input num pr-9"
                  title="Raggio in km"
                  aria-label="Raggio in km"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-400">km</span>
              </div>
              <button
                type="button"
                onClick={handleAddArea}
                disabled={isAddingArea}
                className="btn btn-secondary shrink-0"
              >
                {isAddingArea ? <Spinner /> : <Plus {...ic} />}
                Zona
              </button>
            </div>
          </div>
        </Section>

        {/* Partenza e orari */}
        <Section title="Partenza e orari" icon={Clock}>
          <Field label="Punto di partenza (indirizzo)" htmlFor={fid('base')} hint="Vuoto = base generale.">
            <input
              id={fid('base')}
              type="text"
              value={baseAddress}
              onChange={e => setBaseAddress(e.target.value)}
              placeholder="Es. Via Roma 1, Milano (vuoto = base generale)"
              className="input"
            />
          </Field>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <Field label="Orario di partenza" htmlFor={fid('start')}>
              <input id={fid('start')} type="time" value={workStart} onChange={e => setWorkStart(e.target.value)} className="input num" />
            </Field>
            <Field label="Fine giornata" htmlFor={fid('end')}>
              <input id={fid('end')} type="time" value={workEnd} onChange={e => setWorkEnd(e.target.value)} className="input num" />
            </Field>
          </div>
        </Section>

        {/* Indisponibilità */}
        <Section title="Indisponibilità" icon={CalendarOff} description="Giorni o fasce in cui il tecnico non riceve sopralluoghi.">
          {unavailability.length > 0 && (
            <ul className="mb-4 divide-y divide-amber-100 overflow-hidden rounded-control border border-amber-200 bg-amber-50/60">
              {unavailability.map(u => (
                <li key={u.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                  <Ban {...ic} className="shrink-0 text-amber-600" />
                  <span className="min-w-0 flex-1">
                    <span className="num text-ink-900">{u.from}{u.to && u.to !== u.from ? ` → ${u.to}` : ''}</span>
                    {u.allDay
                      ? <span className="ml-2 text-xs text-ink-500">(tutto il giorno)</span>
                      : <span className="num ml-2 text-xs text-ink-600">{`${u.startTime}-${u.endTime}`}</span>}
                    {u.reason && <span className="block truncate text-xs text-ink-500">{u.reason}</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => setUnavailability(prev => prev.filter(x => x.id !== u.id))}
                    className="icon-btn h-7 w-7 hover:bg-rose-50 hover:text-rose-700"
                    title="Rimuovi indisponibilità"
                    aria-label={`Rimuovi indisponibilità dal ${u.from}`}
                  >
                    <X {...ic} size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="rounded-control border border-line p-3.5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Dal" htmlFor={fid('unav-from')}>
                <input id={fid('unav-from')} type="date" value={unavFrom} onChange={e => setUnavFrom(e.target.value)} className="input num" />
              </Field>
              <Field label="Al (opzionale)" htmlFor={fid('unav-to')}>
                <input id={fid('unav-to')} type="date" value={unavTo} onChange={e => setUnavTo(e.target.value)} className="input num" />
              </Field>
            </div>
            <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm text-ink-800">
              <Switch checked={unavAllDay} onChange={e => setUnavAllDay(e.target.checked)} />
              Tutto il giorno
            </label>
            {!unavAllDay && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <input type="time" aria-label="Indisponibile dalle" value={unavStart} onChange={e => setUnavStart(e.target.value)} className="input num" />
                <input type="time" aria-label="Indisponibile fino alle" value={unavEnd} onChange={e => setUnavEnd(e.target.value)} className="input num" />
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={unavReason}
                onChange={e => setUnavReason(e.target.value)}
                placeholder="Motivo (opzionale)"
                aria-label="Motivo dell'indisponibilità"
                className="input min-w-0 flex-1"
              />
              <button
                type="button"
                onClick={handleAddUnavailability}
                className="btn btn-secondary shrink-0"
              >
                <Plus {...ic} />
                Aggiungi
              </button>
            </div>
          </div>
        </Section>

        {error && (
          <div role="alert" className="callout callout-danger mt-5">
            <CircleAlert {...ic} className="mt-0.5 shrink-0 text-rose-600" />
            <p>{error}</p>
          </div>
        )}
      </div>

      <div className="modal-footer max-sm:px-4">
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Eliminare il tecnico ${technician.name}? Le pratiche assegnate torneranno "da assegnare".`)) {
              onDelete(technician.id);
            }
          }}
          className="btn btn-danger mr-auto"
        >
          <Trash2 {...ic} />
          Elimina
        </button>
        <button type="button" onClick={onCollapse} className="btn btn-secondary">
          Annulla
        </button>
        <button type="button" onClick={handleSave} disabled={isSaving} className="btn btn-primary">
          {isSaving && <Spinner />}
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

  const openTech = technicians.find(t => t.id === openId) || null;

  return (
    <ModalShell
      icon={Users}
      title="Tecnici e zone di competenza"
      subtitle="Chi fa i sopralluoghi, dove, da dove parte e quando non c'è."
      onClose={onClose}
      size="xl"
      bodyClassName="flex min-h-0 flex-1 flex-col md:flex-row md:basis-[640px]"
    >
      {/* Elenco dei tecnici */}
      <aside className={`${openTech ? 'hidden md:flex' : 'flex'} min-h-0 flex-1 flex-col border-line md:w-[300px] md:flex-none md:border-r md:bg-slate-50/50`}>
        <p className="px-5 pb-2 pt-4 text-xs leading-4 text-ink-500 max-sm:px-4">
          Le pratiche vengono assegnate automaticamente in base a province e zone.
          Ogni scheda definisce punto di partenza, orario di partenza e indisponibilità.
        </p>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 max-sm:px-2">
          {technicians.map(tech => {
            const selected = openId === tech.id;
            return (
              <li key={tech.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(tech.id)}
                  aria-current={selected ? 'true' : undefined}
                  className={`flex w-full items-start gap-3 rounded-control px-3 py-2.5 text-left transition-colors ${
                    selected ? 'bg-surface shadow-card ring-1 ring-line' : 'hover:bg-slate-100/80'
                  }`}
                >
                  <span className="dot mt-1.5 h-2.5 w-2.5" style={{ backgroundColor: tech.color }} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-sm font-medium ${tech.active ? 'text-ink-900' : 'text-ink-500'}`}>{tech.name}</span>
                      {!tech.active && <span className="chip chip-neutral h-[18px] px-1.5 text-2xs">non attivo</span>}
                    </span>
                    <span className="block truncate text-xs text-ink-500">{zoneSummary(tech)}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-2xs text-ink-400">
                      <span className="inline-flex min-w-0 items-center gap-1 truncate"><House {...ic} size={11} />{tech.baseAddress ? tech.baseAddress.split(',')[0] : 'base generale'}</span>
                      <span className="num inline-flex shrink-0 items-center gap-1"><Clock {...ic} size={11} />{tech.workStart}-{tech.workEnd}</span>
                      {tech.unavailability.length > 0 && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-amber-700"><Ban {...ic} size={11} />{tech.unavailability.length}</span>
                      )}
                    </span>
                  </span>
                  <ChevronRight {...ic} className={`mt-1 shrink-0 ${selected ? 'text-ink-500' : 'text-ink-300'}`} />
                </button>
              </li>
            );
          })}
          {technicians.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-ink-500">Nessun tecnico: aggiungine uno.</li>
          )}
        </ul>
        <div className="border-t border-line p-3 max-sm:px-4">
          <button type="button" onClick={handleAddTech} className="btn btn-secondary w-full">
            <Plus {...ic} />
            Aggiungi tecnico
          </button>
        </div>
      </aside>

      {/* Scheda del tecnico */}
      <div className={`${openTech ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col`}>
        {openTech ? (
          <TechnicianForm
            key={openTech.id}
            technician={openTech}
            onSave={handleSaveTech}
            onDelete={handleDeleteTech}
            onCollapse={() => setOpenId(null)}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 text-ink-500 ring-1 ring-inset ring-line">
              <UserRound size={22} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <p className="text-sm font-semibold text-ink-900">Seleziona un tecnico</p>
            <p className="mt-1 max-w-xs text-sm text-ink-500">Apri una scheda dall'elenco per modificare zone, partenza, orari e indisponibilità.</p>
          </div>
        )}
      </div>
    </ModalShell>
  );
};

export default TechnicianModal;
