import { describe, expect, it } from 'vitest';
import { applyImportResult, newAppointmentsToAdd, reassignUnknownTechnicians } from '../src/hooks/importPratiche';
import type { Appointment } from '../src/types';
import { P, appt, tech } from './fixtures';

// Applicazione del risultato di un import all'elenco di ADESSO (che può essere
// cambiato durante l'import, es. con il primo scaricamento dal cloud).
// Dati sintetici.

const noUpdates = new Map<string, Partial<Appointment>>();

describe('import: niente doppioni al momento di aggiungere', () => {
  it('una nuova il cui codice è già nell\'elenco non si aggiunge (anche scritto in modo diverso)', () => {
    const all = [
      appt({ id: 's1', periziaCode: '845.326' }),
      appt({ id: 's2', notes: 'Rif: ISP 845.327\naltro' }),
    ];
    const nuove = [
      appt({ id: 'n1', periziaCode: '845326' }),
      appt({ id: 'n2', periziaCode: 'ISP 845.327' }),
      appt({ id: 'n3', periziaCode: '845328' }),
    ];
    expect(newAppointmentsToAdd(all, nuove).map(a => a.id)).toEqual(['n3']);
    expect(applyImportResult(all, { newAppointments: nuove, updates: noUpdates }).map(a => a.id)).toEqual(['s1', 's2', 'n3']);
  });

  it('doppioni fra le nuove: entra solo la prima', () => {
    const nuove = [appt({ id: 'n1', periziaCode: 'BR-1' }), appt({ id: 'n2', periziaCode: 'br-1' })];
    expect(newAppointmentsToAdd([], nuove).map(a => a.id)).toEqual(['n1']);
  });

  it('le pratiche senza codice restano come oggi (si aggiungono tutte)', () => {
    const all = [appt({ id: 's1' })];
    const nuove = [appt({ id: 'n1' }), appt({ id: 'n2', notes: 'nessun riferimento' })];
    expect(applyImportResult(all, { newAppointments: nuove, updates: noUpdates }).map(a => a.id)).toEqual(['s1', 'n1', 'n2']);
  });

  it('gli aggiornamenti per codice si applicano come prima', () => {
    const all = [appt({ id: 's1', periziaCode: 'BR-1' })];
    const updates = new Map<string, Partial<Appointment>>([['s1', { phone: '+390200000001' }]]);
    const out = applyImportResult(all, { newAppointments: [appt({ id: 'n1', periziaCode: 'BR-1' })], updates });
    expect(out).toHaveLength(1);
    expect(out[0].phone).toBe('+390200000001');
  });

  it('le pratiche non toccate restano gli stessi oggetti', () => {
    const s1 = appt({ id: 's1', periziaCode: 'BR-1' });
    const out = applyImportResult([s1], { newAppointments: [], updates: noUpdates });
    expect(out[0]).toBe(s1);
  });
});

describe('import dal bridge: tecnici che non esistono più', () => {
  const cloudTech = tech({ id: 'tech-cloud', provinces: ['MI'] });

  it('tecnico assente fra quelli di adesso: si riassegna per zona', () => {
    const nuove = [appt({ id: 'n1', coords: P.milano, province: 'MI', technicianId: 'tech-predefinito' })];
    expect(reassignUnknownTechnicians(nuove, [cloudTech])[0].technicianId).toBe('tech-cloud');
  });

  it('nessun tecnico corrisponde: la pratica resta senza tecnico', () => {
    const nuove = [appt({ id: 'n1', coords: P.bergamo, province: 'BG', technicianId: 'tech-predefinito' })];
    expect(reassignUnknownTechnicians(nuove, [cloudTech])[0].technicianId).toBeUndefined();
  });

  it('tecnico esistente o pratica senza tecnico: invariate', () => {
    const ok = appt({ id: 'n1', technicianId: 'tech-cloud' });
    const none = appt({ id: 'n2', coords: P.milano, province: 'MI' });
    const out = reassignUnknownTechnicians([ok, none], [cloudTech]);
    expect(out[0]).toBe(ok);
    expect(out[1]).toBe(none);
  });
});
