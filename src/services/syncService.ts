import type { Appointment } from '../types';
import {
  type SyncResult,
  type SyncTarget,
  getSyncableAppointments,
  isSyncable,
  pushConfirmedToFirestore,
} from './gestionaleSync';

export { getSyncableAppointments, isSyncable };
export type { SyncResult };

// ============================================================
// Sincronizzazione OptiRoute -> Gestionale Effetre (Firestore)
// ============================================================
// Scrive i sopralluoghi CONFERMATI nella collection `optiroute_sync`
// del Firestore del gestionale (via REST, regole aperte). Il gestionale
// legge periodicamente la collection e importa le pratiche nel proprio
// formato, marcando i documenti come importati.
//
// Ambiente: di default si scrive sul progetto di COLLAUDO
// (gestionale-effetre-staging). Per andare in produzione impostare
// VITE_SYNC_ENV=production nel deploy Vercel di OptiRoute.

const SYNC_TARGETS: Record<string, SyncTarget> = {
  staging: {
    projectId: 'gestionale-effetre-staging',
    apiKey: 'AIzaSyBREzp0X64Y2zazMGSDZXLpg59Y6gnOqXw',
  },
  production: {
    projectId: 'gestionale-effetre',
    apiKey: 'AIzaSyAxuZxv3_7w4cR01W4dRrGOJ3-qbSsL868',
  },
};

// Ambiente di destinazione: nel browser arriva da VITE_SYNC_ENV (build);
// il motore lato server lo passa esplicitamente.
const currentEnv = (override?: string): string =>
  override || ((import.meta as any).env?.VITE_SYNC_ENV as string | undefined) || 'staging';

const getTarget = (env?: string): SyncTarget => SYNC_TARGETS[currentEnv(env)] || SYNC_TARGETS.staging;

export const getSyncEnvName = (env?: string): string =>
  currentEnv(env) === 'production' ? 'produzione' : 'collaudo';

// Invio dal browser: destinazione scelta da VITE_SYNC_ENV (o da `env`).
export const syncConfirmedToGestionale = (appointments: Appointment[], env?: string): Promise<SyncResult> =>
  pushConfirmedToFirestore(appointments, getTarget(env), getSyncEnvName(env));
