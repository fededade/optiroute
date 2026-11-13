// OptiRoute DENTRO la pagina del gestionale (iframe di un'altra origine).
// Una piccola pagina "gestionale finto" (su una sua porta, quindi un'altra
// origine) implementa i messaggi del contratto (hello, token,
// bridge.snapshot, changed, evento bridge.updated); il server cloud di
// sviluppo gira in modo --gestionale-test (biglietti di Firebase firmati da
// una chiave generata all'avvio, personale finto, nessuna rete).
// Avvio (server Vite e server cloud già accesi):
//   cd <repo> && PORT=8792 CRON_SECRET=chiave-e2e-gestionale-0123456789 FAKE_RETELL=1 \
//     node scripts/dev-cloud-server.mjs --gestionale-test --gestionale-origin http://127.0.0.1:5281
//   VITE_PORT=5271 GESTIONALE_CLOUD_PORT=8792 GESTIONALE_PARENT_PORT=5281 node gestionale.js
const { chromium } = require('playwright');
const { assert, report } = require('./lib');
const http = require('http');
const path = require('path');
const fs = require('fs');

const APP = `http://127.0.0.1:${process.env.VITE_PORT || 5271}`;
const CLOUD = `http://127.0.0.1:${process.env.GESTIONALE_CLOUD_PORT || 8792}`;
const PARENT_PORT = Number(process.env.GESTIONALE_PARENT_PORT || 5281);
const PARENT = `http://127.0.0.1:${PARENT_PORT}`;          // pagina del gestionale autorizzata
const FOREIGN = `http://127.0.0.1:${PARENT_PORT + 1}`;     // un'altra pagina, NON autorizzata
const KEY = 'chiave-e2e-gestionale-0123456789';
// Il caricamento iniziale dal test prende il "turno" degli automatismi (bridge):
// lo si fa con lo stesso id di dispositivo del browser di prova
const DEVICE = 'dev-e2e-gestionale';
const DEVICE_SEED = { enabled: false, key: '', deviceId: DEVICE };
const OUT = path.join(__dirname, 'shots-gestionale');
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log('[e2e]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Date: dopodomani, in Italia
const romeDay = offset => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() + offset * 86400000));
const D = romeDay(2);

const P = { milano: { lat: 45.4642, lng: 9.19 }, sesto: { lat: 45.5353, lng: 9.2337 }, cityLife: { lat: 45.4777, lng: 9.1546 } };
const TECH = { id: 'tech-1', name: 'Tecnico Uno', color: '#2563eb', active: true, provinces: ['MI'], areas: [],
  baseAddress: 'Piazza Duomo, Milano', baseCoords: P.milano, workStart: '08:30', workEnd: '18:00', unavailability: [] };
const CONFIG = { technicians: [TECH], autopilot: { enabled: false, autoDispatch: false }, fallback: { start: '08:30', end: '18:00', base: P.milano } };

// --- Pagina del gestionale finto (contratto §2, lato pagina che contiene) ---
const parentHtml = `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Gestionale di prova</title>
<style>body{margin:0;font-family:sans-serif}#bar{height:36px;line-height:36px;padding:0 12px;background:#123;color:#fff}iframe{border:0;width:1400px;height:900px;display:block}</style>
</head><body>
<div id="bar">Gestionale di prova · OptiRoute</div>
<iframe id="app" title="OptiRoute"></iframe>
<script>
  const q = new URLSearchParams(location.search);
  const APP = q.get('app');
  const CLOUD = q.get('cloud');
  const appOrigin = new URL(APP).origin;
  const user = { name: q.get('name') || 'Anna Admin', email: q.get('email') || 'anna@example.com', role: q.get('role') || 'Amministratore' };
  window.__received = [];
  window.__changed = 0;
  window.__bridge = { status: 'offline', message: 'Bridge non avviato' };
  window.__idToken = async (over) => {
    const body = Object.assign({ email: user.email, role: q.get('norecord') ? null : user.role, name: user.name }, over || {});
    const r = await fetch(CLOUD + '/__test/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()).idToken;
  };
  const frame = document.getElementById('app');
  window.addEventListener('message', async (ev) => {
    if (ev.source !== frame.contentWindow || ev.origin !== appOrigin) return;
    const m = ev.data;
    if (!m || m.channel !== 'optiroute-gestionale' || m.v !== 1 || typeof m.id !== 'string') return;
    window.__received.push(m.method);
    const reply = (body) => frame.contentWindow.postMessage(Object.assign({ channel: 'optiroute-gestionale', v: 1, id: m.id }, body), appOrigin);
    try {
      if (m.method === 'hello') return reply({ ok: true, result: { user, environment: 'collaudo' } });
      if (m.method === 'token') return reply({ ok: true, result: { idToken: await window.__idToken() } });
      if (m.method === 'bridge.snapshot') return reply({ ok: true, result: window.__bridge });
      if (m.method === 'changed') { window.__changed += 1; return reply({ ok: true, result: {} }); }
      return reply({ ok: false, error: { code: 'unknown_method', message: 'Metodo sconosciuto' } });
    } catch (e) {
      return reply({ ok: false, error: { code: 'error', message: String(e) } });
    }
  });
  window.__emit = (event) => frame.contentWindow.postMessage({ channel: 'optiroute-gestionale', v: 1, event, data: {} }, appOrigin);
  frame.src = APP + '/';
</script>
</body></html>`;

const startParentServer = port => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(parentHtml);
  });
  server.on('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

// --- Chiamate dirette al server cloud (dal test) ---
const api = async (method, url, { body, headers = {} } = {}) => {
  const res = await fetch(CLOUD + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
};
const auth = { Authorization: `Bearer ${KEY}` };
const serverList = async () => (await api('GET', '/api/cloud?op=pull&rev=-1&configRev=-1&device=e2e-osservatore', { headers: auth })).json.appointments || [];
const seedServer = (appointments, device = DEVICE) => api('POST', '/api/cloud?op=init', { body: { device, appointments, config: CONFIG, replace: true }, headers: auth });

async function waitFor(fn, what, timeout = 30000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); } catch { last = null; }
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timeout: ${what}`);
}

// --- Browser ---
const newPage = async (browser, { parent = PARENT, user = {}, localSeed = null, blockStorage = false, direct = false } = {}) => {
  const ctx = await browser.newContext({ timezoneId: 'Europe/Rome', locale: 'it-IT', viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const seen = { pingParents: [], sessions: 0, cloudOps: [] };
  // tutto ciò che non è nostro: niente rete
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith(APP) || u.startsWith(PARENT) || u.startsWith(FOREIGN) || u.startsWith(CLOUD)) return r.continue();
    return r.fulfill({ status: 404, body: '' });
  });
  // geocodifica simulata (pratiche dal bridge)
  await page.route('https://nominatim.openstreetmap.org/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith('/reverse')) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ address: { county: 'Milano', city: 'Milano', 'ISO3166-2-lvl6': 'IT-MI' } }) });
    }
    const qq = (u.searchParams.get('q') || '').toLowerCase();
    const where = qq.includes('sesto') ? P.sesto : P.cityLife;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ lat: String(where.lat), lon: String(where.lng), display_name: `${u.searchParams.get('q')}, Italia`, address: { city: 'Milano', county: 'Milano', 'ISO3166-2-lvl6': 'IT-MI' } }]) });
  });
  // le funzioni dell'app (stessa origine di Vite) -> server cloud di sviluppo
  await page.route(`${APP}/api/**`, r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"non disponibile nel test"}' }));
  await page.route(`${APP}/api/cloud*`, async r => {
    const u = new URL(r.request().url());
    const op = u.searchParams.get('op');
    seen.cloudOps.push(op);
    if (op === 'ping' && u.searchParams.get('parent')) seen.pingParents.push(u.searchParams.get('parent'));
    if (op === 'session') seen.sessions += 1;
    const response = await r.fetch({ url: CLOUD + u.pathname + u.search });
    return r.fulfill({ response });
  });
  if (blockStorage) {
    // memoria del browser BLOCCATA dentro l'iframe: già leggerla dà errore
    await page.addInitScript(appOrigin => {
      if (location.origin !== appOrigin) return;
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Accesso negato', 'SecurityError'); } });
    }, APP);
  }
  if (localSeed) {
    await page.addInitScript(([appOrigin, data]) => {
      if (location.origin !== appOrigin) return;
      try {
        if (sessionStorage.getItem('seeded')) return;
        localStorage.clear();
        for (const [k, v] of Object.entries(data)) localStorage.setItem(k, JSON.stringify(v));
        sessionStorage.setItem('seeded', '1');
      } catch { /* memoria non disponibile */ }
    }, [APP, localSeed]);
  }
  page.on('pageerror', e => log('PAGEERROR', e.message));
  const q = new URLSearchParams({ app: APP, cloud: CLOUD, ...user });
  await page.goto(direct ? APP : `${parent}/?${q.toString()}`);
  const frame = direct ? page.mainFrame() : await waitFor(() => page.frames().find(f => f.url().startsWith(APP)), 'iframe dell\'app');
  const app = direct ? page : page.frameLocator('#app');
  return { ctx, page, frame, app, seen };
};

const noticeKind = async app => {
  const n = app.locator('[data-testid="gestionale-notice"]');
  await n.waitFor({ timeout: 20000 });
  return n.getAttribute('data-kind');
};

const parentEval = (page, fn, arg) => page.mainFrame().evaluate(fn, arg);

(async () => {
  const parentServer = await startParentServer(PARENT_PORT);
  const foreignServer = await startParentServer(PARENT_PORT + 1);
  const browser = await chromium.launch();
  let failed = 0;
  const step = async (name, fn) => {
    log('---', name);
    try {
      await fn();
      log('ok', name);
    } catch (err) {
      failed += 1;
      log('FALLITO', name, err && err.stack ? err.stack : err);
    }
  };

  try {
    // Server: collegamento attivo, pagine autorizzate, niente "*"
    await step('server: ping e CORS', async () => {
      assert.equal((await api('POST', '/__test/reset')).status, 200);
      const ping = (await api('GET', `/api/cloud?op=ping&parent=${encodeURIComponent(PARENT)}`)).json;
      assert.deepEqual(ping.gestionale, { enabled: true, parentAllowed: true });
      const foreign = (await api('GET', `/api/cloud?op=ping&parent=${encodeURIComponent(FOREIGN)}`)).json;
      assert.deepEqual(foreign.gestionale, { enabled: true, parentAllowed: false });
      assert.ok(!JSON.stringify(ping).includes(String(PARENT_PORT)), 'ping non rivela le pagine autorizzate');
      const pre = await fetch(`${CLOUD}/api/cloud?op=sopralluoghi`, { method: 'OPTIONS', headers: { Origin: PARENT } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get('access-control-allow-origin'), PARENT);
      assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
      const preForeign = await fetch(`${CLOUD}/api/cloud?op=sopralluoghi`, { method: 'OPTIONS', headers: { Origin: FOREIGN } });
      assert.equal(preForeign.headers.get('access-control-allow-origin'), null);
    });

    // 1) Amministratore: app usabile, cloud acceso senza chiave, dati dal server
    await step('amministratore: cloud acceso da solo, valgono i dati del server', async () => {
      await api('POST', '/__test/reset');
      await seedServer([
        { id: 's1', title: 'Cliente dal Server', address: 'Via Server 1, Milano', coords: P.milano, status: 'proposed', date: D,
          startTime: '09:00', endTime: '09:20', technicianId: 'tech-1', province: 'MI', comune: 'Milano', periziaCode: 'ISP-S1', sequenceOrder: 1 },
        { id: 's2', title: 'Attesa dal Server', address: 'Via Server 2, Milano', coords: P.milano, status: 'pending',
          technicianId: 'tech-1', province: 'MI', comune: 'Milano', periziaCode: 'ISP-S2' },
      ]);
      const manual = { enabled: false, key: 'chiave-manuale-da-non-toccare', deviceId: 'dev-e2e-manuale' };
      const G = await newPage(browser, {
        localSeed: {
          optiroute_appointments_v1: [{ id: 'l1', title: 'Solo nel Browser', address: 'Via Locale 1, Milano', coords: P.milano, status: 'pending', technicianId: 'tech-1', province: 'MI' }],
          optiroute_technicians_v1: [TECH],
          optiroute_cloud_v1: manual,
          optiroute_settings_v1: { startTime: '08:30', endTimeLimit: '18:00', settingsOpen: true, autopilot: { enabled: false, autoDispatch: false } },
        },
      });
      await G.app.locator('[data-testid="autopilot-bar"]').waitFor({ timeout: 30000 });
      assert.equal(await G.app.locator('[data-testid="gestionale-notice"]').count(), 0, 'nessun avviso');
      await G.app.locator('[data-testid="cloud-chip"]').waitFor({ timeout: 20000 });
      assert.deepEqual(G.seen.pingParents.slice(0, 1), [PARENT], 'pagina verificata dal server');
      assert.ok(G.seen.sessions >= 1, 'biglietto di sessione richiesto');
      // i dati sono quelli del server
      await G.app.getByTestId('nav-pratiche').click();
      await G.app.getByText('Cliente dal Server').first().waitFor({ timeout: 20000 });
      assert.equal(await G.app.getByText('Solo nel Browser').count(), 0, 'i dati locali non sovrascrivono il server');
      const list = await serverList();
      assert.deepEqual(list.map(a => a.id).sort(), ['s1', 's2'], 'il server non riceve i dati locali');
      // impostazioni salvate a mano: né usate né modificate
      const stored = await G.frame.evaluate(() => JSON.parse(localStorage.getItem('optiroute_cloud_v1') || 'null'));
      assert.deepEqual(stored, manual);
      // chi è collegato, in basso nella navigazione
      assert.match(await G.app.getByTestId('gestionale-user').innerText(), /Anna Admin/);
      // impostazioni: niente chiave, bridge gestito dal gestionale
      await G.app.locator('[data-testid="autopilot-bar"] button[title^="Impostazioni del pilota"]').click();
      await G.app.getByRole('tab', { name: 'Cloud', exact: true }).click();
      assert.match(await G.app.getByTestId('cloud-gestionale-user').innerText(), /Accesso dal gestionale come Anna Admin \(Amministratore\)/);
      assert.equal(await G.app.getByLabel('Chiave di accesso del cloud').count(), 0, 'nessun campo per la chiave');
      assert.equal(await G.app.getByRole('button', { name: 'Attiva il cloud su questo browser' }).count(), 0);
      await G.app.getByRole('tab', { name: 'Bridge portali', exact: true }).click();
      await G.app.getByTestId('bridge-gestionale-note').waitFor();
      assert.equal(await G.app.locator('#bridge-url').isDisabled(), true, 'indirizzo del bridge non modificabile');
      assert.equal(await G.app.locator('#bridge-token').isDisabled(), true, 'token del bridge non modificabile');
      await G.page.screenshot({ path: path.join(OUT, '1-amministratore-impostazioni.png') });
      await G.app.getByRole('button', { name: 'Annulla' }).first().click();
      await G.ctx.close();
    });

    // 2) Bridge tramite il gestionale + evento bridge.updated
    await step('bridge: pratiche dalla pagina del gestionale, scaricate subito con bridge.updated', async () => {
      await api('POST', '/__test/reset');
      await seedServer([]);
      const G = await newPage(browser, { localSeed: { optiroute_technicians_v1: [TECH], optiroute_cloud_v1: DEVICE_SEED } });
      await G.app.locator('[data-testid="autopilot-bar"]').waitFor({ timeout: 30000 });
      // bridge spento: il chip dice di avviarlo dalla barra del gestionale
      const chip = G.app.getByTestId('bridge-chip');
      await waitFor(async () => /avvialo dalla barra del gestionale/.test(await chip.innerText()), 'chip bridge offline', 30000)
        .catch(async err => {
          log('chip:', await chip.textContent().catch(() => '?'), '| cloud:', await G.app.getByTestId('cloud-chip').textContent().catch(() => '?'),
            '| messaggi:', JSON.stringify(await parentEval(G.page, () => window.__received)));
          throw err;
        });
      const asked = await parentEval(G.page, () => window.__received.filter(m => m === 'bridge.snapshot').length);
      assert.ok(asked >= 1, 'snapshot chiesto alla pagina del gestionale');
      // il bridge si attiva e ha pratiche: il gestionale avvisa
      await parentEval(G.page, () => {
        window.__bridge = { status: 'ok', snapshot: { bridge: 'optiroute-bridge', version: 1, generatedAt: new Date().toISOString(),
          portals: [{ id: 'prelios', status: 'ok', lastSync: new Date().toISOString() }],
          pratiche: [{ portal: 'prelios', codice: 'ISP-B1', intestatario: 'Bianchi Bruno', via: 'Via Bridge', civico: '1', comune: 'Milano', provincia: 'MI', telefono: '+390233330001', note: '', progetto: 'FULL - Acquisto', tipologia: '', esito: '', aggiornatoIl: '' }] } };
        window.__emit('bridge.updated');
      });
      await waitFor(async () => (await serverList()).some(a => a.periziaCode === 'ISP-B1'), 'pratica del bridge arrivata sul server', 30000);
      assert.ok(true, 'pratica ISP-B1 importata');
      await waitFor(async () => /Bridge collegato/.test(await chip.innerText()), 'chip bridge collegato', 15000);
      // seconda pratica: arriva subito con l'evento (senza attendere i 5 minuti)
      const before = await parentEval(G.page, () => window.__received.filter(m => m === 'bridge.snapshot').length);
      await parentEval(G.page, () => {
        window.__bridge.snapshot.pratiche.push({ portal: 'prelios', codice: 'ISP-B2', intestatario: 'Verdi Vera', via: 'Via Sesto', civico: '2', comune: 'Sesto San Giovanni', provincia: 'MI', telefono: '+390233330002', note: '', progetto: '', tipologia: '', esito: '', aggiornatoIl: '' });
        window.__emit('bridge.updated');
      });
      await waitFor(async () => (await serverList()).some(a => a.periziaCode === 'ISP-B2'), 'seconda pratica dopo bridge.updated', 20000);
      const after = await parentEval(G.page, () => window.__received.filter(m => m === 'bridge.snapshot').length);
      assert.ok(after > before, 'bridge.updated ha fatto scaricare lo snapshot');
      await G.page.screenshot({ path: path.join(OUT, '2-bridge.png') });
      await G.ctx.close();
    });

    // 2b) Il turno del cloud ce l'ha UN ALTRO dispositivo: il bridge sta su
    //     questo PC, quindi le sue pratiche arrivano lo stesso
    await step('bridge con il turno su un altro dispositivo: le pratiche arrivano lo stesso', async () => {
      await api('POST', '/__test/reset');
      const OTHER = 'dev-e2e-altro-dispositivo';
      await seedServer([], OTHER); // il caricamento prende il turno per l'altro dispositivo
      const holdTurn = () => api('GET', `/api/cloud?op=pull&rev=-1&configRev=-1&device=${OTHER}`, { headers: auth });
      const first = await holdTurn();
      assert.equal(first.json.lease.holder, true, 'l\'altro dispositivo ha il turno');
      const keepAlive = setInterval(() => { void holdTurn(); }, 15000);
      try {
        const G = await newPage(browser, { localSeed: { optiroute_technicians_v1: [TECH], optiroute_cloud_v1: DEVICE_SEED } });
        await G.app.locator('[data-testid="autopilot-bar"]').waitFor({ timeout: 30000 });
        // il turno resta all'altro dispositivo: lo dice la riga del turno (solo smistamento)
        await G.app.getByTestId('cloud-chip').waitFor({ timeout: 20000 });
        const chip = G.app.getByTestId('bridge-chip');
        await waitFor(async () => /avvialo dalla barra del gestionale/.test(await chip.innerText()), 'chip bridge con lo stato normale', 30000)
          .catch(async err => { log('chip:', await chip.textContent().catch(() => '?')); throw err; });
        assert.doesNotMatch(await chip.innerText(), /gestito da un altro dispositivo/);
        await parentEval(G.page, () => {
          window.__bridge = { status: 'ok', snapshot: { bridge: 'optiroute-bridge', version: 1, generatedAt: new Date().toISOString(),
            portals: [{ id: 'prelios', status: 'ok', lastSync: new Date().toISOString() }],
            pratiche: [{ portal: 'prelios', codice: 'ISP-T1', intestatario: 'Neri Nino', via: 'Via Turno', civico: '3', comune: 'Milano', provincia: 'MI', telefono: '+390233330003', note: '', progetto: '', tipologia: '', esito: '', aggiornatoIl: '' }] } };
          window.__emit('bridge.updated');
        });
        await waitFor(async () => (await serverList()).some(a => a.periziaCode === 'ISP-T1'), 'pratica del bridge sul server senza turno', 30000);
        assert.ok(true, 'pratica ISP-T1 importata senza il turno');
        const still = await api('GET', `/api/cloud?op=pull&rev=-1&configRev=-1&device=${OTHER}`, { headers: auth });
        assert.equal(still.json.lease.holder, true, 'il turno è rimasto all\'altro dispositivo');
        const leaseLine = G.app.getByTestId('cloud-lease');
        if (await leaseLine.count()) assert.doesNotMatch(await leaseLine.innerText(), /bridge/);
        await G.page.screenshot({ path: path.join(OUT, '2b-bridge-senza-turno.png') });
        await G.ctx.close();
      } finally {
        clearInterval(keepAlive);
      }
    });

    // 3) Conferma -> "changed" -> il gestionale legge i sopralluoghi confermati
    await step('conferma: changed al gestionale e sopralluogo in ?op=sopralluoghi con CORS', async () => {
      await api('POST', '/__test/reset');
      await seedServer([
        { id: 'c1', title: 'Cliente da Confermare', address: 'Via Roma 6, 20121 Milano MI', shortAddress: 'Via Roma 6', coords: P.milano, status: 'proposed', date: D,
          startTime: '09:00', endTime: '09:20', technicianId: 'tech-1', province: 'MI', comune: 'Milano', periziaCode: 'ISP-C1', sequenceOrder: 1 },
        { id: 'c2', title: 'Cliente in Attesa', address: 'Via Attesa 2, Milano', coords: P.milano, status: 'pending', technicianId: 'tech-1', province: 'MI', periziaCode: 'ISP-C2', phone: '+390200000002' },
      ]);
      const G = await newPage(browser, { localSeed: { optiroute_technicians_v1: [TECH], optiroute_cloud_v1: DEVICE_SEED } });
      await G.app.locator('[data-testid="autopilot-bar"]').waitFor({ timeout: 30000 });
      await G.app.getByTestId('nav-proposte').click();
      await G.app.getByText('Cliente da Confermare').first().waitFor({ timeout: 20000 });
      const changedBefore = await parentEval(G.page, () => window.__changed);
      await G.app.getByRole('button', { name: 'Conferma giornata' }).first().click();
      await waitFor(async () => (await serverList()).find(a => a.id === 'c1')?.status === 'confirmed', 'conferma arrivata sul server', 20000);
      await waitFor(async () => (await parentEval(G.page, () => window.__changed)) > changedBefore, 'changed ricevuto dal gestionale', 20000);
      assert.ok(true, 'changed ricevuto');

      // il gestionale (sua origine, biglietto di un TECNICO del personale) legge l'elenco
      const fromParent = await parentEval(G.page, async cloud => {
        const token = await window.__idToken({ email: 'toni@example.com', role: 'Tecnico', name: 'Toni Tecnico' });
        const r = await fetch(`${cloud}/api/cloud?op=sopralluoghi`, { headers: { Authorization: `Bearer ${token}` } });
        return { status: r.status, body: await r.json() };
      }, CLOUD);
      assert.equal(fromParent.status, 200, 'letto dalla pagina del gestionale (CORS consentito)');
      assert.equal(fromParent.body.v, 1);
      assert.deepEqual(fromParent.body.confirmed.map(s => s.codice), ['ISP-C1']);
      assert.deepEqual(fromParent.body.notConfirmed, ['ISP-C2']);
      assert.deepEqual(fromParent.body.notConfirmedIds, ['c2']);
      const s = fromParent.body.confirmed[0];
      assert.equal(s.data, D);
      assert.equal(s.oraInizio, '09:00');
      assert.equal(s.tecnico, 'Tecnico Uno');
      assert.equal(s.conferma, 'operatore');
      assert.equal(s.indirizzo, 'Via Roma 6');

      // intestazioni CORS viste dal server
      const tok = await parentEval(G.page, () => window.__idToken({ email: 'toni@example.com', role: 'Tecnico', name: 'Toni Tecnico' }));
      const ok = await api('GET', '/api/cloud?op=sopralluoghi', { headers: { Origin: PARENT, Authorization: `Bearer ${tok}` } });
      assert.equal(ok.headers.get('access-control-allow-origin'), PARENT);
      assert.equal(ok.headers.get('vary'), 'Origin');
      const other = await api('GET', '/api/cloud?op=sopralluoghi', { headers: { Origin: FOREIGN, Authorization: `Bearer ${tok}` } });
      assert.equal(other.headers.get('access-control-allow-origin'), null, 'altra origine: nessuna intestazione CORS');
      const noToken = await api('GET', '/api/cloud?op=sopralluoghi', { headers: { Origin: PARENT } });
      assert.equal(noToken.status, 401, 'senza biglietto: 401');
      const notStaff = await parentEval(G.page, () => window.__idToken({ email: 'estraneo@example.com', role: null }));
      assert.equal((await api('GET', '/api/cloud?op=sopralluoghi', { headers: { Authorization: `Bearer ${notStaff}` } })).status, 403, 'non personale: 403');
      await G.page.screenshot({ path: path.join(OUT, '3-conferma.png') });
      await G.ctx.close();

      // dal browser, una pagina NON autorizzata non può leggere la risposta
      const F = await browser.newPage();
      await F.goto(`${FOREIGN}/?${new URLSearchParams({ app: 'http://127.0.0.1:1', cloud: CLOUD })}`).catch(() => {});
      const blocked = await F.evaluate(async ([cloud, t]) => {
        try { await fetch(`${cloud}/api/cloud?op=sopralluoghi`, { headers: { Authorization: `Bearer ${t}` } }); return 'letto'; } catch { return 'bloccato'; }
      }, [CLOUD, tok]);
      assert.equal(blocked, 'bloccato', 'pagina non autorizzata: il browser blocca la lettura');
      await F.close();
    });

    // 4) Tecnico: area riservata
    await step('tecnico: area riservata agli amministratori', async () => {
      const G = await newPage(browser, { user: { name: 'Toni Tecnico', email: 'toni@example.com', role: 'Tecnico' } });
      assert.equal(await noticeKind(G.app), 'forbidden');
      assert.match(await G.app.getByTestId('gestionale-notice').innerText(), /Area riservata agli amministratori/);
      assert.equal(await G.app.locator('[data-testid="autopilot-bar"]').count(), 0, 'l\'app non si apre');
      await G.page.screenshot({ path: path.join(OUT, '4-tecnico.png') });
      await G.ctx.close();
    });

    // 5) Pagina non autorizzata
    await step('pagina sconosciuta: OptiRoute non si apre', async () => {
      const G = await newPage(browser, { parent: FOREIGN });
      assert.equal(await noticeKind(G.app), 'not_allowed');
      const text = await G.app.getByTestId('gestionale-notice').innerText();
      assert.match(text, /OptiRoute non può essere aperta dentro questa pagina/);
      assert.equal(await G.app.getByTestId('gestionale-open-standalone').getAttribute('target'), '_blank');
      assert.equal(G.seen.sessions, 0, 'nessun accesso richiesto');
      const asked = await parentEval(G.page, () => window.__received.length);
      assert.equal(asked, 0, 'nessun messaggio alla pagina sconosciuta');
      await G.page.screenshot({ path: path.join(OUT, '5-pagina-sconosciuta.png') });
      await G.ctx.close();
    });

    // 6) Memoria del browser bloccata nell'iframe
    await step('memoria del browser bloccata: l\'app si apre lo stesso', async () => {
      await api('POST', '/__test/reset');
      await seedServer([{ id: 'm1', title: 'Pratica Memoria', address: 'Via Memoria 1, Milano', coords: P.milano, status: 'pending', technicianId: 'tech-1', province: 'MI', periziaCode: 'ISP-M1' }]);
      const G = await newPage(browser, { blockStorage: true });
      const blocked = await G.frame.evaluate(() => { try { void window.localStorage; return false; } catch { return true; } });
      assert.equal(blocked, true, 'localStorage lancia davvero nell\'iframe');
      await G.app.locator('[data-testid="autopilot-bar"]').waitFor({ timeout: 30000 });
      await G.app.getByTestId('nav-pratiche').click();
      await G.app.getByText('Pratica Memoria').first().waitFor({ timeout: 20000 });
      assert.ok(true, 'dati del server visibili');
      await G.page.screenshot({ path: path.join(OUT, '6-memoria-bloccata.png') });
      await G.ctx.close();
    });

    // 7) Gestionale non configurato sul server -> pagina sconosciuta (ping
    //    "enabled: false") è coperto dai test del server; qui l'app da sola:
    await step('app aperta da sola: come sempre', async () => {
      const G = await newPage(browser, { direct: true, localSeed: { optiroute_technicians_v1: [TECH] } });
      await G.page.locator('[data-testid="autopilot-bar"]').waitFor({ timeout: 30000 });
      assert.equal(await G.page.locator('[data-testid="gestionale-notice"]').count(), 0);
      assert.equal(await G.page.locator('[data-testid="gestionale-user"]').count(), 0);
      assert.equal(G.seen.pingParents.length, 0, 'nessuna verifica del gestionale');
      assert.equal(G.seen.sessions, 0);
      await G.page.locator('[data-testid="autopilot-bar"] button[title^="Impostazioni del pilota"]').click();
      await G.page.getByRole('tab', { name: 'Cloud', exact: true }).click();
      assert.equal(await G.page.getByLabel('Chiave di accesso del cloud').count(), 1, 'campo della chiave come prima');
      await G.page.getByRole('tab', { name: 'Bridge portali', exact: true }).click();
      assert.equal(await G.page.locator('#bridge-url').isDisabled(), false);
      assert.equal(await G.page.getByTestId('bridge-gestionale-note').count(), 0);
      await G.ctx.close();
    });
  } finally {
    await browser.close();
    parentServer.close();
    foreignServer.close();
  }
  report(0, failed);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error(err);
  report(0, 1);
  process.exit(1);
});
