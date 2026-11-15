import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCallData,
  formatAlternativeSpoken,
  formatDateItalian,
  nomeParlato,
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

  it('apertura: prima chiede della persona per nome, la presentazione viene dopo', () => {
    const { callScript, dynamicVariables } = buildCallData(BASE);
    expect(dynamicVariables.presentazione).toBe('Buongiorno, parlo con Mario Rossi?');
    expect(dynamicVariables.presentazione).not.toContain('Effetre');
    expect(dynamicVariables.motivo_chiamata).toContain('per la perizia sull\'immobile di Milano in Via Roma 10');
    // La presentazione (motivo) e la proposta arrivano solo dopo la conferma
    const apertura = callScript.indexOf('"Buongiorno, parlo con Mario Rossi?"');
    const motivo = callScript.indexOf(`"${dynamicVariables.motivo_chiamata}"`);
    const proposta = callScript.indexOf(`"${dynamicVariables.proposta}"`);
    expect(apertura).toBeGreaterThan(-1);
    expect(motivo).toBeGreaterThan(apertura);
    expect(proposta).toBeGreaterThan(motivo);
    expect(callScript).toContain('NON presentarti e NON dire perché chiami prima che l\'interlocutore abbia risposto');
  });

  it('se non è la persona cercata: prima spiega chi è e perché chiama, poi chiede il contatto', () => {
    const { callScript } = buildCallData(BASE);
    expect(callScript).toMatch(/Se NON è la persona cercata → PRIMA presentati e spiega perché chiami/);
    expect(callScript).toContain('NON chiedere nomi o numeri prima di aver spiegato chi sei e perché chiami');
  });

  it('nomi tutti in maiuscolo diventano pronunciabili', () => {
    expect(nomeParlato('FERRO MATTEO')).toBe('Ferro Matteo');
    expect(nomeParlato("  D'ANGELO   ANNA-MARIA ")).toBe("D'Angelo Anna-Maria");
    expect(nomeParlato('De Luca Paolo')).toBe('De Luca Paolo');
    expect(nomeParlato(undefined)).toBe('');
    expect(buildCallData({ ...BASE, clientName: 'FERRO MATTEO' }).dynamicVariables.presentazione)
      .toBe('Buongiorno, parlo con Ferro Matteo?');
  });

  it('senza nome: presentazione breve e domanda sull\'intestatario', () => {
    const { callScript, dynamicVariables } = buildCallData({ ...BASE, clientName: '' });
    expect(dynamicVariables.presentazione).toMatch(/^Buongiorno, sono .+, per conto di .+ Parlo con l'intestatario della pratica\?$/);
    expect(callScript).toContain('ti sei già presentata nell\'apertura');
  });

  it('il titolo che in realtà è l\'indirizzo non viene chiesto come nome', () => {
    for (const clientName of ['Via Roma 10', 'VIA ROMA 10', 'Via Roma', 'Piazza Duomo 1', 'Corso Italia']) {
      const { dynamicVariables } = buildCallData({ ...BASE, clientName });
      expect(dynamicVariables.presentazione, clientName).toMatch(/^Buongiorno, sono .+ Parlo con l'intestatario della pratica\?$/);
    }
    // dall'indirizzo esteso (titolo = primo pezzo dell'indirizzo geocodificato)
    const { dynamicVariables } = buildCallData({
      clientName: 'Viale Monza', address: 'Viale Monza, Milano, 20125', date: '2026-11-12', startTime: '09:30',
    });
    expect(dynamicVariables.presentazione).not.toContain('parlo con Viale Monza');
  });

  it('"di cosa si tratta?" dopo la conferma: spiega il mutuo e il sopralluogo interno, senza richiedere chi è', () => {
    const { callScript, dynamicVariables } = buildCallData(BASE);
    expect(dynamicVariables.spiegazione_motivo).toBe(
      'La chiamata è relativa alla richiesta di mutuo effettuata per l\'immobile di Via Roma 10 a Milano: ' +
      'per procedere con la lavorazione della perizia è necessario effettuare il sopralluogo interno presso l\'immobile.',
    );
    expect(callScript).toContain('Se DOPO aver confermato chi è chiede "di cosa si tratta?"');
    expect(callScript).toContain('NON chiedere di nuovo con chi parli');
    expect(callScript).toContain(`"${dynamicVariables.spiegazione_motivo}"`);
    // il mutuo solo a chi ha confermato
    expect(callScript).toContain('Il MUTUO citalo SOLO a chi ha confermato di essere Mario Rossi');
  });

  it('domande sul sopralluogo: rilievi e durata per appartamento e villa, solo se chiesto', () => {
    const { callScript, dynamicVariables } = buildCallData(BASE);
    expect(dynamicVariables.info_sopralluogo).toContain('rilievi fotografici e metrici, con misure a campione');
    expect(dynamicVariables.info_sopralluogo).toContain('circa 15 minuti se si tratta di un appartamento');
    expect(dynamicVariables.info_sopralluogo).toContain('circa 25 minuti se si tratta di una villa');
    expect(callScript).toContain('## DOMANDE SUL SOPRALLUOGO (rispondi SOLO se te lo chiedono');
    // senza via/comune separati si usa il luogo breve
    expect(buildCallData({ ...BASE, shortAddress: '', comune: '', address: 'Via Po 3, Torino' })
      .dynamicVariables.spiegazione_motivo).toContain('per l\'immobile di Via Po 3');
  });

  it('dopo "chi parla?" la presentazione non si ripete alla conferma', () => {
    const { callScript } = buildCallData(BASE);
    expect(callScript).toContain('se ti sei GIÀ presentata in questa chiamata');
    expect(callScript).toContain('Se PRIMA di confermare chiede "chi parla?"');
  });

  it('referente con ruolo o senza nome: si chiede solo il nome vero, mai il segnaposto', () => {
    const conRuolo = buildCallData({ ...BASE, contactPerson: 'Luca Bianchi — geometra', referredBy: 'Mario Rossi' });
    expect(conRuolo.dynamicVariables.presentazione).toBe('Buongiorno, parlo con Luca Bianchi?');

    const conParentesi = buildCallData({ ...BASE, contactPerson: 'Sig.ra Bianchi (figlia)', referredBy: 'Mario Rossi' });
    expect(conParentesi.dynamicVariables.presentazione).toBe('Buongiorno, parlo con Sig.ra Bianchi?');

    // segnaposto dell'autopilota: da solo o con il ruolo
    for (const contactPerson of ['Referente indicato dal cliente', 'Referente indicato dal cliente — geometra']) {
      const r = buildCallData({ ...BASE, contactPerson, referredBy: 'Mario Rossi' });
      expect(r.dynamicVariables.presentazione)
        .toMatch(/^Buongiorno, sono .+ Parlo con la persona di riferimento per il sopralluogo\?$/);
      expect(r.callScript).not.toContain('Referente indicato dal cliente?');
    }
  });

  it('referente: si chiede del referente per nome e il contesto arriva dopo la conferma', () => {
    const { callScript, dynamicVariables } = buildCallData({
      ...BASE, contactPerson: 'GIANNI VERDI', referredBy: 'Mario Rossi',
    });
    expect(dynamicVariables.presentazione).toBe('Buongiorno, parlo con Gianni Verdi?');
    expect(callScript).toContain('CONTESTO REFERENTE');
    expect(callScript).toContain('indicato da Mario Rossi');
    expect(callScript.indexOf('CONTESTO REFERENTE')).toBeGreaterThan(callScript.indexOf('"Buongiorno, parlo con Gianni Verdi?"'));
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
