import * as XLSX from 'xlsx';
import type { Appointment } from '../types';

export interface ExcelRow {
  Intestatario?: string;
  Indirizzo?: string;
  'N.Civ.'?: string | number;
  Comune?: string;
  'Prov.'?: string;
  [key: string]: any; 
}

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

const createWorkbook = (appointments: Appointment[]) => {
  const dataToExport = appointments.map(a => ({
    'Data': a.date || 'Da definire',
    'Ordine': a.sequenceOrder || '-',
    'Ora Arrivo': a.startTime || '-',
    'Ora Partenza': a.endTime || '-',
    'Cliente/Intestatario': a.title,
    'Indirizzo Completo': a.address,
    'Stato': a.status === 'confirmed' ? 'Confermato' : (a.status === 'standby' ? 'Stand-by' : 'In Attesa'),
    'Distanza da prec. (km)': a.distanceFromPrev || 0,
    'Tempo viaggio (min)': a.travelTimeFromPrev || 0,
    'Pausa Pranzo Prima': a.hasLunchBreakBefore ? 'Sì' : 'No'
  }));

  const worksheet = XLSX.utils.json_to_sheet(dataToExport);
  
  const wscols = [
    { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 30 }, 
    { wch: 50 }, { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 10 }
  ];
  worksheet['!cols'] = wscols;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Pianificazione");
  return workbook;
};

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

export const exportAppointmentsToExcel = (appointments: Appointment[], filename: string) => {
  const workbook = createWorkbook(appointments);
  XLSX.writeFile(workbook, filename);
};