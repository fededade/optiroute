import type { Appointment, AppointmentStatus } from '../types';
import { dayLabel, placeLabel, shortStreet } from './format';

// "Tutte le pratiche": funzioni pure della tabella (filtro per stato,
// ordinamento, colonne, testo dell'appuntamento, evidenziazione della
// ricerca). Nessuna logica di dominio: solo come si mostrano le pratiche.

// --- Filtro per stato (pillole a scelta singola) ---

export type StatusFilter = 'all' | AppointmentStatus;

export const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Tutte' },
  { id: 'pending', label: 'In attesa' },
  { id: 'proposed', label: 'Proposte' },
  { id: 'confirmed', label: 'Confermate' },
  { id: 'issue', label: 'Problemi' },
  { id: 'standby', label: 'Stand-by' },
  { id: 'cancelled', label: 'Annullate' },
];

export const filterByStatus = (list: Appointment[], filter: StatusFilter): Appointment[] =>
  filter === 'all' ? list : list.filter(a => a.status === filter);

export const statusCounts = (list: Appointment[]): Record<StatusFilter, number> => {
  const out: Record<StatusFilter, number> = { all: list.length, pending: 0, proposed: 0, confirmed: 0, issue: 0, standby: 0, cancelled: 0 };
  for (const a of list) out[a.status] = (out[a.status] || 0) + 1;
  return out;
};

// --- Ordinamento ---

export type SortKey = 'status' | 'cliente' | 'luogo' | 'codice' | 'tecnico' | 'appuntamento';
export type SortDir = 'asc' | 'desc';
export interface SortState { key: SortKey; dir: SortDir }

export const DEFAULT_SORT: SortState = { key: 'status', dir: 'asc' };

// Verso del flusso: prima ciò che chiede una mano, poi ciò che è avviato
export const STATUS_FLOW: AppointmentStatus[] = ['issue', 'pending', 'proposed', 'confirmed', 'standby', 'cancelled'];
const flowRank = (s: AppointmentStatus) => {
  const i = STATUS_FLOW.indexOf(s);
  return i < 0 ? STATUS_FLOW.length : i;
};

// Data/ora dell'appuntamento come chiave ordinabile ('' = nessuna)
export const appointmentSortKey = (a: Appointment): string => {
  if ((a.status === 'confirmed' || a.status === 'proposed') && a.date) return `${a.date} ${a.startTime || '99:99'}`;
  if (a.followUpDate) return `${a.followUpDate} 99:99`;
  return '';
};

const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
const cmpText = (x: string, y: string) => collator.compare(x, y);

// Le vuote vanno sempre in fondo, in qualunque verso
const cmpMaybe = (x: string, y: string, dir: SortDir): number => {
  if (!x && !y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  return dir === 'asc' ? cmpText(x, y) : -cmpText(x, y);
};

// Ordine iniziale: stato nel verso del flusso; in attesa gli urgenti in cima;
// poi data/ora; poi nome
export const compareDefault = (a: Appointment, b: Appointment): number => {
  const r = flowRank(a.status) - flowRank(b.status);
  if (r !== 0) return r;
  if (a.status === 'pending' && !!a.urgent !== !!b.urgent) return a.urgent ? -1 : 1;
  const d = cmpMaybe(appointmentSortKey(a), appointmentSortKey(b), 'asc');
  if (d !== 0) return d;
  return cmpText(a.title || '', b.title || '');
};

export const sortPratiche = (
  list: Appointment[],
  sort: SortState,
  techName: (id?: string) => string = () => '',
): Appointment[] => {
  const { key, dir } = sort;
  const sign = dir === 'asc' ? 1 : -1;
  const by = (a: Appointment, b: Appointment): number => {
    switch (key) {
      case 'status': {
        const r = flowRank(a.status) - flowRank(b.status);
        return r !== 0 ? sign * r : compareDefault(a, b);
      }
      case 'cliente': return sign * cmpText(a.title || '', b.title || '');
      case 'luogo':
        return cmpMaybe(placeLabel(a), placeLabel(b), dir) || cmpMaybe(shortStreet(a), shortStreet(b), dir);
      case 'codice': return cmpMaybe(a.periziaCode || '', b.periziaCode || '', dir);
      case 'tecnico': return cmpMaybe(techName(a.technicianId), techName(b.technicianId), dir);
      case 'appuntamento': return cmpMaybe(appointmentSortKey(a), appointmentSortKey(b), dir);
    }
  };
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => by(x.a, y.a) || compareDefault(x.a, y.a) || x.i - y.i)
    .map(x => x.a);
};

// Clic su un'intestazione: stessa colonna → inverte; colonna nuova → crescente
export const nextSort = (current: SortState, key: SortKey): SortState =>
  current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };

// --- Colonne ---

export type ColumnId = 'stato' | 'cliente' | 'indirizzo' | 'codice' | 'tecnico' | 'appuntamento' | 'telefono' | 'chiamata' | 'azioni';

export interface Column {
  id: ColumnId;
  label: string;
  sortKey?: SortKey;
  /** larghezza fissa in px (assente = si allarga) */
  width?: { xl: number; l: number };
}

export const TABLE_COLUMNS: Column[] = [
  { id: 'stato', label: 'Stato', sortKey: 'status', width: { xl: 136, l: 132 } },
  { id: 'cliente', label: 'Cliente', sortKey: 'cliente' },
  { id: 'indirizzo', label: 'Indirizzo', sortKey: 'luogo' },
  { id: 'codice', label: 'Codice', sortKey: 'codice', width: { xl: 104, l: 88 } },
  { id: 'tecnico', label: 'Tecnico', sortKey: 'tecnico', width: { xl: 116, l: 48 } },
  { id: 'appuntamento', label: 'Appuntamento', sortKey: 'appuntamento', width: { xl: 138, l: 112 } },
  { id: 'telefono', label: 'Telefono', width: { xl: 128, l: 128 } },
  { id: 'chiamata', label: 'Chiamata', width: { xl: 148, l: 108 } },
  { id: 'azioni', label: 'Azioni', width: { xl: 76, l: 72 } },
];

export const SORT_LABELS: Record<SortKey, string> = {
  status: 'Stato',
  cliente: 'Cliente',
  luogo: 'Comune',
  codice: 'Codice',
  tecnico: 'Tecnico',
  appuntamento: 'Appuntamento',
};

// Larghezza del pannello → disposizione: tabella piena, tabella stretta
// (tecnico a solo pallino), righe compatte su due linee
export type TableLayout = 'xl' | 'l' | 'compact';
export const TABLE_WIDE_MIN = 980;
export const TABLE_XL_MIN = 1100;
export const tableLayoutFor = (width: number): TableLayout =>
  width >= TABLE_XL_MIN ? 'xl' : width >= TABLE_WIDE_MIN ? 'l' : 'compact';

// --- Testi delle celle ---

// Appuntamento: giorno e fascia; per i rientri "Rientro <giorno>"; altrimenti —
export const appointmentText = (a: Appointment): { day: string; time: string; kind: 'slot' | 'followup' | 'none' } => {
  if ((a.status === 'confirmed' || a.status === 'proposed') && a.date) {
    return { day: dayLabel(a.date), time: a.startTime ? `${a.startTime}–${a.endTime || ''}`.replace(/–$/, '') : '', kind: 'slot' };
  }
  if (a.followUpDate) return { day: `Rientro ${dayLabel(a.followUpDate)}`, time: '', kind: 'followup' };
  return { day: '—', time: '', kind: 'none' };
};

// Senza telefono il pilota non può chiamare: conta solo per le pratiche vive
export const phoneMissing = (a: Appointment): boolean =>
  !a.phone?.trim() && (a.status === 'pending' || a.status === 'proposed' || a.status === 'confirmed');

// --- Evidenziazione del testo cercato ---

// Spezza il testo in parti trovate / non trovate: ogni parola della ricerca,
// senza badare a maiuscole e accenti (come matchesQuery)
export const highlightParts = (text: string, query: string): { text: string; hit: boolean }[] => {
  const words = query.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
  if (!text || words.length === 0) return [{ text, hit: false }];
  // testo normalizzato carattere per carattere (stessa lunghezza dell'originale)
  // (un'unità per carattere: le posizioni restano allineate)
  const flat = Array.from(text).map(ch => ch.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0) || '\u0000');
  const chars = Array.from(text);
  const hay = flat.join('');
  const mark = new Array(chars.length).fill(false);
  for (const w of words) {
    let from = 0;
    while (from <= hay.length - w.length) {
      const i = hay.indexOf(w, from);
      if (i < 0) break;
      for (let k = i; k < i + w.length; k++) mark[k] = true;
      from = i + w.length;
    }
  }
  const parts: { text: string; hit: boolean }[] = [];
  chars.forEach((ch, i) => {
    const last = parts[parts.length - 1];
    if (last && last.hit === mark[i]) last.text += ch;
    else parts.push({ text: ch, hit: mark[i] });
  });
  return parts;
};
