// Fuso orario del motore. DEVE essere il primo modulo valutato dai bundle
// (gli entry lo importano per primo): i riduttori del pilota ragionano in ora
// LOCALE (`now.getHours()`, `new Date(y, m, d, h, min)`) e su Vercel il
// processo gira in UTC. Da Node 13 l'assegnazione a runtime di TZ ha effetto
// subito (la cache del fuso viene azzerata).
process.env.TZ = process.env.OPTIROUTE_TZ || 'Europe/Rome';

export interface TimezoneStatus {
  zone: string;
  ok: boolean;
}

// Scostamento (minuti, con il segno di getTimezoneOffset) del fuso `zone`
// all'istante `d`, calcolato con Intl: indipendente da process.env.TZ.
const intlOffset = (d: Date, zone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((d.getTime() - asUtc) / 60000);
};

// Autocontrollo: l'ora locale del processo è davvero quella del fuso voluto?
// Si confrontano gennaio e luglio (ora solare e legale). Se fallisce il
// motore NON lancia chiamate: rischierebbe di telefonare fuori fascia.
export const timezoneStatus = (): TimezoneStatus => {
  const zone = process.env.TZ || '';
  try {
    const year = new Date().getFullYear();
    const jan = new Date(year, 0, 15, 12, 0, 0);
    const jul = new Date(year, 6, 15, 12, 0, 0);
    if (zone === 'Europe/Rome') {
      return { zone, ok: jan.getTimezoneOffset() === -60 && jul.getTimezoneOffset() === -120 };
    }
    if (!zone) return { zone, ok: false };
    const ok =
      jan.getTimezoneOffset() === intlOffset(jan, zone) &&
      jul.getTimezoneOffset() === intlOffset(jul, zone);
    return { zone, ok };
  } catch {
    return { zone, ok: false }; // fuso sconosciuto a Intl
  }
};
