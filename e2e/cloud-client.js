// Prova end-to-end del pilota in cloud (lato browser) con un finto cloud in memoria.
// Interfaccia INTEGRATA (sezioni + menu della barra in alto + finestre a schede).
// Avvio: VITE_PORT=5271 node cloud-client.js   (server Vite già acceso)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = process.env.VITE_PORT || 5271;
const OUT = path.join(__dirname, 'shots-cloud-client');
fs.mkdirSync(OUT, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'chiave-di-prova-e2e';
const D = '2026-11-17';

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

// --- Finto cloud: stessa regola di fusione campo per campo del protocollo ---
const stable = v => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
};
const applyChanges = (all, changes) => {
  let list = [...all];
  for (const c of changes) {
    const i = list.findIndex(a => a.id === c.id);
    if (c.op === 'delete') { list = list.filter(a => a.id !== c.id); continue; }
    if (c.op === 'put') {
      if (i >= 0) { list[i] = { ...list[i], ...c.value }; continue; }
      const code = c.value.periziaCode && c.value.periziaCode.trim();
      const twin = code ? list.findIndex(a => (a.periziaCode || '').trim() === code) : -1;
      if (twin >= 0) { if (!list[twin].phone && c.value.phone) list[twin] = { ...list[twin], phone: c.value.phone }; continue; }
      list.push(c.value);
      continue;
    }
    if (i < 0) continue;
    const next = { ...list[i], ...c.set };
    for (const k of c.unset) delete next[k];
    list[i] = next;
  }
  return list;
};

const cloud = {
  appointments: [], config: null, rev: 1, configRev: 1, key: KEY, mode: 'ok',
  holder: null, schedulerSeenAt: null, lastTick: null, log: [],
  snapshot(device) {
    if (!this.holder) this.holder = device;
    return {
      rev: this.rev, configRev: this.configRev,
      appointments: JSON.parse(JSON.stringify(this.appointments)),
      config: this.config ? JSON.parse(JSON.stringify(this.config)) : null,
      lease: { holder: device === this.holder, deviceId: this.holder, until: new Date(Date.now() + 90000).toISOString() },
    };
  },
  edit(fn) { this.appointments = fn(this.appointments); this.rev += 1; },
};

const handleCloud = async (route, who) => {
  const req = route.request();
  const url = new URL(req.url());
  const op = url.searchParams.get('op');
  const auth = req.headers()['authorization'] || null;
  const body = req.method() === 'POST' ? req.postDataJSON() : undefined;
  cloud.log.push({ who, op, method: req.method(), url: req.url(), auth, body, at: Date.now() });
  if (cloud.mode === 'offline') return route.abort('failed');
  const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (op === 'ping') return json(200, { protocol: 1, secretConfigured: true, storeConfigured: true });
  if (auth !== `Bearer ${cloud.key}`) return json(401, { error: 'auth' });
  const device = url.searchParams.get('device') || (body && body.device) || '';
  switch (op) {
    case 'status':
      return json(200, {
        protocol: 1, env: 'production', storeConfigured: true, retellConfigured: true,
        timezone: { zone: 'Europe/Rome', ok: true }, rev: cloud.rev, configRev: cloud.configRev,
        appointmentCount: cloud.appointments.length, lastTick: cloud.lastTick,
        schedulerSeenAt: cloud.schedulerSeenAt, webhookSeenAt: null,
        webhookPath: '/api/cloud?op=webhook&token=tok-esempio', serverTime: new Date().toISOString(),
      });
    case 'pull': {
      const rev = Number(url.searchParams.get('rev'));
      const configRev = Number(url.searchParams.get('configRev'));
      const snap = cloud.snapshot(device);
      if (rev === cloud.rev && configRev === cloud.configRev) return json(200, { rev: cloud.rev, configRev: cloud.configRev, unchanged: true, lease: snap.lease });
      return json(200, snap);
    }
    case 'push':
      if (body.changes.length) { cloud.appointments = applyChanges(cloud.appointments, body.changes); cloud.rev += 1; }
      if (body.config && stable(body.config) !== stable(cloud.config)) { cloud.config = body.config; cloud.configRev += 1; }
      return json(200, cloud.snapshot(device));
    case 'init':
      cloud.appointments = body.appointments; cloud.config = body.config; cloud.rev += 1; cloud.configRev += 1;
      return json(200, cloud.snapshot(device));
    case 'tick': {
      // il "motore": lancia le chiamate in coda
      let launched = 0;
      const now = new Date().toISOString();
      if (cloud.config && cloud.config.autopilot.enabled) {
        cloud.edit(all => all.map(a => {
          if (!a.autoCall || !a.phone) return a;
          launched += 1;
          const n = { ...a, callStatus: 'called', callId: `call-${a.id}`, calledAt: now };
          delete n.autoCall; delete n.autoCallNotBefore;
          return n;
        }));
      }
      const summary = { outcomesApplied: 0, callsLaunched: launched, callsFailed: 0, recovered: 0, expired: 0, inFlight: launched, queued: 0, windowOpen: true, pilotEnabled: true, durationMs: 12 };
      cloud.lastTick = { at: now, source: 'browser', summary };
      return json(200, { summary, rev: cloud.rev, configRev: cloud.configRev });
    }
  }
  return json(400, { error: 'bad_request' });
};

// --- Dati sintetici ---
const tech = { id: 'tech-1', name: 'Tecnico Prova', color: '#2563eb', active: true, provinces: ['MI'], areas: [], baseCoords: { lat: 45.4642, lng: 9.19 }, baseAddress: 'Via Esempio 1, Milano', workStart: '08:30', workEnd: '18:00', unavailability: [] };
const proposed = (id, n, start, end, lat, lng) => ({
  id, title: `Cliente Prova ${n}`, address: `Via Finta ${n}, Milano`, coords: { lat, lng }, status: 'proposed', date: D,
  startTime: start, endTime: end, sequenceOrder: Number(id.slice(1)), technicianId: 'tech-1', phone: `+3902000000${id.slice(1)}`, province: 'MI',
});
const seedAppointments = () => [
  proposed('p1', 'Uno', '09:00', '09:20', 45.4642, 9.19),
  proposed('p2', 'Due', '10:00', '10:20', 45.4746, 9.205),
  proposed('p3', 'Tre', '11:00', '11:20', 45.4777, 9.1546),
  { id: 'w1', title: 'Cliente Prova Quattro', address: 'Via Finta 4, Milano', coords: { lat: 45.452, lng: 9.176 }, status: 'pending', technicianId: 'tech-1', province: 'MI' },
];
const seedSettings = {
  startTime: '08:30', endTimeLimit: '18:00', settingsOpen: true, autopilotIntroSeen: true,
  autopilot: { enabled: true, callWindowStart: '00:00', callWindowEnd: '23:59', callSaturday: true, autoDispatch: true },
};

const newContext = async (browser, who) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const apiLog = [];
  // In Playwright vince la route registrata per ULTIMA: prima il catch-all
  await ctx.route(() => true, route => {
    const u = route.request().url();
    if (u.startsWith(BASE)) return route.continue();
    if (route.request().resourceType() === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    return route.fulfill({ status: 204, body: '' }); // niente servizi esterni
  });
  await ctx.route(new RegExp(`127\\.0\\.0\\.1:${PORT}\\/api\\/`), route => {
    apiLog.push(route.request().url());
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
  });
  await ctx.route(/\/api\/retell-call/, route => {
    apiLog.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ callId: `local-${Date.now()}` }) });
  });
  await ctx.route(/\/api\/call-status/, route => {
    apiLog.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"pending":true}' });
  });
  await ctx.route(/\/api\/cloud\?/, route => { apiLog.push(route.request().url()); return handleCloud(route, who); });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => console.log(`[${who}] pageerror`, e.message));
  return { ctx, page, apiLog };
};

const seed = async (page, withData) => {
  await page.goto(BASE);
  await page.evaluate(({ appts, settings, techs, withData }) => {
    localStorage.clear();
    if (withData) {
      localStorage.setItem('optiroute_appointments_v1', JSON.stringify(appts));
      localStorage.setItem('optiroute_technicians_v1', JSON.stringify(techs));
    }
    localStorage.setItem('optiroute_settings_v1', JSON.stringify(settings));
  }, { appts: seedAppointments(), settings: seedSettings, techs: [tech], withData });
  await page.reload();
  await page.waitForSelector('[data-testid="autopilot-bar"]');
};

// Nuova struttura: sezioni dalla barra laterale, comandi nei menu in alto
const goSection = async (page, id) => {
  await page.getByTestId(`nav-${id}`).click();
  await page.waitForSelector(`[data-testid="section-${id}"]`);
};
// ex pannello "Impostazioni e azioni": ora il menu Pianifica, che si apre e si richiude
const pianificaToggles = async page => {
  const item = page.getByRole('menuitem', { name: /Smista pratiche per zona/ });
  await page.getByTestId('menu-pianifica').click();
  const open = await item.count() === 1;
  await page.keyboard.press('Escape');
  await item.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  const closed = await item.count() === 0;
  return open && closed;
};
const openSettings = page => page.locator('[data-testid="autopilot-bar"] button[title^="Impostazioni del pilota"]').click();
const openCloudTab = page => page.getByRole('tab', { name: 'Cloud', exact: true }).click();
const chipText = page => page.locator('[data-testid="cloud-chip"]').innerText();
const waitChip = async (page, re, timeout = 20000) => {
  await page.waitForFunction(r => {
    const el = document.querySelector('[data-testid="cloud-chip"]');
    return el && new RegExp(r).test(el.textContent || '');
  }, re.source, { timeout });
};
const stored = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), key);

(async () => {
  const browser = await chromium.launch();
  try {
    // ================= a) attivazione =================
    const A = await newContext(browser, 'A');
    await seed(A.page, true);
    await openSettings(A.page);
    await openCloudTab(A.page);
    await A.page.getByLabel('Chiave di accesso del cloud').fill(KEY);
    await A.page.getByRole('button', { name: 'Prova collegamento' }).last().click();
    await A.page.waitForSelector('[data-testid="cloud-checks"]');
    const states = await A.page.$$eval('[data-testid="cloud-checks"] li', lis => Object.fromEntries(lis.map(li => [li.dataset.check, li.dataset.state])));
    check('a) controlli: chiave ✓, database ✓, Retell ✓, fuso ✓', states.key === 'ok' && states.store === 'ok' && states.retell === 'ok' && states.tz === 'ok', JSON.stringify(states));
    check('a) scheduler mai visto -> ✗ con spiegazione', states.scheduler === 'ko');
    check('a) webhook facoltativo -> ○', states.webhook === 'info');
    const webhook = await A.page.locator('[data-testid="cloud-webhook"]').inputValue();
    check('a) indirizzo webhook = origin + webhookPath', webhook === `${BASE}/api/cloud?op=webhook&token=tok-esempio`, webhook);
    await A.page.locator('[data-testid="cloud-section"]').scrollIntoViewIfNeeded();
    await shot(A.page, 'a1-prova-collegamento');
    await A.page.getByRole('button', { name: 'Attiva il cloud su questo browser' }).click();
    await A.page.waitForSelector('[data-testid="cloud-activation-done"]');
    const inits = cloud.log.filter(r => r.op === 'init');
    check('a) cloud vuoto -> init con le pratiche locali', inits.length === 1 && inits[0].body.appointments.length === 4 && inits[0].body.replace === true);
    check('a) chiave mai negli URL', cloud.log.every(r => !r.url.includes(KEY)));
    await shot(A.page, 'a2-attivato');
    await A.page.getByRole('button', { name: 'Annulla' }).click();
    await waitChip(A.page, /sincronizzato/);
    // l'emoji ☁️ non c'è più nel chip (ridisegno: icona al posto dell'emoji)
    check('a) chip "Cloud" sincronizzato', /Cloud · sincronizzato alle \d\d:\d\d/.test(await chipText(A.page)), await chipText(A.page));
    const hint = await A.page.locator('[data-testid="cloud-hint"]').innerText();
    check('a) scheduler non visto -> avviso "a browser chiuso non avanzerebbe"', /non avanzerebbe/.test(hint));
    await shot(A.page, 'a3-chip-sincronizzato');

    // pannello richiudibile con il cloud attivo -> ora il menu Pianifica
    check('regressione: menu Pianifica (ex "Impostazioni e azioni") apribile e richiudibile (cloud attivo)', await pianificaToggles(A.page));

    // ================= b) modifica locale + esito dal server =================
    const pushesBefore = cloud.log.filter(r => r.op === 'push').length;
    await goSection(A.page, 'proposte');
    await A.page.locator('#appt-p1 button[title="Conferma questa proposta"]').click();
    // la conferma propone la chiamata: si chiude la finestra
    const closeCall = A.page.getByRole('button', { name: /Non chiamare|Chiudi/ }).first();
    if (await closeCall.count()) await closeCall.click().catch(() => {});
    await sleep(1500);
    const newPushes = cloud.log.filter(r => r.op === 'push').slice(pushesBefore);
    const firstChanges = newPushes[0] && newPushes[0].body.changes;
    check('b) conferma -> push con le SOLE differenze',
      newPushes.length >= 1 && firstChanges.length === 1 && firstChanges[0].id === 'p1' && firstChanges[0].op === 'patch' && Object.keys(firstChanges[0].set).join() === 'status',
      JSON.stringify(firstChanges));
    // il motore applica un esito a p2
    cloud.edit(all => all.map(a => a.id === 'p2'
      ? { ...a, status: 'confirmed', callStatus: 'called', callId: 'call-p2', callOutcome: { result: 'confermato', summary: 'Il cliente conferma.', receivedAt: new Date().toISOString() } }
      : a));
    await A.page.waitForFunction(() => {
      const list = JSON.parse(localStorage.getItem('optiroute_appointments_v1') || '[]');
      return list.find(a => a.id === 'p2')?.status === 'confirmed';
    }, null, { timeout: 15000 });
    const listA = await stored(A.page, 'optiroute_appointments_v1');
    check('b) esito del server arrivato col pull (p2 confermata)', listA.find(a => a.id === 'p2').callOutcome?.result === 'confermato');
    check('b) modifica locale conservata (p1 confermata)', listA.find(a => a.id === 'p1').status === 'confirmed');
    // solo per la schermata: la conferma è in Agenda, sul giorno del giro
    await goSection(A.page, 'agenda');
    await A.page.getByRole('button', { name: /17 nov/i }).first().click({ timeout: 3000 }).catch(() => {});
    await A.page.evaluate(() => document.querySelector('#appt-p2')?.scrollIntoView());
    await shot(A.page, 'b-esito-dal-server');

    // ================= c) secondo browser =================
    cloud.schedulerSeenAt = new Date(Date.now() - 5 * 60000).toISOString();
    const B = await newContext(browser, 'B');
    await seed(B.page, false);
    await openSettings(B.page);
    await openCloudTab(B.page);
    await B.page.getByLabel('Chiave di accesso del cloud').fill(KEY);
    await B.page.getByRole('button', { name: 'Attiva il cloud su questo browser' }).click();
    await B.page.waitForSelector('[data-testid="cloud-activation-done"]');
    check('c) browser vuoto -> adotta il cloud (nessun nuovo init)', cloud.log.filter(r => r.op === 'init').length === 1);
    await B.page.getByRole('button', { name: 'Annulla' }).click();
    await waitChip(B.page, /sincronizzato/);
    await B.page.waitForFunction(() => JSON.parse(localStorage.getItem('optiroute_appointments_v1') || '[]').length === 4, null, { timeout: 10000 });
    const listB = await stored(B.page, 'optiroute_appointments_v1');
    check('c) il secondo browser vede le stesse pratiche', stable(listB.map(a => [a.id, a.status]).sort()) === stable(cloud.appointments.map(a => [a.id, a.status]).sort()));
    const techB = await stored(B.page, 'optiroute_technicians_v1');
    check('c) e gli stessi tecnici', techB && techB[0]?.name === 'Tecnico Prova');
    const hintB = await B.page.locator('[data-testid="cloud-hint"]').innerText();
    check('c) scheduler visto -> "Puoi chiudere il browser"', /Puoi chiudere il browser/.test(hintB), hintB);
    const leaseB = await B.page.locator('[data-testid="cloud-lease"]').count();
    check('c) turno: B non ha gli automatismi -> "Automatismi attivi su un altro dispositivo"', leaseB === 1);
    await shot(B.page, 'c1-secondo-browser');
    // A cambia impostazioni (tentativi) e mette in pausa
    await openSettings(A.page);
    await A.page.locator('input[type="number"]').first().fill('5');
    await A.page.getByRole('button', { name: 'Salva' }).click();
    await A.page.getByRole('button', { name: /Pausa/ }).click();
    await B.page.waitForFunction(() => {
      const s = JSON.parse(localStorage.getItem('optiroute_settings_v1') || '{}');
      return s.autopilot && s.autopilot.maxAttempts === 5 && s.autopilot.enabled === false;
    }, null, { timeout: 20000 });
    check('c) impostazioni del pilota cambiate in A arrivano in B', true);
    check('c) B mostra il pilota spento', /Pilota automatico spento/.test(await B.page.locator('[data-testid="autopilot-bar"]').innerText()));
    await shot(B.page, 'c2-impostazioni-arrivate');
    // niente ping-pong: dopo l'adozione B non rimanda la configurazione
    const configPushesB = () => cloud.log.filter(r => r.who === 'B' && r.op === 'push' && r.body.config).length;
    const before = configPushesB();
    await sleep(12000);
    check('c) nessun ping-pong della configurazione', configPushesB() === before, `push config di B: ${configPushesB()}`);
    // A riattiva il pilota
    await A.page.getByRole('button', { name: 'Attiva', exact: true }).click();
    await sleep(1000);

    // ================= d) "Approva e chiama" con il cloud =================
    const retellBefore = A.apiLog.filter(u => u.includes('/api/retell-call')).length;
    const ticksBefore = cloud.log.filter(r => r.op === 'tick' && r.who === 'A').length;
    await goSection(A.page, 'proposte');
    await A.page.getByRole('button', { name: 'Approva e chiama', exact: true }).first().click();
    const t0 = Date.now();
    await sleep(4000);
    const ticks = cloud.log.filter(r => r.op === 'tick' && r.who === 'A');
    const queuePush = cloud.log.filter(r => r.op === 'push' && r.who === 'A' && r.at >= t0 - 100).find(r => r.body.changes.some(c => c.set && c.set.autoCall));
    check('d) push con la coda (autoCall)', !!queuePush);
    check('d) passaggio del motore (op=tick) subito dopo', ticks.length > ticksBefore && ticks[ticks.length - 1].at - queuePush.at < 3000, `${ticks.length - ticksBefore} tick`);
    check('d) il browser NON chiama /api/retell-call da solo', A.apiLog.filter(u => u.includes('/api/retell-call')).length === retellBefore);
    check('d) il browser non interroga /api/call-status (esiti dal server)', A.apiLog.filter(u => u.includes('/api/call-status')).length === 0);
    const p3 = (await stored(A.page, 'optiroute_appointments_v1')).find(a => a.id === 'p3');
    check('d) chiamata lanciata dal server visibile nel browser', p3.callStatus === 'called' && !p3.autoCall);
    const tickText = await A.page.locator('[data-testid="cloud-tick"]').innerText();
    check('d) ultimo passaggio del motore mostrato (con la chiamata avviata)', /Ultimo passaggio del motore alle \d\d:\d\d · (alle \d\d:\d\d: )?1 chiamata avviata/.test(tickText), tickText);
    await A.page.evaluate(() => document.querySelector('#appt-p3')?.scrollIntoView());
    await shot(A.page, 'd-approva-e-chiama-cloud');

    // ================= e) chiave errata / non raggiungibile =================
    const C = await newContext(browser, 'C');
    await seed(C.page, true);
    await openSettings(C.page);
    await openCloudTab(C.page);
    await C.page.getByLabel('Chiave di accesso del cloud').fill('chiave-sbagliata');
    await C.page.getByRole('button', { name: 'Prova collegamento' }).last().click();
    await C.page.waitForSelector('[data-testid="cloud-checks"]');
    const keyState = await C.page.locator('[data-testid="cloud-checks"] li[data-check="key"]').innerText();
    check('e) chiave errata -> ✗ con spiegazione', /✗/.test(keyState) && /Chiave errata/.test(keyState), keyState.replace(/\n/g, ' '));
    await C.page.getByRole('button', { name: 'Attiva il cloud su questo browser' }).click();
    await C.page.waitForSelector('[data-testid="cloud-activation-error"]');
    check('e) attivazione con chiave errata -> messaggio chiaro', /Chiave di accesso errata/.test(await C.page.locator('[data-testid="cloud-activation-error"]').innerText()));
    await C.page.locator('[data-testid="cloud-section"]').scrollIntoViewIfNeeded();
    await shot(C.page, 'e1-chiave-errata');
    check('e) dati locali intatti', (await stored(C.page, 'optiroute_appointments_v1')).length === 4 && (await stored(C.page, 'optiroute_cloud_v1')).enabled === false);
    await C.ctx.close();

    // server non raggiungibile (A) e ripresa
    cloud.mode = 'offline';
    // "Forza Conferma Oggi" ora è nel menu "Altre azioni" della scheda in attesa
    await goSection(A.page, 'in-attesa');
    await A.page.locator('#appt-w1').getByRole('button', { name: /Altre azioni/ }).click();
    await A.page.getByRole('menuitem').and(A.page.getByTitle("Forza la conferma nella data dell'agenda")).click();
    const closeCall2 = A.page.getByRole('button', { name: /Non chiamare|Chiudi/ }).first();
    if (await closeCall2.count()) await closeCall2.click().catch(() => {});
    await waitChip(A.page, /non raggiungibile/, 15000);
    check('e) chip "non raggiungibile" con modifiche in attesa', /le modifiche restano qui/.test(await chipText(A.page)), await chipText(A.page));
    await shot(A.page, 'e2-non-raggiungibile');
    await sleep(3000);
    cloud.mode = 'ok';
    await waitChip(A.page, /sincronizzato/, 40000);
    check('e) ripresa automatica: modifica arrivata al server', cloud.appointments.find(a => a.id === 'w1').status === 'confirmed');
    await shot(A.page, 'e3-ripreso');
    // ================= extra: scollegamento di B =================
    const bPushes = () => cloud.log.filter(r => r.who === 'B' && r.op === 'push').length;
    const bPushesBefore = bPushes();
    const bReqBefore = cloud.log.filter(r => r.who === 'B').length;
    await openSettings(B.page);
    await openCloudTab(B.page);
    await B.page.getByRole('button', { name: 'Scollega questo browser' }).click();
    await B.page.waitForSelector('[data-testid="cloud-activation-done"]');
    await shot(B.page, 'g-scollegato');
    await B.page.getByRole('button', { name: 'Salva' }).click();
    await sleep(12000);
    const bCloud = await stored(B.page, 'optiroute_cloud_v1');
    const bSettings = await stored(B.page, 'optiroute_settings_v1');
    check('g) scollegato: cloud spento e pilota locale spento su B', bCloud.enabled === false && bSettings.autopilot.enabled === false);
    check('g) la pausa locale NON arriva al server (pilota in cloud ancora attivo)', bPushes() === bPushesBefore && cloud.config.autopilot.enabled === true);
    check('g) B non parla più col cloud', cloud.log.filter(r => r.who === 'B').length === bReqBefore);
    await B.ctx.close();

    // chiave cambiata sul server: chip "chiave errata", dati locali intatti
    const beforeAuth = (await stored(A.page, 'optiroute_appointments_v1')).length;
    cloud.key = 'chiave-ruotata';
    await waitChip(A.page, /chiave errata/, 40000);
    check('e) chiave non più valida -> chip "chiave errata"', true, await chipText(A.page));
    check('e) nessuna perdita di dati locali', (await stored(A.page, 'optiroute_appointments_v1')).length === beforeAuth);
    await shot(A.page, 'e4-chip-chiave-errata');
    await A.ctx.close();

    // ================= f) regressione a cloud spento =================
    const F = await newContext(browser, 'F');
    await seed(F.page, true);
    await goSection(F.page, 'proposte');
    await F.page.getByRole('button', { name: 'Approva e chiama', exact: true }).first().click();
    await F.page.waitForFunction(() => true);
    let launched = false;
    for (let i = 0; i < 20 && !launched; i++) { await sleep(500); launched = F.apiLog.some(u => u.includes('/api/retell-call')); }
    check('f) cloud spento: "Approva e chiama" fa partire /api/retell-call', launched);
    await sleep(2000);
    check('f) cloud spento: nessuna richiesta a /api/cloud', F.apiLog.every(u => !u.includes('/api/cloud')) && cloud.log.every(r => r.who !== 'F'));
    check('f) nessun chip del cloud', await F.page.locator('[data-testid="cloud-chip"]').count() === 0);
    check('f) "Tieni aperta questa scheda" come prima', /Tieni aperta questa scheda/.test(await F.page.locator('[data-testid="autopilot-bar"]').innerText()));
    check('f) menu Pianifica (ex pannello "Impostazioni e azioni") apribile e richiudibile', await pianificaToggles(F.page));
    await shot(F.page, 'f-cloud-spento');
    await F.ctx.close();
  } catch (err) {
    console.error('ERRORE', err);
    results.push({ name: 'eccezione', ok: false, extra: String(err) });
  } finally {
    await browser.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} controlli superati`);
  console.log(`RISULTATO passati=${results.length - failed.length} falliti=${failed.length}`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
