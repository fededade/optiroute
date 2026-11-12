// Due schede aperte: la modifica fatta in una compare nell'altra senza ricaricare.
// Interfaccia INTEGRATA: "Conferma giornata" sta sui giri della sezione Proposte;
// i vecchi filtri "Proposte (N)" / "Confermate (N)" sono diventati i contatori
// della barra laterale (count-proposte, count-agenda).
// Avvio: VITE_PORT=5271 node tabs.js   (server Vite già acceso)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { assert, counter, report } = require('./lib');
const ORIGIN = `http://127.0.0.1:${process.env.VITE_PORT || 5271}`;
const OUT = path.join(__dirname, 'shots-tabs');
fs.mkdirSync(OUT, { recursive: true });
// Orologio fissato a mer 11/11/2026 10:00 (Roma): il contatore di Agenda conta le
// confermate da oggi in poi, così le due giornate (12 e 13/11) restano sempre "future".
const ROME_10 = Date.UTC(2026, 10, 11, 9, 0, 0);
const P = { milano: { lat: 45.4642, lng: 9.19 }, pv: { lat: 45.4746, lng: 9.205 }, sesto: { lat: 45.5353, lng: 9.2337 } };
const TECH = { id: 'tech-1', name: 'Tecnico Uno', color: '#2563eb', active: true, provinces: ['MI'], areas: [],
  baseAddress: 'Piazza Duomo, Milano', baseCoords: P.milano, workStart: '08:30', workEnd: '18:00', unavailability: [] };
const stop = (id, title, date, start, end, coords) => ({ id, title, address: `Via Prova ${id}, Milano`, coords, status: 'proposed',
  date, startTime: start, endTime: end, technicianId: 'tech-1', province: 'MI', comune: 'Milano', sequenceOrder: 1 });
const seed = {
  optiroute_appointments_v1: [
    stop('a1', 'Cliente Uno', '2026-11-12', '09:00', '09:20', P.pv),
    stop('b1', 'Cliente Due', '2026-11-13', '09:00', '09:20', P.sesto),
  ],
  optiroute_technicians_v1: [TECH],
  optiroute_settings_v1: { startTime: '08:30', endTimeLimit: '18:00', settingsOpen: false },
  optiroute_base_v1: { coords: P.milano, address: 'Piazza Duomo' },
};
// ogni attesa di un contatore è un controllo (come prima l'attesa del filtro "Confermate (N)")
const count = async (page, id, n, timeout = 15000) => {
  await page.waitForFunction(
    ([id, n]) => document.querySelector(`[data-testid="count-${id}"]`)?.textContent.trim() === String(n),
    [id, n], { timeout });
  counter.passed += 1;
};
const goSection = async (page, id) => {
  await page.getByTestId(`nav-${id}`).click();
  await page.waitForSelector(`[data-testid="section-${id}"]`);
};
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ timezoneId: 'Europe/Rome', locale: 'it-IT', viewport: { width: 1400, height: 950 } });
  await ctx.route('**/*', r => (r.request().url().startsWith(ORIGIN) ? r.continue() : r.fulfill({ status: 404, body: '' })));
  await ctx.route('**/api/**', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await ctx.addInitScript(data => {
    if (localStorage.getItem('optiroute_appointments_v1') !== null) return; // solo la prima scheda inizializza
    for (const [k, v] of Object.entries(data)) localStorage.setItem(k, JSON.stringify(v));
  }, seed);
  const A = await ctx.newPage();
  await A.clock.install({ time: ROME_10 });
  A.on('pageerror', e => console.log('[A] PAGEERROR', e.message));
  await A.goto(ORIGIN);
  await goSection(A, 'proposte');
  await A.getByText('Cliente Uno').first().waitFor();
  const B = await ctx.newPage();
  await B.clock.install({ time: ROME_10 });
  B.on('pageerror', e => console.log('[B] PAGEERROR', e.message));
  await B.goto(ORIGIN);
  await goSection(B, 'proposte');
  await B.getByText('Cliente Uno').first().waitFor();
  await count(B, 'proposte', 2);

  // A (scheda principale) conferma il giro del 12/11 → B lo vede senza ricaricare
  await A.getByRole('button', { name: /Conferma giornata/ }).first().click();
  await count(A, 'agenda', 1, 40000);
  await count(B, 'agenda', 1);
  await count(B, 'proposte', 1);
  console.log('A→B: OK');

  // B (scheda secondaria) conferma il giro del 13/11 → A lo vede
  await B.getByRole('button', { name: /Conferma giornata/ }).first().click();
  await count(B, 'agenda', 2, 40000);
  await count(A, 'agenda', 2);
  console.log('B→A: OK');

  // Stato salvato coerente, e nessuna delle due schede ha "perso" la modifica dell'altra
  await A.waitForTimeout(1500);
  const read = p => p.evaluate(() => JSON.parse(localStorage.getItem('optiroute_appointments_v1')).map(a => `${a.id}:${a.status}`).sort().join(','));
  const [sa, sb] = [await read(A), await read(B)];
  assert.equal(sa, 'a1:confirmed,b1:confirmed');
  assert.equal(sb, sa);
  await A.reload();
  await count(A, 'agenda', 2);
  console.log('ricarica: OK —', sa);
  await goSection(A, 'agenda');
  await A.screenshot({ path: path.join(OUT, 'tabs-A.png') });
  await browser.close();
  report();
})().catch(e => { console.error('FALLITO:', e.stack || e.message); counter.failed += 1; report(); process.exit(1); });
