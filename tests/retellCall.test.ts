import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCallData,
  formatAlternativeSpoken,
  formatDateItalian,
  parseAlternatives,
} from '../api/retell-call';

const BASE = {
  clientName: 'Mario Rossi',
  date: '2026-11-12',
  startTime: '09:30',
  endTime: '10:00',
  shortAddress: 'Via Roma 10',
  comune: 'Milano',
};

const ALTS = [
  { label: 'A', date: '2026-11-12', startTime: '15:30', endTime: '16:00' },
  { label: 'B', date: '2026-11-13', startTime: '09:00', endTime: '09:30' },
];

describe('parseAlternatives', () => {
  it('scarta in silenzio gli elementi non validi e tiene al massimo 3 slot', () => {
    const parsed = parseAlternatives([
      { label: 'A', date: '2026-11-12', startTime: '15:30', endTime: '16:00' },
      { label: 'D', date: '2026-11-12', startTime: '15:30', endTime: '16:00' }, // etichetta
      { label: 'B', date: '2026-02-30', startTime: '15:30', endTime: '16:00' }, // data inesistente
      { label: 'B', date: '12/11/2026', startTime: '15:30', endTime: '16:00' }, // formato data
      { label: 'B', date: '2026-11-13', startTime: '9:00', endTime: '09:30' },  // formato ora
      { label: 'B', date: '2026-11-13', startTime: '25:00', endTime: '09:30' }, // ora fuori range
      null,
      'A',
      { label: 'A', date: '2026-11-14', startTime: '10:00', endTime: '10:30' }, // etichetta duplicata
      { label: 'b', date: '2026-11-13', startTime: '09:00', endTime: '09:30' },
      { label: 'C', date: '2026-11-16', startTime: '11:00', endTime: '11:30' },
      { label: 'C', date: '2026-11-17', startTime: '11:00', endTime: '11:30' },
    ]);
    expect(parsed).toEqual([
      { label: 'A', date: '2026-11-12', startTime: '15:30', endTime: '16:00' },
      { label: 'B', date: '2026-11-13', startTime: '09:00', endTime: '09:30' },
      { label: 'C', date: '2026-11-16', startTime: '11:00', endTime: '11:30' },
    ]);
  });

  it('input non array -> nessuna alternativa', () => {
    expect(parseAlternatives(undefined)).toEqual([]);
    expect(parseAlternatives('A')).toEqual([]);
    expect(parseAlternatives({ label: 'A' })).toEqual([]);
  });
});

describe('testo parlato delle alternative', () => {
  const originalTZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTZ;
  });

  it('giorno della settimana, giorno, mese e ora colloquiale', () => {
    expect(formatAlternativeSpoken({ label: 'A', date: '2026-11-12', startTime: '15:30', endTime: '16:00' }))
      .toBe('giovedì 12 novembre alle 15 e mezza');
    expect(formatAlternativeSpoken({ label: 'B', date: '2026-11-13', startTime: '09:00', endTime: '09:30' }))
      .toBe('venerdì 13 novembre alle 9');
    expect(formatAlternativeSpoken({ label: 'C', date: '2026-11-16', startTime: '11:15', endTime: '11:45' }))
      .toBe('lunedì 16 novembre alle 11 e 15');
  });

  it('il giorno della settimana è giusto anche con il server in un altro fuso', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatDateItalian('2026-11-12')).toBe('giovedì 12 novembre');
    expect(formatDateItalian('2027-01-01')).toBe('venerdì 1 gennaio');
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
    expect(formatDateItalian('2026-11-12')).toBe('giovedì 12 novembre');
  });
});

describe('buildCallData', () => {
  it('senza alternative: niente sezione dedicata e comportamento storico', () => {
    const { callScript, dynamicVariables } = buildCallData(BASE);
    expect(callScript).not.toContain('SLOT ALTERNATIVI');
    expect(callScript).not.toContain('alternativa_scelta');
    expect(callScript).toContain('se chiede un ALTRO GIORNO: prendi nota');
    expect(callScript).toContain('prendi nota e basta');
    expect(dynamicVariables.ha_alternative).toBe('no');
    expect(dynamicVariables.alternative_disponibili).toBe('');
    expect(dynamicVariables.alternativa_a).toBe('');
    expect(dynamicVariables.alternativa_b).toBe('');
    expect(dynamicVariables.alternativa_c).toBe('');
  });

  it('con alternative: sezione dedicata, ordine, nota per l\'analisi e niente promesse fuori dagli slot', () => {
    const { callScript, dynamicVariables } = buildCallData({ ...BASE, alternatives: ALTS });
    expect(callScript).toContain('## SLOT ALTERNATIVI');
    expect(callScript).toContain('UNA ALLA VOLTA');
    expect(callScript).toContain('NON inventare altre disponibilità');
    expect(callScript).toContain('Perfetto, allora le confermo il sopralluogo per');
    const a = callScript.indexOf('giovedì 12 novembre alle 15 e mezza');
    const b = callScript.indexOf('venerdì 13 novembre alle 9');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(callScript).toContain('A = 2026-11-12 15:30; B = 2026-11-13 09:00');
    expect(callScript).toContain('alternativa_scelta');
    // Le frasi "storiche" che danno per possibile un altro orario non ci sono più
    expect(callScript).not.toContain('dovrebbe essere possibile, ma');
    expect(callScript).not.toContain('prendi nota e basta');
    // Resto dello script invariato
    expect(callScript).toContain('1. APERTURA');
    expect(callScript).toContain('non leggere MAI ad alta voce titoli');

    expect(dynamicVariables.ha_alternative).toBe('si');
    expect(dynamicVariables.alternative_disponibili)
      .toBe('giovedì 12 novembre alle 15 e mezza\nvenerdì 13 novembre alle 9');
    expect(dynamicVariables.alternativa_a).toBe('giovedì 12 novembre alle 15 e mezza');
    expect(dynamicVariables.alternativa_b).toBe('venerdì 13 novembre alle 9');
    expect(dynamicVariables.alternativa_c).toBe('');
    expect(dynamicVariables.call_script).toBe(callScript);
  });

  it('alternative tutte non valide -> come senza alternative (la chiamata parte comunque)', () => {
    const { callScript, dynamicVariables } = buildCallData({ ...BASE, alternatives: [{ label: 'Z' }, 42] });
    expect(callScript).not.toContain('SLOT ALTERNATIVI');
    expect(dynamicVariables.ha_alternative).toBe('no');
  });

  it('variabili dinamiche: tutte stringhe, anche con input strani', () => {
    const { dynamicVariables } = buildCallData({
      ...BASE,
      urgent: true,
      // valori non stringa arrivati dal body
      periziaCode: 12345 as unknown as string,
      alternatives: ALTS,
    });
    for (const [k, v] of Object.entries(dynamicVariables)) {
      expect(typeof v, k).toBe('string');
    }
    expect(dynamicVariables.pratica_codice).toBe('12345');
  });
});
