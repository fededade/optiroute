import '../server/tz';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GestionaleAuthError,
  GestionaleUnreachableError,
  STAFF_CACHE_TTL_MS,
  createGestionaleService,
  createJwksVerifier,
  gestionaleSettings,
  lookupStaff,
  maxAgeMs,
  normalizeOrigin,
} from '../server/gestionale';
import { SESSION_TTL_MS, isAuthorized, isValidSessionToken, mintSessionToken } from '../server/auth';
import { MemoryStore } from '../server/store';
import { createCloudHandler, type HandlerDeps } from '../server/http';
import { isCallApiAuthorized } from '../api/retell-call';
import { isCallStatusAuthorized } from '../api/call-status';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../src/services/autopilotService';
import type { CloudConfig } from '../src/services/cloudProtocol';
import { FALLBACK, P, appt, at, stop, tech } from './fixtures';
import { FakeRetell, invoke } from './serverFakes';
import { FIRESTORE, ORIGIN, PROJECT, claimsFor, fakeGoogle, makeKey, signToken } from './gestionaleFakes';

const SECRET = 'segreto-di-prova-0123456789';
const KEY = makeKey('chiave-1');
const OTHER_KEY = makeKey('chiave-2');
const NOW_MS = Date.UTC(2026, 10, 11, 9, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);

const ADMIN = 'Admin@Example.com';
const TECH = 'tecnico@example.com';

const tokenFor = (email: string, over: Record<string, unknown> = {}, key = KEY, header?: Record<string, unknown>) =>
  signToken(key, claimsFor(email, NOW_S, over), header);

const ENV = {
  CRON_SECRET: SECRET,
  GESTIONALE_FIREBASE_PROJECTS: `altro-progetto, ${PROJECT}`,
  GESTIONALE_ORIGINS: `${ORIGIN}/, https://collaudo.gestionale.example`,
};

describe('configurazione del collegamento', () => {
  it('attivo solo con progetti, origini e CRON_SECRET', () => {
    expect(gestionaleSettings(ENV)).toEqual({
      projects: ['altro-progetto', PROJECT],
      origins: [ORIGIN, 'https://collaudo.gestionale.example'],
      enabled: true,
    });
    expect(gestionaleSettings({ ...ENV, CRON_SECRET: '' }).enabled).toBe(false);
    expect(gestionaleSettings({ CRON_SECRET: SECRET, GESTIONALE_ORIGINS: ORIGIN }).enabled).toBe(false);
    expect(gestionaleSettings({ CRON_SECRET: SECRET, GESTIONALE_FIREBASE_PROJECTS: PROJECT }).enabled).toBe(false);
    expect(gestionaleSettings({}).enabled).toBe(false);
  });

  it('origini normalizzate', () => {
    expect(normalizeOrigin('https://Gestionale.Example/pagina?x=1')).toBe(ORIGIN);
    expect(normalizeOrigin('null')).toBe('');
    expect(normalizeOrigin('javascript:alert(1)')).toBe('');
    expect(normalizeOrigin(undefined)).toBe('');
  });

  it('cache delle chiavi secondo Cache-Control', () => {
    expect(maxAgeMs('public, max-age=19204, must-revalidate')).toBe(19204 * 1000);
    expect(maxAgeMs(null)).toBe(3600 * 1000);
    expect(maxAgeMs('max-age=5')).toBe(60 * 1000);
  });
});

describe('verifica del biglietto di Firebase', () => {
  const verifier = () => {
    const g = fakeGoogle([KEY]);
    return { g, verify: createJwksVerifier({ fetch: g.fetch }) };
  };
  const rejects = async (token: string, reason: string) => {
    const { verify } = verifier();
    const err = await verify(token, [PROJECT], NOW_MS).then(() => null, e => e);
    expect(err).toBeInstanceOf(GestionaleAuthError);
    expect((err as GestionaleAuthError).reason).toBe(reason);
  };

  it('biglietto valido: email, progetto e utente', async () => {
    const { verify, g } = verifier();
    const claims = await verify(tokenFor(ADMIN), [PROJECT], NOW_MS);
    expect(claims).toMatchObject({ email: ADMIN, aud: PROJECT, sub: `uid-${ADMIN}` });
    // le chiavi restano in cache (max-age=3600)
    await verify(tokenFor(TECH), [PROJECT], NOW_MS + 30 * 60 * 1000);
    expect(g.calls.jwks).toBe(1);
    await verify(tokenFor(TECH, { exp: NOW_S + 7300 }), [PROJECT], NOW_MS + 61 * 60 * 1000);
    expect(g.calls.jwks).toBe(2);
  });

  it('scaduto', () => rejects(tokenFor(ADMIN, { exp: NOW_S - 1 }), 'scaduto'));
  it('emesso nel futuro (oltre 5 minuti)', async () => {
    await rejects(tokenFor(ADMIN, { iat: NOW_S + 6 * 60 }), 'emesso nel futuro');
    const { verify } = verifier();
    await expect(verify(tokenFor(ADMIN, { iat: NOW_S + 4 * 60 }), [PROJECT], NOW_MS)).resolves.toBeTruthy();
  });
  it('progetto sbagliato', () => rejects(tokenFor(ADMIN, { aud: 'progetto-estraneo', iss: 'https://securetoken.google.com/progetto-estraneo' }), 'progetto'));
  it('emittente sbagliato', () => rejects(tokenFor(ADMIN, { iss: 'https://accounts.example/progetto-di-prova' }), 'emittente'));
  it('algoritmo diverso da RS256', async () => {
    await rejects(tokenFor(ADMIN, {}, KEY, { alg: 'HS256', kid: KEY.kid }), 'algoritmo');
    await rejects(tokenFor(ADMIN, {}, KEY, { alg: 'none', kid: KEY.kid }), 'algoritmo');
  });
  it('chiave sconosciuta', () => rejects(tokenFor(ADMIN, {}, OTHER_KEY), 'chiave sconosciuta'));
  it('firma manomessa', async () => {
    const good = tokenFor(ADMIN);
    const [h, , sig] = good.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify(claimsFor('altro@example.com', NOW_S))).toString('base64url')}.${sig}`;
    await rejects(forged, 'firma');
    await rejects(`${good.slice(0, -4)}AAAA`, 'firma');
  });
  it('email non verificata', () => rejects(tokenFor(ADMIN, { email_verified: false }), 'email non verificata'));
  it('senza utente o senza email', async () => {
    await rejects(tokenFor(ADMIN, { sub: '' }), 'utente');
    await rejects(tokenFor(ADMIN, { email: undefined }), 'email');
  });
  it('non è un biglietto', async () => {
    await rejects('abc', 'formato');
    await rejects('a.b.c', 'formato');
  });
  it('chiavi di Google non raggiungibili', async () => {
    const { verify, g } = verifier();
    g.mode.jwks = 'down';
    await expect(verify(tokenFor(ADMIN), [PROJECT], NOW_MS)).rejects.toBeInstanceOf(GestionaleUnreachableError);
  });
});

describe('scheda del personale (Firestore)', () => {
  const g = fakeGoogle([KEY]);
  g.staff.set('admin@example.com', { ruolo: 'Amministratore', nome: 'Anna Admin' });
  const opts = { fetch: g.fetch, baseUrl: FIRESTORE };

  it('200: ruolo e nome, email in minuscolo nel percorso, stesso biglietto', async () => {
    const token = tokenFor(ADMIN);
    expect(await lookupStaff(opts, PROJECT, ADMIN, token)).toEqual({ role: 'Amministratore', name: 'Anna Admin' });
    expect(g.calls.lastUrl).toBe(`${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/personale/admin%40example.com`);
    expect(g.calls.lastAuth).toBe(`Bearer ${token}`);
  });
  it('404 / 403: non è personale', async () => {
    expect(await lookupStaff(opts, PROJECT, TECH, tokenFor(TECH))).toBeNull();
    expect(await lookupStaff(opts, PROJECT, TECH, tokenFor(ADMIN))).toBeNull(); // scheda altrui: 403
  });
  it('401: biglietto rifiutato; 500 o rete: non raggiungibile', async () => {
    g.mode.firestore = 'reject';
    await expect(lookupStaff(opts, PROJECT, ADMIN, tokenFor(ADMIN))).rejects.toBeInstanceOf(GestionaleAuthError);
    g.mode.firestore = 'error500';
    await expect(lookupStaff(opts, PROJECT, ADMIN, tokenFor(ADMIN))).rejects.toBeInstanceOf(GestionaleUnreachableError);
    g.mode.firestore = 'down';
    await expect(lookupStaff(opts, PROJECT, ADMIN, tokenFor(ADMIN))).rejects.toBeInstanceOf(GestionaleUnreachableError);
    g.mode.firestore = 'ok';
  });
  it('riscontri positivi in cache per 5 minuti', async () => {
    const g2 = fakeGoogle([KEY]);
    g2.staff.set('admin@example.com', { ruolo: 'Super Amministratore', nome: 'Anna' });
    const service = createGestionaleService({ fetch: g2.fetch, firestoreBaseUrl: FIRESTORE });
    const token = tokenFor(ADMIN);
    expect(await service.identify(token, [PROJECT], NOW_MS)).toEqual({ name: 'Anna', role: 'Super Amministratore', admin: true });
    await service.identify(token, [PROJECT], NOW_MS + 60_000);
    expect(g2.calls.firestore).toBe(1);
    await service.identify(token, [PROJECT], NOW_MS + STAFF_CACHE_TTL_MS + 1);
    expect(g2.calls.firestore).toBe(2);
    // i negativi non restano in cache
    expect(await service.identify(tokenFor(TECH), [PROJECT], NOW_MS)).toBeNull();
    expect(await service.identify(tokenFor(TECH), [PROJECT], NOW_MS)).toBeNull();
    expect(g2.calls.firestore).toBe(4);
  });
});

describe('biglietti di sessione', () => {
  it('rilascio, verifica e scadenza a 60 minuti', () => {
    const { token, expiresAt } = mintSessionToken(SECRET, NOW_MS);
    expect(token).toMatch(/^ors1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(new Date(expiresAt).getTime()).toBe(Math.floor((NOW_MS + SESSION_TTL_MS) / 1000) * 1000);
    expect(isValidSessionToken(token, SECRET, NOW_MS)).toBe(true);
    expect(isValidSessionToken(token, SECRET, NOW_MS + SESSION_TTL_MS - 1000)).toBe(true);
    expect(isValidSessionToken(token, SECRET, NOW_MS + SESSION_TTL_MS)).toBe(false);
  });
  it('manomesso, altra chiave o formato errato: rifiutato', () => {
    const { token } = mintSessionToken(SECRET, NOW_MS);
    const [p, exp, mac] = token.split('.');
    expect(isValidSessionToken(`${p}.${Number(exp) + 600}.${mac}`, SECRET, NOW_MS)).toBe(false);
    expect(isValidSessionToken(`${p}.${exp}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, SECRET, NOW_MS)).toBe(false);
    expect(isValidSessionToken(token, 'altra-chiave', NOW_MS)).toBe(false);
    expect(isValidSessionToken('ors1.1.abc', SECRET, NOW_MS)).toBe(false);
    expect(isValidSessionToken(token, '', NOW_MS)).toBe(false);
  });
  it('isAuthorized: chiave o biglietto valido', () => {
    const { token } = mintSessionToken(SECRET, NOW_MS);
    expect(isAuthorized({ authorization: `Bearer ${SECRET}` }, SECRET, NOW_MS)).toBe(true);
    expect(isAuthorized({ authorization: `Bearer ${token}` }, SECRET, NOW_MS)).toBe(true);
    expect(isAuthorized({ authorization: `Bearer ${token}` }, SECRET, NOW_MS + SESSION_TTL_MS + 1)).toBe(false);
    expect(isAuthorized({ authorization: 'Bearer altro' }, SECRET, NOW_MS)).toBe(false);
    expect(isAuthorized({}, SECRET, NOW_MS)).toBe(false);
  });
});

describe('API delle chiamate: stessa verifica dei biglietti', () => {
  const saved = process.env.CRON_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('retell-call e call-status accettano e rifiutano come server/auth.ts', () => {
    process.env.CRON_SECRET = SECRET;
    const good = mintSessionToken(SECRET, NOW_MS).token;
    const [p, exp, mac] = good.split('.');
    const cases: [string, number][] = [
      [good, NOW_MS],
      [good, NOW_MS + SESSION_TTL_MS - 1000],
      [good, NOW_MS + SESSION_TTL_MS],
      [mintSessionToken('altra-chiave', NOW_MS).token, NOW_MS],
      [`${p}.${Number(exp) + 60}.${mac}`, NOW_MS],
      [SECRET, NOW_MS],
      ['sbagliata', NOW_MS],
      ['', NOW_MS],
    ];
    for (const [token, now] of cases) {
      const headers = token ? { authorization: `Bearer ${token}` } : {};
      const expected = isAuthorized(headers, SECRET, now);
      expect(isCallApiAuthorized(headers, now), `retell-call ${token.slice(0, 12)} @${now}`).toBe(expected);
      expect(isCallStatusAuthorized(headers, now), `call-status ${token.slice(0, 12)} @${now}`).toBe(expected);
    }
    expect(isCallApiAuthorized({ authorization: `Bearer ${good}` }, NOW_MS)).toBe(true);
  });

  it('senza CRON_SECRET restano aperte come prima', () => {
    delete process.env.CRON_SECRET;
    expect(isCallApiAuthorized({}, NOW_MS)).toBe(true);
    expect(isCallStatusAuthorized({}, NOW_MS)).toBe(true);
  });
});

// --- /api/cloud ---

const D = '2026-11-13';
const CONFIG: CloudConfig = {
  technicians: [tech({ id: 'tech-1', name: 'Tecnico Uno' })],
  autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: false },
  fallback: FALLBACK,
};

const make = (over: { env?: Record<string, string | undefined>; store?: MemoryStore | null } = {}) => {
  const g = fakeGoogle([KEY]);
  g.staff.set('admin@example.com', { ruolo: 'Amministratore', nome: 'Anna Admin' });
  g.staff.set(TECH, { ruolo: 'Tecnico', nome: 'Toni Tecnico' });
  const store = over.store === undefined ? new MemoryStore('optiroute:test:') : over.store;
  const clock = { wall: NOW_MS };
  const deps: Partial<HandlerDeps> = {
    env: over.env || ENV,
    store,
    retell: new FakeRetell(),
    now: () => new Date(clock.wall),
    clock: () => clock.wall,
    gestionale: { fetch: g.fetch, firestoreBaseUrl: FIRESTORE },
  };
  const cloud = createCloudHandler(deps);
  const call = (op: string, init: { method?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {}) =>
    invoke(cloud, { method: init.method || 'GET', query: { op, ...(init.query || {}) }, headers: init.headers || {}, body: init.body });
  return { g, store, clock, cloud, call };
};

describe('/api/cloud: ping', () => {
  it('dice se la pagina che incornicia è del gestionale, senza mai rivelare l\'elenco', async () => {
    const t = make();
    const yes = await t.call('ping', { query: { parent: ORIGIN } });
    expect(yes.body).toMatchObject({ gestionale: { enabled: true, parentAllowed: true } });
    const no = await t.call('ping', { query: { parent: 'https://altro.example' } });
    expect(no.body).toMatchObject({ gestionale: { enabled: true, parentAllowed: false } });
    const none = await t.call('ping');
    expect(none.body).toMatchObject({ gestionale: { enabled: true, parentAllowed: false } });
    for (const r of [yes, no, none]) {
      expect(JSON.stringify(r.body)).not.toContain('gestionale.example');
      expect(JSON.stringify(r.body)).not.toContain(PROJECT);
    }
    const off = make({ env: { ...ENV, CRON_SECRET: '' } });
    expect((await off.call('ping', { query: { parent: ORIGIN } })).body).toMatchObject({ gestionale: { enabled: false, parentAllowed: false } });
  });
});

describe('/api/cloud: op=session', () => {
  const session = (t: ReturnType<typeof make>, token?: string) =>
    t.call('session', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('amministratore: biglietto di sessione valido 60 minuti, accettato dalle altre operazioni', async () => {
    const t = make();
    const res = await session(t, tokenFor(ADMIN));
    expect(res.statusCode).toBe(200);
    expect(res.body.user).toEqual({ name: 'Anna Admin', role: 'Amministratore' });
    expect(res.body.token).toMatch(/^ors1\./);
    expect(new Date(res.body.expiresAt).getTime()).toBe(Math.floor((NOW_MS + SESSION_TTL_MS) / 1000) * 1000);
    expect(JSON.stringify(res.body)).not.toMatch(/example\.com/); // l'email non torna indietro
    const status = await t.call('status', { headers: { authorization: `Bearer ${res.body.token}` } });
    expect(status.statusCode).toBe(200);
    t.clock.wall += SESSION_TTL_MS;
    expect((await t.call('status', { headers: { authorization: `Bearer ${res.body.token}` } })).statusCode).toBe(401);
  });

  it('tecnico o persona senza scheda: 403 forbidden', async () => {
    const t = make();
    expect((await session(t, tokenFor(TECH))).body).toEqual({ error: 'forbidden' });
    expect((await session(t, tokenFor(TECH))).statusCode).toBe(403);
    expect((await session(t, tokenFor('sconosciuto@example.com'))).statusCode).toBe(403);
  });

  it('biglietto mancante o non valido: 401 auth', async () => {
    const t = make();
    expect((await session(t)).statusCode).toBe(401);
    expect((await session(t, tokenFor(ADMIN, { exp: NOW_S - 10 }))).body).toEqual({ error: 'auth' });
    expect((await session(t, SECRET)).statusCode).toBe(401);
    t.g.mode.firestore = 'reject';
    expect((await session(t, tokenFor(ADMIN))).statusCode).toBe(401);
  });

  it('collegamento non configurato: 503; Google o Firestore giù: 502', async () => {
    const off = make({ env: { CRON_SECRET: SECRET } });
    expect((await session(off, tokenFor(ADMIN))).statusCode).toBe(503);
    expect((await session(off, tokenFor(ADMIN))).body).toEqual({ error: 'gestionale_not_configured' });
    const t = make();
    t.g.mode.firestore = 'down';
    expect((await session(t, tokenFor(ADMIN))).statusCode).toBe(502);
    expect((await session(t, tokenFor(ADMIN))).body).toEqual({ error: 'gestionale_unreachable' });
    const t2 = make();
    t2.g.mode.jwks = 'down';
    expect((await session(t2, tokenFor(ADMIN))).statusCode).toBe(502);
  });

  it('solo POST', async () => {
    const t = make();
    expect((await t.call('session', { headers: { authorization: `Bearer ${tokenFor(ADMIN)}` } })).statusCode).toBe(405);
  });
});

describe('/api/cloud: op=sopralluoghi', () => {
  const seed = async (t: ReturnType<typeof make>) => {
    await t.store!.replaceAppointments([
      stop('b', D, '10:00', '10:20', P.portaVenezia, {
        status: 'confirmed', title: 'Cliente B', phone: '+390211111111', periziaCode: 'ISP-2', sequenceOrder: 2,
        callOutcome: { result: 'confermato', summary: 'Confermato', receivedAt: '2026-11-11T09:00:00.000Z' },
      }),
      stop('a', D, '09:00', '09:20', P.milano, { status: 'confirmed', phone: undefined, title: 'Cliente A', periziaCode: 'ISP-1', sequenceOrder: 1 }),
      stop('c', D, '11:00', '11:20', P.milano, { status: 'proposed', autoCall: 'route', title: 'Cliente C', phone: '+390222222222', periziaCode: 'ISP-3' }),
      appt({ id: 'd', periziaCode: 'ISP-4' }),
    ]);
    await t.store!.writeConfig(CONFIG);
  };

  it('con la chiave, un biglietto di sessione o un biglietto di Firebase di qualunque persona del personale', async () => {
    const t = make();
    await seed(t);
    const session = mintSessionToken(SECRET, NOW_MS).token;
    for (const token of [SECRET, session, tokenFor(TECH), tokenFor(ADMIN)]) {
      const res = await t.call('sopralluoghi', { headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.body.v).toBe(1);
      expect(res.body.today).toBe('2026-11-11');
      expect(res.body.generatedAt).toBe(new Date(NOW_MS).toISOString());
      expect(res.body.confirmed.map((s: { id: string }) => s.id)).toEqual(['a', 'b']);
      expect(res.body.notConfirmed).toEqual(['ISP-3', 'ISP-4']);
      expect(res.body.notConfirmedIds).toEqual(['c', 'd']);
      expect(res.body.confirmed[0]).toMatchObject({ conferma: 'operatore', tecnico: 'Tecnico Uno', codice: 'ISP-1', chiamata: null });
      expect(res.body.confirmed[1]).toMatchObject({ conferma: 'chiamata', chiamata: { esito: 'confermato', riepilogo: 'Confermato' } });
    }
  });

  it('senza biglietto 401, biglietto non valido 401, non personale 403, archivio mancante 503', async () => {
    const t = make();
    await seed(t);
    expect((await t.call('sopralluoghi')).statusCode).toBe(401);
    expect((await t.call('sopralluoghi', { headers: { authorization: 'Bearer sbagliata' } })).statusCode).toBe(401);
    expect((await t.call('sopralluoghi', { headers: { authorization: `Bearer ${tokenFor(TECH, { exp: NOW_S - 1 })}` } })).statusCode).toBe(401);
    expect((await t.call('sopralluoghi', { headers: { authorization: `Bearer ${tokenFor('nessuno@example.com')}` } })).statusCode).toBe(403);
    const empty = make({ store: null });
    const res = await empty.call('sopralluoghi', { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'store_not_configured' });
  });
});

describe('/api/cloud: CORS solo per le pagine del gestionale', () => {
  it('origine ammessa: Access-Control-Allow-Origin e Vary; altra origine: nessuna intestazione', async () => {
    const t = make();
    const ok = await t.call('sopralluoghi', { headers: { origin: ORIGIN, authorization: `Bearer ${SECRET}` } });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers.vary).toBe('Origin');
    const other = await t.call('sopralluoghi', { headers: { origin: 'https://altro.example', authorization: `Bearer ${SECRET}` } });
    expect(other.statusCode).toBe(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    // anche gli errori portano le intestazioni (il gestionale deve poter leggere il 401)
    const denied = await t.call('sopralluoghi', { headers: { origin: ORIGIN } });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['access-control-allow-origin']).toBe(ORIGIN);
    // mai "*"
    for (const r of [ok, other, denied]) expect(r.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('OPTIONS: 204 con metodi, intestazioni e durata per l\'origine ammessa; senza per le altre', async () => {
    const t = make();
    const pre = await invoke(t.cloud, { method: 'OPTIONS', query: { op: 'sopralluoghi' }, headers: { origin: ORIGIN } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    const other = await invoke(t.cloud, { method: 'OPTIONS', query: {}, headers: { origin: 'https://altro.example' } });
    expect(other.statusCode).toBe(204);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    expect(other.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('senza le variabili del gestionale nessuna intestazione CORS', async () => {
    const t = make({ env: { CRON_SECRET: SECRET } });
    const res = await t.call('status', { headers: { origin: ORIGIN, authorization: `Bearer ${SECRET}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// riferimento per evitare l'import inutilizzato in alcune configurazioni
void at;
