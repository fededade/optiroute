import type { Appointment, Coordinates } from '../types';

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
  // Reset transient "calling" states left over from a closed session.
  // Con un callId la chiamata era partita davvero: si passa a 'called' così
  // il polling dell'esito (post-call analysis) può riprendere da dove era.
  return data
    .filter(a => a && a.id && a.coords)
    .map(a => (a.callStatus === 'calling'
      ? { ...a, callStatus: a.callId ? ('called' as const) : ('failed' as const) }
      : a));
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

export const saveSettings = (settings: StoredSettings): void => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Impossibile salvare le impostazioni in locale', e);
  }
};
