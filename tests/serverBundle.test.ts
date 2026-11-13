import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error modulo .mjs senza tipi
import { BUNDLES, buildApiBundles } from '../scripts/build-api.mjs';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../src/services/autopilotService';
import { webhookToken } from '../server/auth';
import { FALLBACK, P, appt, at, stop, tech } from './fixtures';
import { invoke, startFakeRetellHttp, type FakeRetellHttp } from './serverFakes';

// I bundle committati (api/cloud.js, api/cloud-tick.js) sono aggiornati
// rispetto ai sorgenti e funzionano da soli, come su Vercel.

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'segreto-bundle';
const AUTH = { authorization: `Bearer ${SECRET}` };

describe('bundle generati', () => {
  it('corrispondono ai sorgenti (altrimenti: node scripts/build-api.mjs)', async () => {
    const built: { out: string; text: string }[] = await buildApiBundles();
    expect(built.map(b => b.out)).toEqual(BUNDLES.map((b: { out: string }) => b.out));
    for (const { out, text } of built) {
      const committed = await readFile(path.join(ROOT, out), 'utf8');
      expect(committed.startsWith('// FILE GENERATO da scripts/build-api.mjs: non modificare a mano.'), out).toBe(true);
      expect(committed === text, `${out} non aggiornato: esegui node scripts/build-api.mjs`).toBe(true);
    }
  });

  it('non contengono chiavi API Google né il progetto del gestionale', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['api/cloud.js', 'api/cloud-tick.js']) {
      const code = await readFile(file, 'utf8');
      expect(code, `${file}: chiave API Google nel bundle`).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      expect(code, `${file}: progetto del gestionale nel bundle`).not.toMatch(/gestionale-effetre/);
    }
  });

  it('autosufficienti: nessun import se non moduli node:', async () => {
    for (const { out } of BUNDLES as { out: string }[]) {
      const text = await readFile(path.join(ROOT, out), 'utf8');
      const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
      expect(imports.length).toBeGreaterThan(0);
      for (const spec of imports) expect(spec, out).toMatch(/^node:/);
      expect(text).not.toMatch(/\brequire\(/);
      // il fuso è la prima istruzione eseguita
      const firstCode = text.split('\n').find(l => l.trim() && !l.startsWith('//') && !l.startsWith('import '));
      expect(firstCode, out).toBe('process.env.TZ = process.env.OPTIROUTE_TZ || "Europe/Rome";');
    }
  });
});

describe('bundle in funzione (archivio in memoria, Retell finto)', () => {
  const VARS = ['OPTIROUTE_STORE', 'CRON_SECRET', 'RETELL_API_KEY', 'RETELL_FROM_NUMBER', 'RETELL_API_BASE', 'VERCEL_ENV', 'RETELL_AGENT_ID'];
  const saved: Record<string, string | undefined> = {};
  let retell: FakeRetellHttp;
  const g = globalThis as { __optirouteNow?: () => Date; __optirouteMemoryRedis?: { clear(): void } };
  // Nessuna richiesta deve uscire verso servizi veri (Retell...)
  const realFetch = globalThis.fetch;
  const external: string[] = [];

  beforeAll(async () => {
    retell = await startFakeRetellHttp();
    for (const k of VARS) saved[k] = process.env[k];
    delete process.env.VERCEL_ENV;
    delete process.env.RETELL_AGENT_ID;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('http://127.0.0.1:')) {
        external.push(url.split('?')[0]);
        throw new Error('rete esterna vietata nei test');
      }
      return realFetch(input, init);
    }) as typeof fetch;
    process.env.OPTIROUTE_STORE = 'memory';
    process.env.CRON_SECRET = SECRET;
    process.env.RETELL_API_KEY = 'key_test';
    process.env.RETELL_FROM_NUMBER = '+390200000001';
    process.env.RETELL_API_BASE = retell.url;
    g.__optirouteMemoryRedis?.clear();
    g.__optirouteNow = () => at('2026-11-11', '10:00');
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await retell.close();
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete g.__optirouteNow;
    g.__optirouteMemoryRedis?.clear();
  });

  it('ping, init, pull, tick, webhook e cloud-tick', async () => {
    const cloud = (await import('../api/cloud.js')).default;
    const cloudTick = (await import('../api/cloud-tick.js')).default;

    const ping = await invoke(cloud, { query: { op: 'ping' } });
    expect(ping.body).toEqual({ protocol: 1, secretConfigured: true, storeConfigured: true, gestionale: { enabled: false, parentAllowed: false } });

    const D = '2026-11-13';
    const init = await invoke(cloud, {
      method: 'POST',
      query: { op: 'init' },
      headers: AUTH,
      body: {
        device: 'dev-a',
        replace: true,
        config: { technicians: [tech()], autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true }, fallback: FALLBACK },
        appointments: [
          stop('s1', D, '09:00', '09:20', P.milano, { sequenceOrder: 1 }),
          stop('x', D, '10:00', '10:20', P.portaVenezia, { sequenceOrder: 2, phone: '+390233330000', autoCall: 'route' }),
          appt({ id: 'near', coords: P.portaVenezia, technicianId: 'tech-1', phone: '+390211111111' }),
        ],
      },
    });
    expect(init.statusCode).toBe(200);
    expect(init.body).toMatchObject({ rev: 1, configRev: 1, lease: { holder: true, deviceId: 'dev-a' } });

    const pull = await invoke(cloud, { query: { op: 'pull', rev: '1', configRev: '1', device: 'dev-a' }, headers: AUTH });
    expect(pull.body).toMatchObject({ rev: 1, configRev: 1, unchanged: true });

    const tick = await invoke(cloud, { method: 'POST', query: { op: 'tick' }, headers: AUTH, body: { device: 'dev-a' } });
    expect(tick.statusCode).toBe(200);
    expect(tick.body.summary).toMatchObject({ callsLaunched: 1, pilotEnabled: true, windowOpen: true });
    expect(tick.body.summary.error).toBeUndefined();
    expect(retell.created).toHaveLength(1);
    expect(retell.created[0].payload.to_number).toBe('+390233330000');

    // esito pronto su Retell: lo applica il passaggio dello scheduler
    retell.calls.set(retell.created[0].callId, {
      call_id: retell.created[0].callId,
      call_status: 'ended',
      call_analysis: { call_summary: 'ok', custom_analysis_data: { esito_appuntamento: 'confermato' } },
    });
    const sched = await invoke(cloudTick, { method: 'POST', headers: { ...AUTH, 'user-agent': 'vercel-cron/1.0' } });
    expect(sched.statusCode).toBe(200);
    expect(sched.body.summary).toMatchObject({ outcomesApplied: 1 });
    expect(sched.body.summary.error).toBeUndefined();

    const hook = await invoke(cloud, { method: 'POST', query: { op: 'webhook', token: webhookToken(SECRET) }, body: { event: 'call_started' } });
    expect(hook.body).toEqual({ ok: true, ignored: true });

    const status = await invoke(cloud, { query: { op: 'status' }, headers: AUTH });
    expect(status.body).toMatchObject({
      timezone: { zone: 'Europe/Rome', ok: true },
      retellConfigured: true,
      appointmentCount: 3,
      lastTick: { source: 'scheduler' },
    });
    expect(status.body.schedulerSeenAt).toBeTruthy();
    expect(status.body.webhookSeenAt).toBeTruthy();

    const full = await invoke(cloud, { query: { op: 'pull' }, headers: AUTH });
    expect(full.body.appointments.find((a: { id: string }) => a.id === 'x')).toMatchObject({
      status: 'confirmed',
      callOutcome: { result: 'confermato' },
    });

    expect((await invoke(cloudTick, { method: 'POST', headers: {} })).statusCode).toBe(401);
    expect(external).toEqual([]);
  });

  it('in un processo Node separato avviato con TZ=UTC il fuso risulta ok', () => {
    const run = (extraEnv: Record<string, string>) => {
      const script = `
        const { default: handler } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'api/cloud.js')).href)});
        const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, end() {} };
        await handler({ method: 'GET', query: { op: 'status' }, headers: { authorization: 'Bearer x' } }, res);
        console.log(JSON.stringify({ code: res.code, timezone: res.body.timezone, jan: new Date(2026, 0, 15).getTimezoneOffset(), hour: new Date(Date.UTC(2026, 10, 11, 9)).getHours() }));
      `;
      const env: Record<string, string> = { PATH: process.env.PATH || '', TZ: 'UTC', OPTIROUTE_STORE: 'memory', CRON_SECRET: 'x', ...extraEnv };
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 20000 });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout.trim().split('\n').pop()!);
    };
    expect(run({})).toEqual({ code: 200, timezone: { zone: 'Europe/Rome', ok: true }, jan: -60, hour: 10 });
    expect(run({ OPTIROUTE_TZ: 'Fuso/Inesistente' }).timezone).toEqual({ zone: 'Fuso/Inesistente', ok: false });
  });
});
