import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeRequestInit, checkBridgeHealth, fetchBridgeSnapshot, isLoopbackUrl, loopbackAddressSpace } from '../src/services/bridgeService';

// Dichiarazione "rete locale" (Chrome, Local Network Access) per le chiamate
// dirette al bridge su questo computer.

type Init = { targetAddressSpace?: string };

// Browser recente: conosce l'opzione con i nomi nuovi
class NewRequest { constructor(_: string, init?: Init) { if (init?.targetAddressSpace && !['loopback', 'local-network', 'public'].includes(init.targetAddressSpace)) throw new TypeError('valore'); } }
// Browser meno recente: solo i nomi vecchi
class OldRequest { constructor(_: string, init?: Init) { if (init?.targetAddressSpace && !['local', 'private', 'public'].includes(init.targetAddressSpace)) throw new TypeError('valore'); } }
// Browser che non conosce l'opzione: la ignora
class PlainRequest { constructor(_: string, __?: Init) {} }
// Browser che rifiuta qualunque valore
class StrictRequest { constructor(_: string, init?: Init) { if (init?.targetAddressSpace) throw new TypeError('valore'); } }

describe('valore accettato da questo browser', () => {
  it('nomi nuovi, nomi vecchi, opzione ignorata, nessun valore, Request assente', () => {
    expect(loopbackAddressSpace(NewRequest)).toBe('loopback');
    expect(loopbackAddressSpace(OldRequest)).toBe('local');
    expect(loopbackAddressSpace(PlainRequest)).toBe('loopback'); // ignorata: innocua
    expect(loopbackAddressSpace(StrictRequest)).toBe('');
    expect(loopbackAddressSpace(undefined)).toBe('');
  });
});

describe('opzione solo per gli indirizzi di questo computer', () => {
  it('indirizzi locali', () => {
    for (const u of ['http://127.0.0.1:8765/v1/pratiche', 'http://localhost:8765/v1/health', 'http://[::1]:8765/v1/pratiche', 'http://LOCALHOST:1/']) {
      expect(isLoopbackUrl(u), u).toBe(true);
      expect(bridgeRequestInit(u, { method: 'GET' }, 'loopback')).toEqual({ method: 'GET', targetAddressSpace: 'loopback' });
    }
  });
  it('altri indirizzi, o browser senza valore: richiesta invariata', () => {
    for (const u of ['http://192.168.1.10:8765/v1/pratiche', 'https://bridge.example/v1/pratiche', 'non un indirizzo']) {
      expect(isLoopbackUrl(u), u).toBe(false);
      expect(bridgeRequestInit(u, { method: 'GET' }, 'loopback')).toEqual({ method: 'GET' });
    }
    expect(bridgeRequestInit('http://127.0.0.1:8765/', { method: 'GET' }, '')).toEqual({ method: 'GET' });
  });
});

describe('chiamate dirette al bridge', () => {
  afterEach(() => vi.unstubAllGlobals());
  const okSnapshot = { bridge: 'optiroute-bridge', version: 1, generatedAt: 'x', portals: [], pratiche: [] };

  it('scaricamento e prova collegamento: dichiarazione sul loopback, token solo nell\'intestazione', async () => {
    const calls: { url: string; init: RequestInit & Init }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit & Init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(okSnapshot), { status: 200 });
    }));
    expect((await fetchBridgeSnapshot({ url: 'http://127.0.0.1:8765', token: 'tok' })).ok).toBe(true);
    expect((await checkBridgeHealth('http://localhost:8765')).ok).toBe(true);
    expect((await fetchBridgeSnapshot({ url: 'http://192.168.1.10:8765', token: 'tok' })).ok).toBe(true);
    expect(calls.map(c => c.url)).toEqual(['http://127.0.0.1:8765/v1/pratiche', 'http://localhost:8765/v1/health', 'http://192.168.1.10:8765/v1/pratiche']);
    // In Node la Request ignora l'opzione: vale il primo nome provato
    expect(calls[0].init.targetAddressSpace).toBe('loopback');
    expect(calls[1].init.targetAddressSpace).toBe('loopback');
    expect('targetAddressSpace' in calls[2].init).toBe(false);
    expect(calls[0].init.headers).toEqual({ 'X-Bridge-Token': 'tok' });
    expect(calls[0].url).not.toContain('tok');
  });
});
