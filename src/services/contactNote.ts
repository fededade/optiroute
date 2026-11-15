import type { Appointment } from '../types';
import { normalizePhone } from '../utils/phone';
import type { BridgePratica } from './bridgeService';
import { isCallInFlight } from './autopilotService';
import { codeKey, praticaKey } from './praticaCode';

// Chi chiamare, e a quale numero, secondo la nota di contatto della pratica.
//
// Le pratiche del portale portano nelle note la «nota del gestore» della
// banca (dal bridge: "progetto | rif. gestore | Contatto Prelios: <nota>").
// Forma tipica: "Nome Cognome - 00393331234567 - eventuali istruzioni", con
// varianti: +39/0039, numeri a gruppi, "TEL:"/"CELL", più numeri nella stessa
// nota, testo tutto maiuscolo. Spesso la persona da chiamare NON è il cliente
// ma, per esempio, l'agente immobiliare: qui si legge di chi è ogni numero e
// quale chiamare. Nel dubbio non si inventa niente: si chiama l'intestatario.
//
// Funzioni PURE (nessuno stato, nessuna rete): le usano l'import delle
// pratiche nuove, l'aggiornamento di quelle già presenti e le pratiche di prova.

// Segnaposto quando non si conosce il nome del referente (la chiamata lo
// riconosce e non lo pronuncia): è lo stesso del pilota automatico
export const REFERENTE_SENZA_NOME = 'Referente indicato dal cliente';

// Lunghezza massima della nota di contatto nelle note (bridge: componi_note)
const NOTA_MAX = 200;

export type NumeroDi = 'cliente' | 'terzo' | 'ignoto';

export interface NumeroNota {
  numero: string;            // +39...
  tipo: 'mobile' | 'fisso';
  posizione: number;         // inizio nel testo della nota
  fine: number;              // fine nel testo della nota
  etichetta: string;         // testo che accompagna il numero (ripulito)
  esplicito: boolean;        // l'etichetta dice di chiamare questo numero
  di: NumeroDi;              // di chi è il numero
  nome?: string;             // nome della terza persona ("Luca Bianchi")
  ruolo?: string;            // ruolo della terza persona ("agente immobiliare")
}

export interface LetturaNotaContatto {
  testo: string;             // nota di contatto letta ('' se non c'è)
  impronta?: string;         // impronta da salvare sulla pratica (assente se la nota è vuota)
  numeri: NumeroNota[];      // tutti i numeri, nell'ordine del testo
  scelto?: NumeroNota;       // il numero da chiamare secondo la nota
  phone?: string;            // numero da usare, SOLO se diverso da quello attuale
  contactPerson?: string;    // solo se il numero scelto è di una terza persona
  referredBy?: string;       // per conto di chi (l'intestatario, se è un nome)
}

// --- Testo ---

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Nota di contatto: dopo "Contatto Prelios:" fino al prossimo " | " (o alla
// fine); senza quella dicitura, tutte le note
export const contactNoteText = (notes: string | undefined): string => {
  const all = (notes || '').replace(/\s+/g, ' ').trim();
  const m = /Contatto Prelios:\s*(.*?)(?=\s\|\s|$)/i.exec(all);
  return (m ? m[1] : all).trim();
};

// --- Numeri (stesse regole del bridge: prelios-bridge/contact_parse.py) ---

// Cellulari: 3xx + 6/7 cifre, separatori facoltativi, prefisso +39/0039 facoltativo
const RE_MOBILE = /(?<![\p{L}\p{N}_+])(?:(?:\+|00)39[\s.]?)?3\d{2}(?:[\s./-]?\d{3}){2}\d?(?![\p{L}\p{N}_])/gu;
// Fissi: 0 + prefisso, prefisso internazionale facoltativo
const RE_FISSO = /(?<![\p{L}\p{N}_+])(?:(?:\+|00)39[\s.]?)?0\d{1,3}[\s./-]?\d{5,8}(?![\p{L}\p{N}_])/gu;

const normalizzaNumero = (raw: string): string => {
  let n = raw.replace(/[\s./-]/g, '');
  if (n.startsWith('0039')) n = `+39${n.slice(4)}`;
  else if (!n.startsWith('+')) n = `+39${n}`;
  return n;
};

interface NumeroGrezzo { numero: string; tipo: 'mobile' | 'fisso'; posizione: number; fine: number }

// Tutti i numeri di un testo, una volta sola (sul numero normalizzato),
// nell'ordine in cui compaiono. Con `tagliato` (nota arrivata già accorciata)
// un numero che finisce proprio alla fine del testo può essere monco: si scarta.
export const numeriNelTesto = (testo: string, tagliato = false): NumeroGrezzo[] => {
  const trovati: NumeroGrezzo[] = [];
  for (const [re, tipo] of [[RE_MOBILE, 'mobile'], [RE_FISSO, 'fisso']] as const) {
    re.lastIndex = 0;
    for (const m of testo.matchAll(re)) {
      const posizione = m.index ?? 0;
      const fine = posizione + m[0].length;
      if (tagliato && fine >= testo.length) continue;
      // un fisso che si sovrappone a un cellulare già trovato non conta
      if (trovati.some(t => posizione < t.fine && fine > t.posizione)) continue;
      trovati.push({ numero: normalizzaNumero(m[0]), tipo, posizione, fine });
    }
  }
  trovati.sort((a, b) => a.posizione - b.posizione);
  const visti = new Set<string>();
  return trovati.filter(t => (visti.has(t.numero) ? false : (visti.add(t.numero), true)));
};

// --- Etichette ---

const SEPARATORI = /^[\s\-–—:,.;/|()[\]]+|[\s\-–—:,;/|([]+$/g;
const CODA_ETICHETTA = /(?:\b(?:tel(?:efono)?|cell(?:ulare)?|num(?:ero)?|n|nr)\b\.?\s*:?\s*)+$/i;

const pulisciEtichetta = (s: string): string => {
  let t = s.replace(/\s+/g, ' ').replace(SEPARATORI, '');
  for (let i = 0; i < 3; i++) t = t.replace(CODA_ETICHETTA, '').replace(SEPARATORI, '');
  return t.trim();
};

// Separatore fra due parti della nota ("Nome - numero - istruzioni")
const SEPARATORE_PARTI = /\s+[-–—]+\s*|\s*[-–—]+\s+|[;|/]/;

// --- Parole ---

// Indicazione esplicita di chi chiamare
const ESPLICITO = /\b(contattare|contattate|contatta|contattarlo|contattarla|chiamare|chiamate|chiama|chiamarlo|chiamarla|telefonare|sentire|sentite|rivolgersi|rivolgetevi|referente|chiavi)\b|\bper\s+(?:il\s+|l\s*'\s*|l\s+)?(sopralluogo|appuntamento|accesso)\b|\bc\s*\/\s*o\b|\bcxo\b/;

// Parole che indicano il cliente stesso
const PAROLE_CLIENTE = /\b(cliente|mutuatario|mutuataria|richiedente|intestatario|intestataria|acquirente)\b/;

// Titoli che precedono il nome di una persona
const TITOLI = new Set([
  'sig', 'sigg', 'ra', 'na', 'signor', 'signore', 'signora', 'signorina', 'dott', 'ssa', 'dottor', 'dottore',
  'dottoressa', 'dr', 'dssa', 'prof', 'rag',
]);

// Ruoli (parola, già senza accenti e minuscola -> ruolo da scrivere)
const RUOLI: Record<string, string> = {
  agente: 'agente immobiliare',
  geometra: 'geometra', geom: 'geometra',
  architetto: 'architetto', arch: 'architetto',
  ingegnere: 'ingegnere', ing: 'ingegnere',
  tecnico: 'tecnico',
  amministratore: 'amministratore', amministratrice: 'amministratrice',
  custode: 'custode',
  portiere: 'portiere', portineria: 'portiere', portinaio: 'portiere',
  venditore: 'venditore', venditrice: 'venditrice',
  proprietario: 'proprietario', proprietaria: 'proprietaria',
  costruttore: 'costruttore', impresa: 'impresa',
  notaio: 'notaio',
  avvocato: 'avvocato', avv: 'avvocato',
  inquilino: 'inquilino', inquilina: 'inquilina', conduttore: 'conduttore', conduttrice: 'conduttrice',
  affittuario: 'affittuario', affittuaria: 'affittuaria',
  figlio: 'figlio', figlia: 'figlia', moglie: 'moglie', marito: 'marito', padre: 'padre', madre: 'madre',
  fratello: 'fratello', sorella: 'sorella', compagno: 'compagno', compagna: 'compagna', coniuge: 'coniuge',
  nipote: 'nipote', genero: 'genero', nuora: 'nuora', cognato: 'cognato', cognata: 'cognata',
  delegato: 'delegato', delegata: 'delegata',
  referente: 'referente',
  segretaria: 'segretaria',
  collega: 'collega',
};

// Parole dell'agenzia (il nome dell'agenzia le segue)
const PAROLE_AGENZIA = new Set(['agenzia', 'immobiliare']);
// "ag. imm." = agente immobiliare
const ABBREVIAZIONI_AGENTE = new Set(['ag', 'imm']);

// Parole comuni che non sono mai un nome di persona
const NON_NOMI = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'l', 'un', 'una', 'uno', 'di', 'del', 'dello', 'della', 'dei', 'degli', 'delle',
  'da', 'dal', 'dallo', 'dalla', 'dai', 'dalle', 'in', 'nel', 'nella', 'con', 'col', 'su', 'sul', 'sulla', 'per',
  'tra', 'fra', 'a', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'e', 'ed', 'o', 'od', 'oppure', 'anche', 'se', 'ma',
  'non', 'si', 'solo', 'sempre', 'gia', 'ancora', 'ore', 'h', 'dopo', 'prima', 'entro', 'verso', 'circa', 'mattina',
  'mattino', 'pomeriggio', 'sera', 'serale', 'serali', 'giorno', 'giorni', 'oggi', 'domani', 'lunedi', 'martedi',
  'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica', 'feriali', 'festivi', 'orario', 'orari', 'ufficio',
  'lavoro', 'casa', 'fisso', 'cell', 'cellulare', 'tel', 'telefono', 'telefonico', 'numero', 'num', 'n', 'nr',
  'whatsapp', 'wa', 'sms', 'mail', 'email', 'pec', 'disponibile', 'disponibili', 'disponibilita', 'reperibile',
  'reperibili', 'risponde', 'rispondere', 'contattare', 'contattate', 'contatta', 'contattarlo', 'contattarla',
  'chiamare', 'chiamate', 'chiama', 'chiamarlo', 'chiamarla', 'telefonare', 'sentire', 'sentite', 'rivolgersi',
  'rivolgetevi', 'riferimento', 'rif', 'sopralluogo', 'appuntamento', 'accesso', 'chiavi', 'presso', 'c', 'note',
  'nota', 'urgente', 'urgenza', 'perizia', 'pratica', 'immobile', 'appartamento', 'villa', 'box', 'cantina',
  'cliente', 'mutuatario', 'mutuataria', 'richiedente', 'intestatario', 'intestataria', 'acquirente', 'parte',
  'mutuo', 'banca', 'gestore', 'filiale', 'intesa', 'prelios', 'ok', 'grazie', 'info', 'altro', 'altra', 'altri',
  'secondo', 'primo', 'piano', 'interno', 'scala', 'citofono', 'via', 'viale', 'piazza', 'piazzale', 'corso',
  'vicolo', 'strada', 'largo', 'localita', 'loc', 'frazione', 'fraz', 'studio', 'condominio', 'chiedere', 'chiedi',
  'avvisare', 'preavviso', 'possibile', 'preferibilmente', 'meglio', 'max', 'min', 'tutti', 'tutto', 'tutte',
  'suo', 'sua', 'loro', 'lui', 'lei', 'nostro', 'vostro', 'che', 'chi', 'come', 'quando', 'dove', 'nome',
  'cognome', 'tramite', 'fino', 'ogni', 'nessuno', 'nessuna', 'italia', 'estero',
  // verbi e parole tipiche delle note: il nome si ferma qui ("SIG. NERI PREFERISCE WHATSAPP")
  'preferisce', 'chiede', 'lavora', 'abita', 'attende', 'aspetta', 'richiama', 'richiamare', 'vuole', 'puo',
  'serata', 'messaggio', 'presente', 'assente', 'libero', 'libera',
]);

// Un nome di persona ha al massimo tre parole
const MAX_PAROLE_NOME = 3;

// Parole tipiche delle insegne delle agenzie ("AG. IMM. CASA FACILE")
const PAROLE_INSEGNA = new Set([
  'casa', 'case', 'immobiliare', 'immobili', 'tecnocasa', 'tempocasa', 'gabetti', 'remax', 'toscano',
  'professionecasa', 'studio', 'gruppo', 'home', 'house', 'real', 'estate', 'servizi', 'srl', 'sas', 'snc',
  'agency', 'group', 'point',
]);
const isParolaInsegna = (p: string): boolean => PAROLE_INSEGNA.has(p) || p.startsWith('immobil');

// Sigle e parole dei codici di pratica: "Rif: ISP 845.326" non è un contatto
const SIGLE_PRATICA = new Set(['isp', 'misi', 'cer', 'cerved', 'prelios', 'intesa', 'pratica', 'perizia', 'codice', 'cod', 'n', 'nr', 'num', 'numero', 'pos']);

interface Token { testo: string; parola: string; maiuscola: boolean; separatore: boolean }

const tokens = (s: string): Token[] => {
  const out: Token[] = [];
  for (const m of s.matchAll(/(\p{L}+(?:['’]\p{L}+)*)|([^\s\p{L}])/gu)) {
    if (m[1]) {
      const w = m[1];
      out.push({ testo: w, parola: fold(w).replace(/’/g, "'"), maiuscola: /^\p{Lu}/u.test(w), separatore: false });
    } else {
      out.push({ testo: m[2], parola: m[2], maiuscola: false, separatore: m[2] !== '.' && m[2] !== "'" });
    }
  }
  return out;
};

const isMarcatore = (p: string): boolean =>
  TITOLI.has(p) || p in RUOLI || PAROLE_AGENZIA.has(p) || ABBREVIAZIONI_AGENTE.has(p);

// Parola che può far parte di un nome di persona: solo lettere, almeno due,
// con l'iniziale maiuscola (o testo tutto maiuscolo), non comune né un ruolo
const isParolaNome = (t: Token): boolean =>
  !t.separatore && t.parola.length >= 2 && /^\p{L}/u.test(t.testo) && t.maiuscola &&
  !NON_NOMI.has(t.parola) && !isMarcatore(t.parola);

interface Gruppo { parole: Token[]; dopo?: string } // `dopo`: parola marcatore subito prima

// Sequenze di parole-nome consecutive, con la parola marcatore che le precede
const gruppiNome = (toks: Token[], anyCase = false): Gruppo[] => {
  const gruppi: Gruppo[] = [];
  let cur: Gruppo | null = null;
  let ultimoMarcatore: string | undefined;
  for (const t of toks) {
    if (isParolaNome(anyCase ? { ...t, maiuscola: true } : t)) {
      if (!cur) { cur = { parole: [], dopo: ultimoMarcatore }; gruppi.push(cur); }
      cur.parole.push(t);
      continue;
    }
    cur = null;
    if (t.testo === '.' || t.testo === "'") continue; // "sig." / "dell'agente": il marcatore resta valido
    ultimoMarcatore = !t.separatore && isMarcatore(t.parola) ? t.parola : undefined;
  }
  return gruppi;
};

// "LUCA d'angelo" -> "Luca D'Angelo"
const iniziali = (parole: Token[]): string =>
  parole
    .map(p => p.testo.toLowerCase().replace(/(^|['’-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()))
    .join(' ');

const paroleDi = (s: string): string[] => fold(s).split(/[^a-z']+/).filter(w => w.length >= 2);

// Parole comuni ammesse nel nome di un'agenzia ("Agenzia Casa Facile")
const AMMESSE_IN_AGENZIA = new Set(['casa', 'studio', 'piazza', 'corso']);

// Nome dell'agenzia: fino a 4 parole con l'iniziale maiuscola subito dopo
// "agenzia" / "immobiliare" (senza titoli, ruoli e parole comuni)
const nomeDellAgenzia = (toks: Token[]): Token[] => {
  const i = toks.findIndex(t => !t.separatore && PAROLE_AGENZIA.has(t.parola));
  if (i < 0) return [];
  const nome: Token[] = [];
  for (let j = i + 1; j < toks.length && nome.length < 4; j++) {
    const t = toks[j];
    if (nome.length === 0 && (PAROLE_AGENZIA.has(t.parola) || t.testo === '.')) continue;
    if (t.separatore || t.testo === '.') break;
    const ok = t.maiuscola && t.parola.length >= 2 && !isMarcatore(t.parola) &&
      (!NON_NOMI.has(t.parola) || AMMESSE_IN_AGENZIA.has(t.parola));
    if (!ok) break;
    nome.push(t);
  }
  return nome;
};

// Parole subito dopo "ag. imm." / "agente" (fino a 4), se non c'è un titolo
// davanti: candidate a essere l'insegna dell'agenzia
const insegnaDopoAgente = (toks: Token[]): Token[] => {
  const parole = toks.map((t, i) => ({ t, i })).filter(x => !x.t.separatore && x.t.testo !== '.' && x.t.testo !== "'");
  let start = -1;
  for (let k = 0; k < parole.length; k++) {
    const p = parole[k].t.parola;
    if (p === 'ag' && parole[k + 1]?.t.parola === 'imm') { start = parole[k + 1].i + 1; break; }
    if (p === 'agente') { start = parole[k].i + 1; if (parole[k + 1]?.t.parola === 'immobiliare') start = parole[k + 1].i + 1; break; }
  }
  if (start < 0) return [];
  const nome: Token[] = [];
  for (let j = start; j < toks.length && nome.length < 4; j++) {
    const t = toks[j];
    if (t.testo === '.' || t.testo === "'") { if (nome.length === 0) continue; break; }
    if (t.separatore) break;
    if (TITOLI.has(t.parola)) { if (nome.length === 0) return []; break; } // "AG. IMM. SIG. BIANCHI": una persona
    const ok = t.maiuscola && t.parola.length >= 2 &&
      (isParolaInsegna(t.parola) || (!NON_NOMI.has(t.parola) && !isMarcatore(t.parola)));
    if (!ok) break;
    nome.push(t);
  }
  return nome;
};

// "rif." / "riferimento" valgono come indicazione di contatto solo se seguiti
// da un ruolo o da un nome, non da una sigla o da un codice ("Rif: ISP 845.326")
const rifVersoPersona = (etichetta: string): boolean => {
  const toks = tokens(etichetta);
  const tuttoMaiuscolo = etichetta === etichetta.toUpperCase();
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].separatore || (toks[i].parola !== 'rif' && toks[i].parola !== 'riferimento')) continue;
    let j = i + 1;
    while (j < toks.length && (toks[j].testo === '.' || toks[j].testo === ':')) j++;
    const t = toks[j];
    if (!t || t.separatore) continue;
    if (TITOLI.has(t.parola) || t.parola in RUOLI || PAROLE_AGENZIA.has(t.parola) || ABBREVIAZIONI_AGENTE.has(t.parola)) return true;
    const sigla = SIGLE_PRATICA.has(t.parola) || (!tuttoMaiuscolo && t.testo === t.testo.toUpperCase() && t.testo.length <= 5);
    if (!sigla && isParolaNome(t)) return true;
  }
  return false;
};

// --- Di chi è un numero ---

interface Classificazione { di: NumeroDi; nome?: string; ruolo?: string }

const classifica = (etichetta: string, intestatario: string): Classificazione => {
  if (!etichetta) return { di: 'ignoto' };
  const testo = fold(etichetta);
  const toks = tokens(etichetta.replace(/\b(re)-(max)\b/gi, '$1$2'));
  const gruppi = gruppiNome(toks).filter(g => g.parole.length >= 1);
  const delCliente = new Set(paroleDi(intestatario));
  const sottoinsieme = (g: Gruppo) => g.parole.every(p => delCliente.has(p.parola));
  const uguale = (g: Gruppo) =>
    g.parole.length >= 2 && sottoinsieme(g) && new Set(g.parole.map(p => p.parola)).size === delCliente.size;

  // Ruolo: il primo che compare nell'etichetta
  let ruolo: string | undefined;
  let agenzia = false;
  const parole = toks.filter(t => !t.separatore && t.testo !== '.' && t.testo !== "'").map(t => t.parola);
  for (let i = 0; i < parole.length; i++) {
    const p = parole[i];
    if (p === 'ag' && parole[i + 1] === 'imm') { ruolo = 'agente immobiliare'; break; }
    if (p === 'agenzia') { agenzia = true; break; }
    if (p === 'immobiliare' && parole[i - 1] !== 'agente' && parole[i - 1] !== 'imm') { agenzia = true; break; }
    if (p === 'parte' && parole[i + 1] === 'venditrice') { ruolo = 'parte venditrice'; break; }
    if (p in RUOLI) { ruolo = RUOLI[p]; break; }
  }

  // Dopo "ag. imm." / "agente" senza un titolo: se le parole che seguono sono
  // un'insegna (parole tipiche o più di due parole) è il nome dell'agenzia,
  // non di una persona ("AG. IMM. CASA FACILE")
  if (ruolo === 'agente immobiliare') {
    const insegna = insegnaDopoAgente(toks);
    if (insegna.length > 0 && (insegna.length > 2 || insegna.some(t => isParolaInsegna(t.parola)))) {
      ruolo = `agenzia immobiliare ${iniziali(insegna)}`;
      const gruppiPersona = gruppi.filter(g => !g.parole.some(p => insegna.includes(p)));
      if (gruppiPersona.some(uguale)) return { di: 'cliente' };
      const g = gruppiPersona.find(x => x.dopo && TITOLI.has(x.dopo));
      return { di: 'terzo', ruolo, ...(g && g.parole.length <= MAX_PAROLE_NOME ? { nome: iniziali(g.parole) } : {}) };
    }
  }

  let gruppiPersona = gruppi;
  if (agenzia) {
    const nomeAgenzia = nomeDellAgenzia(toks);
    ruolo = `agenzia immobiliare${nomeAgenzia.length > 0 ? ` ${iniziali(nomeAgenzia)}` : ''}`;
    // le parole del nome dell'agenzia non sono il nome di una persona
    gruppiPersona = gruppi.filter(g => !g.parole.some(p => nomeAgenzia.includes(p)));
  }
  const conTitolo = gruppiPersona.find(g => g.dopo && (TITOLI.has(g.dopo) || g.dopo in RUOLI || ABBREVIAZIONI_AGENTE.has(g.dopo)));
  const valido = (g?: Gruppo) => (g && g.parole.length <= MAX_PAROLE_NOME ? g : undefined);

  if (ruolo) {
    // Con un ruolo è il cliente solo se c'è il suo nome completo ("MARIO ROSSI PROPRIETARIO")
    if (gruppiPersona.some(uguale)) return { di: 'cliente' };
    const g = valido(conTitolo) || (agenzia ? undefined : valido(gruppiPersona[0]));
    return { di: 'terzo', ruolo, ...(g ? { nome: iniziali(g.parole) } : {}) };
  }
  // Senza ruolo: il nome dell'intestatario (anche solo il cognome, anche
  // scritto in minuscolo) = cliente
  if (gruppiNome(toks, true).some(sottoinsieme)) return { di: 'cliente' };
  if (PAROLE_CLIENTE.test(testo)) return { di: 'cliente' };
  // Nome dopo un titolo ("sig. Bianchi"), oppure nome e cognome (2-4 parole)
  const g = valido(conTitolo) || gruppi.find(x => x.parole.length >= 2 && x.parole.length <= MAX_PAROLE_NOME);
  if (g) return { di: 'terzo', nome: iniziali(g.parole) };
  return { di: 'ignoto' };
};

// --- Lettura della nota ---

const PAROLE_INDIRIZZO = /^(via|viale|v\.le|piazza|p\.zza|piazzale|corso|c\.so|vicolo|strada|str\.|largo|localit[aà]|loc\.|frazione|fraz\.)\s/i;

// L'intestatario è un nome di persona (e non via e civico, come quando manca)?
export const isNomeIntestatario = (s: string | undefined): boolean => {
  const t = (s || '').trim();
  return !!t && !/\d/.test(t) && !PAROLE_INDIRIZZO.test(`${t} `) && /\p{L}{2}/u.test(t);
};

// "Nome — ruolo", solo "Nome", oppure "Referente indicato dal cliente — ruolo"
export const formatContactPerson = (nome?: string, ruolo?: string): string | undefined => {
  const n = (nome || '').replace(/\s+/g, ' ').trim();
  const r = (ruolo || '').replace(/\s+/g, ' ').trim();
  if (!n && !r) return undefined;
  if (!n) return r.toLowerCase() === 'referente' ? REFERENTE_SENZA_NOME : `${REFERENTE_SENZA_NOME} — ${r}`;
  return r ? `${n} — ${r}` : n;
};

// Il contrario (per la finestra della pratica): nome e ruolo del referente.
// Il segnaposto vale come "nessun nome".
export const splitContactPerson = (cp: string | undefined): { nome: string; ruolo: string } => {
  const t = (cp || '').trim();
  if (!t) return { nome: '', ruolo: '' };
  const i = t.search(/\s+[—–]\s+/);
  const nome = (i < 0 ? t : t.slice(0, i)).trim();
  const ruolo = i < 0 ? '' : t.slice(i).replace(/^\s+[—–]\s+/, '').trim();
  return { nome: nome === REFERENTE_SENZA_NOME ? '' : nome, ruolo };
};

const stessoNumero = (a: string | undefined, b: string | undefined): boolean => {
  const na = a ? normalizePhone(a) : null;
  const nb = b ? normalizePhone(b) : null;
  return !!na && na === nb;
};

// Legge la nota di contatto: date le note della pratica, l'intestatario e il
// telefono attuale, dice chi chiamare e a quale numero.
export const readContactNote = (
  notes: string | undefined,
  intestatario: string | undefined,
  telefonoAttuale?: string
): LetturaNotaContatto => {
  const testo = contactNoteText(notes);
  if (!testo) return { testo: '', numeri: [] };
  const grezzi = numeriNelTesto(testo, testo.length >= NOTA_MAX);
  const holder = (intestatario || '').trim();

  const numeri: NumeroNota[] = grezzi.map((g, i) => {
    const inizio = i === 0 ? 0 : grezzi[i - 1].fine;
    const prima = testo.slice(inizio, g.posizione);
    let etichetta = pulisciEtichetta(prima);
    if (!etichetta) {
      // Etichetta dopo il numero ("333 1234567 Mario Rossi"), fino al numero
      // o al separatore successivo
      const fino = i + 1 < grezzi.length ? grezzi[i + 1].posizione : testo.length;
      const dopo = testo.slice(g.fine, fino).replace(/^[\s\-–—:,.;/|()]+/, '');
      const sep = dopo.search(SEPARATORE_PARTI);
      etichetta = pulisciEtichetta(sep < 0 ? dopo : dopo.slice(0, sep));
    }
    // Dal secondo numero in poi, la prima parte dell'etichetta può essere
    // l'istruzione del numero precedente ("... - CHIAMARE DOPO LE 18 - AG. IMM.
    // BIANCHI - 335..."): l'indicazione esplicita si cerca nelle parti dopo
    // ("c/o" non è un separatore)
    const parti = etichetta.replace(/\bc\s*\/\s*o\b/gi, 'cxo').split(SEPARATORE_PARTI).map(s => s.trim()).filter(Boolean);
    const perEsplicito = i > 0 && parti.length >= 2 ? parti.slice(1).join(' - ') : etichetta;
    const c = classifica(etichetta, holder);
    return {
      ...g,
      etichetta,
      esplicito: ESPLICITO.test(fold(perEsplicito)) || rifVersoPersona(perEsplicito),
      di: c.di,
      ...(c.nome ? { nome: c.nome } : {}),
      ...(c.ruolo ? { ruolo: c.ruolo } : {}),
    };
  });

  // Senza numeri non c'è niente da leggere (né impronta da salvare)
  if (numeri.length === 0) return { testo, numeri };
  const base: LetturaNotaContatto = { testo, impronta: testo.slice(0, NOTA_MAX), numeri };

  // Quale numero chiamare
  const attuale = (telefonoAttuale || '').trim();
  let scelto = numeri.find(n => n.esplicito);
  if (!scelto && attuale) scelto = numeri.find(n => stessoNumero(n.numero, attuale));
  if (!scelto && !attuale) scelto = numeri.find(n => n.tipo === 'mobile') || numeri[0];
  // Numero attuale non scritto nella nota e nessuna indicazione: viene da un
  // altro campo del portale (è del cliente), non si cambia niente
  if (!scelto) return base;

  const out: LetturaNotaContatto = { ...base, scelto };
  if (!stessoNumero(scelto.numero, attuale)) out.phone = scelto.numero;
  if (scelto.di === 'terzo') {
    const cp = formatContactPerson(scelto.nome, scelto.ruolo);
    if (cp) {
      out.contactPerson = cp;
      if (isNomeIntestatario(holder)) out.referredBy = holder;
    }
  }
  return out;
};

// Pratica NUOVA: telefono, referente e impronta della nota dal servizio
export const withContactFromNote = <T extends { title: string; phone?: string; notes?: string; contactPerson?: string; referredBy?: string; contactNote?: string }>(a: T): T => {
  const r = readContactNote(a.notes, a.title, a.phone);
  if (!r.impronta) return a;
  // Referente già scritto (es. a mano): si salva solo l'impronta
  if (a.contactPerson) return { ...a, contactNote: r.impronta };
  return {
    ...a,
    contactNote: r.impronta,
    ...(r.phone ? { phone: r.phone } : {}),
    ...(r.contactPerson ? { contactPerson: r.contactPerson } : {}),
    ...(r.referredBy ? { referredBy: r.referredBy } : {}),
  };
};

// --- Pratiche GIÀ PRESENTI, quando arriva lo snapshot del bridge ---

export interface ContactUpdate { id: string; changes: Partial<Appointment> }

// Cosa cambiare sulle pratiche già presenti secondo la nota di contatto dello
// snapshot. Si tocca una pratica solo se:
//  - non è confermata né annullata e non ha una chiamata in corso;
//  - non ha già un referente (scritto a mano, dal pilota o da una lettura precedente);
//  - la nota è cambiata rispetto a quella già letta (impronta `contactNote`):
//    se l'operatore ha tolto o cambiato il referente, resta così finché la
//    nota sul portale non cambia;
//  - il numero da chiamare si può usare: il telefono si cambia solo se quello
//    attuale è vuoto o è uno dei numeri scritti nella nota (un numero
//    corretto a mano non si tocca mai, e allora non si mette nemmeno il referente).
// L'impronta si salva solo insieme a una modifica: rileggere una nota che non
// cambia niente non tocca la pratica (stesso snapshot due volte = nessuna modifica).
export const contactUpdateFor = (a: Appointment, p: Pick<BridgePratica, 'note' | 'telefono' | 'intestatario'>, now: Date): Partial<Appointment> | null => {
  if (a.status === 'confirmed' || a.status === 'cancelled') return null;
  if (isCallInFlight(a, now)) return null;
  if (a.contactPerson?.trim()) return null;
  const attuale = a.phone?.trim() || '';
  // Telefono vuoto: quello che il bridge ha scelto sta arrivando (aggiornamento del telefono)
  const lettura = readContactNote(p.note, a.title || p.intestatario, attuale || p.telefono?.trim() || '');
  if (!lettura.impronta || !lettura.scelto) return null;
  if (a.contactNote === lettura.impronta) return null;
  const nuovo = lettura.phone || (attuale ? undefined : lettura.scelto.numero);
  if (nuovo && attuale && !lettura.numeri.some(n => stessoNumero(n.numero, attuale))) return null;
  const changes: Partial<Appointment> = {};
  if (nuovo && !stessoNumero(nuovo, attuale)) changes.phone = nuovo;
  if (lettura.contactPerson) {
    changes.contactPerson = lettura.contactPerson;
    if (lettura.referredBy && !a.referredBy) changes.referredBy = lettura.referredBy;
  }
  if (Object.keys(changes).length === 0) return null;
  return { ...changes, contactNote: lettura.impronta };
};

// Per ogni pratica dello snapshot già presente (stesso codice), le modifiche
// dalla nota di contatto
export const bridgeContactUpdates = (
  pratiche: Pick<BridgePratica, 'codice' | 'note' | 'telefono' | 'intestatario'>[],
  appointments: Appointment[],
  now: Date = new Date()
): ContactUpdate[] => {
  const byCode = new Map<string, Appointment>();
  for (const a of appointments) {
    const key = praticaKey(a);
    if (key && !byCode.has(key)) byCode.set(key, a);
  }
  const out: ContactUpdate[] = [];
  const seen = new Set<string>();
  for (const p of pratiche) {
    const key = codeKey(p.codice?.trim());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const a = byCode.get(key);
    if (!a) continue;
    const changes = contactUpdateFor(a, p, now);
    if (changes) out.push({ id: a.id, changes });
  }
  return out;
};

// Applica le modifiche all'elenco di ADESSO (le condizioni si ricontrollano
// sulle pratiche attuali). Le pratiche non toccate restano gli stessi oggetti.
export const applyBridgeContacts = (
  list: Appointment[],
  pratiche: Pick<BridgePratica, 'codice' | 'note' | 'telefono' | 'intestatario'>[],
  now: Date = new Date()
): { list: Appointment[]; applied: string[] } => {
  const updates = bridgeContactUpdates(pratiche, list, now);
  if (updates.length === 0) return { list, applied: [] };
  const byId = new Map(updates.map(u => [u.id, u.changes]));
  return {
    list: list.map(a => (byId.has(a.id) ? { ...a, ...byId.get(a.id) } : a)),
    applied: updates.map(u => u.id),
  };
};
