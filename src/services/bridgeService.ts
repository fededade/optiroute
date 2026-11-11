import type { Appointment } from '../types';

// Client del bridge locale dei portali (prelios-bridge, contratto v1):
// un programma sul PC dell'operatore legge le pratiche dai portali e le
// espone su http://127.0.0.1:8765. OptiRoute le scarica da sola (inbox).
// Il token viaggia SOLO nell'header X-Bridge-Token: mai negli URL né nei log.

export interface BridgeSettings {
  enabled: boolean;
  url: string;   // es. http://127.0.0.1:8765
  token: string;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  enabled: false,
  url: 'http://127.0.0.1:8765',
  token: '',
};

export type BridgePortalStatus = 'starting' | 'login_required' | 'running' | 'ok' | 'error';

export interface BridgePortal {
  id: string;
  status: BridgePortalStatus;
  lastSync?: string | null;
  message?: string | null;
}

export interface BridgePratica {
  portal: string;
  codice: string;
  intestatario: string;
  via: string;
  civico: string;
  comune: string;
  provincia: string;
  telefono: string;   // può essere vuoto: pratica non ancora lavorata
  note: string;
  progetto: string;
  tipologia: string;
  esito: string;
  aggiornatoIl: string;
}

export interface BridgeSnapshot {
  bridge: string;
  version: number;
  generatedAt: string;
  portals: BridgePortal[];
  pratiche: BridgePratica[];
}

// offline = bridge non raggiungibile (rete), token = 401, invalid = risposta inattesa
export type BridgeErrorKind = 'offline' | 'token' | 'invalid';

export type BridgeFetchResult =
  | { ok: true; snapshot: BridgeSnapshot }
  | { ok: false; error: BridgeErrorKind; message: string };

const BRIDGE_NAME = 'optiroute-bridge';
const API_VERSION = 1;

const baseUrl = (url: string): string => (url || DEFAULT_BRIDGE_SETTINGS.url).trim().replace(/\/+$/, '');

const str = (v: unknown): string => (v === null || v === undefined ? '' : `${v}`.trim());

// Normalizza una pratica del bridge (campi mancanti -> stringa vuota).
// null se manca il codice: senza codice non si può fare il merge.
const toPratica = (raw: unknown): BridgePratica | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const codice = str(r.codice);
  if (!codice) return null;
  return {
    portal: str(r.portal),
    codice,
    intestatario: str(r.intestatario),
    via: str(r.via),
    civico: str(r.civico),
    comune: str(r.comune),
    provincia: str(r.provincia),
    telefono: str(r.telefono),
    note: str(r.note),
    progetto: str(r.progetto),
    tipologia: str(r.tipologia),
    esito: str(r.esito),
    aggiornatoIl: str(r.aggiornatoIl),
  };
};

const PORTAL_STATUSES: BridgePortalStatus[] = ['starting', 'login_required', 'running', 'ok', 'error'];

const toPortal = (raw: unknown): BridgePortal | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const status = str(r.status) as BridgePortalStatus;
  return {
    id: str(r.id) || 'portale',
    status: PORTAL_STATUSES.includes(status) ? status : 'error',
    lastSync: r.lastSync ? str(r.lastSync) : null,
    message: r.message ? str(r.message) : null,
  };
};

// Valida la risposta di /v1/pratiche; null se non è del bridge v1
export const parseBridgeSnapshot = (data: unknown): BridgeSnapshot | null => {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.bridge !== BRIDGE_NAME || d.version !== API_VERSION) return null;
  if (!Array.isArray(d.pratiche) || !Array.isArray(d.portals)) return null;
  return {
    bridge: BRIDGE_NAME,
    version: API_VERSION,
    generatedAt: str(d.generatedAt),
    portals: d.portals.map(toPortal).filter((p): p is BridgePortal => !!p),
    pratiche: d.pratiche.map(toPratica).filter((p): p is BridgePratica => !!p),
  };
};

// fetch con timeout (AbortController)
const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
};

export const fetchBridgeSnapshot = async (
  settings: Pick<BridgeSettings, 'url' | 'token'>,
  timeoutMs = 8000
): Promise<BridgeFetchResult> => {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${baseUrl(settings.url)}/v1/pratiche`,
      { method: 'GET', headers: { 'X-Bridge-Token': settings.token || '' } },
      timeoutMs
    );
  } catch {
    // Rete o timeout: il bridge non è avviato (o l'indirizzo è sbagliato)
    return { ok: false, error: 'offline', message: 'Bridge non raggiungibile' };
  }

  if (response.status === 401) {
    return { ok: false, error: 'token', message: 'Token del bridge errato' };
  }
  if (!response.ok) {
    return { ok: false, error: 'invalid', message: `Risposta inattesa dal bridge (HTTP ${response.status})` };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: 'invalid', message: 'Risposta del bridge non leggibile' };
  }
  const snapshot = parseBridgeSnapshot(data);
  if (!snapshot) {
    return { ok: false, error: 'invalid', message: 'Risposta inattesa: non sembra il bridge di OptiRoute' };
  }
  return { ok: true, snapshot };
};

// Verifica che all'indirizzo risponda il bridge (senza token)
export const checkBridgeHealth = async (
  url: string,
  timeoutMs = 5000
): Promise<{ ok: true } | { ok: false; error: BridgeErrorKind; message: string }> => {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${baseUrl(url)}/v1/health`, { method: 'GET' }, timeoutMs);
  } catch {
    return { ok: false, error: 'offline', message: 'Bridge non raggiungibile' };
  }
  if (!response.ok) {
    return { ok: false, error: 'invalid', message: `Risposta inattesa dal bridge (HTTP ${response.status})` };
  }
  try {
    const data = await response.json();
    if (data?.bridge === BRIDGE_NAME && data?.version === API_VERSION) return { ok: true };
  } catch {
    // risposta non JSON
  }
  return { ok: false, error: 'invalid', message: 'Risposta inattesa: non sembra il bridge di OptiRoute' };
};

// --- Confronto snapshot / pratiche già presenti (PURO) ---

export interface BridgeDiff {
  nuove: BridgePratica[];                                   // codice non ancora presente
  aggiornamenti: { id: string; changes: Partial<Appointment> }[]; // telefono arrivato ora
}

// nuove: pratiche il cui codice non è fra le pratiche (periziaCode);
// aggiornamenti: pratiche già presenti SENZA telefono per cui il bridge ora
// ha un telefono. Un telefono già presente non si sovrascrive mai (potrebbe
// averlo corretto l'operatore).
export const diffBridgeSnapshot = (snapshot: Pick<BridgeSnapshot, 'pratiche'>, appointments: Appointment[]): BridgeDiff => {
  const byCode = new Map<string, Appointment>();
  for (const a of appointments) {
    if (a.periziaCode && !byCode.has(a.periziaCode)) byCode.set(a.periziaCode, a);
  }

  const nuove: BridgePratica[] = [];
  const aggiornamenti: BridgeDiff['aggiornamenti'] = [];
  const seen = new Set<string>();

  for (const p of snapshot.pratiche) {
    const codice = p.codice?.trim();
    if (!codice || seen.has(codice)) continue;
    seen.add(codice);

    const existing = byCode.get(codice);
    if (!existing) {
      nuove.push(p);
      continue;
    }
    const telefono = p.telefono?.trim();
    if (telefono && !existing.phone?.trim()) {
      aggiornamenti.push({ id: existing.id, changes: { phone: telefono } });
    }
  }
  return { nuove, aggiornamenti };
};
