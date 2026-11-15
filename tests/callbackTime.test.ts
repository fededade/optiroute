import { describe, expect, it } from 'vitest';
import { computeCallbackAt, parseCallbackText, relativeMinutes } from '../src/services/callbackTime';
import { toCallOutcome } from '../src/services/callService';
import { interpretRetellCall } from '../api/call-status';
import { at } from './fixtures';

// Mercoledì 11/11/2026 alle 10:00 (ora locale)
const REF = at('2026-11-11', '10:00');
const iso = (date: string, hhmm: string) => at(date, hhmm).toISOString();
const parsedAt = (text: string, ctxDay?: string, ref = REF) => parseCallbackText(text, ref, ctxDay).at?.toISOString();

describe('richiamo chiesto dal cliente: tempi relativi', () => {
  it.each([
    ['sentitemi tra dieci minuti, devo chiedere all\'inquilino', 10],
    ['fra 10 minuti', 10],
    ['tra 5 min', 5],
    ['tra circa venti minuti', 20],
    ['tra quindici minuti', 15],
    ['tra quarantacinque minuti', 45],
    ['tra un quarto d\'ora', 15],
    ['tra mezz\'ora', 30],
    ['fra mezzora', 30],
    ['tra un\'ora', 60],
    ['tra un\'ora e mezza', 90],
    ['tra due ore', 120],
    ['tra 3 ore', 180],
    ['tra due ore e mezza', 150],
    ['tra un paio d\'ore', 120],
    ['tra novanta minuti', 90],
    ['Tra Trenta Minuti', 30],
  ])('%j -> %d minuti', (text, minutes) => {
    expect(relativeMinutes(text)).toBe(minutes);
    expect(parsedAt(text)).toBe(new Date(REF.getTime() + minutes * 60000).toISOString());
  });

  it.each(['più tardi', 'risentiamoci', 'tra qualche minuto', 'richiamate', 'domani mattina presto, forse', ''])(
    '%j -> niente', text => {
      expect(parseCallbackText(text, REF).at).toBeUndefined();
    }
  );
});

describe('richiamo chiesto dal cliente: orario preciso', () => {
  it.each([
    ['alle 17', '17:00'],
    ['alle 17:30', '17:30'],
    ['ore 17.30', '17:30'],
    ['verso le 17', '17:00'],
    ['dopo le 17', '17:00'],
    ['alle cinque e mezza', '17:30'],
    ['alle 5', '17:00'],
    ['all\'una', '13:00'],
    ['nel pomeriggio', '15:00'],
    ['stasera', '18:00'],
    ['in serata', '18:00'],
  ])('%j -> oggi alle %s', (text, hhmm) => {
    expect(parsedAt(text)).toBe(iso('2026-11-11', hhmm));
  });

  it('orario già passato oggi -> niente', () => {
    expect(parsedAt('alle 9:30')).toBeUndefined();
    expect(parsedAt('nel pomeriggio', undefined, at('2026-11-11', '16:00'))).toBeUndefined();
  });

  it('con una data: quel giorno a quell\'ora', () => {
    expect(parsedAt('alle 10', '2026-11-13')).toBe(iso('2026-11-13', '10:00'));
    expect(parsedAt('domani alle 10')).toBe(iso('2026-11-12', '10:00'));
    expect(parsedAt('oggi alle 17:30')).toBe(iso('2026-11-11', '17:30'));
    expect(parsedAt('venerdì alle 11')).toBe(iso('2026-11-13', '11:00'));
    expect(parsedAt('il 20/11 alle 16')).toBe(iso('2026-11-20', '16:00'));
  });

  it('"pomeriggio" e "stasera" solo per oggi', () => {
    expect(parsedAt('domani pomeriggio')).toBeUndefined();
    expect(parseCallbackText('domani pomeriggio', REF).day).toBe('2026-11-12');
  });
});

describe('computeCallbackAt', () => {
  const src = (over: Partial<Parameters<typeof computeCallbackAt>[0]> = {}) => ({ texts: [], ref: REF, ...over });

  it('richiamo_tra_minuti (numero o testo numerico) vince su tutto', () => {
    expect(computeCallbackAt(src({ minutes: 10, texts: ['alle 17'] }))).toBe(iso('2026-11-11', '10:10'));
    expect(computeCallbackAt(src({ minutes: '15' }))).toBe(iso('2026-11-11', '10:15'));
    expect(computeCallbackAt(src({ minutes: 0 }))).toBeUndefined();
    expect(computeCallbackAt(src({ minutes: 'dieci' }))).toBeUndefined();
  });

  it('testi in ordine: il primo che indica un istante', () => {
    expect(computeCallbackAt(src({ texts: [undefined, 'più tardi', 'tra mezz\'ora', 'alle 17'] }))).toBe(iso('2026-11-11', '10:30'));
  });

  it('giorno da un testo, orario da un altro', () => {
    expect(computeCallbackAt(src({ texts: ['domani', 'alle 11'] }))).toBe(iso('2026-11-12', '11:00'));
  });

  it('solo una data senza orario -> inizio della fascia chiamate di quel giorno', () => {
    expect(computeCallbackAt(src({ followUpDate: '2026-11-13' }))).toBe(iso('2026-11-13', '09:00'));
    expect(computeCallbackAt(src({ followUpDate: '2026-11-13', callWindowStart: '08:30' }))).toBe(iso('2026-11-13', '08:30'));
    expect(computeCallbackAt(src({ texts: ['richiamatemi lunedì'] }))).toBe(iso('2026-11-16', '09:00'));
  });

  it('"oggi" senza orario o testi vaghi -> niente', () => {
    expect(computeCallbackAt(src({ followUpDate: '2026-11-11' }))).toBeUndefined();
    expect(computeCallbackAt(src({ texts: ['più tardi', 'risentiamoci'] }))).toBeUndefined();
  });
});

describe('toCallOutcome: callbackAt', () => {
  const NOW = at('2026-11-11', '10:05');

  it('dal campo richiamo_tra_minuti, a partire dalla fine della chiamata', () => {
    const o = toCallOutcome({ result: 'da_richiamare', callbackMinutes: 10, endedAt: iso('2026-11-11', '10:02') }, NOW);
    expect(o.callbackAt).toBe(iso('2026-11-11', '10:12'));
  });

  it('senza fine della chiamata: dall\'arrivo dell\'esito', () => {
    expect(toCallOutcome({ result: 'da_richiamare', callbackMinutes: 10 }, NOW).callbackAt).toBe(iso('2026-11-11', '10:15'));
  });

  it('dal campo orario_richiamo e dai testi già letti', () => {
    expect(toCallOutcome({ result: 'da_richiamare', callbackTimeRaw: 'oggi alle 17:30' }, NOW).callbackAt).toBe(iso('2026-11-11', '17:30'));
    expect(toCallOutcome({ result: 'da_richiamare', clientNotes: 'Sentitemi tra dieci minuti' }, NOW).callbackAt).toBe(iso('2026-11-11', '10:15'));
    expect(toCallOutcome({ result: 'da_richiamare', requestedTime: 'alle 16' }, NOW).callbackAt).toBe(iso('2026-11-11', '16:00'));
    expect(toCallOutcome({ result: 'da_richiamare', followUpRaw: '2026-11-13' }, NOW, { callWindowStart: '09:30' }).callbackAt).toBe(iso('2026-11-13', '09:30'));
    expect(toCallOutcome({ result: 'da_richiamare', followUpRaw: '2026-11-13', requestedTime: 'alle 15' }, NOW).callbackAt).toBe(iso('2026-11-13', '15:00'));
  });

  it('solo con "da richiamare"; vago -> niente', () => {
    expect(toCallOutcome({ result: 'riprogrammare', callbackMinutes: 10 }, NOW).callbackAt).toBeUndefined();
    expect('callbackAt' in toCallOutcome({ result: 'da_richiamare', clientNotes: 'più tardi' }, NOW)).toBe(false);
  });

  it('da Retell (call-status) all\'esito dell\'app', () => {
    const view = interpretRetellCall({
      call_status: 'ended',
      end_timestamp: at('2026-11-11', '10:01').getTime(),
      call_analysis: {
        call_summary: 'x',
        custom_analysis_data: { esito_appuntamento: 'da_richiamare', richiamo_tra_minuti: 10, orario_richiamo: 'alle 17' },
      },
    });
    expect(view.outcome).toMatchObject({ callbackMinutes: 10, callbackTimeRaw: 'alle 17', endedAt: iso('2026-11-11', '10:01') });
    expect(toCallOutcome(view.outcome, NOW).callbackAt).toBe(iso('2026-11-11', '10:11'));
    const alias = interpretRetellCall({
      call_status: 'ended',
      call_analysis: { custom_analysis_data: { esito_appuntamento: 'da_richiamare', 'Minuti Richiamo': '20', quando_richiamare: 'domani' } },
    });
    expect(alias.outcome).toMatchObject({ callbackMinutes: '20', callbackTimeRaw: 'domani' });
  });
});
