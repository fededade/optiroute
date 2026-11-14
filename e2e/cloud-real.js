// Prova reale "a browser chiuso": il browser A carica i dati sul cloud,
// approva il giro e si chiude; da lì in poi avanzano SOLO i passaggi dello
// scheduler (come farà Vercel ogni 15 minuti) sui bundle veri delle funzioni
// (api/cloud.js, api/cloud-tick.js) con archivio in memoria e Retell finto.
// Alla fine un browser B nuovo ritrova lo stato aggiornato.
// Interfaccia INTEGRATA (sezioni + finestre a schede).
// Avvio (server Vite e server cloud di sviluppo già accesi):
//   cd <repo> && PORT=8791 CRON_SECRET=chiave-e2e-0123456789abcdefghij FAKE_RETELL=1 node scripts/dev-cloud-server.mjs
//   VITE_PORT=5271 CLOUD_PORT=8791 node cloud-real.js
const { chromium } = require('playwright');
const { assert, counter, report } = require('./lib');
const path = require('path');
const fs = require('fs');

const APP = `http://127.0.0.1:${process.env.VITE_PORT || 5271}`;
const CLOUD = `http://127.0.0.1:${process.env.CLOUD_PORT || 8791}`;
const KEY = 'chiave-e2e-0123456789abcdefghij';
const OUT = path.join(__dirname, 'shots-cloud-real');
fs.mkdirSync(OUT, { recursive: true });
const T0 = '2026-11-11T10:00:00+01:00'; // mercoledì, fascia chiamate aperta
const D = '2026-11-13';

const P = {
  milano: { lat: 45.4642, lng: 9.19 }, pv: { lat: 45.4746, lng: 9.205 }, sesto: { lat: 45.5353, lng: 9.2337 },
  navigli: { lat: 45.452, lng: 9.176 }, lodi: { lat: 45.3097, lng: 9.5037 },
};
const TECH = { id: 'tech-1', name: 'Tecnico Uno', color: '#2563eb', active: true, provinces: ['MI'], areas: [],
  baseAddress: 'Piazza Duomo, Milano', baseCoords: P.milano, workStart: '08:30', workEnd: '18:00', unavailability: [] };
const stop = (id, title, start, end, coords, phone, seq) => ({ id, title, address: `Via Prova ${seq}, Milano`, coords, status: 'proposed',
  date: D, startTime: start, endTime: end, technicianId: 'tech-1', province: 'MI', comune: 'Milano', phone, sequenceOrder: seq });
const pend = (id, title, coords, phone) => ({ id, title, address: `Via Attesa ${id}, Milano`, coords, status: 'pending',
  technicianId: 'tech-1', province: 'MI', comune: 'Milano', phone });
const SEED = {
  optiroute_appointments_v1: [
    stop('g1', 'Cliente Alfa', '09:00', '09:20', P.milano, '+390200000001', 1),
    stop('g2', 'Cliente Beta', '10:00', '10:20', P.pv, '+390200000002', 2),
    stop('g3', 'Cliente Gamma', '14:00', '14:20', P.sesto, '+390200000003', 3),
    pend('w1', 'Attesa Uno', P.pv, '+390200000011'),
    pend('w2', 'Attesa Due', P.lodi, '+390200000012'),
  ],
  optiroute_technicians_v1: [TECH],
  optiroute_settings_v1: { startTime: '08:30', endTimeLimit: '18:00', settingsOpen: false, autopilot: { enabled: true, autoDispatch: false } },
  optiroute_base_v1: { coords: P.milano, address: 'Piazza Duomo, Milano' },
};

const api = async (method, url, body, headers = {}) => {
  const res = await fetch(CLOUD + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};
const auth = { Authorization: `Bearer ${KEY}` };
const schedulerTick = () => api('POST', '/api/cloud-tick', undefined, { ...auth, 'user-agent': 'vercel-cron/1.0' });
const pull = async () => (await api('GET', '/api/cloud?op=pull&rev=-1&configRev=-1&device=e2e-osservatore', undefined, auth)).json;
const calls = async () => (await api('GET', '/__test/calls')).json;
const setOutcome = (phone, outcome) => api('POST', '/__test/outcome', { phone, outcome });
const byId = (snap, id) => snap.appointments.find(a => a.id === id);
const log = (...a) => console.log('[e2e]', ...a);

const newBrowserPage = async (browser, { seed, now, blockTicks }) => {
  const ctx = await browser.newContext({ timezoneId: 'Europe/Rome', locale: 'it-IT', viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  const seen = { ticks: 0, pushes: 0, retell: 0 };
  await page.route('**/*', r => (r.request().url().startsWith(APP) ? r.continue() : r.fulfill({ status: 404, body: '' })));
  await page.route('**/api/**', r => {
    if (/retell-call|call-status/.test(r.request().url())) seen.retell += 1;
    return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"non disponibile nel test"}' });
  });
  await page.route('**/api/cloud*', async r => {
    const req = r.request();
    const u = new URL(req.url());
    const op = u.searchParams.get('op');
    if (op === 'push') seen.pushes += 1;
    if (op === 'tick') {
      seen.ticks += 1;
      // Il browser A "si chiude prima del suo primo passaggio": i suoi tick non arrivano al motore
      if (blockTicks) return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"server"}' });
    }
    const response = await r.fetch({ url: CLOUD + u.pathname + u.search });
    return r.fulfill({ response });
  });
  await page.clock.install({ time: new Date(now) });
  if (seed) {
    await page.addInitScript(data => {
      if (localStorage.getItem('optiroute_appointments_v1') !== null) return;
      for (const [k, v] of Object.entries(data)) localStorage.setItem(k, JSON.stringify(v));
    }, seed);
  }
  await page.goto(APP);
  return { ctx, page, seen };
};

const goSection = async (page, id) => {
  await page.getByTestId(`nav-${id}`).click();
  await page.waitForSelector(`[data-testid="section-${id}"]`);
};
const openSettings = page => page.locator('[data-testid="autopilot-bar"] button[title^="Impostazioni del pilota"]').click();
const activateCloud = async page => {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Cloud', exact: true }).click(); // finestre nuove: scheda Cloud
  await page.getByLabel('Chiave di accesso del cloud').fill(KEY);
  await page.getByRole('button', { name: 'Prova collegamento' }).last().click();
  await page.locator('[data-testid="cloud-checks"] li[data-check="key"]').waitFor();
  await page.getByRole('button', { name: 'Attiva il cloud su questo browser' }).click();
};

(async () => {
  // --- preparazione: archivio vuoto, orologio del motore fissato ---
  assert.equal((await api('POST', '/__test/reset')).status, 200);
  assert.equal((await api('POST', '/__test/now', { now: T0 })).status, 200);
  assert.deepEqual((await api('GET', '/api/cloud?op=ping')).json, { protocol: 1, secretConfigured: true, storeConfigured: true, gestionale: { enabled: false, parentAllowed: false } });
  assert.equal((await api('GET', '/api/cloud?op=status')).status, 401, 'senza chiave: 401');
  assert.equal((await api('GET', '/api/cloud?op=status', undefined, { Authorization: 'Bearer sbagliata' })).status, 401);

  const browser = await chromium.launch();

  // --- 1) browser A: attiva il cloud (carica i dati) e approva il giro ---
  const A = await newBrowserPage(browser, { seed: SEED, now: T0, blockTicks: true });
  await goSection(A.page, 'proposte'); // all'avvio si apre Panoramica: il giro sta in Proposte
  await A.page.getByText('Cliente Alfa').first().waitFor();
  await activateCloud(A.page);
  await A.page.locator('[data-testid="cloud-chip"]').waitFor({ timeout: 20000 });
  await A.page.screenshot({ path: path.join(OUT, '1-A-cloud-attivato.png') });
  // chiude la finestra delle impostazioni se è rimasta aperta
  const annulla = A.page.getByRole('button', { name: 'Annulla' });
  if (await annulla.count()) await annulla.first().click().catch(() => {});

  let snap = await pull();
  assert.equal(snap.appointments.length, 5, 'le 5 pratiche del browser sono sul cloud');
  assert.equal(snap.config.autopilot.enabled, true);
  log('caricate sul cloud:', snap.appointments.length, 'pratiche · rev', snap.rev);

  await goSection(A.page, 'proposte');
  await A.page.getByRole('button', { name: 'Approva e chiama', exact: true }).first().click();
  await A.page.waitForFunction(() => true, null, { timeout: 1000 }).catch(() => {});
  for (let i = 0; i < 40; i++) { // attende che la push dell'approvazione sia arrivata al server
    snap = await pull();
    if (['g1', 'g2', 'g3'].every(id => byId(snap, id).autoCall === 'route')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.deepEqual(['g1', 'g2', 'g3'].map(id => byId(snap, id).autoCall), ['route', 'route', 'route'], 'approvazione arrivata al server');
  assert.equal(A.seen.retell, 0, 'con il cloud attivo il browser non telefona da solo');
  assert.equal((await calls()).length, 0, 'nessuna chiamata ancora: il motore non ha fatto passaggi');
  await A.page.screenshot({ path: path.join(OUT, '2-A-giro-approvato.png') });

  // --- 2) IL BROWSER SI CHIUDE ---
  await A.ctx.close();
  log('browser A chiuso. Da qui lavora solo lo scheduler.');

  // --- 3) passaggio dello scheduler: partono le chiamate ---
  let tick = await schedulerTick();
  assert.equal(tick.status, 200);
  log('passaggio 1:', JSON.stringify(tick.json.summary));
  assert.equal(tick.json.summary.callsLaunched, 3, 'tre chiamate avviate dal server');
  let cs = await calls();
  assert.equal(cs.length, 3);
  const dyn = c => c.body.retell_llm_dynamic_variables || {};
  assert.ok(cs.every(c => typeof dyn(c).call_script === 'string' && dyn(c).call_script.length > 200), 'script completo passato a Retell');
  assert.ok(cs.some(c => dyn(c).ha_alternative === 'si'), 'alternative reali offerte in chiamata');
  snap = await pull();
  assert.ok(['g1', 'g2', 'g3'].every(id => byId(snap, id).callStatus === 'called' && byId(snap, id).callId), 'chiamate registrate sulle pratiche');
  const g3Alts = byId(snap, 'g3').offeredAlternatives || [];
  log('alternative offerte a Gamma:', g3Alts.map(a => `${a.label} ${a.date} ${a.startTime}`).join(' · '));

  // un secondo passaggio subito dopo non richiama nessuno (idempotenza)
  tick = await schedulerTick();
  assert.equal(tick.json.summary.callsLaunched, 0);
  assert.equal((await calls()).length, 3, 'nessuna doppia chiamata');

  // --- 4) i clienti rispondono: confermato, rifiutato, nessuna risposta ---
  await setOutcome('+390200000001', { esito_appuntamento: 'confermato', summary: 'Il cliente conferma.' });
  await setOutcome('+390200000002', { esito_appuntamento: 'rifiutato', summary: 'Non interessato.' });
  await setOutcome('+390200000003', { disconnection_reason: 'dial_no_answer' });
  tick = await schedulerTick();
  log('passaggio 3:', JSON.stringify(tick.json.summary));
  assert.equal(tick.json.summary.outcomesApplied, 3);
  snap = await pull();
  assert.equal(byId(snap, 'g1').status, 'confirmed', 'Alfa confermata');
  assert.equal(byId(snap, 'g2').status, 'standby', 'Beta in stand-by');
  assert.deepEqual(byId(snap, 'g2').declinedDates, [D], 'la data rifiutata non verrà riproposta');
  const w1 = byId(snap, 'w1');
  assert.equal(w1.status, 'proposed', 'una pratica in attesa ha preso lo slot liberato');
  assert.equal(w1.date, D);
  assert.equal(w1.backfillOf, 'Cliente Beta');
  log(`rimpiazzo: ${w1.title} alle ${w1.startTime} al posto di Cliente Beta`);
  // il rimpiazzo viene chiamato nello stesso passaggio
  cs = await calls();
  assert.equal(tick.json.summary.callsLaunched, 1, 'il rimpiazzo è stato chiamato subito');
  assert.ok(cs.some(c => /0200000011$/.test(c.to_number || c.body.to_number || '')), 'chiamata verso il rimpiazzo');
  const g3 = byId(snap, 'g3');
  assert.equal(g3.autoCall, 'retry', 'Gamma: richiamo programmato');
  log('Gamma verrà richiamata alle', new Date(g3.autoCallNotBefore).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }));

  // il rimpiazzo risponde subito e conferma; prima dell'orario del richiamo non parte altro
  await setOutcome('+390200000011', { esito_appuntamento: 'confermato', summary: 'Conferma.' });
  tick = await schedulerTick();
  log('passaggio 4:', JSON.stringify(tick.json.summary));
  assert.equal(tick.json.summary.outcomesApplied, 1);
  assert.equal(tick.json.summary.callsLaunched, 0, 'nessun richiamo prima dell\'orario');
  snap = await pull();
  assert.equal(byId(snap, 'w1').status, 'confirmed', 'il rimpiazzo ha confermato');

  // --- 5) due ore dopo: richiamo; il cliente accetta un'alternativa ---
  await api('POST', '/__test/now', { advanceMs: 125 * 60000 });
  tick = await schedulerTick();
  log('passaggio 5 (dopo 2h05):', JSON.stringify(tick.json.summary));
  assert.equal(tick.json.summary.callsLaunched, 1, 'richiamo di Gamma partito');
  snap = await pull();
  const offered = byId(snap, 'g3').offeredAlternatives || [];
  assert.ok(offered.length > 0, 'alternative offerte anche nel richiamo');
  const alt = offered[0];
  await setOutcome('+390200000003', { esito_appuntamento: 'riprogrammare', alternativa_scelta: alt.label, summary: 'Preferisce un altro giorno.' });
  tick = await schedulerTick();
  log('passaggio 6:', JSON.stringify(tick.json.summary));
  snap = await pull();
  const g3b = byId(snap, 'g3');
  assert.equal(g3b.status, 'confirmed', 'Gamma confermata sullo slot alternativo');
  assert.deepEqual([g3b.date, g3b.startTime], [alt.date, alt.startTime]);
  log(`Gamma spostata su ${g3b.date} ${g3b.startTime}`);
  const w2 = byId(snap, 'w2');
  log(`slot delle 14:00 lasciato da Gamma: ${w2.status === 'proposed' ? `riempito con ${w2.title} alle ${w2.startTime} (chiamata avviata: ${tick.json.summary.callsLaunched})` : 'nessuna pratica adatta'}`);

  // nessuna sovrapposizione nel giro del 13/11
  const giro = snap.appointments.filter(a => a.date === D && (a.status === 'confirmed' || a.status === 'proposed'))
    .sort((x, y) => x.startTime.localeCompare(y.startTime));
  for (let i = 1; i < giro.length; i++) assert.ok(giro[i - 1].endTime <= giro[i].startTime, 'nessuna sovrapposizione');
  log('giro del 13/11:', giro.map(a => `${a.startTime} ${a.title} (${a.status})`).join(' | '));

  const status = (await api('GET', '/api/cloud?op=status', undefined, auth)).json;
  assert.ok(status.schedulerSeenAt, 'lo scheduler risulta visto');
  assert.equal(status.timezone.ok, true);
  const allCalls = await calls();
  const perPhone = {};
  for (const c of allCalls) { const n = c.to_number || c.body.to_number; perPhone[n] = (perPhone[n] || 0) + 1; }
  log('chiamate per numero:', JSON.stringify(perPhone));
  assert.equal(perPhone['+390200000001'], 1, 'Alfa chiamata una sola volta');
  assert.equal(perPhone['+390200000002'], 1, 'Beta chiamata una sola volta');
  assert.equal(perPhone['+390200000003'], 2, 'Gamma: chiamata + un richiamo');
  assert.equal(perPhone['+390200000011'], 1, 'il rimpiazzo chiamato una sola volta');
  const expectedStored = snap.appointments.map(a => `${a.id}:${a.status}`).sort().join(',');

  // --- 6) browser B, nuovo: inserisce la chiave e ritrova tutto ---
  const serverNow = new Date(new Date(T0).getTime() + 125 * 60000 + 60000).toISOString();
  const B = await newBrowserPage(browser, { seed: null, now: serverNow, blockTicks: false });
  await B.page.locator('[data-testid="autopilot-bar"]').waitFor();
  await activateCloud(B.page);
  await B.page.locator('[data-testid="cloud-chip"]').waitFor({ timeout: 20000 });
  const annullaB = B.page.getByRole('button', { name: 'Annulla' });
  if (await annullaB.count()) await annullaB.first().click().catch(() => {});
  // il filtro "Confermate (N)" non c'è più: il conteggio delle confermate sta
  // nella voce Agenda della barra laterale (confermate da oggi in poi: qui tutte)
  await B.page.waitForFunction(() => document.querySelector('[data-testid="count-agenda"]')?.textContent.trim() === '3', null, { timeout: 20000 });
  const hint = await B.page.locator('[data-testid="cloud-hint"]').innerText();
  assert.match(hint, /Puoi chiudere il browser/);
  const stored = await B.page.evaluate(() => JSON.parse(localStorage.getItem('optiroute_appointments_v1')).map(a => `${a.id}:${a.status}`).sort().join(','));
  assert.equal(stored, expectedStored, 'il browser B ha esattamente lo stato del server');
  assert.match(stored, /g1:confirmed/); assert.match(stored, /g2:standby/); assert.match(stored, /g3:confirmed/); assert.match(stored, /w1:confirmed/);
  await B.page.screenshot({ path: path.join(OUT, '3-B-stato-ritrovato.png') });
  // la vista sul giorno del giro
  await goSection(B.page, 'agenda'); // la data dell'agenda sta nella barra della sezione Agenda
  await B.page.locator('input[type="date"]').first().fill(D);
  await B.page.getByText('Cliente Alfa').first().waitFor();
  await B.page.screenshot({ path: path.join(OUT, '4-B-giro-del-13.png') });
  assert.equal(B.seen.retell, 0);
  await B.ctx.close();
  await browser.close();

  report();
  console.log(`\nPROVA SUPERATA: a browser chiuso il server ha avviato ${allCalls.length} chiamate, applicato gli esiti, riempito lo slot liberato, richiamato chi non rispondeva e spostato un cliente su un'alternativa; il secondo browser ha ritrovato lo stato.`);
})().catch(async e => { console.error('\nFALLITA:', e.stack || e.message); counter.failed += 1; report(); process.exit(1); });
