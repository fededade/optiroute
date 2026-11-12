import { describe, expect, it } from 'vitest';
import { aOrAd, containsText, displayCode, displayNotes, shortName, titleIsAddress } from '../src/layout/format';
import { sortPratiche } from '../src/layout/praticheTable';
import { appt } from './fixtures';

describe('riferimento della pratica dalle note (solo visualizzazione)', () => {
  it('usa periziaCode quando c\'è, e lascia le note intere', () => {
    const a = { periziaCode: 'PR-1', notes: 'Rif: ISP 845.326\nCitofono 3' };
    expect(displayCode(a)).toBe('PR-1');
    expect(displayNotes(a)).toBe('Rif: ISP 845.326\nCitofono 3');
  });

  it('senza periziaCode prende la riga "Rif:" in testa alle note e la toglie dalle note', () => {
    const a = { notes: 'Rif: CER Banco Popolare PW000618538\nChiamare dopo le 18\nSecondo piano' };
    expect(displayCode(a)).toBe('CER Banco Popolare PW000618538');
    expect(displayNotes(a)).toBe('Chiamare dopo le 18\nSecondo piano');
  });

  it('accetta righe vuote e spazi prima del "Rif:", senza maiuscole', () => {
    const a = { periziaCode: '  ', notes: '\n  rif:   ISP 845.326  \n\nNota' };
    expect(displayCode(a)).toBe('ISP 845.326');
    expect(displayNotes(a)).toBe('Nota');
  });

  it('solo la riga "Rif:" → note vuote', () => {
    expect(displayNotes({ notes: 'Rif: ISP 1' })).toBe('');
  });

  it('un "Rif:" non in testa, o vuoto, non è un codice', () => {
    const a = { notes: 'Chiamare\nRif: ISP 1' };
    expect(displayCode(a)).toBe('');
    expect(displayNotes(a)).toBe('Chiamare\nRif: ISP 1');
    expect(displayCode({ notes: 'Rif:   \naltro' })).toBe('');
    expect(displayCode({})).toBe('');
    expect(displayNotes({})).toBe('');
  });

  it('non modifica la pratica', () => {
    const a = appt({ id: 'x', notes: 'Rif: ISP 2\nNota' });
    const before = JSON.stringify(a);
    displayCode(a); displayNotes(a);
    expect(JSON.stringify(a)).toBe(before);
    expect(a.periziaCode).toBeUndefined();
  });

  it('la tabella ordina per il codice mostrato', () => {
    const list = [
      appt({ id: 'a', title: 'A', notes: 'Rif: ZZZ 9' }),
      appt({ id: 'b', title: 'B', periziaCode: 'MMM 5' }),
      appt({ id: 'c', title: 'C', notes: 'Rif: AAA 1' }),
      appt({ id: 'd', title: 'D' }),
    ];
    expect(sortPratiche(list, { key: 'codice', dir: 'asc' }).map(x => x.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(sortPratiche(list, { key: 'codice', dir: 'desc' }).map(x => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('titolo uguale all\'indirizzo', () => {
  it('riconosce titolo e indirizzo uguali senza badare a maiuscole e spazi', () => {
    expect(titleIsAddress({ title: 'via roma  12, milano', address: 'Via Roma 12, Milano' })).toBe(true);
    expect(titleIsAddress({ title: 'Via Roma 12', address: 'Via Roma 12, Milano, Lombardia, Italia' })).toBe(true);
    expect(titleIsAddress({ title: 'Via Roma 12', address: '12, Via Roma, Milano', shortAddress: 'Via Roma 12' })).toBe(true);
  });
  it('un nome vero non è l\'indirizzo', () => {
    expect(titleIsAddress({ title: 'Mario Rossi', address: 'Via Roma 12, Milano' })).toBe(false);
    expect(titleIsAddress({ title: 'Via Roma 12, Milano', address: 'Via Roma 1, Milano' })).toBe(false);
    expect(titleIsAddress({ title: 'Via', address: 'Via Roma 1' })).toBe(false);
    expect(titleIsAddress({ title: '', address: '' })).toBe(false);
  });
  it('ordinando per cliente le pratiche senza intestatario vanno in fondo', () => {
    const list = [
      appt({ id: 'v', title: 'Via Alfa 1', address: 'Via Alfa 1, Pavia' }),
      appt({ id: 'z', title: 'Zeta' }),
      appt({ id: 'b', title: 'Beta' }),
    ];
    expect(sortPratiche(list, { key: 'cliente', dir: 'asc' }).map(x => x.id)).toEqual(['b', 'z', 'v']);
    expect(sortPratiche(list, { key: 'cliente', dir: 'desc' }).map(x => x.id)).toEqual(['z', 'b', 'v']);
  });
  it('containsText', () => {
    expect(containsText('Via Roma 12, Milano', 'milano')).toBe(true);
    expect(containsText('Via Roma 12', 'Milano')).toBe(false);
    expect(containsText('Via Roma 12', '')).toBe(false);
  });
});

describe('piccoli testi', () => {
  it('a / ad', () => {
    expect(`Torna ${aOrAd('Agenda')} Agenda`).toBe('Torna ad Agenda');
    expect(`Torna ${aOrAd('Archivio')} Archivio`).toBe('Torna ad Archivio');
    expect(`Torna ${aOrAd('Panoramica')} Panoramica`).toBe('Torna a Panoramica');
    expect(aOrAd('In attesa')).toBe('ad');
    expect(aOrAd('Da gestire')).toBe('a');
  });
  it('nome abbreviato', () => {
    expect(shortName('Sara Colombo')).toBe('Sara C.');
    expect(shortName('Anna Maria De Santis')).toBe('Anna S.');
    expect(shortName('Luca')).toBe('Luca');
  });
});
