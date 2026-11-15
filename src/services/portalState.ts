import type { Appointment, Coordinates } from '../types';
import type { BridgeFase, BridgePratica } from './bridgeService';
import type { ExclusionReason, GestionaleExclusion } from './gestionaleExclusions';
import { isCallInFlight } from './autopilotService';
import { codeKey, praticaKey } from './praticaCode';
import { localDateStr, removeFromRoute } from './slotService';

// Stato delle pratiche sul portale (contratto §6), funzioni PURE.
//
// Il bridge dice, per ogni pratica, in che fase è sul portale:
//  - fissato / effettuato / chiusa: la pratica NON va lavorata. Non si
//    importa come nuova e, se c'è già e non è confermata, esce dal lavoro
//    come le esclusioni del gestionale (stessa funzione, stesse tutele);
//  - sospesa: si importa, ma mai come lavoro normale. La nota di sospensione
//    decide: numero sbagliato o mancante (problematica "numero errato"),
//    lavori non finiti (problematica "lavori", con la data se c'è), da
//    richiamare (problematica "da richiamare", con la data se c'è),
//    disponibile da una data (in attesa, con la data di rientro), il resto
//    (es. "solo il sabato") da richiamare senza data: decide una persona.
// Fase assente o sconosciuta = come prima (da fissare).

// --- Esclusioni dal portale ---

const FASE_REASON: Partial<Record<BridgeFase, ExclusionReason>> = {
  fissato: 'concordata',
  effettuato: 'effettuata',
  chiusa: 'chiusa',
};

// La pratica del portale non va lavorata (né importata come nuova)
export const isPortalExcluded = (p: Pick<BridgePratica, 'fase'>): boolean => !!p.fase && !!FASE_REASON[p.fase];

// Esclusioni ricavate dallo snapshot del bridge (fonte "portale")
export const portalExclusions = (pratiche: Pick<BridgePratica, 'codice' | 'fase' | 'dataSopralluogo'>[]): GestionaleExclusion[] => {
  const out: GestionaleExclusion[] = [];
  for (const p of pratiche) {
    const reason = p.fase ? FASE_REASON[p.fase] : undefined;
    if (!reason || !p.codice?.trim()) continue;
    out.push({
      codice: p.codice.trim(),
      reason,
      fonte: 'portale',
      ...(reason === 'concordata' && p.dataSopralluogo ? { data: p.dataSopralluogo } : {}),
    });
  }
  return out;
};

// --- Classificazione della nota di sospensione ---

// richiamo = il cliente va richiamato; disponibilita = il cliente c'è solo da
// una data (o in certi giorni/orari); lavori = l'immobile non è pronto;
// numero = telefono sbagliato o mancante; altro = decide una persona
export type SuspensionKind = 'richiamo' | 'disponibilita' | 'lavori' | 'numero' | 'altro';

export interface SuspensionClass {
  kind: SuspensionKind;
  date?: string; // YYYY-MM-DD
}

// Minuscole, senza accenti, apostrofi come spazi ("lunedi'" = "lunedì")
const normalize = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`´]/g, ' ').replace(/\s+/g, ' ').trim();

// Parole chiave per classe (testo normalizzato). Abbreviazioni dell'ufficio:
// slp = sopralluogo, dispo/dispon. = disponibilità, nr = non risponde,
// sett = settimana, prox/pross = prossima, gg = giorni.
const NUMERO = [
  /\b(numero|recapito|telefono|cellulare|tel)\b[^.;]*?\b(non corrett|errat|sbagliat|inesistent|non attiv|mancant)/,
  /\b(manca|mancano|richiest[oa]|richiedere|chiesto|chiedere)\b[^.;]*?\b(numero|recapito|telefono|cellulare)\b/,
];
const LAVORI = [
  /\blavori\b[^.;]*?\b(non ultimat|da ultimar|non complet|non terminat|non finit|in corso)/,
  /\b(immobile|casa|appartamento|unita)\b[^.;]*?\b(non finit|non ultimat|non complet|non terminat|non pronto)/,
  /\b(cantiere|ristruttur|sanatori|difformit|agibilit)/,
];
const RICHIAMO = [
  // anche chiamare/chiamata, telefonare, contattare ("telefonare" non è
  // "numero": quello vuole le parole del numero sbagliato o mancante)
  /\b(richiam|ricontatt|risent|sentir|ritelefon|chiam|telefon|contatt|irraggiungibil|non raggiungibil|segreteria)/,
  /\bnon rispond/,
  /\bnr\b/,
  /\b(attendo|attendiamo|attende|in attesa)\b(?:\s+(?:di|della|del|dal|dalla|dello))?\s+(conferma|dispo|riscontro|rispost)/,
  /\b(fara|faranno|faremo) sapere\b/,
  /\bcomunicher/,
];
const DISPONIBILITA = [
  /\b(dispo|indispo|solo\b|non prima|a partire|rientr|torn|assent|fuori sede|ferie|ester[oa]\b|vacanz|trasfert|ricoverat|fino a)/,
  // giorni e fasce orarie in cui il cliente c'è ("giov-venerdi mattina")
  /\b(lunedi|martedi|mercoledi|giovedi|giov|venerdi|sabato|domenica|mattin|pomerig|dalle ore)\b/,
];
const matchesAny = (text: string, res: RegExp[]) => res.some(re => re.test(text));

const MONTHS: [string, number][] = [
  ['gennaio', 1], ['febbraio', 2], ['marzo', 3], ['aprile', 4], ['maggio', 5], ['giugno', 6],
  ['luglio', 7], ['agosto', 8], ['settembre', 9], ['ottobre', 10], ['novembre', 11], ['dicembre', 12],
];
// "sett" qui NON è settembre: per l'ufficio è "settimana"
const MONTH_ABBR: [string, number][] = [
  ['gen', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['mag', 5], ['giu', 6],
  ['lug', 7], ['ago', 8], ['set', 9], ['ott', 10], ['nov', 11], ['dic', 12],
];
const monthNumber = (word: string): number =>
  (MONTHS.find(([name]) => name === word) || MONTH_ABBR.find(([name]) => name === word))?.[1] ?? 0;

const MONTH_FULL = `(${MONTHS.map(([n]) => n).join('|')})`;
const MONTH_WORD = `(${MONTHS.map(([n]) => n).join('|')}|${MONTH_ABBR.map(([n]) => n).join('|')})`;

// Giorni della settimana (anche abbreviati), numero come Date.getUTCDay()
const WEEKDAYS: [string, number][] = [
  ['domenica', 0], ['dom', 0], ['lunedi', 1], ['lun', 1], ['martedi', 2], ['mar', 2], ['mercoledi', 3], ['mer', 3],
  ['giovedi', 4], ['giov', 4], ['gio', 4], ['venerdi', 5], ['ven', 5], ['sabato', 6], ['sab', 6],
];

// Date sul calendario (in UTC: niente sorprese con l'ora legale)
const utc = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const isoOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const addDays = (iso: string, n: number): string => isoOf(utc(iso) + n * 86400000);
const pad = (n: number) => String(n).padStart(2, '0');

const validDate = (y: number, m: number, d: number): string | undefined => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return undefined;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : undefined;
};

// Stesso giorno N mesi dopo, limitato alla fine del mese
const addMonths = (iso: string, n: number): string => {
  const m0 = Number(iso.slice(5, 7)) - 1 + n;
  const year = Number(iso.slice(0, 4)) + Math.floor(m0 / 12);
  const month = ((m0 % 12) + 12) % 12 + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(Number(iso.slice(8, 10)), last))}`;
};
const firstOfNextMonth = (iso: string): string => `${addMonths(`${iso.slice(0, 7)}-01`, 1)}`;

// Senza anno: l'anno che rende la data più VICINA a oggi (anche se passata)
const nearestYear = (m: number, d: number, today: string): string | undefined => {
  const y = Number(today.slice(0, 4));
  const now = utc(today);
  let best: string | undefined;
  for (const year of [y - 1, y, y + 1]) {
    const iso = validDate(year, m, d);
    if (iso && (!best || Math.abs(utc(iso) - now) < Math.abs(utc(best) - now))) best = iso;
  }
  return best;
};

const fullYear = (s: string): number => (s.length === 2 ? 2000 + Number(s) : Number(s));

// Espressione di data trovata nella nota.
// tier: 1 = data di calendario (anche un intervallo: vale il primo giorno);
//       2 = mese, parte del mese, "tra N giorni", "settimana prossima"...;
//       3 = domani / giorni della settimana (solo richiamo e lavori).
// monthOnly: solo il mese (con "fino a" vale il primo del mese dopo).
// forward: l'espressione stessa vuol dire "non prima di" (tra N, metà mese...).
interface Found { index: number; tier: 1 | 2 | 3; date?: string; monthOnly?: boolean; forward?: boolean }

// Né dentro un altro numero né subito dopo "tra/fra" ("tra 2 sett" non è una data di calendario)
const NOT_AFTER = '(?<![\\d/.-])(?<!\\b(?:tra|fra)\\s)';
const NUM_WORDS: Record<string, number> = { un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6 };

const findDates = (text: string, today: string): Found[] => {
  const out: Found[] = [];
  const scan = (re: RegExp, f: (m: RegExpExecArray) => Omit<Found, 'index'>) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ index: m.index, ...f(m) });
  };
  const dm = (d: string | number, m: number, y?: string) => (y ? validDate(fullYear(y), m, Number(d)) : nearestYear(m, Number(d), today));
  const partDay = (w: string) => (w === 'meta' ? 15 : w === 'fine' ? 25 : 1);

  // --- 1: date di calendario ---
  // 2026-11-20
  scan(/(?<![\d/.-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d/.-]*\d)/g, m => ({ tier: 1, date: validDate(Number(m[1]), Number(m[2]), Number(m[3])) }));
  // intervalli "9-11/12", "dal 9 all'11/12", "9-11 dicembre": il primo giorno
  scan(new RegExp(`${NOT_AFTER}(\\d{1,2})\\s*(?:-|\\bal\\b|\\ball\\b|\\balla\\b)\\s*\\d{1,2}\\/(\\d{1,2})(?:\\/(\\d{4}|\\d{2}))?(?![\\d/])`, 'g'),
    m => ({ tier: 1, date: dm(m[1], Number(m[2]), m[3]) }));
  scan(new RegExp(`${NOT_AFTER}(\\d{1,2})\\s*(?:-|\\bal\\b|\\ball\\b|\\balla\\b)\\s*\\d{1,2}\\s+${MONTH_WORD}\\b\\.?(?:\\s+(\\d{4}))?`, 'g'),
    m => ({ tier: 1, date: dm(m[1], monthNumber(m[2]), m[3]) }));
  // 20/11, 20/11/26, 20/11/2026
  scan(new RegExp(`${NOT_AFTER}(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{4}|\\d{2}))?(?![\\d/])`, 'g'), m => ({ tier: 1, date: dm(m[1], Number(m[2]), m[3]) }));
  // 20-11-2026, 20.11.2026 (il punto solo con l'anno: "17.30" è un orario)
  scan(/(?<![\d/.-])(\d{1,2})([.-])(\d{1,2})\2(\d{4})(?![\d.-]*\d)/g, m => ({ tier: 1, date: validDate(Number(m[4]), Number(m[3]), Number(m[1])) }));
  // "20 novembre", "3 dic", "1° dicembre 2027"
  scan(new RegExp(`${NOT_AFTER}(\\d{1,2})\\s*[°º]?\\s*${MONTH_WORD}\\b\\.?(?:\\s+(\\d{4}))?`, 'g'), m => ({ tier: 1, date: dm(m[1], monthNumber(m[2]), m[3]) }));

  // --- 2: mesi e date relative ---
  // "inizio / primi di gennaio" = 1, "metà dicembre" = 15, "fine novembre" = 25
  scan(new RegExp(`\\b(inizio|primi|meta|fine)\\s+(?:di\\s+|del\\s+mese\\s+di\\s+)?${MONTH_WORD}\\b(?:\\s+(\\d{4}))?`, 'g'),
    m => ({ tier: 2, forward: true, date: dm(partDay(m[1]), monthNumber(m[2]), m[3]) }));
  // "metà mese", "fine mese": di questo mese se ancora futuro, se no del
  // prossimo; "fine mese prossimo": del prossimo
  scan(/\b(inizio|meta|fine)\s+(?:del\s+)?mese\b(\s+(?:prossimo|prox|pross)\b)?/g, m => {
    const day = pad(partDay(m[1]));
    const thisMonth = `${today.slice(0, 7)}-${day}`;
    const next = `${firstOfNextMonth(today).slice(0, 7)}-${day}`;
    return { tier: 2, forward: true, date: m[2] || thisMonth <= today ? next : thisMonth };
  });
  // il solo mese ("a gennaio", "da dicembre 2027"): il giorno 1
  scan(new RegExp(`\\b${MONTH_FULL}\\b(?:\\s+(\\d{4}))?`, 'g'), m => ({ tier: 2, monthOnly: true, date: dm(1, monthNumber(m[1]), m[2]) }));
  // "tra/fra N giorni|gg|settimane|sett|mesi" (mese = stesso giorno del mese dopo)
  scan(/\b(?:tra|fra)\s+(\d{1,3}|un|uno|una|due|tre|quattro|cinque|sei)\s*(giorni|giorno|gg|settimane|settimana|sett|mesi|mese)\b/g, m => {
    const n = NUM_WORDS[m[1]] ?? Number(m[1]);
    const date = m[2].startsWith('mes') ? addMonths(today, n) : addDays(today, m[2].startsWith('sett') ? 7 * n : n);
    return { tier: 2, forward: true, date };
  });
  // "settimana prossima", "sett prox", "sett. pross.": il lunedì dopo
  // ("in settimana" non è una data)
  const nextMonday = addDays(today, ((1 - new Date(utc(today)).getUTCDay() + 7) % 7) || 7);
  scan(/\b(?:settimana|sett)\.?\s+(?:prossima|prox|pross)\b|\b(?:prossima|prox|pross)\.?\s+(?:settimana|sett)\b/g,
    () => ({ tier: 2, forward: true, date: nextMonday }));
  // "mese prossimo": il primo del mese dopo
  scan(/(?<!\b(?:inizio|meta|fine)\s+(?:del\s+)?)\b(?:mese\s+(?:prossimo|prox|pross)|(?:prossimo|prox|pross)\.?\s+mese)\b/g,
    () => ({ tier: 2, forward: true, date: firstOfNextMonth(today) }));
  // Giorno del mese SENZA mese ("dopo il 19", "dal 25", "fino al 20"): solo
  // dopo il/dal/del/dall'/dell'/al (quindi mai "alle 19", "le 19", "ore 19",
  // "via Roma 19") e mai seguito da ":30", ".30", ",5", "/11", gg/giorni/ore/
  // %/anni/mesi/settimane, "°", piano/scala/interno o dal nome del mese (data
  // completa, livello 1). Il mese: quello che rende la data più vicina a oggi
  // (scorso, questo o prossimo; un giorno che nel mese non c'è salta il mese);
  // con "dal", "dopo il", "fino al"… ("non prima di") il più vicino non passato.
  scan(new RegExp(`(?<=\\b(?:il|dal|del|dall|dell|al)\\s)(\\d{1,2})(?!\\d)(?![:.,/]\\d)(?!\\s*[°º%])`
    + `(?!\\s*(?:gg|giorni|giorno|ore|anni|anno|mesi|mese|settimane|settimana|sett|piano|piani|scala|interno|int)\\b)`
    + `(?!\\s*${MONTH_WORD}\\b)`, 'g'), m => {
    const day = Number(m[1]);
    const before = text.slice(0, m.index);
    const notBefore = FROM_BEFORE.test(before) || UNTIL_BEFORE.test(before);
    const y = Number(today.slice(0, 4));
    const mo = Number(today.slice(5, 7));
    const now = utc(today);
    let best: string | undefined;
    for (const k of [-1, 0, 1]) {
      const m0 = mo - 1 + k;
      const iso = validDate(y + Math.floor(m0 / 12), ((m0 % 12) + 12) % 12 + 1, day);
      if (!iso || (notBefore && iso < today)) continue;
      if (!best || Math.abs(utc(iso) - now) < Math.abs(utc(best) - now)) best = iso;
    }
    return { tier: 2, date: best };
  });

  // --- 3: domani, giorni della settimana (il prossimo, mai oggi) ---
  scan(/\b(dopodomani|domani)\b/g, m => ({ tier: 3, date: addDays(today, m[1] === 'domani' ? 1 : 2) }));
  const todayDow = new Date(utc(today)).getUTCDay();
  scan(new RegExp(`\\b(${WEEKDAYS.map(([w]) => w).join('|')})\\b(?!\\s*\\d)`, 'g'), m => {
    const dow = WEEKDAYS.find(([w]) => w === m[1])?.[1] ?? todayDow;
    return { tier: 3, date: addDays(today, ((dow - todayDow + 7) % 7) || 7) };
  });
  return out;
};

// La prima data valida del livello più preciso (in ordine nel testo)
const pick = (found: Found[], maxTier: 2 | 3): Found | undefined =>
  found.filter(f => f.date && f.tier <= maxTier).sort((a, b) => a.tier - b.tier || a.index - b.index)[0];

// "fino al 20/11" -> dal giorno DOPO; "fino a dicembre" -> dal primo del mese dopo
const UNTIL_BEFORE = /\bfino\s*(?:al|alla|allo|a|ad|all)?\s*(?:il\s*)?$/;
// "dopo il…", "dal…", "a partire da…": non prima di quella data
const FROM_BEFORE = /\b(?:dopo(?:\s+(?:il|la|l))?|dal|dalla|dall|dai|da|a partire(?:\s+(?:da|dal|dalla))?)\s*$/;

const resolve = (text: string, hit: Found): string => {
  if (!UNTIL_BEFORE.test(text.slice(0, hit.index))) return hit.date!;
  return hit.monthOnly ? firstOfNextMonth(hit.date!) : addDays(hit.date!, 1);
};

// Precedenza se ne valgono più d'una: numero > lavori > richiamo > disponibilità > altro
export const classifySuspension = (nota: string, oggi: string): SuspensionClass => {
  const text = normalize(nota || '');
  if (!text) return { kind: 'altro' };
  const today = oggi.slice(0, 10);

  if (matchesAny(text, NUMERO)) return { kind: 'numero' };

  const found = findDates(text, today);
  // Lavori e richiamo: valgono anche domani e i giorni della settimana
  for (const [kind, res] of [['lavori', LAVORI], ['richiamo', RICHIAMO]] as const) {
    if (!matchesAny(text, res)) continue;
    const hit = pick(found, 3);
    return hit ? { kind, date: resolve(text, hit) } : { kind };
  }

  // Disponibilità: giorni della settimana e orari NON sono date
  if (matchesAny(text, DISPONIBILITA)) {
    const hit = pick(found, 2);
    return hit ? { kind: 'disponibilita', date: resolve(text, hit) } : { kind: 'disponibilita' };
  }

  // Nessuna parola chiave, ma un "non prima di" con una data ("dopo il 30/11",
  // "tra 1 mese", "settimana prossima", "fino al 22/11"): disponibilità
  const cued = found.filter(f => f.forward || UNTIL_BEFORE.test(text.slice(0, f.index)) || FROM_BEFORE.test(text.slice(0, f.index)));
  const hit = pick(cued, 2);
  return hit ? { kind: 'disponibilita', date: resolve(text, hit) } : { kind: 'altro' };
};

// --- Applicazione alle pratiche ---

// Impronta della nota applicata (testo ripulito; "-" se vuota)
export const suspensionFingerprint = (nota: string | undefined): string => (nota || '').replace(/\s+/g, ' ').trim() || '-';

// Riga aggiunta alle note. Nota vuota: spesso il bridge non l'ha ancora
// letta (ne legge poche per giro), quindi "non disponibile"
export const suspensionNoteLine = (nota: string | undefined): string => {
  const t = (nota || '').replace(/\s+/g, ' ').trim();
  return t ? `Sospesa sul portale: ${t}` : 'Sospesa sul portale (nota non disponibile).';
};

// Riga scritta da noi (anche nelle forme di prima, es. "(nessuna nota).")
const isSuspensionLine = (line: string): boolean => /^Sospesa sul portale(?::\s| \()/.test(line.trim());

// Stato che la sospensione ha dato alla pratica, in forma compatta
// ("issue|callback|2026-11-20", "pending||2026-11-25")
export const suspensionState = (a: Pick<Appointment, 'status' | 'issueType' | 'followUpDate'>): string =>
  `${a.status}|${a.issueType || ''}|${a.followUpDate || ''}`;

// La pratica è ancora ESATTAMENTE nello stato che le aveva dato la
// sospensione: nessuno l'ha toccata
export const suspensionUntouched = (a: Appointment): boolean =>
  !!a.portalSuspensionState && suspensionState(a) === a.portalSuspensionState;

// Stato della pratica (in attesa o proposta) secondo la nota
export const suspensionChanges = (cls: SuspensionClass): Partial<Appointment> => {
  switch (cls.kind) {
    case 'numero': return { status: 'issue', issueType: 'wrong_phone', followUpDate: undefined };
    case 'lavori': return { status: 'issue', issueType: 'works_pending', followUpDate: cls.date };
    case 'richiamo': return { status: 'issue', issueType: 'callback', followUpDate: cls.date };
    case 'disponibilita':
      if (cls.date) return { status: 'pending', issueType: undefined, followUpDate: cls.date };
      return { status: 'issue', issueType: 'callback', followUpDate: undefined };
    default: return { status: 'issue', issueType: 'callback', followUpDate: undefined };
  }
};

export interface SuspensionChange {
  id: string;
  codice: string;
  kind: SuspensionKind;
  date?: string;
  statusChanged: boolean; // false: solo riga e impronta (pratica in altri stati)
}

export interface SuspensionOptions {
  now: Date;
  today?: string; // YYYY-MM-DD (default: la data locale di now)
  // Base del giorno del tecnico (per ricalcolare i viaggi del giro lasciato)
  dayBase?: (technicianId: string | undefined, date: string) => { base: Coordinates | null } | undefined;
}

// La riga della sospensione SOSTITUISCE quella scritta prima (al suo posto);
// le altre note non si toccano. Nessuna riga di prima: in fondo.
const withLine = (notes: string | undefined, line: string): string => {
  const lines = (notes || '').split('\n');
  const at = lines.findIndex(isSuspensionLine);
  if (at < 0) return notes && notes.trim() ? `${notes.replace(/\s+$/, '')}\n${line}` : line;
  return lines.flatMap((l, i) => (i === at ? [line] : isSuspensionLine(l) ? [] : [l])).join('\n');
};

// Note senza la riga della sospensione
const withoutLine = (notes: string | undefined): string =>
  (notes || '').split('\n').filter(l => !isSuspensionLine(l)).join('\n').replace(/\s+$/, '');

// Senza impronta e stato dato dalla sospensione
const withoutSuspension = (a: Appointment): Appointment => {
  const rest = { ...a };
  delete rest.portalSuspension;
  delete rest.portalSuspensionState;
  return rest;
};

// Applica la sospensione del portale alle pratiche dello snapshot con fase
// "sospesa" (pratiche appena importate comprese: sono in attesa).
//  - in attesa o proposte, oppure ancora ESATTAMENTE nello stato che le aveva
//    dato la sospensione (nessuno l'ha toccata: es. prima la nota vuota, poi
//    quella vera): stato dalla nota (proposta: esce dal giro; chiamata in
//    coda tolta) + riga nelle note + impronta + stato dato (portalSuspensionState);
//  - cambiate dall'operatore (problematiche, stand-by, annullate): solo riga
//    e impronta;
//  - confermate e con una chiamata in corso: mai toccate.
// La riga non si accumula: quella scritta prima viene sostituita.
// Stessa impronta = niente (le scelte successive dell'operatore restano);
// nota cambiata sul portale = si riapplica. Pratica nello snapshot ma non più
// sospesa: se è ancora nello stato che le avevamo dato torna in attesa (senza
// la data e senza la nostra riga, in `restored`); altrimenti si tolgono solo
// impronta e stato dato. Pratica assente dallo snapshot: niente.
export const applyPortalSuspensions = (
  all: Appointment[],
  pratiche: Pick<BridgePratica, 'codice' | 'fase' | 'sospensione'>[],
  opts: SuspensionOptions
): { list: Appointment[]; applied: SuspensionChange[]; cleared: string[]; restored: string[] } => {
  const byKey = new Map<string, Pick<BridgePratica, 'codice' | 'fase' | 'sospensione'>>();
  for (const p of pratiche) {
    const key = codeKey(p.codice);
    if (key && !byKey.has(key)) byKey.set(key, p);
  }
  if (byKey.size === 0) return { list: all, applied: [], cleared: [], restored: [] };

  const today = opts.today || localDateStr(opts.now);
  let list = all;
  const applied: SuspensionChange[] = [];
  const cleared: string[] = [];
  const restored: string[] = [];
  for (const a of all) {
    const key = praticaKey(a);
    const p = key ? byKey.get(key) : undefined;
    if (!p) continue;

    if (p.fase !== 'sospesa') {
      if (a.portalSuspension === undefined && a.portalSuspensionState === undefined) continue;
      const untouched = suspensionUntouched(a) && a.status !== 'confirmed';
      // Stato nostro ma chiamata in corso: si riprova al prossimo scaricamento
      if (untouched && isCallInFlight(a, opts.now)) continue;
      list = list.map(x => {
        if (x.id !== a.id) return x;
        const rest = withoutSuspension(x);
        return untouched
          ? { ...rest, status: 'pending' as const, issueType: undefined, followUpDate: undefined, notes: withoutLine(x.notes) || undefined }
          : rest;
      });
      cleared.push(a.id);
      if (untouched) restored.push(a.id);
      continue;
    }

    const nota = p.sospensione?.nota || '';
    const fingerprint = suspensionFingerprint(nota);
    if (a.portalSuspension === fingerprint) continue;
    if (a.status === 'confirmed') continue;
    if (isCallInFlight(a, opts.now)) continue;

    const notes = withLine(a.notes, suspensionNoteLine(nota));
    const cls = classifySuspension(nota, today);
    const change = { id: a.id, codice: p.codice, kind: cls.kind, ...(cls.date ? { date: cls.date } : {}) };
    if (a.status === 'pending' || a.status === 'proposed' || suspensionUntouched(a)) {
      // Come quando la pratica esce dal giro: slot liberato, giro ricalcolato,
      // coda delle chiamate svuotata
      const ctx = a.date ? opts.dayBase?.(a.technicianId, a.date) : undefined;
      const changes = suspensionChanges(cls);
      const state = suspensionState({ status: changes.status!, issueType: changes.issueType, followUpDate: changes.followUpDate });
      list = removeFromRoute(list, a.id, { ...changes, notes, portalSuspension: fingerprint, portalSuspensionState: state }, ctx);
      applied.push({ ...change, statusChanged: true });
    } else {
      // Cambiata dall'operatore: solo riga e impronta (nessuno stato dato)
      list = list.map(x => (x.id === a.id ? { ...withoutSuspension(x), notes, portalSuspension: fingerprint } : x));
      applied.push({ ...change, statusChanged: false });
    }
  }
  return { list, applied, cleared, restored };
};
