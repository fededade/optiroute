import type { Appointment, Coordinates, Technician } from '../types';
import { calculateSchedule, nearestNeighborChain } from '../utils/geo';
import { hasCachedReverse, reverseGeocodePlace } from './geocodingService';
import { matchTechnician, workWindowOn } from './technicianService';

// Smistamento automatico: assegna le pratiche "in attesa" ai tecnici in base
// alla zona di competenza e distribuisce ogni coda su più giorni, ipotizzando
// data e orario per ciascun sopralluogo. Le proposte diventano stato
// 'proposed' e vanno confermate dall'operatore.

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
  onProgress?: (message: string) => void
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

      // Le urgenti occupano sempre i primi slot del primo giorno utile
      const urgents = queue.filter(a => a.urgent);
      const normals = queue.filter(a => !a.urgent);
      const urgentChain = nearestNeighborChain(urgents, base);
      const lastUrgent = urgentChain[urgentChain.length - 1];
      const normalChain = nearestNeighborChain(normals, lastUrgent ? lastUrgent.coords : base);
      const dayOrder = [...urgentChain, ...normalChain];

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

      queue = overflow;
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

  return { plans, updates, unassigned, unscheduled };
};
