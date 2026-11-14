import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { FetchResponseLike, GestionaleFetch } from '../server/gestionale';
import { FIREBASE_JWKS_URL } from '../server/gestionale';

// Gestionale finto per i test: chiavi RSA generate qui, biglietti di Firebase
// firmati con quelle, Google (chiavi pubbliche) e Firestore (personale)
// simulati in memoria. Nessuna rete.

export const PROJECT = 'progetto-di-prova';
export const ORIGIN = 'https://gestionale.example';
export const FIRESTORE = 'https://firestore.example';

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

export const makeKey = (kid = 'chiave-1'): TestKey => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, jwk };
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export const signToken = (
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' }
): string => {
  const input = `${b64(header)}.${b64(claims)}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), key.privateKey).toString('base64url');
  return `${input}.${signature}`;
};

export const claimsFor = (email: string, nowSec: number, over: Record<string, unknown> = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  auth_time: nowSec - 60,
  user_id: `uid-${email}`,
  sub: `uid-${email}`,
  iat: nowSec - 30,
  exp: nowSec + 3600,
  email,
  email_verified: true,
  ...over,
});

const response = (status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});

export interface FakeGoogle {
  fetch: GestionaleFetch;
  keys: TestKey[];
  staff: Map<string, { ruolo: string; nome: string }>;
  calls: { jwks: number; firestore: number; lastAuth: string; lastUrl: string };
  mode: { jwks: 'ok' | 'down'; firestore: 'ok' | 'down' | 'reject' | 'error500' };
}

// Firestore finto: come le regole del gestionale, si legge solo la PROPRIA
// scheda (email del biglietto = documento richiesto)
export const fakeGoogle = (keys: TestKey[]): FakeGoogle => {
  const g: FakeGoogle = {
    keys,
    staff: new Map(),
    calls: { jwks: 0, firestore: 0, lastAuth: '', lastUrl: '' },
    mode: { jwks: 'ok', firestore: 'ok' },
    fetch: async (url, init) => {
      if (url === FIREBASE_JWKS_URL) {
        g.calls.jwks += 1;
        if (g.mode.jwks === 'down') throw new Error('rete');
        return response(200, { keys: g.keys.map(k => k.jwk) }, { 'cache-control': 'public, max-age=3600, must-revalidate' });
      }
      const m = new RegExp(`^${FIRESTORE}/v1/projects/([^/]+)/databases/\\(default\\)/documents/personale/([^/?]+)$`).exec(url);
      if (m) {
        g.calls.firestore += 1;
        g.calls.lastUrl = url;
        const auth = init?.headers?.Authorization || '';
        g.calls.lastAuth = auth;
        if (g.mode.firestore === 'down') throw new Error('rete');
        if (g.mode.firestore === 'reject') return response(401, { error: { code: 401 } });
        if (g.mode.firestore === 'error500') return response(500, {});
        const email = decodeURIComponent(m[2]);
        const payload = JSON.parse(Buffer.from(auth.replace(/^Bearer /, '').split('.')[1] || '', 'base64url').toString() || '{}');
        if (String(payload.email || '').toLowerCase() !== email) return response(403, { error: { code: 403 } });
        const rec = g.staff.get(email);
        if (!rec) return response(404, { error: { code: 404 } });
        return response(200, { name: 'x', fields: { ruolo: { stringValue: rec.ruolo }, nome: { stringValue: rec.nome }, email: { stringValue: email } } });
      }
      throw new Error(`rete non ammessa nei test: ${url}`);
    },
  };
  return g;
};
