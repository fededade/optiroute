import type { Appointment, Coordinates, Technician } from '../types';
import type { AutopilotSettings } from './autopilotService';

// Protocollo fra il browser e il server (pilota in cloud). Condiviso da
// entrambi: tipi dei messaggi e le funzioni PURE con cui si confrontano e si
// fondono gli elenchi delle pratiche.
//
// Idea: il server ha l'elenco "vero". Il browser non spedisce mai l'elenco
// intero (sovrascriverebbe quello che il motore ha fatto nel frattempo), ma
// solo le DIFFERENZE rispetto all'ultima versione ricevuta, campo per campo.
// Il server le applica sopra il suo stato attuale: una modifica dell'operatore
// alle note non cancella un esito arrivato un secondo prima.

export const CLOUD_PROTOCOL_VERSION = 1;
export const CLOUD_API_PATH = '/api/cloud';
export const CLOUD_TICK_PATH = '/api/cloud-tick';

// --- Configurazione condivisa (serve al motore lato server) ---

export interface CloudConfig {
  technicians: Technician[];
  autopilot: AutopilotSettings;
  // Orari e base generali dell'app (usati se la pratica non ha tecnico)
  fallback: { start: string; end: string; base: Coordinates | null };
}

// --- Differenze fra elenchi ---

export type AppointmentChange =
  // pratica nuova (non presente nella versione di partenza)
  | { op: 'put'; id: string; value: Appointment }
  // campi cambiati (`set`) o svuotati (`unset`) di una pratica esistente
  | { op: 'patch'; id: string; set: Partial<Appointment>; unset: string[] }
  // pratica eliminata
  | { op: 'delete'; id: string };

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const isEmpty = (v: unknown): boolean => v === undefined || v === null;

// Cosa è cambiato da `base` (ultima versione ricevuta dal server) a `current`
// (elenco locale). Elenco vuoto = niente da inviare.
export const diffAppointments = (base: Appointment[], current: Appointment[]): AppointmentChange[] => {
  const baseById = new Map(base.map(a => [a.id, a]));
  const currentIds = new Set(current.map(a => a.id));
  const changes: AppointmentChange[] = [];

  for (const cur of current) {
    const old = baseById.get(cur.id);
    if (!old) {
      changes.push({ op: 'put', id: cur.id, value: cur });
      continue;
    }
    if (old === cur) continue;
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const keys = new Set([...Object.keys(old), ...Object.keys(cur)]);
    for (const key of keys) {
      const before = (old as unknown as Record<string, unknown>)[key];
      const after = (cur as unknown as Record<string, unknown>)[key];
      if (sameValue(before, after)) continue;
      if (isEmpty(after)) unset.push(key);
      else set[key] = after;
    }
    if (Object.keys(set).length > 0 || unset.length > 0) {
      changes.push({ op: 'patch', id: cur.id, set: set as Partial<Appointment>, unset: unset.sort() });
    }
  }

  for (const old of base) {
    if (!currentIds.has(old.id)) changes.push({ op: 'delete', id: old.id });
  }
  return changes;
};

// Applica le differenze a un elenco (lato server: allo stato attuale; lato
// browser: per riportare le modifiche locali sopra la versione appena
// ricevuta). Non muta gli argomenti.
//  - put: se l'id esiste già si fondono i campi; se esiste un'altra pratica
//    con lo stesso codice (stessa pratica importata da due dispositivi) non si
//    duplica: le si completa solo il telefono mancante.
//  - patch su una pratica che non c'è più: ignorata.
export const applyAppointmentChanges = (all: Appointment[], changes: AppointmentChange[]): Appointment[] => {
  if (changes.length === 0) return all;
  let list = all;
  const replace = (index: number, value: Appointment) => {
    if (list === all) list = [...all];
    list[index] = value;
  };

  for (const change of changes) {
    const index = list.findIndex(a => a.id === change.id);

    if (change.op === 'delete') {
      if (index >= 0) list = list.filter(a => a.id !== change.id);
      continue;
    }

    if (change.op === 'put') {
      if (index >= 0) {
        replace(index, { ...list[index], ...change.value });
        continue;
      }
      const code = change.value.periziaCode?.trim();
      const twin = code ? list.findIndex(a => a.periziaCode?.trim() === code) : -1;
      if (twin >= 0) {
        if (!list[twin].phone?.trim() && change.value.phone?.trim()) {
          replace(twin, { ...list[twin], phone: change.value.phone });
        }
        continue;
      }
      list = [...list, change.value];
      continue;
    }

    // patch
    if (index < 0) continue;
    const next = { ...list[index], ...change.set } as unknown as Record<string, unknown>;
    for (const key of change.unset) delete next[key];
    replace(index, next as unknown as Appointment);
  }
  return list;
};

// Fusione a tre vie lato browser: `server` è la versione appena ricevuta,
// `base` quella da cui il browser era partito, `current` l'elenco locale.
// Le modifiche locali non ancora inviate vengono riportate sopra `server`.
export const rebaseAppointments = (server: Appointment[], base: Appointment[], current: Appointment[]): Appointment[] =>
  applyAppointmentChanges(server, diffAppointments(base, current));

// --- Messaggi ---

export type TickSource = 'scheduler' | 'webhook' | 'browser';

export interface TickSummary {
  outcomesApplied: number;  // esiti di chiamata applicati
  callsLaunched: number;    // chiamate avviate
  callsFailed: number;      // chiamate non partite
  recovered: number;        // lanci rimasti a metà recuperati
  expired: number;          // pratiche tolte dalla coda (slot trascorso)
  synced: number;           // sopralluoghi inviati al gestionale
  inFlight: number;         // chiamate in corso dopo il passaggio
  queued: number;           // pratiche in coda dopo il passaggio
  windowOpen: boolean;      // fascia chiamate aperta
  pilotEnabled: boolean;
  skipped?: 'locked' | 'not_production' | 'timezone' | 'no_state' | 'recent';
  error?: string;
  durationMs: number;
}

// Chi può far girare gli automatismi che restano nel browser (smistamento
// automatico, inbox del bridge): un dispositivo alla volta.
export interface AutomationLease {
  holder: boolean;   // questo dispositivo ha il turno
  deviceId: string;  // chi lo ha
  until: string;     // ISO: scadenza (si rinnova a ogni richiesta)
}

export interface CloudStatus {
  protocol: number;
  env: string;                       // production | preview | development
  storeConfigured: boolean;          // database collegato
  retellConfigured: boolean;         // chiavi Retell presenti
  timezone: { zone: string; ok: boolean };
  rev: number;
  configRev: number;
  appointmentCount: number;
  lastTick: { at: string; source: TickSource; summary: TickSummary } | null;
  schedulerSeenAt: string | null;    // ultimo passaggio arrivato dallo scheduler di Vercel
  webhookSeenAt: string | null;      // ultimo avviso arrivato da Retell
  webhookPath: string;               // percorso (con token) da incollare in Retell dopo il dominio
  serverTime: string;
}

export interface CloudSnapshot {
  rev: number;
  configRev: number;
  unchanged?: boolean;               // pull: niente di nuovo rispetto a rev/configRev indicati
  appointments?: Appointment[];
  config?: CloudConfig | null;
  lease?: AutomationLease | null;
}

export interface CloudPushRequest {
  device: string;
  changes: AppointmentChange[];
  // Configurazione completa, solo se cambiata in questo browser
  config?: CloudConfig;
}

export interface CloudInitRequest {
  device: string;
  appointments: Appointment[];
  config: CloudConfig;
  replace: true; // esplicito: sostituisce lo stato sul cloud
}

export type CloudErrorCode =
  | 'auth'                  // 401: chiave mancante o errata
  | 'secret_not_configured' // 503: sul server manca CRON_SECRET
  | 'store_not_configured'  // 503: sul server manca il database
  | 'bad_request'           // 400
  | 'conflict'              // 409: troppe modifiche concorrenti, riprovare
  | 'server';               // 500

export interface CloudError {
  error: CloudErrorCode;
  message?: string;
}
