import type { Appointment, Coordinates } from '../types';
import { CALL_OUTCOME_MAX_AGE_MS, DEFAULT_AUTOPILOT_SETTINGS, type AutopilotSettings } from './autopilotService';
import { DEFAULT_BRIDGE_SETTINGS, type BridgeSettings } from './bridgeService';

// Simple localStorage persistence so the planning survives page reloads.

const APPOINTMENTS_KEY = 'optiroute_appointments_v1';
const BASE_KEY = 'optiroute_base_v1';
const SETTINGS_KEY = 'optiroute_settings_v1';

export interface StoredBase {
  coords: Coordinates;
  address: string;
}

export interface StoredSettings {
  startTime: string;
  endTimeLimit: string;
  /** Pannello "Impostazioni e azioni" della sidebar aperto/chiuso */
  settingsOpen?: boolean;
  /** Pilota automatico delle chiamate (campi mancanti = default) */
  autopilot?: Partial<AutopilotSettings>;
  /** La conferma della prima attivazione del pilota è già stata mostrata */
  autopilotIntroSeen?: boolean;
  /** Bridge locale dei portali (inbox delle pratiche) */
  bridge?: Partial<BridgeSettings>;
  /** Riquadro "Da gestire" aperto/chiuso */
  attentionOpen?: boolean;
}

const safeParse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const loadAppointments = (): Appointment[] => {
  const data = safeParse<Appointment[]>(localStorage.getItem(APPOINTMENTS_KEY));
  if (!Array.isArray(data)) return [];
  return data
    .filter(a => a && a.id && a.coords)
    .map(a => recoverInterruptedCall(a, new Date()));
};

// Stati rimasti a metà: pagina chiusa durante il lancio di una chiamata
// ('calling'). Se il lancio aveva già registrato callId e calledAt recenti la
// chiamata era partita davvero: si passa a 'called' e il polling dell'esito
// riprende. Altrimenti non si sa se sia partita: 'failed', da gestire a mano
// (nessun richiamo automatico, per non chiamare due volte il cliente).
export const recoverInterruptedCall = (a: Appointment, now: Date): Appointment => {
  if (a.callStatus !== 'calling') return a;
  const calledAtMs = a.calledAt ? new Date(a.calledAt).getTime() : NaN;
  const recent = !isNaN(calledAtMs) && now.getTime() - calledAtMs >= 0 && now.getTime() - calledAtMs < CALL_OUTCOME_MAX_AGE_MS;
  if (a.callId && recent) return { ...a, callStatus: 'called' };
  return {
    ...a,
    callStatus: 'failed',
    callOutcome: undefined,
    autoCall: undefined,
    autoCallNotBefore: undefined,
    callSummary: 'Avvio della chiamata interrotto',
  };
};

export const saveAppointments = (appointments: Appointment[]): void => {
  try {
    localStorage.setItem(APPOINTMENTS_KEY, JSON.stringify(appointments));
  } catch (e) {
    console.warn('Impossibile salvare gli appuntamenti in locale', e);
  }
};

export const loadBase = (): StoredBase | null => {
  const data = safeParse<StoredBase>(localStorage.getItem(BASE_KEY));
  return data && data.coords ? data : null;
};

export const saveBase = (base: StoredBase | null): void => {
  try {
    if (base) {
      localStorage.setItem(BASE_KEY, JSON.stringify(base));
    } else {
      localStorage.removeItem(BASE_KEY);
    }
  } catch (e) {
    console.warn('Impossibile salvare la base in locale', e);
  }
};

export const loadSettings = (): StoredSettings | null => {
  return safeParse<StoredSettings>(localStorage.getItem(SETTINGS_KEY));
};

// Impostazioni del pilota fuse con i default: i campi aggiunti in seguito
// hanno sempre un valore
export const loadAutopilotSettings = (): AutopilotSettings => ({
  ...DEFAULT_AUTOPILOT_SETTINGS,
  ...(loadSettings()?.autopilot || {}),
});

export const loadBridgeSettings = (): BridgeSettings => ({
  ...DEFAULT_BRIDGE_SETTINGS,
  ...(loadSettings()?.bridge || {}),
});

export const saveSettings = (settings: StoredSettings): void => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Impossibile salvare le impostazioni in locale', e);
  }
};
