import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryRedis } from '../server/store';
import type { CallLookup, RetellClient } from '../server/retell';
import type { RetellCallBody } from '../api/retell-call';
import type { RawCallOutcome } from '../api/call-status';

// Finti servizi esterni per i test del motore lato server: Upstash REST,
// Retell HTTP e un client Retell in-process. Nessuna rete reale.

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const listen = async (server: http.Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

// --- Upstash REST finto ---
// Implementa il protocollo REST (POST / con il comando come array JSON,
// POST /pipeline, Bearer token, { result } | { error }); i comandi (compresi
// gli script EVAL, riconosciuti dal testo) li esegue l'emulatore MemoryRedis.

export interface FakeUpstash {
  url: string;
  backend: MemoryRedis;
  commands: string[][];
  delayMs: number;
  close: () => Promise<void>;
}

export const startFakeUpstash = async (token: string, backend = new MemoryRedis()): Promise<FakeUpstash> => {
  const state = { commands: [] as string[][], delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply(401, { error: 'Unauthorized' });
    }
    if (req.method !== 'POST') return reply(405, { error: 'method' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: 'ERR failed to parse command' });
    }
    const run = (cmd: unknown) => {
      if (!Array.isArray(cmd) || cmd.some(a => typeof a !== 'string' && typeof a !== 'number')) {
        return { error: 'ERR failed to parse command' };
      }
      state.commands.push(cmd.map(String));
      try {
        return { result: backend.exec(cmd as string[]) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    };
    if (req.url === '/pipeline') {
      if (!Array.isArray(parsed)) return reply(400, { error: 'ERR pipeline' });
      return reply(200, parsed.map(run));
    }
    if (req.url !== '/' && req.url !== '') return reply(404, { error: 'not found' });
    const out = run(parsed);
    return reply('error' in out ? 400 : 200, out);
  });
  const { url, close } = await listen(server);
  return {
    url,
    backend,
    get commands() { return state.commands; },
    get delayMs() { return state.delayMs; },
    set delayMs(v: number) { state.delayMs = v; },
    close,
  } as FakeUpstash;
};

// --- Retell HTTP finto (create-phone-call / get-call) ---

export interface FakeRetellHttp {
  url: string;
  created: { callId: string; payload: any; auth: string }[];
  calls: Map<string, any>; // callId -> JSON di get-call
  close: () => Promise<void>;
}

export const startFakeRetellHttp = async (): Promise<FakeRetellHttp> => {
  const created: FakeRetellHttp['created'] = [];
  const calls = new Map<string, any>();
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'POST' && req.url === '/v2/create-phone-call') {
      const callId = `call_${created.length + 1}`;
      created.push({ callId, payload: JSON.parse(body), auth: String(req.headers.authorization || '') });
      calls.set(callId, { call_id: callId, call_status: 'registered' });
      return reply(201, { call_id: callId, call_status: 'registered' });
    }
    const m = /^\/v2\/get-call\/([\w-]+)$/.exec(req.url || '');
    if (req.method === 'GET' && m) {
      const call = calls.get(m[1]);
      return call ? reply(200, call) : reply(404, { message: 'not found' });
    }
    return reply(404, { message: 'not found' });
  });
  const { url, close } = await listen(server);
  return { url, created, calls, close };
};

// JSON di get-call di una chiamata conclusa con analisi
export const endedCall = (callId: string, custom: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  call_id: callId,
  call_status: 'ended',
  disconnection_reason: 'user_hangup',
  call_analysis: { call_summary: 'Riassunto di prova', custom_analysis_data: custom },
  ...extra,
});

// --- Client Retell in-process (motore) ---

export class FakeRetell implements RetellClient {
  isConfigured = true;
  created: { callId: string; body: RetellCallBody }[] = [];
  lookups = new Map<string, CallLookup>();
  createFailure: string | null = null;
  getCalls: string[] = [];
  private seq = 0;

  configured() {
    return this.isConfigured;
  }

  async createCall(body: RetellCallBody) {
    if (this.createFailure) return { ok: false as const, error: this.createFailure };
    this.seq += 1;
    const callId = `call_${this.seq}`;
    this.created.push({ callId, body });
    return { ok: true as const, callId };
  }

  async getCall(callId: string): Promise<CallLookup> {
    this.getCalls.push(callId);
    return this.lookups.get(callId) || { kind: 'pending' };
  }

  // Esito della chiamata più recente verso quel telefono
  finish(phone: string, outcome: RawCallOutcome) {
    const call = [...this.created].reverse().find(c => c.body.phone === phone);
    if (!call) throw new Error(`nessuna chiamata verso ${phone}`);
    this.lookups.set(call.callId, { kind: 'done', outcome });
    return call.callId;
  }

  phonesCalled(): string[] {
    return this.created.map(c => String(c.body.phone));
  }
}

// --- req/res finti in stile Vercel ---

export interface FakeResponse {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  ended: boolean;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(name: string, value: string): FakeResponse;
  end(): FakeResponse;
}

export const fakeRes = (): FakeResponse => ({
  statusCode: 200,
  body: undefined,
  headers: {},
  ended: false,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = JSON.parse(JSON.stringify(body)); this.ended = true; return this; },
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
  end() { this.ended = true; return this; },
});

export interface FakeRequestInit {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export const invoke = async (
  handler: (req: any, res: any) => unknown,
  init: FakeRequestInit
): Promise<FakeResponse> => {
  const res = fakeRes();
  await handler(
    { method: init.method || 'GET', query: init.query || {}, headers: init.headers || {}, body: init.body },
    res
  );
  return res;
};
