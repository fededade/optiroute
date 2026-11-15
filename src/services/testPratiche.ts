import type { Appointment, Coordinates, Technician } from '../types';
import { normalizePhone } from '../utils/phone';
import { TECHNICIAN_COLORS, matchTechnician } from './technicianService';

// Pratiche di prova della versione di prova: 16 pratiche finte, in attesa,
// tutte con il numero indicato da chi prova, divise in due gruppi (Oltrepò
// pavese; Milano ovest e Novara) che finiscono a due tecnici diversi, così si
// possono ipotizzare due giri. Nomi di fantasia, indirizzi generici e
// coordinate al centro dei comuni. Funzioni pure: lo stato lo cambia l'app.

export const TEST_PRATICA_PREFIX = 'prova-';
export const TEST_PROJECT = 'PROVA';
export const TEST_PRATICHE_COUNT = 16;

export const isTestPratica = (a: Pick<Appointment, 'id'>): boolean => a.id.startsWith(TEST_PRATICA_PREFIX);

export type TestGroupId = 'pavia' | 'milano';

interface TestGroup {
  id: TestGroupId;
  techName: string;          // tecnico di prova aggiunto se nessuno è competente
  techId: string;
  provinces: string[];
  base: { address: string; coords: Coordinates };
}

export const TEST_GROUPS: Record<TestGroupId, TestGroup> = {
  pavia: {
    id: 'pavia',
    techName: 'Tecnico di prova Pavia',
    techId: 'tech-prova-pavia',
    provinces: ['PV'],
    base: { address: 'Stradella (PV)', coords: { lat: 45.0748, lng: 9.3005 } },
  },
  milano: {
    id: 'milano',
    techName: 'Tecnico di prova Milano',
    techId: 'tech-prova-milano',
    provinces: ['MI', 'NO'],
    base: { address: 'Magenta (MI)', coords: { lat: 45.4647, lng: 8.8836 } },
  },
};

interface TestSeed {
  group: TestGroupId;
  comune: string;
  province: string;
  coords: Coordinates;
  shortAddress: string;
  name?: string;             // assente: pratica senza intestatario
  extra?: Partial<Appointment>;
}

// Una pratica per comune (nessun comune ripetuto: niente scarti da aggiungere)
const SEEDS: TestSeed[] = [
  // Oltrepò pavese (PV)
  { group: 'pavia', comune: 'Stradella', province: 'PV', coords: { lat: 45.0748, lng: 9.3005 }, shortAddress: 'Via Roma 12', name: 'Mario Rossi', extra: { urgent: true } },
  { group: 'pavia', comune: 'Broni', province: 'PV', coords: { lat: 45.0620, lng: 9.2610 }, shortAddress: 'Via Garibaldi 5', name: 'Giulia Bianchi', extra: { notes: 'Citofono «Bianchi», secondo piano' } },
  { group: 'pavia', comune: 'Casteggio', province: 'PV', coords: { lat: 45.0130, lng: 9.1250 }, shortAddress: 'Via Mazzini 8', name: 'LUCA FERRARI' },
  { group: 'pavia', comune: 'Santa Maria della Versa', province: 'PV', coords: { lat: 44.9889, lng: 9.2997 }, shortAddress: 'Via Cavour 21' },
  { group: 'pavia', comune: 'Montù Beccaria', province: 'PV', coords: { lat: 45.0367, lng: 9.3139 }, shortAddress: 'Via Verdi 3', name: 'Anna Colombo', extra: { contactPerson: 'Paolo Ricci — geometra', referredBy: 'Anna Colombo' } },
  { group: 'pavia', comune: 'Canneto Pavese', province: 'PV', coords: { lat: 45.0510, lng: 9.2790 }, shortAddress: 'Via Dante 15', name: 'Francesca Romano', extra: { durationMinutes: 40 } },
  { group: 'pavia', comune: 'Varzi', province: 'PV', coords: { lat: 44.8230, lng: 9.1980 }, shortAddress: 'Via Marconi 7', name: 'Giuseppe Marino' },
  { group: 'pavia', comune: 'Voghera', province: 'PV', coords: { lat: 44.9925, lng: 9.0094 }, shortAddress: 'Via Matteotti 30', name: 'Chiara Greco' },
  // Milano ovest e Novara
  { group: 'milano', comune: 'Magenta', province: 'MI', coords: { lat: 45.4647, lng: 8.8836 }, shortAddress: 'Via Milano 10', name: 'Marco Bruno' },
  { group: 'milano', comune: 'Abbiategrasso', province: 'MI', coords: { lat: 45.3987, lng: 8.9186 }, shortAddress: 'Via Manzoni 4', name: 'Sara Gallo' },
  { group: 'milano', comune: 'Corbetta', province: 'MI', coords: { lat: 45.4686, lng: 8.9197 }, shortAddress: 'Via Leopardi 9', name: 'Andrea Conti' },
  { group: 'milano', comune: 'Rho', province: 'MI', coords: { lat: 45.5300, lng: 9.0400 }, shortAddress: 'Via Pascoli 18', name: 'Elena De Luca' },
  { group: 'milano', comune: 'Legnano', province: 'MI', coords: { lat: 45.5949, lng: 8.9146 }, shortAddress: 'Via Carducci 6', name: 'Davide Costa' },
  { group: 'milano', comune: 'Novara', province: 'NO', coords: { lat: 45.4469, lng: 8.6220 }, shortAddress: 'Via Foscolo 22', name: 'Laura Giordano', extra: { notes: 'Scala B, interno 7' } },
  { group: 'milano', comune: 'Trecate', province: 'NO', coords: { lat: 45.4327, lng: 8.7386 }, shortAddress: 'Via Volta 11', name: 'Stefano Mancini' },
  { group: 'milano', comune: 'Galliate', province: 'NO', coords: { lat: 45.4800, lng: 8.7000 }, shortAddress: 'Via Petrarca 2', name: 'Paola Lombardi' },
];

const pad2 = (n: number) => String(n).padStart(2, '0');

// Le 16 pratiche (in attesa) con il telefono già normalizzato e il tecnico di ogni gruppo
export const buildTestPratiche = (phone: string, techByGroup: Record<TestGroupId, string | undefined>): Appointment[] =>
  SEEDS.map((s, i) => ({
    id: `${TEST_PRATICA_PREFIX}${pad2(i + 1)}`,
    // senza intestatario il titolo è via e civico, come nell'import
    title: s.name || s.shortAddress,
    address: `${s.shortAddress}, ${s.comune} (${s.province})`,
    shortAddress: s.shortAddress,
    comune: s.comune,
    province: s.province,
    coords: { ...s.coords },
    status: 'pending' as const,
    periziaCode: String(900001 + i),
    project: TEST_PROJECT,
    phone,
    technicianId: techByGroup[s.group],
    ...(s.extra || {}),
  }));

export const testPraticheGroups = (): { id: string; group: TestGroupId }[] =>
  SEEDS.map((s, i) => ({ id: `${TEST_PRATICA_PREFIX}${pad2(i + 1)}`, group: s.group }));

// --- Tecnici ---

// Per ogni gruppo: un tecnico attivo competente (matchTechnician sulla base del
// gruppo); se non c'è, o se è lo stesso dell'altro gruppo, si aggiunge il
// tecnico di prova. A un tecnico esistente senza base si imposta SOLO la base;
// il resto non si tocca.
export const prepareTestTechnicians = (
  technicians: Technician[]
): { technicians: Technician[]; techByGroup: Record<TestGroupId, string> } => {
  let list = technicians;
  const techByGroup = {} as Record<TestGroupId, string>;
  const taken = new Set<string>();

  for (const group of [TEST_GROUPS.pavia, TEST_GROUPS.milano]) {
    const probe = { coords: group.base.coords, province: group.provinces[0] };
    let tech = matchTechnician(probe, list);
    if (tech && taken.has(tech.id)) tech = null;
    // tecnico di prova già aggiunto in un caricamento precedente (anche se ora spento)
    if (!tech) {
      const previous = list.find(t => t.id === group.techId);
      if (previous) {
        tech = previous.active ? previous : { ...previous, active: true };
        if (tech !== previous) list = list.map(t => (t.id === previous.id ? tech as Technician : t));
      }
    }
    if (!tech) {
      tech = {
        id: group.techId,
        name: group.techName,
        color: TECHNICIAN_COLORS[(list.length + 2) % TECHNICIAN_COLORS.length],
        active: true,
        provinces: [...group.provinces],
        areas: [],
        baseAddress: group.base.address,
        baseCoords: { ...group.base.coords },
        workStart: '08:30',
        workEnd: '18:00',
        unavailability: [],
      };
      list = [...list, tech];
    } else if (!tech.baseCoords) {
      const withBase: Technician = { ...tech, baseAddress: group.base.address, baseCoords: { ...group.base.coords } };
      list = list.map(t => (t.id === withBase.id ? withBase : t));
      tech = withBase;
    }
    taken.add(tech.id);
    techByGroup[group.id] = tech.id;
  }
  return { technicians: list, techByGroup };
};

// --- Caricamento e rimozione ---

export const removeTestPratiche = (all: Appointment[]): Appointment[] =>
  all.some(isTestPratica) ? all.filter(a => !isTestPratica(a)) : all;

export type TestScenarioResult =
  | { ok: true; appointments: Appointment[]; technicians: Technician[]; phone: string; removedOthers: number }
  | { ok: false; error: string };

export interface TestScenarioOptions {
  wipeAll?: boolean;   // «Parti da zero»: elimina anche le pratiche non di prova
}

export const INVALID_TEST_PHONE = 'Numero non valido: scrivilo con il prefisso, per esempio +39 333 1234567.';

// Ricomincia da capo: toglie le pratiche di prova presenti (qualunque stato
// abbiano) e aggiunge le 16 nuove in attesa, assegnate ai due tecnici. Con
// wipeAll restano SOLO le 16 nuove: tutte le altre pratiche vengono eliminate
// (removedOthers dice quante non di prova).
export const loadTestScenario = (
  all: Appointment[],
  technicians: Technician[],
  rawPhone: string,
  options: TestScenarioOptions = {}
): TestScenarioResult => {
  const phone = normalizePhone(rawPhone || '');
  if (!phone) return { ok: false, error: INVALID_TEST_PHONE };
  const prepared = prepareTestTechnicians(technicians);
  const kept = options.wipeAll ? [] : removeTestPratiche(all);
  const removedOthers = options.wipeAll ? all.filter(a => !isTestPratica(a)).length : 0;
  return {
    ok: true,
    phone,
    technicians: prepared.technicians,
    appointments: [...kept, ...buildTestPratiche(phone, prepared.techByGroup)],
    removedOthers,
  };
};
