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
  [key: string]: any; // Allow other columns but ignore them
}

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

// Helper function to create the workbook structure
const createWorkbook = (appointments: Appointment[]) => {
  // Format data for export
  const callStatusLabel = (a: Appointment): string => {
    if (a.callStatus === 'called') return 'Effettuata';
    if (a.callStatus === 'calling') return 'In corso';
    if (a.callStatus === 'failed') return 'Fallita';
    return '-';
  };

  const dataToExport = appointments.map(a => ({
    'Data': a.date || 'Da definire',
    'Ordine': a.sequenceOrder || '-',
    'Ora Arrivo': a.startTime || '-',
    'Ora Partenza': a.endTime || '-',
    'Cliente/Intestatario': a.title,
    'Telefono': a.phone || '-',
    'Indirizzo Completo': a.address,
    'Note': a.notes || '',
    'Stato': a.status === 'confirmed' ? 'Confermato' : (a.status === 'standby' ? 'Stand-by' : 'In Attesa'),
    'Chiamata AI': callStatusLabel(a),
    'Distanza da prec. (km)': a.distanceFromPrev || 0,
    'Tempo viaggio (min)': a.travelTimeFromPrev || 0,
    'Pausa Pranzo Prima': a.hasLunchBreakBefore ? 'Sì' : 'No'
  }));

  const worksheet = XLSX.utils.json_to_sheet(dataToExport);

  // Auto-width for columns (simple approximation)
  const wscols = [
    { wch: 12 }, // Date
    { wch: 8 },  // Order
    { wch: 10 }, // Start
    { wch: 10 }, // End
    { wch: 30 }, // Name
    { wch: 16 }, // Phone
    { wch: 50 }, // Address
    { wch: 30 }, // Notes
    { wch: 12 }, // Status
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
export const generateExcelBlob = async (appointments: Appointment[]): Promise<Blob> => {
  const workbook = createWorkbook(appointments);
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
export const exportAppointmentsToExcel = (appointments: Appointment[], filename: string) => {
  const workbook = createWorkbook(appointments);
  XLSX.writeFile(workbook, filename);
};