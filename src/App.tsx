import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { AlternativeSlot, Appointment, Coordinates, AppointmentStatus, CallOutcome, IssueType, Technician } from './types';
import { geocodeAddress } from './services/geocodingService';
import { parseAddressInput } from './services/geminiService';
import { parseExcelFile, exportAppointmentsToExcel, generateExcelBlob, blobToBase64, extractPhoneFromRow, extractUrgentFromRow, extractCodiceFromRow, parsePraticheMisi } from './services/excelService';
import { optimizeRoute, calculateSchedule, calculateRouteSummary } from './utils/geo';
import { buildDaySchedule as buildDayScheduleText } from './services/dayScheduleService';
import { loadAppointments, saveAppointments, appointmentsFromStorageEvent, loadBase, saveBase, loadSettings, saveSettings, loadAutopilotSettings, loadBridgeSettings } from './services/storageService';
import { loadTechnicians, saveTechnicians, matchTechnician, isFullyUnavailable, workWindowOn } from './services/technicianService';
import { fetchCallOutcome, startConfirmationCall } from './services/callService';
import {
  DEFAULT_AUTOPILOT_SETTINGS,
  type AutopilotSettings,
  type AttentionItem,
  type PlanningContext,
  alternativesForCall,
  approveForCalling,
  attentionItems,
  autopilotStats,
  cancelAutoCalls,
  isCallInFlight,
  reduceCallLaunchResult,
  reduceCallOutcome,
  reduceCallStarted,
} from './services/autopilotService';
import { applyPatches, type AppointmentPatch } from './services/slotService';
import type { BridgeSettings } from './services/bridgeService';
import { type ImportRow, applyImportResult, importRowsToAppointments } from './hooks/importPratiche';
import { useTabLock } from './hooks/useTabLock';
import { useAutopilot, autopilotQueueKey } from './hooks/useAutopilot';
import { useAutoDispatch } from './hooks/useAutoDispatch';
import { useBridgeInbox, type BridgeImportOutcome } from './hooks/useBridgeInbox';
import { useCloudSync } from './hooks/useCloudSync';
import { loadCloudSettings, saveCloudSettings, type CloudSettings } from './services/cloudSettings';
import type { CloudConfig } from './services/cloudProtocol';
import { prepareEmbeddedCloud } from './services/cloudSyncCore';
import { bridgeInboxHere, turnAutomationsHere } from './services/automationTurn';
import { fetchBridgeSnapshotViaParent } from './services/bridgeService';
import type { GestionaleContext } from './Components/GestionaleGate';
import AppointmentModal from './Components/AppointmentModal';
import CallModal from './Components/CallModal';
import BulkCallModal from './Components/BulkCallModal';
import TechnicianModal from './Components/TechnicianModal';
import DispatchModal from './Components/DispatchModal';
import KmzImportModal from './Components/KmzImportModal';
import AutopilotBar from './Components/AutopilotBar';
import AutopilotSettingsModal from './Components/AutopilotSettingsModal';
import ImportProgressModal from './Components/ImportProgressModal';
import SideNav, { type NavCounts } from './layout/SideNav';
import TopBar from './layout/TopBar';
import MapPanel from './layout/MapPanel';
import OverviewSection from './layout/sections/OverviewSection';
import AttentionSection from './layout/sections/AttentionSection';
import PendingSection from './layout/sections/PendingSection';
import ProposalsSection from './layout/sections/ProposalsSection';
import AgendaSection from './layout/sections/AgendaSection';
import ProblemsSection from './layout/sections/ProblemsSection';
import ArchiveSection from './layout/sections/ArchiveSection';
import SettingsSection from './layout/sections/SettingsSection';
import AllPraticheSection from './layout/sections/AllPraticheSection';
import { useUiPrefs, useViewportWidth } from './layout/useUiPrefs';
import type { SectionId, Workspace } from './layout/types';
import { inAgendaRange, longDayLabel, matchesQuery, plural, rangeLabel } from './layout/format';
import { DEFAULT_SORT, filterByStatus, sortPratiche, statusCounts, type SortState, type StatusFilter } from './layout/praticheTable';
import { NAV_ITEMS } from './layout/SideNav';

// --- CONFIGURATION ---
// URL webhook n8n: configurabile via VITE_N8N_WEBHOOK_URL (Method: POST)
const N8N_WEBHOOK_URL = (import.meta as any).env?.VITE_N8N_WEBHOOK_URL || 'https://fededade.app.n8n.cloud/webhook-test/Suca';

const DEFAULT_CENTER: Coordinates = { lat: 41.9028, lng: 12.4964 }; // Rome

type ViewMode = 'day' | 'week' | 'month';

// La riga normalizzata dell'import (ImportRow) e il nucleo che la trasforma
// in pratiche vivono in hooks/importPratiche (condivisi con il bridge).

// Lancio interrotto: la chiamata nuova non ha ancora un id (quello della
// chiamata precedente non deve essere interrogato dal polling dell'esito)
const startCallReducer = reduceCallStarted;

const ALL_TECH = 'all';

const formatDayLabel = (iso?: string): string => {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
};

// `gestionale`: presente solo quando OptiRoute è aperta dentro la pagina del
// gestionale (con l'accesso già verificato, vedi Components/GestionaleGate)
function App({ gestionale }: { gestionale?: GestionaleContext } = {}) {
  const embedded = !!gestionale;
  const [addressInput, setAddressInput] = useState('');
  const [baseInput, setBaseInput] = useState('');

  // Unified List (restored from localStorage)
  const [allAppointments, setAllAppointmentsState] = useState<Appointment[]>(() => loadAppointments());

  // Riferimento SEMPRE aggiornato all'elenco: ogni modifica passa da
  // setAllAppointments, che calcola il nuovo elenco dal ref, lo scrive nel ref
  // in modo sincrono e poi nello stato React. Così il polling, il pilota
  // automatico e lo smistamento vedono subito lo stato nuovo (niente closure
  // stantie, nessuna pratica chiamata due volte).
  const appointmentsRef = useRef<Appointment[]>(allAppointments);
  const setAllAppointments = useCallback((action: Appointment[] | ((prev: Appointment[]) => Appointment[])) => {
    const next = typeof action === 'function' ? action(appointmentsRef.current) : action;
    if (next === appointmentsRef.current) return;
    appointmentsRef.current = next;
    setAllAppointmentsState(next);
  }, []);

  // Technicians (i soggetti che effettuano i sopralluoghi)
  const [technicians, setTechnicians] = useState<Technician[]>(() => loadTechnicians());
  const [selectedTechId, setSelectedTechId] = useState<string>(ALL_TECH);
  const [showTechModal, setShowTechModal] = useState(false);
  const [techModalOpenId, setTechModalOpenId] = useState<string | null>(null);
  const [showDispatchModal, setShowDispatchModal] = useState(false);

  // Selection State
  const [selectedAppointmentId, setSelectedAppointmentId] = useState<string | null>(null);

  const [baseLocation, setBaseLocation] = useState<{coords: Coordinates, address: string} | null>(() => loadBase());
  const [mapCenter, setMapCenter] = useState<Coordinates>(DEFAULT_CENTER);
  const [isLoading, setIsLoading] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isSendingToN8n, setIsSendingToN8n] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');

  // Import Modal State
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFinished, setImportFinished] = useState(false);
  const [importStats, setImportStats] = useState({ success: 0, failed: 0, approx: 0 });
  const [failedImports, setFailedImports] = useState<string[]>([]);
  const [approxImports, setApproxImports] = useState<string[]>([]);

  // Import da Google My Maps (KMZ/KML)
  const [kmzFile, setKmzFile] = useState<File | null>(null);

  // Settings & View
  const [currentDate, setCurrentDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [startTime, setStartTime] = useState(() => loadSettings()?.startTime || "09:00");
  const [endTimeLimit, setEndTimeLimit] = useState(() => loadSettings()?.endTimeLimit || "18:00");
  // Pannello impostazioni/azioni della sidebar: richiudibile per dare spazio all'elenco
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => loadSettings()?.settingsOpen ?? true);

  // Pilota automatico delle chiamate e bridge dei portali
  const [autopilot, setAutopilot] = useState<AutopilotSettings>(() => loadAutopilotSettings());
  const [autopilotIntroSeen, setAutopilotIntroSeen] = useState<boolean>(() => !!loadSettings()?.autopilotIntroSeen);
  const [bridgeSettings, setBridgeSettings] = useState<BridgeSettings>(() => loadBridgeSettings());
  const [attentionOpen, setAttentionOpen] = useState<boolean>(() => loadSettings()?.attentionOpen ?? true);
  const [showAutopilotSettings, setShowAutopilotSettings] = useState(false);
  // Pilota in cloud: con il cloud attivo il motore gira sul server e questo
  // browser è una finestra sui suoi dati (vedi useCloudSync)
  const [cloud, setCloud] = useState<CloudSettings>(() => loadCloudSettings());
  // Dentro il gestionale il cloud è sempre acceso (accesso dal gestionale):
  // chiave e attivazione salvate in questo browser non si usano né si toccano
  const cloudActive = embedded || (cloud.enabled && !!cloud.key);
  const updateCloud = useCallback((next: CloudSettings) => {
    saveCloudSettings(next);
    setCloud(next);
  }, []);
  // Import in corso (file o bridge): mai due import in parallelo, né uno
  // smistamento automatico durante un import
  const importBusyRef = useRef(false);
  const [importBusy, setImportBusy] = useState(false);
  const autoDispatchBusyRef = useRef(false);
  // Orologio della barra del pilota (contatori e "prossima chiamata")
  const [, setClockTick] = useState(0);

  // Appointment add/edit modal
  const [showApptModal, setShowApptModal] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);

  // AI call modal (Retell): singola pratica o coda "Chiama tutte"
  const [callTarget, setCallTarget] = useState<Appointment | null>(null);
  const [bulkCallList, setBulkCallList] = useState<Appointment[] | null>(null);

  // Filters
  const [filters, setFilters] = useState({
      confirmed: true,
      proposed: true,
      pending: true,
      standby: true,
      issues: true,
      cancelled: false
  });

  // Drag & drop: riordino manuale del giro confermato (vista giorno)
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const kmzInputRef = useRef<HTMLInputElement>(null);

  const selectedTech: Technician | null =
    selectedTechId !== ALL_TECH ? technicians.find(t => t.id === selectedTechId) || null : null;

  const techById = useCallback(
    (id?: string): Technician | undefined => (id ? technicians.find(t => t.id === id) : undefined),
    [technicians]
  );

  const technicianNameById: Record<string, string> = Object.fromEntries(
    technicians.map(t => [t.id, t.name])
  );

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((position) => {
        setMapCenter({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        });
      }, () => console.log('Geolocation not allowed'));
    }
  }, []);

  // Persist state locally so a page reload never loses the planning
  useEffect(() => { saveAppointments(allAppointments); }, [allAppointments]);
  useEffect(() => { saveBase(baseLocation); }, [baseLocation]);
  useEffect(() => {
    saveSettings({ startTime, endTimeLimit, settingsOpen, autopilot, autopilotIntroSeen, bridge: bridgeSettings, attentionOpen });
  }, [startTime, endTimeLimit, settingsOpen, autopilot, autopilotIntroSeen, bridgeSettings, attentionOpen]);
  useEffect(() => { saveTechnicians(technicians); }, [technicians]);

  // Se il tecnico selezionato viene eliminato, torna a "Tutti"
  useEffect(() => {
    if (selectedTechId !== ALL_TECH && !technicians.some(t => t.id === selectedTechId)) {
      setSelectedTechId(ALL_TECH);
    }
  }, [technicians, selectedTechId]);

  // Scroll to selected item when it changes
  useEffect(() => {
    if (selectedAppointmentId) {
      const element = document.getElementById(`appt-${selectedAppointmentId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [selectedAppointmentId]);

  // -- Derived Lists --
  const matchesTechFilter = useCallback((appt: Appointment): boolean => {
    if (selectedTechId === ALL_TECH) return true;
    return appt.technicianId === selectedTechId;
  }, [selectedTechId]);

  const getVisibleAppointments = useCallback(() => {
      const selectedDate = new Date(currentDate);

      const isSameWeek = (dateStr?: string) => {
          if (!dateStr) return false;
          const d = new Date(dateStr);
          const startOfWeek = new Date(selectedDate);
          const day = startOfWeek.getDay() || 7;
          if (day !== 1) startOfWeek.setHours(-24 * (day - 1));

          const endOfWeek = new Date(startOfWeek);
          endOfWeek.setDate(startOfWeek.getDate() + 6);

          return d >= startOfWeek && d <= endOfWeek;
      };

      const isSameMonth = (dateStr?: string) => {
          if (!dateStr) return false;
          const d = new Date(dateStr);
          return d.getMonth() === selectedDate.getMonth() && d.getFullYear() === selectedDate.getFullYear();
      };

      return allAppointments.filter((appt: Appointment) => {
          if (!matchesTechFilter(appt)) return false;

          if (appt.status === 'confirmed') {
              if (!filters.confirmed) return false;
              if (viewMode === 'day') return appt.date === currentDate;
              if (viewMode === 'week') return isSameWeek(appt.date);
              if (viewMode === 'month') return isSameMonth(appt.date);
              return false;
          }
          if (appt.status === 'proposed') return filters.proposed;
          if (appt.status === 'pending') return filters.pending;
          if (appt.status === 'standby') return filters.standby;
          if (appt.status === 'issue') return filters.issues;
          if (appt.status === 'cancelled') return filters.cancelled;
          return true;
      });
  }, [allAppointments, filters, currentDate, viewMode, matchesTechFilter]);

  const visibleAppointments = getVisibleAppointments();

  const handleSetBase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!baseInput.trim()) return;
    setIsLoading(true);

    const result = await geocodeAddress(baseInput);
    if (result) {
      setBaseLocation({
        coords: result.coords,
        address: result.displayName
      });
      setMapCenter(result.coords);
      setBaseInput('');
    } else {
      alert("Indirizzo base non trovato.");
    }
    setIsLoading(false);
  };

  const handleAddAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addressInput.trim()) return;

    setIsLoading(true);
    const cleanAddress = await parseAddressInput(addressInput);
    const result = await geocodeAddress(cleanAddress);

    if (result) {
      // Assegnazione automatica del tecnico in base alla zona di competenza
      const matched = matchTechnician({ coords: result.coords, province: result.province }, technicians);

      const newAppointment: Appointment = {
        id: Date.now().toString(),
        address: result.displayName,
        title: cleanAddress,
        coords: result.coords,
        province: result.province,
        comune: result.comune,
        technicianId: matched?.id,
        status: 'pending' // Default to pending
      };

      setAllAppointments(prev => [...prev, newAppointment]);
      setMapCenter(result.coords);
      setAddressInput('');
    } else {
      alert("Indirizzo non trovato.");
    }
    setIsLoading(false);
  };

  // Save from the add/edit modal (create or update)
  const handleSaveAppointment = (appt: Appointment) => {
    setAllAppointments(prev => {
      const exists = prev.some(a => a.id === appt.id);
      return exists ? prev.map(a => (a.id === appt.id ? appt : a)) : [...prev, appt];
    });
    setMapCenter(appt.coords);
    setEditingAppointment(null);
  };

  const openEditModal = (appt: Appointment) => {
    setEditingAppointment(appt);
    setShowApptModal(true);
  };

  const openNewApptModal = () => {
    setEditingAppointment(null);
    setShowApptModal(true);
  };

  const openTechModal = (openId: string | null = null) => {
    setTechModalOpenId(openId);
    setShowTechModal(true);
  };

  const toggleSettingsPanel = () => {
    setSettingsOpen(!settingsOpen);
  };

  // --- AI Call (Retell) handlers ---
  const requestCall = (appt: Appointment) => {
    if (!appt.phone) {
      alert("Questo appuntamento non ha un numero di telefono. Aggiungilo con il tasto Modifica.");
      return;
    }
    setCallTarget(appt);
  };

  // Chiamate in blocco (es. tutte le proposte dopo lo smistamento)
  const requestBulkCall = (appts: Appointment[]) => {
    if (appts.length === 0) return;
    if (!appts.some(a => a.phone)) {
      alert("Nessuna di queste pratiche ha un numero di telefono. Aggiungilo con il tasto Modifica.");
      return;
    }
    setBulkCallList(appts);
  };

  // Tutte le chiamate (singola, in blocco, pilota automatico) passano dagli
  // stessi riduttori: avvio (alternative offerte, esito precedente azzerato:
  // verrà rilevato dal polling) ed esito del lancio.
  const handleCallStarted = (id: string, alternatives: AlternativeSlot[] = []) => {
    const now = new Date();
    setAllAppointments(prev => startCallReducer(prev, id, alternatives, now));
  };

  const handleCallResult = (id: string, ok: boolean, callId?: string, error?: string) => {
    const now = new Date();
    setAllAppointments(prev => reduceCallLaunchResult(prev, id, { ok, callId, error }, now));
  };

  // Esito della telefonata -> categoria problematica (la pratica esce dalla
  // pianificazione; con la data di rientro scatteranno alert e vincoli)
  const handleMarkIssueFromCall = (id: string, issueType: IssueType, followUpDate?: string) => {
    setAllAppointments(prev => prev.map(a => a.id === id
      ? {
          ...a,
          status: 'issue',
          issueType,
          followUpDate: followUpDate || a.followUpDate,
          date: undefined,
          sequenceOrder: undefined,
          startTime: undefined,
          endTime: undefined,
        }
      : a
    ));
  };

  // --- Automatismi: una sola scheda (Web Locks) ---
  // Polling degli esiti, pilota automatico, smistamento automatico e inbox
  // del bridge girano solo nella scheda che ha il lock; le altre schede ne
  // ricevono i risultati tramite l'elenco condiviso (vedi sotto).
  const tabLock = useTabLock('optiroute-automazione');
  const isAutomationTab = tabLock === 'leader';

  // Più schede aperte: ognuna adotta l'elenco salvato dalle altre, così
  // nessuna lavora (e salva) su una copia vecchia delle pratiche.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const next = appointmentsFromStorageEvent(e.key, e.newValue);
      if (!next) return;
      if (JSON.stringify(next) === JSON.stringify(appointmentsRef.current)) return;
      setAllAppointments(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setAllAppointments]);

  // Cloud attivato/scollegato da un'altra scheda: la barra resta coerente
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'optiroute_cloud_v1') return;
      const next = loadCloudSettings();
      setCloud(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // --- Esito chiamata via polling: la risposta del cliente determina lo stato ---

  const CALL_POLL_INTERVAL_MS = 12000;
  const CALL_POLL_MAX_AGE_MS = 45 * 60 * 1000; // oltre: ultimo recupero reale, poi "sconosciuto"

  const awaitingCallOutcome = useCallback((a: Appointment): boolean =>
    !!a.callId && !a.callOutcome && !!a.calledAt &&
    (a.callStatus === 'calling' || a.callStatus === 'called'),
  []);

  const isOutcomePastCutoff = (a: Appointment): boolean =>
    !!a.calledAt && (Date.now() - new Date(a.calledAt).getTime()) >= CALL_POLL_MAX_AGE_MS;

  // --- Contesto di pianificazione per i riduttori del pilota ---
  // Costruito al momento da ref sempre aggiornati (tecnici, impostazioni,
  // orari e base generali dell'app come fallback), con l'ora corrente.
  const techniciansRef = useRef(technicians);
  techniciansRef.current = technicians;
  const autopilotRef = useRef(autopilot);
  autopilotRef.current = autopilot;
  const fallbackRef = useRef<CloudConfig['fallback']>({ start: startTime, end: endTimeLimit, base: baseLocation?.coords || null, baseAddress: baseLocation?.address });
  fallbackRef.current = { start: startTime, end: endTimeLimit, base: baseLocation?.coords || null, baseAddress: baseLocation?.address };

  const getPlanningContext = useCallback((): PlanningContext => ({
    technicians: techniciansRef.current,
    fallback: fallbackRef.current,
    settings: autopilotRef.current,
    now: new Date(),
  }), []);

  // --- Pilota in cloud: sincronizzazione (solo nella scheda principale) ---
  // Configurazione condivisa col motore del server: tecnici, impostazioni del
  // pilota, orari e base generali. Letta dai ref (sempre aggiornati).
  const getCloudConfig = useCallback((): CloudConfig => ({
    technicians: techniciansRef.current,
    autopilot: autopilotRef.current,
    fallback: fallbackRef.current,
  }), []);

  // Configurazione arrivata dal server: si applica allo stato (e quindi al
  // localStorage). I ref si aggiornano subito, così il confronto con l'ultima
  // sincronizzata non fa ripartire una push.
  const applyCloudConfig = useCallback((cfg: CloudConfig): CloudConfig => {
    const technicians = Array.isArray(cfg.technicians) ? cfg.technicians : techniciansRef.current;
    const autopilotNext: AutopilotSettings = { ...DEFAULT_AUTOPILOT_SETTINGS, ...(cfg.autopilot || {}) };
    const base = cfg.fallback?.base ?? null;
    const fallback: CloudConfig['fallback'] = {
      start: cfg.fallback?.start || fallbackRef.current.start,
      end: cfg.fallback?.end || fallbackRef.current.end,
      base,
      // l'indirizzo della base viaggia con la configurazione (se manca: coordinate)
      baseAddress: base ? cfg.fallback?.baseAddress || `Base (${base.lat.toFixed(4)}, ${base.lng.toFixed(4)})` : undefined,
    };
    techniciansRef.current = technicians;
    autopilotRef.current = autopilotNext;
    fallbackRef.current = fallback;
    setTechnicians(technicians);
    setAutopilot(autopilotNext);
    setStartTime(fallback.start);
    setEndTimeLimit(fallback.end);
    setBaseLocation(prev => {
      if (!fallback.base) return null;
      const address = fallback.baseAddress || '';
      if (prev && prev.coords.lat === fallback.base.lat && prev.coords.lng === fallback.base.lng && prev.address === address) return prev;
      return { coords: fallback.base, address };
    });
    return { technicians, autopilot: autopilotNext, fallback };
  }, []);

  // Dentro il gestionale, prima di avviare la sincronizzazione: se il cloud è
  // vuoto lo si inizializza con i dati di questo browser, altrimenti vincono
  // i dati del cloud (come in un browser che aveva già il cloud attivo)
  const [embeddedCloudReady, setEmbeddedCloudReady] = useState(false);
  useEffect(() => {
    if (!gestionale || !isAutomationTab || embeddedCloudReady) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      const r = await prepareEmbeddedCloud(
        { key: '', credential: gestionale.session.credential },
        { deviceId: cloud.deviceId, appointments: appointmentsRef.current, config: getCloudConfig() }
      );
      if (cancelled) return;
      if (r.ok) setEmbeddedCloudReady(true);
      else timer = setTimeout(() => { void attempt(); }, 5000);
    };
    void attempt();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [gestionale, isAutomationTab, embeddedCloudReady, cloud.deviceId, getCloudConfig]);

  const cloudSync = useCloudSync({
    active: cloudActive && isAutomationTab && (!embedded || embeddedCloudReady),
    cloudKey: embedded ? '' : cloud.key,
    credential: gestionale?.session.credential,
    deviceId: cloud.deviceId,
    appointments: allAppointments,
    configDeps: [technicians, autopilot, startTime, endTimeLimit, baseLocation],
    appointmentsRef,
    setAppointments: setAllAppointments,
    getConfig: getCloudConfig,
    applyConfig: applyCloudConfig,
  });
  // Smistamento automatico e inbox del bridge: con il cloud, un solo
  // dispositivo alla volta (quello che ha il turno). Dentro il gestionale
  // l'inbox del bridge gira comunque qui (vedi services/automationTurn)
  const cloudLeaseHolder = cloudSync.state?.lease?.holder === true;
  const automationPlace = { embedded, isAutomationTab, cloudActive, leaseHolder: cloudLeaseHolder };
  const browserAutomationsHere = turnAutomationsHere(automationPlace);
  const bridgeHere = bridgeInboxHere(automationPlace);

  // Applica l'esito della conversazione alla pratica (riduttore puro del
  // pilota). Pilota spento: mappatura di sempre (confermato -> Confermata,
  // riprogrammare -> In Attesa, da_richiamare/numero_errato/lavori ->
  // Problematiche, annullato, rifiutato -> Stand-by, altro_referente ->
  // nuovo numero) più le date rifiutate e le alternative accettate in
  // chiamata. Pilota acceso: anche richiami e rimpiazzo dello slot liberato.
  const applyCallOutcome = useCallback((id: string, outcome: CallOutcome, expectedCallId?: string) => {
    const ctx = getPlanningContext();
    setAllAppointments(prev => reduceCallOutcome(prev, id, outcome, expectedCallId, ctx));
  }, [getPlanningContext, setAllAppointments]);

  // (appointmentsRef, definito in alto, è il riferimento sempre aggiornato:
  // il polling legge da lì senza dover ricreare il timer a ogni modifica.)

  // Chiave stabile: cambia solo quando cambia l'insieme delle chiamate da monitorare
  const callPollKey = allAppointments.filter(awaitingCallOutcome).map(a => a.id).sort().join('|');
  const outcomePollInFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Con il cloud attivo gli esiti li applica il server (arrivano col pull)
    if (!callPollKey || !isAutomationTab || cloudActive) return;
    let cancelled = false;

    const tick = async () => {
      const targets = appointmentsRef.current.filter(awaitingCallOutcome);
      for (const appt of targets) {
        if (cancelled) return;
        if (outcomePollInFlight.current.has(appt.id)) continue;
        outcomePollInFlight.current.add(appt.id);
        try {
          // Anche a finestra scaduta si tenta UN recupero reale: l'esito su
          // Retell è spesso già pronto (es. app riaperta il giorno dopo).
          // Solo se ancora pending si chiude a "sconosciuto".
          const poll = await fetchCallOutcome(appt.callId!);
          if (cancelled) return;
          if (!poll.pending && poll.outcome) {
            applyCallOutcome(appt.id, poll.outcome, appt.callId);
          } else if (isOutcomePastCutoff(appt)) {
            applyCallOutcome(appt.id, {
              result: 'sconosciuto',
              summary: 'Esito non ricevuto nei tempi: controlla la dashboard Retell.',
              receivedAt: new Date().toISOString(),
            }, appt.callId);
          }
        } finally {
          outcomePollInFlight.current.delete(appt.id);
        }
      }
    };

    const firstCheck = setTimeout(tick, 4000); // primo controllo poco dopo l'avvio
    const timer = setInterval(tick, CALL_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(firstCheck); clearInterval(timer); };
  }, [callPollKey, isAutomationTab, cloudActive, awaitingCallOutcome, applyCallOutcome]);

  // Agenda del giorno per l'agente AI: fasce già impegnate del giro dello
  // stesso tecnico, così al telefono può rispondere onesto sulle richieste
  // di spostamento senza impegnare slot in diretta.
  const buildDaySchedule = (appt: Appointment): string =>
    buildDayScheduleText(appt, appointmentsRef.current, technicians, { start: startTime, end: endTimeLimit }, currentDate);
  const buildDayScheduleRef = useRef(buildDaySchedule);
  buildDayScheduleRef.current = buildDaySchedule;

  // Alternative reali che l'agente potrà offrire, calcolate sullo stato
  // attuale subito prima di chiamare
  const buildAlternatives = useCallback((appt: Appointment): AlternativeSlot[] => {
    const all = appointmentsRef.current;
    const current = all.find(a => a.id === appt.id) || appt;
    return alternativesForCall(current, all, getPlanningContext());
  }, [getPlanningContext]);

  // Chiamata lanciata dal pilota automatico: stesso percorso delle manuali
  const performAutoCall = useCallback(async (appt: Appointment): Promise<void> => {
    const current = appointmentsRef.current.find(a => a.id === appt.id) || appt;
    const alternatives = buildAlternatives(current);
    const startedAt = new Date();
    setAllAppointments(prev => startCallReducer(prev, current.id, alternatives, startedAt));
    const tech = techniciansRef.current.find(t => t.id === current.technicianId);
    const result = await startConfirmationCall(current, tech?.name, buildDayScheduleRef.current(current), alternatives);
    const now = new Date();
    setAllAppointments(prev => reduceCallLaunchResult(prev, current.id, result, now));
  }, [buildAlternatives, setAllAppointments]);

  useAutopilot({
    // Con il cloud attivo i lanci li fa il motore sul server
    active: autopilot.enabled && isAutomationTab && !cloudActive,
    appointmentsRef,
    commit: setAllAppointments,
    getContext: getPlanningContext,
    launchCall: performAutoCall,
    queueKey: autopilotQueueKey(allAppointments),
  });

  // Pilota acceso/spento da un'altra scheda: la barra resta coerente
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'optiroute_settings_v1') return;
      const next = loadAutopilotSettings();
      setAutopilot(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Barra del pilota: contatori e orari aggiornati anche senza modifiche
  useEffect(() => {
    if (!autopilot.enabled) return;
    const timer = setInterval(() => setClockTick(n => n + 1), 15000);
    return () => clearInterval(timer);
  }, [autopilot.enabled]);

  const isImportOrDispatchBusy = useCallback(() => importBusyRef.current || autoDispatchBusyRef.current, []);
  const setAutoDispatchBusy = useCallback((busy: boolean) => { autoDispatchBusyRef.current = busy; }, []);

  const autoDispatch = useAutoDispatch({
    active: autopilot.enabled && autopilot.autoDispatch && browserAutomationsHere,
    blocked: importBusy || showDispatchModal,
    appointments: allAppointments,
    appointmentsRef,
    technicians,
    fallbackBase: baseLocation?.coords || null,
    settings: autopilot,
    commit: setAllAppointments,
    isBusy: isImportOrDispatchBusy,
    setBusy: setAutoDispatchBusy,
  });

  // Attende la fine di un altro import / smistamento automatico (max ~2 minuti)
  const waitImportSlot = async (onWait?: () => void): Promise<void> => {
    for (let i = 0; i < 240 && isImportOrDispatchBusy(); i++) {
      onWait?.();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  // Import silenzioso dal bridge: nuove pratiche (nucleo comune) + telefoni
  // arrivati sulle pratiche che non l'avevano (mai sovrascritti)
  const importFromBridge = useCallback(async (
    rows: ImportRow[],
    phoneUpdates: { id: string; changes: Partial<Appointment> }[]
  ): Promise<BridgeImportOutcome> => {
    importBusyRef.current = true;
    setImportBusy(true);
    try {
      const result = rows.length > 0
        ? await importRowsToAppointments(rows, appointmentsRef.current, techniciansRef.current)
        : { newAppointments: [], updates: new Map<string, Partial<Appointment>>(), failures: [], approximates: [] };
      // Le pratiche già presenti le gestisce il diff (solo telefono mancante)
      result.updates.clear();
      const phoneById = new Map(phoneUpdates.map(u => [u.id, u.changes]));
      let updated = 0;
      setAllAppointments(prev => applyImportResult(prev, result).map(a => {
        const changes = phoneById.get(a.id);
        if (!changes || a.phone?.trim()) return a;
        updated += 1;
        return { ...a, ...changes };
      }));
      return { added: result.newAppointments.length, updated, failed: result.failures.length };
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  }, [setAllAppointments]);

  // Dentro il gestionale le pratiche del bridge arrivano tramite la sua pagina
  const bridgeViaParent = useMemo(
    () => (gestionale ? () => fetchBridgeSnapshotViaParent((m, p, o) => gestionale.host.request(m, p, o)) : undefined),
    [gestionale]
  );

  const bridgeInbox = useBridgeInbox({
    settings: bridgeSettings,
    isLeader: bridgeHere,
    appointmentsRef,
    importBridge: importFromBridge,
    isImportBusy: isImportOrDispatchBusy,
    followerMessage: cloudActive && isAutomationTab ? 'Bridge: gestito da un altro dispositivo collegato al cloud' : undefined,
    source: bridgeViaParent,
  });

  // Il gestionale avvisa che il bridge ha novità: si scarica subito
  const bridgeHereRef = useRef(bridgeHere);
  bridgeHereRef.current = bridgeHere;
  const bridgeSyncNow = bridgeInbox.syncNow;
  useEffect(() => {
    if (!gestionale) return;
    return gestionale.host.on('bridge.updated', () => {
      if (bridgeHereRef.current) void bridgeSyncNow();
    });
  }, [gestionale, bridgeSyncNow]);

  // Elenco delle pratiche cambiato: circa 3 secondi dopo si avvisa il
  // gestionale ("changed"), che rilegge i sopralluoghi confermati. Se le
  // modifiche non sono ancora arrivate al server si aspetta un poco.
  const cloudPendingRef = useRef(false);
  cloudPendingRef.current = cloudSync.state?.pending === true;
  const firstListRef = useRef(true);
  useEffect(() => {
    if (!gestionale) return;
    if (firstListRef.current) { firstListRef.current = false; return; }
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const fire = () => {
      if (cloudPendingRef.current && tries < 10) { tries += 1; timer = setTimeout(fire, 1000); return; }
      gestionale.host.request('changed', {}).catch(() => { /* solo un suggerimento */ });
    };
    timer = setTimeout(fire, 3000);
    return () => clearTimeout(timer);
  }, [allAppointments, gestionale]);

  // --- Cloud: attivazione, chiave, scollegamento (dalle impostazioni) ---
  const getLocalCloudData = () => ({ appointments: appointmentsRef.current, config: getCloudConfig() });
  const handleCloudActivate = (key: string) => updateCloud({ ...cloud, key, enabled: true });
  const handleCloudKeySave = (key: string) => updateCloud({ ...cloud, key });
  // Scollegato: il pilota continua sul cloud; qui il pilota LOCALE si spegne
  // (la sincronizzazione si ferma nello stesso aggiornamento: la modifica non
  // arriva al server), per non avere due motori sugli stessi clienti
  const handleCloudDisconnect = () => {
    updateCloud({ ...cloud, enabled: false });
    setAutopilot(s => ({ ...s, enabled: false }));
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset Import State
    setShowImportModal(true);
    setImportFinished(false);
    setImportStats({ success: 0, failed: 0, approx: 0 });
    setFailedImports([]);
    setApproxImports([]);
    setUploadProgress('Lettura file in corso...');
    let ownsImportSlot = false;

    try {
      // 1) Formato strutturato: colonne Intestatario/Indirizzo/Comune
      //    (+ Telefono/Note/Urgente/Codice). È anche il formato prodotto dal
      //    bridge Prelios (giro arricchito).
      let importRows: ImportRow[] = [];
      let excludedInfo = '';

      const rows = await parseExcelFile(file);
      const validRows = rows.filter(r => r.Indirizzo && r.Comune);

      if (validRows.length > 0) {
        importRows = validRows.map(row => ({
          title: row.Intestatario || `${row.Indirizzo} ${row['N.Civ.'] || ''}`.trim(),
          street: `${row.Indirizzo}`,
          civic: row['N.Civ.'] !== undefined && row['N.Civ.'] !== null ? `${row['N.Civ.']}` : undefined,
          fullAddress: `${row.Indirizzo} ${row['N.Civ.'] || ''}, ${row.Comune}, ${row['Prov.'] || ''}`.trim(),
          shortAddress: `${row.Indirizzo} ${row['N.Civ.'] || ''}`.trim(),
          comune: row.Comune ? `${row.Comune}`.trim() : undefined,
          province: row['Prov.'] ? `${row['Prov.']}` : undefined,
          phone: extractPhoneFromRow(row),
          notes: row.Note ? `${row.Note}`.trim() : undefined,
          urgent: extractUrgentFromRow(row),
          codice: extractCodiceFromRow(row),
        }));
      } else {
        // 2) Elenco pratiche MISI grezzo (export Prelios): SOLO tipologia FULL - Acquisto
        const { selected, excluded } = await parsePraticheMisi(file);
        importRows = selected.map(p => ({
          title: p.intestatario || `${p.via} ${p.civico}`.trim(),
          street: p.via,
          civic: p.civico || undefined,
          fullAddress: `${p.via} ${p.civico}, ${p.comune}, ${p.provincia}`.trim(),
          shortAddress: `${p.via} ${p.civico}`.trim(),
          comune: p.comune,
          province: p.provincia || undefined,
          notes: p.noteGestore || undefined,
          codice: p.codice,
          project: p.progetto || undefined,
        }));
        if (excluded > 0) excludedInfo = ` — ${excluded} escluse (non FULL - Acquisto)`;
      }

      if (importRows.length === 0) {
        setUploadProgress("Errore: Nessuna riga valida trovata (formati supportati: elenco pratiche MISI o colonne Indirizzo/Comune).");
        setTimeout(() => setShowImportModal(false), 3000);
        return;
      }

      // Mai in parallelo a un import dal bridge o a uno smistamento automatico
      await waitImportSlot(() => setUploadProgress('Attendo la fine dell\'import automatico in corso...'));
      importBusyRef.current = true;
      ownsImportSlot = true;
      setImportBusy(true);

      // Merge per codice pratica, geocoding con fallback, tecnico per zona:
      // nucleo comune con l'inbox del bridge (hooks/importPratiche)
      const { newAppointments, updates, failures, approximates } = await importRowsToAppointments(
        importRows,
        appointmentsRef.current,
        technicians,
        (processedCount, total) => setUploadProgress(`Elaborazione pratica ${processedCount} di ${total}...${excludedInfo}`)
      );

      setAllAppointments(prev => applyImportResult(prev, { newAppointments, updates }));

      setImportStats({ success: newAppointments.length + updates.size, failed: failures.length, approx: approximates.length });
      setFailedImports(failures);
      setApproxImports(approximates);
      setImportFinished(true);
      setUploadProgress(updates.size > 0
        ? `Completato! ${newAppointments.length} nuove, ${updates.size} aggiornate (telefono/note).${excludedInfo}`
        : `Completato!${excludedInfo}`);

    } catch (error) {
      console.error(error);
      setUploadProgress("Errore durante la lettura del file.");
    } finally {
      if (ownsImportSlot) {
        importBusyRef.current = false;
        setImportBusy(false);
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // --- Import da Google My Maps (KMZ/KML) ---
  const handleKmzSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setKmzFile(file);
    if (kmzInputRef.current) kmzInputRef.current.value = '';
  };

  const handleKmzApply = (imported: Appointment[]) => {
    if (imported.length === 0) return;
    setAllAppointments(prev => [...prev, ...imported]);
    setMapCenter(imported[0].coords);
  };

  const getExportPool = () => {
    // "Mostrate ora": l'elenco della tabella (ricerca o Tutte le pratiche)
    // oppure, nelle altre sezioni, visibleAppointments come sempre
    const pool = shownNow;
    if (pool.length === 0) return null;
    return [...pool].sort((a: Appointment, b: Appointment) => {
        if (a.technicianId !== b.technicianId) return (a.technicianId || 'zzz').localeCompare(b.technicianId || 'zzz');
        if (a.date !== b.date && a.date && b.date) return a.date.localeCompare(b.date);
        return (a.sequenceOrder||0) - (b.sequenceOrder||0);
    });
  };

  const handleExport = () => {
    const sortedAppts = getExportPool();
    if (!sortedAppts) {
      alert("Nessun appuntamento da esportare nella vista corrente.");
      return;
    }
    const filename = `Planning_${viewMode === 'day' ? currentDate : 'Export'}.xlsx`;
    exportAppointmentsToExcel(sortedAppts, filename, technicianNameById);
  };

  const handleSendToN8n = async () => {
      const sortedAppts = getExportPool();
      if (!sortedAppts) {
          alert("Nessun dato da inviare.");
          return;
      }

      setIsSendingToN8n(true);
      try {
          // 1. Genera BLOB del file
          const blob = await generateExcelBlob(sortedAppts, technicianNameById);
          if (blob.size === 0) throw new Error("Il file Excel generato è vuoto.");

          // 2. Genera BASE64 string del file (Backup per n8n text field)
          const base64String = await blobToBase64(blob);

          const filename = `Planning_${viewMode === 'day' ? currentDate : 'Export'}.xlsx`;
          const reportName = `Planning ${viewMode === 'day' ? currentDate : 'Export'}`;

          // Use FormData to send as a file upload (multipart/form-data)
          const formData = new FormData();

          // Metodo Principale: File Binario
          formData.append('data', blob, filename);

          // Metadati
          formData.append('reportName', reportName);
          formData.append('generatedAt', new Date().toISOString());

          // BACKUP: Invia anche il file come stringa Base64 nel caso il binario venga perso
          formData.append('file_base64', base64String);
          formData.append('file_name', filename);

          console.log("Sending to n8n:", N8N_WEBHOOK_URL);

          const response = await fetch(N8N_WEBHOOK_URL, {
              method: 'POST',
              body: formData,
              headers: {
                  'Accept': 'application/json',
              }
          });

          if (response.ok) {
              alert("File inviato a n8n! (Controlla sia l'allegato binario che il campo 'file_base64' se l'allegato manca).");
          } else {
              const text = await response.text();
              console.error("N8n Error Response:", text);
              alert(`Errore n8n (${response.status}): ${text || response.statusText}`);
          }
      } catch (error: any) {
          console.error("Submission Error", error);
          if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
              const tryBlindly = window.confirm(
                  "Errore di Connessione (Network/CORS).\n\n" +
                  "Vuoi riprovare in modalità 'Blind Mode' (senza controllo risposta)?\n" +
                  "Questo invierà sia il file binario che una stringa Base64 di backup."
              );

              if (tryBlindly) {
                 try {
                     const blob = await generateExcelBlob(sortedAppts, technicianNameById);
                     const base64String = await blobToBase64(blob);

                     const filename = `Planning.xlsx`;
                     const formData = new FormData();

                     // Attach everything again
                     formData.append('data', blob, filename);
                     formData.append('reportName', `Planning - Blind Mode`);
                     formData.append('file_base64', base64String);
                     formData.append('file_name', filename);

                     await fetch(N8N_WEBHOOK_URL, {
                         method: 'POST',
                         body: formData,
                         mode: 'no-cors'
                     });
                     alert("Inviato in modalità blind! Controlla in n8n il campo 'file_base64' se l'allegato manca.");
                 } catch (blindErr) {
                     alert("Fallito anche in modalità blind.");
                 }
              }
          } else {
              alert(`Errore durante l'invio: ${error.message}`);
          }
      } finally {
          setIsSendingToN8n(false);
      }
  };

  const closeImportModal = () => {
      setShowImportModal(false);
      setImportFinished(false);
      setImportStats({ success: 0, failed: 0, approx: 0 });
      setFailedImports([]);
      setApproxImports([]);
  };

  const handleStatusChange = (id: string, newStatus: AppointmentStatus) => {
    const target = allAppointments.find(a => a.id === id);
    if (!target) return;

    // Conferma di una proposta: mantiene la data/orario proposti dallo smistamento
    const keepProposal = newStatus === 'confirmed' && target.status === 'proposed' && !!target.date;
    const confirmDate = keepProposal ? target.date! : currentDate;

    setAllAppointments((prev: Appointment[]) => prev.map((a: Appointment) => {
        if (a.id !== id) return a;

        const update: Partial<Appointment> = { status: newStatus };
        if (newStatus === 'confirmed') {
            update.date = confirmDate;
        } else {
            update.date = undefined;
            update.sequenceOrder = undefined;
            update.startTime = undefined;
            update.endTime = undefined;
        }
        // Uscendo dalla categoria problematica, la categoria si azzera; il
        // followUpDate resta: lo smistamento non proporrà date precedenti.
        if (newStatus !== 'issue') {
            update.issueType = undefined;
        }
        return { ...a, ...update };
    }));

    // La vista segue la conferma (vedi handleConfirmDay)
    if (newStatus === 'confirmed') {
        setCurrentDate(confirmDate);
        setViewMode('day');
    }

    // On confirmation, propose the AI confirmation call if a phone number exists
    if (newStatus === 'confirmed' && target?.phone && target.callStatus !== 'called') {
        setCallTarget({ ...target, status: 'confirmed', date: confirmDate });
    }
  };

  // Conferma in blocco tutte le proposte di un tecnico per una data
  const handleConfirmDay = (technicianId: string | undefined, date: string) => {
    setAllAppointments(prev => prev.map(a =>
      a.status === 'proposed' && a.technicianId === technicianId && a.date === date
        ? { ...a, status: 'confirmed' }
        : a
    ));
    // La vista segue la conferma: senza questo salto le confermate "spariscono"
    // (vivono sulla loro data mentre la vista resta su oggi)
    setCurrentDate(date);
    setViewMode('day');
  };

  // Riordino di un giro PROPOSTO (drag & drop): ricalcola gli orari con le
  // stime, come lo smistamento — nessuna rete, istantaneo. La data e il
  // tecnico del gruppo restano quelli della pratica trascinata.
  const rescheduleProposedGroup = async (orderedList: Appointment[], sample: Appointment) => {
    if (orderedList.length === 0) return;

    // Orari e base del tecnico del giro (fallback: impostazioni generali)
    const tech = techById(sample.technicianId);
    let dayStart = startTime;
    let dayEnd = endTimeLimit;
    let base = baseLocation?.coords || null;
    if (tech) {
      const window = workWindowOn(tech, sample.date!);
      if (window) { dayStart = window.start; dayEnd = window.end; }
      base = tech.baseCoords || baseLocation?.coords || null;
    }

    setIsOptimizing(true);
    try {
      const [startH, startM] = dayStart.split(':').map(n => parseInt(n, 10));
      const [endH, endM] = dayEnd.split(':').map(n => parseInt(n, 10));

      const { scheduled, overflow } = await calculateSchedule(
        orderedList,
        base,
        startH,
        startM || 0,
        endH,
        20,
        { useEstimates: true, startFromBase: true, maxEndTimeMinutes: endM || 0 }
      );

      const scheduledById = new Map(scheduled.map(s => [s.id, s]));
      const overflowIds = new Set(overflow.map(o => o.id));

      setAllAppointments(prev => prev.map(a => {
        const calculated = scheduledById.get(a.id);
        if (calculated) return { ...a, ...calculated, status: 'proposed', date: sample.date };
        if (overflowIds.has(a.id)) {
          return { ...a, status: 'pending', date: undefined, sequenceOrder: undefined, startTime: undefined, endTime: undefined };
        }
        return a;
      }));

      if (overflow.length > 0) {
        alert(`Con questo ordine ${overflow.length === 1 ? 'un sopralluogo non rientra' : `${overflow.length} sopralluoghi non rientrano`} più nell'orario di lavoro: ${overflow.length === 1 ? 'è tornato' : 'sono tornati'} "In Attesa".`);
      }
    } catch (error) {
      console.error('Reorder failed', error);
    } finally {
      setIsOptimizing(false);
    }
  };

  // Applica gli esiti dello smistamento (stato 'proposed' + assegnazioni) e
  // il riordino delle tappe già nel giro (sequenza e viaggi, mai gli orari)
  const handleApplyDispatch = (updates: Appointment[], patches: AppointmentPatch[] = []) => {
    const byId = new Map(updates.map(u => [u.id, u]));
    setAllAppointments(prev => applyPatches(prev.map(a => byId.get(a.id) || a), patches));
  };

  const handleOptimize = useCallback(async () => {
    // Con un tecnico selezionato si ottimizza il SUO giro (base, orari e
    // indisponibilità suoi); con "Tutti" si ottimizza il pool non assegnato
    // (comportamento storico, base generale).
    const tech = selectedTech;

    const inPool = (a: Appointment) =>
      tech ? a.technicianId === tech.id : !a.technicianId;

    const activePool = allAppointments.filter(a =>
        inPool(a) && ((a.status === 'confirmed' && a.date === currentDate) || a.status === 'pending')
    );

    if (activePool.length < 1) {
        const assignedPending = allAppointments.filter(a => a.status === 'pending' && a.technicianId).length;
        if (!tech && assignedPending > 0) {
            alert("Le pratiche in attesa sono assegnate ai tecnici: seleziona un tecnico (chip in alto) per ottimizzare il suo giro, oppure usa \"Smista pratiche\" per pianificare tutto.");
        }
        return;
    }

    let dayStart = startTime;
    let dayEnd = endTimeLimit;
    let base = baseLocation?.coords || null;

    if (tech) {
        const window = workWindowOn(tech, currentDate);
        if (!window) {
            alert(`${tech.name} non è disponibile il ${currentDate} (vedi scheda tecnico).`);
            return;
        }
        dayStart = window.start;
        dayEnd = window.end;
        base = tech.baseCoords || baseLocation?.coords || null;
    }

    setIsOptimizing(true);

    try {
      const sorted = optimizeRoute(activePool, base);

      const startH = parseInt(dayStart.split(':')[0]);
      const startM = parseInt(dayStart.split(':')[1]);
      const endH = parseInt(dayEnd.split(':')[0]);
      const endM = parseInt(dayEnd.split(':')[1]) || 0;

      const { scheduled, overflow } = await calculateSchedule(
        sorted,
        base,
        startH,
        startM,
        endH,
        20,
        { maxEndTimeMinutes: endM, startFromBase: !!tech && !!tech.baseCoords }
      );

      const scheduledIds = new Set(scheduled.map(a => a.id));
      const overflowIds = new Set(overflow.map(a => a.id));

      setAllAppointments((prev: Appointment[]) => prev.map((a: Appointment) => {
          if (scheduledIds.has(a.id)) {
              const calculated = scheduled.find(s => s.id === a.id);
              return {
                  ...a,
                  ...calculated,
                  status: 'confirmed',
                  date: currentDate
              };
          } else if (overflowIds.has(a.id)) {
              return {
                  ...a,
                  status: 'pending',
                  date: undefined,
                  sequenceOrder: undefined,
                  startTime: undefined,
                  endTime: undefined
              };
          }
          return a;
      }));

    } catch (error) {
      console.error("Optimization failed", error);
      alert("Errore calcolo.");
    } finally {
      setIsOptimizing(false);
    }
  }, [allAppointments, currentDate, baseLocation, startTime, endTimeLimit, selectedTech]);

  // Ricalcola orari e sequenza del giro (di un tecnico o del pool non
  // assegnato) per la giornata corrente, rispettando l'ordine passato.
  const rescheduleDay = async (orderedList: Appointment[], routeTechId?: string) => {
    if (orderedList.length === 0) return;
    const routeTech = techById(routeTechId);

    setIsOptimizing(true);
    try {
      let dayStart = startTime;
      let dayEnd = endTimeLimit;
      let base = baseLocation?.coords || null;
      if (routeTech) {
          const window = workWindowOn(routeTech, currentDate);
          if (window) { dayStart = window.start; dayEnd = window.end; }
          base = routeTech.baseCoords || baseLocation?.coords || null;
      }

      const startH = parseInt(dayStart.split(':')[0]);
      const startM = parseInt(dayStart.split(':')[1]);
      const endH = parseInt(dayEnd.split(':')[0]);
      const endM = parseInt(dayEnd.split(':')[1]) || 0;

      const { scheduled, overflow } = await calculateSchedule(
          orderedList,
          base,
          startH,
          startM,
          endH,
          20,
          { maxEndTimeMinutes: endM, startFromBase: !!routeTech && !!routeTech.baseCoords }
      );

      const scheduledIds = new Set(scheduled.map(a => a.id));
      const overflowIds = new Set(overflow.map(a => a.id));

      setAllAppointments((prev: Appointment[]) => prev.map((a: Appointment) => {
          if (scheduledIds.has(a.id)) {
              const calculated = scheduled.find(s => s.id === a.id);
              return { ...a, ...calculated, status: 'confirmed', date: currentDate };
          } else if (overflowIds.has(a.id)) {
              return { ...a, status: 'pending', date: undefined, sequenceOrder: undefined, startTime: undefined, endTime: undefined };
          }
          return a;
      }));
    } catch (e) { console.error(e); }
    finally { setIsOptimizing(false); }
  };

  // --- Drag & drop: tieni premuto e trascina una scheda confermata per
  // riordinare il giro; gli orari si ricalcolano subito. ---
  const canDragReorder = viewMode === 'day' && !isOptimizing;

  const sameRoute = (a?: Appointment, b?: Appointment): boolean =>
    !!a && !!b && a.status === b.status &&
    (a.status === 'confirmed' || a.status === 'proposed') &&
    a.technicianId === b.technicianId && a.date === b.date;

  const handleDragStart = (e: React.DragEvent, id: string) => {
    // setData è necessario perché il drag parta anche su Firefox
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDragId(id);
  };

  const handleDragOverCard = (e: React.DragEvent, targetId: string) => {
    if (!dragId) {
      // Stato non ancora aggiornato (primissimo dragover): consenti il drop,
      // sarà handleDropOnCard a validare il giro.
      if (e.dataTransfer.types.includes('text/plain')) e.preventDefault();
      return;
    }
    if (dragId === targetId) return;
    const dragged = allAppointments.find(a => a.id === dragId);
    const target = allAppointments.find(a => a.id === targetId);
    // Riordino valido solo dentro il giro dello stesso tecnico, stessa giornata
    if (!sameRoute(dragged, target)) return;
    e.preventDefault(); // consente il drop
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== targetId) setDragOverId(targetId);
  };

  const handleDropOnCard = async (e: React.DragEvent, targetId: string) => {
    const draggedId = dragId || e.dataTransfer.getData('text/plain');
    setDragId(null);
    setDragOverId(null);
    if (!draggedId || draggedId === targetId) return;

    const dragged = allAppointments.find(a => a.id === draggedId);
    const target = allAppointments.find(a => a.id === targetId);
    if (!sameRoute(dragged, target)) return;

    const dayList = allAppointments
      .filter(a => a.status === dragged!.status && a.date === dragged!.date && a.technicianId === dragged!.technicianId)
      .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

    // Pilota: con una chiamata in corso o in coda nel giro gli orari non si
    // ricalcolano (al cliente sta per essere comunicato quell'orario)
    const now = new Date();
    if (dayList.some(a => isCallInFlight(a, now) || !!a.autoCall)) {
      alert("C'è una chiamata in corso/in coda per questo giro: attendi l'esito o annulla le chiamate in coda prima di riordinare.");
      return;
    }

    const fromIdx = dayList.findIndex(a => a.id === draggedId);
    const toIdx = dayList.findIndex(a => a.id === targetId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

    const reordered = [...dayList];
    const [moved] = reordered.splice(fromIdx, 1);
    // Trascinando verso il basso finisce dopo la scheda su cui si rilascia,
    // verso l'alto ci finisce prima: comportamento naturale di una lista.
    reordered.splice(toIdx, 0, moved);

    if (dragged!.status === 'proposed') {
      await rescheduleProposedGroup(reordered, dragged!);
    } else {
      await rescheduleDay(reordered, dragged!.technicianId);
    }
  };

  const handleDragEnd = () => { setDragId(null); setDragOverId(null); };

  const handleRemove = (id: string) => {
    setAllAppointments((prev: Appointment[]) => prev.filter((a: Appointment) => a.id !== id));
  };

  // Riepilogo percorso: per il tecnico selezionato, o per il pool non
  // assegnato quando la vista è "Tutti" (comportamento storico).
  const confirmedForDate = allAppointments
    .filter(a => a.status === 'confirmed' && a.date === currentDate && matchesTechFilter(a))
    .filter(a => selectedTechId !== ALL_TECH ? true : !a.technicianId)
    .sort((a: Appointment, b: Appointment) => (a.sequenceOrder||0) - (b.sequenceOrder||0));
  const routeSummary = confirmedForDate.length > 0 ? calculateRouteSummary(confirmedForDate) : null;

  // Giornate (diverse da quella in vista) che hanno appuntamenti confermati:
  // rende raggiungibili con un clic i giri confermati "fuori vista"
  const otherConfirmedDays = (() => {
    const counts = new Map<string, number>();
    for (const a of allAppointments) {
      if (a.status !== 'confirmed' || !a.date || !matchesTechFilter(a)) continue;
      if (viewMode === 'day' && a.date === currentDate) continue;
      counts.set(a.date, (counts.get(a.date) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((x, y) => x[0].localeCompare(y[0]));
  })();

  const listProposed = allAppointments.filter(a => a.status === 'proposed' && matchesTechFilter(a));
  const listPending = allAppointments
    .filter(a => a.status === 'pending' && matchesTechFilter(a))
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  const listStandby = allAppointments.filter(a => a.status === 'standby' && matchesTechFilter(a));
  const listIssues = allAppointments.filter(a => a.status === 'issue' && matchesTechFilter(a));
  const listCancelled = allAppointments.filter(a => a.status === 'cancelled' && matchesTechFilter(a));

  const pendingAll = allAppointments.filter(a => a.status === 'pending');

  // Categorie delle pratiche con problematiche
  const ISSUE_META: Record<IssueType, { label: string; icon: string; reentry: string }> = {
    wrong_phone: { label: 'Numeri non corretti', icon: '📵', reentry: 'ricontatto' },
    callback: { label: 'Da richiamare', icon: '📆', reentry: 'richiamo' },
    works_pending: { label: 'Lavori da ultimare', icon: '🚧', reentry: 'fine lavori' },
  };

  // Alert "slot da riservare": pratiche problematiche che rientrano domani o
  // prima (dal giorno precedente la data di richiamo / fine lavori).
  const tomorrowStr = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  })();
  const withFollowUp = allAppointments
    .filter(a => (a.status === 'issue' || a.status === 'pending') && a.followUpDate)
    .sort((a, b) => (a.followUpDate || '').localeCompare(b.followUpDate || ''));
  // Scadenze imminenti (entro domani) e rientri/richieste future: entrambe
  // visibili, così una pratica posticipata "alla data x" non sparisce mai
  const followUpAlerts = withFollowUp.filter(a => a.followUpDate! <= tomorrowStr);
  const futureFollowUps = withFollowUp.filter(a => a.followUpDate! > tomorrowStr);

  // Gruppi proposte per tecnico+data (ordinati)
  const proposedGroups = (() => {
    const groups = new Map<string, { techId?: string; date: string; items: Appointment[] }>();
    for (const a of listProposed) {
      const key = `${a.technicianId || 'none'}|${a.date || ''}`;
      const g = groups.get(key) || { techId: a.technicianId, date: a.date || '', items: [] };
      g.items.push(a);
      groups.set(key, g);
    }
    return Array.from(groups.values())
      .map(g => ({ ...g, items: g.items.sort((a, b) => (a.sequenceOrder||0)-(b.sequenceOrder||0)) }))
      .sort((g1, g2) => g1.date.localeCompare(g2.date) || (g1.techId||'').localeCompare(g2.techId||''));
  })();

  // Carico di lavoro mostrato sul chip: in attesa + proposte + confermate da oggi in poi
  const todayStr = new Date().toISOString().split('T')[0];
  const countForTech = (techId: string): number =>
    allAppointments.filter(a =>
      a.technicianId === techId &&
      (a.status === 'pending' || a.status === 'proposed' ||
        (a.status === 'confirmed' && !!a.date && a.date >= todayStr))
    ).length;

  // --- Pilota automatico: cruscotto, coda, cose da gestire ---
  const planningNow = getPlanningContext();
  const apStats = autopilotStats(allAppointments, planningNow);
  const attention = attentionItems(allAppointments, planningNow);
  const queuedIds = allAppointments.filter(a => a.autoCall).map(a => a.id);

  // "Approva e chiama": il giro entra nella coda del pilota
  const handleApproveAndCall = (ids: string[]) => {
    const now = new Date();
    setAllAppointments(prev => approveForCalling(prev, ids, now));
  };

  const handleCancelQueuedCalls = () => {
    setAllAppointments(prev => cancelAutoCalls(prev, prev.filter(a => a.autoCall || a.autoCallNotBefore).map(a => a.id)));
  };

  // Giro approvabile: ha almeno una tappa chiamabile non ancora in coda
  const approvableIds = (items: Appointment[]): string[] => {
    const now = new Date();
    const queued = approveForCalling(items, items.map(a => a.id), now);
    return queued.filter((a, i) => a !== items[i] && !items[i].autoCall).map(a => a.id);
  };

  const enableAutopilot = () => {
    setAutopilotIntroSeen(true);
    setAutopilot(s => ({ ...s, enabled: true }));
  };

  // Clic su una voce "Da gestire": porta la card in vista, altrimenti apre la
  // modifica della pratica
  const handleAttentionSelect = (item: AttentionItem) => {
    const appt = allAppointments.find(a => a.id === item.id);
    if (!appt) return;
    const el = document.getElementById(`appt-${appt.id}`);
    if (el) {
      setSelectedAppointmentId(appt.id);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      openEditModal(appt);
    }
  };

  // =====================================================================
  // INTERFACCIA (solo presentazione): sezioni, navigazione, ricerca, mappa.
  // Stato e gestori qui sopra restano quelli di sempre: le sezioni li
  // ricevono via props.
  // =====================================================================
  const viewportW = useViewportWidth();
  const [ui, updateUi] = useUiPrefs();
  const [section, setSection] = useState<SectionId>('panoramica');
  const [search, setSearch] = useState('');
  // Tutte le pratiche / ricerca globale: pillola di stato e ordinamento
  const [praticheStatus, setPraticheStatus] = useState<StatusFilter>('all');
  const [praticheSort, setPraticheSort] = useState<SortState>(DEFAULT_SORT);
  // "Attiva il pilota" fuori dalla striscia: la striscia osserva il contatore
  const [autopilotEnableRequest, setAutopilotEnableRequest] = useState(0);
  const [autopilotIntroOpen, setAutopilotIntroOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [navExpandedNarrow, setNavExpandedNarrow] = useState(false);
  const [mapOpenSmall, setMapOpenSmall] = useState(false);
  const [resizing, setResizing] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const workRef = useRef<HTMLDivElement>(null);

  const isMobile = viewportW < 768;          // telefono: navigazione a scomparsa
  const mapIsOverlay = viewportW < 900;      // mappa nascosta di partenza, si apre sopra l'elenco
  const navAutoCollapsed = viewportW < 1100; // navigazione ridotta da sola
  const navCollapsed = isMobile ? false : navAutoCollapsed ? !navExpandedNarrow : ui.navCollapsed;
  const mapVisible = mapIsOverlay ? mapOpenSmall : !ui.mapHidden;
  const compactBar = viewportW < 1100;
  const tightBar = viewportW < 1440;

  const toggleNav = () => {
    if (navAutoCollapsed) setNavExpandedNarrow(v => !v);
    else updateUi({ navCollapsed: !ui.navCollapsed });
  };
  const toggleMap = () => {
    if (mapIsOverlay) setMapOpenSmall(v => !v);
    else updateUi({ mapHidden: !ui.mapHidden });
  };

  // Livelli della mappa: un default sensato per ogni sezione (stessi stati dei vecchi filtri)
  const LAYER_PRESETS: Partial<Record<SectionId, typeof filters>> = {
    'panoramica': { confirmed: true, proposed: true, pending: true, standby: true, issues: true, cancelled: false },
    'da-gestire': { confirmed: true, proposed: true, pending: true, standby: true, issues: true, cancelled: false },
    'in-attesa': { confirmed: false, proposed: false, pending: true, standby: false, issues: false, cancelled: false },
    'proposte': { confirmed: true, proposed: true, pending: false, standby: false, issues: false, cancelled: false },
    'agenda': { confirmed: true, proposed: false, pending: false, standby: false, issues: false, cancelled: false },
    'problemi': { confirmed: false, proposed: false, pending: false, standby: false, issues: true, cancelled: false },
    'archivio': { confirmed: false, proposed: false, pending: false, standby: true, issues: false, cancelled: true },
  };

  const navigate = (next: SectionId) => {
    setSection(next);
    setSearch('');  // scegliendo una sezione la ricerca globale si svuota
    setMobileNavOpen(false);
    const preset = LAYER_PRESETS[next];
    if (preset) setFilters(preset);
    workRef.current?.scrollTo({ top: 0 });
  };

  const sectionOf = (a: Appointment): SectionId =>
    a.status === 'confirmed' ? 'agenda'
      : a.status === 'proposed' ? 'proposte'
      : a.status === 'pending' ? 'in-attesa'
      : a.status === 'issue' ? 'problemi'
      : 'archivio';

  // Porta in vista la scheda di una pratica (dalla mappa o da "Da gestire")
  const showAppointment = (id: string) => {
    const appt = allAppointments.find(a => a.id === id);
    if (!appt) return;
    if (!document.getElementById(`appt-${id}`)) {
      const target = sectionOf(appt);
      if (target !== section) navigate(target);
      if (appt.status === 'confirmed' && appt.date && !inAgendaRange(appt.date, currentDate, viewMode)) {
        setCurrentDate(appt.date);
        setViewMode('day');
      }
      if (search && !matchesQuery(appt, search)) setSearch('');
    }
    setSelectedAppointmentId(id);
  };

  // Divisore trascinabile fra pannello di lavoro e mappa
  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = splitRef.current;
    if (!el) return;
    setResizing(true);
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const minPanel = 520, minMap = 320;
      const x = Math.min(Math.max(ev.clientX - rect.left, minPanel), rect.width - minMap);
      updateUi({ panelPct: Math.round((x / rect.width) * 1000) / 10 });
    };
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const ws: Workspace = {
    techById,
    selectedTechId,
    selectedAppointmentId,
    currentDate,
    viewMode,
    todayStr,
    maxAttempts: autopilot.maxAttempts,
    isOptimizing,
    dragId,
    dragOverId,
    query: search,
    matches: (a: Appointment) => matchesQuery(a, search),
    awaitingOutcome: awaitingCallOutcome,
    hasStartBase: (techId?: string) => !!baseLocation || !!techById(techId)?.baseCoords,
    onOpenBaseSettings: () => navigate('impostazioni'),
    onSelect: setSelectedAppointmentId,
    onEdit: openEditModal,
    onStatusChange: handleStatusChange,
    onRemove: handleRemove,
    onCall: requestCall,
    onBulkCall: requestBulkCall,
    onDragStart: handleDragStart,
    onDragOver: handleDragOverCard,
    onDrop: handleDropOnCard,
    onDragEnd: handleDragEnd,
  };

  // Elenchi per le sezioni (stesse regole di sempre)
  const agendaItems = allAppointments.filter(a =>
    a.status === 'confirmed' && matchesTechFilter(a) && inAgendaRange(a.date, currentDate, viewMode));
  const confirmedUpcoming = allAppointments.filter(a => a.status === 'confirmed' && !!a.date && a.date >= todayStr && matchesTechFilter(a)).length;
  const attentionTotal = attention.length + followUpAlerts.length;
  const navCounts: NavCounts = {
    pratiche: allAppointments.filter(matchesTechFilter).length,
    daGestire: attentionTotal,
    inAttesa: listPending.length,
    proposte: listProposed.length,
    agenda: confirmedUpcoming,
    problemi: listIssues.length,
    archivio: listStandby.length + listCancelled.length,
  };
  const layerCounts = {
    confirmed: allAppointments.filter(a => a.status === 'confirmed' && matchesTechFilter(a)).length,
    proposed: listProposed.length,
    pending: listPending.length,
    standby: listStandby.length,
    issues: listIssues.length,
    cancelled: listCancelled.length,
  };
  const optimizeLabel = `Ottimizza il giro del ${formatDayLabel(currentDate).replace(/\./g, '')}${selectedTech ? ` · ${selectedTech.name.split(' ')[0]}` : ''}`;
  const techUnavailable = !!selectedTech && isFullyUnavailable(selectedTech, currentDate);

  // Tabella delle pratiche (sezione "Tutte le pratiche" e ricerca globale):
  // tutte le date, filtro tecnico, ricerca e pillola di stato
  const searching = search.trim() !== '';
  const tableMode = searching || section === 'pratiche';
  const techFiltered = useMemo(() => allAppointments.filter(matchesTechFilter), [allAppointments, matchesTechFilter]);
  const tableBase = useMemo(
    () => (searching ? techFiltered.filter(a => matchesQuery(a, search)) : techFiltered),
    [techFiltered, searching, search]);
  const tableCounts = useMemo(() => statusCounts(tableBase), [tableBase]);
  const tableRows = useMemo(
    () => sortPratiche(filterByStatus(tableBase, praticheStatus), praticheSort, (id?: string) => techById(id)?.name || ''),
    [tableBase, praticheStatus, praticheSort, techById]);
  // Elenco "mostrate ora": lo usano la mappa e l'esportazione (getExportPool)
  const visibleStable = useMemo(() => getVisibleAppointments(), [getVisibleAppointments]);
  const shownNow = tableMode ? tableRows : visibleStable;
  // In Impostazioni la mappa non serve (la preferenza salvata resta com'è)
  const mapHere = !(section === 'impostazioni' && !tableMode);
  const mapShown = mapVisible && mapHere;
  const sectionLabel = (id: SectionId) => (id === 'impostazioni' ? 'Impostazioni' : NAV_ITEMS.find(n => n.id === id)?.label || '');

  const SECTION_TITLES: Record<SectionId, { title: string; subtitle: string }> = {
    'panoramica': { title: 'Panoramica', subtitle: longDayLabel(todayStr) },
    'pratiche': { title: 'Tutte le pratiche', subtitle: `${plural(techFiltered.length, 'pratica', 'pratiche')}${selectedTech ? ` di ${selectedTech.name}` : ''} · ogni stato e data` },
    'da-gestire': { title: 'Da gestire', subtitle: attentionTotal ? `${attentionTotal} ${attentionTotal === 1 ? 'voce richiede' : 'voci richiedono'} una decisione` : 'Niente in sospeso' },
    'in-attesa': { title: 'In attesa', subtitle: `${listPending.length} da pianificare` },
    'proposte': { title: 'Proposte', subtitle: `${plural(listProposed.length, 'tappa', 'tappe')} in ${plural(proposedGroups.length, 'giro', 'giri')} da approvare` },
    'agenda': { title: 'Agenda', subtitle: `${agendaItems.length} confermati · ${rangeLabel(currentDate, viewMode)}` },
    'problemi': { title: 'Problemi', subtitle: `${plural(listIssues.length, 'pratica', 'pratiche')} da sistemare` },
    'archivio': { title: 'Archivio', subtitle: `${listStandby.length} in stand-by · ${listCancelled.length} annullate` },
    'impostazioni': { title: 'Impostazioni', subtitle: 'Base, orari, pilota e tecnici' },
  };

  const renderSection = () => {
    if (tableMode) {
      return (
        <AllPraticheSection
          ws={ws}
          mode={searching ? 'search' : 'section'}
          rows={tableRows}
          counts={tableCounts}
          status={praticheStatus}
          onStatus={setPraticheStatus}
          sort={praticheSort}
          onSort={setPraticheSort}
          query={search}
          onClearSearch={() => setSearch('')}
          backLabel={section === 'pratiche' ? undefined : sectionLabel(section)}
          onImportExcel={() => fileInputRef.current?.click()}
        />
      );
    }
    switch (section) {
      case 'panoramica':
        return (
          <OverviewSection
            ws={ws}
            all={allAppointments.filter(matchesTechFilter)}
            pendingCount={listPending.length}
            proposedCount={listProposed.length}
            proposedRoutes={proposedGroups.length}
            stats={apStats}
            autopilotOn={autopilot.enabled}
            attention={attention}
            attentionTotal={attentionTotal}
            slotCount={followUpAlerts.length}
            onNavigate={navigate}
            onOpenDay={(d) => { setCurrentDate(d); setViewMode('day'); navigate('agenda'); }}
            onOpenProposals={() => navigate('proposte')}
            onAttentionSelect={handleAttentionSelect}
            onAttentionShow={(item) => showAppointment(item.id)}
            onImportExcel={() => fileInputRef.current?.click()}
            onImportKmz={() => kmzInputRef.current?.click()}
            onDispatch={() => setShowDispatchModal(true)}
            empty={allAppointments.length === 0}
          />
        );
      case 'da-gestire':
        return (
          <AttentionSection
            ws={ws}
            items={attention}
            followUpAlerts={followUpAlerts}
            futureFollowUps={futureFollowUps}
            onSelect={handleAttentionSelect}
            onShow={(item) => showAppointment(item.id)}
            onBackToPending={(id) => handleStatusChange(id, 'pending')}
            onOpenAppt={openEditModal}
          />
        );
      case 'in-attesa':
        return (
          <PendingSection
            ws={ws}
            items={listPending}
            pendingAll={pendingAll.length}
            addressInput={addressInput}
            onAddressInput={setAddressInput}
            onAddAddress={handleAddAddress}
            isLoading={isLoading}
            onDispatch={() => setShowDispatchModal(true)}
            onImportExcel={() => fileInputRef.current?.click()}
            onNewPratica={openNewApptModal}
          />
        );
      case 'proposte':
        return (
          <ProposalsSection
            ws={ws}
            items={listProposed}
            groups={proposedGroups}
            autopilotOn={autopilot.enabled}
            hideEnableCallout={autopilotIntroOpen}
            queuedCount={queuedIds.length}
            approvableIds={approvableIds}
            onApproveAndCall={handleApproveAndCall}
            onCancelQueued={handleCancelQueuedCalls}
            onConfirmDay={handleConfirmDay}
            pendingCount={pendingAll.length}
            onDispatch={() => setShowDispatchModal(true)}
            onEnableAutopilot={() => setAutopilotEnableRequest(n => n + 1)}
          />
        );
      case 'agenda':
        return (
          <AgendaSection
            ws={ws}
            items={agendaItems}
            otherDays={otherConfirmedDays}
            onGoDay={(day) => { setCurrentDate(day); setViewMode('day'); }}
            onOptimize={handleOptimize}
            optimizeLabel={optimizeLabel}
            canDragReorder={canDragReorder}
            routeSummary={viewMode === 'day' ? routeSummary : null}
            selectedTech={selectedTech}
            techUnavailable={techUnavailable}
            onOpenProposals={() => navigate('proposte')}
            proposedCount={listProposed.length}
          />
        );
      case 'problemi':
        return <ProblemsSection ws={ws} items={listIssues} />;
      case 'archivio':
        return <ArchiveSection ws={ws} standby={listStandby} cancelled={listCancelled} />;
      case 'impostazioni':
        return (
          <SettingsSection
            baseLocation={baseLocation}
            baseInput={baseInput}
            onBaseInput={setBaseInput}
            onSetBase={handleSetBase}
            onClearBase={() => setBaseLocation(null)}
            isLoading={isLoading}
            startTime={startTime}
            endTimeLimit={endTimeLimit}
            onStartTime={setStartTime}
            onEndTime={setEndTimeLimit}
            autopilotOn={autopilot.enabled}
            bridgeOn={embedded || bridgeSettings.enabled}
            cloudOn={cloudActive}
            onOpenAutopilotSettings={() => setShowAutopilotSettings(true)}
            technicians={technicians}
            onOpenTech={(id) => openTechModal(id ?? null)}
          />
        );
    }
  };

  const mapPanel = (
    <MapPanel
      appointments={shownNow}
      center={mapCenter}
      routeSummary={!tableMode && viewMode === 'day' ? routeSummary : null}
      listNote={tableMode ? `Sulla mappa: ${shownNow.length === 0 ? 'nessuna pratica in elenco' : shownNow.length === 1 ? 'la pratica in elenco' : `le ${shownNow.length} pratiche in elenco`}` : undefined}
      baseLocation={baseLocation}
      technicians={technicians}
      selectedId={selectedAppointmentId}
      onSelectAppointment={showAppointment}
      onStatusChange={handleStatusChange}
      onRequestCall={(id) => {
        const appt = allAppointments.find(a => a.id === id);
        if (appt) requestCall(appt);
      }}
      layers={filters}
      layerCounts={layerCounts}
      onToggleLayer={(key, value) => setFilters(p => ({ ...p, [key]: value }))}
      currentDate={currentDate}
      viewMode={viewMode}
      selectedTech={selectedTech}
      onHide={toggleMap}
      overlay={mapIsOverlay}
    />
  );

  const titles = searching
    ? { title: `Risultati per «${search.trim()}»`, subtitle: `${plural(tableCounts.all, 'pratica', 'pratiche')} in tutte le sezioni` }
    : SECTION_TITLES[section];

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* --- ADD/EDIT APPOINTMENT MODAL --- */}
      {showApptModal && (
        <AppointmentModal
          initial={editingAppointment}
          technicians={technicians}
          onSave={handleSaveAppointment}
          onClose={() => { setShowApptModal(false); setEditingAppointment(null); }}
        />
      )}

      {/* --- AI CALL MODAL (Retell) --- */}
      {callTarget && (
        <CallModal
          appointment={callTarget}
          technicianName={techById(callTarget.technicianId)?.name}
          daySchedule={buildDaySchedule(callTarget)}
          buildAlternatives={buildAlternatives}
          onClose={() => setCallTarget(null)}
          onCallStarted={handleCallStarted}
          onCallResult={handleCallResult}
          onMarkIssue={handleMarkIssueFromCall}
        />
      )}

      {/* --- BULK AI CALL MODAL (Chiama tutte) --- */}
      {bulkCallList && (
        <BulkCallModal
          appointments={bulkCallList}
          technicianNameById={technicianNameById}
          buildDaySchedule={buildDaySchedule}
          buildAlternatives={buildAlternatives}
          isCallBusy={(id) => {
            const current = appointmentsRef.current.find(a => a.id === id);
            return !!current && isCallInFlight(current, new Date());
          }}
          onClose={() => setBulkCallList(null)}
          onCallStarted={handleCallStarted}
          onCallResult={handleCallResult}
        />
      )}

      {/* --- TECHNICIANS MODAL --- */}
      {showTechModal && (
        <TechnicianModal
          technicians={technicians}
          onChange={setTechnicians}
          onClose={() => { setShowTechModal(false); setTechModalOpenId(null); }}
          initialOpenId={techModalOpenId}
        />
      )}

      {/* --- DISPATCH MODAL --- */}
      {showDispatchModal && (
        <DispatchModal
          pending={pendingAll}
          technicians={technicians}
          fallbackBase={baseLocation?.coords || null}
          existing={allAppointments}
          onApply={handleApplyDispatch}
          onClose={() => setShowDispatchModal(false)}
        />
      )}

      {/* --- PILOTA AUTOMATICO: impostazioni (e bridge) --- */}
      {showAutopilotSettings && (
        <AutopilotSettingsModal
          autopilot={autopilot}
          bridge={bridgeSettings}
          onSave={(ap, br) => { setAutopilot(ap); setBridgeSettings(br); }}
          onClose={() => setShowAutopilotSettings(false)}
          cloud={cloud}
          getLocalCloudData={getLocalCloudData}
          onCloudActivate={handleCloudActivate}
          onCloudDisconnect={handleCloudDisconnect}
          onCloudKeySave={handleCloudKeySave}
          gestionale={gestionale ? { user: gestionale.user, credential: gestionale.session.credential } : null}
        />
      )}

      {/* --- KMZ IMPORT MODAL (Google My Maps) --- */}
      {kmzFile && (
        <KmzImportModal
          file={kmzFile}
          technicians={technicians}
          existing={allAppointments}
          onApply={handleKmzApply}
          onClose={() => setKmzFile(null)}
        />
      )}

      {/* --- IMPORT MODAL --- */}
      {showImportModal && (
        <ImportProgressModal
          finished={importFinished}
          progress={uploadProgress}
          stats={importStats}
          failed={failedImports}
          approx={approxImports}
          onClose={closeImportModal}
        />
      )}

      {/* File nascosti per gli import (Importa ▾) */}
      <input type="file" ref={fileInputRef} onChange={handleFileSelect} accept=".xlsx,.csv" className="hidden" />
      <input type="file" ref={kmzInputRef} onChange={handleKmzSelect} accept=".kmz,.kml" className="hidden" />

      {/* --- NAVIGAZIONE --- */}
      <SideNav
        section={section}
        counts={navCounts}
        collapsed={navCollapsed}
        mobile={isMobile}
        mobileOpen={mobileNavOpen}
        onNavigate={navigate}
        onOpenTechnicians={() => { setMobileNavOpen(false); openTechModal(); }}
        onToggleCollapsed={toggleNav}
        onCloseMobile={() => setMobileNavOpen(false)}
        gestionaleUser={gestionale ? gestionale.user : null}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* --- BARRA IN ALTO --- */}
        <TopBar
          title={titles.title}
          subtitle={titles.subtitle}
          isAgenda={section === 'agenda' && !searching}
          compact={compactBar}
          tight={tightBar}
          mobile={isMobile}
          onOpenNav={() => setMobileNavOpen(true)}
          search={search}
          onSearch={setSearch}
          technicians={technicians.filter(t => t.active)}
          selectedTechId={selectedTechId}
          onSelectTech={setSelectedTechId}
          countForTech={countForTech}
          totalCount={allAppointments.filter(a => a.status === 'pending' || a.status === 'proposed' || (a.status === 'confirmed' && !!a.date && a.date >= todayStr)).length}
          techUnavailable={techUnavailable}
          onOpenTech={(id) => openTechModal(id ?? null)}
          onNewPratica={openNewApptModal}
          onImportExcel={() => fileInputRef.current?.click()}
          onImportKmz={() => kmzInputRef.current?.click()}
          bridge={{
            show: tabLock === 'leader' && bridgeInbox.status.kind !== 'disabled' && bridgeInbox.status.kind !== 'unconfigured',
            busy: bridgeInbox.status.kind === 'checking',
            onSync: () => { void bridgeInbox.syncNow(); },
          }}
          pendingCount={pendingAll.length}
          onDispatch={() => setShowDispatchModal(true)}
          optimizeLabel={optimizeLabel}
          isOptimizing={isOptimizing}
          onOptimize={handleOptimize}
          onExport={handleExport}
          exportHint={`${plural(shownNow.length, 'pratica', 'pratiche')}: quelle mostrate ora`}
          onSendReport={handleSendToN8n}
          isSending={isSendingToN8n}
          currentDate={currentDate}
          onDateChange={setCurrentDate}
          viewMode={viewMode}
          onViewMode={setViewMode}
          mapVisible={mapVisible || !mapHere}
          onToggleMap={toggleMap}
        />

        {/* --- STRISCIA DEL PILOTA --- */}
        <AutopilotBar
          settings={autopilot}
          stats={apStats}
          lock={tabLock === 'pending' ? 'leader' : tabLock}
          introSeen={autopilotIntroSeen}
          autoDispatchRunning={autoDispatch.running}
          bridge={bridgeInbox.status}
          onEnable={enableAutopilot}
          onPause={() => setAutopilot(s => ({ ...s, enabled: false }))}
          onOpenSettings={() => setShowAutopilotSettings(true)}
          onBridgeSyncNow={() => { void bridgeInbox.syncNow(); }}
          cloud={cloudActive ? { mirror: !isAutomationTab, state: cloudSync.state, leaseHolder: cloudLeaseHolder, bridgeHere: embedded && bridgeHere } : null}
          requestEnable={autopilotEnableRequest}
          onIntroOpenChange={setAutopilotIntroOpen}
        />

        {/* --- PANNELLO DI LAVORO + MAPPA --- */}
        <div ref={splitRef} className={`flex-1 min-h-0 flex ${resizing ? 'select-none cursor-col-resize' : ''}`}>
          <main
            ref={workRef}
            className="work-panel min-w-0 overflow-y-auto overflow-x-hidden"
            style={mapShown && !mapIsOverlay ? { width: `${ui.panelPct}%`, minWidth: 520, flex: 'none' } : { flex: '1 1 0%' }}
          >
            <div
              data-testid={`section-${section}`}
              className={`px-4 md:px-5 py-5 ${!mapShown || mapIsOverlay ? (tableMode ? 'max-w-[1600px] mx-auto' : 'max-w-[1100px] mx-auto') : ''}`}
            >
              {renderSection()}
            </div>
          </main>

          {/* In Impostazioni la mappa resta montata ma nascosta (niente
              animazioni di Leaflet interrotte, stessa vista al ritorno) */}
          {mapVisible && !mapIsOverlay && (
            <>
              {mapShown && <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Ridimensiona il pannello e la mappa"
                title="Trascina per ridimensionare"
                onPointerDown={onDividerDown}
                onDoubleClick={() => updateUi({ panelPct: 46 })}
                className="split-handle"
              />}
              <div className={mapShown ? 'flex-1 min-w-[320px] py-3 pr-3 md:py-4 md:pr-4' : 'hidden'} aria-hidden={!mapShown || undefined}>
                {mapPanel}
              </div>
            </>
          )}
        </div>
      </div>

      {mapShown && mapIsOverlay && (
        <div className="fixed inset-0 z-[1000] bg-canvas p-2 animate-fade-in">
          {mapPanel}
        </div>
      )}
    </div>
  );
}

export default App;
