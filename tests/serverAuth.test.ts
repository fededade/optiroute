import '../server/tz';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearerToken, isAuthorized, isValidWebhookToken, safeEqual, webhookToken } from '../server/auth';
import { MemoryStore } from '../server/store';
import { createCloudHandler, createTickHandler, type HandlerDeps } from '../server/http';
import { FakeRetell, invoke } from './serverFakes';

// Chiave unica (CRON_SECRET) e token derivato del webhook.

const SECRET = 'chiave-lunga-e-casuale';

describe('chiave', () => {
  it('confronto a tempo costante, anche fra lunghezze diverse', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('solo Authorization: Bearer', () => {
    expect(bearerToken({ authorization: `Bearer ${SECRET}` })).toBe(SECRET);
    expect(bearerToken({ authorization: `bearer   ${SECRET} ` })).toBe(SECRET);
    expect(bearerToken({ authorization: SECRET })).toBe('');
    expect(bearerToken({ authorization: `Basic ${SECRET}` })).toBe('');
    expect(bearerToken({})).toBe('');
    expect(isAuthorized({ authorization: `Bearer ${SECRET}` }, SECRET)).toBe(true);
    expect(isAuthorized({ authorization: 'Bearer altra' }, SECRET)).toBe(false);
    expect(isAuthorized({}, SECRET)).toBe(false);
    expect(isAuthorized({ authorization: 'Bearer ' }, '')).toBe(false); // senza segreto mai autorizzato
  });

  it('token del webhook: HMAC-SHA256(CRON_SECRET, "optiroute-webhook") in hex, 32 caratteri', () => {
    const expected = createHmac('sha256', SECRET).update('optiroute-webhook').digest('hex').slice(0, 32);
    expect(webhookToken(SECRET)).toBe(expected);
    expect(webhookToken(SECRET)).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidWebhookToken(expected, SECRET)).toBe(true);
    expect(isValidWebhookToken(expected, 'altro-segreto')).toBe(false);
    expect(isValidWebhookToken(undefined, SECRET)).toBe(false);
    expect(isValidWebhookToken('', SECRET)).toBe(false);
  });
});

describe('API cloud: autenticazione e configurazione', () => {
  const handlers = (over: Partial<HandlerDeps>) => {
    const deps: Partial<HandlerDeps> = { store: new MemoryStore('optiroute:test:'), retell: new FakeRetell(), ...over };
    return { cloud: createCloudHandler(deps), tick: createTickHandler(deps) };
  };

  it('chiave giusta / sbagliata / assente', async () => {
    const { cloud, tick } = handlers({ env: { CRON_SECRET: SECRET } });
    const ok = await invoke(cloud, { query: { op: 'status' }, headers: { authorization: `Bearer ${SECRET}` } });
    expect(ok.statusCode).toBe(200);
    for (const headers of [{ authorization: 'Bearer sbagliata' }, {}, { authorization: SECRET }]) {
      const res = await invoke(cloud, { query: { op: 'pull' }, headers });
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'auth' });
      expect((await invoke(tick, { method: 'POST', headers })).statusCode).toBe(401);
    }
  });

  it('senza CRON_SECRET: 503 secret_not_configured (ping escluso)', async () => {
    const { cloud, tick } = handlers({ env: {} });
    for (const op of ['status', 'pull']) {
      const res = await invoke(cloud, { query: { op }, headers: { authorization: 'Bearer qualsiasi' } });
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: 'secret_not_configured' });
    }
    const hook = await invoke(cloud, { method: 'POST', query: { op: 'webhook', token: 'x' }, body: { event: 'call_ended' } });
    expect(hook.body).toEqual({ error: 'secret_not_configured' });
    expect((await invoke(tick, { method: 'POST', headers: { authorization: 'Bearer x' } })).body).toEqual({ error: 'secret_not_configured' });
    expect((await invoke(cloud, { query: { op: 'ping' } })).statusCode).toBe(200);
  });

  it('senza database: 503 store_not_configured (dopo il controllo della chiave)', async () => {
    const { cloud, tick } = handlers({ env: { CRON_SECRET: SECRET }, store: null });
    const auth = { authorization: `Bearer ${SECRET}` };
    const res = await invoke(cloud, { query: { op: 'status' }, headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'store_not_configured' });
    expect((await invoke(cloud, { query: { op: 'status' }, headers: {} })).statusCode).toBe(401);
    expect((await invoke(tick, { method: 'POST', headers: auth })).body).toEqual({ error: 'store_not_configured' });
    const hook = await invoke(cloud, { method: 'POST', query: { op: 'webhook', token: webhookToken(SECRET) }, body: {} });
    expect(hook.body).toEqual({ error: 'store_not_configured' });
  });
});
