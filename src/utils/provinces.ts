// Province italiane: codice sigla -> nome. Usato per far combaciare la
// provincia rilevata (da Excel "Prov." o dal geocoding Nominatim) con le
// zone di competenza dei tecnici, comunque siano scritte ("MI" o "Milano").

export const PROVINCE_NAME_BY_CODE: Record<string, string> = {
  AG: 'Agrigento', AL: 'Alessandria', AN: 'Ancona', AO: 'Aosta', AR: 'Arezzo',
  AP: 'Ascoli Piceno', AT: 'Asti', AV: 'Avellino', BA: 'Bari',
  BT: 'Barletta-Andria-Trani', BL: 'Belluno', BN: 'Benevento', BG: 'Bergamo',
  BI: 'Biella', BO: 'Bologna', BZ: 'Bolzano', BS: 'Brescia', BR: 'Brindisi',
  CA: 'Cagliari', CL: 'Caltanissetta', CB: 'Campobasso', CE: 'Caserta',
  CT: 'Catania', CZ: 'Catanzaro', CH: 'Chieti', CO: 'Como', CS: 'Cosenza',
  CR: 'Cremona', KR: 'Crotone', CN: 'Cuneo', EN: 'Enna', FM: 'Fermo',
  FE: 'Ferrara', FI: 'Firenze', FG: 'Foggia', FC: 'Forlì-Cesena',
  FR: 'Frosinone', GE: 'Genova', GO: 'Gorizia', GR: 'Grosseto', IM: 'Imperia',
  IS: 'Isernia', SP: 'La Spezia', AQ: "L'Aquila", LT: 'Latina', LE: 'Lecce',
  LC: 'Lecco', LI: 'Livorno', LO: 'Lodi', LU: 'Lucca', MC: 'Macerata',
  MN: 'Mantova', MS: 'Massa-Carrara', MT: 'Matera', ME: 'Messina',
  MI: 'Milano', MO: 'Modena', MB: 'Monza e della Brianza', NA: 'Napoli',
  NO: 'Novara', NU: 'Nuoro', OR: 'Oristano', PD: 'Padova', PA: 'Palermo',
  PR: 'Parma', PV: 'Pavia', PG: 'Perugia', PU: 'Pesaro e Urbino',
  PE: 'Pescara', PC: 'Piacenza', PI: 'Pisa', PT: 'Pistoia', PN: 'Pordenone',
  PZ: 'Potenza', PO: 'Prato', RG: 'Ragusa', RA: 'Ravenna',
  RC: 'Reggio Calabria', RE: 'Reggio Emilia', RI: 'Rieti', RN: 'Rimini',
  RM: 'Roma', RO: 'Rovigo', SA: 'Salerno', SS: 'Sassari', SV: 'Savona',
  SI: 'Siena', SR: 'Siracusa', SO: 'Sondrio', SU: 'Sud Sardegna',
  TA: 'Taranto', TE: 'Teramo', TR: 'Terni', TO: 'Torino', TP: 'Trapani',
  TN: 'Trento', TV: 'Treviso', TS: 'Trieste', UD: 'Udine', VA: 'Varese',
  VE: 'Venezia', VB: 'Verbano-Cusio-Ossola', VC: 'Vercelli', VR: 'Verona',
  VV: 'Vibo Valentia', VI: 'Vicenza', VT: 'Viterbo',
};

const stripAccents = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const cleanName = (s: string): string =>
  stripAccents(s)
    .toUpperCase()
    .replace(/[^A-Z]/g, ''); // "Forlì-Cesena" -> "FORLICESENA", "L'Aquila" -> "LAQUILA"

const CODE_BY_CLEAN_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(PROVINCE_NAME_BY_CODE).map(([code, name]) => [cleanName(name), code])
);
// Alias comuni restituiti da Nominatim o scritti a mano
CODE_BY_CLEAN_NAME[cleanName('Monza e Brianza')] = 'MB';
CODE_BY_CLEAN_NAME[cleanName('Reggio nell\'Emilia')] = 'RE';
CODE_BY_CLEAN_NAME[cleanName('Reggio di Calabria')] = 'RC';
CODE_BY_CLEAN_NAME[cleanName('Massa e Carrara')] = 'MS';
CODE_BY_CLEAN_NAME[cleanName('Aoste')] = 'AO';
CODE_BY_CLEAN_NAME[cleanName('Bolzano - Bozen')] = 'BZ';

// Normalizza qualunque scrittura ("IT-MI", "mi", "Milano",
// "Città metropolitana di Milano", "Provincia di Pavia") nella sigla ("MI").
// Se non riconosciuta, restituisce il testo ripulito in maiuscolo (consente
// comunque il confronto per uguaglianza).
export const provinceToCode = (raw?: string | null): string | undefined => {
  if (!raw) return undefined;
  let s = String(raw).trim();
  if (!s) return undefined;

  const iso = s.match(/^IT[-_ ]([A-Za-z]{2})$/);
  if (iso) return iso[1].toUpperCase();

  s = s.replace(
    /^(citt[aà] metropolitana di|provincia (autonoma )?(di|del|della|dell')|libero consorzio comunale di)\s*/i,
    ''
  ).trim();

  if (/^[A-Za-z]{2}$/.test(s)) {
    const code = s.toUpperCase();
    if (PROVINCE_NAME_BY_CODE[code]) return code;
  }

  const byName = CODE_BY_CLEAN_NAME[cleanName(s)];
  if (byName) return byName;

  return stripAccents(s).toUpperCase();
};

// Etichetta leggibile: "MI" -> "Milano (MI)", testo sconosciuto invariato.
export const provinceLabel = (raw?: string | null): string => {
  const code = provinceToCode(raw);
  if (!code) return '';
  const name = PROVINCE_NAME_BY_CODE[code];
  return name ? `${name} (${code})` : code;
};

// Confronto: la provincia dell'appuntamento rientra tra quelle del tecnico?
export const provinceMatches = (
  apptProvince: string | undefined,
  technicianProvinces: string[]
): boolean => {
  const code = provinceToCode(apptProvince);
  if (!code) return false;
  return technicianProvinces.some(p => provinceToCode(p) === code);
};
