import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Un'unica chiave: CRON_SECRET. La invia lo scheduler di Vercel e la usa il
// browser (inserita una volta nelle impostazioni), sempre e solo
// nell'intestazione Authorization: Bearer.
//
// Dentro il gestionale nessuno digita la chiave: il server rilascia un
// "biglietto di sessione" valido 60 minuti, firmato con una chiave derivata
// da CRON_SECRET (formato: ors1.<scadenza in secondi>.<firma HMAC-SHA256>).
// Ovunque si accetta la chiave si accetta anche un biglietto valido e non
// scaduto. Cambiare CRON_SECRET invalida subito tutti i biglietti.
// La stessa verifica è ricopiata in api/retell-call.ts e api/call-status.ts
// (che non possono importare questo file): un test controlla che diano lo
// stesso risultato.

type Headers = Record<string, string | string[] | undefined>;

export const SESSION_PREFIX = 'ors1';
export const SESSION_TTL_MS = 60 * 60 * 1000;

// Confronto a tempo costante: si confrontano i digest (stessa lunghezza)
export const safeEqual = (a: string, b: string): boolean => {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
};

export const headerValue = (headers: Headers | undefined, name: string): string => {
  if (!headers) return '';
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] || '' : v || '';
};

export const bearerToken = (headers: Headers | undefined): string => {
  const m = /^Bearer\s+(.+)$/i.exec(headerValue(headers, 'authorization').trim());
  return m ? m[1].trim() : '';
};

// --- Biglietti di sessione ---

const sessionMac = (secret: string, exp: number): string => {
  const key = createHmac('sha256', secret).update('optiroute-sessione-v1').digest();
  return createHmac('sha256', key).update(`${SESSION_PREFIX}.${exp}`).digest('base64url');
};

export const mintSessionToken = (secret: string, nowMs: number): { token: string; expiresAt: string } => {
  if (!secret) throw new Error('CRON_SECRET mancante');
  const exp = Math.floor((nowMs + SESSION_TTL_MS) / 1000);
  return { token: `${SESSION_PREFIX}.${exp}.${sessionMac(secret, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
};

const SESSION_RE = /^ors1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export const isValidSessionToken = (token: unknown, secret: string, nowMs: number): boolean => {
  if (typeof token !== 'string' || !secret) return false;
  const m = SESSION_RE.exec(token);
  if (!m) return false;
  const exp = parseInt(m[1], 10);
  // scaduto, o con una scadenza più lontana di quanto il server rilasci
  if (exp * 1000 <= nowMs || exp * 1000 > nowMs + SESSION_TTL_MS + 60_000) return false;
  return safeEqual(m[2], sessionMac(secret, exp));
};

// La richiesta porta la chiave giusta (o un biglietto di sessione valido)?
export const isAuthorized = (headers: Headers | undefined, secret: string, nowMs: number = Date.now()): boolean => {
  const token = bearerToken(headers);
  if (!secret || !token) return false;
  return safeEqual(token, secret) || isValidSessionToken(token, secret, nowMs);
};

// Token del webhook di Retell (che non può inviare intestazioni nostre):
// derivato dalla chiave, così non serve un secondo segreto.
export const webhookToken = (secret: string): string =>
  createHmac('sha256', secret).update('optiroute-webhook').digest('hex').slice(0, 32);

export const isValidWebhookToken = (token: unknown, secret: string): boolean =>
  typeof token === 'string' && !!secret && !!token && safeEqual(token, webhookToken(secret));
