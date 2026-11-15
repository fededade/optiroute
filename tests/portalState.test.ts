import { describe, expect, it } from 'vitest';
import type { Appointment } from '../src/types';
import { fetchBridgeSnapshotViaParent, parseBridgeSnapshot, type BridgePratica } from '../src/services/bridgeService';
import {
  EXCLUSION_NOTE,
  PORTAL_EXCLUSION_NOTE,
  alreadyExcludedOnce,
  applyGestionaleExclusions,
  exclusionNote,
  mergeExclusions,
  parseExcluded,
} from '../src/services/gestionaleExclusions';
import {
  applyPortalSuspensions,
  classifySuspension,
  isPortalExcluded,
  portalExclusions,
  suspensionFingerprint,
  suspensionState,
} from '../src/services/portalState';
import { describeImport } from '../src/hooks/useBridgeInbox';
import { P, appt, stop } from './fixtures';

// Stato delle pratiche sul portale (contratto §6): pratiche già fissate,
// fatte o chiuse sul portale e pratiche sospese. Dati sintetici.

const OGGI = '2026-11-14'; // sabato
const NOW = new Date('2026-11-14T10:00:00+01:00');
const D = '2026-11-16';
const byId = (list: Appointment[], id: string) => list.find(a => a.id === id)!;

const base = { portal: 'prelios', intestatario: 'Cliente Prova', via: 'Via Esempio', civico: '1', comune: 'Milano', provincia: 'MI',
  telefono: '+390255500001', note: '', progetto: '', tipologia: '', esito: '', aggiornatoIl: '' };
const body = (pratiche: unknown[]) => ({ bridge: 'optiroute-bridge', version: 1, generatedAt: 'x', portals: [], pratiche });

describe('lettura dei campi del portale', () => {
  it('conserva i campi validi, ripuliti', () => {
    const snap = parseBridgeSnapshot(body([{
      ...base, codice: '100001', stato: '  Sopralluogo   fissato ', fase: 'fissato', dataSopralluogo: '2026-11-20',
    }, {
      ...base, codice: '100002', fase: 'sospesa', sospensione: { nota: ' cliente da richiamare\n il 20/11 ', dal: '2026-11-10' },
    }]));
    expect(snap?.pratiche[0]).toMatchObject({ stato: 'Sopralluogo fissato', fase: 'fissato', dataSopralluogo: '2026-11-20' });
    expect(snap?.pratiche[1].sospensione).toEqual({ nota: 'cliente da richiamare il 20/11', dal: '2026-11-10' });
  });

  it('valori sbagliati = campo assente, mai un errore', () => {
    const snap = parseBridgeSnapshot(body([
      { ...base, codice: '1', stato: 42, fase: 'boh', dataSopralluogo: '20/11/2026', sospensione: 'cliente da richiamare' },
      { ...base, codice: '2', stato: '', fase: '', dataSopralluogo: '2026-02-31', sospensione: { nota: 7, dal: '2026-11-10' } },
      { ...base, codice: '3', fase: 'FISSATO', dataSopralluogo: 20261120, sospensione: [] },
      { ...base, codice: '4', fase: 'sospesa', sospensione: { nota: '', dal: 'ieri' } },
      { ...base, codice: '5', fase: null, sospensione: null },
    ]));
    const [a, b, c, d, e] = snap!.pratiche;
    for (const p of [a, b, c, e]) {
      expect(p.stato).toBeUndefined();
      expect(p.fase).toBeUndefined();
      expect(p.dataSopralluogo).toBeUndefined();
      expect(p.sospensione).toBeUndefined();
    }
    expect('fase' in a).toBe(false);
    expect(d.fase).toBe('sospesa');
    expect(d.sospensione).toEqual({ nota: '' });
  });

  it('tagli: stato 80 caratteri, nota 600', () => {
    const snap = parseBridgeSnapshot(body([{ ...base, codice: '1', stato: 'x'.repeat(200), fase: 'sospesa', sospensione: { nota: 'n'.repeat(1000) } }]));
    expect(snap!.pratiche[0].stato!.length).toBe(80);
    expect(snap!.pratiche[0].sospensione!.nota.length).toBe(600);
  });

  it('bridge vecchio: nessun campo nuovo', () => {
    const snap = parseBridgeSnapshot(body([{ ...base, codice: '1' }]));
    expect(snap!.pratiche[0]).toEqual({ ...base, codice: '1' });
  });

  it('passano anche dalla pagina del gestionale; fonte "portale" nelle esclusioni', async () => {
    const r = await fetchBridgeSnapshotViaParent(async () => ({
      status: 'ok',
      snapshot: body([{ ...base, codice: '1', fase: 'sospesa', sospensione: { nota: 'cliente da richiamare' } }]),
      excluded: [{ codice: '2', reason: 'concordata', fonte: 'portale' }, { codice: '3', reason: 'chiusa', fonte: 'altro' }],
    }));
    expect(r.ok && r.snapshot.pratiche[0].sospensione).toEqual({ nota: 'cliente da richiamare' });
    expect(r.ok && r.excluded).toEqual([{ codice: '2', reason: 'concordata', fonte: 'portale' }, { codice: '3', reason: 'chiusa' }]);
    expect(parseExcluded([{ codice: '4', reason: 'chiusa', fonte: 'portale' }])).toEqual([{ codice: '4', reason: 'chiusa', fonte: 'portale' }]);
    // la data del sopralluogo fissato arriva anche dalla pagina del gestionale
    // (che toglie la pratica dallo snapshot): si tiene solo se valida e solo
    // con la fonte "portale"
    expect(parseExcluded([
      { codice: '5', reason: 'concordata', fonte: 'portale', data: '2026-11-20' },
      { codice: '6', reason: 'concordata', fonte: 'portale', data: '20/11/2026' },
      { codice: '7', reason: 'concordata', data: '2026-11-20' },
      { codice: '8', reason: 'concordata', fonte: 'portale', data: 20261120 },
    ])).toEqual([
      { codice: '5', reason: 'concordata', fonte: 'portale', data: '2026-11-20' },
      { codice: '6', reason: 'concordata', fonte: 'portale' },
      { codice: '7', reason: 'concordata' },
      { codice: '8', reason: 'concordata', fonte: 'portale' },
    ]);
  });
});

describe('esclusioni dal portale', () => {
  const pr = (codice: string, over: Partial<BridgePratica> = {}): BridgePratica => ({ ...base, codice, ...over });

  it('fissato / effettuato / chiusa; le altre fasi no', () => {
    const pratiche = [
      pr('1', { fase: 'fissato', dataSopralluogo: '2026-11-20' }),
      pr('2', { fase: 'effettuato', dataSopralluogo: '2026-11-02' }),
      pr('3', { fase: 'chiusa' }),
      pr('4', { fase: 'sospesa' }),
      pr('5', { fase: 'da_fissare' }),
      pr('6'),
      pr('7', { fase: 'fissato' }),
    ];
    expect(portalExclusions(pratiche)).toEqual([
      { codice: '1', reason: 'concordata', fonte: 'portale', data: '2026-11-20' },
      { codice: '2', reason: 'effettuata', fonte: 'portale' },
      { codice: '3', reason: 'chiusa', fonte: 'portale' },
      { codice: '7', reason: 'concordata', fonte: 'portale' },
    ]);
    expect(pratiche.map(isPortalExcluded)).toEqual([true, true, true, false, false, false, true]);
  });

  it('righe nelle note', () => {
    expect(exclusionNote({ reason: 'concordata', fonte: 'portale' })).toBe('Tolta dal giro: sul portale il sopralluogo risulta già fissato.');
    expect(exclusionNote({ reason: 'concordata', fonte: 'portale', data: '2026-11-20' })).toBe('Tolta dal giro: sul portale il sopralluogo risulta già fissato per il 20/11/2026.');
    expect(exclusionNote({ reason: 'effettuata', fonte: 'portale' })).toBe('Tolta dal giro: sul portale il sopralluogo risulta già fatto.');
    expect(exclusionNote({ reason: 'chiusa', fonte: 'portale' })).toBe('Tolta dal giro: sul portale la perizia risulta chiusa.');
    expect(exclusionNote({ reason: 'chiusa' })).toBe(EXCLUSION_NOTE.chiusa);
  });

  it('fusione con quelle della pagina: stessa pratica una volta sola (vale la pagina)', () => {
    const merged = mergeExclusions(
      [{ codice: '846.759', reason: 'effettuata' }, { codice: '846760', reason: 'chiusa', fonte: 'portale' }],
      portalExclusions([pr('846759', { fase: 'fissato', dataSopralluogo: '2026-11-20' }), pr('846761', { fase: 'chiusa' }), pr('846760', { fase: 'chiusa' })]),
    );
    expect(merged).toEqual([
      { codice: '846.759', reason: 'effettuata' },
      { codice: '846760', reason: 'chiusa', fonte: 'portale' },
      { codice: '846761', reason: 'chiusa', fonte: 'portale' },
    ]);
  });

  it('pratiche già presenti: tolte come quelle del gestionale, con la riga del portale', () => {
    const list = [
      appt({ id: 'e1', periziaCode: '200001', notes: 'Citofono 4' }),
      stop('e2', D, '09:00', '09:30', P.milano, { periziaCode: '200002', status: 'proposed', technicianId: 'tech-1', sequenceOrder: 1, autoCall: 'route' }),
      stop('e3', D, '10:00', '10:30', P.milano, { periziaCode: '200003', status: 'confirmed', technicianId: 'tech-1' }),
      stop('e4', D, '11:00', '11:30', P.milano, { periziaCode: '200004', status: 'proposed', phone: '+390255500004', callStatus: 'calling' }),
    ];
    const excluded = portalExclusions([
      pr('200001', { fase: 'fissato', dataSopralluogo: '2026-11-20' }), pr('200002', { fase: 'chiusa' }),
      pr('200003', { fase: 'effettuato' }), pr('200004', { fase: 'chiusa' }),
    ]);
    const { list: out, removed } = applyGestionaleExclusions(list, excluded, { now: NOW });
    expect(removed).toEqual([
      { id: 'e1', codice: '200001', reason: 'concordata', fonte: 'portale' },
      { id: 'e2', codice: '200002', reason: 'chiusa', fonte: 'portale' },
    ]);
    expect(byId(out, 'e1').status).toBe('cancelled');
    expect(byId(out, 'e1').notes).toBe('Citofono 4\nTolta dal giro: sul portale il sopralluogo risulta già fissato per il 20/11/2026.');
    expect(byId(out, 'e2').notes).toBe(PORTAL_EXCLUSION_NOTE.chiusa);
    expect(byId(out, 'e2').autoCall).toBeUndefined();
    expect(byId(out, 'e2').date).toBeUndefined();
    expect(byId(out, 'e3').status).toBe('confirmed');
    expect(byId(out, 'e4').status).toBe('proposed');
    // seconda volta: niente
    expect(applyGestionaleExclusions(out, excluded, { now: NOW }).list).toBe(out);
  });

  it('"già esclusa una volta" riconosce anche le righe del portale', () => {
    expect(alreadyExcludedOnce('x\nTolta dal giro: sul portale il sopralluogo risulta già fissato per il 20/11/2026.')).toBe(true);
    expect(alreadyExcludedOnce(PORTAL_EXCLUSION_NOTE.effettuata)).toBe(true);
    expect(alreadyExcludedOnce(PORTAL_EXCLUSION_NOTE.chiusa)).toBe(true);
    expect(alreadyExcludedOnce(EXCLUSION_NOTE.concordata)).toBe(true);
    expect(alreadyExcludedOnce('Citofono 4')).toBe(false);
    expect(alreadyExcludedOnce(undefined)).toBe(false);
    // ripristinata dall'operatore: non si toglie di nuovo
    const excluded = portalExclusions([pr('300001', { fase: 'chiusa' })]);
    const first = applyGestionaleExclusions([appt({ id: 'r1', periziaCode: '300001' })], excluded, { now: NOW }).list;
    const restored = first.map(a => ({ ...a, status: 'pending' as const }));
    expect(applyGestionaleExclusions(restored, excluded, { now: NOW }).removed).toEqual([]);
    // e una tolta dal gestionale non si ritoglie per il portale
    const fromGest = [appt({ id: 'r2', periziaCode: '300002', notes: EXCLUSION_NOTE.chiusa })];
    expect(applyGestionaleExclusions(fromGest, portalExclusions([pr('300002', { fase: 'fissato' })]), { now: NOW }).removed).toEqual([]);
  });
});

describe('classificazione della nota di sospensione (oggi sabato 14/11/2026)', () => {
  const vettori: [string, string, string | undefined][] = [
    ['cliente da richiamare il 20/11', 'richiamo', '2026-11-20'],
    ['Cliente da richiamare in data 20/11/2026', 'richiamo', '2026-11-20'],
    // chiamare/telefonare/contattare; giorno del mese senza il mese
    ['chiamare dopo il 19', 'richiamo', '2026-11-19'],
    ['cliente da chiamare dal 25', 'richiamo', '2026-11-25'],
    ['richiamare il 10', 'richiamo', '2026-11-10'],
    ['disponibile dal 2', 'disponibilita', '2026-12-02'],
    ['assente fino al 20', 'disponibilita', '2026-11-21'],
    ['richiamare dopo le 19', 'richiamo', undefined],
    ['chiamare alle 19', 'richiamo', undefined],
    ['telefonare tra 19 giorni', 'richiamo', '2026-12-03'],
    ['contattare il referente', 'richiamo', undefined],
    ['via Roma 19, richiamare', 'richiamo', undefined],
    ["numero errato, chiamare l'agenzia", 'numero', undefined],
    // scelte: giorno che nel mese non c'è (31: novembre no, ottobre sì), orari e altri numeri
    ['richiamare il 31', 'richiamo', '2026-10-31'],
    ['disponibile dal 31', 'disponibilita', '2026-12-31'],
    ['entro il 16 telefonare', 'richiamo', '2026-11-16'],
    ['richiamare il 19 ore 10', 'richiamo', undefined], // "19 ore": come da regola, non è una data
    ['richiamare il 19:30', 'richiamo', undefined],
    ['richiamare il 19.30', 'richiamo', undefined],
    ['richiamare il 2,5', 'richiamo', undefined],
    ['richiamare dal 3 piano', 'richiamo', undefined],
    ['richiamare il 3° giorno', 'richiamo', undefined],
    ['chiamare il 19 dicembre', 'richiamo', '2026-12-19'],
    ['chiamata il 20 alle 10, poi il 25', 'richiamo', '2026-11-20'],
    ['il 32', 'altro', undefined],
    ['dopo il 25', 'disponibilita', '2026-11-25'],
    ['da ricontattare dopo il 3 dicembre', 'richiamo', '2026-12-03'],
    ["RICHIAMARE LUNEDI'", 'richiamo', '2026-11-16'],
    ['risentire a gennaio', 'richiamo', '2027-01-01'],
    ['cliente da richiamare', 'richiamo', undefined],
    ['da richiamare il 10/11', 'richiamo', '2026-11-10'],
    ['cliente da richiamare il 31/02', 'richiamo', undefined],
    ['cliente disponibile solo dal 25/11', 'disponibilita', '2026-11-25'],
    ['disponibile non prima del 2 dicembre', 'disponibilita', '2026-12-02'],
    ["cliente all'estero, rientra il 30/11", 'disponibilita', '2026-11-30'],
    ['assente fino al 20/11', 'disponibilita', '2026-11-21'],
    ['cliente disponibile solo il sabato', 'disponibilita', undefined],
    ['disponibile solo dopo le 17.30', 'disponibilita', undefined],
    ['in attesa documenti', 'altro', undefined],
    ['', 'altro', undefined],
    // esempi sul modello delle note dell'ufficio
    ['sanatoria in corso, richiamare metà dicembre', 'lavori', '2026-12-15'],
    ['immobile non finito, risentire dopo il 20/11', 'lavori', '2026-11-20'],
    ['lavori non ultimati', 'lavori', undefined],
    ['numero non corretto', 'numero', undefined],
    ['numero inesistente, richiesto nuovo recapito', 'numero', undefined],
    ['non risponde, lasciato sms', 'richiamo', undefined],
    ['nr-sms', 'richiamo', undefined],
    ['attendo conferma dal cliente', 'richiamo', undefined],
    ['in ferie, sentire dopo il 22/11', 'richiamo', '2026-11-22'],
    ['slp tra 1 mese', 'disponibilita', '2026-12-14'],
    ['organizzarsi dopo il 30/11', 'disponibilita', '2026-11-30'],
    ['proprietario disponibile 9-11/12', 'disponibilita', '2026-12-09'],
    ['daranno dispo sett prox', 'disponibilita', '2026-11-16'],
    ['No fino al 22/11', 'disponibilita', '2026-11-23'],
    ['cliente in ferie fino al 30/11', 'disponibilita', '2026-12-01'],
    ['slp giov-venerdi mattina o dalle ore 16:00', 'disponibilita', undefined],
  ];
  for (const [nota, kind, date] of vettori) {
    it(`«${nota}»`, () => {
      expect(classifySuspension(nota, OGGI)).toEqual(date ? { kind, date } : { kind });
    });
  }

  it('altre forme di data', () => {
    const c = (n: string) => classifySuspension(n, OGGI);
    expect(c('richiamare il 15/01')).toEqual({ kind: 'richiamo', date: '2027-01-15' });
    expect(c('richiamare il 2026-12-01')).toEqual({ kind: 'richiamo', date: '2026-12-01' });
    expect(c('richiamare il 1-12-2026')).toEqual({ kind: 'richiamo', date: '2026-12-01' });
    expect(c('richiamare il 1.12.2026')).toEqual({ kind: 'richiamo', date: '2026-12-01' });
    expect(c('richiamare il 01/12/27')).toEqual({ kind: 'richiamo', date: '2027-12-01' });
    expect(c('ricontattare dal 3 dic')).toEqual({ kind: 'richiamo', date: '2026-12-03' });
    expect(c('Ritelefonare domani')).toEqual({ kind: 'richiamo', date: '2026-11-15' });
    expect(c('richiamare dopodomani')).toEqual({ kind: 'richiamo', date: '2026-11-16' });
    expect(c('richiamare sabato')).toEqual({ kind: 'richiamo', date: '2026-11-21' }); // mai oggi
    expect(c('richiamare alle 17.30')).toEqual({ kind: 'richiamo' });
    expect(c('cliente in ferie fino a dicembre')).toEqual({ kind: 'disponibilita', date: '2027-01-01' });
    expect(c('fuori sede a partire da gennaio')).toEqual({ kind: 'disponibilita', date: '2027-01-01' });
    expect(c('disponibile solo lunedì mattina')).toEqual({ kind: 'disponibilita' });
    expect(c('disponibile solo domani')).toEqual({ kind: 'disponibilita' });
    expect(c('Disponibilità: solo pomeriggio')).toEqual({ kind: 'disponibilita' });
    expect(c('assente fino al 31/02')).toEqual({ kind: 'disponibilita' });
    expect(c('perizia sospesa dal committente')).toEqual({ kind: 'altro' });
  });

  it('altre espressioni di data e abbreviazioni', () => {
    const c = (n: string) => classifySuspension(n, OGGI);
    // intervalli: il primo giorno
    expect(c("dispon. dal 9 all'11/12")).toEqual({ kind: 'disponibilita', date: '2026-12-09' });
    expect(c('disponibile 9-11 dicembre')).toEqual({ kind: 'disponibilita', date: '2026-12-09' });
    // parti del mese
    expect(c('richiamare inizio gennaio')).toEqual({ kind: 'richiamo', date: '2027-01-01' });
    expect(c('risentire primi di febbraio')).toEqual({ kind: 'richiamo', date: '2027-02-01' });
    expect(c('richiamare fine novembre')).toEqual({ kind: 'richiamo', date: '2026-11-25' });
    expect(c('richiamare metà mese')).toEqual({ kind: 'richiamo', date: '2026-11-15' });
    expect(classifySuspension('richiamare metà mese', '2026-11-20')).toEqual({ kind: 'richiamo', date: '2026-12-15' });
    expect(c('richiamare fine mese')).toEqual({ kind: 'richiamo', date: '2026-11-25' });
    expect(c('richiamare inizio mese')).toEqual({ kind: 'richiamo', date: '2026-12-01' });
    // tra / fra
    expect(c('ricontattare tra 10 gg')).toEqual({ kind: 'richiamo', date: '2026-11-24' });
    expect(c('richiamare fra 2 settimane')).toEqual({ kind: 'richiamo', date: '2026-11-28' });
    expect(c('richiamare tra 2 sett')).toEqual({ kind: 'richiamo', date: '2026-11-28' });
    expect(classifySuspension('slp tra 1 mese', '2027-01-31')).toEqual({ kind: 'disponibilita', date: '2027-02-28' });
    // settimana / mese prossimo
    expect(c('richiamare sett. pross.')).toEqual({ kind: 'richiamo', date: '2026-11-16' });
    expect(classifySuspension('richiamare settimana prossima', '2026-11-16')).toEqual({ kind: 'richiamo', date: '2026-11-23' });
    expect(c('slp mese prossimo')).toEqual({ kind: 'disponibilita', date: '2026-12-01' });
    expect(c('richiamare in settimana')).toEqual({ kind: 'richiamo' });
    // giorni abbreviati: per richiamo e lavori sì, per la disponibilità no
    expect(c('richiamare giov')).toEqual({ kind: 'richiamo', date: '2026-11-19' });
    expect(c('cantiere aperto, risentire ven')).toEqual({ kind: 'lavori', date: '2026-11-20' });
    expect(c('dispo solo mer e ven')).toEqual({ kind: 'disponibilita' });
    // orari: mai date
    expect(c('richiamare ore 17.30')).toEqual({ kind: 'richiamo' });
    expect(c('richiamare alle 9:30')).toEqual({ kind: 'richiamo' });
    // fino al: il giorno dopo, per qualunque classe
    expect(c('lavori in corso fino al 30/11')).toEqual({ kind: 'lavori', date: '2026-12-01' });
    // precedenza
    expect(c('numero errato, richiamare lunedì')).toEqual({ kind: 'numero' });
    expect(c('manca il numero, ristrutturazione in corso')).toEqual({ kind: 'numero' });
    expect(c('agibilità mancante, cliente disponibile dal 25/11')).toEqual({ kind: 'lavori', date: '2026-11-25' });
    expect(c('faranno sapere')).toEqual({ kind: 'richiamo' });
    expect(c('il prop comunicherà la dispo')).toEqual({ kind: 'richiamo' });
    expect(c('in attesa di disponibilità del prop')).toEqual({ kind: 'richiamo' });
    expect(c('segreteria')).toEqual({ kind: 'richiamo' });
  });
});

describe('applicazione delle sospensioni del portale', () => {
  const sosp = (codice: string, nota: string): Pick<BridgePratica, 'codice' | 'fase' | 'sospensione'> => ({ codice, fase: 'sospesa', sospensione: { nota } });
  const run = (list: Appointment[], pratiche: Pick<BridgePratica, 'codice' | 'fase' | 'sospensione'>[]) =>
    applyPortalSuspensions(list, pratiche, { now: NOW, today: OGGI });

  it('pratica nuova (in attesa): da richiamare con la data, riga nelle note, impronta', () => {
    const { list, applied } = run([appt({ id: 'n1', periziaCode: '400001', notes: 'Scala B' })], [sosp('400001', 'cliente da richiamare il 20/11')]);
    const a = byId(list, 'n1');
    expect(a).toMatchObject({ status: 'issue', issueType: 'callback', followUpDate: '2026-11-20', portalSuspension: 'cliente da richiamare il 20/11' });
    expect(a.notes).toBe('Scala B\nSospesa sul portale: cliente da richiamare il 20/11');
    expect(applied).toEqual([{ id: 'n1', codice: '400001', kind: 'richiamo', date: '2026-11-20', statusChanged: true }]);
  });

  it('disponibile da una data: resta in attesa con la data di rientro', () => {
    const a = byId(run([appt({ id: 'n2', periziaCode: '400002' })], [sosp('400002', 'cliente disponibile solo dal 25/11')]).list, 'n2');
    expect(a).toMatchObject({ status: 'pending', followUpDate: '2026-11-25' });
    expect(a.issueType).toBeUndefined();
  });

  it('disponibilità senza data, nota illeggibile o vuota: da richiamare senza data', () => {
    const { list } = run(
      [appt({ id: 'n3', periziaCode: '400003', followUpDate: '2026-11-30' }), appt({ id: 'n4', periziaCode: '400004' }), appt({ id: 'n5', periziaCode: '400005' })],
      [sosp('400003', 'cliente disponibile solo il sabato'), sosp('400004', 'in attesa documenti'), { codice: '400005', fase: 'sospesa' }],
    );
    for (const id of ['n3', 'n4', 'n5']) {
      expect(byId(list, id)).toMatchObject({ status: 'issue', issueType: 'callback' });
      expect(byId(list, id).followUpDate).toBeUndefined();
    }
    expect(byId(list, 'n5').notes).toBe('Sospesa sul portale (nota non disponibile).');
    expect(byId(list, 'n5').portalSuspension).toBe('-');
  });

  it('proposta: esce dal giro, la chiamata in coda si toglie, il giro rimasto si ricalcola', () => {
    const list = [
      stop('g1', D, '09:00', '09:30', P.milano, { periziaCode: '500001', status: 'proposed', technicianId: 'tech-1', sequenceOrder: 1, autoCall: 'route', autoCallNotBefore: '2026-11-14T12:00:00Z' }),
      stop('g2', D, '10:00', '10:30', P.sesto, { periziaCode: '500002', status: 'proposed', technicianId: 'tech-1', sequenceOrder: 2 }),
    ];
    const out = run(list, [sosp('500001', 'risentire a gennaio')]).list;
    const g1 = byId(out, 'g1');
    expect(g1).toMatchObject({ status: 'issue', issueType: 'callback', followUpDate: '2027-01-01' });
    expect([g1.date, g1.startTime, g1.endTime, g1.sequenceOrder, g1.autoCall, g1.autoCallNotBefore]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(byId(out, 'g2').sequenceOrder).toBe(1);
  });

  it('numero sbagliato e lavori: problematiche dedicate', () => {
    const { list } = run(
      [appt({ id: 'w1', periziaCode: '450001', followUpDate: '2026-11-30' }), appt({ id: 'w2', periziaCode: '450002' }), appt({ id: 'w3', periziaCode: '450003' })],
      [sosp('450001', 'numero non corretto'), sosp('450002', 'sanatoria in corso, richiamare metà dicembre'), sosp('450003', 'lavori non ultimati')],
    );
    expect(byId(list, 'w1')).toMatchObject({ status: 'issue', issueType: 'wrong_phone' });
    expect(byId(list, 'w1').followUpDate).toBeUndefined();
    expect(byId(list, 'w2')).toMatchObject({ status: 'issue', issueType: 'works_pending', followUpDate: '2026-12-15' });
    expect(byId(list, 'w3')).toMatchObject({ status: 'issue', issueType: 'works_pending' });
    expect(byId(list, 'w3').followUpDate).toBeUndefined();
  });

  it('in attesa con la chiamata in coda: coda tolta', () => {
    const out = byId(run([appt({ id: 'q1', periziaCode: '500003', autoCall: 'backfill' })], [sosp('500003', 'cliente da richiamare')]).list, 'q1');
    expect(out.autoCall).toBeUndefined();
    expect(out.status).toBe('issue');
  });

  it('confermate e chiamate in corso: mai toccate', () => {
    const list = [
      stop('c1', D, '09:00', '09:30', P.milano, { periziaCode: '600001', status: 'confirmed', technicianId: 'tech-1' }),
      stop('c2', D, '10:00', '10:30', P.milano, { periziaCode: '600002', status: 'proposed', phone: '+390255500002', callStatus: 'calling' }),
    ];
    const r = run(list, [sosp('600001', 'cliente da richiamare'), sosp('600002', 'cliente da richiamare')]);
    expect(r.applied).toEqual([]);
    expect(r.list).toBe(list);
  });

  it('altri stati (problema, stand-by, annullata): solo riga e impronta', () => {
    const list = [
      appt({ id: 'o1', periziaCode: '700001', status: 'issue', issueType: 'wrong_phone' }),
      appt({ id: 'o2', periziaCode: '700002', status: 'standby', notes: 'x' }),
      appt({ id: 'o3', periziaCode: '700003', status: 'cancelled' }),
    ];
    const r = run(list, ['700001', '700002', '700003'].map(c => sosp(c, 'cliente disponibile solo dal 25/11')));
    expect(byId(r.list, 'o1')).toMatchObject({ status: 'issue', issueType: 'wrong_phone', portalSuspension: 'cliente disponibile solo dal 25/11' });
    expect(byId(r.list, 'o1').followUpDate).toBeUndefined();
    expect(byId(r.list, 'o2')).toMatchObject({ status: 'standby', notes: 'x\nSospesa sul portale: cliente disponibile solo dal 25/11' });
    expect(byId(r.list, 'o3').status).toBe('cancelled');
    expect(r.applied.every(c => !c.statusChanged)).toBe(true);
  });

  it('stessa impronta: niente (la scelta dell\'operatore resta); idempotente', () => {
    const first = run([appt({ id: 'i1', periziaCode: '800001' })], [sosp('800001', 'cliente da richiamare il 20/11')]).list;
    const second = run(first, [sosp('800001', 'cliente  da richiamare il 20/11 ')]);
    expect(second.applied).toEqual([]);
    expect(second.list).toBe(first);
    // l'operatore la rimette in attesa: resta così
    const operator = first.map(a => ({ ...a, status: 'pending' as const, issueType: undefined, followUpDate: undefined }));
    expect(run(operator, [sosp('800001', 'cliente da richiamare il 20/11')]).list).toBe(operator);
  });

  it('nota cambiata sul portale, pratica rimessa in attesa: si riapplica, la riga si sostituisce', () => {
    const first = run([appt({ id: 'i2', periziaCode: '800002' })], [sosp('800002', 'cliente da richiamare il 20/11')]).list;
    const operator = first.map(a => ({ ...a, status: 'pending' as const, issueType: undefined, followUpDate: undefined }));
    const r = run(operator, [sosp('800002', 'cliente disponibile solo dal 2 dicembre')]);
    const a = byId(r.list, 'i2');
    expect(a).toMatchObject({ status: 'pending', followUpDate: '2026-12-02', portalSuspension: 'cliente disponibile solo dal 2 dicembre', portalSuspensionState: 'pending||2026-12-02' });
    expect(a.notes).toBe('Sospesa sul portale: cliente disponibile solo dal 2 dicembre');
  });

  it('stato dato dalla sospensione: salvato solo con l\'applicazione completa', () => {
    const r = run(
      [appt({ id: 's1', periziaCode: '810001' }), appt({ id: 's2', periziaCode: '810002', status: 'standby' })],
      [sosp('810001', 'cliente da richiamare il 20/11'), sosp('810002', 'cliente da richiamare il 20/11')],
    );
    expect(byId(r.list, 's1').portalSuspensionState).toBe('issue|callback|2026-11-20');
    expect('portalSuspensionState' in byId(r.list, 's2')).toBe(false);
    expect(suspensionState(byId(r.list, 's1'))).toBe('issue|callback|2026-11-20');
  });

  it('prima senza nota, poi con la nota vera: la data si applica, la riga si sostituisce (una sola)', () => {
    const first = run([appt({ id: 'e1', periziaCode: '820001', notes: 'Scala B' })], [{ codice: '820001', fase: 'sospesa', sospensione: { nota: '' } }]);
    const a0 = byId(first.list, 'e1');
    expect(a0).toMatchObject({ status: 'issue', issueType: 'callback', portalSuspension: '-', portalSuspensionState: 'issue|callback|' });
    expect(a0.notes).toBe('Scala B\nSospesa sul portale (nota non disponibile).');
    const second = run(first.list, [sosp('820001', 'cliente da richiamare il 20/11')]);
    const a = byId(second.list, 'e1');
    expect(a).toMatchObject({ status: 'issue', issueType: 'callback', followUpDate: '2026-11-20', portalSuspension: 'cliente da richiamare il 20/11', portalSuspensionState: 'issue|callback|2026-11-20' });
    expect(a.notes).toBe('Scala B\nSospesa sul portale: cliente da richiamare il 20/11');
    expect(second.applied).toEqual([{ id: 'e1', codice: '820001', kind: 'richiamo', date: '2026-11-20', statusChanged: true }]);
    // idempotente
    const third = run(second.list, [sosp('820001', 'cliente da richiamare il 20/11')]);
    expect(third.applied).toEqual([]);
    expect(third.list).toBe(second.list);
  });

  it('nota cambiata con pratica intatta: riclassificata; la riga resta al suo posto, le altre note no', () => {
    const first = run([appt({ id: 'e2', periziaCode: '820002', notes: 'Citofono rotto' })], [sosp('820002', 'cliente da richiamare il 20/11')]).list;
    const withMore = first.map(a => ({ ...a, notes: `${a.notes}\nChiedere del portiere` }));
    const r = run(withMore, [sosp('820002', 'lavori non ultimati, richiamare a gennaio')]);
    const a = byId(r.list, 'e2');
    expect(a).toMatchObject({ status: 'issue', issueType: 'works_pending', followUpDate: '2027-01-01', portalSuspensionState: 'issue|works_pending|2027-01-01' });
    expect(a.notes).toBe('Citofono rotto\nSospesa sul portale: lavori non ultimati, richiamare a gennaio\nChiedere del portiere');
    expect(r.applied[0].statusChanged).toBe(true);
  });

  it('nota cambiata con pratica toccata dall\'operatore: solo riga (sostituita) e impronta', () => {
    const first = run([appt({ id: 'e3', periziaCode: '820003' })], [sosp('820003', 'cliente da richiamare il 20/11')]).list;
    // l'operatore sposta la data di richiamo
    const operator = first.map(a => ({ ...a, followUpDate: '2026-11-25' }));
    const r = run(operator, [sosp('820003', 'cliente disponibile solo dal 2 dicembre')]);
    const a = byId(r.list, 'e3');
    expect(a).toMatchObject({ status: 'issue', issueType: 'callback', followUpDate: '2026-11-25', portalSuspension: 'cliente disponibile solo dal 2 dicembre' });
    expect('portalSuspensionState' in a).toBe(false);
    expect(a.notes).toBe('Sospesa sul portale: cliente disponibile solo dal 2 dicembre');
    expect(r.applied[0].statusChanged).toBe(false);
  });

  it('nota cambiata: confermate e chiamate in corso mai toccate, anche se intatte', () => {
    const first = run([appt({ id: 'e4', periziaCode: '820004' })], [sosp('820004', 'cliente da richiamare')]).list;
    const calling = first.map(a => ({ ...a, callStatus: 'calling' as const }));
    const r = run(calling, [sosp('820004', 'cliente da richiamare il 20/11')]);
    expect(r.applied).toEqual([]);
    expect(r.list).toBe(calling);
    // non più sospesa durante la chiamata: si aspetta
    const gone = run(calling, [{ codice: '820004', fase: 'da_fissare' }]);
    expect(gone.list).toBe(calling);
    expect(gone.cleared).toEqual([]);
    const confirmed = [stop('e5', D, '09:00', '09:30', P.milano, { periziaCode: '820005', status: 'confirmed', portalSuspension: '-', portalSuspensionState: 'issue|callback|' })];
    expect(run(confirmed, [sosp('820005', 'cliente da richiamare il 20/11')]).list).toBe(confirmed);
  });

  it('non più sospesa, pratica intatta: torna in attesa senza data, la nostra riga si toglie', () => {
    const first = run([appt({ id: 'i3', periziaCode: '800003', notes: 'Scala B' })], [sosp('800003', 'cliente da richiamare il 20/11')]).list;
    const absent = run(first, [sosp('899999', 'x')]);
    expect(absent.list).toBe(first);
    const r = run(first, [{ codice: '800003', fase: 'da_fissare' }]);
    const a = byId(r.list, 'i3');
    expect('portalSuspension' in a).toBe(false);
    expect('portalSuspensionState' in a).toBe(false);
    expect(a).toMatchObject({ status: 'pending', notes: 'Scala B' });
    expect(a.issueType).toBeUndefined();
    expect(a.followUpDate).toBeUndefined();
    expect(r.cleared).toEqual(['i3']);
    expect(r.restored).toEqual(['i3']);
    // anche con un bridge vecchio (fase assente) se la pratica è nello snapshot
    expect(run(first, [{ codice: '800003' }]).restored).toEqual(['i3']);
    expect(run(r.list, [{ codice: '800003' }]).list).toBe(r.list);
    // senza altre note: note vuote
    const solo = run([appt({ id: 'i4', periziaCode: '800004' })], [sosp('800004', 'cliente disponibile solo dal 25/11')]).list;
    const back = byId(run(solo, [{ codice: '800004', fase: 'da_fissare' }]).list, 'i4');
    expect(back).toMatchObject({ status: 'pending' });
    expect(back.notes).toBeUndefined();
    expect(back.followUpDate).toBeUndefined();
  });

  it('non più sospesa, pratica toccata dall\'operatore: si tolgono solo impronta e stato dato', () => {
    const first = run([appt({ id: 'i5', periziaCode: '800005' })], [sosp('800005', 'cliente da richiamare')]).list;
    const operator = first.map(a => ({ ...a, status: 'standby' as const }));
    const r = run(operator, [{ codice: '800005', fase: 'da_fissare' }]);
    const a = byId(r.list, 'i5');
    expect('portalSuspension' in a).toBe(false);
    expect('portalSuspensionState' in a).toBe(false);
    expect(a).toMatchObject({ status: 'standby', issueType: 'callback', notes: 'Sospesa sul portale: cliente da richiamare' });
    expect(r.cleared).toEqual(['i5']);
    expect(r.restored).toEqual([]);
    // pratica di prima (solo impronta, senza stato dato): come prima
    const old = [appt({ id: 'i6', periziaCode: '800006', status: 'issue', issueType: 'callback', portalSuspension: 'x', notes: 'Sospesa sul portale: x' })];
    const r2 = run(old, [{ codice: '800006', fase: 'da_fissare' }]);
    expect(byId(r2.list, 'i6')).toMatchObject({ status: 'issue', notes: 'Sospesa sul portale: x' });
    expect(r2.restored).toEqual([]);
  });

  it('impronta: testo ripulito, "-" se vuota', () => {
    expect(suspensionFingerprint('  cliente   da richiamare ')).toBe('cliente da richiamare');
    expect(suspensionFingerprint('')).toBe('-');
    expect(suspensionFingerprint(undefined)).toBe('-');
  });
});

describe('testo del chip', () => {
  it('sospese e tolte dal portale', () => {
    const at = new Date(2026, 10, 14, 12, 15);
    expect(describeImport({ added: 4, updated: 0, failed: 0, suspended: 3 }, at)).toBe('4 nuove pratiche, 3 sospese sul portale alle 12:15');
    expect(describeImport({ added: 1, updated: 0, failed: 0, suspended: 1 }, at)).toBe('1 nuova pratica, 1 sospesa sul portale alle 12:15');
    expect(describeImport({ added: 0, updated: 0, failed: 0, removed: 1, removedPortal: 2 }, at))
      .toBe('1 tolta perché già nel gestionale, 2 tolte perché già fissate o chiuse sul portale alle 12:15');
    expect(describeImport({ added: 0, updated: 0, failed: 0, removedPortal: 1 }, at)).toBe('1 tolta perché già fissata o chiusa sul portale alle 12:15');
    expect(describeImport({ added: 0, updated: 0, failed: 0, suspended: 1, resumed: 2 }, at))
      .toBe('1 sospesa sul portale, 2 tornate in attesa (non più sospese) alle 12:15');
    expect(describeImport({ added: 0, updated: 0, failed: 0, resumed: 1 }, at)).toBe('1 tornata in attesa (non più sospesa) alle 12:15');
  });
});
