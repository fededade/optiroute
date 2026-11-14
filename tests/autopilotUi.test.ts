import { describe, expect, it } from 'vitest';
import { recoverInterruptedCall } from '../src/services/storageService';
import {
  AUTO_DISPATCH_MAX_RERUNS,
  afterDispatchRun,
  autoDispatchEntries,
  autoDispatchSignature,
  autoDispatchStartDate,
  isAutoDispatchable,
  needsAnotherRun,
} from '../src/hooks/useAutoDispatch';
import { autopilotQueueKey } from '../src/hooks/useAutopilot';
import { DEFAULT_AUTOPILOT_SETTINGS } from '../src/services/autopilotService';
import { appt, at, stop, tech, P } from './fixtures';

const S = { ...DEFAULT_AUTOPILOT_SETTINGS, enabled: true };

describe('recoverInterruptedCall (avvio dell\'app)', () => {
  const now = at('2026-11-11', '10:00');

  it('chiamata partita (callId e calledAt recenti): torna "called"', () => {
    const a = appt({ callStatus: 'calling', callId: 'c1', calledAt: at('2026-11-11', '09:50').toISOString() });
    expect(recoverInterruptedCall(a, now)).toMatchObject({ callStatus: 'called', callId: 'c1' });
  });

  it('lancio interrotto: "failed" con motivo, fuori dalla coda', () => {
    const a = appt({ callStatus: 'calling', autoCall: 'route' });
    expect(recoverInterruptedCall(a, now)).toMatchObject({
      callStatus: 'failed',
      callSummary: 'Avvio della chiamata interrotto',
      autoCall: undefined,
    });
    const old = appt({ callStatus: 'calling', callId: 'c0', calledAt: at('2026-11-10', '09:00').toISOString() });
    expect(recoverInterruptedCall(old, now).callStatus).toBe('failed');
  });

  it('le altre pratiche restano identiche', () => {
    const a = appt({ callStatus: 'called', callId: 'c1' });
    expect(recoverInterruptedCall(a, now)).toBe(a);
  });
});

describe('smistamento automatico: data di partenza', () => {
  it('fascia aperta o non ancora aperta: domani', () => {
    expect(autoDispatchStartDate(at('2026-11-11', '10:00'), S)).toBe('2026-11-12');
    expect(autoDispatchStartDate(at('2026-11-11', '07:00'), S)).toBe('2026-11-12');
  });

  it('fascia di oggi chiusa: dopodomani', () => {
    expect(autoDispatchStartDate(at('2026-11-11', '21:00'), S)).toBe('2026-11-13');
  });

  it('venerdì sera (sabato senza chiamate): il martedì', () => {
    expect(autoDispatchStartDate(at('2026-11-13', '20:00'), S)).toBe('2026-11-17');
  });
});

describe('smistamento automatico: firma dell\'input (niente cicli)', () => {
  const techs = [tech()];
  const base = [
    appt({ id: 'p1', phone: '+390211111111', technicianId: 'tech-1' }),
    appt({ id: 'p2', phone: '+390222222222' }),
    appt({ id: 'p3' }), // senza telefono: non smistata in automatico
    stop('s1', '2026-11-13', '09:00', '09:20', P.milano),
  ];

  it('solo pratiche in attesa con telefono', () => {
    expect(base.filter(isAutoDispatchable).map(a => a.id)).toEqual(['p1', 'p2']);
  });

  it('stabile se non cambia nulla di rilevante (note, ordine, tappe nel giro)', () => {
    const sig = autoDispatchSignature(base, techs, '2026-11-11');
    const shuffled = [base[3], base[1], { ...base[0], notes: 'nota nuova' }, base[2]];
    expect(autoDispatchSignature(shuffled, techs, '2026-11-11')).toBe(sig);
  });

  it('cambia con rientro, date rifiutate, tecnico, telefono arrivato, tecnici e giorno', () => {
    const sig = autoDispatchSignature(base, techs, '2026-11-11');
    const variants = [
      base.map(a => (a.id === 'p1' ? { ...a, followUpDate: '2026-11-20' } : a)),
      base.map(a => (a.id === 'p1' ? { ...a, declinedDates: ['2026-11-13'] } : a)),
      base.map(a => (a.id === 'p2' ? { ...a, technicianId: 'tech-1' } : a)),
      base.map(a => (a.id === 'p3' ? { ...a, phone: '+390233333333' } : a)),
    ];
    for (const v of variants) expect(autoDispatchSignature(v, techs, '2026-11-11')).not.toBe(sig);
    expect(autoDispatchSignature(base, [tech({ workEnd: '17:00' })], '2026-11-11')).not.toBe(sig);
    expect(autoDispatchSignature(base, techs, '2026-11-12')).not.toBe(sig);
  });
});

describe('smistamento automatico: niente lavoro ingoiato', () => {
  const p = (id: string, over = {}) => appt({ id, phone: `+3902${id.padEnd(8, '0').slice(0, 8)}`, ...over });

  it('le voci della firma seguono gli stessi campi della firma (solo pratiche smistabili)', () => {
    const all = [
      p('p1', { followUpDate: '2026-11-20', declinedDates: ['2026-11-13', '2026-11-14'], technicianId: 'tech-1' }),
      p('p2'),
      appt({ id: 'p3' }), // senza telefono
      stop('s1', '2026-11-13', '09:00', '09:20', P.milano),
    ];
    const e = autoDispatchEntries(all);
    expect([...e.keys()].sort()).toEqual(['p1', 'p2']);
    expect(e.get('p1')).toBe('2026-11-20~2026-11-13,2026-11-14~tech-1');
    expect(e.get('p2')).toBe('~~');
  });

  it('tecnico inesistente tolto dal calcolo: si ricalcola', () => {
    const input = autoDispatchEntries([p('p1', { technicianId: 'tech-fantasma' })]);
    const after = autoDispatchEntries([p('p1')]); // il commit gli ha azzerato il tecnico
    expect(needsAnotherRun(input, after)).toBe(true);
  });

  it('pratica arrivata durante il calcolo: si ricalcola', () => {
    const input = autoDispatchEntries([p('p1')]);
    const after = autoDispatchEntries([p('p1'), p('p2')]);
    expect(needsAnotherRun(input, after)).toBe(true);
  });

  it('rientro o date rifiutate cambiati durante il calcolo: si ricalcola', () => {
    const input = autoDispatchEntries([p('p1')]);
    expect(needsAnotherRun(input, autoDispatchEntries([p('p1', { followUpDate: '2026-11-20' })]))).toBe(true);
    expect(needsAnotherRun(input, autoDispatchEntries([p('p1', { declinedDates: ['2026-11-13'] })]))).toBe(true);
  });

  it('pratiche non collocabili rimaste uguali o pratiche uscite: niente ricalcolo', () => {
    const input = autoDispatchEntries([p('p1', { technicianId: 'tech-1' }), p('p2'), p('p3')]);
    // p2 collocata (non più in attesa), p1 e p3 rimaste com'erano
    const after = autoDispatchEntries([p('p1', { technicianId: 'tech-1' }), p('p2', { status: 'proposed' }), p('p3', { notes: 'nota' })]);
    expect(needsAnotherRun(input, after)).toBe(false);
    expect(needsAnotherRun(input, new Map())).toBe(false);
  });

  it('decisione: rilancio solo con lavoro nuovo, con un tetto ai rilanci senza nulla di collocato', () => {
    const input = autoDispatchEntries([p('p1', { technicianId: 'tech-fantasma' })]);
    const changed = autoDispatchEntries([p('p1')]);
    const same = input;
    // niente di nuovo: si registra la firma (il conto riparte se è stato collocato qualcosa)
    expect(afterDispatchRun(input, same, 0, 2)).toEqual({ rerun: false, reruns: 2 });
    expect(afterDispatchRun(input, same, 1, 2)).toEqual({ rerun: false, reruns: 0 });
    // lavoro nuovo: si rilancia fino al tetto, poi ci si ferma
    let reruns = 0;
    const decisions: boolean[] = [];
    for (let i = 0; i < AUTO_DISPATCH_MAX_RERUNS + 2; i++) {
      const d = afterDispatchRun(input, changed, 0, reruns);
      decisions.push(d.rerun);
      reruns = d.reruns;
    }
    expect(decisions).toEqual([...Array(AUTO_DISPATCH_MAX_RERUNS).fill(true), false, false]);
    expect(AUTO_DISPATCH_MAX_RERUNS).toBe(3);
    // un calcolo che colloca qualcosa azzera il conto e può rilanciare
    expect(afterDispatchRun(input, changed, 2, AUTO_DISPATCH_MAX_RERUNS)).toEqual({ rerun: true, reruns: 0 });
  });
});

describe('chiave della coda del pilota', () => {
  it('cambia quando una pratica entra in coda o parte la chiamata', () => {
    const all = [stop('s1', '2026-11-13', '09:00', '09:20', P.milano)];
    const k0 = autopilotQueueKey(all);
    const k1 = autopilotQueueKey([{ ...all[0], autoCall: 'route' }]);
    const k2 = autopilotQueueKey([{ ...all[0], callStatus: 'calling' }]);
    expect(new Set([k0, k1, k2]).size).toBe(3);
  });
});
