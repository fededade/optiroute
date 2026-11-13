import '../server/tz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Appointment } from '../src/types';
import type { CloudConfig } from '../src/services/cloudProtocol';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../src/services/autopilotService';
import {
  ConflictError,
  MemoryRedis,
  MemoryStore,
  RedisStore,
  StoreError,
  UpstashRestClient,
  UpstashStore,
  commit,
  decodeAppointments,
  encodeAppointments,
  keyPrefix,
  storeFromEnv,
  type Store,
} from '../server/store';
import { FALLBACK, P, appt, stop, tech } from './fixtures';
import { startFakeUpstash, type FakeUpstash } from './serverFakes';

// Archivio del pilota in cloud: stesse prove sull'emulatore in memoria e sul
// client REST di Upstash (contro un finto server REST in-process).

const TOKEN = 'token-di-prova';
const CONFIG: CloudConfig = {
  technicians: [tech()],
  autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true },
  fallback: FALLBACK,
};
const list = (): Appointment[] => [
  stop('a', '2026-11-13', '09:00', '09:20', P.milano),
  appt({ id: 'b', technicianId: 'tech-1' }),
];

let upstash: FakeUpstash;
beforeAll(async () => {
  upstash = await startFakeUpstash(TOKEN);
});
afterAll(async () => {
  await upstash.close();
});

const backends: [string, () => Store][] = [
  ['MemoryStore', () => new MemoryStore('optiroute:test:')],
  ['UpstashStore', () => {
    upstash.backend.clear();
    return new UpstashStore({ url: upstash.url, token: TOKEN }, 'optiroute:test:');
  }],
];

describe.each(backends)('%s', (_name, make) => {
  it('stato vuoto, sostituzione e compare-and-set con conflitto', async () => {
    const store = make();
    expect(await store.readAppointments()).toEqual({ appointments: null, rev: 0 });
    expect(await store.revs()).toEqual({ rev: 0, configRev: 0 });

    const initial = list();
    expect(await store.replaceAppointments(initial)).toBe(1);
    const read = await store.readAppointments();
    expect(read.rev).toBe(1);
    expect(read.appointments).toEqual(JSON.parse(JSON.stringify(initial)));

    expect(await store.writeAppointments(1, [])).toBe(2);
    expect(await store.writeAppointments(1, list())).toBeNull(); // rev non più attuale
    expect((await store.readAppointments()).appointments).toEqual([]);
    expect((await store.revs()).rev).toBe(2);
  });

  it('configurazione con la sua rev', async () => {
    const store = make();
    expect(await store.readConfig()).toEqual({ config: null, configRev: 0 });
    expect(await store.writeConfig(CONFIG)).toBe(1);
    expect(await store.writeConfig(CONFIG)).toBe(2);
    const { config, configRev } = await store.readConfig();
    expect(configRev).toBe(2);
    expect(config).toEqual(JSON.parse(JSON.stringify(CONFIG)));
  });

  it('commit: se la rev cambia nel frattempo rilegge e riapplica (nessuna modifica persa)', async () => {
    const inner = make();
    await inner.replaceAppointments(list());
    let interfered = false;
    // Al primo tentativo di scrittura un altro "dispositivo" scrive prima
    const store = Object.create(inner) as Store;
    store.writeAppointments = async (rev, all) => {
      if (!interfered) {
        interfered = true;
        const cur = await inner.readAppointments();
        await inner.writeAppointments(cur.rev, cur.appointments!.map(a => (a.id === 'b' ? { ...a, notes: 'operatore' } : a)));
      }
      return inner.writeAppointments(rev, all);
    };
    let calls = 0;
    const r = await commit(store, all => {
      calls++;
      return all.map(a => (a.id === 'a' ? { ...a, notes: 'motore' } : a));
    });
    expect(calls).toBe(2);
    expect(r.changed).toBe(true);
    const final = (await inner.readAppointments()).appointments!;
    expect(final.find(a => a.id === 'a')!.notes).toBe('motore');
    expect(final.find(a => a.id === 'b')!.notes).toBe('operatore');
    expect(r.rev).toBe(3);
  });

  it('commit: conflitto permanente -> ConflictError dopo 5 tentativi; nessuna scrittura se nulla cambia', async () => {
    const inner = make();
    await inner.replaceAppointments(list());
    const store = Object.create(inner) as Store;
    let writes = 0;
    store.writeAppointments = async () => { writes++; return null; };
    await expect(commit(store, all => [...all])).rejects.toBeInstanceOf(ConflictError);
    expect(writes).toBe(5);

    writes = 0;
    const same = await commit(store, all => all);
    expect(same.changed).toBe(false);
    expect(writes).toBe(0);
  });

  it('lock del passaggio: esclusivo, rilasciato solo dal proprietario', async () => {
    const store = make();
    expect(await store.acquireLock('uno', 5000)).toBe(true);
    expect(await store.acquireLock('due', 5000)).toBe(false);
    await store.releaseLock('due'); // non è suo: nessun effetto
    expect(await store.acquireLock('due', 5000)).toBe(false);
    await store.releaseLock('uno');
    expect(await store.acquireLock('due', 5000)).toBe(true);
  });

  it('lock: scade da solo (TTL)', async () => {
    const store = make();
    expect(await store.acquireLock('uno', 30)).toBe(true);
    await new Promise(r => setTimeout(r, 60));
    expect(await store.acquireLock('due', 5000)).toBe(true);
  });

  it('turno degli automatismi: al primo che lo chiede, rinnovo, passaggio alla scadenza', async () => {
    const store = make();
    const t0 = 1_000_000;
    expect(await store.claimLease('dev-a', t0, 90_000)).toEqual({ deviceId: 'dev-a', until: t0 + 90_000 });
    // un altro dispositivo con il turno ancora valido: resta ad A
    expect(await store.claimLease('dev-b', t0 + 1000, 90_000)).toEqual({ deviceId: 'dev-a', until: t0 + 90_000 });
    // A rinnova
    expect(await store.claimLease('dev-a', t0 + 60_000, 90_000)).toEqual({ deviceId: 'dev-a', until: t0 + 150_000 });
    // scaduto: passa a B
    expect(await store.claimLease('dev-b', t0 + 150_001, 90_000)).toEqual({ deviceId: 'dev-b', until: t0 + 240_001 });
    expect(await store.readLease()).toEqual({ deviceId: 'dev-b', until: t0 + 240_001 });
  });

  it('metadati', async () => {
    const store = make();
    expect(await store.readMeta()).toEqual({
      lastTick: null, schedulerSeenAt: null, webhookSeenAt: null, lastTickWallMs: null,
    });
    await store.updateMeta({ webhookSeenAt: '2026-11-11T10:00:00.000Z', lastTickWallMs: 1234 });
    const meta = await store.readMeta();
    expect(meta.webhookSeenAt).toBe('2026-11-11T10:00:00.000Z');
    expect(meta.lastTickWallMs).toBe(1234);
    expect(meta.schedulerSeenAt).toBeNull();
  });
});

describe('compressione e chiavi', () => {
  it('metadati salvati prima della rimozione dell\'invio al gestionale: il vecchio campo lastSync è ignorato', async () => {
    const redis = new MemoryRedis();
    const store = new MemoryStore('optiroute:test:', redis);
    redis.exec(['HSET', 'optiroute:test:meta', 'lastSync', JSON.stringify({ at: '2026-11-11T10:00:00.000Z', sent: 2, failed: 0 }), 'webhookSeenAt', '2026-11-11T09:00:00.000Z']);
    expect(await store.readMeta()).toEqual({
      lastTick: null, schedulerSeenAt: null, webhookSeenAt: '2026-11-11T09:00:00.000Z', lastTickWallMs: null,
    });
    await store.updateMeta({ lastTickWallMs: 5 });
    expect((await store.readMeta()).lastTickWallMs).toBe(5);
  });

  it('elenco salvato come gzip + base64, anche grande', async () => {
    const redis = new MemoryRedis();
    const store = new MemoryStore('optiroute:test:', redis);
    const big = Array.from({ length: 2000 }, (_, i) => appt({ id: `p${i}`, notes: 'nota abbastanza lunga '.repeat(5) }));
    await store.replaceAppointments(big);
    const raw = redis.exec(['GET', 'optiroute:test:appointments']) as string;
    expect(raw.startsWith('H4sI')).toBe(true); // intestazione gzip in base64
    expect(raw.length).toBeLessThan(JSON.stringify(big).length / 5);
    expect((await store.readAppointments()).appointments).toHaveLength(2000);
    expect(decodeAppointments(encodeAppointments(big))).toEqual(JSON.parse(JSON.stringify(big)));
    expect(() => decodeAppointments('non-base64-gzip')).toThrow(StoreError);
  });

  it('prefisso per ambiente: anteprima e produzione non si vedono', async () => {
    expect(keyPrefix('production')).toBe('optiroute:production:');
    expect(keyPrefix(undefined)).toBe('optiroute:development:');
    const redis = new MemoryRedis();
    const prod = new RedisStore(redis, 'memory', keyPrefix('production'));
    const preview = new RedisStore(redis, 'memory', keyPrefix('preview'));
    await prod.replaceAppointments(list());
    expect(await preview.readAppointments()).toEqual({ appointments: null, rev: 0 });
    expect((await prod.readAppointments()).rev).toBe(1);
  });

  it('scelta dell\'archivio dalle variabili d\'ambiente', () => {
    expect(storeFromEnv({})).toBeNull();
    const kv = storeFromEnv({ KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 't', VERCEL_ENV: 'preview' });
    expect(kv?.kind).toBe('upstash');
    expect(kv?.prefix).toBe('optiroute:preview:');
    // memoria solo fuori da Vercel
    expect(storeFromEnv({ OPTIROUTE_STORE: 'memory' })?.kind).toBe('memory');
    expect(storeFromEnv({ OPTIROUTE_STORE: 'memory', VERCEL_ENV: 'production' })).toBeNull();
    expect(storeFromEnv({ OPTIROUTE_STORE: 'memory', VERCEL_ENV: 'production', KV_REST_API_URL: 'https://kv', KV_REST_API_TOKEN: 't' })?.kind)
      .toBe('upstash');
  });

  it('UPSTASH_REDIS_REST_* ha la precedenza su KV_REST_API_*', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ result: [null, null] }), { status: 200 });
    }) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const store = storeFromEnv({
        KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'a',
        UPSTASH_REDIS_REST_URL: 'https://upstash.example', UPSTASH_REDIS_REST_TOKEN: 'b',
      })!;
      await store.revs();
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual(['https://upstash.example']);
  });
});

describe('client REST di Upstash: errori', () => {
  it('token errato -> StoreError auth', async () => {
    const store = new UpstashStore({ url: upstash.url, token: 'sbagliato' }, 'optiroute:test:');
    await expect(store.revs()).rejects.toMatchObject({ name: 'StoreError', code: 'auth' });
  });

  it('comando rifiutato -> StoreError redis; pipeline', async () => {
    const client = new UpstashRestClient({ url: upstash.url, token: TOKEN });
    await expect(client.command(['NONESISTE'])).rejects.toMatchObject({ code: 'redis' });
    upstash.backend.clear();
    expect(await client.pipeline([['SET', 'k', 'v'], ['GET', 'k'], ['INCR', 'n']])).toEqual(['OK', 'v', 1]);
  });

  it('rete assente -> network; risposta lenta -> timeout', async () => {
    const offline = new UpstashRestClient({ url: 'http://127.0.0.1:9', token: TOKEN, timeoutMs: 2000 });
    await expect(offline.command(['GET', 'k'])).rejects.toMatchObject({ code: 'network' });
    upstash.delayMs = 300;
    try {
      const slow = new UpstashRestClient({ url: upstash.url, token: TOKEN, timeoutMs: 50 });
      await expect(slow.command(['GET', 'k'])).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      upstash.delayMs = 0;
    }
  });

  it('i comandi viaggiano come array di stringhe, gli script come EVAL', async () => {
    upstash.backend.clear();
    const before = upstash.commands.length;
    const store = new UpstashStore({ url: upstash.url, token: TOKEN }, 'optiroute:test:');
    await store.replaceAppointments(list());
    const sent = upstash.commands.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('EVAL');
    expect(sent[0][2]).toBe('2');
    expect(sent[0].slice(3, 5)).toEqual(['optiroute:test:appointments', 'optiroute:test:rev']);
  });
});
