import type { Appointment, Technician } from '../types';
import { geocodeAddressParts } from '../services/geocodingService';
import { matchTechnician } from '../services/technicianService';
import { provinceToCode } from '../utils/provinces';
import type { BridgePratica } from '../services/bridgeService';

// Nucleo dell'import delle pratiche, comune all'import da file (Excel / MISI)
// e all'inbox del bridge: righe strutturate -> pratiche (merge per codice,
// geocoding con fallback, assegnazione del tecnico per zona, posizioni
// approssimate). Non tocca lo stato: restituisce cosa aggiungere/aggiornare.

// Riga normalizzata prodotta da qualunque formato di import supportato
export interface ImportRow {
  title: string;
  street?: string;       // via (per il geocoding con fallback)
  civic?: string;
  fullAddress: string;
  shortAddress?: string; // via + civico (pronunciato in chiamata e per il gestionale)
  comune?: string;
  province?: string;
  phone?: string;
  notes?: string;
  urgent?: boolean;
  codice?: string;       // codice pratica/perizia (per merge e link Prelios)
  project?: string;
}

export interface ImportCoreResult {
  newAppointments: Appointment[];
  updates: Map<string, Partial<Appointment>>; // pratiche già presenti (merge per codice)
  failures: string[];
  approximates: string[];
}

const appendNote = (notes: string | undefined, extra: string): string =>
  notes ? `${notes} | ${extra}` : extra;

export const importRowsToAppointments = async (
  importRows: ImportRow[],
  existingAppointments: Appointment[],
  technicians: Technician[],
  onProgress?: (processed: number, total: number) => void
): Promise<ImportCoreResult> => {
  // Merge per codice pratica: le pratiche già presenti vengono AGGIORNATE
  // (telefono/note/progetto) invece di essere duplicate — è il flusso del
  // file arricchito dal bridge Prelios.
  const byCode = new Map<string, Appointment>();
  existingAppointments.forEach(a => { if (a.periziaCode) byCode.set(a.periziaCode, a); });

  const newAppointments: Appointment[] = [];
  const updates = new Map<string, Partial<Appointment>>();
  const failures: string[] = [];
  const approximates: string[] = [];
  const seenCodes = new Set<string>();
  let processedCount = 0;

  for (const row of importRows) {
    processedCount++;
    onProgress?.(processedCount, importRows.length);

    // Dedupe righe duplicate nello stesso file
    if (row.codice) {
      if (seenCodes.has(row.codice)) continue;
      seenCodes.add(row.codice);
    }

    const existing = row.codice ? byCode.get(row.codice) : undefined;
    if (existing) {
      updates.set(existing.id, {
        phone: row.phone || existing.phone,
        // Le note operative locali (esiti, richieste cliente) NON vanno
        // sovrascritte dal file: si appende solo contenuto nuovo
        notes: !existing.notes
          ? row.notes
          : (row.notes && !existing.notes.includes(row.notes)
              ? appendNote(existing.notes, row.notes)
              : existing.notes),
        project: row.project || existing.project,
      });
      continue;
    }

    try {
      // Geocoding con fallback: indirizzo esatto, poi varianti (senza
      // civico, senza prefisso via/piazza) e infine centro del comune.
      // Il rate limit Nominatim è gestito dentro il servizio.
      const result = await geocodeAddressParts({
        street: row.street,
        civic: row.civic,
        comune: row.comune,
        province: row.province,
      });
      if (result) {
        // Provincia: la colonna del file è più affidabile del geocoding
        const province = provinceToCode(row.province) || result.province;
        const comune = row.comune || result.comune;
        const matched = matchTechnician({ coords: result.coords, province }, technicians);

        if (result.approximate) {
          approximates.push(`${row.fullAddress} (${row.title})`);
        }

        newAppointments.push({
          id: Date.now() + Math.random().toString(),
          // Se la posizione è approssimativa manteniamo l'indirizzo del
          // file (quello del comune sarebbe fuorviante per il tecnico)
          address: result.approximate ? row.fullAddress : result.displayName,
          shortAddress: row.shortAddress,
          title: row.title,
          phone: row.phone,
          notes: row.notes,
          coords: result.coords,
          province,
          comune,
          urgent: row.urgent || undefined,
          approximate: result.approximate || undefined,
          periziaCode: row.codice,
          project: row.project,
          technicianId: matched?.id,
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

  return { newAppointments, updates, failures, approximates };
};

// Applica il risultato dell'import all'elenco (aggiornamenti + nuove in coda)
export const applyImportResult = (
  all: Appointment[],
  result: Pick<ImportCoreResult, 'newAppointments' | 'updates'>
): Appointment[] => [
  ...all.map(a => (result.updates.has(a.id) ? { ...a, ...result.updates.get(a.id) } : a)),
  ...result.newAppointments,
];

// Pratica del bridge -> riga di import (stessa forma dell'elenco MISI)
export const bridgePraticaToRow = (p: BridgePratica): ImportRow => ({
  title: p.intestatario || `${p.via} ${p.civico}`.trim(),
  street: p.via || undefined,
  civic: p.civico || undefined,
  fullAddress: `${p.via} ${p.civico}, ${p.comune}, ${p.provincia}`.trim(),
  shortAddress: `${p.via} ${p.civico}`.trim(),
  comune: p.comune || undefined,
  province: p.provincia || undefined,
  phone: p.telefono || undefined,
  notes: p.note || undefined,
  codice: p.codice,
  project: p.progetto || undefined,
});
