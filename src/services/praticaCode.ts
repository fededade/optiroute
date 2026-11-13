import type { Appointment } from '../types';

// Codice della pratica (funzioni PURE, usate dall'app e dal server).
//
// Lo stesso numero arriva scritto in modi diversi:
//  - il bridge dei portali lo dà di sole cifre ("845326");
//  - l'import da Google My Maps non salva periziaCode: il riferimento è la
//    prima riga delle note ("Rif: ISP 845.326");
//  - il gestionale lo scrive con il punto ("845.326").
// Per riconoscere la stessa pratica si confrontano le CHIAVI (codeKey), mai i
// testi salvati, che non vengono mai riscritti.

const RIF_LINE = /^\s*rif\s*:\s*(.*?)\s*$/i;

// Riga "Rif: …" se è la prima riga non vuota delle note
export const notesRef = (notes?: string): { code: string; rest: string } | null => {
  if (!notes) return null;
  const lines = notes.split(/\r?\n/);
  const i = lines.findIndex(l => l.trim() !== '');
  if (i < 0) return null;
  const m = RIF_LINE.exec(lines[i]);
  if (!m || !m[1]) return null;
  return { code: m[1], rest: lines.slice(i + 1).join('\n').trim() };
};

type CodeSource = Pick<Appointment, 'periziaCode' | 'notes'>;

// Codice da mostrare: periziaCode; altrimenti il "Rif:" in testa alle note
export const displayCode = (a: CodeSource): string =>
  a.periziaCode?.trim() || notesRef(a.notes)?.code || '';

// Note da mostrare: senza la riga "Rif:" quando è usata come codice
export const displayNotes = (a: CodeSource): string => {
  if (a.periziaCode?.trim()) return a.notes || '';
  const ref = notesRef(a.notes);
  return ref ? ref.rest : (a.notes || '');
};

// Numero di pratica: prefisso alfabetico facoltativo + 5-7 cifre, scritte di
// fila o con UN separatore delle migliaia (punto o spazio):
// "845326", "845.326", "845 326", "ISP 845.326", "isp845326"
const NUMBERED = /^(?:[A-Z]+ ?)?(\d{5,7}|\d{2,4}[. ]\d{3})$/;

// Chiave di confronto di un codice: testo pulito (spazi ridotti, maiuscole);
// per i numeri di pratica, le sole cifre. Gli altri codici ("ISP-C1",
// "BR-1", "1.234.567"…) restano il testo pulito.
export const codeKey = (text: string | undefined | null): string => {
  const clean = (text || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!clean) return '';
  const m = NUMBERED.exec(clean);
  return m ? m[1].replace(/\D/g, '') : clean;
};

// Chiave della pratica ('' se non ha codice)
export const praticaKey = (a: CodeSource): string => codeKey(displayCode(a));
