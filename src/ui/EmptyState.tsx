import React from 'react';
import type { LucideIcon } from 'lucide-react';

// Stato vuoto curato: icona, una riga che spiega a cosa serve la vista e
// l'azione per riempirla.
export const EmptyState: React.FC<{
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  tone?: 'neutral' | 'success';
}> = ({ icon: Icon, title, children, action, tone = 'neutral' }) => (
  <div className="empty-state">
    <span className={`empty-state-icon ${tone === 'success' ? 'text-emerald-600 bg-emerald-50 border-emerald-100' : ''}`}>
      <Icon size={20} strokeWidth={1.75} aria-hidden />
    </span>
    <p className="text-sm font-semibold text-ink-900">{title}</p>
    {children && <p className="text-[13px] text-ink-500 max-w-sm leading-relaxed">{children}</p>}
    {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
  </div>
);

// Intestazione di un blocco dentro una sezione
export const BlockHeader: React.FC<{ title: React.ReactNode; count?: number; icon?: LucideIcon; tone?: string; children?: React.ReactNode }> = ({ title, count, icon: Icon, tone = 'text-ink-500', children }) => (
  <div className="flex items-center gap-2 min-h-[32px] mb-2 flex-wrap">
    {Icon && <Icon size={16} strokeWidth={1.75} className={tone} aria-hidden />}
    <h3 className="section-title">{title}</h3>
    {count !== undefined && <span className="num text-xs text-ink-500">{count}</span>}
    {children && <div className="ml-auto flex items-center gap-1.5 flex-wrap">{children}</div>}
  </div>
);
