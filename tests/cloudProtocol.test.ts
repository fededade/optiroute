import { describe, expect, it } from 'vitest';
import type { Appointment } from '../src/types';
import { applyAppointmentChanges, diffAppointments, rebaseAppointments } from '../src/services/cloudProtocol';
import { P, appt, outcome, stop } from './fixtures';

// Sincronizzazione browser <-> server: differenze campo per campo e fusione.

const D = '2026-11-13';
const byId = (all: Appointment[], id: string) => all.find(a => a.id === id);
const sortById = (all: Appointment[]) => [...all].sort((x, y) => x.id.localeCompare(y.id));
// come viaggia in rete: JSON (i campi undefined spariscono)
const wire = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const base = (): Appointment[] => [
  stop('a', D, '09:00', '09:20', P.milano, { notes: 'citofono rotto' }),
  stop('b', D, '10:00', '10:20', P.sesto),
  appt({ id: 'c', technicianId: 'tech-1', phone: '+390211111111' }),
];

describe('diffAppointments', () => {
  it('nessuna modifica: niente da inviare', () => {
    const b = base();
    expect(diffAppointments(b, b)).toEqual([]);
    expect(diffAppointments(b, wire(b))).toEqual([]);
  });

  it('pratica nuova, campi cambiati, campi svuotati, pratica eliminata', () => {
    const b = base();
    const nuova = appt({ id: 'n', technicianId: 'tech-1' });
    const current = [
      { ...b[0], notes: 'citofono rotto · richiamare', startTime: undefined, endTime: undefined, date: undefined, status: 'pending' as const },
      b[1],
      nuova,
    ];
    const changes = diffAppointments(b, current);
    expect(changes).toEqual([
      { op: 'patch', id: 'a', set: { notes: 'citofono rotto · richiamare', status: 'pending' }, unset: ['date', 'endTime', 'startTime'] },
      { op: 'put', id: 'n', value: nuova },
      { op: 'delete', id: 'c' },
    ]);
  });

  it('applicare le differenze alla versione di partenza riproduce l\'elenco locale', () => {
    const b = base();
    const current = [
      { ...b[0], callOutcome: outcome('confermato'), status: 'confirmed' as const, declinedDates: ['2026-11-12'] },
      { ...b[2], phone: undefined },
      appt({ id: 'z', coords: P.monza }),
    ];
    const rebuilt = applyAppointmentChanges(wire(b), wire(diffAppointments(b, current)));
    expect(sortById(rebuilt)).toEqual(sortById(wire(current)));
  });
});

describe('applyAppointmentChanges', () => {
  it('fonde campo per campo: una modifica alle note non cancella l\'esito arrivato nel frattempo', () => {
    const b = base();
    // il server ha appena applicato l'esito della chiamata alla pratica "a"
    const server = b.map(a => (a.id === 'a' ? { ...a, status: 'confirmed' as const, callOutcome: outcome('confermato') } : a));
    // l'operatore, partendo dalla versione vecchia, ha solo corretto le note
    const local = b.map(a => (a.id === 'a' ? { ...a, notes: 'citofono riparato' } : a));
    const merged = applyAppointmentChanges(server, diffAppointments(b, local));
    expect(byId(merged, 'a')).toMatchObject({ status: 'confirmed', notes: 'citofono riparato', callOutcome: { result: 'confermato' } });
  });

  it('una modifica a una pratica che non c\'è più viene ignorata; l\'eliminazione è idempotente', () => {
    const b = base();
    const server = b.filter(a => a.id !== 'b');
    const out = applyAppointmentChanges(server, [
      { op: 'patch', id: 'b', set: { notes: 'x' }, unset: [] },
      { op: 'delete', id: 'b' },
    ]);
    expect(out.map(a => a.id)).toEqual(['a', 'c']);
  });

  it('la stessa pratica importata da due dispositivi non si duplica (stesso codice)', () => {
    const server = [appt({ id: 'srv', periziaCode: '826361', technicianId: 'tech-1' })];
    const doppia = appt({ id: 'loc', periziaCode: '826361', technicianId: 'tech-1', phone: '+390233333333' });
    const altra = appt({ id: 'altra', periziaCode: '900000', technicianId: 'tech-1' });
    const out = applyAppointmentChanges(server, [
      { op: 'put', id: 'loc', value: doppia },
      { op: 'put', id: 'altra', value: altra },
    ]);
    expect(out.map(a => a.id)).toEqual(['srv', 'altra']);
    expect(byId(out, 'srv')!.phone).toBe('+390233333333'); // solo il telefono mancante viene completato
    // un telefono già presente non si sovrascrive
    const again = applyAppointmentChanges(out, [{ op: 'put', id: 'loc2', value: { ...doppia, id: 'loc2', phone: '+390244444444' } }]);
    expect(byId(again, 'srv')!.phone).toBe('+390233333333');
  });

  it('reinviare la stessa pratica nuova non la duplica', () => {
    const nuova = appt({ id: 'n', technicianId: 'tech-1' });
    const once = applyAppointmentChanges(base(), [{ op: 'put', id: 'n', value: nuova }]);
    const twice = applyAppointmentChanges(once, [{ op: 'put', id: 'n', value: nuova }]);
    expect(twice.filter(a => a.id === 'n')).toHaveLength(1);
  });

  it('è pura: elenco e oggetti in ingresso restano identici', () => {
    const b = base();
    const snapshot = JSON.stringify(b);
    const refs = [...b];
    applyAppointmentChanges(b, [
      { op: 'patch', id: 'a', set: { notes: 'x' }, unset: ['date'] },
      { op: 'delete', id: 'b' },
      { op: 'put', id: 'n', value: appt({ id: 'n' }) },
    ]);
    expect(JSON.stringify(b)).toBe(snapshot);
    b.forEach((a, i) => expect(a).toBe(refs[i]));
    expect(applyAppointmentChanges(b, [])).toBe(b);
  });
});

describe('rebaseAppointments (fusione a tre vie nel browser)', () => {
  it('riporta le modifiche locali non inviate sopra la versione nuova del server', () => {
    const b = base();
    // server: "b" confermata dal cliente, "c" smistata dal rimpiazzo
    const server = b.map(a =>
      a.id === 'b' ? { ...a, status: 'confirmed' as const }
        : a.id === 'c' ? { ...a, status: 'proposed' as const, date: D, startTime: '11:00', endTime: '11:20', autoCall: 'backfill' as const }
          : a);
    // locale: note su "a" e una pratica nuova, non ancora inviate
    const nuova = appt({ id: 'n', technicianId: 'tech-1' });
    const current = [...b.map(a => (a.id === 'a' ? { ...a, notes: 'nuove note' } : a)), nuova];
    const merged = rebaseAppointments(server, b, current);
    expect(byId(merged, 'a')!.notes).toBe('nuove note');
    expect(byId(merged, 'b')!.status).toBe('confirmed');
    expect(byId(merged, 'c')).toMatchObject({ status: 'proposed', autoCall: 'backfill' });
    expect(byId(merged, 'n')).toEqual(nuova);
  });

  it('senza modifiche locali il browser adotta la versione del server così com\'è', () => {
    const b = base();
    const server = [...b.slice(1), appt({ id: 'srv-new' })];
    expect(rebaseAppointments(server, b, b)).toBe(server);
  });

  it('una pratica eliminata sul server non ricompare per una modifica locale', () => {
    const b = base();
    const server = b.filter(a => a.id !== 'a');
    const current = b.map(a => (a.id === 'a' ? { ...a, notes: 'modifica tardiva' } : a));
    expect(rebaseAppointments(server, b, current).map(a => a.id)).toEqual(['b', 'c']);
  });
});
