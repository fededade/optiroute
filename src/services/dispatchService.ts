import type { Appointment, Coordinates, Technician } from '../types';
import { calculateSchedule, nearestNeighborChain, optimizeRoute } from '../utils/geo';
import { hasCachedReverse, reverseGeocodePlace } from './geocodingService';
import { matchTechnician, workWindowOn } from './technicianService';
import { reservedOfferStops } from './autopilotService';
import {
  type AppointmentPatch,
  type DayContext,
  type RouteStop,
  type SlotOption,
  bestSlotForReturn,
  durationOf,
  findFeasibleSlots,
  getDayRoute,
  isDraftStop,
  isInRoute,
  sequenceStops,
  slotSignature,
  toHHMM,
  toMin,
} from './slotService';

// Smistamento automatico: assegna le pratiche "in attesa" ai tecnici in base
// alla zona di competenza e distribuisce ogni coda su più giorni, ipotizzando
// data e orario per ciascun sopralluogo. Le proposte diventano stato
// 'proposed' e vanno confermate dall'operatore.
//
// Regola del rientro: l'ultimo sopralluogo del giro deve essere il più vicino
// possibile alla base (se l'ultimo appuntamento finisce tardi, almeno il
// rientro è breve). Con la base del tecnico (o quella generale):
// - giorno nuovo: si scelgono le pratiche per priorità (urgenti, rientrate,
//   normali) e si ordinano partendo dalla più lontana, così l'ultima è la più
//   vicina alla base;
// - giorno con tappe che sono tutte bozze (proposte dello smistamento non
//   ancora approvate, chiamate o cambiate a mano): si ripianifica da capo con
//   le pratiche nuove, solo se ne entra almeno una;
// - giorno con almeno una tappa approvata, chiamata o confermata: le nuove si
//   inseriscono negli spazi liberi senza mai spostare le tappe esistenti,
//   bozze comprese (al cliente l'orario è già stato comunicato, o lo sarà a
//   breve); in coda al giro entra solo una tappa più vicina alla base
//   dell'ultima, o che permette comunque di rientrare entro fine giornata.
// Senza base si lavora come prima (catena dal punto di partenza, inserimento
// col detour minimo).

export interface DispatchParams {
  startDate: string;        // primo giorno pianificabile (YYYY-MM-DD)
  horizonDays: number;      // giorni di calendario esaminati a partire da startDate
  includeWeekends: boolean;
}

export interface DispatchDayPlan {
  technician: Technician;
  date: string;
  workStart: string;
  workEnd: string;
  appointments: Appointment[]; // copie con date/orari/sequenza proposti
}

export interface DispatchProposal {
  plans: DispatchDayPlan[];
  // Copie aggiornate di TUTTE le pratiche toccate (da applicare allo stato):
  // - pianificate: status 'proposed' + data/orari/sequenza/tecnico
  // - assegnate ma non pianificate nell'orizzonte: tecnico + provincia
  // - non assegnabili: solo eventuale provincia rilevata
  // Le bozze già nel giro non sono mai qui: cambiano solo con `patches`.
  updates: Appointment[];
  unassigned: Appointment[]; // nessun tecnico competente trovato
  unscheduled: { technician: Technician; appointments: Appointment[] }[]; // fuori orizzonte
  // Modifiche alle tappe GIÀ nel giro. Per le tappe approvate, chiamate o
  // confermate solo sequenza e viaggi, mai gli orari. Per le bozze: nuovo
  // orario nel giorno ripianificato, nuovo slot in un altro giorno, oppure
  // ritorno in attesa se non trovano più posto nell'orizzonte.
  patches: AppointmentPatch[];
}

const addDays = (dateStr: string, n: number): string => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const isWeekend = (dateStr: string): boolean => {
  const day = new Date(`${dateStr}T00:00:00`).getDay();
  return day === 0 || day === 6;
};

const parseTime = (t: string): { h: number; m: number } => {
  const [h, m] = t.split(':').map(n => parseInt(n, 10));
  return { h: h || 0, m: m || 0 };
};

// Anteprima sincrona (senza reverse geocoding): conteggi per tecnico.
export interface DispatchPreview {
  perTechnician: { technician: Technician; count: number; urgentCount: number }[];
  unassignedCount: number;
  missingProvinceCount: number; // risolvibili col reverse geocoding in fase di calcolo
}

export const previewDispatch = (
  pending: Appointment[],
  technicians: Technician[]
): DispatchPreview => {
  const counts = new Map<string, { count: number; urgent: number }>();
  let unassigned = 0;
  let missingProvince = 0;

  for (const appt of pending) {
    const tech = appt.technicianId
      ? technicians.find(t => t.id === appt.technicianId) || null
      : matchTechnician(appt, technicians);
    if (tech) {
      const c = counts.get(tech.id) || { count: 0, urgent: 0 };
      c.count += 1;
      if (appt.urgent) c.urgent += 1;
      counts.set(tech.id, c);
    } else {
      unassigned += 1;
      if (!appt.province) missingProvince += 1;
    }
  }

  return {
    perTechnician: technicians
      .filter(t => t.active)
      .map(t => ({
        technician: t,
        count: counts.get(t.id)?.count || 0,
        urgentCount: counts.get(t.id)?.urgent || 0,
      })),
    unassignedCount: unassigned,
    missingProvinceCount: missingProvince,
  };
};

export const computeDispatch = async (
  pending: Appointment[],
  technicians: Technician[],
  fallbackBase: Coordinates | null,
  params: DispatchParams,
  onProgress?: (message: string) => void,
  existing: Appointment[] = [], // tutte le pratiche correnti: se ne usano le tappe già nel giro
  now?: Date // per riconoscere le chiamate rimaste senza esito (senza: tutte ancora in corso)
): Promise<DispatchProposal> => {
  // 1) Arricchimento: provincia/comune mancanti via reverse geocoding (cache + throttle)
  const enriched: Appointment[] = [];
  const toResolve = pending.filter(a => !a.province && !hasCachedReverse(a.coords)).length;
  let resolved = 0;

  for (const appt of pending) {
    if (appt.province) {
      enriched.push({ ...appt });
      continue;
    }
    if (!hasCachedReverse(appt.coords)) {
      resolved += 1;
      onProgress?.(`Rilevo la provincia ${resolved} di ${toResolve} (mappa)...`);
    }
    const place = await reverseGeocodePlace(appt.coords);
    enriched.push({
      ...appt,
      province: place?.province || appt.province,
      comune: place?.comune || appt.comune,
    });
  }

  // 2) Assegnazione per zona (l'assegnazione manuale esistente viene rispettata)
  const queues = new Map<string, Appointment[]>();
  const unassigned: Appointment[] = [];

  for (const appt of enriched) {
    const tech = appt.technicianId
      ? technicians.find(t => t.id === appt.technicianId && t.active) || null
      : matchTechnician(appt, technicians);
    if (tech) {
      appt.technicianId = tech.id;
      const q = queues.get(tech.id) || [];
      q.push(appt);
      queues.set(tech.id, q);
    } else {
      appt.technicianId = undefined;
      unassigned.push(appt);
    }
  }

  // 3) Distribuzione su più giorni, per ogni tecnico
  const plans: DispatchDayPlan[] = [];
  const unscheduled: { technician: Technician; appointments: Appointment[] }[] = [];
  const updates: Appointment[] = [];
  const patches: AppointmentPatch[] = [];

  // Tappe già nel giro (le pratiche da smistare non ne fanno parte). Gli slot
  // offerti come alternativa nelle chiamate ancora in corso contano come
  // occupati: il cliente potrebbe accettarli. Senza `now` ogni chiamata senza
  // esito si considera ancora in corso (scelta prudente).
  const pendingIds = new Set(pending.map(a => a.id));
  const reserved = reservedOfferStops(existing, now ?? new Date(0));
  const existingInRoute = [...existing, ...reserved].filter(a => isInRoute(a) && !pendingIds.has(a.id));
  const reservedIds = new Set(reserved.map(a => a.id));
  // Bozze che hanno perso il posto nel loro giorno (scalzate da pratiche con
  // priorità più alta): seguono la coda come le altre, ma il loro esito finale
  // arriva come patch (non sono fra le pratiche in attesa ricevute)
  const displacedIds = new Set<string>();

  for (const tech of technicians.filter(t => t.active)) {
    let queue = queues.get(tech.id) || [];
    if (queue.length === 0) continue;

    onProgress?.(`Pianifico i sopralluoghi di ${tech.name}...`);

    const base = tech.baseCoords || fallbackBase || null;

    for (let offset = 0; offset < params.horizonDays && queue.length > 0; offset++) {
      const date = addDays(params.startDate, offset);
      if (!params.includeWeekends && isWeekend(date)) continue;

      const window = workWindowOn(tech, date);
      if (!window) continue; // giorno di indisponibilità

      // Vincolo data di rientro (richiamo concordato / fine lavori): la pratica
      // non viene mai proposta prima del suo followUpDate.
      const deferred: Appointment[] = [];
      const eligible: Appointment[] = [];
      // Le date rifiutate dal cliente non si ripropongono: restano in coda.
      for (const a of queue) {
        const notYet = !!a.followUpDate && a.followUpDate > date;
        const declined = !!a.declinedDates?.includes(date);
        (notYet || declined ? deferred : eligible).push(a);
      }
      if (eligible.length === 0) continue; // solo pratiche non ancora rientrate

      const ctx: DayContext = { windowStart: toMin(window.start), windowEnd: toMin(window.end), base };
      const existingRoute = getDayRoute(existingInRoute, tech.id, date);

      // Giorno con tappe tutte bozze (e nessuno slot riservato): si
      // ripianifica da capo. Senza base si inserisce come prima.
      const replan =
        !!base &&
        existingRoute.length > 0 &&
        existingRoute.every(s => !reservedIds.has(s.id) && isDraftStop(s.appt));

      // Giorno con tappe approvate, chiamate o confermate: inserimento negli
      // spazi liberi, le tappe esistenti non si muovono
      if (existingRoute.length > 0 && !replan) {
        const { placed, overflow, existingPatches } = insertIntoRoute(existingRoute, ctx, eligible, reservedIds);
        if (placed.length > 0) {
          const dayAppointments = placed.map(a => withAutoSlot({ ...a, date, technicianId: tech.id }));
          plans.push({
            technician: tech,
            date,
            workStart: window.start,
            workEnd: window.end,
            appointments: dayAppointments,
          });
          updates.push(...dayAppointments);
          patches.push(...existingPatches);
        }
        queue = [...overflow, ...deferred];
        continue;
      }

      const start = parseTime(window.start);
      const end = parseTime(window.end);
      const scheduleDay: ScheduleFn = order =>
        calculateSchedule(order, base, start.h, start.m, end.h, 20, {
          useEstimates: true,
          startFromBase: true,
          maxEndTimeMinutes: end.m,
          roundToMinutes: 5,
        });

      // Bozze del giorno (in ordine d'orario): candidate insieme alle nuove
      const drafts = existingRoute.map(s => s.appt);
      const draftById = new Map(drafts.map(d => [d.id, d]));

      let scheduled: Appointment[];
      let overflow: Appointment[];
      if (base) {
        const priority = priorityOrder(drafts, eligible, base);
        ({ scheduled, overflow } = await planEndingNearBase(priority, ctx, scheduleDay));
        // Giorno di bozze: si cambia solo se entra almeno una pratica nuova,
        // altrimenti resta esattamente com'è e le nuove restano in coda
        if (replan && !scheduled.some(a => !draftById.has(a.id))) continue;
      } else {
        // Senza base: catena del più vicino come prima, si va in overflow
        // dalla prima tappa che non entra in poi
        ({ scheduled, overflow } = await scheduleDay(priorityOrder([], eligible, null)));
      }

      if (scheduled.length > 0) {
        const dayAppointments = scheduled.map(a =>
          withAutoSlot({ ...a, status: 'proposed' as const, date, technicianId: tech.id })
        );
        // Nell'anteprima tutte le tappe del giorno, bozze risistemate comprese
        plans.push({
          technician: tech,
          date,
          workStart: window.start,
          workEnd: window.end,
          appointments: dayAppointments,
        });
        for (const a of dayAppointments) {
          const draft = draftById.get(a.id);
          if (!draft) {
            updates.push(a);
            continue;
          }
          const changes = changedPlanning(draft, a);
          if (changes) patches.push({ id: a.id, changes });
        }
      }

      // Bozze rimaste senza posto: in coda per i giorni successivi
      for (const a of overflow) if (draftById.has(a.id)) displacedIds.add(a.id);

      // Le rimandate (followUpDate futuro) restano in coda per i giorni successivi
      queue = [...overflow, ...deferred];
    }

    if (queue.length > 0) {
      unscheduled.push({ technician: tech, appointments: queue });
      // restano "in attesa" ma con tecnico e provincia aggiornati
      updates.push(
        ...queue.map(a => ({
          ...a,
          status: 'pending' as const,
          date: undefined,
          sequenceOrder: undefined,
          startTime: undefined,
          endTime: undefined,
          autoSlot: undefined,
        }))
      );
    }
  }

  // Le bozze scalzate non sono pratiche in attesa: il loro esito (nuovo slot
  // oppure ritorno in attesa) diventa una patch
  const finalUpdates: Appointment[] = [];
  for (const u of updates) {
    if (displacedIds.has(u.id)) patches.push({ id: u.id, changes: displacedOutcome(u) });
    else finalUpdates.push(u);
  }

  // Anche le non assegnabili vengono aggiornate (provincia rilevata)
  finalUpdates.push(...unassigned.map(a => ({ ...a })));

  return { plans, updates: finalUpdates, unassigned, unscheduled, patches };
};

// Firma dello slot scritta su ogni tappa pianificata dallo smistamento
const withAutoSlot = (a: Appointment): Appointment => ({ ...a, autoSlot: slotSignature(a) });

const classOf = (a: Appointment): number => (a.urgent ? 0 : a.followUpDate ? 1 : 2);

// Ordine di priorità del giorno: urgenti, poi pratiche "rientrate" (il loro
// followUpDate è arrivato: vanno inserite appena possibile), poi le altre.
// Le nuove seguono la catena del più vicino (urgenti dalla base, rientrate
// dall'ultima urgente, normali dall'ultima rientrata); dentro ogni classe le
// bozze già nel giorno (in ordine d'orario) vengono prima delle nuove.
const priorityOrder = (drafts: Appointment[], eligible: Appointment[], base: Coordinates | null): Appointment[] => {
  const urgentChain = nearestNeighborChain(eligible.filter(a => classOf(a) === 0), base);
  const lastUrgent = urgentChain[urgentChain.length - 1];
  const dueChain = nearestNeighborChain(eligible.filter(a => classOf(a) === 1), lastUrgent ? lastUrgent.coords : base);
  const lastDue = dueChain[dueChain.length - 1] || lastUrgent;
  const normalChain = nearestNeighborChain(eligible.filter(a => classOf(a) === 2), lastDue ? lastDue.coords : base);
  return [urgentChain, dueChain, normalChain].flatMap((chain, c) => [...drafts.filter(d => classOf(d) === c), ...chain]);
};

type ScheduleFn = (order: Appointment[]) => Promise<{ scheduled: Appointment[]; overflow: Appointment[] }>;

// Regola del rientro sul giorno da pianificare: scelta golosa su TUTTA la
// priorità. Si scorrono le pratiche in ordine; ognuna entra solo se, insieme
// a quelle già scelte e ordinate dalla più lontana alla più vicina alla base
// (optimizeRoute), trovano posto TUTTE. Se le durate da sole sforano la
// finestra si salta senza calcolo. Una pratica che non entra (es. un'urgente
// molto lontana) non blocca quelle dopo di lei. L'ultima tappa del giorno è
// sempre la più vicina alla base.
const planEndingNearBase = async (
  priority: Appointment[],
  ctx: DayContext,
  scheduleDay: ScheduleFn
): Promise<{ scheduled: Appointment[]; overflow: Appointment[] }> => {
  const span = ctx.windowEnd - ctx.windowStart;
  const chosen: Appointment[] = [];
  const chosenIds = new Set<string>();
  let scheduled: Appointment[] = [];
  let total = 0;
  for (const a of priority) {
    const d = durationOf(a);
    if (total + d > span) continue;
    const res = await scheduleDay(optimizeRoute([...chosen, a], ctx.base));
    if (res.overflow.length > 0) continue;
    chosen.push(a);
    chosenIds.add(a.id);
    total += d;
    scheduled = res.scheduled;
  }
  return { scheduled, overflow: priority.filter(a => !chosenIds.has(a.id)).map(clearSlot) };
};

// Come l'overflow di calculateSchedule: sequenza e orari azzerati
const clearSlot = (a: Appointment): Appointment => ({
  ...a,
  sequenceOrder: undefined,
  startTime: undefined,
  endTime: undefined,
});

const DRAFT_FIELDS = [
  'startTime', 'endTime', 'sequenceOrder', 'travelTimeFromPrev', 'distanceFromPrev', 'hasLunchBreakBefore', 'autoSlot',
] as const;

// Campi di pianificazione cambiati per una bozza rimasta nel suo giorno
// (null se non è cambiato niente)
const changedPlanning = (before: Appointment, after: Appointment): Partial<Appointment> | null => {
  const changes: Partial<Appointment> = {};
  for (const k of DRAFT_FIELDS) {
    const same = k === 'hasLunchBreakBefore' ? !!before[k] === !!after[k] : before[k] === after[k];
    if (!same) (changes as Record<string, unknown>)[k] = after[k];
  }
  return Object.keys(changes).length > 0 ? changes : null;
};

// Esito finale di una bozza scalzata: nuovo slot completo, oppure ritorno in
// attesa con la pianificazione azzerata
const displacedOutcome = (u: Appointment): Partial<Appointment> =>
  u.status === 'proposed'
    ? {
        status: 'proposed',
        date: u.date,
        technicianId: u.technicianId,
        startTime: u.startTime,
        endTime: u.endTime,
        sequenceOrder: u.sequenceOrder,
        travelTimeFromPrev: u.travelTimeFromPrev,
        distanceFromPrev: u.distanceFromPrev,
        hasLunchBreakBefore: u.hasLunchBreakBefore,
        autoSlot: u.autoSlot,
      }
    : {
        status: 'pending',
        date: undefined,
        startTime: undefined,
        endTime: undefined,
        sequenceOrder: undefined,
        travelTimeFromPrev: undefined,
        distanceFromPrev: undefined,
        hasLunchBreakBefore: undefined,
        autoSlot: undefined,
      };

// Inserimento greedy nel giro esistente (le tappe esistenti non si muovono):
// classi urgenti -> rientrate (followUpDate) -> normali; dentro la classe entra
// ogni volta la pratica con l'inserimento più economico (detour minimo, a
// parità più presto) fra quelli ammessi dalla regola del rientro.
const insertIntoRoute = (
  existingRoute: RouteStop[],
  ctx: DayContext,
  eligible: Appointment[],
  reservedIds: Set<string> = new Set() // slot riservati: occupano spazio ma non sono tappe
): { placed: Appointment[]; overflow: Appointment[]; existingPatches: AppointmentPatch[] } => {
  const route: RouteStop[] = [...existingRoute];
  const newIds = new Set<string>();
  const overflow: Appointment[] = [];

  const classes = [
    eligible.filter(a => a.urgent),
    eligible.filter(a => !a.urgent && a.followUpDate),
    eligible.filter(a => !a.urgent && !a.followUpDate),
  ];

  for (const cls of classes) {
    const remaining = [...cls];
    while (remaining.length > 0) {
      let chosen: (SlotOption & { index: number }) | null = null;
      for (let index = 0; index < remaining.length; index++) {
        const a = remaining[index];
        // regola del rientro: in coda al giro solo chi è più vicino alla base dell'ultima
        const opt = bestSlotForReturn(findFeasibleSlots(route, ctx, a.coords, durationOf(a)), route, ctx, a.coords);
        if (!opt) continue;
        if (
          !chosen ||
          opt.detourKm < chosen.detourKm - 1e-9 ||
          (Math.abs(opt.detourKm - chosen.detourKm) <= 1e-9 && opt.start < chosen.start)
        ) {
          chosen = { index, ...opt };
        }
      }
      if (!chosen) break; // nessuna pratica della classe entra più nel giorno
      const appt = remaining.splice(chosen.index, 1)[0];
      newIds.add(appt.id);
      route.splice(chosen.position, 0, {
        id: appt.id,
        coords: appt.coords,
        start: chosen.start,
        end: chosen.end,
        lunchBefore: chosen.lunchBefore,
        appt,
      });
    }
    overflow.push(...remaining);
  }

  if (newIds.size === 0) return { placed: [], overflow, existingPatches: [] };

  // Sequenza finale del giorno: nuove tappe complete, esistenti solo riordino
  // (gli slot riservati alle chiamate in corso non sono tappe: fuori sequenza)
  const realExisting = existingRoute.filter(s => !reservedIds.has(s.id));
  const realRoute = route.filter(s => !reservedIds.has(s.id));
  const seq = sequenceStops(realRoute, ctx.base);
  const placed: Appointment[] = [];
  const existingPatches: AppointmentPatch[] = [];
  realRoute.forEach((s, i) => {
    const v = seq[i];
    if (newIds.has(s.id)) {
      placed.push({
        ...s.appt,
        status: 'proposed',
        startTime: toHHMM(s.start),
        endTime: toHHMM(s.end),
        hasLunchBreakBefore: s.lunchBefore,
        ...v,
      });
      return;
    }
    // Tappa esistente: i viaggi si ricalcolano solo se è cambiata la tappa precedente
    const oldIndex = realExisting.findIndex(e => e.id === s.id);
    const prevBefore = oldIndex > 0 ? realExisting[oldIndex - 1].id : null;
    const prevNow = i > 0 ? realRoute[i - 1].id : null;
    const changes: Partial<Appointment> = {};
    if (s.appt.sequenceOrder !== v.sequenceOrder) changes.sequenceOrder = v.sequenceOrder;
    if (prevBefore !== prevNow) {
      changes.travelTimeFromPrev = v.travelTimeFromPrev;
      changes.distanceFromPrev = v.distanceFromPrev;
    }
    if (Object.keys(changes).length > 0) existingPatches.push({ id: s.id, changes });
  });

  return { placed, overflow, existingPatches };
};
