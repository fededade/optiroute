// E2E del pilota automatico e dell'inbox del bridge (dati sintetici).
// Interfaccia INTEGRATA (struttura a sezioni + finestre ridisegnate): cambiano
// solo i percorsi per raggiungere i comandi, le asserzioni sono quelle di prima.
// Avvio: VITE_PORT=5271 node autopilot.js [abcde]   (server Vite già acceso)
const { chromium } = require('playwright');
const { assert, counter, report } = require('./lib');
const path = require('path');
const fs = require('fs');

const ORIGIN = `http://127.0.0.1:${process.env.VITE_PORT || 5271}`;
const OUT = path.join(__dirname, 'shots-autopilot');
fs.mkdirSync(OUT, { recursive: true });

// Nuova interfaccia: si va alla sezione, i comandi stanno nei menu
const goSection = async (page, id) => {
  await page.getByTestId(`nav-${id}`).click();
  await page.waitForSelector(`[data-testid="section-${id}"]`);
};
const openPianifica = async page => {
  await page.getByTestId('menu-pianifica').click();
};
const statusText = page => page.getByTestId('autopilot-status').innerText();
const ROME_10 = Date.UTC(2026, 10, 11, 9, 0, 0); // mer 11/11/2026 10:00 Europe/Rome
const ROME_21 = Date.UTC(2026, 10, 11, 20, 0, 0); // mer 11/11/2026 21:00 Europe/Rome

const P = {
  milano: { lat: 45.4642, lng: 9.19 },
  portaVenezia: { lat: 45.4746, lng: 9.205 },
  cityLife: { lat: 45.4777, lng: 9.1546 },
  navigli: { lat: 45.452, lng: 9.176 },
  sesto: { lat: 45.5353, lng: 9.2337 },
  cinisello: { lat: 45.5558, lng: 9.2149 },
  segrate: { lat: 45.4904, lng: 9.2955 },
  rho: { lat: 45.528, lng: 9.04 },
  monza: { lat: 45.5845, lng: 9.2744 },
};

const TECH = {
  id: 'tech-1', name: 'Tecnico Uno', color: '#2563eb', active: true, provinces: ['MI'], areas: [],
  baseAddress: 'Piazza Duomo, Milano', baseCoords: P.milano, workStart: '08:30', workEnd: '18:00', unavailability: [],
};

let seq = 0;
const stop = (id, title, date, start, end, coords, over = {}) => ({
  id, title, address: `Via Prova ${++seq}, Milano`, coords, status: 'proposed', date, startTime: start, endTime: end,
  technicianId: 'tech-1', phone: `+3902000000${String(seq).padStart(2, '0')}`, province: 'MI', comune: 'Milano', ...over,
});
const pend = (id, title, coords, over = {}) => ({
  id, title, address: `Via Attesa ${++seq}, Milano`, coords, status: 'pending', technicianId: 'tech-1',
  phone: `+3902111111${String(seq).padStart(2, '0')}`, province: 'MI', comune: 'Milano', ...over,
});

const settings = (over = {}, autopilot = {}, bridge) => ({
  startTime: '08:30', endTimeLimit: '18:00', settingsOpen: true, ...over,
  autopilot: { autoDispatch: false, ...autopilot },
  ...(bridge ? { bridge } : {}),
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const log = (...a) => console.log('[e2e]', ...a);

async function newPage(browser, { time, seed, bridge }) {
  const context = await browser.newContext({ timezoneId: 'Europe/Rome', locale: 'it-IT', viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  const net = { calls: [], outcomes: {}, bridgeHits: 0, bridgeHeaders: [], bridgeUrls: [], snapshot: null };

  // Catch-all PRIMA (in Playwright vince la route registrata per ultima)
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN)) return route.continue();
    return route.abort();
  });
  await page.route('**/api/directions*', route => route.fulfill({ status: 500, body: '{}' }));
  await page.route('**/api/retell-call', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    const callId = `call-${net.calls.length + 1}`;
    net.calls.push({ ...body, callId, at: Date.now() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ callId }) });
  });
  await page.route('**/api/call-status*', route => {
    const callId = new URL(route.request().url()).searchParams.get('callId');
    const o = net.outcomes[callId];
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o ? { pending: false, outcome: o } : { pending: true }) });
  });
  // Nominatim simulato: coordinate deterministiche per via
  await page.route('https://nominatim.openstreetmap.org/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/reverse')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ address: { county: 'Milano', city: 'Milano', 'ISO3166-2-lvl6': 'IT-MI' } }) });
    }
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const where = q.includes('sesto') ? P.sesto : q.includes('monza') ? P.monza : q.includes('segrate') ? P.segrate : P.cityLife;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ lat: String(where.lat + Math.random() * 0.002), lon: String(where.lng), display_name: `${u.searchParams.get('q')}, Italia`, address: { city: 'Milano', county: 'Milano', 'ISO3166-2-lvl6': 'IT-MI' } }]),
    });
  });
  // Bridge simulato
  await page.route('http://127.0.0.1:8765/**', route => {
    const u = new URL(route.request().url());
    net.bridgeUrls.push(u.toString());
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'X-Bridge-Token' } });
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (u.pathname === '/v1/health') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ bridge: 'optiroute-bridge', version: 1 }) });
    net.bridgeHits++;
    net.bridgeHeaders.push(route.request().headers()['x-bridge-token']);
    if (route.request().headers()['x-bridge-token'] !== 'tok-prova') return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{"error":"token"}' });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(net.snapshot) });
  });

  page.on('pageerror', e => log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|Geocoding error|Routing|directions|OSRM/i.test(m.text())) log('console.error', m.text()); });
  page.on('dialog', d => { net.lastDialog = d.message(); d.accept(); });

  await page.clock.install({ time });
  await page.addInitScript(seedData => {
    if (sessionStorage.getItem('seeded')) return;
    localStorage.clear();
    for (const [k, v] of Object.entries(seedData)) localStorage.setItem(k, JSON.stringify(v));
    sessionStorage.setItem('seeded', '1');
  }, {
    optiroute_technicians_v1: [TECH],
    optiroute_base_v1: { coords: P.milano, address: 'Piazza Duomo, Milano' },
    ...seed,
  });
  if (bridge) net.snapshot = bridge;
  await page.goto(ORIGIN);
  await page.waitForSelector('[data-testid="autopilot-bar"]');
  return { context, page, net };
}

const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('optiroute_appointments_v1') || '[]'));
const byTitle = (all, t) => all.find(a => a.title === t);
async function waitFor(fn, what, timeout = 60000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`Timeout: ${what}`);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: false });
const sidebar = page => page.locator('aside');

const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function overlaps(all) {
  const groups = {};
  for (const a of all) {
    if (!['proposed', 'confirmed'].includes(a.status) || !a.date || !a.startTime) continue;
    (groups[`${a.technicianId}|${a.date}`] ||= []).push(a);
  }
  const bad = [];
  for (const [k, g] of Object.entries(groups)) {
    g.sort((x, y) => toMin(x.startTime) - toMin(y.startTime));
    for (let i = 1; i < g.length; i++) {
      if (toMin(g[i].startTime) < toMin(g[i - 1].endTime)) bad.push(`${k}: ${g[i - 1].title} ${g[i - 1].startTime}-${g[i - 1].endTime} / ${g[i].title} ${g[i].startTime}`);
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
async function scenarioA(browser) {
  const D = '2026-11-13'; // venerdì (dopodomani)
  const seed = {
    optiroute_appointments_v1: [
      stop('g1', 'Cliente Alfa', D, '09:00', '09:20', P.navigli, { sequenceOrder: 1 }),
      stop('g2', 'Cliente Beta', D, '10:00', '10:20', P.portaVenezia, { sequenceOrder: 2 }),
      stop('g3', 'Cliente Gamma', D, '11:00', '11:20', P.sesto, { sequenceOrder: 3 }),
      stop('g4', 'Cliente Delta', D, '14:00', '14:20', P.cinisello, { sequenceOrder: 4, hasLunchBreakBefore: true }),
      pend('w1', 'Attesa Uno', { lat: 45.4760, lng: 9.2070 }),
      pend('w2', 'Attesa Due', P.rho),
    ],
    optiroute_settings_v1: settings({}, {}),
  };
  const { context, page, net } = await newPage(browser, { time: ROME_10, seed });

  // Pilota spento: riga compatta
  await page.getByText('Pilota automatico spento').waitFor();
  await shot(page, 'a0-pilota-spento.png');
  // Prima attivazione: conferma in tre righe
  await page.getByRole('button', { name: 'Attiva', exact: true }).click();
  await page.getByText('Attivare il pilota automatico?').waitFor();
  await shot(page, 'a1-conferma-attivazione.png');
  await page.getByRole('button', { name: 'Attiva il pilota' }).click();
  await page.getByText('Tieni aperta questa scheda').waitFor();
  await goSection(page, 'proposte'); // i giri proposti stanno nella sezione Proposte

  // Approva e chiama il giro di venerdì
  await page.getByRole('button', { name: 'Approva e chiama', exact: true }).first().click();
  await waitFor(() => net.calls.length >= 4 && net.calls, '4 chiamate avviate', 30000);
  await sleep(500);
  const titles = net.calls.slice(0, 4).map(c => c.clientName);
  assert.deepEqual(titles, ['Cliente Alfa', 'Cliente Beta', 'Cliente Gamma', 'Cliente Delta'], 'chiamate in ordine');
  for (const c of net.calls.slice(0, 4)) assert.ok(Array.isArray(c.alternatives) && c.alternatives.length > 0, `alternatives nel body di ${c.clientName}`);
  const gaps = net.calls.slice(1, 4).map((c, i) => c.at - net.calls[i].at);
  assert.ok(gaps.every(g => g >= 1400), `lanci distanziati (${gaps.join(',')} ms)`);
  // stato: 4 chiamate in volo, nessuna in coda
  let all = await state(page);
  assert.equal(all.filter(a => a.autoCall).length, 0);
  assert.equal(all.filter(a => a.callStatus === 'called').length, 4);
  // contatori come etichette separate nella striscia del pilota
  await waitFor(async () => { const t = await statusText(page); return /In coda 0\b/.test(t) && /In corso 4\b/.test(t); }, 'In coda 0 · In corso 4', 10000);
  await shot(page, 'a2-chiamate-in-corso.png');

  // Esiti
  const callOf = t => net.calls.find(c => c.clientName === t).callId;
  const gammaAlt = net.calls.find(c => c.clientName === 'Cliente Gamma').alternatives[0];
  log('Alternativa A di Gamma:', gammaAlt);
  const now = new Date(ROME_10).toISOString();
  net.outcomes[callOf('Cliente Alfa')] = { result: 'confermato', summary: 'Confermato', receivedAt: now };
  net.outcomes[callOf('Cliente Beta')] = { result: 'rifiutato', summary: 'Non interessato', receivedAt: now };
  net.outcomes[callOf('Cliente Gamma')] = { result: 'riprogrammare', chosenAlternative: 'A', requestedDate: gammaAlt.date, requestedTime: gammaAlt.startTime, summary: 'Preferisce l\'alternativa A', receivedAt: now };
  net.outcomes[callOf('Cliente Delta')] = { result: 'non_risposto', summary: 'Segreteria', receivedAt: now };

  all = await waitFor(async () => {
    const s = await state(page);
    return s.filter(a => a.callOutcome || a.autoCall === 'retry').length >= 4 && byTitle(s, 'Cliente Delta').autoCall === 'retry' && s;
  }, 'esiti applicati', 60000);
  const alfa = byTitle(all, 'Cliente Alfa'), beta = byTitle(all, 'Cliente Beta'), gamma = byTitle(all, 'Cliente Gamma'), delta = byTitle(all, 'Cliente Delta');
  assert.equal(alfa.status, 'confirmed');
  assert.equal(beta.status, 'standby');
  assert.deepEqual(beta.declinedDates, [D]);
  assert.equal(gamma.status, 'confirmed', 'gamma confermata sull\'alternativa');
  assert.equal(gamma.date, gammaAlt.date);
  assert.equal(gamma.startTime, gammaAlt.startTime);
  assert.equal(delta.autoCall, 'retry');
  assert.equal(delta.callAttempts, 1);
  assert.equal(delta.startTime, '14:00', 'orario di Delta invariato');
  assert.equal(alfa.startTime, '09:00', 'orario di Alfa invariato');
  // Rimpiazzo: una pratica in attesa entra al posto di Beta e viene chiamata da sola
  const sub = all.find(a => a.backfillOf === 'Cliente Beta');
  assert.ok(sub, 'rimpiazzo presente');
  assert.equal(sub.title, 'Attesa Uno');
  assert.equal(sub.date, D);
  log('Rimpiazzo:', sub.title, sub.startTime, sub.autoCall, sub.callStatus);
  await page.getByText('Rimpiazza Cliente Beta').first().waitFor();
  await waitFor(() => net.calls.some(c => c.clientName === 'Attesa Uno'), 'chiamata del rimpiazzo', 30000);
  await page.getByText(/Richiamo alle \d\d:\d\d \(tentativo 2 di 3\)/).first().waitFor();
  assert.deepEqual(overlaps(await state(page)), [], 'nessuna sovrapposizione dopo gli esiti');
  await page.locator('#appt-g4').scrollIntoViewIfNeeded();
  await shot(page, 'a3-esiti-rimpiazzo-richiamo.png');
  const retryAt = new Date(delta.autoCallNotBefore);
  log('Richiamo di Delta previsto alle', retryAt.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome' }));

  // Drag su un giro con chiamate in coda/in corso: avviso, nessun ricalcolo
  // (Delta è in coda per il richiamo e il rimpiazzo è in chiamata)
  const before = await state(page);
  net.lastDialog = null;
  await dragCard(page, 'g4', 'w1');
  await waitFor(() => net.lastDialog, 'avviso riordino', 5000);
  assert.match(net.lastDialog, /chiamata in corso\/in coda/);
  const after = await state(page);
  assert.equal(byTitle(after, 'Cliente Delta').startTime, byTitle(before, 'Cliente Delta').startTime);

  // Avanza l'orologio oltre il richiamo: parte da solo
  const nDelta = net.calls.filter(c => c.clientName === 'Cliente Delta').length;
  await page.clock.fastForward('02:05:00');
  await waitFor(() => net.calls.filter(c => c.clientName === 'Cliente Delta').length > nDelta, 'richiamo di Delta partito', 40000);
  all = await state(page);
  assert.equal(byTitle(all, 'Cliente Delta').autoCall, undefined);
  await shot(page, 'a4-richiamo-partito.png');
  results.push('a) OK: 4 chiamate in sequenza con alternative; confermato/rifiutato+rimpiazzo chiamato/alternativa A/richiamo partito dopo 2h');
  await context.close();
}

async function dragCard(page, fromId, toId) {
  await page.evaluate(async ([fromId, toId]) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const src = document.getElementById(`appt-${fromId}`);
    const dst = document.getElementById(`appt-${toId}`);
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(50);
    dst.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(50);
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(50);
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [fromId, toId]);
}

// ---------------------------------------------------------------------------
async function scenarioB(browser) {
  const D = '2026-11-13';
  const seed = {
    optiroute_appointments_v1: [
      stop('g1', 'Cliente Alfa', D, '09:00', '09:20', P.navigli, { sequenceOrder: 1, autoCall: 'route' }),
      stop('g2', 'Cliente Beta', D, '10:00', '10:20', P.portaVenezia, { sequenceOrder: 2, autoCall: 'route' }),
    ],
    optiroute_settings_v1: { ...settings({}, { enabled: true }), autopilotIntroSeen: true },
  };
  const { context, page, net } = await newPage(browser, { time: ROME_21, seed });
  const status = page.getByTestId('autopilot-status');
  await status.getByText('Fascia chiamate chiusa: riprende domani alle 09:00').waitFor();
  await sleep(20000); // più di un battito del motore
  assert.equal(net.calls.length, 0, 'nessuna chiamata fuori fascia');
  const txt = await status.innerText();
  assert.match(txt, /In coda 2/);
  await shot(page, 'b-fuori-fascia.png');
  // Seconda scheda: gli automatismi restano nella prima (Web Locks)
  const page2 = await context.newPage();
  await page2.goto(ORIGIN);
  await page2.getByText("Pilota automatico attivo in un'altra scheda").waitFor();
  await page2.screenshot({ path: path.join(OUT, 'b2-seconda-scheda.png') });
  await page2.close();
  results.push(`b) OK: alle 21:00 nessuna chiamata; barra: "${txt.trim()}"; seconda scheda: "Pilota automatico attivo in un'altra scheda"`);
  await context.close();
}

// ---------------------------------------------------------------------------
const bridgePratica = (codice, intestatario, via, comune, telefono) => ({
  portal: 'prelios', codice, intestatario, via, civico: '10', comune, provincia: 'MI', telefono,
  note: '', progetto: 'Progetto Prova', tipologia: 'FULL - Acquisto', esito: telefono ? 'OK' : 'IN ATTESA', aggiornatoIl: '2026-11-11T08:00:00Z',
});
const snapshot = pratiche => ({
  bridge: 'optiroute-bridge', version: 1, generatedAt: '2026-11-11T09:00:00Z',
  portals: [{ id: 'prelios', status: 'ok', lastSync: '2026-11-11T09:00:00Z', message: null }], pratiche,
});

async function scenarioC(browser) {
  const seed = {
    optiroute_appointments_v1: [],
    optiroute_settings_v1: {
      ...settings({}, { enabled: true, autoDispatch: true }, { enabled: true, url: 'http://127.0.0.1:8765', token: 'tok-prova' }),
      autopilotIntroSeen: true,
    },
  };
  const snap1 = snapshot([
    bridgePratica('BR-1', 'Bridge Uno', 'Via Sesto', 'Sesto San Giovanni', '+390244400001'),
    bridgePratica('BR-2', 'Bridge Due', 'Via Monza', 'Monza', '+390244400002'),
    bridgePratica('BR-3', 'Bridge Tre', 'Via Segrate', 'Segrate', ''),
  ]);
  const { context, page, net } = await newPage(browser, { time: ROME_10, seed, bridge: snap1 });

  let all = await waitFor(async () => { const s = await state(page); return s.length >= 3 && s; }, 'pratiche dal bridge', 40000);
  assert.deepEqual(all.map(a => a.periziaCode).sort(), ['BR-1', 'BR-2', 'BR-3']);
  assert.ok(all.every(a => a.coords && a.technicianId === 'tech-1'), 'geocodificate e assegnate');
  assert.ok(net.bridgeHeaders.every(h => h === 'tok-prova'), 'token nell\'header');
  assert.ok(net.bridgeUrls.every(u => !u.includes('tok-prova')), 'token mai nell\'URL');
  await page.getByTestId('bridge-chip').getByText(/2 nuove pratiche|3 nuove pratiche/).waitFor();

  all = await waitFor(async () => {
    const s = await state(page);
    return s.filter(a => a.status === 'proposed').length === 2 && s;
  }, 'smistamento automatico', 40000);
  const proposed = all.filter(a => a.status === 'proposed');
  assert.ok(proposed.every(a => a.date === '2026-11-12'), 'proposte da domani');
  assert.ok(proposed.every(a => !a.autoCall), 'senza approvazione: non in coda');
  assert.equal(byTitle(all, 'Bridge Tre').status, 'pending', 'senza telefono resta in attesa');
  await sleep(4000);
  const chip1 = await page.getByTestId('bridge-chip').innerText();
  await shot(page, 'c1-bridge-import-smistamento.png');

  // Secondo snapshot: arriva il telefono di Bridge Tre
  net.snapshot = snapshot([
    bridgePratica('BR-1', 'Bridge Uno', 'Via Sesto', 'Sesto San Giovanni', '+390244400001'),
    bridgePratica('BR-2', 'Bridge Due', 'Via Monza', 'Monza', '+390299999999'), // non sovrascrive
    bridgePratica('BR-3', 'Bridge Tre', 'Via Segrate', 'Segrate', '+390244400003'),
  ]);
  await page.getByRole('button', { name: 'Scarica ora', exact: true }).click();
  all = await waitFor(async () => { const s = await state(page); return byTitle(s, 'Bridge Tre').phone && s; }, 'telefono riportato', 20000);
  assert.equal(byTitle(all, 'Bridge Tre').phone, '+390244400003');
  assert.equal(byTitle(all, 'Bridge Due').phone, '+390244400002', 'telefono esistente non sovrascritto');
  all = await waitFor(async () => { const s = await state(page); return byTitle(s, 'Bridge Tre').status === 'proposed' && s; }, 'Bridge Tre smistata', 20000);
  assert.deepEqual(overlaps(all), []);
  await page.getByTestId('bridge-chip').getByText(/telefono arrivato/).waitFor();
  const chip2 = await page.getByTestId('bridge-chip').innerText();
  await shot(page, 'c2-bridge-telefono-arrivato.png');

  // Token errato: chip dedicato
  await page.getByTitle('Impostazioni del pilota automatico e del bridge').click();
  // finestre nuove: il campo del token sta nella scheda "Bridge portali"; le
  // altre schede sono montate ma nascoste, quindi il "Prova collegamento"
  // visibile è solo quello del bridge
  await page.getByRole('tab', { name: 'Bridge portali' }).click();
  await page.getByPlaceholder('Incolla il token stampato dal bridge').fill('sbagliato');
  await page.getByRole('tabpanel').getByRole('button', { name: 'Prova collegamento' }).click();
  await page.getByText('Il bridge risponde, ma il token è errato.').waitFor();
  await shot(page, 'c3-impostazioni-token-errato.png');
  await page.getByRole('button', { name: 'Salva' }).click();
  await page.getByTestId('bridge-chip').getByText(/token errato/).waitFor();
  results.push(`c) OK: 3 pratiche dal bridge geocodificate; 2 con telefono smistate da sole il 12/11; la terza smistata quando il 2° snapshot porta il telefono. Chip: "${chip1.trim()}" → "${chip2.trim()}"`);
  await context.close();
}

// ---------------------------------------------------------------------------
async function scenarioD(browser) {
  const T = '2026-11-12';
  const seed = {
    optiroute_appointments_v1: [
      pend('p1', 'Prima Uno', P.navigli), pend('p2', 'Prima Due', P.cityLife), pend('p3', 'Prima Tre', P.portaVenezia),
    ],
    optiroute_settings_v1: settings(),
  };
  const { context, page } = await newPage(browser, { time: ROME_10, seed });
  const runDispatch = async () => {
    await openPianifica(page);
    await page.getByRole('menuitem', { name: /Smista pratiche per zona/ }).click();
    await page.getByRole('button', { name: 'Calcola proposta' }).click();
    await page.getByRole('button', { name: /Applica:/ }).click();
  };
  await runDispatch();
  let all = await waitFor(async () => { const s = await state(page); return s.filter(a => a.status === 'proposed').length === 3 && s; }, '1° smistamento');
  const first = Object.fromEntries(all.filter(a => a.status === 'proposed').map(a => [a.id, `${a.date} ${a.startTime}-${a.endTime}`]));
  log('1° smistamento', first);
  // Nuove pratiche in attesa (stesso tecnico, stessa zona)
  await page.evaluate(newOnes => {
    const s = JSON.parse(localStorage.getItem('optiroute_appointments_v1'));
    localStorage.setItem('optiroute_appointments_v1', JSON.stringify([...s, ...newOnes]));
  }, [pend('q1', 'Seconda Uno', P.navigli), pend('q2', 'Seconda Due', P.cityLife), pend('q3', 'Seconda Tre', P.segrate)]);
  await page.reload();
  await page.waitForSelector('[data-testid="autopilot-bar"]');
  await runDispatch();
  all = await waitFor(async () => { const s = await state(page); return s.filter(a => a.status === 'proposed').length === 6 && s; }, '2° smistamento');
  const bad = overlaps(all);
  assert.deepEqual(bad, [], `sovrapposizioni: ${bad.join('; ')}`);
  for (const [id, when] of Object.entries(first)) {
    const a = all.find(x => x.id === id);
    assert.equal(`${a.date} ${a.startTime}-${a.endTime}`, when, `orario di ${a.title} invariato`);
  }
  const seq = all.filter(a => a.date === T).sort((x, y) => x.sequenceOrder - y.sequenceOrder).map(a => `${a.sequenceOrder}.${a.startTime} ${a.title}`);
  log('Giro del 12/11 dopo il 2° smistamento:', seq);
  await shot(page, 'd-smistamento-ripetuto.png');
  results.push(`d) OK: secondo smistamento senza sovrapposizioni, orari delle 3 tappe esistenti invariati. Giro 12/11: ${seq.join(' | ')}`);
  await context.close();
}

// ---------------------------------------------------------------------------
async function scenarioE(browser) {
  const D = '2026-11-13';
  const seed = {
    optiroute_appointments_v1: [
      stop('g1', 'Cliente Alfa', D, '09:00', '09:20', P.navigli, { sequenceOrder: 1 }),
      stop('g2', 'Cliente Beta', D, '10:00', '10:20', P.portaVenezia, { sequenceOrder: 2 }),
      stop('g3', 'Cliente Gamma', D, '11:00', '11:20', P.sesto, { sequenceOrder: 3 }),
    ],
    optiroute_settings_v1: settings(),
  };
  const { context, page } = await newPage(browser, { time: ROME_10, seed });
  // Il vecchio pannello "Impostazioni e azioni" non c'è più: i comandi stanno
  // nei menu della barra in alto, che si aprono e si chiudono
  await openPianifica(page);
  await page.getByRole('menuitem', { name: /Smista pratiche per zona/ }).waitFor();
  await shot(page, 'e1-menu-pianifica.png');
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: /Smista pratiche per zona/ }).waitFor({ state: 'detached' });
  await openPianifica(page);
  await page.getByRole('menuitem', { name: /Smista pratiche per zona/ }).waitFor();
  await page.keyboard.press('Escape');
  await goSection(page, 'proposte');

  // Drag & drop di una proposta su un'altra: il giro si riordina
  await dragCard(page, 'g3', 'g1');
  const all = await waitFor(async () => { const s = await state(page); return byTitle(s, 'Cliente Gamma').sequenceOrder === 1 && s; }, 'riordino proposte', 10000);
  const order = all.filter(a => a.date === D).sort((x, y) => x.sequenceOrder - y.sequenceOrder).map(a => `${a.startTime} ${a.title}`);
  assert.equal(order[0].endsWith('Cliente Gamma'), true);
  await shot(page, 'e2-drag-riordinato.png');

  // Chiamata singola: l'anteprima mostra le alternative che l'agente offrirà
  await page.locator('#appt-g2').getByRole('button', { name: /Altre azioni/ }).click(); // "Chiama" sta nel menu "Altro"
  await page.getByRole('menuitem').and(page.getByTitle('Chiama il cliente per conferma (AI)')).click();
  await page.getByTestId('call-alternatives').getByText(/Se il cliente non può, l'operatore AI offrirà: .+ alle \d\d:\d\d/).waitFor();
  await shot(page, 'e2b-anteprima-alternative.png');
  await page.getByRole('button', { name: 'Non chiamare' }).click();

  // Pilota spento: "Chiama tutte" apre ancora la finestra delle chiamate in blocco
  await page.getByRole('button', { name: /Chiama tutte/ }).first().click();
  await page.getByText('Chiamate di conferma AI').waitFor();
  await shot(page, 'e3-chiama-tutte.png');
  results.push(`e) OK: menu Pianifica apribile/richiudibile; drag Gamma→Alfa riordina (${order.join(' | ')}); "Chiama tutte" apre la finestra in blocco`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  const only = process.argv[2];
  const all = { a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD, e: scenarioE };
  let failed = false;
  for (const [k, fn] of Object.entries(all)) {
    if (only && !only.includes(k)) continue;
    log(`--- scenario ${k}`);
    try { await fn(browser); } catch (e) { failed = true; counter.failed += 1; log(`FALLITO ${k}:`, e.stack || e.message); results.push(`${k}) FALLITO: ${e.message}`); }
  }
  await browser.close();
  console.log('\n' + results.join('\n'));
  report();
  process.exit(failed ? 1 : 0);
})();
