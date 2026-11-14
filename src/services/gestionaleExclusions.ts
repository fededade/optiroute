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
// Stessa cosa per le pratiche che il PORTALE dà già fissate, fatte o chiuse
// (contratto §6, fonte "portale"): le ricava OptiRoute dallo snapshot del
// bridge (vedi portalState.ts) o le indica la pagina del gestionale.

export type ExclusionReason = 'concordata' | 'effettuata' | 'chiusa';

export interface GestionaleExclusion {
  codice: string;
  reason: ExclusionReason;
  fonte?: 'portale';   // assente = deciso dal gestionale; 'portale' = stato sul portale
  data?: string;       // (fonte portale) data del sopralluogo fissato, YYYY-MM-DD, se nota
}

const REASONS: ExclusionReason[] = ['concordata', 'effettuata', 'chiusa'];

// Riga aggiunta alle note, per motivo
export const EXCLUSION_NOTE: Record<ExclusionReason, string> = {
  concordata: 'Tolta dal giro: nel gestionale il sopralluogo risulta già concordato.',
  effettuata: 'Tolta dal giro: nel gestionale il sopralluogo risulta già fatto.',
  chiusa: 'Tolta dal giro: nel gestionale la pratica risulta chiusa.',
};

// Riga aggiunta alle note quando la fonte è il portale
export const PORTAL_EXCLUSION_NOTE: Record<ExclusionReason, string> = {
  concordata: 'Tolta dal giro: sul portale il sopralluogo risulta già fissato.',
  effettuata: 'Tolta dal giro: sul portale il sopralluogo risulta già fatto.',
  chiusa: 'Tolta dal giro: sul portale la perizia risulta chiusa.',
};

// Inizio comune delle righe "già fissato" (con o senza la data)
const PORTAL_FIXED_PREFIX = 'Tolta dal giro: sul portale il sopralluogo risulta già fissato';

const itDate = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Riga delle note per una voce dell'elenco
export const exclusionNote = (e: Pick<GestionaleExclusion, 'reason' | 'fonte' | 'data'>): string => {
  if (e.fonte !== 'portale') return EXCLUSION_NOTE[e.reason];
  if (e.reason === 'concordata' && e.data && /^\d{4}-\d{2}-\d{2}$/.test(e.data)) {
    return `${PORTAL_FIXED_PREFIX} per il ${itDate(e.data)}.`;
  }
  return PORTAL_EXCLUSION_NOTE[e.reason];
};

// Unisce le esclusioni della pagina del gestionale con quelle ricavate dal
// portale: stessa pratica due volte -> una sola (vale la prima, cioè quella
// della pagina: il gestionale ha la precedenza, contratto §6)
export const mergeExclusions = (...lists: GestionaleExclusion[][]): GestionaleExclusion[] => {
  const seen = new Set<string>();
  const out: GestionaleExclusion[] = [];
  for (const list of lists) {
    for (const e of list) {
      const key = codeKey(e.codice);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
};

// Elenco "excluded" della risposta del gestionale: si tengono solo le voci
// con un codice non vuoto e uno dei tre motivi; il resto si ignora. La fonte
// si tiene solo se è "portale"; con quella fonte si tiene anche la data del
// sopralluogo fissato, se è una data valida (finisce nella riga delle note).
// Mancante o non valido = elenco vuoto.
export const parseExcluded = (raw: unknown): GestionaleExclusion[] => {
  if (!Array.isArray(raw)) return [];
  const out: GestionaleExclusion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.codice !== 'string' || !r.codice.trim()) continue;
    if (typeof r.reason !== 'string' || !REASONS.includes(r.reason as ExclusionReason)) continue;
    const portale = r.fonte === 'portale';
    const data = portale && typeof r.data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.data) ? r.data : undefined;
    out.push({
      codice: r.codice.trim(),
      reason: r.reason as ExclusionReason,
      ...(portale ? { fonte: 'portale' as const } : {}),
      ...(data ? { data } : {}),
    });
  }
  return out;
};

export interface ExclusionChange {
  id: string;
  codice: string;
  reason: ExclusionReason;
  fonte?: 'portale';
}

export interface ExclusionOptions {
  now: Date;
  // Base del giorno del tecnico (per ricalcolare i viaggi del giro lasciato)
  dayBase?: (technicianId: string | undefined, date: string) => { base: Coordinates | null } | undefined;
}

// Una riga già scritta da noi nelle note (dal gestionale o dal portale): se
// l'operatore ha poi ripristinato la pratica, la sua scelta vale e non la si
// toglie di nuovo.
export const alreadyExcludedOnce = (notes?: string): boolean =>
  !!notes && [...Object.values(EXCLUSION_NOTE), ...Object.values(PORTAL_EXCLUSION_NOTE), PORTAL_FIXED_PREFIX]
    .some(line => notes.includes(line));

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
      notes: appendLine(a.notes, exclusionNote(hit)),
    }, ctx);
    removed.push({ id: a.id, codice: hit.codice, reason: hit.reason, ...(hit.fonte ? { fonte: hit.fonte } : {}) });
  }
  return { list, removed };
};
