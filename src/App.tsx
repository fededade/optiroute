import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Appointment, Coordinates, AppointmentStatus, Technician } from './types';
import { geocodeAddress, geocodeAddressParts } from './services/geocodingService';
import { parseAddressInput } from './services/geminiService';
import { parseExcelFile, exportAppointmentsToExcel, generateExcelBlob, blobToBase64, extractPhoneFromRow, extractUrgentFromRow } from './services/excelService';
import { optimizeRoute, calculateSchedule, calculateRouteSummary } from './utils/geo';
import { loadAppointments, saveAppointments, loadBase, saveBase, loadSettings, saveSettings } from './services/storageService';
import { loadTechnicians, saveTechnicians, matchTechnician, isFullyUnavailable, workWindowOn } from './services/technicianService';
import { provinceToCode } from './utils/provinces';
import MapComponent from './Components/MapComponent';
import AppointmentModal from './Components/AppointmentModal';
import CallModal from './Components/CallModal';
import BulkCallModal from './Components/BulkCallModal';
import TechnicianModal from './Components/TechnicianModal';
import DispatchModal from './Components/DispatchModal';

// --- CONFIGURATION ---
// URL webhook n8n: configurabile via VITE_N8N_WEBHOOK_URL (Method: POST)
const N8N_WEBHOOK_URL = (import.meta as any).env?.VITE_N8N_WEBHOOK_URL || 'https://fededade.app.n8n.cloud/webhook-test/Suca';

// Icons
const PlusIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
  </svg>
);
const SparklesIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 3.844 18 4.75l-.259-.906a3 3 0 0 0-2.059-2.06L15 1.5l.682.259a3 3 0 0 0 2.059 2.059L18 4.75l.259-.906a3 3 0 0 0 2.06-2.059L21 1.5l-.682.259a3 3 0 0 0-2.059 2.059Z" />
  </svg>
);
const TrashIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
  </svg>
);
const UploadIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
  </svg>
);
const DownloadIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v6m0 0 3-3m-3 3-3-3m3-9a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>
);
const PaperAirplaneIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
  </svg>
);
const ArrowsRightLeftIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
);
const CoffeeIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993 1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007ZM8.625 10.5a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm7.5 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
    </svg>
);
const PauseIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25v13.5m-7.5-13.5v13.5" />
    </svg>
);
const ClockIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
);
const PhoneIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
    </svg>
);
const PencilIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
    </svg>
);
const UsersIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
    </svg>
);
const TruckIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 0 1-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 0 0-3.213-9.193 2.056 2.056 0 0 0-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 0 0-10.026 0 1.106 1.106 0 0 0-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12" />
    </svg>
);
const CheckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
  </svg>
);
const ChevronUpIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
  </svg>
);
const ChevronDownIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
  </svg>
);
const XMarkIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
  </svg>
);
const CheckCircleIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-12 h-12 text-emerald-500">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>
);
const ExclamationCircleIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-12 h-12 text-orange-500">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
  </svg>
);

const DEFAULT_CENTER: Coordinates = { lat: 41.9028, lng: 12.4964 }; // Rome

type ViewMode = 'day' | 'week' | 'month';

const ALL_TECH = 'all';

const formatDayLabel = (iso?: string): string => {
  if (!iso) return '';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('it-IT', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
};

function App() {
  const [addressInput, setAddressInput] = useState('');
  const [baseInput, setBaseInput] = useState('');

  // Unified List (restored from localStorage)
  const [allAppointments, setAllAppointments] = useState<Appointment[]>(() => loadAppointments());

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

  // Settings & View
  const [currentDate, setCurrentDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [startTime, setStartTime] = useState(() => loadSettings()?.startTime || "09:00");
  const [endTimeLimit, setEndTimeLimit] = useState(() => loadSettings()?.endTimeLimit || "18:00");

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
      standby: true
  });

  // Swap Mode State
  const [isSwapMode, setIsSwapMode] = useState(false);
  const [selectedForSwap, setSelectedForSwap] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

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
  useEffect(() => { saveSettings({ startTime, endTimeLimit }); }, [startTime, endTimeLimit]);
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

  const handleCallStarted = (id: string) => {
    setAllAppointments(prev => prev.map(a => a.id === id ? { ...a, callStatus: 'calling' } : a));
  };

  const handleCallResult = (id: string, ok: boolean, callId?: string) => {
    setAllAppointments(prev => prev.map(a => a.id === id
      ? { ...a, callStatus: ok ? 'called' : 'failed', callId: callId || a.callId, calledAt: new Date().toISOString() }
      : a
    ));
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

    try {
      const rows = await parseExcelFile(file);
      const newAppointments: Appointment[] = [];
      const failures: string[] = [];
      const approximates: string[] = [];

      let processedCount = 0;
      const validRows = rows.filter(r => r.Indirizzo && r.Comune);

      if (validRows.length === 0) {
        setUploadProgress("Errore: Nessuna riga valida trovata.");
        setTimeout(() => setShowImportModal(false), 2000);
        return;
      }

      for (const row of validRows) {
        processedCount++;
        setUploadProgress(`Elaborazione pratica ${processedCount} di ${validRows.length}...`);

        const fullAddress = `${row.Indirizzo} ${row['N.Civ.'] || ''}, ${row.Comune}, ${row['Prov.'] || ''}`.trim();
        const title = row.Intestatario || fullAddress;
        const phone = extractPhoneFromRow(row);
        const notes = row.Note ? `${row.Note}`.trim() : undefined;
        const urgent = extractUrgentFromRow(row);

        try {
          // Geocoding con fallback: prova l'indirizzo esatto, poi varianti
          // (senza civico, senza prefisso via/piazza) e infine il centro del
          // comune. Il rate limit Nominatim è gestito dal servizio.
          const result = await geocodeAddressParts({
            street: `${row.Indirizzo}`,
            civic: row['N.Civ.'] !== undefined && row['N.Civ.'] !== null ? `${row['N.Civ.']}` : undefined,
            comune: `${row.Comune}`,
            province: row['Prov.'] ? `${row['Prov.']}` : undefined,
          });
          if (result) {
            // Provincia: la colonna "Prov." del file è più affidabile del geocoding
            const province = provinceToCode(row['Prov.'] ? `${row['Prov.']}` : undefined) || result.province;
            const comune = row.Comune ? `${row.Comune}`.trim() : result.comune;
            const matched = matchTechnician({ coords: result.coords, province }, technicians);

            if (result.approximate) {
              approximates.push(`${fullAddress} (${title})`);
            }

            newAppointments.push({
              id: Date.now() + Math.random().toString(),
              // Se la posizione è approssimativa manteniamo l'indirizzo del
              // file (quello del comune sarebbe fuorviante per il tecnico)
              address: result.approximate ? fullAddress : result.displayName,
              title: title,
              phone: phone,
              notes: notes,
              coords: result.coords,
              province,
              comune,
              urgent: urgent || undefined,
              approximate: result.approximate || undefined,
              technicianId: matched?.id,
              status: 'pending' // Import as pending
            });
          } else {
            failures.push(`${fullAddress} (${title})`);
          }
        } catch (err) {
          console.error(err);
          failures.push(`${fullAddress} (Errore di rete)`);
        }
      }

      setAllAppointments(prev => [...prev, ...newAppointments]);

      setImportStats({ success: newAppointments.length, failed: failures.length, approx: approximates.length });
      setFailedImports(failures);
      setApproxImports(approximates);
      setImportFinished(true);
      setUploadProgress('Completato!');

    } catch (error) {
      console.error(error);
      setUploadProgress("Errore durante la lettura del file.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const getExportPool = () => {
    if (visibleAppointments.length === 0) return null;
    return [...visibleAppointments].sort((a: Appointment, b: Appointment) => {
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
        return { ...a, ...update };
    }));

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
  };

  // Sposta una proposta prima/dopo l'altra nel giro del suo tecnico+giorno e
  // ricalcola gli orari (stime, come lo smistamento: nessuna rete, istantaneo).
  const moveProposed = async (appt: Appointment, direction: -1 | 1) => {
    if (isOptimizing) return;

    const group = allAppointments
      .filter(a => a.status === 'proposed' && a.technicianId === appt.technicianId && a.date === appt.date)
      .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

    const idx = group.findIndex(a => a.id === appt.id);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= group.length) return;

    const reordered = [...group];
    [reordered[idx], reordered[targetIdx]] = [reordered[targetIdx], reordered[idx]];

    // Orari e base del tecnico del giro (fallback: impostazioni generali)
    const tech = techById(appt.technicianId);
    let dayStart = startTime;
    let dayEnd = endTimeLimit;
    let base = baseLocation?.coords || null;
    if (tech) {
      const window = workWindowOn(tech, appt.date!);
      if (window) { dayStart = window.start; dayEnd = window.end; }
      base = tech.baseCoords || baseLocation?.coords || null;
    }

    setIsOptimizing(true);
    try {
      const [startH, startM] = dayStart.split(':').map(n => parseInt(n, 10));
      const [endH, endM] = dayEnd.split(':').map(n => parseInt(n, 10));

      const { scheduled, overflow } = await calculateSchedule(
        reordered,
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
        if (calculated) return { ...a, ...calculated, status: 'proposed', date: appt.date };
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

  // Applica gli esiti dello smistamento automatico (stato 'proposed' + assegnazioni)
  const handleApplyDispatch = (updates: Appointment[]) => {
    const byId = new Map(updates.map(u => [u.id, u]));
    setAllAppointments(prev => prev.map(a => byId.get(a.id) || a));
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
    setIsSwapMode(false);
    setSelectedForSwap([]);

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

  const toggleSwapSelection = async (id: string) => {
    if (!isSwapMode) return;
    const target = allAppointments.find(a => a.id === id);
    if (!target || target.status !== 'confirmed' || target.date !== currentDate) return;

    let newSelection = [...selectedForSwap];
    if (newSelection.includes(id)) {
      newSelection = newSelection.filter(s => s !== id);
    } else {
      if (newSelection.length < 2) newSelection.push(id);
    }

    setSelectedForSwap(newSelection);

    if (newSelection.length === 2) {
      const first = allAppointments.find(a => a.id === newSelection[0]);
      const second = allAppointments.find(a => a.id === newSelection[1]);
      if (!first || !second) return;

      // Lo scambio ha senso solo all'interno del giro dello stesso tecnico
      if (first.technicianId !== second.technicianId) {
        alert("Puoi scambiare solo due tappe dello stesso tecnico.");
        setSelectedForSwap([]);
        return;
      }

      const routeTechId = first.technicianId;
      const routeTech = techById(routeTechId);

      const currentDayAppointments = allAppointments
        .filter(a => a.status === 'confirmed' && a.date === currentDate && a.technicianId === routeTechId)
        .sort((a: Appointment, b: Appointment) => (a.sequenceOrder||0)-(b.sequenceOrder||0));

      const idx1 = currentDayAppointments.findIndex(a => a.id === newSelection[0]);
      const idx2 = currentDayAppointments.findIndex(a => a.id === newSelection[1]);

      if (idx1 === -1 || idx2 === -1) return;

      const updatedList = [...currentDayAppointments];
      [updatedList[idx1], updatedList[idx2]] = [updatedList[idx2], updatedList[idx1]];

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
            updatedList,
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

        setSelectedForSwap([]);
      } catch (e) { console.error(e); }
      finally { setIsOptimizing(false); }
    }
  };

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

  // "Scambia Ordine" deve comparire anche per i giri smistati ai tecnici
  // (confirmedForDate in vista "Tutti" copre solo il pool non assegnato)
  const swappableConfirmedCount = allAppointments
    .filter(a => a.status === 'confirmed' && a.date === currentDate && matchesTechFilter(a)).length;

  const listProposed = allAppointments.filter(a => a.status === 'proposed' && matchesTechFilter(a));
  const listPending = allAppointments
    .filter(a => a.status === 'pending' && matchesTechFilter(a))
    .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  const listStandby = allAppointments.filter(a => a.status === 'standby' && matchesTechFilter(a));

  const pendingAll = allAppointments.filter(a => a.status === 'pending');

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

  // Small badge showing the AI call state on a card
  const CallBadge = ({ appt }: { appt: Appointment }) => {
    if (appt.callStatus === 'called') return <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-1 rounded">✓ Chiamato</span>;
    if (appt.callStatus === 'calling') return <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-100 px-1 rounded animate-pulse">📞 In chiamata...</span>;
    if (appt.callStatus === 'failed') return <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-1 rounded">✗ Chiamata fallita</span>;
    return null;
  };

  const UrgentBadge = ({ appt }: { appt: Appointment }) => {
    if (!appt.urgent) return null;
    return <span className="text-[10px] font-bold text-white bg-red-600 px-1.5 rounded">URGENTE</span>;
  };

  // Indirizzo non trovato con precisione: pin al centro del comune
  const ApproxBadge = ({ appt }: { appt: Appointment }) => {
    if (!appt.approximate) return null;
    return (
      <span
        className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded"
        title="Indirizzo esatto non trovato sulle mappe: la pratica è posizionata al centro del comune. Correggi l'indirizzo con il tasto Modifica per il punto esatto."
      >
        ≈ centro comune
      </span>
    );
  };

  const TechBadge = ({ appt }: { appt: Appointment }) => {
    const tech = techById(appt.technicianId);
    if (tech) {
      return (
        <span className="text-[10px] font-bold text-white px-1.5 rounded inline-flex items-center gap-1" style={{ backgroundColor: tech.color }}>
          {tech.name}
        </span>
      );
    }
    if (appt.status === 'pending') {
      return <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded">Da assegnare</span>;
    }
    return null;
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">
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
          onClose={() => setCallTarget(null)}
          onCallStarted={handleCallStarted}
          onCallResult={handleCallResult}
        />
      )}

      {/* --- BULK AI CALL MODAL (Chiama tutte) --- */}
      {bulkCallList && (
        <BulkCallModal
          appointments={bulkCallList}
          technicianNameById={technicianNameById}
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
          onApply={handleApplyDispatch}
          onClose={() => setShowDispatchModal(false)}
        />
      )}

      {/* --- IMPORT MODAL --- */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full text-center flex flex-col max-h-[80vh]">
             {!importFinished ? (
                 <>
                    <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4 shrink-0"></div>
                    <h3 className="text-lg font-bold text-slate-800 mb-2 shrink-0">Importazione in corso...</h3>
                    <p className="text-sm text-slate-500 mb-4 shrink-0">{uploadProgress}</p>
                    <p className="text-xs text-slate-400 shrink-0">Non chiudere questa finestra.</p>
                 </>
             ) : (
                 <>
                    <div className="mx-auto mb-4 flex justify-center shrink-0">
                        {importStats.failed === 0 ? <CheckCircleIcon /> : <ExclamationCircleIcon />}
                    </div>
                    <h3 className="text-xl font-bold text-slate-800 mb-2 shrink-0">Fatto!</h3>
                    <div className="mb-4 space-y-2 shrink-0">
                        <p className="text-md text-slate-600">N. <span className="font-bold text-indigo-600">{importStats.success}</span> Pratiche importate!</p>
                        {importStats.approx > 0 && (
                            <p className="text-sm text-amber-700 bg-amber-50 p-2 rounded">
                                ≈ {importStats.approx} {importStats.approx === 1 ? 'indirizzo posizionato' : 'indirizzi posizionati'} al centro del comune
                                (numero civico o via non trovati sulle mappe).
                            </p>
                        )}
                        {importStats.failed > 0 && (
                            <p className="text-sm text-red-500 bg-red-50 p-2 rounded">
                                ⚠️ {importStats.failed} indirizzi non trovati.
                            </p>
                        )}
                    </div>

                    {(failedImports.length > 0 || approxImports.length > 0) && (
                        <div className="flex-1 overflow-y-auto mb-4 bg-slate-50 rounded border border-slate-200 p-2 text-left">
                            {approxImports.length > 0 && (
                                <>
                                    <p className="text-xs font-bold text-slate-500 mb-2 sticky top-0 bg-slate-50">Posizione approssimativa (verifica o correggi con Modifica):</p>
                                    <ul className="text-xs text-amber-700 space-y-1 mb-2">
                                        {approxImports.map((approxStr, i) => (
                                            <li key={i} className="flex gap-1.5 items-start">
                                                <span className="shrink-0">≈</span>
                                                <span>{approxStr}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}
                            {failedImports.length > 0 && (
                                <>
                                    <p className="text-xs font-bold text-slate-500 mb-2 sticky top-0 bg-slate-50">Dettaglio errori:</p>
                                    <ul className="text-xs text-red-600 space-y-1">
                                        {failedImports.map((failStr, i) => (
                                            <li key={i} className="flex gap-1.5 items-start">
                                                <span className="shrink-0">•</span>
                                                <span>{failStr}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}
                        </div>
                    )}

                    <button
                        onClick={closeImportModal}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg transition-colors shrink-0"
                    >
                        Chiudi
                    </button>
                 </>
             )}
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex flex-col sm:flex-row items-center justify-between shadow-sm z-10 gap-4">
        <div className="flex items-center gap-3 w-full sm:w-auto">
          {/* LOGO UPDATE */}
          <div className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg shadow-sm border border-slate-100 bg-slate-900 flex items-center justify-center">
             <img src="/Logo.png" alt="Logo Aziendale" className="h-full w-full object-cover" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">OptiRoute</h1>
            <p className="text-xs text-slate-500 hidden sm:block">Gestione Sopralluoghi Multi-Tecnico</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3">
          {/* Technicians Manager */}
          <button
            onClick={() => openTechModal()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl border border-slate-200 bg-slate-50 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors"
          >
            <UsersIcon /> Tecnici
          </button>

          {/* Date & View Selector */}
          <div className="flex flex-col sm:flex-row items-center gap-3 bg-slate-50 p-1.5 rounded-xl border border-slate-200">
            <div className="flex gap-1">
                <button
                    onClick={() => setViewMode('day')}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors ${viewMode === 'day' ? 'bg-white shadow text-indigo-600' : 'text-slate-500 hover:text-indigo-500'}`}
                >
                    Giorno
                </button>
                <button
                    onClick={() => setViewMode('week')}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors ${viewMode === 'week' ? 'bg-white shadow text-indigo-600' : 'text-slate-500 hover:text-indigo-500'}`}
                >
                    Settimana
                </button>
                <button
                    onClick={() => setViewMode('month')}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-colors ${viewMode === 'month' ? 'bg-white shadow text-indigo-600' : 'text-slate-500 hover:text-indigo-500'}`}
                >
                    Mese
                </button>
            </div>
            <div className="h-4 w-px bg-slate-300 hidden sm:block"></div>
            <div className="flex items-center gap-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase hidden md:block">Data Rif:</label>
                <input
                    type="date"
                    value={currentDate}
                    onChange={(e) => setCurrentDate(e.target.value)}
                    className="px-2 py-1 bg-white border border-slate-200 rounded-md text-sm font-semibold focus:ring-2 focus:ring-indigo-500 outline-none text-slate-700"
                />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">

        {/* Sidebar */}
        <aside className="w-full md:w-96 bg-white z-20 flex flex-col border-r border-slate-200 shadow-xl md:shadow-none">

           {/* Technician selector */}
           <div className="p-2 bg-white border-b border-slate-200 flex gap-1.5 overflow-x-auto items-center">
             <button
                onClick={() => setSelectedTechId(ALL_TECH)}
                className={`px-2.5 py-1 rounded-full text-xs font-bold border whitespace-nowrap transition-colors ${selectedTechId === ALL_TECH ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'}`}
             >
                Tutti
             </button>
             {technicians.filter(t => t.active).map(tech => (
                <button
                    key={tech.id}
                    onClick={() => setSelectedTechId(tech.id)}
                    className={`px-2.5 py-1 rounded-full text-xs font-bold border whitespace-nowrap flex items-center gap-1.5 transition-colors ${selectedTechId === tech.id ? 'text-white' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'}`}
                    style={selectedTechId === tech.id ? { backgroundColor: tech.color, borderColor: tech.color } : undefined}
                >
                    <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: selectedTechId === tech.id ? 'white' : tech.color }}></span>
                    {tech.name.split(' ')[0]} ({countForTech(tech.id)})
                </button>
             ))}
             <button
                onClick={() => openTechModal()}
                title="Gestisci tecnici"
                className="px-2 py-1 rounded-full text-xs font-bold border border-dashed border-slate-300 text-slate-400 hover:text-indigo-600 hover:border-indigo-300 whitespace-nowrap"
             >
                +
             </button>
           </div>

           {/* Selected technician info */}
           {selectedTech && (
             <div className="px-3 py-2 border-b border-slate-200 text-xs" style={{ backgroundColor: `${selectedTech.color}14` }}>
                <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-600 truncate">
                        🏠 <b>{selectedTech.baseAddress ? selectedTech.baseAddress.split(',')[0] : 'Base generale'}</b>
                        {' '}· partenza <b>{selectedTech.workStart}</b> · fine <b>{selectedTech.workEnd}</b>
                    </span>
                    <button
                        onClick={() => openTechModal(selectedTech.id)}
                        className="font-bold shrink-0 hover:underline"
                        style={{ color: selectedTech.color }}
                    >
                        Apri scheda →
                    </button>
                </div>
                {isFullyUnavailable(selectedTech, currentDate) && (
                    <p className="mt-1 text-red-600 font-bold">🚫 Non disponibile il {formatDayLabel(currentDate)}</p>
                )}
             </div>
           )}

           {/* Filters Bar */}
           <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between gap-1 overflow-x-auto">
             <label className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-50 text-blue-800 border border-blue-100 cursor-pointer whitespace-nowrap">
                <input type="checkbox" checked={filters.confirmed} onChange={e => setFilters(p => ({...p, confirmed: e.target.checked}))} className="rounded text-blue-600 focus:ring-0" />
                Confermate ({allAppointments.filter(a => a.status === 'confirmed' && matchesTechFilter(a)).length})
             </label>
             <label className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-indigo-50 text-indigo-800 border border-indigo-100 cursor-pointer whitespace-nowrap">
                <input type="checkbox" checked={filters.proposed} onChange={e => setFilters(p => ({...p, proposed: e.target.checked}))} className="rounded text-indigo-600 focus:ring-0" />
                Proposte ({listProposed.length})
             </label>
             <label className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-orange-50 text-orange-800 border border-orange-100 cursor-pointer whitespace-nowrap">
                <input type="checkbox" checked={filters.pending} onChange={e => setFilters(p => ({...p, pending: e.target.checked}))} className="rounded text-orange-600 focus:ring-0" />
                In Attesa ({listPending.length})
             </label>
             <label className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 border border-gray-200 cursor-pointer whitespace-nowrap">
                <input type="checkbox" checked={filters.standby} onChange={e => setFilters(p => ({...p, standby: e.target.checked}))} className="rounded text-gray-500 focus:ring-0" />
                Stand-by ({listStandby.length})
             </label>
           </div>

          {/* Config & Add */}
          <div className="p-4 bg-slate-100 border-b border-slate-200 space-y-3">
            {/* Base */}
            {!baseLocation ? (
                <form onSubmit={handleSetBase} className="flex gap-2">
                  <input type="text" value={baseInput} onChange={e => setBaseInput(e.target.value)} placeholder="Imposta Base Generale..." className="flex-1 px-3 py-1.5 rounded-lg border text-sm" />
                  <button type="submit" className="bg-red-500 text-white px-3 rounded-lg text-xs font-bold">SET</button>
                </form>
            ) : (
                <div className="flex items-center justify-between text-xs bg-white p-2 rounded border border-red-200">
                    <span className="truncate flex-1 text-slate-700">🏠 Base Generale: <b>{baseLocation.address.split(',')[0]}</b></span>
                    <button onClick={() => setBaseLocation(null)} className="text-red-500 ml-2"><TrashIcon /></button>
                </div>
            )}

            {/* Add */}
            <form onSubmit={handleAddAddress} className="flex gap-2">
              <input type="text" value={addressInput} onChange={e => setAddressInput(e.target.value)} placeholder="Aggiunta rapida (solo indirizzo)..." className="flex-1 px-3 py-2 rounded-lg border text-sm" />
              <button disabled={isLoading} title="Aggiungi da indirizzo" className="bg-indigo-600 text-white px-3 rounded-lg disabled:opacity-60">
                {isLoading ? <span className="block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></span> : <PlusIcon />}
              </button>
            </form>
            <button
              onClick={openNewApptModal}
              className="w-full text-xs py-1.5 rounded-lg border border-indigo-200 bg-white text-indigo-600 font-bold hover:bg-indigo-50 transition-colors flex items-center justify-center gap-1"
            >
              <PlusIcon /> Nuovo completo (cliente, telefono, urgenza)
            </button>

            {/* Time Limits (usati per "Tutti"; ogni tecnico ha i suoi orari nella scheda) */}
            {!selectedTech && (
              <div className="flex gap-2 text-xs">
                  <div className="flex-1">
                      <span className="block text-slate-400 font-bold mb-0.5">INIZIO</span>
                      <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="w-full p-1 rounded border"/>
                  </div>
                  <div className="flex-1">
                      <span className="block text-slate-400 font-bold mb-0.5">FINE</span>
                      <input type="time" value={endTimeLimit} onChange={e => setEndTimeLimit(e.target.value)} className="w-full p-1 rounded border"/>
                  </div>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="p-2 grid grid-cols-2 gap-2 bg-white border-b border-slate-100">
             <button
                onClick={() => setShowDispatchModal(true)}
                disabled={pendingAll.length === 0}
                className="col-span-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2"
             >
                <TruckIcon /> Smista pratiche per zona ({pendingAll.length})
             </button>
             <button onClick={handleOptimize} className="col-span-2 bg-emerald-600 hover:bg-emerald-700 text-white py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2">
                {isOptimizing ? "Calcolo..." : <><SparklesIcon /> Ottimizza {currentDate}{selectedTech ? ` · ${selectedTech.name.split(' ')[0]}` : ''}</>}
             </button>
             {swappableConfirmedCount >= 2 && viewMode === 'day' && (
                <button onClick={() => setIsSwapMode(!isSwapMode)} className={`col-span-2 text-xs py-1.5 border rounded flex items-center justify-center gap-1 ${isSwapMode ? 'bg-amber-100 text-amber-800' : 'text-slate-600'}`}>
                    <ArrowsRightLeftIcon /> Scambia Ordine
                </button>
             )}
              <input type="file" ref={fileInputRef} onChange={handleFileSelect} accept=".xlsx,.csv" className="hidden" />

              <div className="col-span-2 grid grid-cols-2 gap-2">
                  <button onClick={() => fileInputRef.current?.click()} className="text-xs py-1.5 border rounded flex items-center justify-center gap-1 text-slate-600 bg-white hover:bg-slate-50">
                      <UploadIcon /> Importa Excel
                  </button>
                  <button onClick={handleExport} className="text-xs py-1.5 border rounded flex items-center justify-center gap-1 text-indigo-600 border-indigo-200 bg-indigo-50 hover:bg-indigo-100">
                      <DownloadIcon /> Esporta Excel
                  </button>
              </div>

              {/* Tasto Invia a N8N */}
              <button
                onClick={handleSendToN8n}
                disabled={isSendingToN8n}
                className="col-span-2 text-xs py-1.5 border rounded flex items-center justify-center gap-1 text-white bg-slate-800 hover:bg-slate-900 border-slate-900 transition-colors"
              >
                 {isSendingToN8n ? 'Invio in corso...' : <><PaperAirplaneIcon /> Invia Report Email</>}
              </button>
          </div>

          {/* List Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-6 bg-white">

            {/* 1. Proposed (da confermare) */}
            {filters.proposed && listProposed.length > 0 && (
                <div>
                    <h3 className="text-xs font-bold text-indigo-600 uppercase tracking-wider mb-2 border-b border-indigo-100 pb-1 flex justify-between items-center gap-2">
                        <span>Proposte da confermare ({listProposed.length})</span>
                        {listProposed.some(a => a.phone) && (
                            <button
                                onClick={() => requestBulkCall(listProposed)}
                                title="Avvia la chiamata AI di conferma per tutte le proposte con telefono"
                                className="normal-case tracking-normal text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-2 py-0.5 rounded flex items-center gap-1 shrink-0"
                            >
                                <PhoneIcon /> Chiama tutte
                            </button>
                        )}
                    </h3>
                    <div className="space-y-3">
                        {proposedGroups.map(group => {
                            const tech = techById(group.techId);
                            return (
                                <div key={`${group.techId || 'none'}-${group.date}`} className="border border-indigo-100 rounded-lg overflow-hidden">
                                    <div className="px-2.5 py-1.5 flex items-center justify-between gap-2" style={{ backgroundColor: tech ? `${tech.color}18` : '#eef2ff' }}>
                                        <span className="text-xs font-bold capitalize" style={{ color: tech?.color || '#4f46e5' }}>
                                            {tech ? tech.name : 'Senza tecnico'} — {formatDayLabel(group.date)}
                                        </span>
                                        <div className="flex items-center gap-1 shrink-0">
                                            {group.items.some(a => a.phone) && (
                                                <button
                                                    onClick={() => requestBulkCall(group.items)}
                                                    className="text-[10px] font-bold text-emerald-700 bg-white/80 border border-emerald-200 hover:bg-emerald-50 px-1.5 py-0.5 rounded flex items-center"
                                                    title="Chiama tutte le proposte di questa giornata (AI)"
                                                >
                                                    <PhoneIcon />
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleConfirmDay(group.techId, group.date)}
                                                className="text-[10px] font-bold text-white px-2 py-0.5 rounded"
                                                style={{ backgroundColor: tech?.color || '#4f46e5' }}
                                                title="Conferma tutte le proposte di questa giornata"
                                            >
                                                ✓ Conferma giornata
                                            </button>
                                        </div>
                                    </div>
                                    <div className="divide-y divide-slate-100">
                                        {group.items.map((appt, itemIdx) => (
                                            <div
                                                key={appt.id}
                                                id={`appt-${appt.id}`}
                                                className={`p-2.5 bg-white flex justify-between items-start gap-2 ${selectedAppointmentId === appt.id ? 'ring-2 ring-indigo-400' : ''}`}
                                            >
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                        <span className="text-xs font-mono font-bold text-indigo-700 bg-indigo-50 px-1 rounded shrink-0">
                                                            {appt.startTime}
                                                        </span>
                                                        <UrgentBadge appt={appt} />
                                                        <h4 className="text-sm font-semibold text-slate-800 leading-tight truncate">{appt.title}</h4>
                                                    </div>
                                                    <p className="text-xs text-slate-400 truncate">{appt.address}</p>
                                                    <div className="mt-0.5 flex gap-1.5 items-center flex-wrap">
                                                        {appt.phone && <span className="text-[11px] text-slate-400">📞 {appt.phone}</span>}
                                                        <ApproxBadge appt={appt} />
                                                        <CallBadge appt={appt} />
                                                    </div>
                                                </div>
                                                <div className="flex flex-col gap-1 shrink-0">
                                                    <div className="flex gap-1" title="Sposta il sopralluogo prima o dopo un altro: gli orari del giro si ricalcolano">
                                                        <button
                                                            onClick={() => moveProposed(appt, -1)}
                                                            disabled={itemIdx === 0 || isOptimizing}
                                                            title="Sposta prima (su)"
                                                            className="flex-1 p-0.5 rounded border border-slate-200 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 disabled:opacity-25 disabled:pointer-events-none flex items-center justify-center"
                                                        ><ChevronUpIcon /></button>
                                                        <button
                                                            onClick={() => moveProposed(appt, 1)}
                                                            disabled={itemIdx === group.items.length - 1 || isOptimizing}
                                                            title="Sposta dopo (giù)"
                                                            className="flex-1 p-0.5 rounded border border-slate-200 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 disabled:opacity-25 disabled:pointer-events-none flex items-center justify-center"
                                                        ><ChevronDownIcon /></button>
                                                    </div>
                                                    <button
                                                        onClick={() => handleStatusChange(appt.id, 'confirmed')}
                                                        title="Conferma questa proposta"
                                                        className="p-1 rounded bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border border-emerald-200"
                                                    ><CheckIcon /></button>
                                                    {appt.phone && appt.callStatus !== 'calling' && (
                                                        <button
                                                            onClick={() => requestCall(appt)}
                                                            title="Chiama il cliente per conferma (AI)"
                                                            className={`p-1 rounded ${appt.callStatus === 'called' ? 'text-emerald-500 hover:bg-emerald-50' : 'text-emerald-600 hover:bg-emerald-100 bg-emerald-50'}`}
                                                        ><PhoneIcon /></button>
                                                    )}
                                                    <button
                                                        onClick={() => handleStatusChange(appt.id, 'pending')}
                                                        title="Rifiuta: torna in attesa"
                                                        className="p-1 rounded bg-white text-slate-400 hover:bg-red-50 hover:text-red-500 border border-slate-200"
                                                    ><XMarkIcon /></button>
                                                    <button onClick={() => openEditModal(appt)} title="Modifica" className="p-1 hover:bg-indigo-100 rounded text-indigo-400"><PencilIcon/></button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2">
                        Con le frecce ↑/↓ sposti un sopralluogo prima o dopo un altro nel giro
                        (gli orari si ricalcolano). Con "Chiama tutte" (o il tasto 📞 su gruppo/pratica)
                        l'operatore AI chiama i clienti per confermare data e orario proposti, senza
                        bisogno di confermare prima a mano. L'urgenza viene comunicata al cliente.
                    </p>
                </div>
            )}

            {/* 2. Confirmed */}
            {filters.confirmed && (
                <div>
                    <h3 className="text-xs font-bold text-blue-600 uppercase tracking-wider mb-2 border-b border-blue-100 pb-1 flex justify-between items-center gap-2">
                        <span>Confermate ({visibleAppointments.filter(a => a.status === 'confirmed').length})</span>
                        <span className="flex items-center gap-2 shrink-0">
                            {visibleAppointments.some(a => a.status === 'confirmed' && a.phone) && (
                                <button
                                    onClick={() => requestBulkCall(visibleAppointments.filter(a => a.status === 'confirmed'))}
                                    title="Avvia la chiamata AI di conferma per tutte le confermate con telefono"
                                    className="normal-case tracking-normal text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-2 py-0.5 rounded flex items-center gap-1"
                                >
                                    <PhoneIcon /> Chiama tutte
                                </button>
                            )}
                            <span className="text-slate-400 font-normal normal-case">{viewMode === 'day' ? 'Giorno' : viewMode === 'week' ? 'Settimana' : 'Mese'}</span>
                        </span>
                    </h3>
                    <div className="space-y-2">
                        {visibleAppointments.filter(a => a.status === 'confirmed')
                         .sort((a,b) => {
                             if(a.date !== b.date && a.date && b.date) return a.date.localeCompare(b.date);
                             return (a.sequenceOrder||0) - (b.sequenceOrder||0);
                         })
                         .map((appt) => {
                            const tech = techById(appt.technicianId);
                            return (
                            <React.Fragment key={appt.id}>
                                {appt.hasLunchBreakBefore && viewMode === 'day' && (
                                    <div className="flex items-center gap-2 text-orange-600 text-[10px] font-bold py-1 justify-center bg-orange-50 rounded">
                                    <CoffeeIcon /> PAUSA PRANZO
                                    </div>
                                )}
                                <div
                                    id={`appt-${appt.id}`}
                                    onClick={() => toggleSwapSelection(appt.id)}
                                    className={`
                                        relative p-3 rounded-lg border transition-all
                                        ${isSwapMode && selectedForSwap.includes(appt.id) ? 'bg-amber-50 border-amber-500' : 'bg-blue-50 border-blue-100'}
                                        ${selectedAppointmentId === appt.id ? 'ring-2 ring-indigo-500 shadow-md scale-[1.01]' : ''}
                                        ${appt.urgent ? 'border-l-4 border-l-red-500' : ''}
                                    `}
                                >
                                    <div className="flex justify-between items-start">
                                        <div className="flex gap-2">
                                            <div
                                                className="w-6 h-6 rounded-full text-white flex items-center justify-center text-xs font-bold flex-shrink-0"
                                                style={{ backgroundColor: tech?.color || '#2563eb' }}
                                            >
                                                {appt.sequenceOrder}
                                            </div>
                                            <div>
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <h4 className="text-sm font-semibold text-slate-800 leading-tight">{appt.title}</h4>
                                                    <UrgentBadge appt={appt} />
                                                    <ApproxBadge appt={appt} />
                                                </div>
                                                <p className="text-xs text-slate-500">{appt.address}</p>
                                                {appt.phone && <p className="text-xs text-slate-500 mt-0.5">📞 {appt.phone}</p>}
                                                <div className="mt-1 flex gap-2 flex-wrap items-center">
                                                    {viewMode !== 'day' && <span className="text-xs font-bold text-slate-600 bg-slate-100 px-1 rounded">{appt.date}</span>}
                                                    <span className="text-xs font-mono text-blue-700 bg-blue-100 inline-block px-1 rounded">
                                                        {appt.startTime} - {appt.endTime}
                                                    </span>
                                                    {selectedTechId === ALL_TECH && <TechBadge appt={appt} />}
                                                    <CallBadge appt={appt} />
                                                </div>
                                            </div>
                                        </div>
                                        {/* Actions */}
                                        <div className="flex flex-col gap-1">
                                            {appt.phone && appt.callStatus !== 'calling' && (
                                                <button onClick={(e) => { e.stopPropagation(); requestCall(appt); }} title="Chiama il cliente (AI)" className={`p-1 rounded ${appt.callStatus === 'called' ? 'text-emerald-500 hover:bg-emerald-50' : 'text-emerald-600 hover:bg-emerald-100 bg-emerald-50'}`}><PhoneIcon/></button>
                                            )}
                                            <button onClick={(e) => { e.stopPropagation(); openEditModal(appt); }} title="Modifica" className="p-1 hover:bg-indigo-100 rounded text-indigo-400"><PencilIcon/></button>
                                            <button onClick={(e) => { e.stopPropagation(); handleStatusChange(appt.id, 'standby'); }} title="Metti in Stand-by" className="p-1 hover:bg-slate-200 rounded text-slate-400"><PauseIcon/></button>
                                            <button onClick={(e) => { e.stopPropagation(); handleStatusChange(appt.id, 'pending'); }} title="Torna in Attesa" className="p-1 hover:bg-orange-100 rounded text-orange-400"><ClockIcon/></button>
                                        </div>
                                    </div>
                                </div>
                            </React.Fragment>
                         );})}
                        {visibleAppointments.filter(a => a.status === 'confirmed').length === 0 && <p className="text-xs text-slate-400 italic">Nessun appuntamento confermato nel periodo.</p>}
                    </div>
                </div>
            )}

            {/* 3. Pending */}
            {filters.pending && (
                <div>
                    <h3 className="text-xs font-bold text-orange-500 uppercase tracking-wider mb-2 border-b border-orange-100 pb-1 mt-4">
                        In Attesa / Da Pianificare ({listPending.length})
                    </h3>
                    <div className="space-y-2 opacity-90">
                        {listPending.map(appt => (
                             <div
                                key={appt.id}
                                id={`appt-${appt.id}`}
                                className={`
                                    p-3 rounded-lg border bg-white flex justify-between items-start transition-all
                                    ${appt.urgent ? 'border-red-300 border-l-4 border-l-red-500' : 'border-orange-200'}
                                    ${selectedAppointmentId === appt.id ? 'ring-2 ring-orange-400 shadow-md' : ''}
                                `}
                             >
                                 <div className="min-w-0">
                                     <div className="flex items-center gap-1.5 flex-wrap">
                                        <h4 className="text-sm font-semibold text-slate-700">{appt.title}</h4>
                                        <UrgentBadge appt={appt} />
                                        <ApproxBadge appt={appt} />
                                     </div>
                                     <p className="text-xs text-slate-400">{appt.address}</p>
                                     {appt.phone && <p className="text-xs text-slate-400 mt-0.5">📞 {appt.phone}</p>}
                                     {appt.notes && <p className="text-xs text-slate-400 italic mt-0.5 line-clamp-2">{appt.notes}</p>}
                                     <div className="mt-1 flex gap-1.5 flex-wrap items-center">
                                        {selectedTechId === ALL_TECH && <TechBadge appt={appt} />}
                                        {appt.province && <span className="text-[10px] text-slate-400 border border-slate-200 px-1 rounded">{appt.province}</span>}
                                        <CallBadge appt={appt} />
                                     </div>
                                 </div>
                                 <div className="flex flex-col gap-1">
                                    <button onClick={() => handleStatusChange(appt.id, 'confirmed')} title="Forza Conferma Oggi" className="text-xs bg-blue-100 text-blue-600 px-1 py-0.5 rounded font-bold hover:bg-blue-200">
                                        + OGGI
                                    </button>
                                    <button onClick={() => openEditModal(appt)} title="Modifica" className="p-1 hover:bg-indigo-100 rounded text-indigo-400"><PencilIcon/></button>
                                    <button onClick={() => handleStatusChange(appt.id, 'standby')} className="p-1 hover:bg-slate-100 rounded text-slate-400"><PauseIcon/></button>
                                    <button onClick={() => handleRemove(appt.id)} className="p-1 hover:bg-red-50 rounded text-red-300"><TrashIcon/></button>
                                 </div>
                             </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 4. Standby */}
            {filters.standby && (
                <div>
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 border-b border-gray-200 pb-1 mt-4">
                        In Stand-by ({listStandby.length})
                    </h3>
                    <div className="space-y-2 opacity-60">
                        {listStandby.map(appt => (
                             <div
                                key={appt.id}
                                id={`appt-${appt.id}`}
                                className={`
                                    p-3 rounded-lg border border-slate-200 bg-slate-50 flex justify-between items-center transition-all
                                    ${selectedAppointmentId === appt.id ? 'ring-2 ring-gray-400 shadow-md' : ''}
                                `}
                             >
                                 <div>
                                     <div className="flex items-center gap-1.5 flex-wrap">
                                        <h4 className="text-sm font-semibold text-slate-600">{appt.title}</h4>
                                        <UrgentBadge appt={appt} />
                                     </div>
                                     <p className="text-xs text-slate-400">{appt.address}</p>
                                     {appt.phone && <p className="text-xs text-slate-400 mt-0.5">📞 {appt.phone}</p>}
                                 </div>
                                 <div className="flex gap-2">
                                     <button onClick={() => openEditModal(appt)} title="Modifica" className="text-indigo-400 hover:bg-indigo-50 p-1 rounded"><PencilIcon/></button>
                                     <button onClick={() => handleStatusChange(appt.id, 'pending')} title="Riattiva" className="text-green-600 hover:bg-green-50 p-1 rounded"><ClockIcon/></button>
                                     <button onClick={() => handleRemove(appt.id)} className="text-red-400 hover:bg-red-50 p-1 rounded"><TrashIcon/></button>
                                 </div>
                             </div>
                        ))}
                    </div>
                </div>
            )}

          </div>
        </aside>

        {/* Map Area */}
        <main className="flex-1 relative bg-slate-200 h-[50vh] md:h-auto">
          <MapComponent
            appointments={visibleAppointments}
            center={mapCenter}
            routeSummary={viewMode === 'day' ? routeSummary : null}
            baseLocation={baseLocation}
            technicians={technicians}
            onSelectAppointment={setSelectedAppointmentId}
            onStatusChange={handleStatusChange}
            onRequestCall={(id) => {
              const appt = allAppointments.find(a => a.id === id);
              if (appt) requestCall(appt);
            }}
          />

          <div className="absolute bottom-6 left-6 z-[400] bg-white/90 backdrop-blur px-4 py-2 rounded-lg shadow-lg border border-slate-200 hidden md:block">
            <div className="text-xs font-medium text-slate-600">
              <p>Riferimento: <span className="text-indigo-600 font-bold">{currentDate}</span></p>
              <p>Vista: <span className="text-slate-800 font-bold uppercase">{viewMode === 'day' ? 'Giornaliera' : viewMode === 'week' ? 'Settimanale' : 'Mensile'}</span></p>
              {selectedTech && (
                <p className="mt-1 font-bold" style={{ color: selectedTech.color }}>
                  Tecnico: {selectedTech.name}
                </p>
              )}
              {baseLocation && <p className="text-red-500 mt-1">Base: {baseLocation.address.split(',')[0]}</p>}
            </div>
          </div>
        </main>

      </div>
    </div>
  );
}

export default App;
