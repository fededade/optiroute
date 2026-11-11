import type { Appointment } from '../types';
import type { ViewMode } from './types';

// Piccole funzioni di formattazione per l'interfaccia (nessuna logica di dominio)

const pad = (n: number) => String(n).padStart(2, '0');

// "gio 12 nov"
export const dayLabel = (iso?: string): string => {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
};

export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
// "Gio 12 nov" (in testa a un blocco)
export const dayTitle = (iso?: string): string => cap(dayLabel(iso));

// "giovedì 12 novembre"
export const longDayLabel = (iso?: string): string => {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
};

export const isoDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

export const hhmmOf = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Indirizzo breve (via e civico) e comune per la scheda
export const shortStreet = (a: Appointment): string => {
  if (a.shortAddress?.trim()) return a.shortAddress.trim();
  const parts = (a.address || '').split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  // "12, Via Roma, ..." (Nominatim mette a volte il civico prima)
  if (/^\d+[a-z]?$/i.test(parts[0]) && parts[1]) return `${parts[1]} ${parts[0]}`;
  return parts[0];
};

export const placeLabel = (a: Appointment): string => {
  const comune = a.comune?.trim();
  const prov = a.province?.trim();
  if (comune) return prov && prov.length <= 3 && prov.toUpperCase() !== comune.toUpperCase() ? `${comune} (${prov.toUpperCase()})` : comune;
  const parts = (a.address || '').split(',').map(s => s.trim()).filter(Boolean);
  return parts[1] && !/^\d/.test(parts[1]) ? parts[1] : '';
};

// Ricerca: cliente, indirizzo, comune, codice pratica, telefono, note, referente
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export const matchesQuery = (a: Appointment, query: string): boolean => {
  const q = norm(query.trim());
  if (!q) return true;
  const hay = norm([a.title, a.address, a.shortAddress, a.comune, a.province, a.periziaCode, a.phone, a.notes, a.contactPerson, a.project]
    .filter(Boolean).join(' \n '));
  if (q.split(/\s+/).every(w => hay.includes(w))) return true;
  const digits = q.replace(/\D/g, '');
  return digits.length >= 4 && (a.phone || '').replace(/\D/g, '').includes(digits);
};

// Stessa regola dell'elenco delle confermate (getVisibleAppointments in App):
// giorno = stessa data; settimana = lun–dom della data; mese = stesso mese
export const inAgendaRange = (date: string | undefined, currentDate: string, viewMode: ViewMode): boolean => {
  if (!date) return false;
  if (viewMode === 'day') return date === currentDate;
  const selected = new Date(currentDate);
  const d = new Date(date);
  if (viewMode === 'week') {
    const startOfWeek = new Date(selected);
    const day = startOfWeek.getDay() || 7;
    if (day !== 1) startOfWeek.setHours(-24 * (day - 1));
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    return d >= startOfWeek && d <= endOfWeek;
  }
  return d.getMonth() === selected.getMonth() && d.getFullYear() === selected.getFullYear();
};

export const rangeLabel = (currentDate: string, viewMode: ViewMode): string => {
  if (viewMode === 'day') return dayLabel(currentDate);
  const d = new Date(`${currentDate}T00:00:00`);
  if (viewMode === 'month') return d.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  const day = d.getDay() || 7;
  const mon = new Date(d); mon.setDate(d.getDate() - (day - 1));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const f = (x: Date) => x.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }).replace(/\./g, '');
  return `settimana ${f(mon)} – ${f(sun)}`;
};

export const kmLabel = (km?: number): string =>
  km === undefined || km === null ? '' : `${km.toLocaleString('it-IT', { maximumFractionDigits: 1 })} km`;
