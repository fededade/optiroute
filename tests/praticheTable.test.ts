import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SORT, STATUS_FILTERS, TABLE_COLUMNS, appointmentSortKey, appointmentText, filterByStatus, highlightParts,
  nextSort, phoneMissing, sortPratiche, statusCounts, tableLayoutFor,
} from '../src/layout/praticheTable';
import { attentionBreakdown } from '../src/layout/attentionSummary';
import { formatPhone } from '../src/layout/format';
import { appt } from './fixtures';

const ids = (list: { id: string }[]) => list.map(a => a.id);

const sample = () => [
  appt({ id: 'c2', title: 'Zeta', status: 'confirmed', date: '2026-11-12', startTime: '09:00', endTime: '09:20', comune: 'Pavia', periziaCode: 'PR-2', technicianId: 't2' }),
  appt({ id: 'c1', title: 'Alfa', status: 'confirmed', date: '2026-11-11', startTime: '10:00', endTime: '10:20', comune: 'Milano', periziaCode: 'PR-1', technicianId: 't1' }),
  appt({ id: 'p1', title: 'Beta', status: 'pending', comune: 'Lodi' }),
  appt({ id: 'p2', title: 'Alfa urgente', status: 'pending', urgent: true, comune: 'Monza', periziaCode: 'PR-9' }),
  appt({ id: 'i1', title: 'Gamma', status: 'issue', issueType: 'callback', followUpDate: '2026-11-20' }),
  appt({ id: 'x1', title: 'Delta', status: 'cancelled' }),
  appt({ id: 's1', title: 'Epsilon', status: 'standby' }),
  appt({ id: 'r1', title: 'Omega', status: 'proposed', date: '2026-11-13', startTime: '08:30', endTime: '08:50' }),
];

describe('Tutte le pratiche: filtro per stato', () => {
  it('pillole nell\'ordine del flusso, "Tutte" per prima', () => {
    expect(STATUS_FILTERS.map(f => f.label)).toEqual(['Tutte', 'In attesa', 'Proposte', 'Confermate', 'Problemi', 'Stand-by', 'Annullate']);
  });
  it('conteggi per stato e filtro a scelta singola', () => {
    const list = sample();
    const c = statusCounts(list);
    expect(c).toMatchObject({ all: 8, pending: 2, proposed: 1, confirmed: 2, issue: 1, standby: 1, cancelled: 1 });
    expect(ids(filterByStatus(list, 'confirmed')).sort()).toEqual(['c1', 'c2']);
    expect(filterByStatus(list, 'all')).toBe(list);
  });
});

describe('Tutte le pratiche: ordinamento', () => {
  it('iniziale: problemi, in attesa (urgenti in cima), proposte, confermate per data/ora, stand-by, annullate', () => {
    expect(ids(sortPratiche(sample(), DEFAULT_SORT))).toEqual(['i1', 'p2', 'p1', 'r1', 'c1', 'c2', 's1', 'x1']);
  });
  it('per stato decrescente: il flusso al contrario', () => {
    const out = ids(sortPratiche(sample(), { key: 'status', dir: 'desc' }));
    expect(out[0]).toBe('x1');
    expect(out[out.length - 1]).toBe('i1');
  });
  it('per cliente, nei due versi (ordine alfabetico italiano)', () => {
    expect(ids(sortPratiche(sample(), { key: 'cliente', dir: 'asc' })).slice(0, 3)).toEqual(['c1', 'p2', 'p1']);
    expect(ids(sortPratiche(sample(), { key: 'cliente', dir: 'desc' }))[0]).toBe('c2');
  });
  it('per codice e per appuntamento: i vuoti sempre in fondo', () => {
    const byCode = ids(sortPratiche(sample(), { key: 'codice', dir: 'desc' }));
    expect(byCode.slice(0, 3)).toEqual(['p2', 'c2', 'c1']);
    const byWhen = ids(sortPratiche(sample(), { key: 'appuntamento', dir: 'asc' }));
    expect(byWhen.slice(0, 4)).toEqual(['c1', 'c2', 'r1', 'i1']);
    const byWhenDesc = ids(sortPratiche(sample(), { key: 'appuntamento', dir: 'desc' }));
    expect(byWhenDesc.slice(0, 4)).toEqual(['i1', 'r1', 'c2', 'c1']);
  });
  it('per tecnico usa il nome, per comune il luogo', () => {
    const names: Record<string, string> = { t1: 'Zoe', t2: 'Anna' };
    expect(ids(sortPratiche(sample(), { key: 'tecnico', dir: 'asc' }, id => (id ? names[id] : '') || '')).slice(0, 2)).toEqual(['c2', 'c1']);
    // Lodi < Milano < Monza < Pavia
    const byPlace = ids(sortPratiche(sample(), { key: 'luogo', dir: 'asc' }));
    expect(['p1', 'c1', 'p2', 'c2'].map(id => byPlace.indexOf(id))).toEqual([...['p1', 'c1', 'p2', 'c2'].map(id => byPlace.indexOf(id))].sort((a, b) => a - b));
    expect(byPlace[0]).toBe('p1');
    expect(byPlace[byPlace.length - 1]).toBe('c2');
  });
  it('non modifica l\'elenco di partenza', () => {
    const list = sample();
    const before = ids(list);
    sortPratiche(list, { key: 'cliente', dir: 'asc' });
    expect(ids(list)).toEqual(before);
  });
  it('clic sull\'intestazione: stessa colonna inverte, colonna nuova parte crescente', () => {
    expect(nextSort({ key: 'cliente', dir: 'asc' }, 'cliente')).toEqual({ key: 'cliente', dir: 'desc' });
    expect(nextSort({ key: 'cliente', dir: 'desc' }, 'codice')).toEqual({ key: 'codice', dir: 'asc' });
  });
});

describe('Tutte le pratiche: colonne e celle', () => {
  it('colonne della tabella larga, ordinabili quelle richieste', () => {
    expect(TABLE_COLUMNS.map(c => c.id)).toEqual(['stato', 'cliente', 'indirizzo', 'codice', 'tecnico', 'appuntamento', 'telefono', 'chiamata', 'azioni']);
    expect(TABLE_COLUMNS.filter(c => c.sortKey).map(c => c.id)).toEqual(['stato', 'cliente', 'indirizzo', 'codice', 'tecnico', 'appuntamento']);
  });
  it('disposizione secondo la larghezza reale del pannello', () => {
    expect(tableLayoutFor(556)).toBe('compact');
    expect(tableLayoutFor(916)).toBe('compact');
    expect(tableLayoutFor(1008)).toBe('l');
    expect(tableLayoutFor(1168)).toBe('xl');
  });
  it('appuntamento: giorno e fascia; rientro; altrimenti trattino', () => {
    const [, c1, p1, , i1] = sample();
    expect(appointmentText(c1)).toMatchObject({ kind: 'slot', time: '10:00–10:20' });
    expect(appointmentText(c1).day).toMatch(/11 nov/);
    expect(appointmentText(i1)).toMatchObject({ kind: 'followup' });
    expect(appointmentText(i1).day).toMatch(/^Rientro .*20 nov/);
    expect(appointmentText(p1)).toEqual({ day: '—', time: '', kind: 'none' });
    expect(appointmentSortKey(p1)).toBe('');
  });
  it('telefono mancante: conta solo per in attesa, proposte e confermate', () => {
    expect(phoneMissing(appt({ status: 'pending' }))).toBe(true);
    expect(phoneMissing(appt({ status: 'confirmed', phone: '  ' }))).toBe(true);
    expect(phoneMissing(appt({ status: 'pending', phone: '3331234567' }))).toBe(false);
    expect(phoneMissing(appt({ status: 'cancelled' }))).toBe(false);
    expect(phoneMissing(appt({ status: 'issue' }))).toBe(false);
  });
});

describe('Evidenziazione del testo cercato', () => {
  const hits = (t: string, q: string) => highlightParts(t, q).filter(p => p.hit).map(p => p.text);
  it('ogni parola, senza badare a maiuscole e accenti', () => {
    expect(hits('Via Vigevano 18, Milano', 'vigevano')).toEqual(['Vigevano']);
    expect(hits('Niccolò Bassi', 'niccolo bas')).toEqual(['Niccolò', 'Bas']);
    expect(highlightParts('Città', 'citta').map(p => p.text).join('')).toBe('Città');
  });
  it('ricerca vuota o senza riscontri: il testo intero, non evidenziato', () => {
    expect(highlightParts('Marta Galli', '')).toEqual([{ text: 'Marta Galli', hit: false }]);
    expect(highlightParts('Marta Galli', 'xyz')).toEqual([{ text: 'Marta Galli', hit: false }]);
  });
  it('ricomponendo le parti si ottiene il testo originale', () => {
    const t = 'Condominio Le Magnolie — scala B';
    expect(highlightParts(t, 'le b').map(p => p.text).join('')).toBe(t);
  });
});

describe('Panoramica: dettaglio di "Da gestire"', () => {
  it('slot da riservare in testa, poi per tipo con singolare e plurale', () => {
    const parts = attentionBreakdown([
      { kind: 'numero_errato' }, { kind: 'esito_da_verificare' }, { kind: 'numero_errato' },
    ], 1);
    expect(parts.map(p => p.text)).toEqual(['1 slot da riservare', '1 esito da verificare', '2 numeri errati']);
  });
  it('niente in sospeso: nessuna voce', () => {
    expect(attentionBreakdown([], 0)).toEqual([]);
  });
});

describe('Telefono leggibile (solo visualizzazione)', () => {
  it('cellulari con e senza prefisso', () => {
    expect(formatPhone('3331234567')).toBe('+39 333 123 4567');
    expect(formatPhone('+393331234567')).toBe('+39 333 123 4567');
    expect(formatPhone('0039 333 1234567')).toBe('+39 333 123 4567');
    expect(formatPhone('333 123 4567')).toBe('+39 333 123 4567');
  });
  it('fissi: Milano e Roma a due cifre, grandi città a tre, gli altri a quattro', () => {
    expect(formatPhone('0212345678')).toBe('+39 02 1234 5678');
    expect(formatPhone('+39 06 1234567')).toBe('+39 06 123 4567');
    expect(formatPhone('011-1234567')).toBe('+39 011 123 4567');
    expect(formatPhone('0382123456')).toBe('+39 0382 123 456');
  });
  it('già formattati: stesso risultato', () => {
    expect(formatPhone('+39 02 410 1037')).toBe('+39 02 410 1037');
    expect(formatPhone('+39 333 123 4567')).toBe('+39 333 123 4567');
  });
  it('esteri, speciali e testi non numerici restano come sono', () => {
    expect(formatPhone('+41 44 123 45 67')).toBe('+41 44 123 45 67');
    expect(formatPhone('800 123 456')).toBe('800 123 456');
    expect(formatPhone('chiedere al portiere')).toBe('chiedere al portiere');
    expect(formatPhone('')).toBe('');
    expect(formatPhone(undefined)).toBe('');
  });
});
