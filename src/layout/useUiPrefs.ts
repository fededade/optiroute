import { useCallback, useEffect, useState } from 'react';

// Stato di sola interfaccia, con le preferenze ricordate nel browser:
// barra laterale ridotta, mappa nascosta, larghezza del pannello di lavoro.
// (Nessun dato delle pratiche: quelle restano gestite da App.)

const KEY = 'optiroute_ui_v1';

interface UiPrefs {
  navCollapsed: boolean;
  mapHidden: boolean;
  panelPct: number;  // larghezza del pannello di lavoro, % dello spazio accanto alla navigazione
}

const DEFAULTS: UiPrefs = { navCollapsed: false, mapHidden: false, panelPct: 46 };

const load = (): UiPrefs => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw);
    return {
      navCollapsed: typeof v.navCollapsed === 'boolean' ? v.navCollapsed : DEFAULTS.navCollapsed,
      mapHidden: typeof v.mapHidden === 'boolean' ? v.mapHidden : DEFAULTS.mapHidden,
      panelPct: typeof v.panelPct === 'number' && v.panelPct >= 25 && v.panelPct <= 80 ? v.panelPct : DEFAULTS.panelPct,
    };
  } catch {
    return DEFAULTS;
  }
};

export const useViewportWidth = (): number => {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
};

export const useUiPrefs = () => {
  const [prefs, setPrefs] = useState<UiPrefs>(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* spazio pieno o privato: pazienza */ }
  }, [prefs]);
  const update = useCallback((patch: Partial<UiPrefs>) => setPrefs(p => ({ ...p, ...patch })), []);
  return [prefs, update] as const;
};
