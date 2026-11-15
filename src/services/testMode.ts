import { useEffect, useState } from 'react';
import { cloudPing, type CloudPing, type FetchLike } from './cloudSync';

// Versione di prova (anteprima di Vercel): il browser lo scopre UNA volta
// all'avvio dal ping anonimo del cloud (GET /api/cloud?op=ping), che dice
// solo se la modalità prova è accesa e se ci sono numeri ammessi (mai quali).
// Errore, tempo scaduto o risposta senza il campo: NON è una versione di prova.

export interface TestModeState {
  testMode: boolean;
  testNumbersConfigured: boolean;
}

export const NOT_TEST_MODE: TestModeState = { testMode: false, testNumbersConfigured: false };

export const TEST_MODE_PING_TIMEOUT_MS = 4000;

// Lettura della risposta del ping: vale solo un `true` esplicito
export const testModeFromPing = (ping: Partial<CloudPing> | null | undefined): TestModeState =>
  ping && ping.testMode === true
    ? { testMode: true, testNumbersConfigured: ping.testNumbersConfigured === true }
    : NOT_TEST_MODE;

export const fetchTestMode = async (opts: { fetch?: FetchLike; baseUrl?: string; timeoutMs?: number } = {}): Promise<TestModeState> => {
  try {
    const r = await cloudPing({ fetch: opts.fetch, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs ?? TEST_MODE_PING_TIMEOUT_MS });
    return r.ok ? testModeFromPing(r.data) : NOT_TEST_MODE;
  } catch {
    return NOT_TEST_MODE;
  }
};

// Una sola lettura per pagina, condivisa da tutti i componenti
let pending: Promise<TestModeState> | null = null;
let known: TestModeState | null = null;

export const loadTestMode = (): Promise<TestModeState> => {
  if (!pending) {
    pending = fetchTestMode().then(s => {
      known = s;
      return s;
    });
  }
  return pending;
};

// Solo per i test
export const resetTestModeCache = (): void => {
  pending = null;
  known = null;
};

// Stato della versione di prova: "non prova" finché il ping non risponde
export const useTestMode = (): TestModeState => {
  const [state, setState] = useState<TestModeState>(() => known || NOT_TEST_MODE);
  useEffect(() => {
    let alive = true;
    void loadTestMode().then(s => { if (alive) setState(s); });
    return () => { alive = false; };
  }, []);
  return state;
};

// Titolo della scheda del browser con il prefisso della versione di prova
export const TEST_TITLE_PREFIX = 'PROVA · ';
export const testModeTitle = (title: string, testMode: boolean): string => {
  const bare = title.startsWith(TEST_TITLE_PREFIX) ? title.slice(TEST_TITLE_PREFIX.length) : title;
  return testMode ? `${TEST_TITLE_PREFIX}${bare}` : bare;
};
