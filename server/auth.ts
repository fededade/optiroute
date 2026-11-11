import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Un'unica chiave: CRON_SECRET. La invia lo scheduler di Vercel e la usa il
// browser (inserita una volta nelle impostazioni), sempre e solo
// nell'intestazione Authorization: Bearer.

type Headers = Record<string, string | string[] | undefined>;

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

// La richiesta porta la chiave giusta?
export const isAuthorized = (headers: Headers | undefined, secret: string): boolean => {
  const token = bearerToken(headers);
  return !!secret && !!token && safeEqual(token, secret);
};

// Token del webhook di Retell (che non può inviare intestazioni nostre):
// derivato dalla chiave, così non serve un secondo segreto.
export const webhookToken = (secret: string): string =>
  createHmac('sha256', secret).update('optiroute-webhook').digest('hex').slice(0, 32);

export const isValidWebhookToken = (token: unknown, secret: string): boolean =>
  typeof token === 'string' && !!secret && !!token && safeEqual(token, webhookToken(secret));
