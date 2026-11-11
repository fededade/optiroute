import { describe, expect, it } from 'vitest';
import { recoverInterruptedCall } from '../src/services/storageService';
import { autoDispatchSignature, autoDispatchStartDate, isAutoDispatchable } from '../src/hooks/useAutoDispatch';
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

describe('chiave della coda del pilota', () => {
  it('cambia quando una pratica entra in coda o parte la chiamata', () => {
    const all = [stop('s1', '2026-11-13', '09:00', '09:20', P.milano)];
    const k0 = autopilotQueueKey(all);
    const k1 = autopilotQueueKey([{ ...all[0], autoCall: 'route' }]);
    const k2 = autopilotQueueKey([{ ...all[0], callStatus: 'calling' }]);
    expect(new Set([k0, k1, k2]).size).toBe(3);
  });
});
