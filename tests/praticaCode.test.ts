import { describe, expect, it } from 'vitest';
import { codeKey, displayCode, displayNotes, praticaKey } from '../src/services/praticaCode';
import { displayCode as displayCodeFromLayout, displayNotes as displayNotesFromLayout } from '../src/layout/format';
import { buildSopralluoghiExport } from '../src/services/gestionaleExport';
import { diffBridgeSnapshot, type BridgePratica } from '../src/services/bridgeService';
import { importRowsToAppointments, type ImportRow } from '../src/hooks/importPratiche';
import { applyAppointmentChanges } from '../src/services/cloudProtocol';
import { appt, tech } from './fixtures';

// Lo stesso numero di pratica scritto in modi diversi (bridge, My Maps,
// gestionale) deve indicare la stessa pratica.

describe('codeKey', () => {
  it.each([
    ['845326', '845326'],
    ['845.326', '845326'],
    ['845 326', '845326'],
    ['ISP 845.326', '845326'],
    ['isp845326', '845326'],
    ['  Isp   845.326  ', '845326'],
    ['12345', '12345'],
    ['1234567', '1234567'],
    ['ISP-C1', 'ISP-C1'],
    ['BR-1', 'BR-1'],
    ['br-1', 'BR-1'],
    ['1.234.567', '1.234.567'],
    ['1234', '1234'],
    ['12345678', '12345678'],
    ['CER  12 a', 'CER 12 A'],
    ['', ''],
    ['   ', ''],
  ])('%j -> %j', (input, key) => {
    expect(codeKey(input)).toBe(key);
  });
  it('vuoto o mancante', () => {
    expect(codeKey(undefined)).toBe('');
    expect(codeKey(null)).toBe('');
  });
});

describe('codice della pratica', () => {
  it('periziaCode, oppure "Rif:" in testa alle note; layout/format li riesporta', () => {
    const maps = { notes: 'Rif: ISP 845.326\nCitofono rotto' };
    expect(displayCode(maps)).toBe('ISP 845.326');
    expect(displayNotes(maps)).toBe('Citofono rotto');
    expect(praticaKey(maps)).toBe('845326');
    expect(praticaKey({ periziaCode: '845.326' })).toBe('845326');
    expect(praticaKey({ notes: 'solo note' })).toBe('');
    expect(praticaKey({})).toBe('');
    expect(displayCodeFromLayout).toBe(displayCode);
    expect(displayNotesFromLayout).toBe(displayNotes);
  });
});

describe('export per il gestionale: pratica da My Maps', () => {
  it('codice dal "Rif:", note senza quella riga', () => {
    const out = buildSopralluoghiExport([
      appt({ id: 'm', status: 'confirmed', date: '2026-11-13', startTime: '09:00', notes: 'Rif: ISP 845.326\nCitofono rotto' }),
    ], [tech()]);
    expect(out.confirmed[0].codice).toBe('ISP 845.326');
    expect(out.confirmed[0].note).toBe('Citofono rotto');
  });
  it('con periziaCode le note restano intere', () => {
    const out = buildSopralluoghiExport([
      appt({ id: 'p', status: 'confirmed', date: '2026-11-13', startTime: '09:00', periziaCode: 'ISP-1', notes: 'Rif: altro\nx' }),
    ], [tech()]);
    expect(out.confirmed[0]).toMatchObject({ codice: 'ISP-1', note: 'Rif: altro\nx' });
  });
  it('lo stesso numero scritto in modo diverso, una confermata: non è fra i non confermati', () => {
    const out = buildSopralluoghiExport([
      appt({ id: 'c', status: 'confirmed', date: '2026-11-13', startTime: '09:00', notes: 'Rif: ISP 845.326' }),
      appt({ id: 'd', status: 'pending', periziaCode: '845326' }),
      appt({ id: 'e', status: 'pending', notes: 'Rif: 777.888' }),
      appt({ id: 'f', status: 'pending', periziaCode: '777888' }),
    ], [tech()]);
    expect(out.notConfirmed).toEqual(['777.888']);
    expect(out.notConfirmedIds).toEqual(['d', 'e', 'f']);
  });
});

const pratica = (codice: string, telefono = '+390211112222'): BridgePratica => ({
  portal: 'prelios', codice, intestatario: 'Rossi', via: 'Via Roma', civico: '1', comune: 'Milano', provincia: 'MI',
  telefono, note: '', progetto: '', tipologia: '', esito: '', aggiornatoIl: '',
});

describe('diff del bridge', () => {
  it('"845326" ritrova la pratica salvata come "845.326" e quella con solo "Rif: ISP 845.326"', () => {
    const byCode = appt({ id: 'a', periziaCode: '845.326' });
    const byNotes = appt({ id: 'b', notes: 'Rif: ISP 845.327\nnota' });
    const diff = diffBridgeSnapshot({ pratiche: [pratica('845326'), pratica('845327', '+390233334444'), pratica('999111')] }, [byCode, byNotes]);
    expect(diff.nuove.map(p => p.codice)).toEqual(['999111']);
    expect(diff.aggiornamenti).toEqual([
      { id: 'a', changes: { phone: '+390211112222' } },
      { id: 'b', changes: { phone: '+390233334444' } },
    ]);
  });
  it('telefono già presente: non si tocca; stesso numero due volte nel bridge: una sola', () => {
    const diff = diffBridgeSnapshot({ pratiche: [pratica('845.326'), pratica('845326')] }, [appt({ id: 'a', periziaCode: '845326', phone: '+39020000' })]);
    expect(diff).toEqual({ nuove: [], aggiornamenti: [] });
  });
  it('codici non numerici: confronto come prima', () => {
    const diff = diffBridgeSnapshot({ pratiche: [pratica('BR-1'), pratica('BR-2')] }, [appt({ id: 'x', periziaCode: 'BR-1' })]);
    expect(diff.nuove.map(p => p.codice)).toEqual(['BR-2']);
  });
});

describe('import da file: stesso numero scritto in modi diversi', () => {
  const row = (codice: string, phone?: string): ImportRow => ({ title: 'Rossi', fullAddress: 'Via Roma 1, Milano', codice, phone, notes: 'dal file' });
  it('aggiorna la pratica esistente invece di duplicarla (anche con il solo "Rif:")', async () => {
    const existing = [
      appt({ id: 'a', periziaCode: '845.326' }),
      appt({ id: 'b', notes: 'Rif: ISP 845.327' }),
    ];
    const r = await importRowsToAppointments([row('ISP 845326', '+3902111'), row('845327', '+3902222'), row('845.327')], existing, [tech()]);
    expect(r.newAppointments).toEqual([]);
    expect(r.failures).toEqual([]);
    expect([...r.updates.keys()].sort()).toEqual(['a', 'b']);
    expect(r.updates.get('a')?.phone).toBe('+3902111');
    expect(r.updates.get('b')?.phone).toBe('+3902222');
  });
});

describe('server: stessa pratica importata da due dispositivi', () => {
  it('riconosciuta anche con il numero scritto in modo diverso: niente doppione, solo il telefono mancante', () => {
    const all = [appt({ id: 'a', notes: 'Rif: ISP 845.326' })];
    const next = applyAppointmentChanges(all, [{ op: 'put', id: 'z', value: appt({ id: 'z', periziaCode: '845326', phone: '+3902999' }) }]);
    expect(next.map(a => a.id)).toEqual(['a']);
    expect(next[0].phone).toBe('+3902999');
    expect(next[0].periziaCode).toBeUndefined(); // il codice salvato non si riscrive
    const other = applyAppointmentChanges(all, [{ op: 'put', id: 'y', value: appt({ id: 'y', periziaCode: '845327' }) }]);
    expect(other.map(a => a.id)).toEqual(['a', 'y']);
  });
});
