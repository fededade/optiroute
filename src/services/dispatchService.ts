import type { Appointment, Coordinates, Technician } from '../types';
import { calculateSchedule, nearestNeighborChain } from '../utils/geo';
import { hasCachedReverse, reverseGeocodePlace } from './geocodingService';
import { matchTechnician, workWindowOn } from './technicianService';
import { reservedOfferStops } from './autopilotService';
import {
  type AppointmentPatch,
  type DayContext,
  type RouteStop,
  type SlotOption,
  bestSlot,
  durationOf,
  findFeasibleSlots,
  getDayRoute,
  isInRoute,
  sequenceStops,
  toHHMM,
  toMin,
} from './slotService';

// Smistamento automatico: assegna le pratiche "in attesa" ai tecnici in base
// alla zona di competenza e distribuisce ogni coda su più giorni, ipotizzando
// data e orario per ciascun sopralluogo. Le proposte diventano stato
// 'proposed' e vanno confermate dall'operatore.
// Smistamento incrementale: se un tecnico ha già tappe nel giro di un giorno,
// le nuove pratiche si inseriscono negli spazi liberi senza mai spostare
// l'orario delle tappe esistenti (al cliente è già stato comunicato).

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
  updates: Appointment[];
  unassigned: Appointment[]; // nessun tecnico competente trovato
  unscheduled: { technician: Technician; appointments: Appointment[] }[]; // fuori orizzonte
  // Riordino delle tappe GIÀ nel giro (sequenza e viaggi): mai gli orari
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

      // Giorno con tappe già nel giro: inserimento negli spazi liberi
      const existingRoute = getDayRoute(existingInRoute, tech.id, date);
      if (existingRoute.length > 0) {
        const ctx: DayContext = { windowStart: toMin(window.start), windowEnd: toMin(window.end), base };
        const { placed, overflow, existingPatches } = insertIntoRoute(existingRoute, ctx, eligible, reservedIds);
        if (placed.length > 0) {
          const dayAppointments = placed.map(a => ({ ...a, date, technicianId: tech.id }));
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

      // Ordine slot del giorno: urgenti, poi pratiche "rientrate" (il loro
      // followUpDate è arrivato: vanno inserite appena possibile), poi le altre
      const urgents = eligible.filter(a => a.urgent);
      const dues = eligible.filter(a => !a.urgent && a.followUpDate);
      const normals = eligible.filter(a => !a.urgent && !a.followUpDate);
      const urgentChain = nearestNeighborChain(urgents, base);
      const lastUrgent = urgentChain[urgentChain.length - 1];
      const dueChain = nearestNeighborChain(dues, lastUrgent ? lastUrgent.coords : base);
      const lastDue = dueChain[dueChain.length - 1] || lastUrgent;
      const normalChain = nearestNeighborChain(normals, lastDue ? lastDue.coords : base);
      const dayOrder = [...urgentChain, ...dueChain, ...normalChain];

      const start = parseTime(window.start);
      const end = parseTime(window.end);

      const { scheduled, overflow } = await calculateSchedule(
        dayOrder,
        base,
        start.h,
        start.m,
        end.h,
        20,
        { useEstimates: true, startFromBase: true, maxEndTimeMinutes: end.m }
      );

      if (scheduled.length > 0) {
        const dayAppointments = scheduled.map(a => ({
          ...a,
          status: 'proposed' as const,
          date,
          technicianId: tech.id,
        }));
        plans.push({
          technician: tech,
          date,
          workStart: window.start,
          workEnd: window.end,
          appointments: dayAppointments,
        });
        updates.push(...dayAppointments);
      }

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
        }))
      );
    }
  }

  // Anche le non assegnabili vengono aggiornate (provincia rilevata)
  updates.push(...unassigned.map(a => ({ ...a })));

  return { plans, updates, unassigned, unscheduled, patches };
};

// Inserimento greedy nel giro esistente: classi urgenti -> rientrate
// (followUpDate) -> normali; dentro la classe entra ogni volta la pratica con
// l'inserimento più economico (detour minimo, a parità più presto).
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
        const opt = bestSlot(findFeasibleSlots(route, ctx, a.coords, durationOf(a)));
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
