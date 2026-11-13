// Server locale per le prove end-to-end del pilota in cloud.
//
// Monta i DUE BUNDLE COMMITTATI (api/cloud.js e api/cloud-tick.js, generati da
// scripts/build-api.mjs: dopo una modifica ai sorgenti rigenerali) su
//   /api/cloud       e   /api/cloud-tick
// adattando req/res allo stile Vercel (req.query, req.body JSON, req.headers;
// res.status().json(), res.setHeader, res.end). Solo node:http, nessuna
// dipendenza. Archivio in memoria (OPTIROUTE_STORE=memory): i dati si perdono
// alla chiusura. CORS aperto a qualunque origine (SOLO per questo strumento
// locale), così il browser in `npm run dev` può puntarci. Non c'è nessun
// invio al gestionale (tolto a novembre 2026).
//
// Uso:
//   CRON_SECRET=prova FAKE_RETELL=1 node scripts/dev-cloud-server.mjs
//   (oppure npm run dev:cloud)
//
// Variabili:
//   PORT=8787          porta (default 8787)
//   CRON_SECRET=...    chiave del cloud (default "dev-secret", stampata all'avvio)
//   FAKE_RETELL=1      Retell finto in-process (altrimenti si usano RETELL_API_KEY,
//                      RETELL_FROM_NUMBER, RETELL_API_BASE come su Vercel: ATTENZIONE,
//                      con le chiavi vere le telefonate partono davvero)
//   OPTIROUTE_TZ=...   fuso del motore (default Europe/Rome)
//
// Endpoint di test (solo qui, mai sui bundle):
//   POST /__test/outcome  { "phone": "+39333...", "outcome": {...}, "delayMs": 0 }
//                    oppure { "callId": "call_3", "outcome": {...} }
//       Esito della chiamata più recente verso quel numero (se non ce n'è
//       ancora una, vale per la prossima). `outcome` contiene i campi della
//       post-call analysis di Retell (custom_analysis_data), es.
//         { "esito_appuntamento": "confermato", "alternativa_scelta": "A" }
//         { "esito_appuntamento": "riprogrammare", "nuova_data_richiesta": "2026-11-20" }
//         { "esito_appuntamento": "altro_referente", "nuovo_referente_telefono": "+39..." }
//       più, facoltativi: "summary" (riassunto), "disconnection_reason"
//       (es. "dial_no_answer" senza esito = non risposto), "call_status"
//       (es. "error"). `delayMs`: l'esito diventa visibile dopo N ms (prima la
//       chiamata risulta "ongoing").
//   GET  /__test/calls    elenco delle chiamate create (id, numero, body ricevuto, esito)
//   POST /__test/now      { "now": "2026-11-11T10:00:00+01:00" } fissa l'orologio del
//                         motore; { "now": null } torna all'ora reale;
//                         { "advanceMs": 3600000 } lo sposta in avanti.
//   POST /__test/reset    svuota archivio e chiamate finte.
//
// Esempio:
//   curl -s localhost:8787/api/cloud?op=ping
//   curl -s -H 'Authorization: Bearer dev-secret' 'localhost:8787/api/cloud?op=status'
//   curl -s -X POST -H 'Authorization: Bearer dev-secret' localhost:8787/api/cloud-tick
//
// Prove con il gestionale (facoltative; la funzione resta quella del bundle,
// cambiano solo le dipendenze che le si passano: nessun interruttore di prova
// nel codice che va su Vercel):
//
//   --gestionale-test --gestionale-origin <origine della pagina del gestionale>
//       Gestionale FINTO in questo processo: all'avvio si genera una chiave RSA;
//       le chiavi pubbliche "di Google" e le schede del personale "di Firestore"
//       le fornisce un finto interno (nessuna rete). Progetto: progetto-di-prova.
//       In più:
//         POST /__test/token { "email", "role", "name", "verified"?, "project"?, "expiresInSeconds"? }
//           -> { "idToken": "<biglietto firmato>" }. "role": null = la persona non ha
//           una scheda nel personale. "verified": false = email non verificata.
//
//   --gestionale-emulatori <indirizzo dell'emulatore di Firestore, es. http://127.0.0.1:8080>
//   --gestionale-progetto <id del progetto negli emulatori>
//   --gestionale-origin <origine della pagina del gestionale>
//       Per una prova insieme agli emulatori di Firebase: accetta i biglietti
//       NON FIRMATI dell'emulatore di Authentication (se ne controllano solo
//       progetto, scadenza ed email verificata) e legge la scheda del personale
//       dall'emulatore di Firestore con lo stesso biglietto.
//
// In questi due modi le intestazioni CORS di /api/cloud le decide la funzione
// (solo per l'origine indicata), come su Vercel.
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);

if (process.env.VERCEL_ENV) {
  console.error('dev-cloud-server: VERCEL_ENV è impostata, l\'archivio in memoria non sarebbe usato. Toglila.');
  process.exit(1);
}
process.env.OPTIROUTE_STORE = 'memory';
if (!process.env.CRON_SECRET) process.env.CRON_SECRET = 'dev-secret';

// --- Opzioni da riga di comando (gestionale) ---
const argValue = name => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
};
const GEST_TEST = process.argv.includes('--gestionale-test');
const GEST_EMULATORS = argValue('--gestionale-emulatori');
const GEST_ORIGIN = argValue('--gestionale-origin');
const GEST_TEST_PROJECT = 'progetto-di-prova';
const GEST_PROJECT = GEST_TEST ? GEST_TEST_PROJECT : argValue('--gestionale-progetto');
const GEST_MODE = GEST_TEST ? 'test' : GEST_EMULATORS ? 'emulatori' : '';
if (GEST_TEST && GEST_EMULATORS) {
  console.error('dev-cloud-server: usa --gestionale-test OPPURE --gestionale-emulatori, non entrambi.');
  process.exit(1);
}
if (GEST_MODE && !GEST_ORIGIN) {
  console.error('dev-cloud-server: manca --gestionale-origin <origine della pagina del gestionale>.');
  process.exit(1);
}
if (GEST_MODE === 'emulatori' && !GEST_PROJECT) {
  console.error('dev-cloud-server: manca --gestionale-progetto <id del progetto negli emulatori>.');
  process.exit(1);
}
if (GEST_MODE) {
  process.env.GESTIONALE_ORIGINS = GEST_ORIGIN;
  process.env.GESTIONALE_FIREBASE_PROJECTS = GEST_PROJECT;
}

const FAKE_RETELL = process.env.FAKE_RETELL === '1';
if (FAKE_RETELL) {
  process.env.RETELL_API_BASE = `http://127.0.0.1:${PORT}/__retell`;
  process.env.RETELL_API_KEY = process.env.RETELL_API_KEY || 'key_finta';
  process.env.RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER || '+390000000000';
}

// --- Orologio del motore (letto dai bundle solo con archivio in memoria) ---
let fixedNow = null; // ms epoch, null = ora reale
globalThis.__optirouteNow = () => new Date(fixedNow ?? Date.now());

// --- Retell finto ---
const fake = { seq: 0, calls: [], pending: [] }; // pending: esiti in attesa della prossima chiamata a un numero

const digits = s => String(s || '').replace(/\D/g, '');
const samePhone = (a, b) => {
  const x = digits(a), y = digits(b);
  return !!x && !!y && (x === y || x.endsWith(y) || y.endsWith(x));
};

const setOutcome = (call, outcome, delayMs) => {
  call.outcome = outcome;
  call.readyAt = Date.now() + (Number(delayMs) || 0);
};

const retellView = call => {
  if (!call.outcome || Date.now() < call.readyAt) {
    return { call_id: call.callId, call_status: 'ongoing' };
  }
  const { summary, disconnection_reason, call_status, ...custom } = call.outcome;
  const hasCustom = Object.keys(custom).length > 0;
  return {
    call_id: call.callId,
    call_status: call_status || 'ended',
    disconnection_reason: disconnection_reason || 'user_hangup',
    call_analysis: {
      call_summary: summary || 'Esito simulato (dev-cloud-server)',
      ...(hasCustom ? { custom_analysis_data: custom } : {}),
    },
  };
};

const handleFakeRetell = (req, res, url, body) => {
  if (req.method === 'POST' && url.pathname === '/__retell/v2/create-phone-call') {
    fake.seq += 1;
    const call = { callId: `call_${fake.seq}`, toNumber: body?.to_number, body, createdAt: new Date().toISOString(), outcome: null, readyAt: 0 };
    fake.calls.push(call);
    const i = fake.pending.findIndex(p => samePhone(p.phone, call.toNumber));
    if (i >= 0) {
      const [p] = fake.pending.splice(i, 1);
      setOutcome(call, p.outcome, p.delayMs);
    }
    console.log(`retell finto: creata ${call.callId}`);
    return sendJson(res, 201, { call_id: call.callId, call_status: 'registered' });
  }
  const m = /^\/__retell\/v2\/get-call\/([\w-]+)$/.exec(url.pathname);
  if (req.method === 'GET' && m) {
    const call = fake.calls.find(c => c.callId === m[1]);
    return call ? sendJson(res, 200, retellView(call)) : sendJson(res, 404, { message: 'not found' });
  }
  return sendJson(res, 404, { message: 'not found' });
};

// --- Endpoint di test ---
const handleTest = async (req, res, url, body) => {
  if (req.method === 'POST' && url.pathname === '/__test/outcome') {
    const { phone, callId, outcome, delayMs } = body || {};
    if (!outcome || typeof outcome !== 'object') return sendJson(res, 400, { error: 'outcome mancante' });
    let call = callId ? fake.calls.find(c => c.callId === callId) : [...fake.calls].reverse().find(c => samePhone(c.toNumber, phone));
    if (!call && callId) return sendJson(res, 404, { error: 'chiamata sconosciuta' });
    if (!call) {
      if (!phone) return sendJson(res, 400, { error: 'phone o callId' });
      fake.pending.push({ phone, outcome, delayMs });
      return sendJson(res, 200, { ok: true, pendingForNextCall: true });
    }
    setOutcome(call, outcome, delayMs);
    return sendJson(res, 200, { ok: true, callId: call.callId });
  }
  if (req.method === 'GET' && url.pathname === '/__test/calls') {
    return sendJson(res, 200, fake.calls.map(c => ({
      callId: c.callId, toNumber: c.toNumber, createdAt: c.createdAt, body: c.body, outcome: c.outcome, view: retellView(c),
    })));
  }
  if (req.method === 'POST' && url.pathname === '/__test/now') {
    if (body && 'now' in body) {
      if (body.now === null) fixedNow = null;
      else {
        const t = new Date(body.now).getTime();
        if (!Number.isFinite(t)) return sendJson(res, 400, { error: 'data non valida' });
        fixedNow = t;
      }
    }
    if (body && Number.isFinite(Number(body.advanceMs))) fixedNow = (fixedNow ?? Date.now()) + Number(body.advanceMs);
    return sendJson(res, 200, { now: globalThis.__optirouteNow().toISOString(), fixed: fixedNow !== null });
  }
  if (req.method === 'POST' && url.pathname === '/__test/reset') {
    globalThis.__optirouteMemoryRedis?.clear();
    fake.calls = [];
    fake.pending = [];
    fake.seq = 0;
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
};

// --- Adattatore stile Vercel ---
const sendJson = (res, status, payload) => {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  res.end(JSON.stringify(payload));
};

const vercelRes = res => {
  const wrapper = {
    status(code) { res.statusCode = code; return wrapper; },
    json(payload) {
      if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return wrapper;
    },
    setHeader(name, value) { if (!res.headersSent) res.setHeader(name, value); return wrapper; },
    end(...args) { res.end(...args); return wrapper; },
  };
  return wrapper;
};

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const parseJsonBody = (raw, contentType) => {
  if (!raw) return undefined;
  if (!/json/i.test(contentType || '') && !/^\s*[{[]/.test(raw)) return raw;
  try { return JSON.parse(raw); } catch { return raw; }
};

const queryOf = url => {
  const q = {};
  for (const [k, v] of url.searchParams) {
    if (k in q) q[k] = [].concat(q[k], v);
    else q[k] = v;
  }
  return q;
};

// --- Gestionale finto (--gestionale-test) ---
// Chiave RSA generata all'avvio; "Google" (chiavi pubbliche) e "Firestore"
// (schede del personale) rispondono da qui, senza rete. Come le regole del
// gestionale, si legge solo la PROPRIA scheda.
const fakeGestionale = (() => {
  if (GEST_MODE !== 'test') return null;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `chiave-locale-${Date.now().toString(36)}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const staff = new Map(); // email minuscola -> { ruolo, nome }
  const FIRESTORE = 'http://firestore.finto.invalid';
  const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const reply = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  });
  const fetchFake = async (url, init) => {
    if (url.includes('/service_accounts/v1/jwk/')) {
      return reply(200, { keys: [jwk] }, { 'cache-control': 'public, max-age=3600' });
    }
    const m = /\/documents\/personale\/([^/?]+)$/.exec(url);
    if (url.startsWith(FIRESTORE) && m) {
      const email = decodeURIComponent(m[1]);
      const token = String(init?.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
      let payload = {};
      try { payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')); } catch { /* biglietto illeggibile */ }
      if (String(payload.email || '').toLowerCase() !== email) return reply(403, { error: { code: 403 } });
      const rec = staff.get(email);
      if (!rec) return reply(404, { error: { code: 404 } });
      return reply(200, { fields: { ruolo: { stringValue: rec.ruolo }, nome: { stringValue: rec.nome } } });
    }
    throw new Error('rete non ammessa nel gestionale finto');
  };
  const issue = ({ email, role, name, verified, project, expiresInSeconds }) => {
    const lower = String(email || '').trim().toLowerCase();
    if (!lower) throw new Error('email mancante');
    if (role === null) staff.delete(lower);
    else staff.set(lower, { ruolo: String(role || 'Amministratore'), nome: String(name || lower) });
    const now = Math.floor(Date.now() / 1000);
    const aud = String(project || GEST_TEST_PROJECT);
    const claims = {
      iss: `https://securetoken.google.com/${aud}`, aud, auth_time: now, user_id: `uid-${lower}`, sub: `uid-${lower}`,
      iat: now, exp: now + (Number.isFinite(Number(expiresInSeconds)) ? Number(expiresInSeconds) : 3600),
      email: String(email).trim(), email_verified: verified !== false,
    };
    const input = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${cryptoSign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  };
  return { deps: { fetch: fetchFake, firestoreBaseUrl: FIRESTORE }, issue };
})();

const bundleUrl = file => pathToFileURL(path.join(ROOT, file)).href;
const cloudModule = await import(bundleUrl('api/cloud.js'));
const { default: cloudTick } = await import(bundleUrl('api/cloud-tick.js'));

// Biglietti NON firmati dell'emulatore di Authentication: si leggono e si
// controllano progetto, scadenza ed email verificata (la scheda del
// personale la decide comunque l'emulatore di Firestore con le sue regole)
const emulatorDeps = () => ({
  firestoreBaseUrl: GEST_EMULATORS,
  verifyToken: async (token, projects, nowMs) =>
    cloudModule.checkFirebaseClaims(cloudModule.decodeJwt(token).payload, projects, Math.floor(nowMs / 1000), { strict: false }),
});

const cloud = GEST_MODE === 'test'
  ? cloudModule.createCloudHandler({ gestionale: fakeGestionale.deps })
  : GEST_MODE === 'emulatori'
    ? cloudModule.createCloudHandler({ gestionale: emulatorDeps() })
    : cloudModule.default;

const server = http.createServer(async (req, res) => {
  const url0 = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  // Con il gestionale, CORS e preflight di /api/* li gestisce la funzione
  const functionCors = !!GEST_MODE && url0.pathname.startsWith('/api/');
  if (!functionCors) {
    // CORS aperto: SOLO per questo strumento locale
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
  }
  try {
    const url = url0;
    const raw = await readBody(req);
    const body = parseJsonBody(raw, req.headers['content-type']);

    if (req.method === 'POST' && url.pathname === '/__test/token') {
      if (!fakeGestionale) return sendJson(res, 404, { error: 'avvia con --gestionale-test' });
      try {
        return sendJson(res, 200, { idToken: fakeGestionale.issue(body || {}) });
      } catch (err) {
        return sendJson(res, 400, { error: err?.message || 'richiesta non valida' });
      }
    }

    if (url.pathname.startsWith('/__retell/')) {
      if (!FAKE_RETELL) return sendJson(res, 404, { message: 'FAKE_RETELL non attivo' });
      return handleFakeRetell(req, res, url, body);
    }
    if (url.pathname.startsWith('/__test/')) return await handleTest(req, res, url, body);

    const handler = url.pathname === '/api/cloud' ? cloud : url.pathname === '/api/cloud-tick' ? cloudTick : null;
    if (!handler) return sendJson(res, 404, { error: 'not found' });
    const vreq = { method: req.method, url: req.url, headers: req.headers, query: queryOf(url), body };
    await handler(vreq, vercelRes(res));
    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error('dev-cloud-server: errore', err?.name || err);
    if (!res.writableEnded) sendJson(res, 500, { error: 'server' });
  }
});

server.listen(PORT, () => {
  console.log(`dev-cloud-server su http://localhost:${PORT}`);
  console.log(`  chiave (CRON_SECRET): ${process.env.CRON_SECRET}`);
  console.log(`  Retell: ${FAKE_RETELL ? 'FINTO (in-process)' : (process.env.RETELL_API_KEY ? 'VERO: le telefonate partono davvero!' : 'non configurato')}`);
  console.log(`  fuso del motore: ${process.env.TZ}`);
  if (GEST_MODE === 'test') console.log(`  gestionale: FINTO (progetto ${GEST_TEST_PROJECT}, pagina ${GEST_ORIGIN}); biglietti da POST /__test/token`);
  if (GEST_MODE === 'emulatori') console.log(`  gestionale: EMULATORI (progetto ${GEST_PROJECT}, Firestore ${GEST_EMULATORS}, pagina ${GEST_ORIGIN})`);
});
