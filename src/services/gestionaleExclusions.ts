import type { Appointment, Coordinates } from '../types';
import { isCallInFlight } from './autopilotService';
import { codeKey, praticaKey } from './praticaCode';
import { removeFromRoute } from './slotService';

// Controllo incrociato con il gestionale (funzioni PURE).
//
// Dentro il gestionale è il gestionale a decidere quali pratiche del portale
// vanno programmate. Insieme alle pratiche del bridge manda l'elenco di
// quelle da NON lavorare ("excluded"), con il motivo:
//  - concordata: il giorno del sopralluogo è già fissato nel gestionale;
//  - effettuata: il sopralluogo è già stato fatto;
//  - chiusa: la pratica è completata o eliminata.
// Le pratiche già presenti in OptiRoute con quel codice escono dal lavoro:
// vanno fra le annullate (archivio), come quando l'operatore le annulla,
// con una riga nelle note che spiega il perché. Le confermate non si
// toccano mai, e nemmeno quelle con una chiamata in corso.

export type ExclusionReason = 'concordata' | 'effettuata' | 'chiusa';

export interface GestionaleExclusion {
  codice: string;
  reason: ExclusionReason;
}

const REASONS: ExclusionReason[] = ['concordata', 'effettuata', 'chiusa'];

// Riga aggiunta alle note, per motivo
export const EXCLUSION_NOTE: Record<ExclusionReason, string> = {
  concordata: 'Tolta dal giro: nel gestionale il sopralluogo risulta già concordato.',
  effettuata: 'Tolta dal giro: nel gestionale il sopralluogo risulta già fatto.',
  chiusa: 'Tolta dal giro: nel gestionale la pratica risulta chiusa.',
};

// Elenco "excluded" della risposta del gestionale: si tengono solo le voci
// con un codice non vuoto e uno dei tre motivi; il resto si ignora.
// Mancante o non valido = elenco vuoto.
export const parseExcluded = (raw: unknown): GestionaleExclusion[] => {
  if (!Array.isArray(raw)) return [];
  const out: GestionaleExclusion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.codice !== 'string' || !r.codice.trim()) continue;
    if (typeof r.reason !== 'string' || !REASONS.includes(r.reason as ExclusionReason)) continue;
    out.push({ codice: r.codice.trim(), reason: r.reason as ExclusionReason });
  }
  return out;
};

export interface ExclusionChange {
  id: string;
  codice: string;
  reason: ExclusionReason;
}

export interface ExclusionOptions {
  now: Date;
  // Base del giorno del tecnico (per ricalcolare i viaggi del giro lasciato)
  dayBase?: (technicianId: string | undefined, date: string) => { base: Coordinates | null } | undefined;
}

// Una riga già scritta da noi nelle note: se l'operatore ha poi ripristinato
// la pratica, la sua scelta vale e non la si toglie di nuovo.
const alreadyExcludedOnce = (notes?: string): boolean =>
  !!notes && Object.values(EXCLUSION_NOTE).some(line => notes.includes(line));

const appendLine = (notes: string | undefined, line: string): string =>
  notes && notes.trim() ? `${notes.replace(/\s+$/, '')}\n${line}` : line;

// Applica l'elenco alle pratiche. Restituisce il nuovo elenco e le pratiche
// tolte (vuoto se non cambia nulla: applicare due volte lo stesso elenco
// non cambia niente la seconda volta).
export const applyGestionaleExclusions = (
  all: Appointment[],
  excluded: GestionaleExclusion[],
  opts: ExclusionOptions
): { list: Appointment[]; removed: ExclusionChange[] } => {
  const byKey = new Map<string, GestionaleExclusion>();
  for (const e of excluded) {
    const key = codeKey(e.codice);
    if (key && !byKey.has(key)) byKey.set(key, e);
  }
  if (byKey.size === 0) return { list: all, removed: [] };

  let list = all;
  const removed: ExclusionChange[] = [];
  for (const a of all) {
    const key = praticaKey(a);
    const hit = key ? byKey.get(key) : undefined;
    if (!hit) continue;
    if (a.status === 'confirmed' || a.status === 'cancelled') continue;
    if (isCallInFlight(a, opts.now)) continue;
    if (alreadyExcludedOnce(a.notes)) continue;

    // Come l'annullamento (operatore, o esito "annullato" del pilota): fuori
    // dal giro, slot liberato e giro ricalcolato, coda delle chiamate svuotata
    const ctx = a.date ? opts.dayBase?.(a.technicianId, a.date) : undefined;
    list = removeFromRoute(list, a.id, {
      status: 'cancelled',
      issueType: undefined,
      notes: appendLine(a.notes, EXCLUSION_NOTE[hit.reason]),
    }, ctx);
    removed.push({ id: a.id, codice: hit.codice, reason: hit.reason });
  }
  return { list, removed };
};
