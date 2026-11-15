import { describe, expect, it } from 'vitest';
import { interpretRetellCall, normalizeChosenAlternative } from '../api/call-status';

describe('normalizeChosenAlternative', () => {
  it.each([
    ['A', 'A'],
    ['b', 'B'],
    [' C ', 'C'],
    ['alternativa B', 'B'],
    ['Alternativa: c', 'C'],
    ['opzione c', 'C'],
    ['Slot A', 'A'],
    ["l'alternativa A", 'A'],
    ['A.', 'A'],
  ])('%j -> %s', (raw, expected) => {
    expect(normalizeChosenAlternative(raw)).toBe(expected);
  });

  it.each([
    'nessuna',
    'Nessuna',
    'no',
    'NO',
    '-',
    '',
    '   ',
    'n/a',
    'nessuna alternativa',
    'alternativa', // nessuna lettera
    'A o B',       // più lettere: ambiguo
    'va bene la b o la c',
    'a domani',
    'casa',
    'banca',
  ])('%j -> assente', raw => {
    expect(normalizeChosenAlternative(raw)).toBeUndefined();
  });

  it('valori non stringa -> assente', () => {
    expect(normalizeChosenAlternative(undefined)).toBeUndefined();
    expect(normalizeChosenAlternative(null)).toBeUndefined();
    expect(normalizeChosenAlternative(1)).toBeUndefined();
  });
});

describe('riassunto della chiamata', () => {
  const ended = (analysis: Record<string, unknown>) => ({ call_status: 'ended', call_analysis: analysis });

  it('preso dal campo italiano quando c\'è', () => {
    const v = interpretRetellCall(ended({
      call_summary: 'The agent called the customer.',
      custom_analysis_data: { esito_appuntamento: 'confermato', riassunto: 'Proposto venerdì alle 10, il cliente ha confermato.' },
    }));
    expect(v.outcome?.summary).toBe('Proposto venerdì alle 10, il cliente ha confermato.');
  });

  it('accetta anche gli altri nomi del campo', () => {
    const v = interpretRetellCall(ended({
      call_summary: 'The agent called the customer.',
      custom_analysis_data: { esito_appuntamento: 'confermato', Sintesi: 'Confermato per venerdì.' },
    }));
    expect(v.outcome?.summary).toBe('Confermato per venerdì.');
  });

  it('da call_summary quando il campo italiano manca o è vuoto', () => {
    const senza = interpretRetellCall(ended({
      call_summary: 'The agent called the customer.',
      custom_analysis_data: { esito_appuntamento: 'confermato' },
    }));
    expect(senza.outcome?.summary).toBe('The agent called the customer.');
    const vuoto = interpretRetellCall(ended({
      call_summary: 'The agent called the customer.',
      custom_analysis_data: { esito_appuntamento: 'confermato', riassunto: '  ' },
    }));
    expect(vuoto.outcome?.summary).toBe('The agent called the customer.');
  });
});
