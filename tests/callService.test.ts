import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCallOutcome } from '../src/services/callService';

const mockFetch = (body: unknown, ok = true, status = 200) => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCallOutcome', () => {
  it('riporta l\'alternativa scelta; la data richiesta di un esito confermato non diventa rientro', async () => {
    mockFetch({
      pending: false,
      outcome: {
        result: 'confermato',
        chosenAlternative: 'B',
        requestedDate: '2026-11-13',
        requestedTime: '09:00',
      },
    });
    const poll = await fetchCallOutcome('call_123');
    expect(poll.pending).toBe(false);
    expect(poll.outcome?.result).toBe('confermato');
    expect(poll.outcome?.chosenAlternative).toBe('B');
    expect(poll.outcome?.requestedDate).toBe('2026-11-13');
    expect(poll.outcome?.requestedTime).toBe('09:00');
    expect(poll.outcome?.followUpDate).toBeUndefined();
  });

  it('ignora valori di alternativa non validi', async () => {
    for (const chosenAlternative of ['D', 'nessuna', 'a', '', null, 1]) {
      mockFetch({ pending: false, outcome: { result: 'riprogrammare', chosenAlternative } });
      const poll = await fetchCallOutcome('call_123');
      expect(poll.outcome?.chosenAlternative).toBeUndefined();
    }
  });

  it('senza alternativa nell\'esito il campo resta assente', async () => {
    mockFetch({ pending: false, outcome: { result: 'rifiutato' } });
    const poll = await fetchCallOutcome('call_123');
    expect(poll.outcome?.result).toBe('rifiutato');
    expect(poll.outcome?.chosenAlternative).toBeUndefined();
  });

  it('chiamata non conclusa -> pending', async () => {
    mockFetch({ pending: true, callStatus: 'ongoing' });
    expect(await fetchCallOutcome('call_123')).toEqual({ pending: true });
  });
});
