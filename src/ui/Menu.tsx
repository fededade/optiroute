import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

// Menu a comparsa: un bottone che apre un elenco di voci testuali.
// Il menu è disegnato in un portale con posizione fissa, così non viene
// tagliato dai pannelli che scorrono; si chiude con Esc, clic fuori o scroll.

const CloseCtx = createContext<() => void>(() => {});

interface MenuProps {
  // contenuto del bottone (icona + etichetta)
  button: React.ReactNode;
  buttonClassName?: string;
  title?: string;
  ariaLabel?: string;
  align?: 'start' | 'end';
  minWidth?: number;
  testId?: string;
  children: React.ReactNode;
}

export const Menu: React.FC<MenuProps> = ({ button, buttonClassName = 'btn btn-secondary btn-sm', title, ariaLabel, align = 'end', minWidth = 240, testId, children }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    const m = menuRef.current;
    if (!b || !m) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(minWidth, m.offsetWidth), vw - 16);
    let left = align === 'end' ? b.right - width : b.left;
    left = Math.max(8, Math.min(left, vw - width - 8));
    const h = m.offsetHeight;
    let top = b.bottom + 6;
    if (top + h > vh - 8 && b.top - h - 6 > 8) top = b.top - h - 6;
    setPos({ position: 'fixed', top, left, minWidth: Math.min(minWidth, vw - 16), maxWidth: vw - 16, visibility: 'visible' });
  }, [align, minWidth]);

  useLayoutEffect(() => {
    if (open) place();
    else setPos({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') || []);
        if (items.length === 0) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
        items[next].focus();
      }
    };
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={buttonClassName}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen(o => !o)}
      >
        {button}
      </button>
      {open && createPortal(
        <div ref={menuRef} role="menu" className="menu" style={pos} onClick={e => e.stopPropagation()}>
          <CloseCtx.Provider value={close}>{children}</CloseCtx.Provider>
        </div>,
        document.body
      )}
    </>
  );
};

interface MenuItemProps {
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  hint?: React.ReactNode;      // seconda riga, in piccolo
  trailing?: React.ReactNode;  // a destra (es. contatore)
  keepOpen?: boolean;
  children: React.ReactNode;
}

export const MenuItem: React.FC<MenuItemProps> = ({ icon: Icon, onSelect, disabled, danger, title, hint, trailing, keepOpen, children }) => {
  const close = useContext(CloseCtx);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      className={`menu-item ${hint ? 'menu-item-2' : ''} ${danger ? 'menu-item-danger' : ''}`}
      onClick={() => { if (!keepOpen) close(); onSelect(); }}
    >
      {Icon && <Icon size={16} strokeWidth={1.75} className={`shrink-0 ${danger ? '' : 'text-ink-500'}`} aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {hint && <span className="block text-xs text-ink-500 truncate">{hint}</span>}
      </span>
      {trailing}
    </button>
  );
};

export const MenuLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="menu-label">{children}</div>
);

export const MenuDivider: React.FC = () => <div className="my-1.5 border-t border-line" role="separator" />;
