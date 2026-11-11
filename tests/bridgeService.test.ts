import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Appointment } from '../src/types';
import {
  DEFAULT_BRIDGE_SETTINGS,
  checkBridgeHealth,
  diffBridgeSnapshot,
  fetchBridgeSnapshot,
  parseBridgeSnapshot,
  type BridgePratica,
} from '../src/services/bridgeService';
import { bridgePraticaToRow } from '../src/hooks/importPratiche';
import { appt } from './fixtures';

// Dati sintetici: nessun dato personale reale.
const pratica = (over: Partial<BridgePratica> = {}): BridgePratica => ({
  portal: 'prelios',
  codice: 'P-001',
  intestatario: 'Cliente Prova',
  via: 'Via Esempio',
  civico: '1',
  comune: 'Milano',
  provincia: 'MI',
  telefono: '',
  note: '',
  progetto: 'Progetto X',
  tipologia: 'FULL - Acquisto',
  esito: 'IN ATTESA',
  aggiornatoIl: '2026-11-11T09:00:00Z',
  ...over,
});

const snapshotBody = (pratiche: unknown[] = [pratica()], portals: unknown[] = [{ id: 'prelios', status: 'ok', lastSync: null, message: null }]) => ({
  bridge: 'optiroute-bridge',
  version: 1,
  generatedAt: '2026-11-11T09:00:00Z',
  portals,
  pratiche,
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diffBridgeSnapshot', () => {
  const existing: Appointment[] = [
    appt({ id: 'a', periziaCode: 'P-001' }),                          // senza telefono
    appt({ id: 'b', periziaCode: 'P-002', phone: '+390211111111' }),  // telefono già presente
    appt({ id: 'c' }),                                                // senza codice
  ];

  it('nuove: codici non presenti (una volta sola, anche se ripetuti)', () => {
    const diff = diffBridgeSnapshot(
      { pratiche: [pratica({ codice: 'P-003' }), pratica({ codice: 'P-003' }), pratica({ codice: 'P-001' })] },
      existing
    );
    expect(diff.nuove.map(p => p.codice)).toEqual(['P-003']);
  });

  it('aggiornamenti: il telefono arriva solo dove manca', () => {
    const diff = diffBridgeSnapshot(
      {
        pratiche: [
          pratica({ codice: 'P-001', telefono: '+390233333333' }),
          pratica({ codice: 'P-002', telefono: '+390299999999' }), // non sovrascrive
        ],
      },
      existing
    );
    expect(diff.nuove).toEqual([]);
    expect(diff.aggiornamenti).toEqual([{ id: 'a', changes: { phone: '+390233333333' } }]);
  });

  it('nessun aggiornamento se il bridge non ha ancora il telefono', () => {
    const diff = diffBridgeSnapshot({ pratiche: [pratica({ codice: 'P-001', telefono: '' })] }, existing);
    expect(diff).toEqual({ nuove: [], aggiornamenti: [] });
  });

  it('è puro: non modifica le pratiche', () => {
    const before = JSON.stringify(existing);
    diffBridgeSnapshot({ pratiche: [pratica({ codice: 'P-001', telefono: '+390233333333' })] }, existing);
    expect(JSON.stringify(existing)).toBe(before);
  });
});

describe('parseBridgeSnapshot', () => {
  it('accetta il contratto v1 e scarta le pratiche senza codice', () => {
    const snap = parseBridgeSnapshot(snapshotBody([pratica(), { ...pratica(), codice: '' }, null]));
    expect(snap?.pratiche).toHaveLength(1);
    expect(snap?.portals[0]).toMatchObject({ id: 'prelios', status: 'ok' });
  });

  it('rifiuta risposte di altro tipo o versione', () => {
    expect(parseBridgeSnapshot({ ...snapshotBody(), bridge: 'altro' })).toBeNull();
    expect(parseBridgeSnapshot({ ...snapshotBody(), version: 2 })).toBeNull();
    expect(parseBridgeSnapshot({ bridge: 'optiroute-bridge', version: 1 })).toBeNull();
    expect(parseBridgeSnapshot('ciao')).toBeNull();
  });
});

describe('fetchBridgeSnapshot: mappatura degli errori', () => {
  const settings = { ...DEFAULT_BRIDGE_SETTINGS, token: 'segreto-di-prova' };

  it('ok: token solo nell\'header, mai nell\'URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, snapshotBody()));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchBridgeSnapshot(settings);
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8765/v1/pratiche');
    expect(url).not.toContain('segreto');
    expect((init.headers as Record<string, string>)['X-Bridge-Token']).toBe('segreto-di-prova');
  });

  it('offline: errore di rete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const res = await fetchBridgeSnapshot(settings);
    expect(res).toMatchObject({ ok: false, error: 'offline' });
  });

  it('token: 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'token' })));
    expect(await fetchBridgeSnapshot(settings)).toMatchObject({ ok: false, error: 'token' });
  });

  it('invalid: HTTP 500, JSON non valido o risposta di altro servizio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})));
    expect(await fetchBridgeSnapshot(settings)).toMatchObject({ ok: false, error: 'invalid' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    expect(await fetchBridgeSnapshot(settings)).toMatchObject({ ok: false, error: 'invalid' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { hello: 'world' })));
    expect(await fetchBridgeSnapshot(settings)).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('il token non finisce nei log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await fetchBridgeSnapshot(settings);
    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain('segreto');
  });

  it('timeout: la richiesta viene annullata e risulta offline', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    expect(await fetchBridgeSnapshot(settings, 20)).toMatchObject({ ok: false, error: 'offline' });
  });
});

describe('checkBridgeHealth', () => {
  it('riconosce il bridge, senza token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { bridge: 'optiroute-bridge', version: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkBridgeHealth('http://127.0.0.1:8765/')).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8765/v1/health');
    expect(init.headers).toBeUndefined();
  });

  it('offline e risposta estranea', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await checkBridgeHealth('http://127.0.0.1:8765')).toMatchObject({ ok: false, error: 'offline' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })));
    expect(await checkBridgeHealth('http://127.0.0.1:8765')).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('bridgePraticaToRow', () => {
  it('stessa forma dell\'elenco MISI; telefono vuoto = assente', () => {
    expect(bridgePraticaToRow(pratica({ note: 'citofono 3' }))).toEqual({
      title: 'Cliente Prova',
      street: 'Via Esempio',
      civic: '1',
      fullAddress: 'Via Esempio 1, Milano, MI',
      shortAddress: 'Via Esempio 1',
      comune: 'Milano',
      province: 'MI',
      phone: undefined,
      notes: 'citofono 3',
      codice: 'P-001',
      project: 'Progetto X',
    });
  });
});
