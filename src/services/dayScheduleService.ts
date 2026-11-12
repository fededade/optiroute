import type { Appointment, Technician } from '../types';
import { workWindowOn } from './technicianService';

// Agenda del giorno per l'agente AI: fasce già impegnate del giro dello
// stesso tecnico, così al telefono può rispondere onesto sulle richieste di
// spostamento senza impegnare slot in diretta. Funzione pura: la usano sia il
// browser sia il motore lato server.
export const buildDaySchedule = (
  appt: Appointment,
  all: Appointment[],
  technicians: Technician[],
  fallback: { start: string; end: string },
  defaultDay: string // giorno da usare se la pratica non ha ancora una data
): string => {
  const day = appt.date || defaultDay;
  const tech = appt.technicianId ? technicians.find(t => t.id === appt.technicianId) : undefined;
  let windowStart = fallback.start;
  let windowEnd = fallback.end;
  if (tech) {
    const window = workWindowOn(tech, day);
    if (window) { windowStart = window.start; windowEnd = window.end; }
  }
  const impegni = all
    .filter(a =>
      (a.status === 'confirmed' || a.status === 'proposed') &&
      a.date === day && a.id !== appt.id && !!a.startTime &&
      a.technicianId === appt.technicianId)
    .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0))
    .map(a => `${a.startTime}-${a.endTime || '?'}${a.comune ? ` (zona ${a.comune})` : ''}`);
  return `Giornata lavorativa ${windowStart}-${windowEnd}. ` +
    (impegni.length ? `Fasce già impegnate: ${impegni.join('; ')}.` : 'Nessun altro appuntamento fissato.');
};
