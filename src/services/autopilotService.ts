import type { AlternativeSlot, Appointment, CallOutcome, CallOutcomeResult, Technician } from '../types';
import { computeAlternativeSlots, inferChosenAlternative, resolveAlternative } from './alternativesService';
import {
  type PlanningFallback,
  type SlotOption,
  dateAtMinutes,
  dayContextFor,
  durationOf,
  findFeasibleSlots,
  getDayRoute,
  isInRoute,
  placeAppointment,
  removeFromRoute,
  toMin,
} from './slotService';

// Pilota automatico delle chiamate: riduttori PURI sull'elenco delle pratiche.
// La coda vive sulle pratiche stesse (campo `autoCall`); la UI decide quando
// avviare la prossima chiamata (nextDueCall) e passa qui ogni evento:
// avvio, esito del lancio, esito della conversazione. Obiettivo: nessun giro
// a vuoto. Chi rifiuta riceve alternative reali, lo slot liberato viene
// riempito con un'altra pratica (rimpiazzo), chi non risponde viene
// richiamato entro la fascia oraria fino al tetto tentativi.

export interface AutopilotSettings {
  enabled: boolean;            // false di default: senza, il comportamento resta quello manuale
  callWindowStart: string;     // '09:00'
  callWindowEnd: string;       // '19:30'
  callSaturday: boolean;       // false; la domenica mai
  maxAttempts: number;         // 3 chiamate senza risposta, poi "irreperibile"
  retryMinutes: number;        // 120
  offerAlternatives: boolean;  // true
  backfill: boolean;           // true
  minLeadHours: number;        // 3: non proporre/riempire slot che iniziano entro N ore
  autoDispatch: boolean;       // true (usato dalla UI)
  dispatchHorizonDays: number; // 14 (usato dalla UI)
  autoApprove: boolean;        // false (usato dalla UI): chiama le nuove proposte senza attendere l'approvazione del giro
}

export const DEFAULT_AUTOPILOT_SETTINGS: AutopilotSettings = {
  enabled: false,
  callWindowStart: '09:00',
  callWindowEnd: '19:30',
  callSaturday: false,
  maxAttempts: 3,
  retryMinutes: 120,
  offerAlternatives: true,
  backfill: true,
  minLeadHours: 3,
  autoDispatch: true,
  dispatchHorizonDays: 14,
  autoApprove: false,
};

export interface PlanningContext {
  technicians: Technician[];
  fallback: PlanningFallback;
  settings: AutopilotSettings;
  now: Date;
}

// --- Utilità ---

// Oltre questo tempo senza esito la chiamata non è più "in volo": l'esito non
// è arrivato (stesso limite del polling) e non deve bloccare la coda. Finisce
// fra le cose da gestire a mano.
export const CALL_OUTCOME_MAX_AGE_MS = 45 * 60 * 1000;

const outcomeOverdue = (a: Appointment, now: Date): boolean =>
  a.callStatus === 'called' &&
  !!a.callId &&
  !a.callOutcome &&
  !!a.calledAt &&
  now.getTime() - new Date(a.calledAt).getTime() >= CALL_OUTCOME_MAX_AGE_MS;

// Chiamata "in volo": partita e senza ancora un esito. Con `now` le chiamate
// rimaste senza esito oltre il limite non contano più.
export const isCallInFlight = (a: Appointment, now?: Date): boolean => {
  if (a.callStatus === 'calling') return true;
  if (a.callStatus !== 'called' || !a.callId || a.callOutcome) return false;
  return !(now && outcomeOverdue(a, now));
};

// Slot offerti come alternativa nelle chiamate ancora in corso: finché non
// arriva l'esito vanno considerati occupati, altrimenti due clienti
// potrebbero accettare lo stesso slot (o un rimpiazzo potrebbe prenderselo).
// Restituisce tappe "fantasma" da aggiungere all'elenco solo per i calcoli.
export const reservedOfferStops = (all: Appointment[], now: Date, excludeId?: string): Appointment[] =>
  all.flatMap(a =>
    a.id !== excludeId && a.offeredAlternatives && isCallInFlight(a, now)
      ? a.offeredAlternatives.map(o => ({
          ...a,
          id: `${a.id}#${o.label}`,
          status: 'proposed' as const,
          date: o.date,
          startTime: o.startTime,
          endTime: o.endTime,
          hasLunchBreakBefore: false,
          sequenceOrder: undefined,
        }))
      : []
  );

// Istante di inizio dello slot (null se la pratica non è nel giro)
export const slotStartOf = (a: Appointment): Date | null =>
  a.date && a.startTime ? dateAtMinutes(a.date, toMin(a.startTime)) : null;

const slotPassed = (a: Appointment, now: Date): boolean => {
  const start = slotStartOf(a);
  return !!start && start.getTime() <= now.getTime();
};

const addNote = (notes: string | undefined, nota: string): string =>
  notes ? `${notes} · ${nota}` : nota;

const addDeclined = (dates: string[] | undefined, date: string | undefined): string[] | undefined => {
  if (!date) return dates;
  if (dates?.includes(date)) return dates;
  return [...(dates || []), date];
};

const formatDate = (date: string): string => {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
};

const replaceById = (all: Appointment[], updated: Appointment): Appointment[] =>
  all.map(a => (a.id === updated.id ? updated : a));

const techById = (technicians: Technician[], id?: string): Technician | undefined =>
  id ? technicians.find(t => t.id === id) : undefined;

// Base del giorno per ricalcolare i viaggi (anche se il tecnico non lavora)
const baseFor = (ctx: PlanningContext, technicianId: string | undefined, date: string) => {
  const tech = techById(ctx.technicians, technicianId);
  const day = dayContextFor(tech, date, ctx.fallback);
  return { base: day ? day.base : tech?.baseCoords || ctx.fallback.base };
};

// --- Fascia oraria delle chiamate ---

const dayAllowed = (d: Date, s: AutopilotSettings): boolean => {
  const day = d.getDay();
  if (day === 0) return false;           // la domenica mai
  if (day === 6) return s.callSaturday;
  return true;
};

export const isWithinCallWindow = (now: Date, s: AutopilotSettings): boolean => {
  if (!dayAllowed(now, s)) return false;
  const min = now.getHours() * 60 + now.getMinutes();
  return min >= toMin(s.callWindowStart) && min < toMin(s.callWindowEnd);
};

// Prossima apertura della fascia chiamate (adesso, se già aperta)
export const nextCallWindowStart = (now: Date, s: AutopilotSettings): Date => {
  if (isWithinCallWindow(now, s)) return new Date(now.getTime());
  const startMin = toMin(s.callWindowStart);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 0, startMin, 0, 0);
    if (d.getTime() > now.getTime() && dayAllowed(d, s)) return d;
  }
  return new Date(now.getTime()); // configurazione impossibile: nessuna attesa
};

// --- Coda delle chiamate ---

// Mette in coda le PROPOSTE del giro con telefono, non in volo e non già
// confermate dal cliente (e con lo slot non ancora trascorso). Le tappe
// confermate a mano dall'operatore non si richiamano in automatico.
export const approveForCalling = (all: Appointment[], ids: string[], now: Date): Appointment[] => {
  const set = new Set(ids);
  return all.map(a => {
    if (!set.has(a.id)) return a;
    if (a.status !== 'proposed' || !isInRoute(a) || !a.phone || isCallInFlight(a, now)) return a;
    if (a.callOutcome?.result === 'confermato') return a;
    if (slotPassed(a, now)) return a;
    return { ...a, autoCall: 'route', autoCallNotBefore: undefined, callAttempts: 0 };
  });
};

export const cancelAutoCalls = (all: Appointment[], ids: string[]): Appointment[] => {
  const set = new Set(ids);
  return all.map(a =>
    set.has(a.id) && (a.autoCall || a.autoCallNotBefore)
      ? { ...a, autoCall: undefined, autoCallNotBefore: undefined }
      : a
  );
};

const PRIORITY: Record<string, number> = { backfill: 0, route: 1, retry: 2 };

// Pratica in coda pronta per essere chiamata (ignora fascia e tetto)
const isDue = (a: Appointment, now: Date): boolean =>
  !!a.autoCall &&
  !!a.phone &&
  isInRoute(a) &&
  !isCallInFlight(a, now) &&
  (!a.autoCallNotBefore || new Date(a.autoCallNotBefore).getTime() <= now.getTime()) &&
  !slotPassed(a, now);

const byPriority = (x: Appointment, y: Appointment): number =>
  (PRIORITY[x.autoCall || ''] ?? 9) - (PRIORITY[y.autoCall || ''] ?? 9) ||
  (x.date || '').localeCompare(y.date || '') ||
  (x.startTime || '').localeCompare(y.startTime || '');

export const nextDueCall = (all: Appointment[], ctx: PlanningContext, maxInFlight = 4): Appointment | null => {
  if (!ctx.settings.enabled) return null;
  if (!isWithinCallWindow(ctx.now, ctx.settings)) return null;
  if (all.filter(a => isCallInFlight(a, ctx.now)).length >= maxInFlight) return null;
  const due = all.filter(a => isDue(a, ctx.now)).sort(byPriority);
  return due[0] || null;
};

// Toglie dalla coda le pratiche il cui slot è già trascorso
export const expireStaleAutoCalls = (all: Appointment[], now: Date): Appointment[] =>
  all.map(a =>
    a.autoCall && slotPassed(a, now) ? { ...a, autoCall: undefined, autoCallNotBefore: undefined } : a
  );

// --- Eventi di chiamata ---

// Alternative da offrire nella chiamata che sta per partire (vuoto se
// l'opzione è spenta o la pratica non ha uno slot proposto). Non riusa gli
// slot già offerti nelle chiamate in corso.
export const alternativesForCall = (appt: Appointment, all: Appointment[], ctx: PlanningContext): AlternativeSlot[] => {
  if (!ctx.settings.offerAlternatives || !isInRoute(appt)) return [];
  return computeAlternativeSlots(appt, [...all, ...reservedOfferStops(all, ctx.now, appt.id)], ctx.technicians, {
    now: ctx.now,
    fallback: ctx.fallback,
    minLeadMinutes: ctx.settings.minLeadHours * 60,
  });
};

export const reduceCallStarted = (
  all: Appointment[],
  id: string,
  alternatives: AlternativeSlot[]
): Appointment[] =>
  all.map(a =>
    a.id === id
      ? {
          ...a,
          callStatus: 'calling',
          // via i riferimenti alla chiamata precedente: il suo esito non deve
          // essere scambiato per quello della chiamata che sta partendo
          callId: undefined,
          calledAt: undefined,
          autoCall: undefined,
          autoCallNotBefore: undefined,
          callOutcome: undefined,
          callSummary: undefined,
          offeredAlternatives: alternatives.length > 0 ? alternatives : undefined,
        }
      : a
  );

export const reduceCallLaunchResult = (
  all: Appointment[],
  id: string,
  result: { ok: boolean; callId?: string; error?: string },
  now: Date
): Appointment[] =>
  all.map(a => {
    if (a.id !== id) return a;
    if (result.ok) {
      return { ...a, callStatus: 'called', callId: result.callId, calledAt: now.toISOString() };
    }
    // Nessun retry automatico: finisce fra le cose da gestire
    return {
      ...a,
      callStatus: 'failed',
      calledAt: now.toISOString(),
      callSummary: result.error || 'Chiamata non avviata',
    };
  });

// --- Esito della conversazione ---

interface FreedSlot {
  technicianId?: string;
  date: string;
  start: number;
  end: number;
  coords: Appointment['coords'];
  title: string;
}

const ALTERNATIVE_RESULTS: CallOutcomeResult[] = ['confermato', 'riprogrammare', 'da_richiamare', 'sconosciuto'];

// Applica l'esito della conversazione alla pratica (porta ed estende la
// mappatura esito -> stato dell'app):
//  alternativa accettata -> spostata sullo slot scelto, Confermata
//  confermato          -> proposta => Confermata (data/orario mantenuti)
//  riprogrammare       -> In Attesa, preferenza del cliente nelle note
//  da_richiamare       -> Problematica 📆 con data di rientro
//  numero_errato       -> Problematica 📵
//  lavori_non_ultimati -> Problematica 🚧 con data fine lavori
//  annullato           -> Annullata (archivio)
//  rifiutato           -> Stand-by (data rifiutata: non si ripropone)
//  altro_referente     -> aggiorna telefono/referente e (pilota) richiama
//  non_risposto        -> (pilota) nuovo tentativo o irreperibile
//  sconosciuto         -> solo esito
// Con il pilota acceso lo slot liberato viene riempito (rimpiazzo).
export const reduceCallOutcome = (
  all: Appointment[],
  id: string,
  outcome: CallOutcome,
  expectedCallId: string | undefined,
  ctx: PlanningContext
): Appointment[] => {
  const a = all.find(x => x.id === id);
  if (!a || a.callOutcome) return all;
  if (expectedCallId && a.callId !== expectedCallId) return all; // nel frattempo è partita un'altra chiamata

  const s = ctx.settings;
  const pilot = s.enabled;
  const eraNelGiro = isInRoute(a);
  const freed: FreedSlot | null = eraNelGiro
    ? {
        technicianId: a.technicianId,
        date: a.date as string,
        start: toMin(a.startTime as string),
        end: a.endTime ? toMin(a.endTime) : toMin(a.startTime as string) + durationOf(a),
        coords: a.coords,
        title: a.title,
      }
    : null;
  const oldDayBase = freed ? baseFor(ctx, freed.technicianId, freed.date) : undefined;

  const base: Appointment = {
    ...a,
    callOutcome: outcome,
    callSummary: outcome.summary || a.callSummary,
    callStatus: outcome.result === 'non_risposto' ? 'failed' : 'called',
  };
  let list = replaceById(all, base);
  let liberato = false;

  // Esce dal giro con le modifiche indicate (slot liberato se era nel giro)
  const leaveRoute = (changes: Partial<Appointment>) => {
    list = removeFromRoute(list, id, changes, oldDayBase);
    liberato = eraNelGiro;
  };

  const reschedule = (followUpDate: string | undefined, nota: string, savedOutcome: CallOutcome) => {
    leaveRoute({
      status: 'pending',
      followUpDate,
      declinedDates: addDeclined(a.declinedDates, a.date),
      notes: addNote(a.notes, nota),
      callOutcome: savedOutcome,
    });
  };

  // 1) Alternativa accettata in chiamata
  // (etichetta esplicita dall'analisi post-chiamata, oppure dedotta dalla
  // data/ora richieste se coincidono con uno slot offerto)
  const chosen = inferChosenAlternative(outcome, a.offeredAlternatives, eraNelGiro ? a : undefined);
  const offered = chosen ? a.offeredAlternatives?.find(o => o.label === chosen) : undefined;
  if (offered && ALTERNATIVE_RESULTS.includes(outcome.result)) {
    // Rivalidazione anche contro gli slot offerti in altre chiamate ancora in
    // corso (un esito arrivato in ritardo non può prendersi lo slot di un altro)
    const occupied = [...list, ...reservedOfferStops(list, ctx.now, id)];
    const resolved = resolveAlternative(a, offered.label, occupied, ctx.technicians, ctx.fallback, ctx.now);
    const quando = `${formatDate(offered.date)} ${offered.startTime}`;
    if (resolved) {
      list = placeAppointment(
        list,
        id,
        {
          date: resolved.date,
          option: resolved.option,
          ctx: baseFor(ctx, a.technicianId, resolved.date),
          fromCtx: oldDayBase,
        },
        {
          status: 'confirmed',
          callOutcome: { ...outcome, result: 'confermato', chosenAlternative: offered.label },
          declinedDates: a.date && a.date !== resolved.date ? addDeclined(a.declinedDates, a.date) : a.declinedDates,
          callAttempts: 0,
          autoCall: undefined,
          autoCallNotBefore: undefined,
          notes: addNote(a.notes, `Spostato su richiesta del cliente: ${quando}`),
        }
      );
      liberato = eraNelGiro;
    } else {
      reschedule(
        offered.date,
        `Da riprogrammare — l'alternativa scelta dal cliente (${quando}) non è più libera`,
        { ...outcome, result: 'riprogrammare', followUpDate: offered.date }
      );
    }
  } else {
    // 2) Mappatura esito -> stato
    switch (outcome.result) {
      case 'confermato':
        list = replaceById(list, {
          ...base,
          status: a.status === 'proposed' ? 'confirmed' : base.status,
          callAttempts: 0,
        });
        break;
      case 'riprogrammare': {
        // Se la data richiesta è interpretabile diventa "rientro": lo
        // smistamento non propone prima
        const quando = [outcome.requestedDate, outcome.requestedTime].filter(Boolean).join(' ');
        reschedule(
          outcome.followUpDate || a.followUpDate,
          quando ? `Da riprogrammare — richiesta cliente: ${quando}` : 'Da riprogrammare (nessuna preferenza indicata)',
          outcome
        );
        break;
      }
      case 'da_richiamare':
        leaveRoute({ status: 'issue', issueType: 'callback', followUpDate: outcome.followUpDate || a.followUpDate });
        break;
      case 'numero_errato':
        leaveRoute({ status: 'issue', issueType: 'wrong_phone' });
        break;
      case 'lavori_non_ultimati':
        leaveRoute({ status: 'issue', issueType: 'works_pending', followUpDate: outcome.followUpDate || a.followUpDate });
        break;
      case 'annullato':
        leaveRoute({ status: 'cancelled', issueType: undefined });
        break;
      case 'rifiutato':
        leaveRoute({
          status: 'standby',
          notes: addNote(a.notes, 'Rifiutato dal cliente'),
          declinedDates: addDeclined(a.declinedDates, a.date),
        });
        break;
      case 'altro_referente':
        // Pilota acceso e pratica già passata da un referente all'altro: ci
        // si ferma (niente rimbalzi infiniti fra numeri), l'esito resta sulla
        // pratica e finisce fra le cose da gestire.
        if (outcome.newContactPhone && !(pilot && a.referredBy)) {
          // Il cliente ha indicato un'altra persona: si aggiorna il numero e
          // la pratica torna pronta per una nuova chiamata ("per conto di...")
          list = replaceById(list, {
            ...base,
            phone: outcome.newContactPhone,
            contactPerson:
              [outcome.newContactName, outcome.newContactRole].filter(Boolean).join(' — ') || 'Referente indicato dal cliente',
            referredBy: a.referredBy || a.title,
            callStatus: undefined,
            callId: undefined,
            calledAt: undefined,
            callOutcome: undefined,
            callAttempts: 0,
            notes: addNote(
              a.notes,
              `Nuovo referente: ${[outcome.newContactName, outcome.newContactRole, outcome.newContactPhone].filter(Boolean).join(' · ')}`
            ),
            // Pilota: richiama da solo il referente per lo stesso slot
            ...(pilot && eraNelGiro ? { autoCall: 'route' as const, autoCallNotBefore: undefined } : {}),
          });
        }
        break;
      case 'non_risposto': {
        const attempts = (a.callAttempts || 0) + 1;
        // Una tappa già confermata (a mano o dal cliente) non esce dal giro
        // perché non risponde: si contano solo i tentativi
        if (!pilot || !eraNelGiro || a.status !== 'proposed') {
          list = replaceById(list, { ...base, callAttempts: attempts });
          break;
        }
        const retryAt = nextCallWindowStart(new Date(ctx.now.getTime() + s.retryMinutes * 60000), s);
        const slotStart = slotStartOf(a) as Date;
        const deadline = slotStart.getTime() - s.minLeadHours * 3600000;
        if (attempts < s.maxAttempts && retryAt.getTime() < deadline) {
          list = replaceById(list, {
            ...base,
            callAttempts: attempts,
            autoCall: 'retry',
            autoCallNotBefore: retryAt.toISOString(),
          });
        } else {
          // Irreperibile: lo slot si libera per un'altra pratica
          leaveRoute({
            status: 'issue',
            issueType: 'callback',
            callAttempts: attempts,
            autoCall: undefined,
            autoCallNotBefore: undefined,
            notes: addNote(a.notes, `Non raggiungibile dopo ${attempts} ${attempts === 1 ? 'tentativo' : 'tentativi'}`),
          });
        }
        break;
      }
      default:
        break; // sconosciuto: solo esito salvato
    }
  }

  // 3) Rimpiazzo dello slot liberato
  if (pilot && s.backfill && liberato && freed) {
    const leadOk = dateAtMinutes(freed.date, freed.start).getTime() - ctx.now.getTime() >= s.minLeadHours * 3600000;
    if (leadOk) list = backfillSlot(list, freed, id, ctx);
  }

  return list;
};

// Sceglie e inserisce un sostituto nello slot liberato. Non innesca altri
// rimpiazzi (il giorno da cui arriva un anticipo viene solo risequenziato).
const backfillSlot = (all: Appointment[], freed: FreedSlot, leftId: string, ctx: PlanningContext): Appointment[] => {
  if (!freed.technicianId) return all;
  const tech = techById(ctx.technicians, freed.technicianId);
  const day = dayContextFor(tech, freed.date, ctx.fallback);
  if (!day) return all;

  const minStartAbs = ctx.now.getTime() + ctx.settings.minLeadHours * 3600000;
  // Gli slot offerti in chiamate ancora in corso restano riservati a quei clienti
  const occupied = [...all, ...reservedOfferStops(all, ctx.now, leftId)];

  let best: { cand: Appointment; option: SlotOption; score: number } | null = null;
  for (const cand of all) {
    if (cand.id === leftId || cand.technicianId !== freed.technicianId || !cand.phone) continue;
    if (cand.declinedDates?.includes(freed.date)) continue;
    // Mai prima della data di rientro (vale anche per chi viene anticipato da
    // un giorno successivo), mai chi ha una chiamata ancora in corso
    if (cand.followUpDate && cand.followUpDate > freed.date) continue;
    if (isCallInFlight(cand, ctx.now)) continue;

    const waiting = cand.status === 'pending';
    const advance =
      cand.status === 'proposed' &&
      isInRoute(cand) &&
      (cand.date as string) > freed.date &&
      cand.callOutcome?.result !== 'confermato';
    if (!waiting && !advance) continue;

    const route = getDayRoute(occupied, freed.technicianId, freed.date, cand.id);
    const options = findFeasibleSlots(route, day, cand.coords, durationOf(cand), {
      notBefore: freed.start - 30,
      notAfter: freed.start + 120,
    }).filter(o => dateAtMinutes(freed.date, o.start).getTime() >= minStartAbs);

    for (const option of options) {
      const score =
        option.detourKm +
        Math.abs(option.start - freed.start) / 60 +
        (advance ? 3 : 0) -
        (cand.urgent ? 1000 : 0);
      if (!best || score < best.score) best = { cand, option, score };
    }
  }
  if (!best) return all;

  const { cand, option } = best;
  return placeAppointment(
    all,
    cand.id,
    {
      date: freed.date,
      option,
      technicianId: freed.technicianId,
      ctx: { base: day.base },
      fromCtx: cand.date ? baseFor(ctx, cand.technicianId, cand.date) : undefined,
    },
    {
      status: 'proposed',
      autoCall: 'backfill',
      backfillOf: freed.title,
      callAttempts: 0,
      callStatus: undefined,
      callId: undefined,
      calledAt: undefined,
      callOutcome: undefined,
      callSummary: undefined,
      offeredAlternatives: undefined,
      autoCallNotBefore: undefined,
    }
  );
};

// --- Cruscotto ---

export interface AutopilotStats {
  queued: number;          // pratiche in coda
  inFlight: number;        // chiamate in corso / in attesa di esito
  dueNow: number;          // in coda e già chiamabili (fascia a parte)
  nextCallAt: Date | null; // prossima chiamata prevista (null se nessuna)
  windowOpen: boolean;
}

export const autopilotStats = (all: Appointment[], ctx: PlanningContext): AutopilotStats => {
  const queuedList = all.filter(a => !!a.autoCall);
  const dueNow = all.filter(a => isDue(a, ctx.now)).length;

  let nextCallAt: Date | null = null;
  if (ctx.settings.enabled) {
    let earliest: number | null = null;
    for (const a of queuedList) {
      if (!a.phone || !isInRoute(a) || isCallInFlight(a, ctx.now) || slotPassed(a, ctx.now)) continue;
      const t = a.autoCallNotBefore
        ? Math.max(ctx.now.getTime(), new Date(a.autoCallNotBefore).getTime())
        : ctx.now.getTime();
      if (earliest === null || t < earliest) earliest = t;
    }
    if (earliest !== null) nextCallAt = nextCallWindowStart(new Date(earliest), ctx.settings);
  }

  return {
    queued: queuedList.length,
    inFlight: all.filter(a => isCallInFlight(a, ctx.now)).length,
    dueNow,
    nextCallAt,
    windowOpen: isWithinCallWindow(ctx.now, ctx.settings),
  };
};

// --- Cose da gestire a mano ---

export type AttentionKind =
  | 'esito_da_verificare'
  | 'referente_senza_numero'
  | 'senza_telefono'
  | 'chiamata_non_avviata'
  | 'senza_tecnico'
  | 'posizione_approssimativa'
  | 'irreperibile'
  | 'numero_errato'
  | 'rifiutato';

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
}

export const attentionItems = (all: Appointment[], ctx: PlanningContext): AttentionItem[] => {
  const items: AttentionItem[] = [];
  const push = (a: Appointment, kind: AttentionKind, detail: string) =>
    items.push({ id: a.id, kind, title: a.title, detail });

  for (const a of all) {
    const result = a.callOutcome?.result;
    if (result === 'sconosciuto') {
      push(a, 'esito_da_verificare', a.callSummary || 'Esito della chiamata non classificabile: ascolta e verifica');
    }
    if (outcomeOverdue(a, ctx.now)) {
      push(a, 'esito_da_verificare', 'Esito della chiamata non ricevuto: verifica com\'è andata e aggiorna la pratica');
    }
    if (a.status === 'standby' && result === 'rifiutato') {
      push(a, 'rifiutato', a.callSummary || 'Il cliente ha rifiutato l\'appuntamento: decidi se ricontattarlo o annullare');
    }
    if (result === 'altro_referente' && !a.callOutcome?.newContactPhone) {
      const chi = [a.callOutcome?.newContactName, a.callOutcome?.newContactRole].filter(Boolean).join(' — ');
      push(a, 'referente_senza_numero', chi ? `Referente indicato senza numero: ${chi}` : 'Indicato un altro referente, senza numero');
    }
    if (result === 'altro_referente' && a.callOutcome?.newContactPhone) {
      // esito rimasto sulla pratica: secondo cambio di referente, non applicato da solo
      const chi = [a.callOutcome.newContactName, a.callOutcome.newContactRole, a.callOutcome.newContactPhone].filter(Boolean).join(' · ');
      push(a, 'esito_da_verificare', `Indicato un altro referente per la seconda volta (${chi}): verifica chi contattare`);
    }
    if (a.status === 'proposed' && isInRoute(a) && !a.phone) {
      push(a, 'senza_telefono', `Tappa proposta il ${formatDate(a.date as string)} alle ${a.startTime} senza telefono: non chiamabile`);
    }
    if (a.status === 'pending' && !a.phone?.trim()) {
      push(a, 'senza_telefono', 'In attesa senza telefono: non viene smistata né chiamata in automatico');
    }
    if (a.callStatus === 'failed' && !a.callOutcome) {
      push(a, 'chiamata_non_avviata', a.callSummary || 'La chiamata non è partita');
    }
    if (a.status === 'pending' && !a.technicianId) {
      push(a, 'senza_tecnico', 'Nessun tecnico competente per la zona');
    }
    if (a.approximate && (a.status === 'pending' || a.status === 'proposed')) {
      push(a, 'posizione_approssimativa', 'Indirizzo non trovato: posizione al centro del comune');
    }
    if (a.status === 'issue' && a.issueType === 'callback' && a.notes?.includes('Non raggiungibile')) {
      push(a, 'irreperibile', `Non raggiungibile dopo ${a.callAttempts || ctx.settings.maxAttempts} tentativi`);
    }
    if (a.status === 'issue' && a.issueType === 'wrong_phone') {
      push(a, 'numero_errato', a.phone ? `Numero errato: ${a.phone}` : 'Numero errato');
    }
  }
  return items;
};
