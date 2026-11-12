// Impostazioni del collegamento al cloud, per QUESTO browser (localStorage).
// La chiave è la stessa impostata sul server (variabile CRON_SECRET): non
// viaggia mai negli URL, solo nell'intestazione Authorization.

const CLOUD_KEY = 'optiroute_cloud_v1';

export interface CloudSettings {
  enabled: boolean;  // questo browser lavora sui dati del cloud
  key: string;       // chiave di accesso
  deviceId: string;  // identifica questo browser fra i dispositivi collegati
}

const newDeviceId = (): string => {
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `dev-${Date.now().toString(36)}-${rnd()}${rnd()}`;
};

const hasStorage = (): boolean => typeof localStorage !== 'undefined';

export const loadCloudSettings = (): CloudSettings => {
  const fallback: CloudSettings = { enabled: false, key: '', deviceId: '' };
  if (!hasStorage()) return fallback; // lato server / test
  try {
    const raw = localStorage.getItem(CLOUD_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<CloudSettings>) : {};
    const settings: CloudSettings = {
      enabled: parsed.enabled === true,
      key: typeof parsed.key === 'string' ? parsed.key : '',
      deviceId: typeof parsed.deviceId === 'string' && parsed.deviceId ? parsed.deviceId : newDeviceId(),
    };
    if (!parsed.deviceId) saveCloudSettings(settings); // l'id del dispositivo resta stabile
    return settings;
  } catch {
    return fallback;
  }
};

export const saveCloudSettings = (settings: CloudSettings): void => {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(CLOUD_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Impossibile salvare le impostazioni del cloud', e);
  }
};
