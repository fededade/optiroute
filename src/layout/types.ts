import type React from 'react';
import type { Appointment, AppointmentStatus, Technician } from '../types';

// Sezioni del pannello di lavoro (anche negli agganci data-testid: nav-<id>, section-<id>)
export type SectionId =
  | 'panoramica'
  | 'pratiche'
  | 'da-gestire'
  | 'in-attesa'
  | 'proposte'
  | 'agenda'
  | 'problemi'
  | 'archivio'
  | 'impostazioni';

export type ViewMode = 'day' | 'week' | 'month';

// Livelli della mappa: sono gli stessi stati React dei vecchi filtri
export interface MapLayers {
  confirmed: boolean;
  proposed: boolean;
  pending: boolean;
  standby: boolean;
  issues: boolean;
  cancelled: boolean;
}

// Dati e gestori condivisi da tutte le schede delle pratiche. Costruito in
// App a partire dallo stato e dai gestori esistenti: qui solo presentazione.
export interface Workspace {
  techById: (id?: string) => Technician | undefined;
  selectedTechId: string;          // 'all' = tutti
  selectedAppointmentId: string | null;
  currentDate: string;
  viewMode: ViewMode;
  todayStr: string;
  maxAttempts: number;             // tentativi del pilota (per "tentativo n di N")
  isOptimizing: boolean;
  dragId: string | null;
  dragOverId: string | null;
  query: string;                   // testo della ricerca
  matches: (a: Appointment) => boolean;
  awaitingOutcome: (a: Appointment) => boolean;
  hasStartBase: (techId?: string) => boolean;   // base del tecnico o base generale
  onOpenBaseSettings: () => void;               // porta a Impostazioni (base generale)

  onSelect: (id: string) => void;
  onEdit: (a: Appointment) => void;
  onStatusChange: (id: string, status: AppointmentStatus) => void;
  onRemove: (id: string) => void;
  onCall: (a: Appointment) => void;
  onBulkCall: (list: Appointment[]) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
}
