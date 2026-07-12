import * as XLSX from 'xlsx';
import type { Appointment } from '../types';

export interface ExcelRow {
  Intestatario?: string;
  Indirizzo?: string;
  'N.Civ.'?: string | number;
  Comune?: string;
  'Prov.'?: string;
  Telefono?: string | number;
  Note?: string;
  Codice?: string | number; // codice pratica/perizia (file arricchito dal bridge)
  [key: string]: any; // Allow other columns but ignore them
}

// Extract the pratica/perizia code from commonly used column names
export const extractCodiceFromRow = (row: ExcelRow): string | undefined => {
  const candidates = ['Codice', 'Codice Perizia', 'Cod. Immobile', 'Cod Immobile', 'Pratica'];
  for (const col of candidates) {
    const value = row[col];
    if (value !== undefined && value !== null && `${value}`.trim() !== '') {
      return `${value}`.trim().replace(/\./g, '');
    }
  }
  return undefined;
};

// Extract a phone number from any of the commonly used column names
export const extractPhoneFromRow = (row: ExcelRow): string | undefined => {
  const candidates = ['Telefono', 'Tel', 'Tel.', 'Cellulare', 'Cell', 'Cell.', 'Numero', 'Phone'];
  for (const col of candidates) {
    const value = row[col];
    if (value !== undefined && value !== null && `${value}`.trim() !== '') {
      return `${value}`.trim();
    }
  }
  return undefined;
};

// ============================================================
// Elenco pratiche MISI (export grezzo Prelios/Intesa)
// ============================================================

export interface PraticaMisi {
  codice: string;       // codice pratica/perizia, es. "826361"
  intestatario: string;
  via: string;
  civico: string;
  comune: string;
  provincia: string;
  progetto: string;     // commessa, es. "01-09546 (INTESA SANPAOLO (2019))"
  tipologia: string;    // es. "FULL - Acquisto"
  noteGestore: string;  // es. "Rif. Gestore: ..."
}

const normalizeTipologia = (value: string): string =>
  value.toUpperCase().replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();

// Only "FULL - Acquisto" rows are relevant for the sopralluoghi tour
export const isFullAcquisto = (tipologia: string): boolean =>
  normalizeTipologia(tipologia) === 'FULL - ACQUISTO';

const TIPOLOGIA_PATTERN = /^(FULL|DSKT|DRIVE)\s*-\s*.+/i;

// Parse the raw pratiche list. Works with or without a header row: each row
// is anchored on the "Tipologia" column (values like "FULL - Acquisto"),
// from which the other fields sit at fixed relative offsets:
//   progetto = T-2, intestatario = T+3, via = T+4, civico = T+5,
//   comune = T+6, provincia = T+7; codice = 5-7 digit cell before T.
export const parseMisiRows = (rows: any[][]): PraticaMisi[] => {
  const pratiche: PraticaMisi[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 10) continue;
    const cells = row.map(c => (c === undefined || c === null) ? '' : `${c}`.trim());

    // Anchor: tipologia column
    const t = cells.findIndex(c => TIPOLOGIA_PATTERN.test(c));
    if (t < 0 || t < 2 || t + 7 >= cells.length) continue;

    // Codice pratica: 5-7 digit numeric cell before the tipologia column
    let codice = '';
    for (let i = 0; i < t; i++) {
      if (/^\d{5,7}$/.test(cells[i])) { codice = cells[i]; break; }
    }
    if (!codice) continue;

    const pratica: PraticaMisi = {
      codice,
      tipologia: cells[t],
      progetto: cells[t - 2] || '',
      intestatario: cells[t + 3] || '',
      via: cells[t + 4] || '',
      civico: cells[t + 5] || '',
      comune: cells[t + 6] || '',
      provincia: cells[t + 7] || '',
      noteGestore: '',
    };

    // Sanity: without street and town the row is not usable
    if (!pratica.via || !pratica.comune) continue;

    // Note gestore: last long text cell after the address block
    for (let i = cells.length - 1; i > t + 7; i--) {
      const c = cells[i];
      if (c && !/^[\d\s/:.,-]+$/.test(c) && !/^U\d+$/i.test(c) && c.length > 8) {
        pratica.noteGestore = c.replace(/\s+/g, ' ').trim();
        break;
      }
    }

    pratiche.push(pratica);
  }

  return pratiche;
};

// Read the raw MISI pratiche file (xlsx/xls/csv) and return ONLY the
// "FULL - Acquisto" rows, ready to be geocoded and mapped.
export const parsePraticheMisi = async (file: File): Promise<{ selected: PraticaMisi[]; excluded: number }> => {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: false });

  const all = parseMisiRows(rows);
  const selected = all.filter(p => isFullAcquisto(p.tipologia));
  return { selected, excluded: all.length - selected.length };
};

// Tag "urgente" da colonne tipo Urgente/Urgenza/Priorità: valori accettati
// sì/si/x/1/true/urgente/alta
export const extractUrgentFromRow = (row: ExcelRow): boolean => {
  const candidates = ['Urgente', 'Urgenza', 'Priorità', 'Priorita', 'Urgent'];
  for (const col of candidates) {
    const value = row[col];
    if (value === undefined || value === null) continue;
    const s = `${value}`.trim().toLowerCase();
    if (['sì', 'si', 'x', '1', 'true', 'urgente', 'urgent', 'alta', 'yes'].includes(s)) {
      return true;
    }
  }
  return false;
};

export const parseExcelFile = async (file: File): Promise<ExcelRow[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data) {
          reject("No data read");
          return;
        }

        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        // Convert to JSON
        const jsonData = XLSX.utils.sheet_to_json<ExcelRow>(worksheet);
        resolve(jsonData);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = (error) => reject(error);
    reader.readAsArrayBuffer(file);
  });
};

const ISSUE_EXPORT_LABEL: Record<string, string> = {
  wrong_phone: 'Numero non corretto',
  callback: 'Da richiamare',
  works_pending: 'Lavori da ultimare',
};

const statusLabel = (a: Appointment): string => {
  if (a.status === 'confirmed') return 'Confermato';
  if (a.status === 'proposed') return 'Proposto (da confermare)';
  if (a.status === 'standby') return 'Stand-by';
  if (a.status === 'issue') return `Problema: ${ISSUE_EXPORT_LABEL[a.issueType || ''] || 'da gestire'}`;
  if (a.status === 'cancelled') return 'Annullata';
  return 'In Attesa';
};

// Helper function to create the workbook structure
const createWorkbook = (
  appointments: Appointment[],
  technicianNameById: Record<string, string> = {}
) => {
  // Format data for export (l'esito della conversazione ha la precedenza)
  const OUTCOME_EXPORT_LABEL: Record<string, string> = {
    confermato: 'Confermata dal cliente',
    riprogrammare: 'Da riprogrammare',
    da_richiamare: 'Da richiamare',
    numero_errato: 'Numero errato',
    lavori_non_ultimati: 'Lavori da ultimare',
    annullato: 'Annullata dal cliente',
    rifiutato: 'Rifiutata dal cliente',
    altro_referente: 'Indicato altro referente',
    non_risposto: 'Non risponde',
    sconosciuto: 'Esito da verificare',
  };
  const callStatusLabel = (a: Appointment): string => {
    if (a.callOutcome) return OUTCOME_EXPORT_LABEL[a.callOutcome.result] || 'Esito da verificare';
    if (a.callStatus === 'called') return 'Effettuata';
    if (a.callStatus === 'calling') return 'In corso';
    if (a.callStatus === 'failed') return 'Fallita';
    return '-';
  };

  const dataToExport = appointments.map(a => ({
    'Data': a.date || 'Da definire',
    'Tecnico': (a.technicianId && technicianNameById[a.technicianId]) || '-',
    'Urgente': a.urgent ? 'SÌ' : 'No',
    'Ordine': a.sequenceOrder || '-',
    'Ora Arrivo': a.startTime || '-',
    'Ora Partenza': a.endTime || '-',
    'Cliente/Intestatario': a.title,
    'Telefono': a.phone || '-',
    'Indirizzo Completo': a.address,
    'Prov.': a.province || '-',
    'Codice': a.periziaCode || '-',
    'Note': a.notes || '',
    'Stato': statusLabel(a),
    'Rientro previsto': a.followUpDate || '-',
    'Chiamata AI': callStatusLabel(a),
    'Distanza da prec. (km)': a.distanceFromPrev || 0,
    'Tempo viaggio (min)': a.travelTimeFromPrev || 0,
    'Pausa Pranzo Prima': a.hasLunchBreakBefore ? 'Sì' : 'No'
  }));

  const worksheet = XLSX.utils.json_to_sheet(dataToExport);

  // Auto-width for columns (simple approximation)
  const wscols = [
    { wch: 12 }, // Date
    { wch: 18 }, // Technician
    { wch: 9 },  // Urgent
    { wch: 8 },  // Order
    { wch: 10 }, // Start
    { wch: 10 }, // End
    { wch: 30 }, // Name
    { wch: 16 }, // Phone
    { wch: 50 }, // Address
    { wch: 7 },  // Province
    { wch: 30 }, // Notes
    { wch: 26 }, // Status
    { wch: 14 }, // Follow-up
    { wch: 12 }, // AI call
    { wch: 15 }, // Dist
    { wch: 15 }, // Time
    { wch: 10 }  // Lunch
  ];
  worksheet['!cols'] = wscols;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Pianificazione");
  return workbook;
};

// Generate a Blob object directly (for sending via API)
export const generateExcelBlob = async (
  appointments: Appointment[],
  technicianNameById: Record<string, string> = {}
): Promise<Blob> => {
  const workbook = createWorkbook(appointments, technicianNameById);
  const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
};

export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
        const result = reader.result as string;
        resolve(result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Trigger a browser download
export const exportAppointmentsToExcel = (
  appointments: Appointment[],
  filename: string,
  technicianNameById: Record<string, string> = {}
) => {
  const workbook = createWorkbook(appointments, technicianNameById);
  XLSX.writeFile(workbook, filename);
};