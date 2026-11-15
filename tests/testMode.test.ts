import '../server/tz';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import retellCall, {
  TEST_NO_NUMBERS,
  TEST_NUMBER_NOT_ALLOWED,
  buildRetellCallPayload,
  createRetellCall,
  isTestModeEnv,
  normalizePhone as apiNormalizePhone,
  parseTestNumbers,
  retellEnv,
  type RetellEnv,
} from '../api/retell-call';
import {
  DEFAULT_AUTOPILOT_SETTINGS,
  effectiveAutopilotSettings,
  isWithinCallWindow,
  nextCallWindowStart,
  storableAutopilotSettings,
  type AutopilotSettings,
} from '../src/services/autopilotService';
import { loadAutopilotSettings } from '../src/services/storageService';
import { safeLocalStorage } from '../src/services/safeStorage';
import { autoDispatchStartDate } from '../src/hooks/useAutoDispatch';
import type { CloudConfig } from '../src/services/cloudProtocol';
import { MemoryStore } from '../server/store';
import { planningFrom, runTick, type EngineDeps } from '../server/engine';
import { createCloudHandler, createTickHandler } from '../server/http';
import { normalizePhone } from '../src/utils/phone';
import { defaultTechnicians, matchTechnician } from '../src/services/technicianService';
import {
  TEST_GROUPS,
  TEST_PRATICHE_COUNT,
  isTestPratica,
  loadTestScenario,
  prepareTestTechnicians,
  removeTestPratiche,
  testPraticheGroups,
} from '../src/services/testPratiche';
import { NOT_TEST_MODE, fetchTestMode, testModeFromPing, testModeTitle } from '../src/services/testMode';
import type { Appointment, Technician } from '../src/types';
import { FALLBACK, P, appt, at, stop, tech } from './fixtures';
import { FakeRetell, invoke, startFakeRetellHttp, type FakeRetellHttp } from './serverFakes';

// Versione di prova: regola dell'ambiente, numeri ammessi, blocco delle
// chiamate, ping, pilota anche la domenica, pratiche di prova e tecnici.

const ALLOWED = '+390255500101';
const OTHER = '+390255500999';
const SUNDAY = at('2026-11-15', '11:00');   // domenica
const WEDNESDAY = at('2026-11-11', '10:00');

describe('regola della modalità prova', () => {
  it('anteprima di Vercel o OPTIROUTE_TEST_MODE=1', () => {
    expect(isTestModeEnv({ VERCEL_ENV: 'preview' })).toBe(true);
    expect(isTestModeEnv({ OPTIROUTE_TEST_MODE: '1' })).toBe(true);
    expect(isTestModeEnv({ VERCEL_ENV: 'development', OPTIROUTE_TEST_MODE: '1' })).toBe(true);
    expect(isTestModeEnv({})).toBe(false);
    expect(isTestModeEnv({ VERCEL_ENV: 'development' })).toBe(false);
    expect(isTestModeEnv({ OPTIROUTE_TEST_MODE: 'true' })).toBe(false);
    expect(isTestModeEnv({ OPTIROUTE_TEST_MODE: '0' })).toBe(false);
  });

  it('MAI in produzione, anche con la variabile impostata', () => {
    expect(isTestModeEnv({ VERCEL_ENV: 'production' })).toBe(false);
    expect(isTestModeEnv({ VERCEL_ENV: 'production', OPTIROUTE_TEST_MODE: '1' })).toBe(false);
  });
});

describe('numeri ammessi (RETELL_TEST_NUMBERS)', () => {
  it('separati da virgola, punto e virgola, spazi o a capo; normalizzati come le chiamate', () => {
    expect(parseTestNumbers('+39 02 5550 0101, 0255500102;0039 02 55500103\n+390255500104  +390255500105'))
      .toEqual(['+390255500101', '+390255500102', '+390255500103', '+390255500104', '+390255500105']);
  });

  it('vuota, non validi e doppioni', () => {
    expect(parseTestNumbers(undefined)).toEqual([]);
    expect(parseTestNumbers('')).toEqual([]);
    expect(parseTestNumbers(' , ; \n')).toEqual([]);
    expect(parseTestNumbers('abc, 12, +390255500101, 0255500101')).toEqual(['+390255500101']);
  });

  it('la normalizzazione del browser coincide con quella delle chiamate', () => {
    const samples = ['333 1234567', '+39 333-123.4567', '0039 3331234567', '(02) 5550 0101', '12345', 'abc', '', '+1 (555) 010-0000', '00441234567890', '+3933312345678901'];
    for (const s of samples) expect(normalizePhone(s), s).toBe(apiNormalizePhone(s));
  });
});

const baseEnv = (over: Partial<RetellEnv> = {}): RetellEnv => ({
  apiKey: 'key_test', fromNumber: '+390200000001', agentId: '', apiBase: 'http://127.0.0.1:9', ...over,
});
const BODY = { phone: '02 5550 0101', clientName: 'Mario Rossi', date: '2026-11-13', startTime: '10:00' };

describe('blocco nel payload', () => {
  it('numero ammesso (scritto in un altro modo): la chiamata si prepara', () => {
    const r = buildRetellCallPayload(BODY, baseEnv({ testMode: true, testNumbers: [ALLOWED] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.toNumber).toBe(ALLOWED);
  });

  it('numero non ammesso: 403 con il messaggio', () => {
    const r = buildRetellCallPayload({ ...BODY, phone: OTHER }, baseEnv({ testMode: true, testNumbers: [ALLOWED] }));
    expect(r).toEqual({ ok: false, status: 403, error: TEST_NUMBER_NOT_ALLOWED });
    expect(TEST_NUMBER_NOT_ALLOWED).toBe('Versione di prova: questo numero non è fra quelli ammessi per le prove.');
  });

  it('lista vuota: 403 con l\'invito a impostare RETELL_TEST_NUMBERS', () => {
    for (const testNumbers of [[], undefined]) {
      const r = buildRetellCallPayload(BODY, baseEnv({ testMode: true, testNumbers }));
      expect(r).toEqual({ ok: false, status: 403, error: TEST_NO_NUMBERS });
    }
    expect(TEST_NO_NUMBERS).toBe('Versione di prova: nessun numero ammesso. Imposta RETELL_TEST_NUMBERS (ambiente Preview) con i numeri che si possono chiamare.');
  });

  it('numero non valido: resta l\'errore di sempre (400)', () => {
    const r = buildRetellCallPayload({ ...BODY, phone: 'abc' }, baseEnv({ testMode: true, testNumbers: [ALLOWED] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('fuori dalla prova nessun effetto: stesso payload di prima', () => {
    const plain = buildRetellCallPayload({ ...BODY, phone: OTHER }, baseEnv());
    const off = buildRetellCallPayload({ ...BODY, phone: OTHER }, baseEnv({ testMode: false, testNumbers: [] }));
    expect(plain.ok).toBe(true);
    expect(off).toEqual(plain);
  });

  it('il percorso del pilota in cloud (createRetellCall) è bloccato prima di qualunque richiesta', async () => {
    // apiBase verso una porta chiusa: se partisse una richiesta l'errore sarebbe 500
    const r = await createRetellCall({ ...BODY, phone: OTHER }, { env: baseEnv({ testMode: true, testNumbers: [ALLOWED] }) });
    expect(r).toEqual({ ok: false, status: 403, error: TEST_NUMBER_NOT_ALLOWED });
  });
});

describe('endpoint /api/retell-call in modalità prova', () => {
  const VARS = ['CRON_SECRET', 'RETELL_API_KEY', 'RETELL_FROM_NUMBER', 'RETELL_AGENT_ID', 'RETELL_API_BASE', 'VERCEL_ENV', 'OPTIROUTE_TEST_MODE', 'RETELL_TEST_NUMBERS'] as const;
  const saved: Record<string, string | undefined> = {};
  let retell: FakeRetellHttp;
  beforeAll(async () => { retell = await startFakeRetellHttp(); });
  afterAll(async () => { await retell.close(); });
  beforeEach(() => {
    for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.RETELL_API_KEY = 'key_test';
    process.env.RETELL_FROM_NUMBER = '+390200000001';
    process.env.RETELL_API_BASE = retell.url;
  });
  afterEach(() => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('retellEnv legge modalità e numeri dall\'ambiente', () => {
    expect(retellEnv()).toMatchObject({ testMode: false, testNumbers: [] });
    process.env.VERCEL_ENV = 'preview';
    process.env.RETELL_TEST_NUMBERS = '02 5550 0101; +390255500102';
    expect(retellEnv()).toMatchObject({ testMode: true, testNumbers: [ALLOWED, '+390255500102'] });
  });

  it('anteprima: numero ammesso parte, gli altri 403, nessuna richiesta a Retell', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.RETELL_TEST_NUMBERS = ALLOWED;
    const before = retell.created.length;
    const blocked = await invoke(retellCall, { method: 'POST', body: { ...BODY, phone: OTHER } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body).toEqual({ error: TEST_NUMBER_NOT_ALLOWED });
    expect(retell.created.length).toBe(before);
    const ok = await invoke(retellCall, { method: 'POST', body: BODY });
    expect(ok.statusCode).toBe(200);
    expect(retell.created.at(-1)!.payload.to_number).toBe(ALLOWED);

    delete process.env.RETELL_TEST_NUMBERS;
    const none = await invoke(retellCall, { method: 'POST', body: BODY });
    expect(none.statusCode).toBe(403);
    expect(none.body).toEqual({ error: TEST_NO_NUMBERS });
  });

  it('produzione con OPTIROUTE_TEST_MODE=1: nessun blocco', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.OPTIROUTE_TEST_MODE = '1';
    const res = await invoke(retellCall, { method: 'POST', body: { ...BODY, phone: OTHER } });
    expect(res.statusCode).toBe(200);
    expect(retell.created.at(-1)!.payload.to_number).toBe(OTHER);
  });
});

describe('ping: campi della modalità prova', () => {
  const ping = async (env: Record<string, string>) => {
    const cloud = createCloudHandler({ env, store: null, retell: new FakeRetell() });
    return invoke(cloud, { method: 'GET', query: { op: 'ping' }, headers: {} });
  };

  it('anteprima con numeri: testMode e testNumbersConfigured, mai i numeri', async () => {
    const res = await ping({ VERCEL_ENV: 'preview', RETELL_TEST_NUMBERS: `${ALLOWED}, 0255500102` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ testMode: true, testNumbersConfigured: true });
    expect(JSON.stringify(res.body)).not.toMatch(/5550010/);
  });

  it('anteprima senza numeri, fuori prova, produzione', async () => {
    expect((await ping({ VERCEL_ENV: 'preview' })).body).toMatchObject({ testMode: true, testNumbersConfigured: false });
    expect((await ping({ OPTIROUTE_TEST_MODE: '1', RETELL_TEST_NUMBERS: 'abc' })).body).toMatchObject({ testMode: true, testNumbersConfigured: false });
    expect((await ping({})).body).toMatchObject({ testMode: false, testNumbersConfigured: false });
    expect((await ping({ VERCEL_ENV: 'production', OPTIROUTE_TEST_MODE: '1' })).body).toMatchObject({ testMode: false });
  });
});

describe('browser: lettura del ping', () => {
  const fakeFetch = (status: number, body: unknown) => (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as never;

  it('vale solo un testMode esplicito', () => {
    expect(testModeFromPing({ testMode: true, testNumbersConfigured: true })).toEqual({ testMode: true, testNumbersConfigured: true });
    expect(testModeFromPing({ testMode: true })).toEqual({ testMode: true, testNumbersConfigured: false });
    expect(testModeFromPing({ protocol: 1 })).toEqual(NOT_TEST_MODE);
    expect(testModeFromPing(null)).toEqual(NOT_TEST_MODE);
    expect(testModeFromPing({ testMode: 'true' as never })).toEqual(NOT_TEST_MODE);
  });

  it('risposta, campo assente, errore, pagina non JSON, rete giù', async () => {
    expect(await fetchTestMode({ fetch: fakeFetch(200, { protocol: 1, testMode: true, testNumbersConfigured: false }) }))
      .toEqual({ testMode: true, testNumbersConfigured: false });
    expect(await fetchTestMode({ fetch: fakeFetch(200, { protocol: 1, secretConfigured: true }) })).toEqual(NOT_TEST_MODE);
    expect(await fetchTestMode({ fetch: fakeFetch(500, { error: 'server' }) })).toEqual(NOT_TEST_MODE);
    expect(await fetchTestMode({ fetch: fakeFetch(200, '<!doctype html>') })).toEqual(NOT_TEST_MODE);
    expect(await fetchTestMode({ fetch: (async () => { throw new Error('rete'); }) as never })).toEqual(NOT_TEST_MODE);
  });

  it('titolo della scheda con il prefisso', () => {
    expect(testModeTitle('OptiRoute', true)).toBe('PROVA · OptiRoute');
    expect(testModeTitle('PROVA · OptiRoute', true)).toBe('PROVA · OptiRoute');
    expect(testModeTitle('PROVA · OptiRoute', false)).toBe('OptiRoute');
    expect(testModeTitle('OptiRoute', false)).toBe('OptiRoute');
  });
});

describe('pilota: ogni giorno solo in prova', () => {
  const s: AutopilotSettings = { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true };

  it('domenica: chiusa fuori prova, aperta in prova (negli orari impostati)', () => {
    expect(isWithinCallWindow(SUNDAY, s)).toBe(false);
    expect(isWithinCallWindow(SUNDAY, effectiveAutopilotSettings(s, { testMode: false }))).toBe(false);
    const prova = effectiveAutopilotSettings(s, { testMode: true });
    expect(isWithinCallWindow(SUNDAY, prova)).toBe(true);
    expect(isWithinCallWindow(at('2026-11-15', '08:59'), prova)).toBe(false);
    expect(isWithinCallWindow(at('2026-11-15', '19:30'), prova)).toBe(false);
    // sabato senza callSaturday
    expect(isWithinCallWindow(at('2026-11-14', '11:00'), s)).toBe(false);
    expect(isWithinCallWindow(at('2026-11-14', '11:00'), prova)).toBe(true);
  });

  it('prossima apertura e smistamento automatico', () => {
    const satEvening = at('2026-11-14', '20:00');
    expect(nextCallWindowStart(satEvening, s).getTime()).toBe(at('2026-11-16', '09:00').getTime());
    const prova = effectiveAutopilotSettings(s, { testMode: true });
    expect(nextCallWindowStart(satEvening, prova).getTime()).toBe(at('2026-11-15', '09:00').getTime());
    expect(autoDispatchStartDate(satEvening, s)).toBe('2026-11-17');
    expect(autoDispatchStartDate(satEvening, prova)).toBe('2026-11-16');
  });

  it('callEveryDay non si salva né si legge dalle impostazioni salvate', () => {
    const prova = effectiveAutopilotSettings(s, { testMode: true });
    expect('callEveryDay' in storableAutopilotSettings(prova)).toBe(false);
    expect(storableAutopilotSettings(s)).toBe(s);
    expect(effectiveAutopilotSettings({ ...s, callEveryDay: true }, { testMode: false }).callEveryDay).toBe(false);
    safeLocalStorage.setItem('optiroute_settings_v1', JSON.stringify({ autopilot: { ...s, callEveryDay: true } }));
    try {
      const loaded = loadAutopilotSettings();
      expect('callEveryDay' in loaded).toBe(false);
      expect(isWithinCallWindow(SUNDAY, loaded)).toBe(false);
    } finally {
      safeLocalStorage.removeItem('optiroute_settings_v1');
    }
  });

  const config = (over: Partial<AutopilotSettings> = {}): CloudConfig => ({
    technicians: [tech()],
    autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true, ...over },
    fallback: FALLBACK,
  });
  const world = (): Appointment[] => [
    stop('x', '2026-11-17', '10:00', '10:20', P.portaVenezia, { title: 'Cliente X', sequenceOrder: 1, phone: ALLOWED, autoCall: 'route', callAttempts: 0 }),
  ];

  it('motore in cloud: planningFrom prende callEveryDay dall\'ambiente, mai dalla configurazione', () => {
    const cfg = config({ callEveryDay: true });
    expect(planningFrom(cfg, SUNDAY).settings.callEveryDay).toBe(false);
    expect(planningFrom(cfg, SUNDAY, { testMode: false }).settings.callEveryDay).toBe(false);
    expect(planningFrom(config(), SUNDAY, { testMode: true }).settings.callEveryDay).toBe(true);
  });

  it('motore in cloud: la domenica chiama solo in prova', async () => {
    for (const testMode of [false, true]) {
      const store = new MemoryStore('optiroute:test:');
      await store.replaceAppointments(world());
      await store.writeConfig(config());
      const retell = new FakeRetell();
      const clock = { wall: 1_000_000 };
      const deps: EngineDeps = {
        store, retell, now: () => SUNDAY, clock: () => clock.wall, sleep: async ms => { clock.wall += ms; }, testMode,
      };
      const summary = await runTick(deps, 'scheduler');
      expect(summary.windowOpen, `prova=${testMode}`).toBe(testMode);
      expect(summary.callsLaunched, `prova=${testMode}`).toBe(testMode ? 1 : 0);
    }
  });

  it('il passaggio dello scheduler prende la modalità dall\'ambiente (anteprima sì, produzione no)', async () => {
    for (const [env, expected] of [[{ VERCEL_ENV: 'preview' }, 1], [{ VERCEL_ENV: 'production', OPTIROUTE_TEST_MODE: '1' }, 0]] as const) {
      const store = new MemoryStore('optiroute:test:');
      await store.replaceAppointments(world());
      await store.writeConfig(config());
      const retell = new FakeRetell();
      const clock = { wall: 1_000_000 };
      const tick = createTickHandler({
        env: { ...env, CRON_SECRET: 'segreto-di-prova-0123456789' }, store, retell,
        now: () => SUNDAY, clock: () => clock.wall, sleep: async ms => { clock.wall += ms; },
      });
      const res = await invoke(tick, { method: 'GET', headers: { authorization: 'Bearer segreto-di-prova-0123456789' } });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      expect(retell.created.length, JSON.stringify(env)).toBe(expected);
    }
  });

  it('nei giorni feriali nulla cambia', () => {
    expect(isWithinCallWindow(WEDNESDAY, s)).toBe(true);
    expect(isWithinCallWindow(WEDNESDAY, effectiveAutopilotSettings(s, { testMode: true }))).toBe(true);
  });
});

describe('pratiche di prova', () => {
  const PHONE_RAW = '02 5550 0101';
  const load = (all: Appointment[] = [], techs: Technician[] = defaultTechnicians()) => {
    const r = loadTestScenario(all, techs, PHONE_RAW);
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it('16 pratiche in attesa, codici e progetto, telefono normalizzato', () => {
    const r = load();
    const test = r.appointments.filter(isTestPratica);
    expect(test).toHaveLength(TEST_PRATICHE_COUNT);
    expect(test.map(a => a.id)).toEqual(Array.from({ length: 16 }, (_, i) => `prova-${String(i + 1).padStart(2, '0')}`));
    expect(test.map(a => a.periziaCode)).toEqual(Array.from({ length: 16 }, (_, i) => String(900001 + i)));
    for (const a of test) {
      expect(a).toMatchObject({ status: 'pending', project: 'PROVA', phone: ALLOWED });
      expect(a.province && a.comune && a.shortAddress && a.address).toBeTruthy();
      expect(a.address).toContain(a.comune!);
      expect(Number.isFinite(a.coords.lat) && Number.isFinite(a.coords.lng)).toBe(true);
    }
    // nessuna coppia di coordinate uguale
    expect(new Set(test.map(a => `${a.coords.lat},${a.coords.lng}`)).size).toBe(16);
    expect(r.phone).toBe(ALLOWED);
  });

  it('varietà per l\'operatore AI', () => {
    const test = load().appointments;
    expect(test.filter(a => a.urgent)).toHaveLength(1);
    const ref = test.filter(a => a.contactPerson);
    expect(ref).toHaveLength(3);
    for (const a of ref) {
      expect(a.contactPerson).toMatch(/^.+ — .+$/);
      expect(a.referredBy).toBe(a.title);
      // il numero resta quello di chi prova (chiamate solo ai numeri ammessi)
      expect(a.phone).toBe(ALLOWED);
    }
    // quella scritta a mano resta com'è
    expect(test.find(a => a.contactPerson === 'Paolo Ricci — geometra')?.contactNote).toBeUndefined();
    expect(test.some(a => /[A-Z]/.test(a.title) && a.title === a.title.toUpperCase() && !/\d/.test(a.title))).toBe(true);
    const noOwner = test.filter(a => a.title === a.shortAddress);
    expect(noOwner).toHaveLength(1);
    expect(test.filter(a => a.notes)).toHaveLength(4);
    expect(test.filter(a => a.durationMinutes === 40)).toHaveLength(1);
  });

  it('referenti dalla nota del portale: uno per gruppo, letti dallo stesso servizio dell\'import', () => {
    const test = load().appointments;
    const groups = testPraticheGroups();
    const fromNote = test.filter(a => a.contactNote);
    expect(fromNote).toHaveLength(2);
    expect(new Set(fromNote.map(a => groups.find(g => g.id === a.id)!.group))).toEqual(new Set(['pavia', 'milano']));
    const agente = fromNote.find(a => /AG\. IMM\./.test(a.notes || ''))!;
    expect(agente.notes).toBe(`PROVA | Contatto Prelios: CONTATTARE AG. IMM. SIG. ROBERTO NERI ${ALLOWED}`);
    expect(agente).toMatchObject({ contactPerson: 'Roberto Neri — agente immobiliare', referredBy: 'Giuseppe Marino', phone: ALLOWED });
    const agenzia = fromNote.find(a => a !== agente)!;
    expect(agenzia).toMatchObject({ contactPerson: 'Referente indicato dal cliente — agenzia immobiliare Girasole', referredBy: 'Elena De Luca', phone: ALLOWED });
    // con un numero di cellulare (scritto come lo scrive la banca) vale lo stesso
    const mobile = loadTestScenario([], defaultTechnicians(), '333 555 0109');
    if (!mobile.ok) throw new Error(mobile.error);
    expect(mobile.appointments.filter(a => a.contactNote).map(a => a.contactPerson)).toEqual([
      'Roberto Neri — agente immobiliare',
      'Referente indicato dal cliente — agenzia immobiliare Girasole',
    ]);
  });

  it('due gruppi a due tecnici diversi con i tecnici predefiniti (che ricevono la base)', () => {
    const before = defaultTechnicians();
    const r = load([], before);
    const groups = testPraticheGroups();
    const techOf = (g: string) => new Set(r.appointments.filter(a => groups.find(x => x.id === a.id)!.group === g).map(a => a.technicianId));
    const pv = techOf('pavia');
    const mi = techOf('milano');
    expect(pv.size).toBe(1);
    expect(mi.size).toBe(1);
    const [pvId] = [...pv];
    const [miId] = [...mi];
    expect(pvId).not.toBe(miId);
    // i predefiniti sono competenti: nessun tecnico aggiunto
    expect(r.technicians.map(t => t.id)).toEqual(before.map(t => t.id));
    expect(pvId).toBe(matchTechnician({ coords: TEST_GROUPS.pavia.base.coords, province: 'PV' }, before)!.id);
    expect(miId).toBe(matchTechnician({ coords: TEST_GROUPS.milano.base.coords, province: 'MI' }, before)!.id);
    // base impostata (erano senza), nient'altro cambiato
    for (const t of r.technicians) {
      const orig = before.find(o => o.id === t.id)!;
      const base = t.id === pvId ? TEST_GROUPS.pavia.base : TEST_GROUPS.milano.base;
      expect(t.baseCoords).toEqual(base.coords);
      expect(t.baseAddress).toBe(base.address);
      expect({ ...t, baseCoords: undefined, baseAddress: undefined }).toEqual({ ...orig, baseCoords: undefined, baseAddress: undefined });
    }
    // ogni pratica è nella competenza del suo tecnico
    for (const a of r.appointments) expect(matchTechnician(a, r.technicians)!.id).toBe(a.technicianId);
  });

  it('ricarica: sostituisce le pratiche di prova (qualunque stato), il resto resta', () => {
    const other = appt({ id: 'vera-1', phone: '+390255500200' });
    const first = load([other]).appointments;
    const touched = first.map(a =>
      a.id === 'prova-01' ? { ...a, status: 'confirmed' as const, date: '2026-11-17', startTime: '09:00', callStatus: 'called' as const, callId: 'c1' }
      : a.id === 'prova-02' ? { ...a, status: 'cancelled' as const }
      : a
    ).filter(a => a.id !== 'prova-03');
    const again = load(touched).appointments;
    expect(again.filter(isTestPratica)).toHaveLength(16);
    expect(again.filter(isTestPratica).every(a => a.status === 'pending' && !a.callId && !a.date)).toBe(true);
    expect(again.find(a => a.id === 'vera-1')).toBe(other);
    expect(again).toHaveLength(17);
    expect(removeTestPratiche(again)).toEqual([other]);
    const none = [other];
    expect(removeTestPratiche(none)).toBe(none);
  });

  it('senza «Parti da zero»: le altre pratiche restano e nessuna è contata come eliminata', () => {
    const others = [
      appt({ id: 'vecchia-1', phone: '+390255500201', status: 'confirmed', date: '2026-11-17', startTime: '09:00' }),
      appt({ id: 'vecchia-2', phone: '+390255500202' }),
    ];
    const r = load([...others, ...load().appointments]);
    expect(r.removedOthers).toBe(0);
    expect(r.appointments).toHaveLength(18);
    expect(r.appointments.slice(0, 2)).toEqual(others);
    expect(loadTestScenario(others, defaultTechnicians(), PHONE_RAW, { wipeAll: false })).toMatchObject({ ok: true, removedOthers: 0 });
  });

  it('con «Parti da zero»: restano SOLO le 16 nuove in attesa, con il conto delle altre eliminate', () => {
    const others = [
      appt({ id: 'vecchia-1', phone: '+390255500201', status: 'confirmed', date: '2026-11-17', startTime: '09:00' }),
      appt({ id: 'vecchia-2', phone: '+390255500202', status: 'proposed', date: '2026-11-18', startTime: '10:00' }),
      appt({ id: 'vecchia-3', phone: '+390255500203' }),
    ];
    const oldTest = load().appointments.map(a => (a.id === 'prova-01' ? { ...a, status: 'confirmed' as const } : a));
    const r = loadTestScenario([...others, ...oldTest], defaultTechnicians(), PHONE_RAW, { wipeAll: true });
    if (!r.ok) throw new Error(r.error);
    expect(r.removedOthers).toBe(3);   // le pratiche di prova non contano
    expect(r.appointments).toHaveLength(TEST_PRATICHE_COUNT);
    expect(r.appointments.every(a => isTestPratica(a) && a.status === 'pending')).toBe(true);
    // niente da eliminare: conto a zero
    const empty = loadTestScenario([], defaultTechnicians(), PHONE_RAW, { wipeAll: true });
    expect(empty).toMatchObject({ ok: true, removedOthers: 0 });
  });

  it('numero non valido: niente modifiche', () => {
    expect(loadTestScenario([appt({ id: 'vecchia-1' })], defaultTechnicians(), 'abc', { wipeAll: true }).ok).toBe(false);
    expect(loadTestScenario([], defaultTechnicians(), 'abc').ok).toBe(false);
    expect(loadTestScenario([], defaultTechnicians(), '').ok).toBe(false);
  });
});

describe('sistemazione dei tecnici', () => {
  it('nessun tecnico: si aggiungono i due tecnici di prova con la base', () => {
    const r = prepareTestTechnicians([]);
    expect(r.technicians.map(t => [t.name, t.provinces])).toEqual([
      ['Tecnico di prova Pavia', ['PV']],
      ['Tecnico di prova Milano', ['MI', 'NO']],
    ]);
    expect(r.technicians.every(t => t.active && t.baseCoords && t.baseAddress)).toBe(true);
    expect(r.techByGroup).toEqual({ pavia: 'tech-prova-pavia', milano: 'tech-prova-milano' });
    // secondo caricamento: li riusa, nessun doppione
    const again = prepareTestTechnicians(r.technicians);
    expect(again.technicians).toEqual(r.technicians);
  });

  it('tecnico con la base: non si tocca', () => {
    const t = tech({ id: 't-pv', provinces: ['PV'], baseCoords: { lat: 45.1, lng: 9.2 }, baseAddress: 'Base esistente' });
    const r = prepareTestTechnicians([t, tech({ id: 't-mi', provinces: ['MI', 'NO'], baseCoords: { lat: 45.4, lng: 9.1 } })]);
    expect(r.technicians[0]).toBe(t);
    expect(r.techByGroup).toEqual({ pavia: 't-pv', milano: 't-mi' });
  });

  it('un solo tecnico per tutte le province: il secondo gruppo va a un tecnico di prova', () => {
    const solo = tech({ id: 'solo', provinces: ['PV', 'MI', 'NO'], baseCoords: { lat: 45.2, lng: 9.1 } });
    const r = prepareTestTechnicians([solo]);
    expect(r.techByGroup.pavia).toBe('solo');
    expect(r.techByGroup.milano).toBe('tech-prova-milano');
    expect(r.technicians[0]).toBe(solo);
  });

  it('tecnico competente spento: non conta, si aggiunge quello di prova', () => {
    const off = tech({ id: 'off', provinces: ['PV'], active: false });
    const r = prepareTestTechnicians([off, tech({ id: 't-mi', provinces: ['MI', 'NO'] })]);
    expect(r.techByGroup.pavia).toBe('tech-prova-pavia');
    expect(r.technicians.find(t => t.id === 'off')).toBe(off);
  });
});
