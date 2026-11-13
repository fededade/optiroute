// Prova end-to-end delle FINESTRE ridisegnate sopra la nuova STRUTTURA
// (interfaccia integrata; dati sintetici, servizi simulati).
// Lo stesso giro completo (con tutte le asserzioni) gira a 1440x900 e a 390x844,
// deviceScaleFactor 1; le schermate vanno in ./shots/<larghezza>-<finestra>.png
// Uso: VITE_PORT=5271 node finestre.js [desktop|mobile|all]   (server Vite già acceso)
const { chromium } = require('playwright');
const { assert } = require('./lib');
const path = require('path');
const fs = require('fs');

const ORIGIN = `http://127.0.0.1:${process.env.VITE_PORT || 5271}`;
const { counter } = require('./lib');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const ROME_10 = Date.UTC(2026, 10, 11, 9, 0, 0); // mer 11/11/2026 10:00 Europe/Rome
const D = '2026-11-13';
const CLOUD_KEY = 'chiave-giusta-e2e';

const P = {
  milano: { lat: 45.4642, lng: 9.19 }, portaVenezia: { lat: 45.4746, lng: 9.205 }, cityLife: { lat: 45.4777, lng: 9.1546 },
  navigli: { lat: 45.452, lng: 9.176 }, sesto: { lat: 45.5353, lng: 9.2337 }, pavia: { lat: 45.1847, lng: 9.1582 },
  torino: { lat: 45.0703, lng: 7.6869 },
};

const TECHS = [
  { id: 'tech-1', name: 'Tecnico Uno', color: '#2563eb', active: true, provinces: ['MI'],
    areas: [{ id: 'ar-1', label: 'Sesto San Giovanni', center: P.sesto, radiusKm: 10 }],
    baseAddress: 'Piazza Duomo, Milano', baseCoords: P.milano, workStart: '08:30', workEnd: '18:00',
    unavailability: [{ id: 'u-1', from: '2026-11-20', to: '2026-11-21', allDay: true, reason: 'Ferie' }, { id: 'u-2', from: '2026-11-25', allDay: false, startTime: '14:00', endTime: '18:00', reason: 'Corso di formazione' }] },
  { id: 'tech-2', name: 'Tecnica Due', color: '#d97706', active: true, provinces: ['PV'], areas: [],
    baseAddress: 'Piazza della Vittoria, Pavia', baseCoords: P.pavia, workStart: '09:00', workEnd: '17:30',
    unavailability: [{ id: 'u-3', from: '2026-11-12', to: '2026-11-12', allDay: true, reason: 'Permesso' }] },
  { id: 'tech-3', name: 'Tecnico Tre', color: '#059669', active: false, provinces: ['LO'], areas: [], workStart: '08:30', workEnd: '18:00', unavailability: [] },
];

let seq = 0;
const stop = (id, title, start, end, coords, over = {}) => ({
  id, title, address: `Via Prova ${++seq}, 20100 Milano MI`, coords, status: 'proposed', date: D, startTime: start, endTime: end,
  technicianId: 'tech-1', phone: `+39 02 0000 00${String(seq).padStart(2, '0')}`, province: 'MI', comune: 'Milano', ...over,
});
const pend = (id, title, coords, over = {}) => ({
  id, title, address: `Via Attesa ${++seq}, Milano`, coords, status: 'pending', technicianId: 'tech-1',
  phone: `+39 02 1111 11${String(seq).padStart(2, '0')}`, province: 'MI', comune: 'Milano', ...over,
});

const seedAppointments = () => [
  stop('g1', 'Cliente Alfa', '09:00', '09:20', P.navigli, { sequenceOrder: 1, callStatus: 'called' }),
  stop('g2', 'Cliente Beta', '10:00', '10:20', P.portaVenezia, { sequenceOrder: 2, periziaCode: 'PR-0001', notes: 'Citofono al secondo piano, chiedere dell\'amministratore.', contactPerson: 'Referente Esempio (amministratore)', referredBy: 'Cliente Beta' }),
  stop('g3', 'Cliente Gamma', '11:00', '11:20', P.sesto, { sequenceOrder: 3, urgent: true }),
  stop('g4', 'Cliente Delta', '12:00', '12:20', P.cityLife, { sequenceOrder: 4, phone: undefined }),
  pend('p1', 'Attesa Uno', P.navigli, { urgent: true }),
  pend('p2', 'Attesa Due', P.cityLife),
  pend('p3', 'Attesa Pavia', P.pavia, { technicianId: undefined, province: 'PV', comune: 'Pavia', address: 'Via Pavia 3, Pavia' }),
  pend('p4', 'Attesa Torino', P.torino, { technicianId: undefined, province: 'TO', comune: 'Torino', address: 'Via Torino 4, Torino' }),
  pend('p5', 'Attesa Senza Provincia', P.portaVenezia, { technicianId: undefined, province: undefined, comune: undefined, address: 'Via Senza Provincia 5' }),
];
const settings = (over = {}) => ({ startTime: '08:30', endTimeLimit: '18:00', settingsOpen: true, autopilotIntroSeen: true, autopilot: { autoDispatch: false }, ...over });

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Mappa sopralluoghi</name>
<Folder><name>13/11</name>
 <Placemark><name>Via Esempio 1 Milano MI ore 9:30 slp uno</name><description><![CDATA[ISP 100.001<br>Intestati: Prova Kappa<br>tel 3330000001]]></description><Point><coordinates>9.19,45.46,0</coordinates></Point></Placemark>
 <Placemark><name>Via Esempio 2 Milano MI ore 11</name><description><![CDATA[Intestati: Prova Lambda]]></description><Point><coordinates>9.20,45.47,0</coordinates></Point></Placemark>
</Folder>
<Folder><name>Da pianificare</name>
 <Placemark><name>Via Esempio 3 Milano MI</name><description><![CDATA[Intestati: Prova Mu]]></description><Point><coordinates>9.17,45.45,0</coordinates></Point></Placemark>
 <Placemark><name>Via Esempio 4 Milano MI</name><description><![CDATA[Intestati: Prova Nu]]></description><Point><coordinates>9.16,45.48,0</coordinates></Point></Placemark>
 <Placemark><name>Via Esempio 5 Milano MI</name><description><![CDATA[Intestati: Prova Xi]]></description><Point><coordinates>9.21,45.44,0</coordinates></Point></Placemark>
</Folder>
<Folder><name>Lavori da ultimare</name>
 <Placemark><name>Via Esempio 6 Milano MI</name><description><![CDATA[Intestati: Prova Omicron]]></description><Point><coordinates>9.22,45.49,0</coordinates></Point></Placemark>
</Folder>
<Folder><name>Periti</name>
 <Placemark><name>Sede periti</name><Point><coordinates>9.18,45.46,0</coordinates></Point></Placemark>
</Folder>
<Folder><name>Annullate 2026</name>
 <Placemark><name>Via Esempio 8 Milano MI</name><description><![CDATA[Intestati: Prova Pi]]></description><Point><coordinates>9.15,45.47,0</coordinates></Point></Placemark>
</Folder>
</Document></kml>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('optiroute_appointments_v1') || '[]'));
const stored = (page, k) => page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), k);
async function waitFor(fn, what, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error(`Timeout: ${what}`);
}
const dialog = page => page.getByRole('dialog');

async function newPage(browser, viewport, settingsOver = {}) {
  const context = await browser.newContext({ timezoneId: 'Europe/Rome', locale: 'it-IT', viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const net = { calls: [], retell: { delay: 0, fail: null }, directionsDelay: 0, cloud: [] };
  await page.route('**/*', route => (route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort()));
  await page.route('**/api/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }));
  await page.route('**/api/directions*', async route => { if (net.directionsDelay) await sleep(net.directionsDelay); route.fulfill({ status: 500, body: '{}' }); });
  await page.route('**/api/retell-call', async route => {
    if (net.retell.delay) await sleep(net.retell.delay);
    if (net.retell.fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: net.retell.fail }) });
    const body = JSON.parse(route.request().postData() || '{}');
    const callId = `call-${net.calls.length + 1}`;
    net.calls.push({ ...body, callId });
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ callId }) });
  });
  await page.route('**/api/call-status*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"pending":true}' }));
  await page.route('**/api/cloud?*', route => {
    const req = route.request();
    const u = new URL(req.url());
    const op = u.searchParams.get('op');
    net.cloud.push(op);
    const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (op === 'ping') return json(200, { protocol: 1, secretConfigured: true, storeConfigured: true });
    if (req.headers()['authorization'] !== `Bearer ${CLOUD_KEY}`) return json(401, { error: 'auth' });
    if (op === 'status') {
      return json(200, {
        protocol: 1, env: 'production', storeConfigured: true, retellConfigured: false,
        timezone: { zone: 'Europe/Rome', ok: true }, rev: 1, configRev: 1, appointmentCount: 0, lastTick: null,
        schedulerSeenAt: new Date(Date.now() - 3 * 60000).toISOString(), webhookSeenAt: null,
        webhookPath: '/api/cloud?op=webhook&token=tok-esempio', serverTime: new Date().toISOString(),
      });
    }
    return json(400, { error: 'bad_request' });
  });
  await page.route('https://nominatim.openstreetmap.org/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/reverse')) { if (net.directionsDelay) await sleep(net.directionsDelay); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ address: { county: 'Milano', city: 'Milano', 'ISO3166-2-lvl6': 'IT-MI' } }) }); }
    const q = (u.searchParams.get('q') || '').toLowerCase();
    if (q.includes('inesistente')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    const where = q.includes('sesto') ? P.sesto : q.includes('pavia') ? P.pavia : P.cityLife;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ lat: String(where.lat), lon: String(where.lng), display_name: `${u.searchParams.get('q')}, Lombardia, Italia`, address: { city: 'Milano', county: 'Milano', 'ISO3166-2-lvl6': 'IT-MI' } }]) });
  });
  page.on('pageerror', e => { console.log('PAGEERROR', e.message); net.pageErrors = (net.pageErrors || 0) + 1; });
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|Geocoding error|Routing|directions|OSRM/i.test(m.text())) console.log('console.error', m.text().slice(0, 300)); });
  page.on('dialog', d => d.accept());
  await page.clock.install({ time: ROME_10 });
  await page.addInitScript(seedData => {
    if (sessionStorage.getItem('seeded')) return;
    localStorage.clear();
    for (const [k, v] of Object.entries(seedData)) localStorage.setItem(k, JSON.stringify(v));
    sessionStorage.setItem('seeded', '1');
  }, {
    optiroute_technicians_v1: TECHS,
    optiroute_base_v1: { coords: P.milano, address: 'Piazza Duomo, Milano' },
    optiroute_appointments_v1: seedAppointments(),
    optiroute_settings_v1: settings(settingsOver),
  });
  await page.goto(ORIGIN);
  await page.waitForSelector('[data-testid="autopilot-bar"]');
  return { context, page, net };
}



// ---------------------------------------------------------------------------
// Nuova struttura: come si raggiungono i comandi (cambia solo il percorso)
const nav = page => page.getByRole('navigation', { name: 'Sezioni' });
async function openNavIfNeeded(page) {
  const opener = page.getByRole('button', { name: 'Apri il menu' }); // telefono: barra laterale a scomparsa
  if (await opener.count() && await opener.isVisible()) {
    await opener.click();
    await page.waitForTimeout(300); // transizione della barra
  }
}
async function goSection(page, id) {
  await openNavIfNeeded(page);
  await page.getByTestId(`nav-${id}`).click();
  await page.waitForSelector(`[data-testid="section-${id}"]`);
}
async function cardAction(page, apptId, title) {
  // "Chiama" e "Modifica" delle proposte stanno nel menu "Altre azioni" della scheda
  const card = page.locator(`#appt-${apptId}`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('button', { name: /Altre azioni/ }).click();
  await page.getByRole('menuitem').and(page.getByTitle(title, { exact: true })).click();
}
async function pianifica(page, item) {
  await page.getByTestId('menu-pianifica').click();
  await page.getByRole('menuitem', { name: item }).click();
}
async function openTechnicians(page) {
  await openNavIfNeeded(page);
  await nav(page).getByRole('button', { name: 'Tecnici', exact: true }).click();
}
async function importKmz(page, file) {
  // dal menu Importa: la voce apre il selettore di file
  const chooserP = page.waitForEvent('filechooser');
  await page.getByTestId('menu-importa').click();
  await page.getByRole('menuitem', { name: /Google My Maps/ }).click();
  const chooser = await chooserP;
  await chooser.setFiles(file);
}
const openSettings = page => page.locator('[data-testid="autopilot-bar"] button[title^="Impostazioni del pilota"]').click();
const newPratica = page => page.locator('header').getByRole('button', { name: 'Nuova pratica', exact: true }).click();

// ---------------------------------------------------------------------------
async function tour(browser, viewport) {
  const tag = `${viewport.width}`;
  const ok = (name, extra = '') => { results.push({ name: `[${tag}] ${name}`, ok: true, extra }); console.log(`OK   [${tag}] ${name}${extra ? ` — ${extra}` : ''}`); };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`), animations: 'disabled' });
  const { context, page, net } = await newPage(browser, viewport);
  await shot(page, 'struttura-panoramica');

  // ===== 1. Nuova pratica (bottone "Nuova pratica" nella barra in alto) =====
  await newPratica(page);
  await dialog(page).getByText('Nuovo Appuntamento').waitFor();
  await shot(page, 'pratica-nuova');
  await dialog(page).getByLabel('Cliente / Intestatario').fill('Cliente Prova Nuova');
  await dialog(page).getByLabel('Telefono').fill('abc');
  await dialog(page).getByLabel('Indirizzo *').fill('Via Sesto 10, Sesto San Giovanni');
  await dialog(page).getByRole('button', { name: 'Aggiungi', exact: true }).click();
  await dialog(page).getByText('Numero di telefono non valido.').waitFor();
  await dialog(page).getByLabel('Urgente').check().catch(async () => { await page.getByText('Urgente', { exact: true }).click(); });
  await shot(page, 'pratica-errore');
  ok('pratica: telefono non valido -> errore in pagina');
  await dialog(page).getByLabel('Telefono').fill('+39 333 1234567');
  await dialog(page).getByRole('button', { name: 'Aggiungi', exact: true }).click();
  await dialog(page).waitFor({ state: 'detached' });
  let all = await waitFor(async () => { const s = await state(page); return s.find(a => a.title === 'Cliente Prova Nuova') && s; }, 'pratica salvata');
  const nuova = all.find(a => a.title === 'Cliente Prova Nuova');
  assert.equal(nuova.phone, '+39 333 1234567');
  assert.equal(nuova.urgent, true);
  assert.equal(nuova.status, 'pending');
  ok('pratica: salvataggio della nuova pratica (telefono, urgente, in attesa)', `tecnico ${nuova.technicianId}`);

  // Esc chiude la finestra (chiusura già permessa con clic sullo sfondo)
  await newPratica(page);
  await dialog(page).waitFor();
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  ok('pratica: Esc chiude la finestra');

  // ===== 2. Chiamata: anteprima con alternative, in partenza, avviata =====
  await goSection(page, 'proposte');
  await shot(page, 'struttura-proposte');
  await cardAction(page, 'g2', 'Chiama il cliente per conferma (AI)');
  await page.getByTestId('call-alternatives').getByText(/Se il cliente non può, l'operatore AI offrirà: .+ alle \d\d:\d\d/).waitFor();
  const altText = await page.getByTestId('call-alternatives').textContent();
  assert.ok(altText.startsWith("Se il cliente non può, l'operatore AI offrirà:"), altText);
  await shot(page, 'chiamata-anteprima');
  ok('chiamata: anteprima con alternative (testo e data-testid invariati)', altText.slice(0, 90));
  net.retell.delay = 2500;
  await page.getByRole('button', { name: 'Chiama ora' }).click();
  await dialog(page).getByText('Avvio chiamata...').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Esci' }).isDisabled(), true);
  await page.mouse.click(5, 5); // clic sullo sfondo (o sull'intestazione): non deve chiudere durante la partenza
  await page.keyboard.press('Escape');
  await dialog(page).getByText('Avvio chiamata...').waitFor();
  await shot(page, 'chiamata-in-partenza');
  ok('chiamata: in partenza (X disattivata, sfondo ed Esc non chiudono)');
  await dialog(page).getByText('Chiamata avviata!').waitFor({ timeout: 10000 });
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].clientName, 'Cliente Beta');
  assert.ok(Array.isArray(net.calls[0].alternatives) && net.calls[0].alternatives.length > 0, 'alternative inviate');
  await page.getByRole('button', { name: 'Da richiamare' }).click();
  await dialog(page).getByLabel('Richiamare il').fill('2026-11-18');
  await shot(page, 'chiamata-avviata-esito');
  ok('chiamata: avviata (una sola richiesta, con le alternative) e scelta esito con data');
  await page.getByRole('button', { name: 'Chiudi', exact: true }).click();
  await dialog(page).waitFor({ state: 'detached' });

  // ===== 3. Chiamata: errore (urgente) =====
  net.retell.delay = 600;
  net.retell.fail = 'Numero non raggiungibile (prova).';
  await cardAction(page, 'g3', 'Chiama il cliente per conferma (AI)');
  await dialog(page).getByText('SOPRALLUOGO URGENTE').waitFor();
  await shot(page, 'chiamata-urgente');
  await page.getByRole('button', { name: 'Chiama ora' }).click();
  await dialog(page).getByText('Chiamata non riuscita').waitFor({ timeout: 10000 });
  await dialog(page).getByText('Numero non raggiungibile (prova).').waitFor();
  await page.getByRole('button', { name: 'Lavori da ultimare' }).click();
  await shot(page, 'chiamata-errore');
  assert.equal(await page.getByRole('button', { name: 'Riprova' }).count(), 1);
  ok('chiamata: errore con messaggio del server, "Riprova" e "Chiudi"');
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  net.retell.fail = null;

  // ===== 4. Chiamate in blocco ("Chiama tutte" nella sezione Proposte) =====
  await page.getByRole('button', { name: /Chiama tutte/ }).first().click();
  await page.getByText('Chiamate di conferma AI').waitFor();
  await shot(page, 'chiamate-blocco-selezione');
  const boxes = dialog(page).locator('input[type="checkbox"]');
  const nBoxes = await boxes.count();
  for (let i = 0; i < nBoxes; i++) await boxes.nth(i).check();
  const checked = await dialog(page).locator('input[type="checkbox"]:checked').count();
  ok('chiamate in blocco: selezione', `${checked}/${nBoxes} selezionate`);
  const startBtn = dialog(page).getByRole('button', { name: /^Avvia \d+ chiamat/ });
  const label = await startBtn.innerText();
  net.retell.delay = 1500;
  const before = net.calls.length;
  await startBtn.click();
  await dialog(page).getByText('In corso...').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Esci' }).isDisabled(), true);
  await sleep(1900);
  await shot(page, 'chiamate-blocco-in-corso');
  ok('chiamate in blocco: in corso (barra di avanzamento, stati per riga)', label.trim());
  await dialog(page).getByText(/^Completato:/).waitFor({ timeout: 30000 });
  await shot(page, 'chiamate-blocco-finite');
  const avviate = await dialog(page).locator('.chip', { hasText: 'Avviata' }).count();
  const annullate = await dialog(page).locator('.chip', { hasText: 'Annullata' }).count();
  assert.equal(net.calls.length - before, avviate);
  assert.equal(avviate + annullate, checked);
  assert.ok(await dialog(page).getByText('Chiamata già in corso').count() === annullate);
  ok('chiamate in blocco: finite, una richiesta per pratica avviata; quelle già in chiamata saltate', `${avviate} avviate, ${annullate} saltate (già in corso)`);
  await page.getByRole('button', { name: 'Chiudi', exact: true }).click();
  await dialog(page).waitFor({ state: 'detached' });

  // ===== 5. Modifica pratica (stato e data di rientro) =====
  await cardAction(page, 'g4', 'Modifica la pratica');
  await dialog(page).getByText('Modifica Appuntamento').waitFor();
  await dialog(page).getByLabel('Categoria / Problematica').selectOption('works_pending');
  await dialog(page).getByLabel('Data prevista fine lavori').fill('2026-12-01');
  await dialog(page).getByLabel('Note').fill('Cantiere in corso: richiamare a fine lavori.');
  await shot(page, 'pratica-modifica');
  await page.getByRole('button', { name: 'Salva Modifiche' }).click();
  await dialog(page).waitFor({ state: 'detached' });
  all = await state(page);
  const g4 = all.find(a => a.id === 'g4');
  assert.equal(g4.status, 'issue');
  assert.equal(g4.issueType, 'works_pending');
  assert.equal(g4.followUpDate, '2026-12-01');
  assert.equal(g4.date, undefined);
  ok('pratica: modifica -> problematica "lavori da ultimare" con data di rientro');

  // ===== 6. Smistamento (menu Pianifica) =====
  await pianifica(page, /Smista pratiche per zona/);
  await dialog(page).getByText('Anteprima assegnazioni').waitFor();
  await dialog(page).getByLabel('Orizzonte (giorni)').fill('1');
  await shot(page, 'smistamento-parametri');
  net.directionsDelay = 2500;
  await page.getByRole('button', { name: 'Calcola proposta' }).click();
  await dialog(page).getByText('Smistamento in corso...').waitFor();
  await shot(page, 'smistamento-calcolo');
  assert.equal(await page.getByRole('button', { name: 'Annulla calcolo' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Esci' }).isDisabled(), false);
  ok('smistamento: calcolo con "Annulla calcolo" e X attiva');
  await dialog(page).getByRole('button', { name: /^Applica:/ }).waitFor({ timeout: 60000 });
  net.directionsDelay = 0;
  await dialog(page).getByText(/Senza tecnico competente \(\d+\)/).waitFor();
  await dialog(page).getByText(/Non pianificate nell'orizzonte/).waitFor();
  await shot(page, 'smistamento-proposta');
  const scrollable = dialog(page).locator('.modal-body');
  await scrollable.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot(page, 'smistamento-proposta-avvisi');
  ok('smistamento: proposta con non assegnabili e fuori orizzonte in avvisi distinti');
  const applyLabel = await dialog(page).getByRole('button', { name: /^Applica:/ }).innerText();
  await dialog(page).getByRole('button', { name: /^Applica:/ }).click();
  await dialog(page).waitFor({ state: 'detached' });
  all = await state(page);
  const proposedNow = all.filter(a => ['p1', 'p2'].includes(a.id) && a.status === 'proposed');
  assert.ok(proposedNow.length >= 1, 'pratiche in attesa diventate proposte');
  ok('smistamento: "Applica" porta le pratiche in Proposte', `${applyLabel.trim()} · ${proposedNow.map(a => `${a.title} ${a.date} ${a.startTime}`).join(' | ')}`);
  // ...e il bottone "Smista per zona" della sezione In attesa apre la stessa finestra
  await goSection(page, 'in-attesa');
  await page.getByTestId('section-in-attesa').getByRole('button', { name: 'Smista per zona' }).click();
  await dialog(page).getByText('Anteprima assegnazioni').waitFor();
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  ok('smistamento: si apre anche da "Smista per zona" in In attesa');

  // ===== 7. Import KMZ (menu Importa) =====
  await importKmz(page, { name: 'file-rovinato.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from('<kml><Folder>') });
  await dialog(page).getByText('File KML non valido.').waitFor();
  await shot(page, 'kmz-errore');
  await dialog(page).getByRole('button', { name: 'Chiudi', exact: true }).click();
  await dialog(page).waitFor({ state: 'detached' });
  ok('import KMZ: file non valido -> stato di errore con "Chiudi"');
  await importKmz(page, { name: 'mappa-sopralluoghi.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from(KML) });
  await dialog(page).getByText('Verrà importato').waitFor();
  await shot(page, 'kmz-livelli');
  await dialog(page).getByLabel('Destinazione del livello Annullate 2026').selectOption('skip');
  const importBtn = dialog(page).getByRole('button', { name: /^Importa \d+ schede/ });
  const importLabel = (await importBtn.innerText()).trim();
  assert.equal(importLabel, 'Importa 6 schede');
  await shot(page, 'kmz-modificato');
  const countBefore = (await state(page)).length;
  await importBtn.click();
  await dialog(page).getByText('Import completato').waitFor();
  await shot(page, 'kmz-completato');
  const countAfter = (await state(page)).length;
  assert.equal(countAfter - countBefore, 6);
  ok('import KMZ: 5 livelli, destinazione modificabile, 6 schede importate', `${countBefore} -> ${countAfter}`);
  await page.getByRole('button', { name: 'Chiudi', exact: true }).click();
  await dialog(page).waitFor({ state: 'detached' });

  // ===== 8. Tecnici (voce "Tecnici" della barra laterale) =====
  await openTechnicians(page);
  await dialog(page).getByText('Tecnici e zone di competenza').waitFor();
  await shot(page, 'tecnici-elenco');
  await dialog(page).getByRole('button', { name: /Tecnico Uno/ }).click();
  await dialog(page).getByText('Zone di competenza', { exact: true }).waitFor();
  await shot(page, 'tecnici-scheda');
  await dialog(page).getByLabel('Comune al centro della zona').fill('Pavia');
  await dialog(page).getByLabel('Raggio in km').fill('20');
  await dialog(page).getByRole('button', { name: 'Zona', exact: true }).click();
  await dialog(page).getByText('raggio 20 km').waitFor();
  await dialog(page).getByText('Tutto il giorno', { exact: true }).click();
  await dialog(page).getByLabel('Dal', { exact: true }).fill('2026-12-07');
  await dialog(page).getByLabel('Motivo dell\'indisponibilità').fill('Visita medica');
  await dialog(page).getByRole('button', { name: 'Aggiungi', exact: true }).click();
  await dialog(page).locator('.modal-body, .overflow-y-auto').last().evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot(page, 'tecnici-indisponibilita');
  await dialog(page).getByRole('button', { name: 'Salva scheda' }).click();
  // dopo il salvataggio si torna all'elenco: a 1440 accanto c'è "Seleziona un tecnico";
  // a 390 (sotto 768 px elenco e scheda una alla volta) quel segnaposto è nascosto e torna l'elenco
  if (viewport.width >= 768) await dialog(page).getByText('Seleziona un tecnico').waitFor();
  else await dialog(page).getByRole('button', { name: /Tecnica Due/ }).waitFor();
  const techs = await stored(page, 'optiroute_technicians_v1');
  const t1 = techs.find(t => t.id === 'tech-1');
  assert.ok(t1.areas.some(a => a.label === 'Pavia' && a.radiusKm === 20));
  assert.ok(t1.unavailability.some(u => u.reason === 'Visita medica' && u.from === '2026-12-07' && u.allDay === false));
  ok('tecnici: zona e indisponibilità aggiunte e salvate', `${t1.areas.length} zone, ${t1.unavailability.length} indisponibilità`);
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  // anche dal filtro tecnico ("Gestisci tecnici")
  await page.getByTestId('tech-filter').click();
  await page.getByRole('menuitem', { name: 'Gestisci tecnici' }).click();
  await dialog(page).getByText('Tecnici e zone di competenza').waitFor();
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'detached' });
  ok('tecnici: la finestra si apre anche da "Gestisci tecnici" del filtro tecnico');

  // ===== 9. Impostazioni del pilota (bottone della striscia del pilota) =====
  await openSettings(page);
  await dialog(page).getByText('Impostazioni del pilota').first().waitFor();
  const tabNames = await page.getByRole('dialog').getByRole('tab').allInnerTexts();
  assert.deepEqual(tabNames.map(s => s.trim()), ['Chiamate', 'Pianificazione', 'Bridge portali', 'Cloud']);
  await page.locator('input[type="number"]').first().fill('7');
  await dialog(page).getByLabel('Inizio fascia chiamate').fill('09:15');
  await shot(page, 'impostazioni-chiamate');
  await page.getByRole('tab', { name: 'Pianificazione' }).click();
  await page.getByText('Chiama senza approvazione').click();
  await dialog(page).getByText(/i clienti verranno chiamati senza che nessuno/).waitFor();
  await shot(page, 'impostazioni-pianificazione');
  await page.getByRole('tab', { name: 'Bridge portali' }).click();
  await page.getByPlaceholder('Incolla il token stampato dal bridge').fill('tok-prova-e2e');
  await page.getByRole('button', { name: 'Prova collegamento' }).click();
  await dialog(page).getByText(/Bridge non raggiungibile/).waitFor();
  await shot(page, 'impostazioni-bridge');
  await page.getByRole('tab', { name: 'Chiamate' }).click();
  assert.equal(await page.locator('input[type="number"]').first().inputValue(), '7');
  assert.equal(await dialog(page).getByLabel('Inizio fascia chiamate').inputValue(), '09:15');
  ok('impostazioni: 4 schede, valori conservati passando da una all\'altra');
  await page.getByRole('tab', { name: 'Cloud' }).click();
  assert.equal(await page.getByRole('tab', { name: 'Cloud' }).getAttribute('aria-selected'), 'true');
  await shot(page, 'impostazioni-cloud');
  await dialog(page).getByLabel('Chiave di accesso del cloud').fill(CLOUD_KEY);
  await page.getByRole('button', { name: 'Prova collegamento' }).click();
  await page.waitForSelector('[data-testid="cloud-checks"]');
  const st = await page.$$eval('[data-testid="cloud-checks"] li', lis => Object.fromEntries(lis.map(li => [li.dataset.check, li.dataset.state])));
  assert.equal(st.key, 'ok'); assert.equal(st.retell, 'ko'); assert.equal(st.webhook, 'info');
  assert.ok((await page.getByTestId('cloud-webhook').inputValue()).endsWith('/api/cloud?op=webhook&token=tok-esempio'));
  await dialog(page).locator('.modal-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot(page, 'impostazioni-cloud-controlli');
  ok('impostazioni/cloud: controlli misti (ok / errore / facoltativo) e webhook', JSON.stringify(st));
  await dialog(page).getByLabel('Chiave di accesso del cloud').fill('chiave-sbagliata');
  await page.getByRole('button', { name: 'Prova collegamento' }).click();
  await page.waitForSelector('[data-testid="cloud-checks"] li[data-check="key"][data-state="ko"]');
  await page.getByRole('button', { name: 'Attiva il cloud su questo browser' }).click();
  await page.waitForSelector('[data-testid="cloud-activation-error"]');
  assert.match(await page.getByTestId('cloud-activation-error').innerText(), /Chiave di accesso errata/);
  await dialog(page).locator('.modal-body').evaluate(el => { el.scrollTop = 0; });
  await shot(page, 'impostazioni-cloud-chiave-errata');
  ok('impostazioni/cloud: chiave errata -> controllo in errore e messaggio di attivazione');
  await dialog(page).getByLabel('Chiave di accesso del cloud').fill(CLOUD_KEY);
  await page.getByRole('button', { name: 'Salva' }).click();
  await dialog(page).waitFor({ state: 'detached' });
  const s = await stored(page, 'optiroute_settings_v1');
  assert.equal(s.autopilot.maxAttempts, 7);
  assert.equal(s.autopilot.callWindowStart, '09:15');
  assert.equal(s.autopilot.autoApprove, true);
  assert.equal(s.bridge.token, 'tok-prova-e2e');
  const cloud = await stored(page, 'optiroute_cloud_v1');
  assert.equal(cloud.key, CLOUD_KEY);
  await page.reload();
  await page.waitForSelector('[data-testid="autopilot-bar"]');
  // dopo il ricaricamento la si riapre dalla sezione Impostazioni
  await goSection(page, 'impostazioni');
  await shot(page, 'struttura-impostazioni');
  await page.getByRole('button', { name: 'Apri le impostazioni del pilota' }).click();
  await dialog(page).getByText('Impostazioni del pilota').first().waitFor();
  assert.equal(await page.locator('input[type="number"]').first().inputValue(), '7');
  ok('impostazioni: "Salva" persiste (anche dopo il ricaricamento); si apre anche dalla sezione Impostazioni');
  await page.getByRole('button', { name: 'Annulla' }).click();
  await dialog(page).waitFor({ state: 'detached' });
  await context.close();
  if (net.pageErrors) throw new Error(`${net.pageErrors} errori JavaScript nella pagina`);

  // ===== 10. Conferma di attivazione del pilota (prima volta) =====
  const intro = await newPage(browser, viewport, { autopilotIntroSeen: false });
  await intro.page.getByRole('button', { name: 'Attiva', exact: true }).click();
  await intro.page.getByText('Attivare il pilota automatico?').waitFor();
  await shot(intro.page, 'pilota-attivazione');
  await intro.page.getByRole('dialog').getByRole('button', { name: 'Annulla' }).click();
  await intro.page.getByText('Attivare il pilota automatico?').waitFor({ state: 'detached' });
  ok('pilota: finestra di prima attivazione apribile e richiudibile');
  await intro.context.close();
}

(async () => {
  const which = process.argv[2] || 'all';
  const browser = await chromium.launch();
  let failedFlows = 0;
  const sizes = [];
  if (which === 'all' || which === 'desktop') sizes.push({ width: 1440, height: 900 });
  if (which === 'all' || which === 'mobile') sizes.push({ width: 390, height: 844 });
  for (const vp of sizes) {
    try {
      await tour(browser, vp);
    } catch (err) {
      failedFlows += 1;
      results.push({ name: `[${vp.width}] giro interrotto`, ok: false, extra: String(err.message || err) });
      console.error(`FAIL [${vp.width}]`, err);
    }
  }
  await browser.close();
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed} controlli superati${failedFlows ? ` — ${failedFlows} giri interrotti` : ''} (${counter.passed} asserzioni)`);
  console.log(`RISULTATO passati=${passed} falliti=${failedFlows}`);
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'logs', 'finestre-results.json'), JSON.stringify(results, null, 2));
  process.exit(failedFlows ? 1 : 0);
})();
