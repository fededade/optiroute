import { unzipSync } from 'fflate';
import type { Coordinates, IssueType } from '../types';

// Import da Google My Maps (KMZ/KML): ogni livello della mappa diventa un
// gruppo di pratiche da smistare verso uno stato di OptiRoute. Le coordinate
// sono già nel file, quindi non serve alcun geocoding.

export type KmzTargetKind = 'skip' | 'confirmed' | 'pending' | 'standby' | 'issue' | 'cancelled';

export interface KmzTarget {
  kind: KmzTargetKind;
  date?: string;        // YYYY-MM-DD, per kind 'confirmed'
  issueType?: IssueType; // per kind 'issue'
}

export interface KmzPlacemark {
  rawName: string;
  address: string;       // prima riga del nome, ripulita da date/orari
  coords: Coordinates;
  title?: string;        // intestatari (da "intestati ..." nella descrizione)
  phone?: string;        // primo numero di telefono trovato
  notes?: string;        // riferimento banca + storico + contatti
  timeGuess?: string;    // HH:MM se nel nome c'è un orario
  issueGuess?: IssueType; // problematica rilevata nel testo della scheda
  techGuess?: string;    // nome dopo "slp ..." (es. "federica")
}

export interface KmzLayer {
  name: string;
  placemarks: KmzPlacemark[];
  suggested: KmzTarget;
}

const pad = (n: number) => String(n).padStart(2, '0');

// "9/07" -> data completa nell'anno che rende la data più vicina a oggi
// (gestisce sia pianificazioni future sia storici di fine anno precedente).
export const resolveDayMonth = (day: number, month: number, today = new Date()): string | undefined => {
  if (day < 1 || day > 31 || month < 1 || month > 12) return undefined;
  const y = today.getFullYear();
  let best: Date | null = null;
  for (const yy of [y - 1, y, y + 1]) {
    const candidate = new Date(yy, month - 1, day);
    if (candidate.getDate() !== day) continue; // data inesistente (es. 30/02)
    if (!best || Math.abs(candidate.getTime() - today.getTime()) < Math.abs(best.getTime() - today.getTime())) {
      best = candidate;
    }
  }
  return best ? `${best.getFullYear()}-${pad(best.getMonth() + 1)}-${pad(best.getDate())}` : undefined;
};

// La descrizione di My Maps è HTML "appiattito": <br> come separatore di riga
const htmlToLines = (html: string): string[] =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => l.length > 0);

// Primo numero di telefono italiano nel testo (cellulare 3xx o fisso 0xx),
// evitando i codici pratica tipo "PW000618538" (bloccati dal contesto alfanumerico).
const extractPhone = (text: string): string | undefined => {
  const re = /(^|[^0-9A-Za-z])(\+?39[\s.]?)?((?:3\d{2}|0\d{2,3})[\s.\/-]?\d{6,8})(?!\d)/;
  const m = re.exec(text);
  if (!m) return undefined;
  const number = m[3].replace(/[\s.\/-]/g, '');
  return `${m[2] ? '+39 ' : ''}${number}`.trim();
};

// Problematica desunta dal testo della scheda
export const detectIssueType = (text: string): IssueType | undefined => {
  const t = text.toLowerCase();
  if (/numer[oi][^\n]{0,30}(non\s+corrett|sbagliat|errat)|nr[- ]?non corretto|numero non valido/.test(t)) return 'wrong_phone';
  if (/non\s+ultimat|da\s+ultimare|lavori\s+(in\s+corso|non\s+finiti)|immobile\s+non\s+ultimato/.test(t)) return 'works_pending';
  if (/richiam|sospension|sospes/.test(t)) return 'callback';
  return undefined;
};

// Ripulisce la prima riga del nome (indirizzo) da code di pianificazione:
// "… 9/07 ore 9:00", "-18/11 15:30/45 - …", "- OK mercoledì …", "(indirizzo corretto)".
// I civici tipo "52/53" non vengono toccati (serve un orario dopo la data).
const cleanAddressLine = (line: string): { address: string; trimmed?: string } => {
  let addr = line.replace(/\s*\(indirizzo[^)]*\)/gi, ' ');
  let cutAt = addr.length;

  const patterns = [
    /\s*[-–]\s*ok\b.*$/i,                                          // "- OK mercoledì 20/11 …"
    /\s*\bok\b\s+(?:luned|marted|mercol|gioved|vener|sabato|domen|\d{1,2}\/\d{1,2}).*$/i,
    /\s*[-–]?\s*\b(\d{1,2})\/(\d{1,2})\b\s*(?:ore\b|h\b|\d{1,2}[:.]\d{2}).*$/i, // "9/07 ore 9:00", "-18/11 15:30"
    /\s*[-–]\s*\b(\d{1,2})\/(\d{1,2})\b.*$/,                       // "-18/11 …" (data dopo trattino)
  ];

  for (const re of patterns) {
    const m = re.exec(addr);
    if (!m) continue;
    // Se il pattern cattura giorno/mese, dev'essere una data plausibile (non un civico "52/53")
    if (m[1] && m[2]) {
      const d = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    }
    if (m.index < cutAt) cutAt = m.index;
  }

  const address = addr.slice(0, cutAt).replace(/\s+/g, ' ').replace(/[\s,;:–-]+$/, '').trim();
  const trimmed = addr.slice(cutAt).trim();
  return { address: address || line.trim(), trimmed: trimmed || undefined };
};

// Orario del sopralluogo: prima si cerca vicino alla data del livello
// ("13/07 ore 8:45"), poi il primo "ore …" nel testo.
const extractTime = (name: string, layerDay?: { day: number; month: number }): string | undefined => {
  const toHHMM = (h: string, m?: string): string | undefined => {
    const hh = parseInt(h, 10);
    const mm = m ? parseInt(m, 10) : 0;
    if (isNaN(hh) || hh < 0 || hh > 23 || isNaN(mm) || mm < 0 || mm > 59) return undefined;
    return `${pad(hh)}:${pad(mm)}`;
  };

  if (layerDay) {
    const re = new RegExp(
      `0?${layerDay.day}\\s*/\\s*0?${layerDay.month}[^0-9\\n]{0,12}(?:ore\\s*)?(\\d{1,2})(?:[:.](\\d{2}))?`,
      'i'
    );
    const m = re.exec(name);
    if (m) {
      const t = toHHMM(m[1], m[2]);
      if (t) return t;
    }
  }

  const generic = /\bore\s*(\d{1,2})(?:[:.](\d{2}))?/i.exec(name);
  if (generic) return toHHMM(generic[1], generic[2]);
  return undefined;
};

// Suggerimento di destinazione in base al nome del livello di My Maps
export const suggestLayerTarget = (layerName: string): KmzTarget => {
  const n = layerName.trim().toLowerCase();

  if (/perit|tecnic/.test(n)) return { kind: 'skip' };

  const dateMatch = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(n);
  if (dateMatch) {
    const date = resolveDayMonth(parseInt(dateMatch[1], 10), parseInt(dateMatch[2], 10));
    if (date) return { kind: 'confirmed', date };
  }

  if (/annullat|cancellat/.test(n)) return { kind: 'cancelled' };
  if (/sospension|sospes|richiam/.test(n)) return { kind: 'issue', issueType: 'callback' };
  if (/lavor|ultimar|ultimat/.test(n)) return { kind: 'issue', issueType: 'works_pending' };
  if (/numer/.test(n)) return { kind: 'issue', issueType: 'wrong_phone' };

  return { kind: 'pending' };
};

const parsePlacemark = (pm: Element, layerName: string): KmzPlacemark | null => {
  // Solo segnaposti puntuali (niente linee/poligoni)
  if (pm.getElementsByTagNameNS('*', 'Point').length === 0) return null;
  const coordText = pm.getElementsByTagNameNS('*', 'coordinates')[0]?.textContent?.trim();
  if (!coordText) return null;
  const [lngStr, latStr] = coordText.split(',');
  const lng = parseFloat(lngStr);
  const lat = parseFloat(latStr);
  if (isNaN(lat) || isNaN(lng)) return null;

  const childText = (local: string): string => {
    const el = Array.from(pm.children).find(c => c.localName === local);
    return (el?.textContent || '').replace(/ /g, ' ').trim();
  };

  const rawName = childText('name');
  const rawDesc = childText('description');

  const nameLines = rawName.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const firstLine = nameLines[0] || '';
  const { address, trimmed } = cleanAddressLine(firstLine);

  const descLines = htmlToLines(rawDesc);

  // Riferimento pratica: la prima riga della descrizione (es. "ISP 826.606",
  // "CER Banco Popolare PW000618538"), se breve e con almeno una cifra
  let reference: string | undefined;
  let bodyLines = descLines;
  if (descLines.length > 0 && descLines[0].length <= 60 && /\d/.test(descLines[0]) && !/^intestat/i.test(descLines[0])) {
    reference = descLines[0];
    bodyLines = descLines.slice(1);
  }

  // Intestatari -> titolo della pratica
  let title: string | undefined;
  const remaining: string[] = [];
  for (const line of bodyLines) {
    const m = /^intestati:?\s*(.+)$/i.exec(line);
    if (!title && m && m[1].trim()) {
      title = m[1].trim();
    } else {
      remaining.push(line);
    }
  }

  const phone = extractPhone([...remaining, rawName].join('\n'));

  // Data del livello (se è del tipo "9/07") per agganciare l'orario giusto
  const layerDate = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(layerName.trim());
  const timeGuess = extractTime(rawName, layerDate
    ? { day: parseInt(layerDate[1], 10), month: parseInt(layerDate[2], 10) }
    : undefined);

  const techMatch = /\bslp\s+([a-zà-ù]{2,})/i.exec(rawName);

  const notesParts: string[] = [];
  if (reference) notesParts.push(`Rif: ${reference}`);
  if (trimmed) notesParts.push(trimmed);
  notesParts.push(...nameLines.slice(1));
  notesParts.push(...remaining);

  return {
    rawName,
    address,
    coords: { lat, lng },
    title,
    phone,
    notes: notesParts.join('\n') || undefined,
    timeGuess,
    issueGuess: detectIssueType(`${rawName}\n${rawDesc}`),
    techGuess: techMatch ? techMatch[1].toLowerCase() : undefined,
  };
};

export const parseKmzFile = async (file: File): Promise<KmzLayer[]> => {
  const buffer = new Uint8Array(await file.arrayBuffer());

  let kmlText: string;
  if (/\.kml$/i.test(file.name)) {
    kmlText = new TextDecoder('utf-8').decode(buffer);
  } else {
    const entries = unzipSync(buffer);
    const kmlEntry = Object.keys(entries).find(k => /\.kml$/i.test(k));
    if (!kmlEntry) throw new Error('Nessun file KML trovato dentro il KMZ.');
    kmlText = new TextDecoder('utf-8').decode(entries[kmlEntry]);
  }

  const dom = new DOMParser().parseFromString(kmlText, 'application/xml');
  if (dom.getElementsByTagName('parsererror').length > 0) {
    throw new Error('File KML non valido.');
  }

  const layers: KmzLayer[] = [];
  const folders = Array.from(dom.getElementsByTagNameNS('*', 'Folder'));
  const seenPlacemarks = new Set<Element>();

  for (const folder of folders) {
    const nameEl = Array.from(folder.children).find(c => c.localName === 'name');
    const layerName = (nameEl?.textContent || 'Livello senza nome').trim();
    const pms = Array.from(folder.getElementsByTagNameNS('*', 'Placemark'));
    pms.forEach(pm => seenPlacemarks.add(pm));

    const placemarks = pms
      .map(pm => parsePlacemark(pm, layerName))
      .filter((p): p is KmzPlacemark => p !== null);

    if (placemarks.length > 0) {
      layers.push({ name: layerName, placemarks, suggested: suggestLayerTarget(layerName) });
    }
  }

  // Segnaposti fuori da qualsiasi livello
  const loose = Array.from(dom.getElementsByTagNameNS('*', 'Placemark'))
    .filter(pm => !seenPlacemarks.has(pm))
    .map(pm => parsePlacemark(pm, ''))
    .filter((p): p is KmzPlacemark => p !== null);
  if (loose.length > 0) {
    layers.push({ name: 'Senza livello', placemarks: loose, suggested: { kind: 'pending' } });
  }

  if (layers.length === 0) throw new Error('Nessun segnaposto trovato nel file.');
  return layers;
};
