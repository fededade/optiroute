import React, { useEffect, useMemo, useState } from 'react';
import type { Appointment, IssueType, Technician } from '../types';
import { parseKmzFile, type KmzLayer, type KmzTarget, type KmzTargetKind } from '../services/kmzService';
import { matchTechnician } from '../services/technicianService';
import { provinceToCode } from '../utils/provinces';
import { CircleAlert, Download, Layers, MapPinned } from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { StateView, ic } from './modal/parts';

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
  wrong_phone: 'Numeri non corretti',
  callback: 'Da richiamare',
  works_pending: 'Lavori da ultimare',
};

// Valori del select destinazione (kind + issueType compattati)
const TARGET_OPTIONS: { value: string; label: string }[] = [
  { value: 'skip', label: 'Salta (non importare)' },
  { value: 'confirmed', label: 'Confermate (con data)' },
  { value: 'pending', label: 'In attesa / da pianificare' },
  { value: 'standby', label: 'Stand-by' },
  { value: 'issue:wrong_phone', label: ISSUE_LABEL.wrong_phone },
  { value: 'issue:callback', label: ISSUE_LABEL.callback },
  { value: 'issue:works_pending', label: ISSUE_LABEL.works_pending },
  { value: 'cancelled', label: 'Annullate (archivio)' },
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
    if (k === 'confirmed') return 'Confermate';
    if (k === 'pending') return 'In attesa';
    if (k === 'standby') return 'Stand-by';
    if (k === 'cancelled') return 'Annullate';
    return k;
  };

  // Colore di stato della destinazione (sempre gli stessi colori dell'app)
  const kindDot = (k: string): string =>
    k === 'confirmed' ? 'bg-emerald-500'
    : k === 'pending' ? 'bg-amber-500'
    : k.startsWith('issue') ? 'bg-rose-500'
    : k === 'skip' ? 'bg-slate-300'
    : 'bg-slate-400';

  const toImportCount = layers
    ? layers.reduce((n, l, i) => (targets[i] || l.suggested).kind === 'skip' ? n : n + l.placemarks.length, 0)
    : 0;

  // Riepilogo di cosa verrà importato, per destinazione (solo presentazione)
  const plan = useMemo(() => {
    if (!layers) return [] as { value: string; count: number; label: string; missingDate: boolean }[];
    const m = new Map<string, { value: string; count: number; label: string; missingDate: boolean }>();
    layers.forEach((l, i) => {
      const t = targets[i] || l.suggested;
      const value = targetToValue(t);
      const label = TARGET_OPTIONS.find(o => o.value === value)?.label || value;
      const prev = m.get(value) || { value, count: 0, label, missingDate: false };
      prev.count += l.placemarks.length;
      if (t.kind === 'confirmed' && !t.date) prev.missingDate = true;
      m.set(value, prev);
    });
    return [...m.values()].sort((a, b) => (a.value === 'skip' ? 1 : 0) - (b.value === 'skip' ? 1 : 0));
  }, [layers, targets]);

  const footer =
    summary ? (
      <button type="button" onClick={onClose} className="btn btn-primary">
        Chiudi
      </button>
    ) : layers && !error ? (
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">
          Annulla
        </button>
        <button type="button" onClick={handleImport} className="btn btn-accent">
          <Download {...ic} />
          Importa {toImportCount} schede
        </button>
      </>
    ) : error ? (
      <button type="button" onClick={onClose} className="btn btn-secondary">
        Chiudi
      </button>
    ) : undefined;

  return (
    <ModalShell
      icon={MapPinned}
      title="Importa da Google My Maps"
      subtitle={<>File: <span className="num text-ink-700">{file.name}</span></>}
      onClose={onClose}
      size="wide"
      footer={footer}
    >
        {error && (
          <>
            <StateView kind="error" title="Impossibile importare il file" />
            <div role="alert" className="callout callout-danger -mt-2">
              <CircleAlert {...ic} className="mt-0.5 shrink-0 text-rose-600" />
              <p>{error}</p>
            </div>
          </>
        )}

        {!error && !layers && (
          <div className="py-8">
            <StateView kind="loading" title="Lettura della mappa in corso..." />
          </div>
        )}

        {!error && layers && !summary && (
          <div className="space-y-5">
            <p className="text-sm leading-6 text-ink-600">
              Ogni <b className="font-semibold text-ink-900">livello</b> della mappa viene importato nella destinazione indicata (proposta automatica, modificabile).
              Le schede con "numero non corretto" o "immobile non ultimato" nel testo vengono affinate da sole nella
              categoria giusta. Niente geocoding: le posizioni arrivano dal file.
            </p>

            <div className="card overflow-hidden shadow-none">
              <div className="hidden grid-cols-[minmax(0,1fr)_56px_244px_148px] gap-3 border-b border-line bg-slate-50/70 px-4 py-2 sm:grid">
                <span className="eyebrow">Livello</span>
                <span className="eyebrow text-right">Schede</span>
                <span className="eyebrow">Destinazione</span>
                <span className="eyebrow">Data</span>
              </div>
              <ul className="divide-y divide-line">
                {layers.map((layer, i) => {
                  const target = targets[i] || layer.suggested;
                  const value = targetToValue(target);
                  return (
                    <li
                      key={i}
                      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_56px_244px_148px] ${target.kind === 'skip' ? 'bg-slate-50/60' : ''}`}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Layers {...ic} className="shrink-0 text-ink-400" />
                        <span className={`truncate text-sm font-medium ${target.kind === 'skip' ? 'text-ink-400 line-through decoration-ink-300' : 'text-ink-900'}`} title={layer.name}>{layer.name}</span>
                      </div>
                      <span className="num text-right text-sm text-ink-600">
                        {layer.placemarks.length}<span className="sm:hidden"> schede</span>
                      </span>
                      <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
                        <span className={`dot ${kindDot(target.kind === 'issue' ? 'issue' : target.kind)}`} aria-hidden="true" />
                        <select
                          aria-label={`Destinazione del livello ${layer.name}`}
                          value={value}
                          onChange={e => setLayerTarget(i, e.target.value)}
                          className="select h-8 text-[13px]"
                        >
                          {TARGET_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-2 sm:col-span-1">
                        {target.kind === 'confirmed' ? (
                          <input
                            type="date"
                            value={target.date || ''}
                            onChange={e => setLayerDate(i, e.target.value)}
                            className={`input num h-8 text-[13px] ${!target.date ? 'border-amber-300' : ''}`}
                            title="Data delle conferme di questo livello"
                            aria-label={`Data delle conferme del livello ${layer.name}`}
                          />
                        ) : (
                          <span className="hidden text-sm text-ink-300 sm:inline">—</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="rounded-card border border-line bg-slate-50/60 p-4">
              <h3 className="section-title mb-3">Verrà importato</h3>
              <ul className="space-y-1.5">
                {plan.map(p => (
                  <li key={p.value} className="flex items-center gap-2.5 text-sm">
                    <span className={`dot ${kindDot(p.value.startsWith('issue') ? 'issue' : p.value)}`} aria-hidden="true" />
                    <span className={`min-w-0 flex-1 truncate ${p.value === 'skip' ? 'text-ink-400' : 'text-ink-800'}`}>
                      {p.label}
                      {p.missingDate && <span className="ml-1.5 text-xs text-amber-700">senza data: finiranno in attesa</span>}
                    </span>
                    <span className="num shrink-0 text-ink-600">{p.count}</span>
                  </li>
                ))}
              </ul>
              <p className="field-hint mt-3">Le schede già presenti (stessa posizione e nome) vengono saltate.</p>
            </div>
          </div>
        )}

        {summary && (
          <div>
            <StateView kind="success" title="Import completato">
              <span className="num font-semibold text-ink-900">{summary.imported}</span> pratiche importate
              {summary.duplicates > 0 && <> · <span className="num font-semibold text-ink-900">{summary.duplicates}</span> duplicati saltati</>}
              {summary.skipped > 0 && <> · <span className="num font-semibold text-ink-900">{summary.skipped}</span> in livelli esclusi</>}
            </StateView>
            <ul className="card mx-auto max-w-sm divide-y divide-line overflow-hidden shadow-none">
              {Object.entries(summary.perKind).map(([k, n]) => (
                <li key={k} className="flex items-center gap-2.5 px-4 py-2 text-sm">
                  <span className={`dot ${kindDot(k.startsWith('issue') ? 'issue' : k)}`} aria-hidden="true" />
                  <span className="flex-1 text-ink-700">{kindSummaryLabel(k)}</span>
                  <span className="num font-semibold text-ink-900">{n}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
    </ModalShell>
  );
};

export default KmzImportModal;
