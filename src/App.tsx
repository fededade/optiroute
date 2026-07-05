import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Appointment, Coordinates, AppointmentStatus } from './types';
import { geocodeAddress, hasCachedGeocode } from './services/geocodingService';
import { parseAddressInput } from './services/geminiService';
import { parseExcelFile, exportAppointmentsToExcel, generateExcelBlob, blobToBase64, extractPhoneFromRow, extractCodiceFromRow, parsePraticheMisi } from './services/excelService';
import { startConfirmationCall, fetchCallOutcome } from './services/callService';
import { optimizeRoute, calculateSchedule, calculateRouteSummary } from './utils/geo';
import { loadAppointments, saveAppointments, loadBase, saveBase, loadSettings, saveSettings } from './services/storageService';
import MapComponent from './Components/MapComponent';
import AppointmentModal from './Components/AppointmentModal';
import CallModal from './Components/CallModal';

// --- CONFIGURATION ---
// URL webhook n8n: configurabile via VITE_N8N_WEBHOOK_URL (Method: POST)
const N8N_WEBHOOK_URL = (import.meta as any).env?.VITE_N8N_WEBHOOK_URL || 'https://fededade.app.n8n.cloud/webhook-test/Suca';

// Icons
const PlusIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
  </svg>
);
const MapPinIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
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

// Normalized row produced by any of the supported import formats
interface ImportRow {
  title: string;
  fullAddress: string;
  phone?: string;
  notes?: string;
  codice?: string;   // codice pratica/perizia (per merge e link Prelios)
  project?: string;
}

const appendNote = (notes: string | undefined, extra: string): string =>
  notes ? `${notes} | ${extra}` : extra;

// Max age of a call before we stop polling for its outcome
const OUTCOME_POLL_MAX_AGE_MS = 45 * 60000;

const needsOutcomePolling = (a: Appointment): boolean =>
  !!a.callId && a.callStatus === 'called' && !a.callOutcome &&
  !!a.calledAt && (Date.now() - new Date(a.calledAt).getTime()) < OUTCOME_POLL_MAX_AGE_MS;

function App() {
  const [addressInput, setAddressInput] = useState('');
  const [baseInput, setBaseInput] = useState('');

  // Unified List (restored from localStorage)
  const [allAppointments, setAllAppointments] = useState<Appointment[]>(() => loadAppointments());

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
  const [importStats, setImportStats] = useState({ success: 0, failed: 0 });
  const [failedImports, setFailedImports] = useState<string[]>([]);
  
  // Settings & View
  const [currentDate, setCurrentDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [startTime, setStartTime] = useState(() => loadSettings()?.startTime || "09:00");
  const [endTimeLimit, setEndTimeLimit] = useState(() => loadSettings()?.endTimeLimit || "18:00");

  // Appointment add/edit modal
  const [showApptModal, setShowApptModal] = useState(false);
  const [editingAppointment, setEditingAppointment] = useState<Appointment | null>(null);

  // AI call modal (Retell)
  const [callTarget, setCallTarget] = useState<Appointment | null>(null);
  const [isBatchCalling, setIsBatchCalling] = useState(false);

  // Filters
  const [filters, setFilters] = useState({
      confirmed: true,
      pending: true,
      standby: true
  });

  // Swap Mode State
  const [isSwapMode, setIsSwapMode] = useState(false);
  const [selectedForSwap, setSelectedForSwap] = useState<string[]>([]);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

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
          if (appt.status === 'confirmed') {
              if (!filters.confirmed) return false;
              if (viewMode === 'day') return appt.date === currentDate;
              if (viewMode === 'week') return isSameWeek(appt.date);
              if (viewMode === 'month') return isSameMonth(appt.date);
              return false;
          }
          if (appt.status === 'pending') return filters.pending;
          if (appt.status === 'standby') return filters.standby;
          return true;
      });
  }, [allAppointments, filters, currentDate, viewMode]);

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
      const newAppointment: Appointment = {
        id: Date.now().toString(),
        address: result.displayName,
        title: cleanAddress,
        coords: result.coords,
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

  // --- AI Call (Retell) handlers ---
  const requestCall = (appt: Appointment) => {
    if (!appt.phone) {
      alert("Questo appuntamento non ha un numero di telefono. Aggiungilo con il tasto Modifica.");
      return;
    }
    setCallTarget(appt);
  };

  const handleCallStarted = (id: string) => {
    setAllAppointments(prev => prev.map(a => a.id === id ? { ...a, callStatus: 'calling' } : a));
  };

  const handleCallResult = (id: string, ok: boolean, callId?: string) => {
    setAllAppointments(prev => prev.map(a => a.id === id
      ? { ...a, callStatus: ok ? 'called' : 'failed', callId: ok ? callId : a.callId, calledAt: new Date().toISOString(), callOutcome: ok ? undefined : a.callOutcome }
      : a
    ));
  };

  // --- Batch calling: chiama in sequenza tutti gli appuntamenti del giorno ---
  // Richiamabili: mai chiamati, chiamata fallita, oppure esito "non risponde"/
  // "da verificare". NON richiamabili: chiamata in corso, esito in arrivo,
  // già confermati, rifiutati o con richiesta di spostamento (li gestisce
  // l'operatore con "Applica esiti").
  const getBatchCallTargets = () => allAppointments
    .filter(a => {
      if (a.status !== 'confirmed' || a.date !== currentDate || !a.phone) return false;
      if (a.callStatus === 'calling') return false;
      if (a.callStatus === 'called' && !a.callOutcome) return false; // esito in arrivo
      if (a.callOutcome && !['non_risposto', 'sconosciuto'].includes(a.callOutcome.result)) return false;
      return true;
    })
    .sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

  const handleCallAll = async () => {
    const targets = getBatchCallTargets();
    if (targets.length === 0) {
      alert("Nessun appuntamento da chiamare per questa data (serve il telefono e una conferma ancora mancante).");
      return;
    }
    if (!window.confirm(`Avviare le chiamate AI per ${targets.length} sopralluoghi del ${currentDate}?\n\nGli esiti (conferma / rifiuto / richiesta di spostamento) verranno raccolti automaticamente.`)) return;

    setIsBatchCalling(true);
    try {
      for (const appt of targets) {
        setAllAppointments(prev => prev.map(a => a.id === appt.id ? { ...a, callStatus: 'calling' } : a));
        const res = await startConfirmationCall(appt);
        setAllAppointments(prev => prev.map(a => a.id === appt.id
          ? {
              ...a,
              callStatus: res.ok ? 'called' : 'failed',
              callId: res.ok ? res.callId : a.callId,
              calledAt: new Date().toISOString(),
              callOutcome: res.ok ? undefined : a.callOutcome,
            }
          : a));
        // Piccola pausa tra un avvio e l'altro
        await new Promise(r => setTimeout(r, 1500));
      }
    } finally {
      setIsBatchCalling(false);
    }
  };

  // --- Polling esiti: interroga Retell finché le chiamate lanciate non hanno un esito ---
  useEffect(() => {
    if (!allAppointments.some(needsOutcomePolling)) return;

    const interval = setInterval(async () => {
      const targets = allAppointments.filter(needsOutcomePolling);
      for (const appt of targets) {
        const poll = await fetchCallOutcome(appt.callId!);
        if (poll.pending) continue;
        const outcome = poll.outcome || {
          result: 'sconosciuto' as const,
          summary: poll.error,
          receivedAt: new Date().toISOString(),
        };
        setAllAppointments(prev => prev.map(a => a.id === appt.id ? { ...a, callOutcome: outcome } : a));
      }
    }, 15000);

    return () => clearInterval(interval);
  }, [allAppointments]);

  // --- Applica esiti: riorganizza il giro in base alle risposte dei clienti ---
  const handleApplyOutcomes = () => {
    const dayAppts = allAppointments.filter(a => a.status === 'confirmed' && a.date === currentDate && a.callOutcome);
    const refused = dayAppts.filter(a => a.callOutcome!.result === 'rifiutato');
    const toReschedule = dayAppts.filter(a => a.callOutcome!.result === 'riprogrammare');

    if (refused.length === 0 && toReschedule.length === 0) {
      alert("Nessuna modifica da applicare: nessun rifiuto né richiesta di spostamento tra gli esiti raccolti.");
      return;
    }

    const proceed = window.confirm(
      `Applicare gli esiti al giro del ${currentDate}?\n\n` +
      `• ${refused.length} rifiutati → Stand-by\n` +
      `• ${toReschedule.length} da riprogrammare → Stand-by (con la richiesta del cliente in nota)\n\n` +
      `Dopo, premi "Ottimizza" per ricalcolare sequenza e orari del giro con i soli confermati.`
    );
    if (!proceed) return;

    setAllAppointments(prev => prev.map(a => {
      if (a.status !== 'confirmed' || a.date !== currentDate || !a.callOutcome) return a;

      if (a.callOutcome.result === 'rifiutato') {
        return {
          ...a, status: 'standby' as const, date: undefined, sequenceOrder: undefined,
          startTime: undefined, endTime: undefined,
          notes: appendNote(a.notes, `Rifiutato dal cliente (chiamata AI del ${currentDate})`),
        };
      }
      if (a.callOutcome.result === 'riprogrammare') {
        const req = [a.callOutcome.requestedDate, a.callOutcome.requestedTime].filter(Boolean).join(' ');
        return {
          ...a, status: 'standby' as const, date: undefined, sequenceOrder: undefined,
          startTime: undefined, endTime: undefined,
          notes: appendNote(a.notes, `Da riprogrammare — richiesta cliente: ${req || 'altro giorno/orario'}`),
        };
      }
      return a;
    }));
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset Import State
    setShowImportModal(true);
    setImportFinished(false);
    setImportStats({ success: 0, failed: 0 });
    setFailedImports([]);
    setUploadProgress('Lettura file in corso...');

    try {
      // 1) Formato strutturato: colonne Intestatario/Indirizzo/Comune (+ Telefono/Note/Codice)
      //    È anche il formato prodotto dal bridge Prelios (giro arricchito).
      let importRows: ImportRow[] = [];
      let excludedInfo = '';

      const rows = await parseExcelFile(file);
      const validRows = rows.filter(r => r.Indirizzo && r.Comune);

      if (validRows.length > 0) {
        importRows = validRows.map(row => ({
          title: row.Intestatario || `${row.Indirizzo} ${row['N.Civ.'] || ''}`.trim(),
          fullAddress: `${row.Indirizzo} ${row['N.Civ.'] || ''}, ${row.Comune}, ${row['Prov.'] || ''}`.trim(),
          phone: extractPhoneFromRow(row),
          notes: row.Note ? `${row.Note}`.trim() : undefined,
          codice: extractCodiceFromRow(row),
        }));
      } else {
        // 2) Elenco pratiche MISI grezzo (export Prelios): SOLO tipologia FULL - Acquisto
        const { selected, excluded } = await parsePraticheMisi(file);
        importRows = selected.map(p => ({
          title: p.intestatario || `${p.via} ${p.civico}`.trim(),
          fullAddress: `${p.via} ${p.civico}, ${p.comune}, ${p.provincia}`.trim(),
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

      // Merge per codice pratica: le pratiche già presenti vengono AGGIORNATE
      // (telefono/note/progetto) invece di essere duplicate — è il flusso del
      // file arricchito dal bridge Prelios.
      const byCode = new Map<string, Appointment>();
      allAppointments.forEach(a => { if (a.periziaCode) byCode.set(a.periziaCode, a); });

      const newAppointments: Appointment[] = [];
      const updates = new Map<string, Partial<Appointment>>();
      const failures: string[] = [];
      const seenCodes = new Set<string>();
      let processedCount = 0;

      for (const row of importRows) {
        processedCount++;
        setUploadProgress(`Elaborazione pratica ${processedCount} di ${importRows.length}...${excludedInfo}`);

        // Dedupe righe duplicate nello stesso file
        if (row.codice) {
          if (seenCodes.has(row.codice)) continue;
          seenCodes.add(row.codice);
        }

        const existing = row.codice ? byCode.get(row.codice) : undefined;
        if (existing) {
          updates.set(existing.id, {
            phone: row.phone || existing.phone,
            notes: row.notes || existing.notes,
            project: row.project || existing.project,
          });
          continue;
        }

        // Rate limit strictness for Nominatim (skipped for cached/duplicate addresses)
        if (!hasCachedGeocode(row.fullAddress)) {
          await new Promise(resolve => setTimeout(resolve, 1100));
        }

        try {
          const result = await geocodeAddress(row.fullAddress);
          if (result) {
            newAppointments.push({
              id: Date.now() + Math.random().toString(),
              address: result.displayName,
              title: row.title,
              phone: row.phone,
              notes: row.notes,
              periziaCode: row.codice,
              project: row.project,
              coords: result.coords,
              status: 'pending' // Import as pending
            });
          } else {
            failures.push(`${row.fullAddress} (${row.title})`);
          }
        } catch (err) {
          console.error(err);
          failures.push(`${row.fullAddress} (Errore di rete)`);
        }
      }

      setAllAppointments(prev => [
        ...prev.map(a => updates.has(a.id) ? { ...a, ...updates.get(a.id) } : a),
        ...newAppointments
      ]);

      setImportStats({ success: newAppointments.length + updates.size, failed: failures.length });
      setFailedImports(failures);
      setImportFinished(true);
      setUploadProgress(updates.size > 0
        ? `Completato! ${newAppointments.length} nuove, ${updates.size} aggiornate (telefono/note).${excludedInfo}`
        : `Completato!${excludedInfo}`);

    } catch (error) {
      console.error(error);
      setUploadProgress("Errore durante la lettura del file.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const getExportData = () => {
    if (visibleAppointments.length === 0) return null;

    // Sort logic for export
    const sorted = [...visibleAppointments].sort((a: Appointment, b: Appointment) => {
        if(a.date !== b.date && a.date && b.date) return a.date.localeCompare(b.date);
        return (a.sequenceOrder||0) - (b.sequenceOrder||0);
    });

    // Format data similar to excelService export
    return sorted.map((a: Appointment) => ({
        'Data': a.date || 'Da definire',
        'Ordine': a.sequenceOrder || '-',
        'Ora Arrivo': a.startTime || '-',
        'Ora Partenza': a.endTime || '-',
        'Codice': a.periziaCode || '-',
        'Cliente': a.title,
        'Telefono': a.phone || '-',
        'Indirizzo': a.address,
        'Progetto': a.project || '',
        'Note': a.notes || '',
        'Stato': a.status,
        'Esito Cliente': a.callOutcome?.result || '-',
        'Distanza': a.distanceFromPrev || 0,
        'Tempo': a.travelTimeFromPrev || 0,
        'Pausa Pranzo': a.hasLunchBreakBefore ? 'Sì' : 'No'
    }));
  };

  const handleExport = () => {
    const data = getExportData();
    if (!data) {
      alert("Nessun appuntamento da esportare nella vista corrente.");
      return;
    }
    const filename = `Planning_${viewMode === 'day' ? currentDate : 'Export'}.xlsx`;
    // Re-sort the actual appointments array for the file generation function
    const sortedAppts = [...visibleAppointments].sort((a: Appointment, b: Appointment) => {
        if(a.date !== b.date && a.date && b.date) return a.date.localeCompare(b.date);
        return (a.sequenceOrder||0) - (b.sequenceOrder||0);
    });
    exportAppointmentsToExcel(sortedAppts, filename);
  };

  const handleSendToN8n = async () => {
      if (visibleAppointments.length === 0) {
          alert("Nessun dato da inviare.");
          return;
      }

      setIsSendingToN8n(true);
      try {
          const sortedAppts = [...visibleAppointments].sort((a: Appointment, b: Appointment) => {
              if(a.date !== b.date && a.date && b.date) return a.date.localeCompare(b.date);
              return (a.sequenceOrder||0) - (b.sequenceOrder||0);
          });

          // 1. Genera BLOB del file
          const blob = await generateExcelBlob(sortedAppts);
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
                     const sortedAppts = [...visibleAppointments].sort((a: Appointment, b: Appointment) => (a.sequenceOrder||0)-(b.sequenceOrder||0));
                     const blob = await generateExcelBlob(sortedAppts);
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
      setImportStats({ success: 0, failed: 0 });
      setFailedImports([]);
  };

  const handleStatusChange = (id: string, newStatus: AppointmentStatus) => {
    const target = allAppointments.find(a => a.id === id);

    setAllAppointments((prev: Appointment[]) => prev.map((a: Appointment) => {
        if (a.id !== id) return a;

        const update: Partial<Appointment> = { status: newStatus };
        if (newStatus === 'confirmed') {
            update.date = currentDate; // Assign to current date
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
        setCallTarget({ ...target, status: 'confirmed', date: currentDate });
    }
  };

  const handleOptimize = useCallback(async () => {
    const activePool = allAppointments.filter(a => 
        (a.status === 'confirmed' && a.date === currentDate) || a.status === 'pending'
    );
    
    if (activePool.length < 1) return; 
    
    setIsOptimizing(true);
    setIsSwapMode(false);
    setSelectedForSwap([]);

    try {
      const sorted = optimizeRoute(activePool, baseLocation?.coords);

      const startH = parseInt(startTime.split(':')[0]);
      const startM = parseInt(startTime.split(':')[1]);
      const endH = parseInt(endTimeLimit.split(':')[0]);

      const { scheduled, overflow } = await calculateSchedule(
        sorted, 
        baseLocation?.coords, 
        startH, 
        startM, 
        endH
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
  }, [allAppointments, currentDate, baseLocation, startTime, endTimeLimit]);

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
      const currentDayAppointments = allAppointments.filter(a => a.status === 'confirmed' && a.date === currentDate).sort((a: Appointment, b: Appointment) => (a.sequenceOrder||0)-(b.sequenceOrder||0));
      
      const idx1 = currentDayAppointments.findIndex(a => a.id === newSelection[0]);
      const idx2 = currentDayAppointments.findIndex(a => a.id === newSelection[1]);

      if (idx1 === -1 || idx2 === -1) return;

      const updatedList = [...currentDayAppointments];
      [updatedList[idx1], updatedList[idx2]] = [updatedList[idx2], updatedList[idx1]];

      setIsOptimizing(true);
      try {
        const startH = parseInt(startTime.split(':')[0]);
        const startM = parseInt(startTime.split(':')[1]);
        const endH = parseInt(endTimeLimit.split(':')[0]);

        const { scheduled, overflow } = await calculateSchedule(
            updatedList, 
            baseLocation?.coords, 
            startH, 
            startM, 
            endH
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

  const confirmedForDate = allAppointments.filter(a => a.status === 'confirmed' && a.date === currentDate).sort((a: Appointment, b: Appointment) => (a.sequenceOrder||0) - (b.sequenceOrder||0));
  const routeSummary = confirmedForDate.length > 0 ? calculateRouteSummary(confirmedForDate) : null;

  const listPending = allAppointments.filter(a => a.status === 'pending');
  const listStandby = allAppointments.filter(a => a.status === 'standby');

  // Small badge showing the AI call state on a card
  const CallBadge = ({ appt }: { appt: Appointment }) => {
    if (appt.callOutcome) return null; // l'esito sostituisce lo stato chiamata
    if (appt.callStatus === 'called') return <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-100 px-1 rounded animate-pulse">🕓 Esito in arrivo...</span>;
    if (appt.callStatus === 'calling') return <span className="text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-100 px-1 rounded animate-pulse">📞 In chiamata...</span>;
    if (appt.callStatus === 'failed') return <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-1 rounded">✗ Chiamata fallita</span>;
    return null;
  };

  // Badge with the client's answer collected by the AI call
  const OutcomeBadge = ({ appt }: { appt: Appointment }) => {
    const o = appt.callOutcome;
    if (!o) return null;
    const tooltip = [o.summary, o.clientNotes].filter(Boolean).join(' — ');
    switch (o.result) {
      case 'confermato':
        return <span title={tooltip} className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1 rounded">✅ Cliente ha confermato</span>;
      case 'rifiutato':
        return <span title={tooltip} className="text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 px-1 rounded">🚫 Rifiutato</span>;
      case 'riprogrammare': {
        const req = [o.requestedDate, o.requestedTime].filter(Boolean).join(' ');
        return <span title={tooltip} className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1 rounded">🔁 Chiede: {req || 'altro giorno/orario'}</span>;
      }
      case 'non_risposto':
        return <span title={tooltip} className="text-[10px] font-bold text-slate-600 bg-slate-100 border border-slate-200 px-1 rounded">📵 Non risponde</span>;
      default:
        return <span title={tooltip} className="text-[10px] font-bold text-slate-600 bg-slate-100 border border-slate-200 px-1 rounded">❓ Esito da verificare</span>;
    }
  };

  // Chip with the pratica/perizia code
  const CodeChip = ({ appt }: { appt: Appointment }) => (
    appt.periziaCode
      ? <span className="text-[10px] font-mono text-slate-500 bg-slate-100 border border-slate-200 px-1 rounded" title={appt.project || ''}>#{appt.periziaCode}</span>
      : null
  );

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">
      {/* --- ADD/EDIT APPOINTMENT MODAL --- */}
      {showApptModal && (
        <AppointmentModal
          initial={editingAppointment}
          onSave={handleSaveAppointment}
          onClose={() => { setShowApptModal(false); setEditingAppointment(null); }}
        />
      )}

      {/* --- AI CALL MODAL (Retell) --- */}
      {callTarget && (
        <CallModal
          appointment={callTarget}
          onClose={() => setCallTarget(null)}
          onCallStarted={handleCallStarted}
          onCallResult={handleCallResult}
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
                        {importStats.failed > 0 && (
                            <p className="text-sm text-red-500 bg-red-50 p-2 rounded">
                                ⚠️ {importStats.failed} indirizzi non trovati.
                            </p>
                        )}
                    </div>
                    
                    {failedImports.length > 0 && (
                        <div className="flex-1 overflow-y-auto mb-4 bg-slate-50 rounded border border-slate-200 p-2 text-left">
                            <p className="text-xs font-bold text-slate-500 mb-2 sticky top-0 bg-slate-50">Dettaglio errori:</p>
                            <ul className="text-xs text-red-600 space-y-1">
                                {failedImports.map((failStr, i) => (
                                    <li key={i} className="flex gap-1.5 items-start">
                                        <span className="shrink-0">•</span>
                                        <span>{failStr}</span>
                                    </li>
                                ))}
                            </ul>
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
            <p className="text-xs text-slate-500 hidden sm:block">Gestione Giornaliera e Stati</p>
          </div>
        </div>
        
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
      </header>

      {/* Main Content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        
        {/* Sidebar */}
        <aside className="w-full md:w-96 bg-white z-20 flex flex-col border-r border-slate-200 shadow-xl md:shadow-none">
          
           {/* Filters Bar */}
           <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between gap-1 overflow-x-auto">
             <label className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-50 text-blue-800 border border-blue-100 cursor-pointer whitespace-nowrap">
                <input type="checkbox" checked={filters.confirmed} onChange={e => setFilters(p => ({...p, confirmed: e.target.checked}))} className="rounded text-blue-600 focus:ring-0" />
                Confermate ({allAppointments.filter(a => a.status === 'confirmed').length})
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
                  <input type="text" value={baseInput} onChange={e => setBaseInput(e.target.value)} placeholder="Imposta Base..." className="flex-1 px-3 py-1.5 rounded-lg border text-sm" />
                  <button type="submit" className="bg-red-500 text-white px-3 rounded-lg text-xs font-bold">SET</button>
                </form>
            ) : (
                <div className="flex items-center justify-between text-xs bg-white p-2 rounded border border-red-200">
                    <span className="truncate flex-1 text-slate-700">🏠 Base: <b>{baseLocation.address.split(',')[0]}</b></span>
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
              <PlusIcon /> Nuovo completo (cliente, telefono, note)
            </button>

            {/* Time Limits */}
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
          </div>

          {/* Controls */}
          <div className="p-2 grid grid-cols-2 gap-2 bg-white border-b border-slate-100">
             <button onClick={handleOptimize} className="col-span-2 bg-emerald-600 hover:bg-emerald-700 text-white py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2">
                {isOptimizing ? "Calcolo..." : <><SparklesIcon /> Ottimizza {currentDate}</>}
             </button>
             {confirmedForDate.length > 0 && viewMode === 'day' && (
                <button onClick={() => setIsSwapMode(!isSwapMode)} className={`text-xs py-1.5 border rounded flex items-center justify-center gap-1 ${isSwapMode ? 'bg-amber-100 text-amber-800' : 'text-slate-600'}`}>
                    <ArrowsRightLeftIcon /> Scambia Ordine
                </button>
             )}

             {/* Giro giornaliero: chiamate AI in blocco + applicazione esiti */}
             {confirmedForDate.length > 0 && viewMode === 'day' && (
                <div className="col-span-2 grid grid-cols-2 gap-2">
                    <button
                        onClick={handleCallAll}
                        disabled={isBatchCalling}
                        className="text-xs py-1.5 border rounded flex items-center justify-center gap-1 text-white bg-emerald-600 hover:bg-emerald-700 border-emerald-700 disabled:opacity-60 transition-colors"
                    >
                        <PhoneIcon /> {isBatchCalling ? 'Chiamate in corso...' : `Chiama tutti (${getBatchCallTargets().length})`}
                    </button>
                    <button
                        onClick={handleApplyOutcomes}
                        className="text-xs py-1.5 border rounded flex items-center justify-center gap-1 text-amber-700 border-amber-300 bg-amber-50 hover:bg-amber-100 transition-colors"
                    >
                        🔁 Applica esiti al giro
                    </button>
                </div>
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
            
            {/* 1. Confirmed */}
            {filters.confirmed && (
                <div>
                    <h3 className="text-xs font-bold text-blue-600 uppercase tracking-wider mb-2 border-b border-blue-100 pb-1 flex justify-between">
                        <span>Confermate ({visibleAppointments.filter(a => a.status === 'confirmed').length})</span>
                        <span className="text-slate-400 font-normal normal-case">{viewMode === 'day' ? 'Giorno' : viewMode === 'week' ? 'Settimana' : 'Mese'}</span>
                    </h3>
                    <div className="space-y-2">
                        {visibleAppointments.filter(a => a.status === 'confirmed')
                         .sort((a,b) => {
                             if(a.date !== b.date && a.date && b.date) return a.date.localeCompare(b.date);
                             return (a.sequenceOrder||0) - (b.sequenceOrder||0);
                         })
                         .map((appt) => (
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
                                    `}
                                >
                                    <div className="flex justify-between items-start">
                                        <div className="flex gap-2">
                                            <div className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-bold flex-shrink-0">
                                                {appt.sequenceOrder}
                                            </div>
                                            <div>
                                                <h4 className="text-sm font-semibold text-slate-800 leading-tight">{appt.title}</h4>
                                                <p className="text-xs text-slate-500">{appt.address}</p>
                                                {appt.phone && <p className="text-xs text-slate-500 mt-0.5">📞 {appt.phone}</p>}
                                                <div className="mt-1 flex gap-2 flex-wrap items-center">
                                                    {viewMode !== 'day' && <span className="text-xs font-bold text-slate-600 bg-slate-100 px-1 rounded">{appt.date}</span>}
                                                    <span className="text-xs font-mono text-blue-700 bg-blue-100 inline-block px-1 rounded">
                                                        {appt.startTime} - {appt.endTime}
                                                    </span>
                                                    <CodeChip appt={appt} />
                                                    <CallBadge appt={appt} />
                                                    <OutcomeBadge appt={appt} />
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
                        ))}
                        {visibleAppointments.filter(a => a.status === 'confirmed').length === 0 && <p className="text-xs text-slate-400 italic">Nessun appuntamento confermato nel periodo.</p>}
                    </div>
                </div>
            )}

            {/* 2. Pending */}
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
                                    p-3 rounded-lg border border-orange-200 bg-white flex justify-between items-start transition-all
                                    ${selectedAppointmentId === appt.id ? 'ring-2 ring-orange-400 shadow-md' : ''}
                                `}
                             >
                                 <div>
                                     <h4 className="text-sm font-semibold text-slate-700">{appt.title}</h4>
                                     <p className="text-xs text-slate-400">{appt.address}</p>
                                     {appt.phone && <p className="text-xs text-slate-400 mt-0.5">📞 {appt.phone}</p>}
                                     {appt.notes && <p className="text-xs text-slate-400 italic mt-0.5 line-clamp-2">{appt.notes}</p>}
                                     <div className="mt-1 flex gap-1 flex-wrap"><CodeChip appt={appt} /><CallBadge appt={appt} /><OutcomeBadge appt={appt} /></div>
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

            {/* 3. Standby */}
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
                                     <h4 className="text-sm font-semibold text-slate-600">{appt.title}</h4>
                                     <p className="text-xs text-slate-400">{appt.address}</p>
                                     {appt.phone && <p className="text-xs text-slate-400 mt-0.5">📞 {appt.phone}</p>}
                                     {appt.notes && <p className="text-xs text-slate-400 italic mt-0.5 line-clamp-2">{appt.notes}</p>}
                                     <div className="mt-1 flex gap-1 flex-wrap"><CodeChip appt={appt} /><OutcomeBadge appt={appt} /></div>
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
              {baseLocation && <p className="text-red-500 mt-1">Base: {baseLocation.address.split(',')[0]}</p>}
            </div>
          </div>
        </main>

      </div>
    </div>
  );
}

export default App;