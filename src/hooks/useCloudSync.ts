import { useEffect, useRef, useState } from 'react';
import type { Appointment } from '../types';
import type { CloudConfig } from '../services/cloudProtocol';
import { CloudSyncEngine, type CloudSyncState } from '../services/cloudSyncCore';

// Pilota in cloud, lato browser: con il cloud attivo (e solo nella scheda
// principale) il browser diventa una finestra sui dati del server. Il nucleo
// (services/cloudSyncCore) scarica, invia le modifiche dell'operatore, chiede
// i passaggi del motore; qui lo si collega a React:
//  - ogni cambio dell'elenco o della configurazione -> engine.localChanged()
//    (se il cambio arriva dal server, il diff è vuoto e non parte nulla);
//  - pagina nascosta / in chiusura -> invio immediato con keepalive;
//  - visibilità -> ritmo del pull (10 s visibile, 30 s nascosta).

interface UseCloudSyncOptions {
  active: boolean;                 // cloud acceso, chiave presente, scheda principale
  cloudKey: string;
  deviceId: string;
  appointments: Appointment[];     // per accorgersi delle modifiche
  configDeps: unknown[];           // tecnici, impostazioni del pilota, orari, base
  appointmentsRef: React.MutableRefObject<Appointment[]>;
  setAppointments: (list: Appointment[]) => void;
  getConfig: () => CloudConfig;
  applyConfig: (config: CloudConfig) => CloudConfig | void;
}

export const useCloudSync = ({
  active, cloudKey, deviceId, appointments, configDeps, appointmentsRef, setAppointments, getConfig, applyConfig,
}: UseCloudSyncOptions): { state: CloudSyncState | null; engineRef: React.MutableRefObject<CloudSyncEngine | null> } => {
  const [state, setState] = useState<CloudSyncState | null>(null);
  const engineRef = useRef<CloudSyncEngine | null>(null);
  const latest = useRef({ setAppointments, getConfig, applyConfig });
  latest.current = { setAppointments, getConfig, applyConfig };

  useEffect(() => {
    if (!active || !cloudKey) { setState(null); return; }
    const engine = new CloudSyncEngine({
      key: cloudKey,
      deviceId,
      host: {
        getAppointments: () => appointmentsRef.current,
        setAppointments: list => latest.current.setAppointments(list),
        getConfig: () => latest.current.getConfig(),
        applyConfig: config => latest.current.applyConfig(config),
        isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
      },
      onState: s => setState(s),
    });
    engineRef.current = engine;
    setState(engine.getState());
    engine.start();

    const onVisibility = () => {
      engine.visibilityChanged();
      if (document.visibilityState === 'hidden') engine.flushNow({ keepalive: true });
      else engine.requestPull();
    };
    const onPageHide = () => engine.flushNow({ keepalive: true, closing: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      engine.destroy();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [active, cloudKey, deviceId, appointmentsRef]);

  // Modifiche locali (o adottate dal server: in quel caso non parte nulla)
  useEffect(() => {
    engineRef.current?.localChanged();
  }, [appointments]);

  useEffect(() => {
    engineRef.current?.localChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, configDeps);

  return { state, engineRef };
};
