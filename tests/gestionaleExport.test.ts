import { describe, expect, it } from 'vitest';
import { buildSopralluoghiExport, isConfirmedInAgenda } from '../src/services/gestionaleExport';
import { P, appt, outcome, tech } from './fixtures';

// Regola "sopralluogo confermato" per il gestionale e forma dei dati.

const D1 = '2026-11-13';
const D2 = '2026-11-14';
const TECHS = [tech({ id: 'tech-1', name: 'Tecnico Uno' }), tech({ id: 'tech-2', name: 'Tecnica Due' })];

const confirmed = (id: string, date: string, start: string, over = {}) =>
  appt({ id, status: 'confirmed', date, startTime: start, endTime: '10:20', technicianId: 'tech-1', phone: `+3902${id}`, periziaCode: `ISP-${id}`, ...over });

describe('regola di conferma', () => {
  it('confermato dalla chiamata AI', () => {
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { callOutcome: outcome('confermato') }))).toBe(true);
  });
  it('senza telefono: fa fede l\'operatore', () => {
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { phone: undefined }))).toBe(true);
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { phone: '  ' }))).toBe(true);
  });
  it('confermato dall\'operatore anche con il telefono e senza chiamata (es. "Conferma giornata")', () => {
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00'))).toBe(true);
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { callStatus: 'called', callId: 'c1' }))).toBe(true);
    for (const r of ['non_risposto', 'sconosciuto'] as const) {
      expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { callOutcome: outcome(r) }))).toBe(true);
    }
  });
  it('proposta in attesa della chiamata ("Approva e chiama"): non ancora confermata', () => {
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { status: 'proposed', autoCall: 'route' }))).toBe(false);
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { status: 'proposed', callStatus: 'called', callId: 'c1' }))).toBe(false);
  });
  it('altri stati o senza data/orario', () => {
    for (const status of ['proposed', 'pending', 'standby', 'issue', 'cancelled'] as const) {
      expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { status, callOutcome: outcome('confermato') }))).toBe(false);
    }
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { date: undefined, phone: undefined }))).toBe(false);
    expect(isConfirmedInAgenda(confirmed('1', D1, '09:00', { startTime: undefined, phone: undefined }))).toBe(false);
  });
});

describe('elenco per il gestionale', () => {
  const list = [
    confirmed('late', D2, '09:00', { phone: undefined, sequenceOrder: 1 }),
    confirmed('b', D1, '10:00', {
      sequenceOrder: 2, technicianId: 'tech-2', urgent: true, approximate: true, contactPerson: 'Sig.ra Bianchi (figlia)',
      shortAddress: 'Via Roma 6', address: 'Via Roma 6, 20121 Milano MI', comune: 'Milano', province: 'MI', project: 'FULL - Acquisto',
      notes: 'Citofono 3', coords: P.portaVenezia,
      callOutcome: outcome('confermato', { summary: 'Il cliente conferma', clientNotes: 'Suonare due volte', receivedAt: '2026-11-11T09:00:00.000Z' }),
    }),
    confirmed('a', D1, '09:00', { phone: undefined, sequenceOrder: 1, technicianId: 'tech-ignoto' }),
    confirmed('wait', D1, '11:00', { status: 'proposed', autoCall: 'route' }), // in attesa della chiamata
    appt({ id: 'nocode', status: 'pending' }),                          // senza codice
    confirmed('op', D2, '10:00'),                                       // confermata dall'operatore, con telefono, senza chiamata
    confirmed('nr', D2, '11:00', { callOutcome: outcome('non_risposto', { summary: 'Segreteria', receivedAt: '2026-11-11T08:00:00.000Z' }) }),
    appt({ id: 'pend', status: 'pending', periziaCode: 'ISP-pend' }),
    appt({ id: 'canc', status: 'cancelled', periziaCode: 'ISP-canc' }),
    appt({ id: 'dup', status: 'pending', periziaCode: 'ISP-pend' }),  // stesso codice: una volta sola
    appt({ id: 'empty', status: 'standby', periziaCode: '  ' }),
  ];
  const out = buildSopralluoghiExport(list, TECHS);

  it('confermati in ordine di data e ora', () => {
    expect(out.confirmed.map(s => s.id)).toEqual(['a', 'b', 'late', 'op', 'nr']);
  });

  it('confermata dall\'operatore con telefono e senza chiamata: "operatore", nessuna chiamata', () => {
    expect(out.confirmed.find(s => s.id === 'op')).toMatchObject({ conferma: 'operatore', chiamata: null, telefono: '+3902op' });
  });

  it('confermata dall\'operatore dopo un "non risponde": "operatore", con l\'esito della chiamata', () => {
    expect(out.confirmed.find(s => s.id === 'nr')).toMatchObject({
      conferma: 'operatore',
      chiamata: { esito: 'non_risposto', riepilogo: 'Segreteria', noteCliente: '', ricevutoIl: '2026-11-11T08:00:00.000Z' },
    });
  });

  it('non confermati: i codici non vuoti di tutte le altre pratiche, senza doppioni', () => {
    expect(out.notConfirmed).toEqual(['ISP-canc', 'ISP-pend', 'ISP-wait']);
  });

  it('non confermati per id: tutte le altre pratiche, con o senza codice', () => {
    expect(out.notConfirmedIds).toEqual(['canc', 'dup', 'empty', 'nocode', 'pend', 'wait']);
  });

  it('stesso codice su due pratiche, una confermata: il codice NON è fra i non confermati, l\'id sì', () => {
    const r = buildSopralluoghiExport([
      confirmed('x1', D1, '09:00', { periziaCode: 'ISP-DOPPIO', phone: undefined }),
      appt({ id: 'x2', status: 'pending', periziaCode: 'ISP-DOPPIO' }),
      appt({ id: 'x3', status: 'pending' }),
    ], TECHS);
    expect(r.confirmed.map(c => c.codice)).toEqual(['ISP-DOPPIO']);
    expect(r.notConfirmed).toEqual([]);
    expect(r.notConfirmedIds).toEqual(['x2', 'x3']);
  });

  it('pratica cancellata da OptiRoute: in nessuno dei due elenchi', () => {
    const without = buildSopralluoghiExport(list.filter(a => a.id !== 'wait' && a.id !== 'b'), TECHS);
    expect(without.confirmed.map(s => s.codice)).not.toContain('ISP-b');
    expect(without.notConfirmed).not.toContain('ISP-b');
    expect(without.notConfirmed).not.toContain('ISP-wait');
    expect(without.notConfirmedIds).not.toContain('b');
    expect(without.notConfirmedIds).not.toContain('wait');
  });

  it('tutti i campi del contratto', () => {
    const b = out.confirmed.find(s => s.id === 'b')!;
    expect(b).toEqual({
      id: 'b', codice: 'ISP-b', data: D1, oraInizio: '10:00', oraFine: '10:20', ordine: 2,
      tecnico: 'Tecnica Due', cliente: b.cliente, telefono: '+3902b', referente: 'Sig.ra Bianchi (figlia)',
      indirizzo: 'Via Roma 6', indirizzoCompleto: 'Via Roma 6, 20121 Milano MI', comune: 'Milano', provincia: 'MI',
      lat: P.portaVenezia.lat, lng: P.portaVenezia.lng, approssimato: true, progetto: 'FULL - Acquisto', note: 'Citofono 3',
      urgente: true, conferma: 'chiamata',
      chiamata: { esito: 'confermato', riepilogo: 'Il cliente conferma', noteCliente: 'Suonare due volte', ricevutoIl: '2026-11-11T09:00:00.000Z' },
    });
  });

  it('confermato dall\'operatore: tecnico sconosciuto vuoto, nessuna chiamata, campi mancanti vuoti', () => {
    const a = out.confirmed.find(s => s.id === 'a')!;
    expect(a).toMatchObject({ conferma: 'operatore', chiamata: null, tecnico: '', telefono: '', referente: '', comune: '', urgente: false, approssimato: false, ordine: 1 });
    expect(a.indirizzo).toBe(a.indirizzoCompleto);
    const late = out.confirmed.find(s => s.id === 'late')!;
    expect(late.tecnico).toBe('Tecnico Uno');
  });

  it('senza codice: compare fra i confermati con codice vuoto', () => {
    const only = buildSopralluoghiExport([confirmed('x', D1, '09:00', { periziaCode: undefined, phone: undefined })], TECHS);
    expect(only.confirmed[0].codice).toBe('');
    expect(only.notConfirmed).toEqual([]);
    expect(only.notConfirmedIds).toEqual([]);
  });
});
