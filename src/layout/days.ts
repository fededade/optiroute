import type { Appointment } from '../types';
import type { ViewMode } from './types';
import { isInRoute } from '../services/slotService';
import { addDays, isoDate } from './format';

// Giorni attivi dell'agenda e colore di ogni giorno (solo visualizzazione:
// nessuna logica di pianificazione). Funzioni pure, provate in tests/days.test.ts

// --- Colore del giorno ---------------------------------------------------
// 12 colori ben distinti, scuri abbastanza per il numero bianco del
// segnaposto e leggibili sulla mappa chiara. L'ordine è scelto perché due
// giorni consecutivi (e lo stesso giorno della settimana dopo, cioè la cella
// sotto nel calendario) abbiano tinte lontane almeno un quarto di giro.
export const DAY_PALETTE: readonly string[] = [
  '#db2777', // rosa
  '#0e7490', // ciano
  '#b45309', // ambra
  '#4f46e5', // indaco
  '#ea580c', // arancio
  '#0f766e', // verde acqua
  '#c026d3', // fucsia
  '#2563eb', // blu
  '#4d7c0f', // verde oliva
  '#7c3aed', // viola
  '#dc2626', // rosso
  '#059669', // smeraldo
];

// Numero progressivo del giorno (giorni dal 1° gennaio 1970), senza fusi orari
export const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
};

// Colore stabile per data: stesso giorno, stesso colore; giorni vicini, colori diversi
export const dayColor = (iso?: string): string => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '#646A7B';
  const n = dayNumber(iso);
  return DAY_PALETTE[((n % DAY_PALETTE.length) + DAY_PALETTE.length) % DAY_PALETTE.length];
};

// --- Conteggi per il calendario -------------------------------------------
export interface DayCount { confirmed: number; proposed: number }

// Pratiche "nel giro" per giorno (confermate e proposte con data e ora),
// con il filtro del tecnico della barra in alto
export const dayCounts = (
  appointments: Appointment[],
  matchesTech: (a: Appointment) => boolean = () => true,
): Map<string, DayCount> => {
  const out = new Map<string, DayCount>();
  for (const a of appointments) {
    if (!isInRoute(a) || !matchesTech(a)) continue;
    const c = out.get(a.date!) || { confirmed: 0, proposed: 0 };
    if (a.status === 'confirmed') c.confirmed += 1; else c.proposed += 1;
    out.set(a.date!, c);
  }
  return out;
};

// --- Giorni attivi ----------------------------------------------------------
// Stato: la data dell'agenda (currentDate), la vista e, in vista giorno, i
// giorni aggiunti con "Più giorni" (extraDays). Settimana e mese valgono come
// "tutti i giorni dell'intervallo attivi".
export interface DaySelection {
  currentDate: string;
  viewMode: ViewMode;
  extraDays: string[];
}

const uniqSorted = (days: string[]): string[] => Array.from(new Set(days)).sort();

// Tutti i giorni dell'intervallo della vista (settimana lun–dom o mese)
export const rangeDays = (currentDate: string, viewMode: ViewMode): string[] => {
  if (viewMode === 'day') return [currentDate];
  const d = new Date(`${currentDate}T00:00:00`);
  let start: string;
  let len: number;
  if (viewMode === 'week') {
    const dow = d.getDay() || 7;
    start = addDays(currentDate, -(dow - 1));
    len = 7;
  } else {
    start = isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
    len = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }
  return Array.from({ length: len }, (_, i) => addDays(start, i));
};

export const activeDays = (s: DaySelection): string[] =>
  s.viewMode === 'day' ? uniqSorted([s.currentDate, ...s.extraDays]) : rangeDays(s.currentDate, s.viewMode);

export const isDayActive = (s: DaySelection, date?: string): boolean => {
  if (!date) return false;
  // confronto fra date "AAAA-MM-GG" (nessun fuso orario di mezzo)
  if (s.viewMode !== 'day') return rangeDays(s.currentDate, s.viewMode).includes(date);
  return date === s.currentDate || s.extraDays.includes(date);
};

// Un solo giorno (clic normale, frecce, "Oggi", "Solo oggi")
export const selectSingleDay = (date: string): DaySelection => ({ currentDate: date, viewMode: 'day', extraDays: [] });

// "Più giorni": il clic aggiunge o toglie un giorno. Da settimana/mese si
// parte da tutti i giorni dell'intervallo. L'ultimo giorno rimasto non si
// toglie. La data dell'agenda resta la stessa finché è fra i giorni attivi.
export const toggleDay = (s: DaySelection, date: string): DaySelection => {
  const current = activeDays(s);
  const next = current.includes(date)
    ? (current.length > 1 ? current.filter(d => d !== date) : current)
    : uniqSorted([...current, date]);
  const primary = next.includes(s.currentDate) ? s.currentDate : next[0];
  return { currentDate: primary, viewMode: 'day', extraDays: next.filter(d => d !== primary) };
};

// --- Griglia del mese (lun–dom) --------------------------------------------
// 6 settimane da lunedì: sempre 42 giorni, la griglia non cambia altezza
export const monthGrid = (year: number, month0: number): string[] => {
  const first = new Date(year, month0, 1);
  const dow = first.getDay() || 7;
  const start = addDays(isoDate(first), -(dow - 1));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
};

// --- Filtri -------------------------------------------------------------------
// Agenda: confermate dei giorni attivi
export const agendaFilter = (s: DaySelection) => (a: Appointment): boolean =>
  a.status === 'confirmed' && isDayActive(s, a.date);

// Mappa: le pratiche nel giro (confermate; proposte con data e ora) solo dei
// giorni attivi. Le proposte senza giorno e ora non sono "nel giro" e
// restano visibili come prima; gli altri stati non si toccano.
// allProposals: in Proposte la mappa mostra tutte le proposte, come l'elenco.
export const mapDayFilter = (s: DaySelection, allProposals = false) => (a: Appointment): boolean => {
  if (a.status === 'confirmed') return isDayActive(s, a.date);
  if (a.status === 'proposed') return allProposals || !isInRoute(a) || isDayActive(s, a.date);
  return true;
};

// Giorni presenti fra le pratiche nel giro mostrate (per la legenda)
export const routeDaysOf = (appointments: Appointment[]): [string, number][] => {
  const m = new Map<string, number>();
  for (const a of appointments) {
    if (!isInRoute(a)) continue;
    m.set(a.date!, (m.get(a.date!) || 0) + 1);
  }
  return Array.from(m.entries()).sort((x, y) => x[0].localeCompare(y[0]));
};
