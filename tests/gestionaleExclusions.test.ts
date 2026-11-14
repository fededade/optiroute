import { describe, expect, it } from 'vitest';
import {
  EXCLUSION_NOTE,
  applyGestionaleExclusions,
  parseExcluded,
  type GestionaleExclusion,
} from '../src/services/gestionaleExclusions';
import { fetchBridgeSnapshotViaParent } from '../src/services/bridgeService';
import { describeImport } from '../src/hooks/useBridgeInbox';
import { P, appt, stop } from './fixtures';

// Controllo incrociato con il gestionale: pratiche già concordate, fatte o
// chiuse nel gestionale escono dal lavoro. Dati sintetici.

const NOW = new Date('2026-11-14T10:00:00+01:00');
const D = '2026-11-16';
const run = (list: ReturnType<typeof appt>[], excluded: GestionaleExclusion[]) =>
  applyGestionaleExclusions(list, excluded, { now: NOW });
const byId = (list: ReturnType<typeof appt>[], id: string) => list.find(a => a.id === id)!;

describe('elenco "excluded" del gestionale', () => {
  it('tiene solo voci valide; mancante = vuoto', () => {
    expect(parseExcluded(undefined)).toEqual([]);
    expect(parseExcluded(null)).toEqual([]);
    expect(parseExcluded('846759')).toEqual([]);
    expect(parseExcluded({ codice: '1', reason: 'chiusa' })).toEqual([]);
    expect(parseExcluded([
      { codice: ' 846759 ', reason: 'concordata' },
      { codice: '845.326', reason: 'effettuata' },
      { codice: 'ISP-C1', reason: 'chiusa' },
      { codice: '', reason: 'chiusa' },
      { codice: '   ', reason: 'chiusa' },
      { codice: 123456, reason: 'chiusa' },
      { codice: '111111', reason: 'sospesa' },
      { codice: '222222' },
      null,
      'x',
      [],
    ])).toEqual([
      { codice: '846759', reason: 'concordata' },
      { codice: '845.326', reason: 'effettuata' },
      { codice: 'ISP-C1', reason: 'chiusa' },
    ]);
  });

  it('passa dalla risposta di bridge.snapshot', async () => {
    const snapshot = { bridge: 'optiroute-bridge', version: 1, generatedAt: 'x', portals: [], pratiche: [{ codice: '100001' }] };
    const ask = (result: Record<string, unknown>) => fetchBridgeSnapshotViaParent(async () => result);
    const withList = await ask({ status: 'ok', snapshot, excluded: [{ codice: '846759', reason: 'chiusa' }, { codice: 'x', reason: '?' }], portalCount: 15 });
    expect(withList).toMatchObject({ ok: true, excluded: [{ codice: '846759', reason: 'chiusa' }], portalCount: 15 });
    const without = await ask({ status: 'ok', snapshot });
    expect(without.ok && without.excluded).toEqual([]);
    expect(without.ok && 'portalCount' in without).toBe(false);
    const bad = await ask({ status: 'ok', snapshot, excluded: 'tutte', portalCount: -1 });
    expect(bad.ok && bad.excluded).toEqual([]);
    expect(bad.ok && bad.portalCount).toBeUndefined();
  });
});

describe('pratiche tolte dal lavoro', () => {
  it('in attesa, proposta, stand-by, problema: annullate con la riga nelle note', () => {
    const list = [
      appt({ id: 'p1', periziaCode: '100001', status: 'pending', notes: 'Citofono rotto' }),
      stop('p2', D, '09:00', '09:30', P.milano, { periziaCode: '100002', status: 'proposed', technicianId: 'tech-1', sequenceOrder: 1 }),
      appt({ id: 'p3', periziaCode: '100003', status: 'standby' }),
      appt({ id: 'p4', periziaCode: '100004', status: 'issue', issueType: 'callback', followUpDate: D }),
    ];
    const { list: out, removed } = run(list, [
      { codice: '100001', reason: 'concordata' },
      { codice: '100002', reason: 'effettuata' },
      { codice: '100003', reason: 'chiusa' },
      { codice: '100004', reason: 'concordata' },
    ]);
    expect(removed.map(r => r.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      expect(byId(out, id).status).toBe('cancelled');
      expect(byId(out, id).issueType).toBeUndefined();
    }
    expect(byId(out, 'p1').notes).toBe(`Citofono rotto\n${EXCLUSION_NOTE.concordata}`);
    expect(EXCLUSION_NOTE.concordata).toBe('Tolta dal giro: nel gestionale il sopralluogo risulta già concordato.');
    expect(byId(out, 'p2').notes).toBe('Tolta dal giro: nel gestionale il sopralluogo risulta già fatto.');
    expect(byId(out, 'p3').notes).toBe('Tolta dal giro: nel gestionale la pratica risulta chiusa.');
    // fuori dal giro: data e orari azzerati
    const p2 = byId(out, 'p2');
    expect([p2.date, p2.startTime, p2.endTime, p2.sequenceOrder]).toEqual([undefined, undefined, undefined, undefined]);
    expect(byId(out, 'p4').followUpDate).toBe(D);
  });

  it('slot liberato: il giro rimasto si ricalcola', () => {
    const list = [
      stop('g1', D, '09:00', '09:30', P.milano, { periziaCode: '200001', status: 'proposed', technicianId: 'tech-1', sequenceOrder: 1 }),
      stop('g2', D, '10:00', '10:30', P.sesto, { periziaCode: '200002', status: 'proposed', technicianId: 'tech-1', sequenceOrder: 2 }),
    ];
    const { list: out } = run(list, [{ codice: '200001', reason: 'concordata' }]);
    expect(byId(out, 'g2').sequenceOrder).toBe(1);
  });

  it('la chiamata in coda si toglie', () => {
    const list = [stop('q1', D, '09:00', '09:30', P.milano, { periziaCode: '300001', status: 'proposed', phone: '+390200000001', autoCall: 'route', autoCallNotBefore: '2026-11-14T12:00:00Z' })];
    const out = byId(run(list, [{ codice: '300001', reason: 'effettuata' }]).list, 'q1');
    expect(out.status).toBe('cancelled');
    expect(out.autoCall).toBeUndefined();
    expect(out.autoCallNotBefore).toBeUndefined();
  });

  it('confermate, chiamate in corso e già annullate non si toccano', () => {
    const list = [
      stop('c1', D, '09:00', '09:30', P.milano, { periziaCode: '400001', status: 'confirmed', technicianId: 'tech-1' }),
      stop('c2', D, '10:00', '10:30', P.milano, { periziaCode: '400002', status: 'proposed', phone: '+3902', callStatus: 'calling' }),
      stop('c3', D, '11:00', '11:30', P.milano, { periziaCode: '400003', status: 'proposed', phone: '+3902', callStatus: 'called', callId: 'call-1', calledAt: '2026-11-14T08:55:00Z' }),
      appt({ id: 'c4', periziaCode: '400004', status: 'cancelled', notes: 'Annullata dal cliente' }),
    ];
    const excluded: GestionaleExclusion[] = ['400001', '400002', '400003', '400004'].map(codice => ({ codice, reason: 'chiusa' }));
    const { list: out, removed } = run(list, excluded);
    expect(removed).toEqual([]);
    expect(out).toBe(list);
  });

  it('codice sconosciuto ignorato; pratiche senza codice ignorate', () => {
    const list = [appt({ id: 'u1', periziaCode: '500001' }), appt({ id: 'u2' })];
    const { list: out, removed } = run(list, [{ codice: '599999', reason: 'chiusa' }]);
    expect(removed).toEqual([]);
    expect(out).toBe(list);
    expect(run(list, []).list).toBe(list);
  });

  it('stesso numero scritto in modi diversi', () => {
    const list = [
      appt({ id: 's1', periziaCode: '845326' }),
      appt({ id: 's2', periziaCode: '845.326' }),
      appt({ id: 's3', notes: 'Rif: ISP 845.326\nSecondo piano' }),
      appt({ id: 's4', periziaCode: '845327' }),
    ];
    for (const codice of ['845326', '845.326', 'ISP 845.326']) {
      const { list: out, removed } = run(list, [{ codice, reason: 'chiusa' }]);
      expect(removed.map(r => r.id)).toEqual(['s1', 's2', 's3']);
      expect(byId(out, 's4').status).toBe('pending');
      // la riga "Rif:" resta in testa: il codice si riconosce ancora
      expect(byId(out, 's3').notes).toBe(`Rif: ISP 845.326\nSecondo piano\n${EXCLUSION_NOTE.chiusa}`);
    }
  });

  it('due volte lo stesso elenco: la seconda non cambia niente', () => {
    const list = [appt({ id: 'i1', periziaCode: '600001' }), appt({ id: 'i2', periziaCode: '600002', status: 'confirmed', date: D, startTime: '09:00' })];
    const excluded: GestionaleExclusion[] = [{ codice: '600001', reason: 'concordata' }, { codice: '600002', reason: 'concordata' }];
    const first = run(list, excluded);
    expect(first.removed.length).toBe(1);
    const second = run(first.list, excluded);
    expect(second.removed).toEqual([]);
    expect(second.list).toBe(first.list);
  });

  it('ripristinata a mano dall\'operatore: non si toglie di nuovo', () => {
    const first = run([appt({ id: 'r1', periziaCode: '700001' })], [{ codice: '700001', reason: 'concordata' }]).list;
    const restored = first.map(a => ({ ...a, status: 'pending' as const }));
    expect(run(restored, [{ codice: '700001', reason: 'concordata' }]).removed).toEqual([]);
  });

  it('testo del chip', () => {
    const at = new Date(2026, 10, 14, 12, 15);
    expect(describeImport({ added: 3, updated: 0, failed: 0, removed: 2 }, at)).toBe('3 nuove pratiche, 2 tolte perché già nel gestionale alle 12:15');
    expect(describeImport({ added: 0, updated: 0, failed: 0, removed: 1 }, at)).toBe('1 tolta perché già nel gestionale alle 12:15');
    expect(describeImport({ added: 0, updated: 0, failed: 0 }, at)).toBe('nessuna novità alle 12:15');
  });
});
