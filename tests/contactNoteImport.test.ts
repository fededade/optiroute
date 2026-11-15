import { describe, expect, it, vi } from 'vitest';
import type { Appointment } from '../src/types';
import type { BridgePratica } from '../src/services/bridgeService';
import { applyBridgeContacts, bridgeContactUpdates } from '../src/services/contactNote';
import { applyAppointmentChanges, diffAppointments } from '../src/services/cloudProtocol';
import { bridgePraticaToRow, importRowsToAppointments } from '../src/hooks/importPratiche';
import { describeImport } from '../src/hooks/useBridgeInbox';
import { appt, at, tech } from './fixtures';

// La nota di contatto del portale nell'import (pratiche nuove) e sulle
// pratiche già presenti (snapshot del bridge). Dati di fantasia.

vi.mock('../src/services/geocodingService', () => ({
  geocodeAddressParts: async () => ({ coords: { lat: 45.4642, lng: 9.19 }, displayName: 'Via Esempio 1, Milano', province: 'MI', comune: 'Milano', approximate: false }),
}));

const NOW = at('2026-11-16', '10:00');
const AG = '+393335550111';
const CLI = '+393335550122';
const NOTA_AGENTE = `Mario Rossi - 00393335550122 - per il sopralluogo contattare ag. imm. sig. Luca Bianchi 00393335550111`;
const note = (contatto: string) => `MUTUO CASA | Rif. gestore 7 | Contatto Prelios: ${contatto}`;

const pratica = (over: Partial<BridgePratica> = {}): BridgePratica => ({
  portal: 'prelios',
  codice: '900101',
  intestatario: 'Mario Rossi',
  via: 'Via Esempio',
  civico: '1',
  comune: 'Milano',
  provincia: 'MI',
  telefono: CLI,                 // il bridge sceglie il primo cellulare della nota
  note: note(NOTA_AGENTE),
  progetto: 'MUTUO CASA',
  tipologia: 'FULL',
  esito: '',
  aggiornatoIl: '2026-11-16T09:00:00Z',
  ...over,
});

const presente = (over: Partial<Appointment> = {}) =>
  appt({ id: 'p1', periziaCode: '900101', title: 'Mario Rossi', phone: CLI, ...over });

describe('import: pratiche nuove', () => {
  it('dal bridge: telefono, referente e "per conto di" dalla nota', async () => {
    const r = await importRowsToAppointments([bridgePraticaToRow(pratica())], [], [tech()]);
    expect(r.newAppointments).toHaveLength(1);
    expect(r.newAppointments[0]).toMatchObject({
      title: 'Mario Rossi',
      phone: AG,
      contactPerson: 'Luca Bianchi — agente immobiliare',
      referredBy: 'Mario Rossi',
      contactNote: NOTA_AGENTE,
    });
  });

  it('nota del cliente stesso: si chiama l\'intestatario come oggi', async () => {
    const r = await importRowsToAppointments([bridgePraticaToRow(pratica({ note: note('ROSSI MARIO - 00393335550122') }))], [], [tech()]);
    expect(r.newAppointments[0].phone).toBe(CLI);
    expect(r.newAppointments[0].contactPerson).toBeUndefined();
    expect(r.newAppointments[0].referredBy).toBeUndefined();
  });

  it('da file (Excel): stesse regole sulle note (senza "Contatto Prelios:" si leggono tutte)', async () => {
    const r = await importRowsToAppointments(
      [{ title: 'Anna Colombo', fullAddress: 'Via Verdi 3, Milano', phone: '333 5550111', notes: 'geom. Paolo Ricci 333 555 0111' }],
      [],
      [tech()]
    );
    expect(r.newAppointments[0]).toMatchObject({ phone: '333 5550111', contactPerson: 'Paolo Ricci — geometra', referredBy: 'Anna Colombo' });
  });

  it('pratica già presente nell\'import: il merge non legge la nota (lo fa lo snapshot del bridge)', async () => {
    const r = await importRowsToAppointments([bridgePraticaToRow(pratica())], [presente()], [tech()]);
    expect(r.newAppointments).toEqual([]);
    expect(r.updates.get('p1')?.contactPerson).toBeUndefined();
  });
});

describe('snapshot del bridge: pratiche già presenti', () => {
  it('si legge la nota: numero dell\'agente, referente, impronta', () => {
    const u = bridgeContactUpdates([pratica()], [presente()], NOW);
    expect(u).toEqual([{
      id: 'p1',
      changes: { phone: AG, contactPerson: 'Luca Bianchi — agente immobiliare', referredBy: 'Mario Rossi', contactNote: NOTA_AGENTE },
    }]);
  });

  it('senza telefono: arriva quello scelto dalla nota', () => {
    const u = bridgeContactUpdates([pratica()], [presente({ phone: undefined })], NOW);
    expect(u[0].changes).toMatchObject({ phone: AG, contactPerson: 'Luca Bianchi — agente immobiliare' });
  });

  it('pratica confermata o annullata: non si tocca', () => {
    expect(bridgeContactUpdates([pratica()], [presente({ status: 'confirmed', date: '2026-11-18' })], NOW)).toEqual([]);
    expect(bridgeContactUpdates([pratica()], [presente({ status: 'cancelled' })], NOW)).toEqual([]);
  });

  it('chiamata in corso: non si tocca', () => {
    expect(bridgeContactUpdates([pratica()], [presente({ callStatus: 'calling' })], NOW)).toEqual([]);
    expect(bridgeContactUpdates([pratica()], [presente({ callStatus: 'called', callId: 'c1', calledAt: NOW.toISOString() })], NOW)).toEqual([]);
  });

  it('referente già presente: non si tocca', () => {
    expect(bridgeContactUpdates([pratica()], [presente({ contactPerson: 'Paola Neri — figlia', referredBy: 'Mario Rossi' })], NOW)).toEqual([]);
  });

  it('numero corretto a mano (non scritto nella nota): non si tocca, e niente referente', () => {
    expect(bridgeContactUpdates([pratica()], [presente({ phone: '+390255500199' })], NOW)).toEqual([]);
  });

  it('nota già letta (stessa impronta): non si rilegge, anche se l\'operatore ha tolto il referente', () => {
    expect(bridgeContactUpdates([pratica()], [presente({ contactNote: NOTA_AGENTE })], NOW)).toEqual([]);
  });

  it('nota cambiata sul portale: si rilegge', () => {
    const nuova = `Mario Rossi 3335550122 - contattare figlia Sara 3335550133`;
    const u = bridgeContactUpdates([pratica({ note: note(nuova) })], [presente({ contactNote: NOTA_AGENTE })], NOW);
    expect(u[0].changes).toMatchObject({ phone: '+393335550133', contactPerson: 'Sara — figlia', contactNote: nuova });
  });

  it('nota che non cambia niente: nessuna modifica (nemmeno l\'impronta)', () => {
    expect(bridgeContactUpdates([pratica({ note: note('Mario Rossi - 00393335550122') })], [presente()], NOW)).toEqual([]);
    expect(bridgeContactUpdates([pratica({ note: 'MUTUO CASA' })], [presente()], NOW)).toEqual([]);
  });

  it('pratica non presente nello snapshot o senza codice: non si tocca', () => {
    expect(bridgeContactUpdates([pratica({ codice: '900999' })], [presente()], NOW)).toEqual([]);
    expect(bridgeContactUpdates([pratica()], [presente({ periziaCode: undefined })], NOW)).toEqual([]);
  });

  it('idempotenza: lo stesso snapshot due volte non cambia niente la seconda volta', () => {
    const list = [presente(), appt({ id: 'p2', periziaCode: '900102', title: 'Anna Colombo', phone: AG })];
    const snap = [pratica(), pratica({ codice: '900102', intestatario: 'Anna Colombo', note: note(`geom. Paolo Ricci ${AG}`), telefono: AG })];
    const first = applyBridgeContacts(list, snap, NOW);
    expect(first.applied).toEqual(['p1', 'p2']);
    expect(first.list.find(a => a.id === 'p2')).toMatchObject({ phone: AG, contactPerson: 'Paolo Ricci — geometra', referredBy: 'Anna Colombo' });
    const second = applyBridgeContacts(first.list, snap, NOW);
    expect(second.applied).toEqual([]);
    expect(second.list).toBe(first.list);
    // l'operatore toglie il referente: resta tolto finché la nota non cambia
    const tolto = first.list.map(a => (a.id === 'p1' ? { ...a, contactPerson: undefined, referredBy: undefined } : a));
    expect(applyBridgeContacts(tolto, snap, NOW).applied).toEqual([]);
  });

  it('le pratiche non toccate restano gli stessi oggetti', () => {
    const altra = appt({ id: 'z', periziaCode: '777' });
    const r = applyBridgeContacts([presente(), altra], [pratica()], NOW);
    expect(r.list[1]).toBe(altra);
  });

  it('il resoconto dello scaricamento conta i contatti presi dalla nota', () => {
    const t = at('2026-11-16', '12:15');
    expect(describeImport({ added: 0, updated: 0, failed: 0, referents: 2 }, t)).toBe('2 contatti presi dalla nota del portale alle 12:15');
    expect(describeImport({ added: 1, updated: 0, failed: 0, referents: 1 }, t)).toBe('1 nuova pratica, 1 contatto preso dalla nota del portale alle 12:15');
  });
});

describe('sincronizzazione col cloud', () => {
  it('il campo nuovo viaggia nelle differenze e si toglie come gli altri', () => {
    const base = [presente()];
    const letto = applyBridgeContacts(base, [pratica()], NOW).list;
    const changes = diffAppointments(base, letto);
    expect(changes).toEqual([{
      op: 'patch',
      id: 'p1',
      set: { phone: AG, contactPerson: 'Luca Bianchi — agente immobiliare', referredBy: 'Mario Rossi', contactNote: NOTA_AGENTE },
      unset: [],
    }]);
    const server = applyAppointmentChanges(JSON.parse(JSON.stringify(base)), JSON.parse(JSON.stringify(changes)));
    expect(server[0]).toMatchObject({ contactNote: NOTA_AGENTE, contactPerson: 'Luca Bianchi — agente immobiliare' });
    const tolto = [{ ...server[0], contactPerson: undefined, referredBy: undefined }];
    const back = diffAppointments(server, tolto);
    expect(back).toEqual([{ op: 'patch', id: 'p1', set: {}, unset: ['contactPerson', 'referredBy'] }]);
    expect(applyAppointmentChanges(server, back)[0].contactNote).toBe(NOTA_AGENTE);
  });
});
