import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCallData,
  formatAlternativeSpoken,
  formatDateItalian,
  nomeParlato,
  numeriInLettere,
  numeroInLettere,
  oraParlata,
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
      .toBe('giovedì dodici novembre alle quindici e mezza');
    expect(formatAlternativeSpoken({ label: 'B', date: '2026-11-13', startTime: '09:00', endTime: '09:30' }))
      .toBe('venerdì tredici novembre alle nove');
    expect(formatAlternativeSpoken({ label: 'C', date: '2026-11-16', startTime: '11:15', endTime: '11:45' }))
      .toBe('lunedì sedici novembre alle undici e quindici');
  });

  it('il giorno della settimana è giusto anche con il server in un altro fuso', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatDateItalian('2026-11-12')).toBe('giovedì dodici novembre');
    expect(formatDateItalian('2027-01-01')).toBe('venerdì primo gennaio');
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
    expect(formatDateItalian('2026-11-12')).toBe('giovedì dodici novembre');
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
    const a = callScript.indexOf('giovedì dodici novembre alle quindici e mezza');
    const b = callScript.indexOf('venerdì tredici novembre alle nove');
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
      .toBe('giovedì dodici novembre alle quindici e mezza\nvenerdì tredici novembre alle nove');
    expect(dynamicVariables.alternativa_a).toBe('giovedì dodici novembre alle quindici e mezza');
    expect(dynamicVariables.alternativa_b).toBe('venerdì tredici novembre alle nove');
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
    expect(dynamicVariables.motivo_chiamata).toContain('per la perizia sull\'immobile di Milano in Via Roma dieci');
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
    expect(callScript).toMatch(/Se NON è la persona cercata \(e non è l'agente immobiliare\) → PRIMA presentati e spiega perché chiami/);
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
      'La chiamata è relativa alla richiesta di mutuo effettuata per l\'immobile di Via Roma dieci a Milano: ' +
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
    expect(dynamicVariables.info_sopralluogo).toContain('circa quindici minuti se si tratta di un appartamento');
    expect(dynamicVariables.info_sopralluogo).toContain('circa venticinque minuti se si tratta di una villa');
    expect(callScript).toContain('## DOMANDE SUL SOPRALLUOGO (rispondi SOLO se te lo chiedono');
    // senza via/comune separati si usa il luogo breve
    expect(buildCallData({ ...BASE, shortAddress: '', comune: '', address: 'Via Po 3, Torino' })
      .dynamicVariables.spiegazione_motivo).toContain('per l\'immobile di Via Po tre');
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

describe('numeri in lettere (la voce storpia le cifre)', () => {
  it('numeri, orari e indirizzi', () => {
    expect(numeroInLettere(0)).toBe('zero');
    expect(numeroInLettere(16)).toBe('sedici');
    expect(numeroInLettere(21)).toBe('ventuno');
    expect(numeroInLettere(23)).toBe('ventitré');
    expect(numeroInLettere(38)).toBe('trentotto');
    expect(numeroInLettere(108)).toBe('centotto');
    expect(numeroInLettere(180)).toBe('centottanta');
    expect(numeroInLettere(1250)).toBe('milleduecentocinquanta');
    expect(numeroInLettere(2000)).toBe('duemila');
    expect(oraParlata('09:00')).toBe('nove');
    expect(oraParlata('09:30')).toBe('nove e mezza');
    expect(oraParlata('13:05')).toBe('tredici e cinque');
    expect(oraParlata('15:20')).toBe('quindici e venti');
    expect(numeriInLettere('Via Leopardi 9, Corbetta')).toBe('Via Leopardi nove, Corbetta');
    expect(numeriInLettere('Via Roma 10/A')).toBe('Via Roma dieci barra A');
    expect(numeriInLettere('Via 4 Novembre 21')).toBe('Via quattro Novembre ventuno');
    expect(numeriInLettere('Via 1° Maggio 21A')).toBe('Via primo Maggio ventuno A');
    expect(numeriInLettere('Piazza 1 Maggio 5BIS')).toBe('Piazza primo Maggio cinque bis');
    expect(numeriInLettere('Viale XX Settembre 10/B')).toBe('Viale venti Settembre dieci barra B');
    expect(numeriInLettere('Piazza IV Novembre')).toBe('Piazza quattro Novembre');
    expect(numeriInLettere('Via I Maggio')).toBe('Via primo Maggio');
    expect(numeriInLettere('Via Vittorio Emanuele II')).toBe('Via Vittorio Emanuele II');
    expect(numeroInLettere(103)).toBe('centotré');
    expect(numeroInLettere(1003)).toBe('milletré');
  });

  it('orari in lettere anche nei dati dell\'appuntamento e nell\'agenda del giorno', () => {
    const { callScript } = buildCallData({
      ...BASE, startTime: '15:20', endTime: '16:20', daySchedule: 'Giornata 08:30-18:00. Fasce impegnate: 09:00-10:00',
    });
    expect(callScript).toContain('- Orario proposto: alle quindici e venti (indicativamente fino alle sedici e venti)');
    expect(callScript).toContain('Giornata otto e mezza-diciotto. Fasce impegnate: nove-dieci');
  });

  it('nello script da pronunciare non restano cifre in data, ora e luogo', () => {
    const { dynamicVariables, callScript } = buildCallData({ ...BASE, date: '2026-11-16', startTime: '13:05' });
    expect(dynamicVariables.proposta).toContain('lunedì sedici novembre alle tredici e cinque');
    expect(dynamicVariables.proposta).not.toMatch(/\d/);
    expect(dynamicVariables.motivo_chiamata).not.toMatch(/\d/);
    expect(dynamicVariables.immobile).toBe('Via Roma dieci, Milano');
    expect(callScript).toContain('scrivi SEMPRE i numeri IN LETTERE');
    expect(callScript).toContain('NUMERI DI TELEFONO ripetili cifra per cifra');
  });
});

describe('casi della conversazione', () => {
  it('numero sbagliato: scuse e chiusura subito, senza insistere', () => {
    const { callScript } = buildCallData(BASE);
    expect(callScript).toContain('Se dice che il NUMERO È SBAGLIATO o che NON CONOSCE nessuno che si chiama Mario Rossi');
    // chi conosce la persona (un familiare) non è un numero sbagliato
    expect(callScript).toContain('chi CONOSCE la persona cercata');
    expect(callScript).not.toContain("non c'entra nulla con la pratica");
    expect(callScript).toContain('CHIUDI SUBITO la chiamata');
    expect(callScript).toContain('esito_appuntamento = numero_errato');
    // la regola viene prima di quella su "non è la persona cercata"
    expect(callScript.indexOf('NUMERO È SBAGLIATO')).toBeLessThan(callScript.indexOf('Se NON è la persona cercata'));
  });

  it('pochi minuti prima o dopo: niente agenda piena, al massimo dieci minuti e puntualità', () => {
    const { callScript } = buildCallData({ ...BASE, startTime: '13:05' });
    expect(callScript).toContain('Chiede di ANTICIPARE o POSTICIPARE di POCHI MINUTI');
    expect(callScript).toContain('NON usare la frase sull\'agenda piena');
    expect(callScript).toContain('riuscirebbe a esserci alle tredici e cinque?');
    expect(callScript).toContain('non prima delle dodici e cinquantacinque e non dopo le tredici e quindici');
    expect(callScript).toContain('chiedi la cortesia di essere puntuale');
    expect(callScript).toContain('nuovo_orario_richiesto = l\'orario concordato (HH:MM)');
    // la regola viene prima del tentativo "agenda piena"
    expect(callScript.indexOf('POCHI MINUTI')).toBeLessThan(callScript.indexOf('l\'agenda è pressoché piena'));
    // con gli slot alternativi le regole lasciano spazio all'aggiustamento
    const conAlt = buildCallData({ ...BASE, startTime: '13:05', alternatives: ALTS }).callScript;
    expect(conAlt).toContain('Unica eccezione: il piccolo aggiustamento di al massimo dieci minuti');
    expect(conAlt).toContain('oltre al piccolo aggiustamento di al massimo dieci minuti dell\'orario proposto');
    expect(conAlt).toContain('gli slot alternativi non si spostano');
    // senza orario proposto la regola non c'è
    expect(buildCallData({ ...BASE, startTime: '' }).callScript).not.toContain('POCHI MINUTI');
  });

  it('risponde l\'agente immobiliare: è la persona giusta, si spiega la pratica di mutuo e si propone', () => {
    const { callScript, dynamicVariables } = buildCallData({ ...BASE, clientName: 'DE NUNZIO DANIELA' });
    expect(dynamicVariables.spiegazione_agenzia).toBe(
      'La chiamo per la pratica di mutuo di De Nunzio Daniela per l\'immobile che avete in gestione in Via Roma dieci a Milano: ' +
      'per procedere con la perizia è necessario effettuare il sopralluogo interno presso l\'immobile.',
    );
    expect(callScript).toContain('Se chi risponde dice di essere l\'AGENTE IMMOBILIARE');
    expect(callScript).toContain('NON chiedergli nome e numero di telefono');
    expect(callScript).toContain(`"${dynamicVariables.spiegazione_agenzia}"`);
    expect(callScript).toContain('o all\'agente immobiliare che segue l\'immobile');
    expect(callScript).toContain('NON altro_referente');
  });

  it('referente indicato come agente immobiliare: contesto con la pratica di mutuo dell\'intestatario', () => {
    const agente = buildCallData({ ...BASE, contactPerson: 'Luca Bianchi — agente immobiliare', referredBy: 'Mario Rossi' });
    expect(agente.dynamicVariables.presentazione).toBe('Buongiorno, parlo con Luca Bianchi?');
    expect(agente.callScript).toContain('stai chiamando l\'AGENTE IMMOBILIARE che ha in gestione l\'immobile');
    expect(agente.callScript).toContain('La chiamo per la pratica di mutuo di Mario Rossi per l\'immobile che avete in gestione');
    // presentazione breve + spiegazione + proposta, con l'indirizzo detto una volta sola
    const passo = agente.callScript.split('\n').find(l => l.includes('a) presentati, spiega il motivo e proponi'))!;
    const fraseIntera = passo.split('"')[1]; // la frase da dire, prima della variante "già presentata"
    expect(fraseIntera.startsWith('Sono Misi di')).toBe(true);
    expect(fraseIntera.match(/Via Roma dieci/g)).toHaveLength(1);
    expect(passo).toContain('Avremmo disponibilità per giovedì dodici novembre alle nove e mezza. Può andarle bene?');
    expect(agente.callScript).toContain('NON proporgli di delegare l\'agente immobiliare');
    expect(passo).toContain('se ti sei GIÀ presentata in questa chiamata');
    // senza chi l'ha indicato: "dall'intestatario", non "da l'intestatario"
    const senzaRif = buildCallData({ ...BASE, contactPerson: 'Referente indicato dal cliente — agenzia immobiliare' }).callScript;
    expect(senzaRif).toContain('indicato dall\'intestatario della pratica');
    expect(senzaRif).not.toContain('da l\'intestatario');
    const geometra = buildCallData({ ...BASE, contactPerson: 'Luca Bianchi — geometra', referredBy: 'Mario Rossi' });
    expect(geometra.callScript).not.toContain('stai chiamando l\'AGENTE IMMOBILIARE');
    expect(geometra.callScript).toContain('NON stai chiamando l\'intestatario');
  });
});
