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

// Telefono leggibile (solo visualizzazione: il valore salvato non cambia).
// "3331234567" / "+393331234567" → "+39 333 123 4567";
// "0212345678" → "+39 02 1234 5678"; "0382123456" → "+39 0382 123 456".
// Prefissi esteri, numeri speciali e testi non numerici restano come sono.
const AREA_3 = new Set(['010', '011', '015', '019', '030', '031', '035', '039', '040', '041', '045', '049', '050', '051', '055', '059',
  '070', '071', '075', '079', '080', '081', '085', '089', '090', '091', '095', '099']);
const groupRest = (s: string): string => {
  if (s.length <= 5) return s;
  if (s.length === 6) return `${s.slice(0, 3)} ${s.slice(3)}`;
  if (s.length === 7) return `${s.slice(0, 3)} ${s.slice(3)}`;
  if (s.length === 8) return `${s.slice(0, 4)} ${s.slice(4)}`;
  return `${s.slice(0, s.length - 4)} ${s.slice(-4)}`;
};
export const formatPhone = (raw?: string): string => {
  if (!raw) return '';
  const trimmed = raw.trim();
  const compact = trimmed.replace(/[\s.\-/()]/g, '');
  if (!/^(\+|00)?\d+$/.test(compact)) return trimmed;
  let national: string;
  if (compact.startsWith('+39')) national = compact.slice(3);
  else if (compact.startsWith('0039')) national = compact.slice(4);
  else if (compact.startsWith('+') || compact.startsWith('00')) return trimmed;
  else national = compact;
  if (/^3\d{8,9}$/.test(national)) {
    // cellulare: 3-3-4 (o 3-3-3)
    return `+39 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  }
  if (/^0\d{5,10}$/.test(national)) {
    const areaLen = /^0[26]/.test(national) ? 2 : AREA_3.has(national.slice(0, 3)) ? 3 : 4;
    return `+39 ${national.slice(0, areaLen)} ${groupRest(national.slice(areaLen))}`;
  }
  return trimmed;
};

export const kmLabel =(km?: number): string =>
  km === undefined || km === null ? '' : `${km.toLocaleString('it-IT', { maximumFractionDigits: 1 })} km`;
