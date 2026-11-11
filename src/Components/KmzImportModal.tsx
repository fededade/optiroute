import React, { useEffect, useMemo, useState } from 'react';
import type { Appointment, IssueType, Technician } from '../types';
import { parseKmzFile, type KmzLayer, type KmzTarget, type KmzTargetKind } from '../services/kmzService';
import { matchTechnician } from '../services/technicianService';
import { provinceToCode } from '../utils/provinces';

// Import da Google My Maps: l'utente rivede la destinazione proposta per ogni
// livello della mappa e importa tutto in un colpo solo (niente geocoding:
// le coordinate arrivano dal file).

interface KmzImportModalProps {
  file: File;
  technicians: Technician[];
  existing: Appointment[];
  onApply: (newAppointments: Appointment[]) => void;
  onClose: () => void;
}

const ISSUE_LABEL: Record<IssueType, string> = {
  wrong_phone: '📵 Numeri non corretti',
  callback: '📆 Da richiamare',
  works_pending: '🚧 Lavori da ultimare',
};

// Valori del select destinazione (kind + issueType compattati)
const TARGET_OPTIONS: { value: string; label: string }[] = [
  { value: 'skip', label: '— Salta (non importare)' },
  { value: 'confirmed', label: '✔ Confermate (con data)' },
  { value: 'pending', label: '🕒 In attesa / da pianificare' },
  { value: 'standby', label: '⏸ Stand-by' },
  { value: 'issue:wrong_phone', label: ISSUE_LABEL.wrong_phone },
  { value: 'issue:callback', label: ISSUE_LABEL.callback },
  { value: 'issue:works_pending', label: ISSUE_LABEL.works_pending },
  { value: 'cancelled', label: '✖ Annullate (archivio)' },
];

const targetToValue = (t: KmzTarget): string =>
  t.kind === 'issue' ? `issue:${t.issueType || 'callback'}` : t.kind;

const valueToTarget = (value: string, date?: string): KmzTarget => {
  if (value.startsWith('issue:')) {
    return { kind: 'issue', issueType: value.split(':')[1] as IssueType };
  }
  return { kind: value as KmzTargetKind, date };
};

// Chiave di deduplica: coordinate arrotondate + titolo/indirizzo
const dupKey = (coords: { lat: number; lng: number }, title: string): string =>
  `${coords.lat.toFixed(5)}|${coords.lng.toFixed(5)}|${title.trim().toLowerCase()}`;

const addMinutes = (hhmm: string, minutes: number): string => {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  const total = (h || 0) * 60 + (m || 0) + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const KmzImportModal: React.FC<KmzImportModalProps> = ({ file, technicians, existing, onApply, onClose }) => {
  const [layers, setLayers] = useState<KmzLayer[] | null>(null);
  const [error, setError] = useState('');
  const [targets, setTargets] = useState<Record<number, KmzTarget>>({});
  const [summary, setSummary] = useState<{ imported: number; skipped: number; duplicates: number; perKind: Record<string, number> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    parseKmzFile(file)
      .then(parsed => {
        if (cancelled) return;
        setLayers(parsed);
        setTargets(Object.fromEntries(parsed.map((l, i) => [i, l.suggested])));
      })
      .catch(err => {
        console.error(err);
        if (!cancelled) setError(err?.message || 'Impossibile leggere il file.');
      });
    return () => { cancelled = true; };
  }, [file]);

  const existingKeys = useMemo(
    () => new Set(existing.map(a => dupKey(a.coords, a.title))),
    [existing]
  );

  const setLayerTarget = (index: number, value: string) => {
    setTargets(prev => ({ ...prev, [index]: valueToTarget(value, prev[index]?.date) }));
  };

  const setLayerDate = (index: number, date: string) => {
    setTargets(prev => ({ ...prev, [index]: { ...prev[index], date } }));
  };

  // Tecnico: prima il nome dopo "slp ..." nella scheda, poi la zona di competenza
  const resolveTechnician = (techGuess: string | undefined, coords: { lat: number; lng: number }, province?: string): string | undefined => {
    if (techGuess) {
      const byName = technicians.find(t =>
        t.active && t.name.toLowerCase().split(/\s+/)[0] === techGuess
      );
      if (byName) return byName.id;
    }
    return matchTechnician({ coords, province }, technicians)?.id;
  };

  const handleImport = () => {
    if (!layers) return;

    const seen = new Set(existingKeys);
    const built: Appointment[] = [];
    let duplicates = 0;
    let skipped = 0;
    const perKind: Record<string, number> = {};

    layers.forEach((layer, index) => {
      const target = targets[index] || layer.suggested;
      if (target.kind === 'skip') {
        skipped += layer.placemarks.length;
        return;
      }

      for (const pm of layer.placemarks) {
        const title = pm.title || pm.address.split(',')[0];
        const key = dupKey(pm.coords, title);
        if (seen.has(key)) {
          duplicates += 1;
          continue;
        }
        seen.add(key);

        // Provincia dalla sigla in coda all'indirizzo (es. "… Landriano PV")
        const provMatch = /\b([A-Z]{2})\b\s*$/.exec(pm.address);
        const province = provinceToCode(provMatch?.[1]);

        const isConfirmed = target.kind === 'confirmed' && !!target.date;
        const issueType: IssueType | undefined =
          target.kind === 'issue' ? (pm.issueGuess || target.issueType || 'callback') : undefined;

        const appt: Appointment = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          address: pm.address,
          title,
          coords: pm.coords,
          province,
          phone: pm.phone,
          notes: pm.notes,
          status: target.kind === 'issue' ? 'issue'
            : isConfirmed ? 'confirmed'
            : target.kind === 'confirmed' ? 'pending' // confermata senza data -> in attesa
            : target.kind,
          issueType,
          date: isConfirmed ? target.date : undefined,
          startTime: isConfirmed ? pm.timeGuess : undefined,
          technicianId: resolveTechnician(pm.techGuess, pm.coords, province),
        };
        built.push(appt);
        const kindLabel = appt.status === 'issue' ? `issue:${issueType}` : appt.status;
        perKind[kindLabel] = (perKind[kindLabel] || 0) + 1;
      }
    });

    // Ordine e orario di fine per le confermate: per (data, tecnico), in ordine di orario
    const groups = new Map<string, Appointment[]>();
    for (const a of built) {
      if (a.status !== 'confirmed' || !a.date) continue;
      const k = `${a.date}|${a.technicianId || 'none'}`;
      const g = groups.get(k) || [];
      g.push(a);
      groups.set(k, g);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));
      group.forEach((a, i) => {
        a.sequenceOrder = i + 1;
        if (a.startTime) a.endTime = addMinutes(a.startTime, a.durationMinutes || 20);
      });
    }

    onApply(built);
    setSummary({ imported: built.length, skipped, duplicates, perKind });
  };

  const kindSummaryLabel = (k: string): string => {
    if (k.startsWith('issue:')) return ISSUE_LABEL[k.split(':')[1] as IssueType] || k;
    if (k === 'confirmed') return '✔ Confermate';
    if (k === 'pending') return '🕒 In attesa';
    if (k === 'standby') return '⏸ Stand-by';
    if (k === 'cancelled') return '✖ Annullate';
    return k;
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-bold text-slate-800">Importa da Google My Maps</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none px-1">✕</button>
        </div>
        <p className="text-xs text-slate-500 mb-4 truncate">File: {file.name}</p>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded p-3">{error}</p>
        )}

        {!error && !layers && (
          <div className="py-10 text-center">
            <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-3"></div>
            <p className="text-sm text-slate-500">Lettura della mappa in corso...</p>
          </div>
        )}

        {!error && layers && !summary && (
          <>
            <p className="text-xs text-slate-500 mb-3">
              Ogni <b>livello</b> della mappa viene importato nella destinazione indicata (proposta automatica, modificabile).
              Le schede con "numero non corretto" o "immobile non ultimato" nel testo vengono affinate da sole nella
              categoria giusta. Niente geocoding: le posizioni arrivano dal file.
            </p>

            <div className="space-y-2 mb-4">
              {layers.map((layer, i) => {
                const target = targets[i] || layer.suggested;
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2 border border-slate-200 rounded-lg p-2.5 bg-slate-50">
                    <div className="flex-1 min-w-[140px]">
                      <p className="text-sm font-bold text-slate-700 truncate">{layer.name}</p>
                      <p className="text-[11px] text-slate-400">{layer.placemarks.length} schede</p>
                    </div>
                    <select
                      value={targetToValue(target)}
                      onChange={e => setLayerTarget(i, e.target.value)}
                      className="px-2 py-1.5 rounded-lg border border-slate-300 text-xs bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    >
                      {TARGET_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    {target.kind === 'confirmed' && (
                      <input
                        type="date"
                        value={target.date || ''}
                        onChange={e => setLayerDate(i, e.target.value)}
                        className="px-2 py-1 rounded-lg border border-slate-300 text-xs bg-white focus:ring-2 focus:ring-indigo-500 outline-none"
                        title="Data delle conferme di questo livello"
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                Annulla
              </button>
              <button
                onClick={handleImport}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold"
              >
                Importa {layers.reduce((n, l, i) => (targets[i] || l.suggested).kind === 'skip' ? n : n + l.placemarks.length, 0)} schede
              </button>
            </div>
          </>
        )}

        {summary && (
          <div className="text-center">
            <p className="text-3xl mb-2">✅</p>
            <h4 className="text-lg font-bold text-slate-800 mb-1">Import completato</h4>
            <p className="text-sm text-slate-600 mb-3">
              <b className="text-indigo-600">{summary.imported}</b> pratiche importate
              {summary.duplicates > 0 && <> · <b>{summary.duplicates}</b> duplicati saltati</>}
              {summary.skipped > 0 && <> · <b>{summary.skipped}</b> in livelli esclusi</>}
            </p>
            <div className="text-left bg-slate-50 border border-slate-200 rounded-lg p-3 mb-4 space-y-1">
              {Object.entries(summary.perKind).map(([k, n]) => (
                <p key={k} className="text-xs text-slate-600 flex justify-between">
                  <span>{kindSummaryLabel(k)}</span><b>{n}</b>
                </p>
              ))}
            </div>
            <button
              onClick={onClose}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg"
            >
              Chiudi
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default KmzImportModal;
