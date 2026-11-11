import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import retellCall, { buildRetellCallPayload, createRetellCall, type RetellEnv } from '../api/retell-call';
import callStatus, { interpretRetellCall } from '../api/call-status';
import { endedCall, invoke, startFakeRetellHttp, type FakeRetellHttp } from './serverFakes';

// api/retell-call e api/call-status: protette dalla chiave SOLO se CRON_SECRET
// è impostata; altrimenti comportamento invariato. Retell finto via RETELL_API_BASE.

const VARS = ['CRON_SECRET', 'RETELL_API_KEY', 'RETELL_FROM_NUMBER', 'RETELL_AGENT_ID', 'RETELL_API_BASE'] as const;
const saved: Record<string, string | undefined> = {};

let retell: FakeRetellHttp;
beforeAll(async () => {
  retell = await startFakeRetellHttp();
});
afterAll(async () => {
  await retell.close();
});
beforeEach(() => {
  for (const k of VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const configureRetell = () => {
  process.env.RETELL_API_KEY = 'key_test';
  process.env.RETELL_FROM_NUMBER = '+390200000001';
  process.env.RETELL_API_BASE = retell.url;
};

const BODY = { phone: '333 1234567', clientName: 'Cliente', date: '2026-11-13', startTime: '10:00', endTime: '10:20' };

describe('api/retell-call', () => {
  it('senza CRON_SECRET: aperta come prima', async () => {
    const notConfigured = await invoke(retellCall, { method: 'POST', body: BODY });
    expect(notConfigured.statusCode).toBe(500);
    expect(notConfigured.body.error).toMatch(/non configurate/);

    configureRetell();
    const res = await invoke(retellCall, { method: 'POST', body: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ callId: retell.created.at(-1)!.callId, callStatus: 'registered', toNumber: '+393331234567' });
    const sent = retell.created.at(-1)!;
    expect(sent.auth).toBe('Bearer key_test');
    expect(sent.payload).toMatchObject({ from_number: '+390200000001', to_number: '+393331234567', metadata: { source: 'optiroute' } });
    expect(sent.payload.override_agent_id).toBeUndefined();

    expect((await invoke(retellCall, { method: 'POST', body: { ...BODY, phone: '' } })).statusCode).toBe(400);
    expect((await invoke(retellCall, { method: 'POST', body: { ...BODY, phone: 'abc' } })).statusCode).toBe(400);
    expect((await invoke(retellCall, { method: 'GET' })).statusCode).toBe(405);
  });

  it('con CRON_SECRET: serve la chiave', async () => {
    configureRetell();
    process.env.CRON_SECRET = 'segreto';
    const before = retell.created.length;
    for (const headers of [{}, { authorization: 'Bearer sbagliato' }]) {
      const res = await invoke(retellCall, { method: 'POST', headers, body: BODY });
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'auth' });
    }
    expect(retell.created.length).toBe(before); // nessuna telefonata
    const ok = await invoke(retellCall, { method: 'POST', headers: { authorization: 'Bearer segreto' }, body: BODY });
    expect(ok.statusCode).toBe(200);
    expect(retell.created.length).toBe(before + 1);
  });

  it('CORS ammette Authorization', async () => {
    const res = await invoke(retellCall, { method: 'OPTIONS' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('payload completo riusabile dal motore', async () => {
    const env: RetellEnv = { apiKey: 'k', fromNumber: '+390200000001', agentId: 'agent_x', apiBase: retell.url };
    const built = buildRetellCallPayload({ ...BODY, alternatives: [{ label: 'A', date: '2026-11-16', startTime: '09:00', endTime: '09:20' }] }, env);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.override_agent_id).toBe('agent_x');
    expect((built.payload.retell_llm_dynamic_variables as Record<string, string>).ha_alternative).toBe('si');
    const res = await createRetellCall(BODY, { env, timeoutMs: 5000 });
    expect(res).toMatchObject({ ok: true, toNumber: '+393331234567' });
    const offline = await createRetellCall(BODY, { env: { ...env, apiBase: 'http://127.0.0.1:9' }, timeoutMs: 2000 });
    expect(offline).toMatchObject({ ok: false, status: 500 });
  });
});

describe('api/call-status', () => {
  it('senza CRON_SECRET: aperta come prima; esito letto da Retell', async () => {
    expect((await invoke(callStatus, { query: { callId: 'c1' } })).statusCode).toBe(500); // chiave Retell assente
    configureRetell();
    retell.calls.set('c1', endedCall('c1', { esito_appuntamento: 'confermato', alternativa_scelta: 'B' }));
    const res = await invoke(callStatus, { query: { callId: 'c1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ pending: false, callStatus: 'ended', outcome: { result: 'confermato', chosenAlternative: 'B' } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await invoke(callStatus, { query: { callId: 'nessuna' } })).statusCode).toBe(404);
    expect((await invoke(callStatus, { query: { callId: '../x' } })).statusCode).toBe(400);
  });

  it('con CRON_SECRET: serve la chiave', async () => {
    configureRetell();
    process.env.CRON_SECRET = 'segreto';
    retell.calls.set('c2', { call_id: 'c2', call_status: 'ongoing' });
    expect((await invoke(callStatus, { query: { callId: 'c2' } })).statusCode).toBe(401);
    const ok = await invoke(callStatus, { query: { callId: 'c2' }, headers: { authorization: 'Bearer segreto' } });
    expect(ok.body).toEqual({ pending: true, callStatus: 'ongoing' });
  });

  it('interpretRetellCall: stessa logica dell\'endpoint', () => {
    expect(interpretRetellCall({ call_status: 'registered' })).toEqual({ pending: true, callStatus: 'registered' });
    expect(interpretRetellCall({ call_status: 'ended' })).toEqual({ pending: true, callStatus: 'ended', analysisPending: true });
    expect(interpretRetellCall({ call_status: 'error', disconnection_reason: 'invalid_destination' })).toMatchObject({
      pending: false,
      outcome: { result: 'numero_errato' },
    });
    expect(interpretRetellCall({ call_status: 'not_connected', disconnection_reason: 'dial_no_answer', call_analysis: { call_summary: 's' } }))
      .toMatchObject({ pending: false, outcome: { result: 'non_risposto', summary: 's' } });
    expect(interpretRetellCall(null)).toMatchObject({ callStatus: 'unknown' });
  });
});
