import React, { useState } from 'react';
import type { Appointment, IssueType, Technician } from '../types';
import { geocodeAddress } from '../services/geocodingService';
import { parseAddressInput } from '../services/geminiService';
import { matchTechnician } from '../services/technicianService';
import { provinceLabel } from '../utils/provinces';
import { Building2, CalendarClock, CircleAlert, Contact, FilePen, FilePlus2, Flag, Siren, StickyNote, TriangleAlert, UserRound } from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { Field, Section, Spinner, Switch, ic } from './modal/parts';

interface AppointmentModalProps {
  initial?: Appointment | null; // null/undefined = new appointment
  technicians: Technician[];
  onSave: (appointment: Appointment) => void;
  onClose: () => void;
}

const AUTO_TECH = '__auto__';
const NO_TECH = '__none__';

// Categoria della pratica: normale, problematica (3 tipi) o annullata
const CATEGORY_NONE = 'none';
const CATEGORY_CANCELLED = 'cancelled';
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: CATEGORY_NONE, label: 'Nessuna (pratica normale)' },
  { value: 'wrong_phone', label: 'Numero non corretto (da richiedere)' },
  { value: 'callback', label: 'Da richiamare' },
  { value: 'works_pending', label: 'Lavori da ultimare' },
  { value: CATEGORY_CANCELLED, label: 'Pratica annullata' },
];

const followUpLabel = (category: string): string => {
  if (category === 'callback') return 'Data richiamo concordata';
  if (category === 'works_pending') return 'Data prevista fine lavori';
  if (category === 'wrong_phone') return 'Data ricontatto (opzionale)';
  return 'Non pianificare prima del (opzionale)';
};

const AppointmentModal: React.FC<AppointmentModalProps> = ({ initial, technicians, onSave, onClose }) => {
  const isEdit = !!initial;

  const [title, setTitle] = useState(initial?.title || '');
  const [phone, setPhone] = useState(initial?.phone || '');
  const [address, setAddress] = useState(initial?.address || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [duration, setDuration] = useState<string>(initial?.durationMinutes ? String(initial.durationMinutes) : '20');
  const [urgent, setUrgent] = useState<boolean>(initial?.urgent === true);
  const [technicianChoice, setTechnicianChoice] = useState<string>(
    initial?.technicianId && technicians.some(t => t.id === initial.technicianId)
      ? initial.technicianId
      : AUTO_TECH
  );
  const [category, setCategory] = useState<string>(
    initial?.status === 'issue' ? (initial.issueType || 'callback')
      : initial?.status === 'cancelled' ? CATEGORY_CANCELLED
      : CATEGORY_NONE
  );
  const [followUpDate, setFollowUpDate] = useState(initial?.followUpDate || '');

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmedAddress = address.trim();
    if (!trimmedAddress) {
      setError('Inserisci un indirizzo.');
      return;
    }

    const trimmedPhone = phone.trim();
    if (trimmedPhone && !/^[+]?[\d\s\-().]{6,20}$/.test(trimmedPhone)) {
      setError('Numero di telefono non valido.');
      return;
    }

    setIsSaving(true);
    try {
      let coords = initial?.coords;
      let displayAddress = initial?.address || '';
      let province = initial?.province;
      let comune = initial?.comune;
      let approximate = initial?.approximate;

      // Geocode only when the address is new or was changed
      const addressChanged = !initial || trimmedAddress !== initial.address;
      if (addressChanged) {
        const cleanAddress = await parseAddressInput(trimmedAddress);
        const result = await geocodeAddress(cleanAddress);
        if (!result) {
          setError('Indirizzo non trovato. Prova ad essere più specifico (via, civico, comune).');
          setIsSaving(false);
          return;
        }
        coords = result.coords;
        displayAddress = result.displayName;
        province = result.province || province;
        comune = result.comune || comune;
        approximate = undefined; // indirizzo trovato con precisione: via il flag
      }

      const parsedDuration = parseInt(duration, 10);

      // Assegnazione tecnico: scelta manuale oppure automatica per zona
      let technicianId: string | undefined;
      if (technicianChoice === AUTO_TECH) {
        const matched = matchTechnician({ coords: coords!, province }, technicians);
        technicianId = matched?.id;
      } else if (technicianChoice === NO_TECH) {
        technicianId = undefined;
      } else {
        technicianId = technicianChoice;
      }

      const appointment: Appointment = {
        ...(initial || { id: Date.now().toString(), status: 'pending' as const }),
        title: title.trim() || displayAddress.split(',')[0],
        phone: trimmedPhone || undefined,
        notes: notes.trim() || undefined,
        durationMinutes: !isNaN(parsedDuration) && parsedDuration > 0 ? parsedDuration : undefined,
        address: displayAddress,
        coords: coords!,
        province,
        comune,
        urgent: urgent || undefined,
        approximate,
        technicianId,
        followUpDate: followUpDate || undefined,
      };

      // Categoria: problematica/annullata esce dalla pianificazione; tornando
      // a "normale" da problematica/annullata la pratica riparte da "in attesa"
      const clearSchedule = () => {
        appointment.date = undefined;
        appointment.sequenceOrder = undefined;
        appointment.startTime = undefined;
        appointment.endTime = undefined;
      };
      if (category === CATEGORY_CANCELLED) {
        appointment.status = 'cancelled';
        appointment.issueType = undefined;
        clearSchedule();
      } else if (category !== CATEGORY_NONE) {
        appointment.status = 'issue';
        appointment.issueType = category as IssueType;
        clearSchedule();
      } else {
        appointment.issueType = undefined;
        if (initial && (initial.status === 'issue' || initial.status === 'cancelled')) {
          appointment.status = 'pending';
        }
      }

      onSave(appointment);
      onClose();
    } catch (err) {
      console.error(err);
      setError('Errore imprevisto durante il salvataggio. Riprova.');
    } finally {
      setIsSaving(false);
    }
  };

  const fid = (k: string) => `appt-${k}`;
  const categoryTone = category === CATEGORY_CANCELLED ? 'chip-neutral' : 'chip-danger';
  const categoryChip = CATEGORY_OPTIONS.find(o => o.value === category)?.label;

  return (
    <ModalShell
      icon={isEdit ? FilePen : FilePlus2}
      title={isEdit ? 'Modifica Appuntamento' : 'Nuovo Appuntamento'}
      subtitle={isEdit
        ? 'Aggiorna i dati della pratica, la pianificazione e lo stato.'
        : 'Inserisci la pratica: l\'indirizzo viene verificato sulla mappa.'}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Annulla
          </button>
          <button type="submit" form="appointment-form" disabled={isSaving} className="btn btn-primary min-w-[140px]">
            {isSaving && <Spinner />}
            {isSaving ? 'Verifica indirizzo...' : (isEdit ? 'Salva Modifiche' : 'Aggiungi')}
          </button>
        </>
      }
    >
      <form id="appointment-form" onSubmit={handleSubmit}>
        <Section title="Cliente e contatti" icon={UserRound}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cliente / Intestatario" htmlFor={fid('title')}>
              <input
                id={fid('title')}
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Es. Mario Rossi"
                className="input"
                autoFocus
              />
            </Field>
            <Field label="Telefono" htmlFor={fid('phone')} hint="Per la chiamata AI di conferma.">
              <input
                id={fid('phone')}
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="Es. +39 333 1234567"
                className="input num"
              />
            </Field>
          </div>
          {initial?.contactPerson && (
            <div className="mt-4 flex items-start gap-2.5 rounded-control border border-line bg-slate-50/70 px-3 py-2.5 text-sm">
              <Contact {...ic} className="mt-0.5 shrink-0 text-ink-400" />
              <div className="min-w-0">
                <span className="text-ink-500">Referente da contattare: </span>
                <span className="font-medium text-ink-900">{initial.contactPerson}</span>
                {initial.referredBy && <span className="block text-xs text-ink-500">indicato da {initial.referredBy}</span>}
              </div>
            </div>
          )}
        </Section>

        <Section title="Immobile" icon={Building2}>
          <Field
            label="Indirizzo *"
            htmlFor={fid('address')}
            hint={initial?.province
              ? <>Provincia rilevata: <span className="font-medium text-ink-700">{provinceLabel(initial.province)}</span></>
              : 'Via, civico e comune: più è preciso, meglio è.'}
          >
            <input
              id={fid('address')}
              type="text"
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="Via, civico, comune"
              className="input"
              required
            />
          </Field>
          {initial?.approximate && (
            <div className="callout callout-warn mt-3">
              <TriangleAlert {...ic} className="mt-0.5 shrink-0 text-amber-600" />
              <p className="leading-5">
                Posizione approssimativa (centro del comune): l'indirizzo esatto non è stato trovato
                sulle mappe. Modificalo (es. controlla via e civico) per riposizionare il pin.
              </p>
            </div>
          )}
        </Section>

        <Section title="Pianificazione" icon={CalendarClock}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tecnico" htmlFor={fid('tech')} hint="Auto: il tecnico competente per zona.">
              <select
                id={fid('tech')}
                value={technicianChoice}
                onChange={e => setTechnicianChoice(e.target.value)}
                className="select"
              >
                <option value={AUTO_TECH}>Auto (per zona)</option>
                {technicians.filter(t => t.active).map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
                <option value={NO_TECH}>Nessuno</option>
              </select>
            </Field>
            <Field label="Durata (min)" htmlFor={fid('duration')} hint="Durata prevista del sopralluogo.">
              <input
                id={fid('duration')}
                type="number"
                min="5"
                max="480"
                step="5"
                value={duration}
                onChange={e => setDuration(e.target.value)}
                className="input num"
              />
            </Field>
          </div>
          <label
            className={`mt-4 flex cursor-pointer items-center gap-3 rounded-control border px-3.5 py-3 transition-colors ${
              urgent ? 'border-rose-200 bg-rose-50' : 'border-line bg-surface hover:bg-slate-50'
            }`}
          >
            <Siren size={18} strokeWidth={1.75} aria-hidden="true" className={urgent ? 'shrink-0 text-rose-600' : 'shrink-0 text-ink-400'} />
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-medium ${urgent ? 'text-rose-800' : 'text-ink-900'}`}>Urgente</span>
              <span className="block text-xs leading-4 text-ink-500">
                priorità nello smistamento; l'operatore AI lo dichiara in chiamata
              </span>
            </span>
            <Switch checked={urgent} onChange={e => setUrgent(e.target.checked)} className="checked:!bg-rose-600" />
          </label>
        </Section>

        <Section
          title="Stato"
          icon={Flag}
          aside={category !== CATEGORY_NONE && categoryChip ? <span className={`chip ${categoryTone}`}>{categoryChip}</span> : undefined}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Categoria / Problematica" htmlFor={fid('category')}>
              <select
                id={fid('category')}
                value={category}
                onChange={e => setCategory(e.target.value)}
                className="select"
              >
                {CATEGORY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            {category !== CATEGORY_CANCELLED && (
              <Field label={followUpLabel(category)} htmlFor={fid('followup')}>
                <input
                  id={fid('followup')}
                  type="date"
                  value={followUpDate}
                  onChange={e => setFollowUpDate(e.target.value)}
                  className="input num"
                />
              </Field>
            )}
          </div>
          {category !== CATEGORY_CANCELLED && (
            <p className="field-hint mt-2 leading-4">
              Dal giorno prima comparirà l'alert "slot da riservare"; lo smistamento automatico
              non propone mai date precedenti.
            </p>
          )}
        </Section>

        <Section title="Note" icon={StickyNote}>
          <textarea
            aria-label="Note"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Note utili (comunicate anche all'operatore AI durante la chiamata)"
            rows={3}
            className="input resize-none"
          />
        </Section>

        {error && (
          <div role="alert" className="callout callout-danger mt-5">
            <CircleAlert {...ic} className="mt-0.5 shrink-0 text-rose-600" />
            <p>{error}</p>
          </div>
        )}
      </form>
    </ModalShell>
  );
};

export default AppointmentModal;
