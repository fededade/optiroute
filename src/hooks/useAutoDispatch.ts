import { useEffect, useRef, useState } from 'react';
import type { Appointment, Coordinates, Technician } from '../types';
import { computeDispatch } from '../services/dispatchService';
import { applyPatches, addDaysStr, isDraftStop, isInRoute, localDateStr } from '../services/slotService';
import { approveForCalling, nextCallWindowStart, type AutopilotSettings } from '../services/autopilotService';

// Smistamento automatico (pilota acceso + "smistamento automatico"): le
// pratiche in attesa con telefono vengono smistate da sole in giri proposti,
// inserite negli spazi liberi dei giri esistenti. Le tappe approvate, chiamate
// o confermate non si spostano mai; le bozze (proposte dello smistamento non
// ancora approvate né toccate a mano) si possono risistemare quando il giorno
// si ripianifica (arrivano come `patches`). Con "chiama senza approvazione" le nuove proposte vanno subito in
// coda chiamate, altrimenti restano fra le Proposte per l'operatore.
//
// Niente cicli: le pratiche che lo smistamento non riesce a collocare restano
// in attesa e NON fanno ripartire il calcolo. Si ricalcola solo quando cambia
// la "firma" dell'input (pratiche in attesa con rientro/date rifiutate/
// tecnico, configurazione dei tecnici, data di oggi), con un debounce, mai in
// parallelo a un import, a un altro smistamento o con lo smistamento manuale
// aperto.
// Niente lavoro perso: se dopo l'applicazione c'è una pratica da smistare che
// il calcolo non ha visto in quella forma (arrivata durante il calcolo, o con
// il tecnico tolto perché inesistente o non attivo) si ricalcola subito, con
// un tetto ai rilanci consecutivi che non collocano nulla.

export const AUTO_DISPATCH_DEBOUNCE_MS = 3000;

// Pratiche che lo smistamento automatico prende in carico: in attesa e con
// telefono (senza telefono non si potrebbero chiamare: niente giri a vuoto;
// entrano appena il numero arriva, es. dal bridge).
export const isAutoDispatchable = (a: Appointment): boolean => a.status === 'pending' && !!a.phone?.trim();

const technicianSignature = (technicians: Technician[]): string =>
  JSON.stringify(
    technicians.map(t => [t.id, t.active, t.provinces, t.areas, t.baseCoords, t.workStart, t.workEnd, t.unavailability])
  );

export const autoDispatchSignature = (all: Appointment[], technicians: Technician[], today: string): string => {
  const pending = all
    .filter(isAutoDispatchable)
    .map(a => `${a.id}~${a.followUpDate || ''}~${(a.declinedDates || []).join(',')}~${a.technicianId || ''}`)
    .sort()
    .join('|');
  return `${today}#${technicianSignature(technicians)}#${pending}`;
};

// Voci della firma, per pratica: id -> rientro, date rifiutate, tecnico
// (stessi campi di autoDispatchSignature)
export const autoDispatchEntries = (all: Appointment[]): Map<string, string> =>
  new Map(
    all
      .filter(isAutoDispatchable)
      .map(a => [a.id, `${a.followUpDate || ''}~${(a.declinedDates || []).join(',')}~${a.technicianId || ''}`])
  );

// Dopo un calcolo: c'è una pratica da smistare che il calcolo non ha visto in
// questa forma (id nuovo o voce cambiata)? Le pratiche rimaste uguali (non
// collocabili) non contano: niente cicli.
export const needsAnotherRun = (input: Map<string, string>, after: Map<string, string>): boolean => {
  for (const [id, entry] of after) {
    if (input.get(id) !== entry) return true;
  }
  return false;
};

// Rilanci consecutivi senza nessuna pratica collocata: oltre si registra la
// firma e ci si ferma
export const AUTO_DISPATCH_MAX_RERUNS = 3;

// Decisione dopo l'applicazione di un calcolo. `reruns`: rilanci consecutivi
// già fatti senza collocare nulla. Un calcolo che colloca qualcosa azzera il
// conto.
export const afterDispatchRun = (
  input: Map<string, string>,
  after: Map<string, string>,
  placed: number,
  reruns: number
): { rerun: boolean; reruns: number } => {
  const base = placed > 0 ? 0 : reruns;
  if (!needsAnotherRun(input, after)) return { rerun: false, reruns: base };
  if (placed > 0) return { rerun: true, reruns: 0 };
  if (base >= AUTO_DISPATCH_MAX_RERUNS) return { rerun: false, reruns: base };
  return { rerun: true, reruns: base + 1 };
};

// Firma delle tappe già nel giro: se cambia durante il calcolo, il risultato
// potrebbe sovrapporsi a una tappa nuova e va ricalcolato. Conta anche se la
// tappa è ancora una bozza: una bozza approvata nel frattempo non deve essere
// spostata dal risultato calcolato prima.
export const routeSignature = (all: Appointment[]): string =>
  all
    .filter(isInRoute)
    .map(a => `${a.id}~${a.technicianId || ''}~${a.date}~${a.startTime}~${a.endTime || ''}~${isDraftStop(a) ? 'b' : ''}`)
    .sort()
    .join('|');

// Primo giorno pianificabile: il cliente va avvisato almeno il giorno prima,
// quindi il giorno dopo la prossima apertura della fascia chiamate (domani se
// la fascia di oggi è aperta o deve ancora aprire, dopodomani se è chiusa).
export const autoDispatchStartDate = (now: Date, settings: AutopilotSettings): string =>
  addDaysStr(localDateStr(nextCallWindowStart(now, settings)), 1);

// Campi di pianificazione portati dallo smistamento (il resto della pratica
// resta quello attuale: potrebbe essere cambiato durante il calcolo)
const PLANNING_FIELDS: (keyof Appointment)[] = [
  'status', 'date', 'startTime', 'endTime', 'sequenceOrder', 'travelTimeFromPrev', 'distanceFromPrev',
  'hasLunchBreakBefore', 'technicianId', 'province', 'comune', 'autoSlot',
];

export const planningOf = (u: Appointment): Partial<Appointment> => {
  const out: Partial<Appointment> = {};
  for (const k of PLANNING_FIELDS) (out as Record<string, unknown>)[k] = u[k];
  return out;
};

export interface AutoDispatchInfo {
  running: boolean;
  lastRunAt: Date | null;
  lastPlaced: number;
}

interface UseAutoDispatchOptions {
  active: boolean;                 // pilota + smistamento automatico accesi, scheda con il lock
  blocked: boolean;                // import in corso, smistamento manuale aperto...
  appointments: Appointment[];     // solo per calcolare la firma al render
  appointmentsRef: React.MutableRefObject<Appointment[]>;
  technicians: Technician[];
  fallbackBase: Coordinates | null;
  settings: AutopilotSettings;
  commit: (fn: (all: Appointment[]) => Appointment[]) => void;
  isBusy: () => boolean;           // controllo sincrono (ref) subito prima di partire
  setBusy: (busy: boolean) => void;
}

export const useAutoDispatch = ({
  active, blocked, appointments, appointmentsRef, technicians, fallbackBase, settings, commit, isBusy, setBusy,
}: UseAutoDispatchOptions): AutoDispatchInfo => {
  const [info, setInfo] = useState<AutoDispatchInfo>({ running: false, lastRunAt: null, lastPlaced: 0 });
  const lastSignatureRef = useRef<string | null>(null);
  const rerunsRef = useRef(0); // rilanci consecutivi senza nulla di collocato
  const runningRef = useRef(false);
  const [rerun, setRerun] = useState(0);

  const today = localDateStr(new Date());
  const signature = autoDispatchSignature(appointments, technicians, today);
  const hasWork = appointments.some(isAutoDispatchable);

  // Valori sempre aggiornati per il calcolo asincrono
  const latest = useRef({ technicians, fallbackBase, settings, commit });
  latest.current = { technicians, fallbackBase, settings, commit };

  useEffect(() => {
    if (!active || blocked || !hasWork) return;
    if (signature === lastSignatureRef.current) return;

    const timer = setTimeout(async () => {
      if (runningRef.current || isBusy()) {
        setRerun(n => n + 1); // si riprova al prossimo giro
        return;
      }
      // Firma cambiata per altri motivi (non per un nostro rilancio): il
      // conto dei rilanci riparte
      if (lastSignatureRef.current !== null) rerunsRef.current = 0;
      const { technicians: techs, fallbackBase: base, settings: s } = latest.current;
      const before = appointmentsRef.current;
      const sigNow = autoDispatchSignature(before, techs, localDateStr(new Date()));
      const pendingList = before.filter(isAutoDispatchable);
      if (pendingList.length === 0) { lastSignatureRef.current = sigNow; return; }
      const inputEntries = autoDispatchEntries(before);

      runningRef.current = true;
      setBusy(true);
      setInfo(i => ({ ...i, running: true }));
      let placed = 0;
      try {
        const now = new Date();
        const routeBefore = routeSignature(before);
        const proposal = await computeDispatch(
          pendingList,
          techs,
          base,
          { startDate: autoDispatchStartDate(now, s), horizonDays: s.dispatchHorizonDays, includeWeekends: false },
          undefined,
          before,
          now
        );

        // Nel frattempo i giri sono cambiati (rimpiazzo, esito...): si scarta
        // e si ricalcola sullo stato nuovo, per non sovrapporre gli orari
        if (routeSignature(appointmentsRef.current) !== routeBefore) {
          lastSignatureRef.current = null;
          setRerun(n => n + 1);
          return;
        }

        const byId = new Map(proposal.updates.map(u => [u.id, u]));
        const placedIds = proposal.updates.filter(u => u.status === 'proposed').map(u => u.id);
        placed = placedIds.length;
        latest.current.commit(all => {
          // Solo le pratiche ancora in attesa (l'operatore potrebbe averle
          // spostate durante il calcolo). Le bozze risistemate o scalzate dal
          // loro giorno arrivano solo come `patches`.
          let next = all.map(a => (a.status === 'pending' && byId.has(a.id) ? { ...a, ...planningOf(byId.get(a.id)!) } : a));
          next = applyPatches(next, proposal.patches);
          if (s.autoApprove && placedIds.length > 0) next = approveForCalling(next, placedIds, now);
          return next;
        });
        // Pratiche da smistare che il calcolo non ha visto in questa forma
        // (arrivate nel frattempo, o con il tecnico tolto perché inesistente
        // o non attivo): si ricalcola subito, con un tetto ai rilanci
        const decision = afterDispatchRun(inputEntries, autoDispatchEntries(appointmentsRef.current), placed, rerunsRef.current);
        rerunsRef.current = decision.reruns;
        if (decision.rerun) {
          lastSignatureRef.current = null;
          setRerun(n => n + 1);
        } else {
          // Firma dopo l'applicazione: le pratiche rimaste in attesa (non
          // collocabili) non devono far ripartire il calcolo
          lastSignatureRef.current = autoDispatchSignature(appointmentsRef.current, techs, localDateStr(new Date()));
        }
      } catch (err) {
        console.error('Smistamento automatico non riuscito', err);
        lastSignatureRef.current = sigNow; // niente tentativi a raffica
      } finally {
        runningRef.current = false;
        setBusy(false);
        setInfo(i => ({ running: false, lastRunAt: placed > 0 ? new Date() : i.lastRunAt, lastPlaced: placed > 0 ? placed : i.lastPlaced }));
      }
    }, AUTO_DISPATCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [active, blocked, hasWork, signature, rerun, appointmentsRef, isBusy, setBusy]);

  return info;
};
