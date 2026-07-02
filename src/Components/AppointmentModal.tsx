import React, { useState } from 'react';
import type { Appointment } from '../types';
import { geocodeAddress } from '../services/geocodingService';
import { parseAddressInput } from '../services/geminiService';

interface AppointmentModalProps {
  initial?: Appointment | null; // null/undefined = new appointment
  onSave: (appointment: Appointment) => void;
  onClose: () => void;
}

const AppointmentModal: React.FC<AppointmentModalProps> = ({ initial, onSave, onClose }) => {
  const isEdit = !!initial;

  const [title, setTitle] = useState(initial?.title || '');
  const [phone, setPhone] = useState(initial?.phone || '');
  const [address, setAddress] = useState(initial?.address || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [duration, setDuration] = useState<string>(initial?.durationMinutes ? String(initial.durationMinutes) : '20');

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
      }

      const parsedDuration = parseInt(duration, 10);

      const appointment: Appointment = {
        ...(initial || { id: Date.now().toString(), status: 'pending' as const }),
        title: title.trim() || displayAddress.split(',')[0],
        phone: trimmedPhone || undefined,
        notes: notes.trim() || undefined,
        durationMinutes: !isNaN(parsedDuration) && parsedDuration > 0 ? parsedDuration : undefined,
        address: displayAddress,
        coords: coords!,
      };

      onSave(appointment);
      onClose();
    } catch (err) {
      console.error(err);
      setError('Errore imprevisto durante il salvataggio. Riprova.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800">
            {isEdit ? 'Modifica Appuntamento' : 'Nuovo Appuntamento'}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none px-1">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Cliente / Intestatario</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Es. Mario Rossi"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">
              Telefono <span className="font-normal normal-case text-slate-400">(per la chiamata AI di conferma)</span>
            </label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="Es. +39 333 1234567"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Indirizzo *</label>
            <input
              type="text"
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="Via, civico, comune"
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              required
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Durata (min)</label>
              <input
                type="number"
                min="5"
                max="480"
                step="5"
                value={duration}
                onChange={e => setDuration(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Note</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Note utili (comunicate anche all'operatore AI durante la chiamata)"
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:ring-2 focus:ring-indigo-500 outline-none resize-none"
            />
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded p-2">{error}</p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
            >
              Annulla
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-bold"
            >
              {isSaving ? 'Verifica indirizzo...' : (isEdit ? 'Salva Modifiche' : 'Aggiungi')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AppointmentModal;
