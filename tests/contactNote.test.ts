import { describe, expect, it } from 'vitest';
import {
  REFERENTE_SENZA_NOME,
  contactNoteText,
  formatContactPerson,
  isNomeIntestatario,
  numeriNelTesto,
  readContactNote,
  splitContactPerson,
  withContactFromNote,
} from '../src/services/contactNote';

// Note di fantasia nella forma del portale (bridge: componi_note). Nomi
// inventati, numeri finti (+390255500xxx / 333 555 01xx).

const nota = (contatto: string) => `MUTUO CASA | Rif. gestore 12 | Contatto Prelios: ${contatto}`;
const AG = '+393335550111';
const CLI = '+393335550122';

describe('testo della nota di contatto', () => {
  it('dopo "Contatto Prelios:" fino al prossimo " | " o alla fine', () => {
    expect(contactNoteText(nota('Mario Rossi - 3335550122'))).toBe('Mario Rossi - 3335550122');
    expect(contactNoteText('A | Contatto Prelios: Mario Rossi 3335550122 | Sospesa: altro')).toBe('Mario Rossi 3335550122');
  });
  it('senza la dicitura: tutte le note; vuote: niente', () => {
    expect(contactNoteText('Mario Rossi 333 555 0122')).toBe('Mario Rossi 333 555 0122');
    expect(contactNoteText(undefined)).toBe('');
    expect(contactNoteText('   ')).toBe('');
  });
});

describe('numeri nella nota (stesse regole del bridge)', () => {
  it('prefissi 0039/+39, gruppi, fissi, normalizzati +39 con la posizione', () => {
    const n = numeriNelTesto('A 00393335550111 B +39 333 555 0122 C 333.555.0133 D 02 55500101 E 0255500102');
    expect(n.map(x => [x.numero, x.tipo])).toEqual([
      ['+393335550111', 'mobile'],
      ['+393335550122', 'mobile'],
      ['+393335550133', 'mobile'],
      ['+390255500101', 'fisso'],
      ['+390255500102', 'fisso'],
    ]);
    expect(n[0].posizione).toBe(2);
  });
  it('lo stesso numero due volte conta una volta; date e codici non sono numeri', () => {
    expect(numeriNelTesto('3335550111 e ancora 333 555 0111').length).toBe(1);
    expect(numeriNelTesto('entro il 02/03/2026, pratica 845.326')).toEqual([]);
  });
  it('nota accorciata: il numero monco alla fine si scarta', () => {
    expect(numeriNelTesto('x 333555012', true)).toEqual([]);
    expect(numeriNelTesto('x 333555012', false)).toHaveLength(1);
  });
});

describe('chi chiamare e a quale numero', () => {
  it('nome uguale all\'intestatario (anche invertito e maiuscolo): nessun referente', () => {
    for (const t of ['Mario Rossi - 00393335550122', 'ROSSI MARIO - 00393335550122 - chiamare dopo le 18', 'rossi - 3335550122', 'Sig. Rossi 3335550122']) {
      const r = readContactNote(nota(t), 'Mario Rossi', CLI);
      expect(r.contactPerson, t).toBeUndefined();
      expect(r.phone, t).toBeUndefined();
      expect(r.scelto?.di, t).toBe('cliente');
    }
  });

  it('accenti e maiuscole non contano', () => {
    const r = readContactNote(nota('NICOLÒ FERRÀ - 3335550122'), 'Nicolo Ferra', CLI);
    expect(r.scelto?.di).toBe('cliente');
  });

  it('agente immobiliare con nome (forma delle pratiche di prova)', () => {
    const r = readContactNote(nota(`CONTATTARE AG. IMM. SIG. ROBERTO NERI ${AG}`), 'Giuseppe Marino', AG);
    expect(r).toMatchObject({ contactPerson: 'Roberto Neri — agente immobiliare', referredBy: 'Giuseppe Marino' });
    expect(r.phone).toBeUndefined();
  });

  it('"agente" e "ag. imm." scritti in vari modi', () => {
    expect(readContactNote(nota('agente Luca Bianchi - 3335550111'), 'Mario Rossi', AG).contactPerson).toBe('Luca Bianchi — agente immobiliare');
    expect(readContactNote(nota('Ag.Imm. Bianchi 3335550111'), 'Mario Rossi', AG).contactPerson).toBe('Bianchi — agente immobiliare');
    expect(readContactNote(nota('Luca Bianchi (agente immobiliare) 3335550111'), 'Mario Rossi', AG).contactPerson).toBe('Luca Bianchi — agente immobiliare');
  });

  it('agenzia senza nome di persona: segnaposto con il nome dell\'agenzia nel ruolo', () => {
    const r = readContactNote(nota(`AGENZIA IMMOBILIARE GIRASOLE - ${AG} - RIVOLGERSI IN AGENZIA PER LE CHIAVI`), 'Elena De Luca', AG);
    expect(r.contactPerson).toBe(`${REFERENTE_SENZA_NOME} — agenzia immobiliare Girasole`);
    expect(r.referredBy).toBe('Elena De Luca');
    expect(readContactNote(nota('Agenzia Casa Facile 3335550111'), 'Mario Rossi', AG).contactPerson)
      .toBe(`${REFERENTE_SENZA_NOME} — agenzia immobiliare Casa Facile`);
  });

  it('agenzia con la persona', () => {
    expect(readContactNote(nota('Agenzia Girasole sig.ra Carla Neri 3335550111'), 'Mario Rossi', AG).contactPerson)
      .toBe('Carla Neri — agenzia immobiliare Girasole');
  });

  it('geometra, architetto, amministratore, custode', () => {
    expect(readContactNote(nota('geom. Paolo Ricci 3335550111'), 'Anna Colombo', AG).contactPerson).toBe('Paolo Ricci — geometra');
    expect(readContactNote(nota('ARCH. GIANNI VERDI - 3335550111'), 'Anna Colombo', AG).contactPerson).toBe('Gianni Verdi — architetto');
    expect(readContactNote(nota('amministratore condominio 0255500101'), 'Anna Colombo', '+390255500101').contactPerson)
      .toBe(`${REFERENTE_SENZA_NOME} — amministratore`);
    expect(readContactNote(nota('custode Rina 3335550111'), 'Anna Colombo', AG).contactPerson).toBe('Rina — custode');
  });

  it('parte venditrice e proprietario', () => {
    expect(readContactNote(nota('parte venditrice sig. Gino Sala 3335550111'), 'Mario Rossi', AG).contactPerson).toBe('Gino Sala — parte venditrice');
    expect(readContactNote(nota('PROPRIETARIO 3335550111'), 'Mario Rossi', AG).contactPerson).toBe(`${REFERENTE_SENZA_NOME} — proprietario`);
  });

  it('il nome completo dell\'intestatario vince sul ruolo ("MARIO ROSSI PROPRIETARIO")', () => {
    expect(readContactNote(nota('MARIO ROSSI PROPRIETARIO 3335550122'), 'Mario Rossi', CLI).contactPerson).toBeUndefined();
  });

  it('familiari', () => {
    expect(readContactNote(nota('figlia Sara 3335550111'), 'Mario Rossi', AG).contactPerson).toBe('Sara — figlia');
    expect(readContactNote(nota('Sara (figlia) - 3335550111'), 'Mario Rossi', AG).contactPerson).toBe('Sara — figlia');
    expect(readContactNote(nota('moglie Rossi 3335550111'), 'Mario Rossi', AG).contactPerson).toBe('Rossi — moglie');
  });

  it('un altro nome senza ruolo: referente con solo il nome', () => {
    const r = readContactNote(nota('Luca Bianchi - 3335550111'), 'Mario Rossi', AG);
    expect(r.contactPerson).toBe('Luca Bianchi');
    expect(r.scelto?.di).toBe('terzo');
  });

  it('parole comuni o un nome solo senza titolo: nel dubbio nessun referente', () => {
    expect(readContactNote(nota('3335550111 disponibile solo mattina'), 'Mario Rossi', AG).contactPerson).toBeUndefined();
    expect(readContactNote(nota('Bianchi 3335550111'), 'Mario Rossi', AG).contactPerson).toBeUndefined();
    expect(readContactNote(nota('TEL: 3335550111'), 'Mario Rossi', AG).contactPerson).toBeUndefined();
  });

  it('due numeri (cliente e agente) senza indicazione esplicita: resta il numero attuale', () => {
    const t = `Mario Rossi - 00393335550122 - ag. imm. Bianchi - 00393335550111`;
    const r = readContactNote(nota(t), 'Mario Rossi', CLI);
    expect(r.numeri.map(n => n.di)).toEqual(['cliente', 'terzo']);
    expect(r.contactPerson).toBeUndefined();
    expect(r.phone).toBeUndefined();
    // se il numero attuale è quello dell'agente: si chiama l'agente
    expect(readContactNote(nota(t), 'Mario Rossi', AG).contactPerson).toBe('Bianchi — agente immobiliare');
  });

  it('due numeri con indicazione esplicita: si cambia il numero', () => {
    const r = readContactNote(nota('Mario Rossi 3335550122 - per il sopralluogo contattare ag. imm. Bianchi 3335550111'), 'Mario Rossi', CLI);
    expect(r).toMatchObject({ phone: AG, contactPerson: 'Bianchi — agente immobiliare', referredBy: 'Mario Rossi' });
  });

  it('l\'istruzione del numero precedente non vale per il successivo', () => {
    const r = readContactNote(nota('MARIO ROSSI - 3335550122 - CHIAMARE DOPO LE 18 - AG. IMM. BIANCHI - 3335550111'), 'Mario Rossi', CLI);
    expect(r.numeri[1]).toMatchObject({ esplicito: false, di: 'terzo' });
    expect(r.contactPerson).toBeUndefined();
  });

  it('"c/o", "rif." e "chiavi" sono indicazioni esplicite', () => {
    expect(readContactNote(nota('Mario Rossi 3335550122, chiavi c/o vicina sig.ra Pina Galli 3335550111'), 'Mario Rossi', CLI))
      .toMatchObject({ phone: AG, contactPerson: 'Pina Galli' });
    expect(readContactNote(nota('rif. geom. Tosi 3335550111'), 'Mario Rossi', '').contactPerson).toBe('Tosi — geometra');
  });

  it('numero attuale non presente nella nota: nessun referente, telefono invariato', () => {
    const r = readContactNote(nota('ag. imm. Bianchi 3335550111'), 'Mario Rossi', '+393335550199');
    expect(r.contactPerson).toBeUndefined();
    expect(r.phone).toBeUndefined();
  });

  it('senza numero attuale: primo cellulare, altrimenti primo numero', () => {
    const r = readContactNote(nota('studio 0255500101 - Luca Bianchi 3335550111'), 'Mario Rossi', '');
    expect(r.phone).toBe(AG);
    expect(r.contactPerson).toBe('Luca Bianchi');
    expect(readContactNote(nota('Mario Rossi 0255500101'), 'Mario Rossi', '').phone).toBe('+390255500101');
  });

  it('fisso + cellulare dello stesso cliente', () => {
    const r = readContactNote(nota('ROSSI MARIO TEL. 02 55500101 CELL. 333 555 0122'), 'Mario Rossi', CLI);
    expect(r.numeri.map(n => n.etichetta)).toEqual(['ROSSI MARIO', '']);
    expect(r.contactPerson).toBeUndefined();
  });

  it('etichetta dopo il numero', () => {
    const r = readContactNote(nota('3335550111 - geom. Paolo Ricci - per accordi'), 'Anna Colombo', AG);
    expect(r.numeri[0].etichetta).toBe('geom. Paolo Ricci');
    expect(r.contactPerson).toBe('Paolo Ricci — geometra');
  });

  it('nota vuota o senza numeri: niente (nemmeno l\'impronta)', () => {
    expect(readContactNote('', 'Mario Rossi', CLI)).toEqual({ testo: '', numeri: [] });
    const r = readContactNote(nota('cliente disponibile solo il pomeriggio'), 'Mario Rossi', CLI);
    expect(r.numeri).toEqual([]);
    expect(r.impronta).toBeUndefined();
    expect(r.contactPerson).toBeUndefined();
  });

  it('testo tutto maiuscolo', () => {
    expect(readContactNote(nota('FIGLIA SARA ROSSI - 00393335550111 - SOLO POMERIGGIO'), 'MARIO ROSSI', AG))
      .toMatchObject({ contactPerson: 'Sara Rossi — figlia', referredBy: 'MARIO ROSSI' });
  });

  it('nota tagliata a 200 caratteri: il numero monco non si usa', () => {
    const lungo = `Mario Rossi 3335550122 - ${'x'.repeat(150)} - contattare geom. Ricci 333555011`;
    const contatto = lungo.slice(0, 200);
    expect(contatto.length).toBe(200);
    const r = readContactNote(nota(contatto), 'Mario Rossi', CLI);
    expect(r.numeri.map(n => n.numero)).toEqual([CLI]);
    expect(r.contactPerson).toBeUndefined();
    expect(r.impronta).toBe(contatto);
  });

  it('intestatario che è un indirizzo: referente sì, "per conto di" no', () => {
    const r = readContactNote(nota('ag. imm. Bianchi 3335550111'), 'Via Cavour 21', AG);
    expect(r.contactPerson).toBe('Bianchi — agente immobiliare');
    expect(r.referredBy).toBeUndefined();
  });

  it('numero attuale scritto in un altro formato: è lo stesso', () => {
    expect(readContactNote(nota('ag. imm. Bianchi 0039 333 555 0111'), 'Mario Rossi', '333 5550111')).toMatchObject({
      contactPerson: 'Bianchi — agente immobiliare',
    });
    expect(readContactNote(nota('ag. imm. Bianchi 0039 333 555 0111'), 'Mario Rossi', '333 5550111').phone).toBeUndefined();
  });
});

describe('regole prudenti: insegne, parole che non sono nomi, riferimenti di pratica', () => {
  const cp = (t: string, intestatario = 'Mario Rossi') => readContactNote(nota(`${t} 3335550111`), intestatario, AG).contactPerson;

  it('dopo "ag. imm." / "agente" senza titolo: un\'insegna è l\'agenzia, non una persona', () => {
    expect(cp('AG. IMM. CASA FACILE')).toBe(`${REFERENTE_SENZA_NOME} — agenzia immobiliare Casa Facile`);
    expect(cp('agente Tecnocasa Milano')).toBe(`${REFERENTE_SENZA_NOME} — agenzia immobiliare Tecnocasa Milano`);
    expect(cp('ag. imm. Re-Max Point')).toBe(`${REFERENTE_SENZA_NOME} — agenzia immobiliare Remax Point`);
    expect(cp('AG. IMM. IMMOBILGEST')).toBe(`${REFERENTE_SENZA_NOME} — agenzia immobiliare Immobilgest`);
    expect(cp('AG. IMM. GIGLIO BLU SERENO')).toBe(`${REFERENTE_SENZA_NOME} — agenzia immobiliare Giglio Blu Sereno`);
    // con un titolo più avanti la persona c'è
    expect(cp('ag. imm. Casa Facile sig. Luca Neri')).toBe('Luca Neri — agenzia immobiliare Casa Facile');
  });

  it('con un titolo, o una o due parole non tipiche delle insegne: resta la persona', () => {
    expect(cp('AG. IMM. SIG. BIANCHI')).toBe('Bianchi — agente immobiliare');
    expect(cp('AG. IMM. BIANCHI')).toBe('Bianchi — agente immobiliare');
    expect(cp('AGENTE MARCO BIANCHI')).toBe('Marco Bianchi — agente immobiliare');
  });

  it('il nome si ferma alla prima parola comune; al massimo tre parole', () => {
    expect(cp('SIG. NERI PREFERISCE WHATSAPP')).toBe('Neri');
    expect(cp('sig.ra Carla Neri risponde solo dopo le 18')).toBe('Carla Neri');
    expect(cp('SIG. NERI SERATA LIBERO')).toBe('Neri');
    const comuni = 'preferisce chiede risponde lavora abita attende aspetta richiama richiamare chiamare contattare sentire vuole può non solo sempre dopo prima entro mattina mattino pomeriggio sera serata ore orario orari giorni giorno whatsapp sms mail email messaggio tel cell casa ufficio lavoro disponibile reperibile presente assente libero libera chiavi sopralluogo appuntamento accesso urgente grazie';
    for (const w of comuni.split(' ')) {
      expect(cp(`SIG. NERI ${w.toUpperCase()} X`), w).toBe('Neri');
      expect(cp(`Sig. Neri ${w} Rossa`), w).toBe('Neri');
    }
    expect(cp('Luca Neri può dopo le 17')).toBe('Luca Neri');
    expect(cp('geom. Gian Luca Neri')).toBe('Gian Luca Neri — geometra');
    // quattro parole: nessun nome (segnaposto)
    expect(cp('geom. Gian Luca De Neri')).toBe(`${REFERENTE_SENZA_NOME} — geometra`);
  });

  it('"Rif: ISP 845.326" non è un\'indicazione di contatto; "rif." con un ruolo o un nome sì', () => {
    const due = (t: string) => readContactNote(nota(t), 'Mario Rossi', CLI);
    // riferimento di pratica in testa: non sposta la chiamata sul primo numero se l'attuale è un altro
    const r = due('Rif: ISP 845.326 - Luca Bianchi 3335550111 - Mario Rossi 3335550122');
    expect(r.numeri[0].esplicito).toBe(false);
    expect(r.phone).toBeUndefined();
    expect(r.contactPerson).toBeUndefined();
    expect(due('RIF. MISI 845326 - LUCA BIANCHI 3335550111 - MARIO ROSSI 3335550122').numeri[0].esplicito).toBe(false);
    expect(due('rif. 845326 Luca Bianchi 3335550111 - Mario Rossi 3335550122').numeri[0].esplicito).toBe(false);
    // con un nome o un ruolo dopo: indicazione esplicita
    expect(due('Mario Rossi 3335550122 - rif. Luca Bianchi 3335550111')).toMatchObject({ phone: AG, contactPerson: 'Luca Bianchi' });
    expect(due('Mario Rossi 3335550122 - riferimento: geom. Tosi 3335550111')).toMatchObject({ phone: AG, contactPerson: 'Tosi — geometra' });
  });
});

describe('formato del referente', () => {
  it('compone e scompone', () => {
    expect(formatContactPerson('Luca Bianchi', 'agente immobiliare')).toBe('Luca Bianchi — agente immobiliare');
    expect(formatContactPerson('Luca Bianchi', '')).toBe('Luca Bianchi');
    expect(formatContactPerson('', 'geometra')).toBe(`${REFERENTE_SENZA_NOME} — geometra`);
    expect(formatContactPerson(' ', ' ')).toBeUndefined();
    expect(splitContactPerson('Luca Bianchi — agente immobiliare')).toEqual({ nome: 'Luca Bianchi', ruolo: 'agente immobiliare' });
    expect(splitContactPerson(`${REFERENTE_SENZA_NOME} — geometra`)).toEqual({ nome: '', ruolo: 'geometra' });
    expect(splitContactPerson('Sig.ra Bianchi (figlia)')).toEqual({ nome: 'Sig.ra Bianchi (figlia)', ruolo: '' });
    expect(splitContactPerson(undefined)).toEqual({ nome: '', ruolo: '' });
  });
  it('intestatario come nome', () => {
    expect(isNomeIntestatario('Mario Rossi')).toBe(true);
    expect(isNomeIntestatario('Via Verdi 3')).toBe(false);
    expect(isNomeIntestatario('')).toBe(false);
  });
});

describe('pratica nuova', () => {
  it('telefono, referente e impronta dalla nota', () => {
    const a = withContactFromNote({ title: 'Mario Rossi', phone: CLI, notes: nota(`Mario Rossi ${CLI} - contattare agente Bianchi ${AG}`) });
    expect(a).toMatchObject({ phone: AG, contactPerson: 'Bianchi — agente immobiliare', referredBy: 'Mario Rossi', contactNote: `Mario Rossi ${CLI} - contattare agente Bianchi ${AG}` });
  });
  it('referente già scritto: resta, si salva solo l\'impronta', () => {
    const a = withContactFromNote({ title: 'Mario Rossi', phone: AG, contactPerson: 'Paolo Ricci — geometra', notes: nota(`ag. imm. Bianchi ${AG}`) });
    expect(a.contactPerson).toBe('Paolo Ricci — geometra');
    expect(a.contactNote).toBe(`ag. imm. Bianchi ${AG}`);
  });
  it('senza numeri nella nota: la pratica resta quella', () => {
    const a = { title: 'Mario Rossi', notes: 'Citofono Rossi' };
    expect(withContactFromNote(a)).toBe(a);
  });
});
