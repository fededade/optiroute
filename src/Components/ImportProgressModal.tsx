import React from 'react';
import { CircleCheck, FileSpreadsheet, TriangleAlert } from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { StateView } from './modal/parts';

// Avanzamento dell'import Excel: durante il lavoro non si chiude; alla fine
// riepilogo (importate, posizioni approssimative, indirizzi non trovati) con
// il dettaglio e il bottone Chiudi. Solo presentazione: lo stato è di App.

interface ImportProgressModalProps {
  finished: boolean;
  progress: string;
  stats: { success: number; failed: number; approx: number };
  failed: string[];
  approx: string[];
  onClose: () => void;
}

const ImportProgressModal: React.FC<ImportProgressModalProps> = ({ finished, progress, stats, failed, approx, onClose }) => {
  const clean = stats.failed === 0;
  return (
    <ModalShell
      testId="import-modal"
      icon={!finished ? FileSpreadsheet : clean ? CircleCheck : TriangleAlert}
      tone={!finished ? 'neutral' : clean ? 'success' : 'danger'}
      title={finished ? 'Fatto!' : 'Import Excel'}
      subtitle={finished ? 'Import Excel completato' : undefined}
      onClose={onClose}
      dismissible={finished}
      closeDisabled={!finished}
      closeHint="Attendi la fine dell'importazione"
      size="sm"
      footer={finished ? (
        <button type="button" onClick={onClose} className="btn btn-primary w-full sm:w-auto">Chiudi</button>
      ) : undefined}
    >
      {!finished ? (
        <StateView kind="loading" title="Importazione in corso...">
          <p>{progress}</p>
          <p className="mt-2 text-xs text-ink-400">Non chiudere questa finestra.</p>
        </StateView>
      ) : (
        <div className="space-y-3">
          <p className="text-[15px] text-ink-700">
            N. <span className="num font-semibold text-ink-950">{stats.success}</span> Pratiche importate!
          </p>
          {stats.approx > 0 && (
            <p className="callout callout-warn">
              ≈ {stats.approx} {stats.approx === 1 ? 'indirizzo posizionato' : 'indirizzi posizionati'} al centro del comune
              (numero civico o via non trovati sulle mappe).
            </p>
          )}
          {stats.failed > 0 && (
            <p className="callout callout-danger items-center">
              <TriangleAlert size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
              <span>{stats.failed} {stats.failed === 1 ? 'indirizzo non trovato' : 'indirizzi non trovati'}.</span>
            </p>
          )}

          {(failed.length > 0 || approx.length > 0) && (
            <div className="max-h-[40vh] overflow-y-auto rounded-control border border-line bg-slate-50/60 px-3 pb-2 text-left">
              {approx.length > 0 && (
                <>
                  <p className="sticky top-0 bg-slate-50 pt-2 pb-1.5 text-xs font-semibold text-ink-600">Posizione approssimativa (verifica o correggi con Modifica):</p>
                  <ul className="mb-2 space-y-1 text-xs text-amber-800">
                    {approx.map((line, i) => (
                      <li key={i} className="flex items-start gap-1.5"><span className="shrink-0">≈</span><span>{line}</span></li>
                    ))}
                  </ul>
                </>
              )}
              {failed.length > 0 && (
                <>
                  <p className="sticky top-0 bg-slate-50 pt-2 pb-1.5 text-xs font-semibold text-ink-600">Dettaglio errori:</p>
                  <ul className="space-y-1 text-xs text-rose-700">
                    {failed.map((line, i) => (
                      <li key={i} className="flex items-start gap-1.5"><span className="shrink-0">•</span><span>{line}</span></li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
};

export default ImportProgressModal;
