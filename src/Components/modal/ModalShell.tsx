import React, { useEffect, useId, useRef } from 'react';
import { X, type LucideIcon } from 'lucide-react';

// Guscio comune di tutte le finestre: sfondo sfocato, intestazione con icona,
// titolo e sottotitolo, corpo scorrevole e piè di pagina fisso.
// Solo presentazione: la logica (cosa succede chiudendo) resta al chiamante.

export type ModalTone = 'neutral' | 'ai' | 'brand' | 'success' | 'danger';

const TONE: Record<ModalTone, string> = {
  neutral: 'bg-slate-50 text-ink-700 ring-line',
  ai: 'bg-violet-50 text-violet-700 ring-violet-100',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  danger: 'bg-rose-50 text-rose-700 ring-rose-100',
};

const SIZE = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  wide: 'sm:max-w-3xl',
  xl: 'sm:max-w-5xl',
} as const;

interface ModalShellProps {
  icon: LucideIcon;
  tone?: ModalTone;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  /** Esc e clic sullo sfondo chiudono la finestra (default: sì) */
  dismissible?: boolean;
  /** La X resta visibile ma non cliccabile (es. chiamata in partenza) */
  closeDisabled?: boolean;
  closeHint?: string;
  size?: keyof typeof SIZE;
  /** Fascia sotto l'intestazione (schede, passaggi) */
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  /** Classi del corpo: di default padding e scorrimento */
  bodyClassName?: string;
  children: React.ReactNode;
  testId?: string;
}

const ModalShell: React.FC<ModalShellProps> = ({
  icon: Icon, tone = 'neutral', title, subtitle, onClose, dismissible = true, closeDisabled = false,
  closeHint, size = 'md', toolbar, footer, bodyClassName, children, testId,
}) => {
  const titleId = useId();
  const subtitleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Esc: solo dove la chiusura è già permessa
  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismissible]);

  return (
    <div
      className="modal-backdrop max-sm:p-0 max-sm:items-end"
      onClick={dismissible ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        data-testid={testId}
        className={`modal ${SIZE[size]} max-sm:max-h-[94dvh] max-sm:rounded-b-none`}
        onClick={e => e.stopPropagation()}
      >
        <header className="modal-header max-sm:px-4 items-center">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-control ring-1 ring-inset ${TONE[tone]}`}>
            <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="modal-title leading-6 truncate">{title}</h2>
            {subtitle && (
              <p id={subtitleId} className="modal-subtitle text-[13px] leading-5 text-ink-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Esci"
            title={closeDisabled ? (closeHint || 'Attendi la fine dell\'operazione') : 'Chiudi (Esc)'}
            className="icon-btn -mr-1.5 shrink-0"
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        {toolbar && <div className="shrink-0 border-b border-line">{toolbar}</div>}
        <div className={bodyClassName ?? 'modal-body flex-1 min-h-0 max-sm:px-4'}>
          {children}
        </div>
        {footer && (
          <footer className="modal-footer flex-wrap max-sm:px-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
};

export default ModalShell;
