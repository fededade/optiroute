// Rete di sicurezza per TUTTI i test: nessuna richiesta può uscire verso
// servizi veri (gestionale/Firestore, Retell, Upstash, geocoding...). Sono
// ammessi solo i server finti in ascolto su questa macchina. I test che
// simulano fetch (vi.stubGlobal, vi.fn) sostituiscono comunque questa funzione.
const realFetch = globalThis.fetch;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const hostOf = (input: unknown): string => {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string })?.url || '';
    return new URL(url, 'http://127.0.0.1').hostname;
  } catch {
    return '(non valido)';
  }
};

globalThis.fetch = ((input: unknown, init?: unknown) => {
  const host = hostOf(input);
  if (!LOCAL_HOSTS.has(host)) {
    return Promise.reject(new Error(`Test: richiesta di rete verso "${host}" bloccata (nei test solo server locali)`));
  }
  return (realFetch as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
}) as typeof fetch;
