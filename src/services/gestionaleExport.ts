import type { Appointment, Technician } from '../types';
import { codeKey, displayCode, displayNotes } from './praticaCode';

// Elenco dei sopralluoghi CONFERMATI da consegnare al gestionale
// (GET /api/cloud?op=sopralluoghi). Funzioni PURE, usate dal server.
// Il gestionale legge l'elenco quando vuole: OptiRoute non scrive nulla nel
// suo database e non ha sue chiavi.

export interface SopralluogoChiamata {
  esito: string;
  riepilogo: string;
  noteCliente: string;
  ricevutoIl: string;
}

export interface Sopralluogo {
  id: string;
  codice: string;
  data: string;
  oraInizio: string;
  oraFine: string;
  ordine: number;
  tecnico: string;
  cliente: string;
  telefono: string;
  referente: string;
  indirizzo: string;
  indirizzoCompleto: string;
  comune: string;
  provincia: string;
  lat: number;
  lng: number;
  approssimato: boolean;
  progetto: string;
  note: string;
  urgente: boolean;
  conferma: 'chiamata' | 'operatore';
  chiamata: SopralluogoChiamata | null;
}

export interface SopralluoghiExport {
  confirmed: Sopralluogo[];
  notConfirmed: string[];
  notConfirmedIds: string[];
}

// Un sopralluogo è confermato quando in OptiRoute è "Confermato" con data e
// orario: il gestionale rispecchia l'agenda dei sopralluoghi confermati.
// In OptiRoute lo stato "Confermato" vuol già dire confermato: con il pilota
// la pratica resta "proposta" finché il cliente non dice sì al telefono;
// "Conferma giornata" (o lo stato messo a mano) conferma sulla parola
// dell'operatore. Restano fuori: in attesa, proposte (anche in attesa della
// chiamata), stand-by, problemi, annullate.
export const isConfirmedInAgenda = (a: Appointment): boolean =>
  a.status === 'confirmed' && !!a.date && !!a.startTime;

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const toSopralluogo = (a: Appointment, technicianName: string): Sopralluogo => {
  const byCall = a.callOutcome?.result === 'confermato';
  const o = a.callOutcome;
  return {
    id: a.id,
    codice: s(displayCode(a)),
    data: s(a.date),
    oraInizio: s(a.startTime),
    oraFine: s(a.endTime),
    ordine: n(a.sequenceOrder),
    tecnico: technicianName,
    cliente: s(a.title),
    telefono: s(a.phone),
    referente: s(a.contactPerson),
    indirizzo: s(a.shortAddress) || s(a.address),
    indirizzoCompleto: s(a.address),
    comune: s(a.comune),
    provincia: s(a.province),
    lat: n(a.coords?.lat),
    lng: n(a.coords?.lng),
    approssimato: a.approximate === true,
    progetto: s(a.project),
    note: s(displayNotes(a)),
    urgente: a.urgent === true,
    conferma: byCall ? 'chiamata' : 'operatore',
    chiamata: o
      ? {
          esito: s(o.result),
          riepilogo: s(o.summary) || s(a.callSummary),
          noteCliente: s(o.clientNotes),
          ricevutoIl: s(o.receivedAt),
        }
      : null,
  };
};

const compare = (x: Sopralluogo, y: Sopralluogo): number =>
  x.data.localeCompare(y.data) ||
  x.oraInizio.localeCompare(y.oraInizio) ||
  x.ordine - y.ordine ||
  x.id.localeCompare(y.id);

// confirmed: i sopralluoghi confermati, in ordine di data e ora.
// codice: periziaCode, oppure il "Rif:" in testa alle note (import da My Maps);
// note: senza quella riga quando è usata come codice.
// notConfirmed: i codici (non vuoti, senza doppioni) di tutte le altre
// pratiche presenti in OptiRoute; mai un codice che compare anche fra i
// confermati (due pratiche con lo stesso codice, una confermata: il codice
// NON è qui).
// notConfirmedIds: gli id OptiRoute di TUTTE le pratiche presenti non
// confermate (con o senza codice).
// Una pratica cancellata non compare in nessuno degli elenchi.
export const buildSopralluoghiExport = (appointments: Appointment[], technicians: Technician[]): SopralluoghiExport => {
  const names = new Map(technicians.map(t => [t.id, s(t.name)]));
  const confirmed: Sopralluogo[] = [];
  const others = new Map<string, string>(); // chiave -> codice come scritto (il primo)
  const otherIds: string[] = [];
  for (const a of appointments) {
    if (!a || typeof a.id !== 'string') continue;
    if (isConfirmedInAgenda(a)) {
      confirmed.push(toSopralluogo(a, (a.technicianId && names.get(a.technicianId)) || ''));
    } else {
      otherIds.push(a.id);
      const code = s(displayCode(a));
      const key = codeKey(code);
      if (key && !others.has(key)) others.set(key, code);
    }
  }
  confirmed.sort(compare);
  // stesso numero scritto in modi diversi ("845326" / "845.326") = stessa pratica
  const confirmedKeys = new Set(confirmed.map(c => codeKey(c.codice)).filter(Boolean));
  const notConfirmed = [...others].filter(([key]) => !confirmedKeys.has(key)).map(([, code]) => code).sort();
  const notConfirmedIds = [...new Set(otherIds)].sort();
  return { confirmed, notConfirmed, notConfirmedIds };
};
