import { parseFollowUpDate } from './callService';

// Quando il cliente chiede di essere richiamato ("sentitemi tra dieci minuti",
// "richiamate alle 17:30", "domani alle 10"): dal testo libero raccolto in
// chiamata all'istante del richiamo. Funzioni PURE, usate dal browser e dal
// motore lato server (tramite toCallOutcome).
// Nel dubbio nessun valore: il pilota si comporta come prima (decide l'operatore).

const pad = (n: number) => String(n).padStart(2, '0');
const dayStr = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number): string => dayStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
const at = (day: string, h: number, m: number): Date => {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0);
};

// minuscolo, senza accenti, apostrofi come spazi, spazi singoli
const norm = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`´]/g, ' ').replace(/\s+/g, ' ').trim();

const WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9,
  dieci: 10, undici: 11, dodici: 12, quindici: 15, venti: 20, trenta: 30, quaranta: 40,
  quarantacinque: 45, cinquanta: 50, sessanta: 60, novanta: 90,
};
// "quarantacinque" prima di "quaranta", "dodici" prima di "due"...
const WORD_RE = Object.keys(WORDS).sort((x, y) => y.length - x.length).join('|');
const NUM = `(\\d{1,3}|${WORD_RE})`;
const toNum = (s: string): number => (/^\d+$/.test(s) ? parseInt(s, 10) : WORDS[s]);

const TRA = '\\b(?:tra|fra)\\s+(?:circa\\s+)?';

// "tra N minuti", "tra un quarto d'ora", "tra mezz'ora", "tra un'ora (e mezza)",
// "tra N ore (e mezza)", "tra un paio d'ore" -> minuti (undefined se assente)
export const relativeMinutes = (text: string): number | undefined => {
  const t = norm(text);
  if (new RegExp(`${TRA}un quarto d\\s?ora\\b`).test(t)) return 15;
  if (new RegExp(`${TRA}(?:una\\s+)?mezz\\s?ora\\b`).test(t)) return 30;
  if (new RegExp(`${TRA}un paio d\\s?ore\\b`).test(t)) return 120;
  let m = new RegExp(`${TRA}${NUM}\\s+(?:minuti|minuto|min)\\b`).exec(t);
  if (m) return toNum(m[1]);
  m = new RegExp(`${TRA}(un|${NUM.slice(1, -1)})\\s+(?:ora|ore)(\\s+e\\s+mezz[ao])?\\b`).exec(t);
  if (m) return toNum(m[1]) * 60 + (m[2] ? 30 : 0);
  return undefined;
};

// Giorno indicato nel testo: data scritta, "oggi", "domani", "dopodomani",
// giorno della settimana (il prossimo). undefined se assente.
const WEEKDAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const dayInText = (t: string, ref: Date): string | undefined => {
  const explicit = parseFollowUpDate(t);
  if (explicit) return explicit;
  if (/\bdopodomani\b/.test(t)) return addDays(ref, 2);
  if (/\bdomani\b/.test(t)) return addDays(ref, 1);
  if (/\b(?:oggi|stamattina|stamani|stasera)\b/.test(t)) return dayStr(ref);
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) {
      const diff = (i - ref.getDay() + 7) % 7 || 7;
      return addDays(ref, diff);
    }
  }
  return undefined;
};

// Ora del giorno: "alle 17", "alle 17:30", "ore 17.30", "verso le 17",
// "dopo le 17", "alle cinque". Le ore da 1 a 7 senza altro si intendono del
// pomeriggio ("alle 5" = 17:00): di notte non si chiama.
const HOUR_WORDS = 'una|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici';
const timeInText = (t: string): { h: number; m: number } | undefined => {
  const re = new RegExp(`\\b(?:alle|all|ore|verso le|verso l|dopo le|dopo l|per le|per l|dalle|dall)\\s+(\\d{1,2}|${HOUR_WORDS})(?:\\s*[:.]\\s*(\\d{2})|\\s+e\\s+(mezza|mezzo|un quarto|quarantacinque|trenta|quindici))?\\b`);
  const m = re.exec(t);
  if (!m) return undefined;
  let h = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORDS[m[1]];
  let min = 0;
  if (m[2]) min = parseInt(m[2], 10);
  else if (m[3]) min = m[3].startsWith('mezz') || m[3] === 'trenta' ? 30 : m[3] === 'quarantacinque' ? 45 : 15;
  if (h >= 1 && h <= 7) h += 12;
  if (h > 23 || min > 59) return undefined;
  return { h, m: min };
};

export interface ParsedCallback {
  at?: Date;     // istante del richiamo, se il testo lo indica
  day?: string;  // solo il giorno (AAAA-MM-GG), senza orario
}

// Un testo: istante (relativo o orario preciso) o almeno il giorno.
// `ref`: riferimento per i tempi relativi e per "oggi"; `contextDay`: giorno
// già noto (data di rientro normalizzata), se il testo non ne indica uno.
export const parseCallbackText = (text: string, ref: Date, contextDay?: string): ParsedCallback => {
  if (!text || !text.trim()) return {};
  const minutes = relativeMinutes(text);
  if (minutes !== undefined && minutes > 0) return { at: new Date(ref.getTime() + minutes * 60000) };

  const t = norm(text);
  const today = dayStr(ref);
  const ownDay = dayInText(t, ref);
  const day = ownDay || contextDay;
  const time = timeInText(t);
  if (time) {
    const d = at(day || today, time.h, time.m);
    return d.getTime() > ref.getTime() ? { at: d } : {};
  }
  // Parti della giornata: solo per oggi
  if (!day || day === today) {
    const part = /\b(?:nel pomeriggio|oggi pomeriggio|questo pomeriggio|di pomeriggio)\b/.test(t)
      ? 15
      : /\b(?:stasera|in serata|questa sera)\b/.test(t) ? 18 : undefined;
    if (part !== undefined) {
      const d = at(today, part, 0);
      return d.getTime() > ref.getTime() ? { at: d } : {};
    }
  }
  return ownDay ? { day: ownDay } : {};
};

export interface CallbackSources {
  minutes?: unknown;           // richiamo_tra_minuti (numero o testo numerico)
  texts: (string | undefined)[]; // orario_richiamo, data_richiamo/rientro, orario richiesto, note: in ordine
  followUpDate?: string;       // data già normalizzata (AAAA-MM-GG)
  ref: Date;                   // fine della chiamata, o arrivo dell'esito
  callWindowStart?: string;    // 'HH:MM' per "solo il giorno" (default 09:00)
}

const MAX_MINUTES = 14 * 24 * 60;

// Istante del richiamo chiesto dal cliente (ISO) o undefined
export const computeCallbackAt = (src: CallbackSources): string | undefined => {
  const { ref } = src;
  const n = typeof src.minutes === 'number' ? src.minutes
    : typeof src.minutes === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(src.minutes) ? parseFloat(src.minutes.replace(',', '.'))
    : NaN;
  if (Number.isFinite(n) && n > 0 && n <= MAX_MINUTES) return new Date(ref.getTime() + Math.round(n) * 60000).toISOString();

  let day = src.followUpDate;
  let dayFromText: string | undefined;
  for (const text of src.texts) {
    if (!text) continue;
    const p = parseCallbackText(text, ref, dayFromText || day);
    if (p.at) return p.at.toISOString();
    if (p.day && !dayFromText) dayFromText = p.day;
  }
  day = dayFromText || day;
  // Solo il giorno: all'inizio della fascia chiamate, ma mai per oggi
  // ("richiamatemi oggi" è troppo vago per richiamare subito)
  if (day && day > dayStr(ref)) {
    const [h, m] = (src.callWindowStart || '09:00').split(':').map(Number);
    return at(day, h || 0, m || 0).toISOString();
  }
  return undefined;
};
