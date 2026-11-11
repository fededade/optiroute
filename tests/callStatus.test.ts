import { describe, expect, it } from 'vitest';
import { normalizeChosenAlternative } from '../api/call-status';

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
