import React from 'react';
import { CircleCheck, CircleX, LoaderCircle, type LucideIcon } from 'lucide-react';

// Piccoli pezzi di sola presentazione condivisi dalle finestre.

/** Proprietà standard delle icone (tratto 1.75) */
export const ic = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const;

/** Sezione di un modulo: titolo, descrizione facoltativa, contenuto */
export const Section: React.FC<{
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, description, icon: Icon, aside, className = '', children }) => (
  <section className={`py-5 first:pt-0 last:pb-0 border-t border-line first:border-t-0 ${className}`}>
    <div className="mb-3 flex items-start gap-2">
      {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-400" />}
      <div className="min-w-0 flex-1">
        <h3 className="section-title">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] leading-5 text-ink-500">{description}</p>}
      </div>
      {aside}
    </div>
    {children}
  </section>
);

/** Campo: etichetta sopra, aiuto sotto */
export const Field: React.FC<{
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ label, htmlFor, hint, className = '', children }) => (
  <div className={className}>
    {htmlFor ? <label htmlFor={htmlFor} className="field-label">{label}</label> : <span className="field-label">{label}</span>}
    {children}
    {hint && <p className="field-hint leading-4">{hint}</p>}
  </div>
);

/** Interruttore: è una vera casella (stessa semantica, solo aspetto diverso) */
export const Switch: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className = '', style, ...props }) => (
  <input
    type="checkbox"
    {...props}
    style={{ backgroundImage: 'radial-gradient(circle, #fff 6.5px, transparent 7px)', ...style }}
    className={`h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-slate-300 bg-no-repeat bg-[length:16px_16px] bg-[position:2px_50%]
      transition-[background-color,background-position] duration-150 checked:bg-ink-900 checked:bg-[position:18px_50%]
      hover:bg-slate-400 checked:hover:bg-ink-700 disabled:opacity-50 ${className}`}
  />
);

/** Riga di impostazione: testo e aiuto a sinistra, comando a destra */
export const SettingRow: React.FC<{
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  asLabel?: boolean;
}> = ({ label, hint, htmlFor, children, asLabel }) => {
  const text = (
    <span className="min-w-[11rem] flex-1">
      <span className="block text-sm font-medium text-ink-900">{label}</span>
      {hint && <span className="mt-0.5 block text-xs leading-4 text-ink-500">{hint}</span>}
    </span>
  );
  const cls = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3';
  if (asLabel) return <label className={`${cls} cursor-pointer hover:bg-slate-50/70`}>{text}{children}</label>;
  return (
    <div className={cls}>
      {htmlFor ? <label htmlFor={htmlFor} className="flex min-w-[11rem] flex-1 cursor-pointer">{text}</label> : text}
      {children}
    </div>
  );
};

/** Gruppo di righe di impostazione in una scheda con divisori */
export const SettingGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="card divide-y divide-line overflow-hidden shadow-none">{children}</div>
);

export const Spinner: React.FC<{ size?: number; className?: string }> = ({ size = 16, className = '' }) => (
  <LoaderCircle size={size} strokeWidth={1.75} aria-hidden="true" className={`animate-spin ${className}`} />
);

/** Stato centrato (caricamento, successo, errore) */
export const StateView: React.FC<{
  kind: 'loading' | 'success' | 'error';
  title: React.ReactNode;
  children?: React.ReactNode;
}> = ({ kind, title, children }) => {
  const ring = kind === 'success' ? 'bg-emerald-50 text-emerald-600 ring-emerald-100'
    : kind === 'error' ? 'bg-rose-50 text-rose-600 ring-rose-100'
    : 'bg-slate-50 text-ink-700 ring-line';
  return (
    <div className="flex flex-col items-center px-2 py-6 text-center" role={kind === 'loading' ? 'status' : undefined}>
      <span className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full ring-1 ring-inset ${ring}`}>
        {kind === 'loading' && <Spinner size={22} />}
        {kind === 'success' && <CircleCheck size={24} strokeWidth={1.75} aria-hidden="true" />}
        {kind === 'error' && <CircleX size={24} strokeWidth={1.75} aria-hidden="true" />}
      </span>
      <h3 className="text-base font-semibold tracking-tight text-ink-950">{title}</h3>
      {children && <div className="mt-1.5 w-full max-w-md text-sm leading-6 text-ink-500">{children}</div>}
    </div>
  );
};

/** Passaggi di una procedura (es. Parametri → Calcolo → Proposta) */
export const Steps: React.FC<{ steps: string[]; current: number }> = ({ steps, current }) => (
  <ol className="flex items-center gap-2 px-6 py-2.5 max-sm:px-4 text-[13px]">
    {steps.map((s, i) => {
      const done = i < current;
      const active = i === current;
      return (
        <li key={s} className="flex items-center gap-2" aria-current={active ? 'step' : undefined}>
          {i > 0 && <span className={`h-px w-6 sm:w-10 ${done || active ? 'bg-ink-300' : 'bg-line'}`} aria-hidden="true" />}
          <span
            className={`num flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold ${
              active ? 'bg-ink-900 text-white' : done ? 'bg-slate-200 text-ink-700' : 'bg-slate-100 text-ink-400'
            }`}
          >
            {i + 1}
          </span>
          <span className={active ? 'font-medium text-ink-900' : done ? 'text-ink-600' : 'text-ink-400'}>{s}</span>
        </li>
      );
    })}
  </ol>
);

/** Piccola statistica (numero grande + etichetta) */
export const Stat: React.FC<{ value: React.ReactNode; label: string; tone?: 'neutral' | 'success' | 'danger' | 'warn' }> = ({ value, label, tone = 'neutral' }) => {
  const color = tone === 'success' ? 'text-emerald-700' : tone === 'danger' ? 'text-rose-700' : tone === 'warn' ? 'text-amber-800' : 'text-ink-950';
  return (
    <div className="rounded-control border border-line bg-surface px-3 py-2.5">
      <div className={`num text-xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-ink-500">{label}</div>
    </div>
  );
};
