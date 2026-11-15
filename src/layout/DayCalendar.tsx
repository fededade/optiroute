import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarRange, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { DayCount, DaySelection } from './days';
import { activeDays, dayColor, isDayActive, monthGrid, selectSingleDay, toggleDay } from './days';
import { addDays, cap, dayLabel, dayTitle, isoDate, longDayLabel, plural, rangeLabel } from './format';

// Calendario dei giorni: si apre dal bottone della data nella barra
// dell'Agenda. Ogni giorno mostra quante pratiche sono nel giro (confermate
// in evidenza, proposte più tenui). Un clic sceglie il giorno; con
// "Più giorni" acceso ogni clic aggiunge o toglie un giorno, e ogni giorno
// attivo prende il suo colore (lo stesso della mappa e degli elenchi).
// Sul telefono si apre come foglio dal basso, a tutta larghezza.

interface DayCalendarProps {
  selection: DaySelection;
  counts: Map<string, DayCount>;
  todayStr: string;
  mobile: boolean;
  onChange: (s: DaySelection) => void;
}

const WEEKDAYS = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
const WEEKDAYS_LONG = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];

const monthOf = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return { y, m0: m - 1 };
};
const shiftMonth = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00`);
  const day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return isoDate(t);
};

// Etichetta del bottone: un giorno, più giorni o l'intervallo della vista
export const selectionLabel = (s: DaySelection): string => {
  if (s.viewMode !== 'day') return cap(rangeLabel(s.currentDate, s.viewMode));
  const days = activeDays(s);
  return days.length === 1 ? dayTitle(days[0]) : `${days.length} giorni`;
};

const DayCalendar: React.FC<DayCalendarProps> = ({ selection, counts, todayStr, mobile, onChange }) => {
  const [open, setOpen] = useState(false);
  const [multi, setMulti] = useState(false);
  const [focusDate, setFocusDate] = useState(selection.currentDate);
  const [pos, setPos] = useState<React.CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusOnRender = useRef(false);

  const days = activeDays(selection);
  const multiActive = selection.viewMode === 'day' && days.length > 1;
  const { y, m0 } = monthOf(focusDate);
  const grid = monthGrid(y, m0);
  const monthTitle = cap(new Date(y, m0, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }));

  const openCal = () => {
    setFocusDate(selection.currentDate);
    setMulti(multiActive);
    setOpen(true);
    focusOnRender.current = true;
  };
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  // Posizione sotto il bottone (sul telefono: foglio dal basso, niente calcoli)
  const place = useCallback(() => {
    if (mobile) return;
    const b = btnRef.current?.getBoundingClientRect();
    const el = panelRef.current;
    if (!b || !el) return;
    const vw = window.innerWidth;
    const w = el.offsetWidth;
    const left = Math.max(8, Math.min(b.left, vw - w - 8));
    setPos({ position: 'fixed', top: b.bottom + 6, left, visibility: 'visible' });
  }, [mobile]);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
    };
  }, [open, close, place]);

  // Fuoco sul giorno "corrente" della griglia (apertura e frecce)
  useEffect(() => {
    if (!open || !focusOnRender.current) return;
    focusOnRender.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus();
  });

  const moveFocus = (date: string) => {
    setFocusDate(date);
    focusOnRender.current = true;
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in steps) { e.preventDefault(); moveFocus(addDays(focusDate, steps[e.key])); return; }
    if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); moveFocus(shiftMonth(focusDate, e.key === 'PageUp' ? -1 : 1)); return; }
    const dow = new Date(`${focusDate}T00:00:00`).getDay() || 7;
    if (e.key === 'Home') { e.preventDefault(); moveFocus(addDays(focusDate, -(dow - 1))); }
    if (e.key === 'End') { e.preventDefault(); moveFocus(addDays(focusDate, 7 - dow)); }
  };

  const pick = (date: string) => {
    setFocusDate(date);
    if (multi) {
      onChange(toggleDay(selection, date));
    } else {
      onChange(selectSingleDay(date));
      close();
    }
  };

  const onlyToday = () => {
    setMulti(false);
    onChange(selectSingleDay(todayStr));
    setFocusDate(todayStr);
  };

  const countText = (c?: DayCount): string => {
    if (!c) return 'nessuna pratica nel giro';
    const parts = [];
    if (c.confirmed) parts.push(plural(c.confirmed, 'confermata', 'confermate'));
    if (c.proposed) parts.push(plural(c.proposed, 'proposta', 'proposte'));
    return parts.join(', ');
  };

  const panel = open && (
    <>
      {mobile && <div className="fixed inset-0 z-[1190] bg-ink-950/40 animate-fade-in" aria-hidden onMouseDown={() => close()} />}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={mobile || undefined}
        aria-label="Calendario dei giorni"
        data-testid="calendar"
        style={mobile ? undefined : pos}
        className={mobile
          ? 'fixed inset-x-0 bottom-0 z-[1200] bg-surface rounded-t-2xl shadow-pop px-4 pt-3 pb-5 max-h-[92vh] overflow-y-auto animate-pop-in'
          : 'card shadow-pop z-[1200] w-[348px] p-3 animate-pop-in'}
      >
        {mobile && <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-300" aria-hidden />}
        {/* Mese: precedente, titolo, successivo, Oggi */}
        <div className="flex items-center gap-1">
          <button type="button" className="icon-btn h-8 w-8" onClick={() => moveFocus(shiftMonth(focusDate, -1))} aria-label="Mese precedente" title="Mese precedente" data-testid="calendar-prev">
            <ChevronLeft size={16} strokeWidth={1.75} />
          </button>
          <p className="flex-1 text-center text-sm font-semibold text-ink-950" aria-live="polite" data-testid="calendar-month">{monthTitle}</p>
          <button type="button" className="icon-btn h-8 w-8" onClick={() => moveFocus(shiftMonth(focusDate, 1))} aria-label="Mese successivo" title="Mese successivo" data-testid="calendar-next">
            <ChevronRight size={16} strokeWidth={1.75} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm px-2" onClick={() => moveFocus(todayStr)} title="Mostra il mese di oggi">Oggi</button>
          {mobile && (
            <button type="button" className="icon-btn h-8 w-8" onClick={() => close()} aria-label="Chiudi il calendario"><X size={16} strokeWidth={1.75} /></button>
          )}
        </div>

        {/* Più giorni */}
        <div className="mt-2 flex items-center gap-2 rounded-control border border-line bg-slate-50/70 px-2.5 py-1.5">
          <button
            type="button"
            role="switch"
            aria-checked={multi}
            onClick={() => setMulti(v => !v)}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-[13px] font-medium text-ink-800 min-h-[32px]"
            data-testid="calendar-multi"
          >
            <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${multi ? 'bg-ink-900' : 'bg-slate-300'}`} aria-hidden>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${multi ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
            </span>
            Più giorni
          </button>
          <span className="min-w-0 text-xs leading-4 text-ink-500">{multi ? 'ogni clic aggiunge o toglie un giorno' : 'un clic sceglie un giorno'}</span>
        </div>

        {/* Griglia lun–dom */}
        <div className="mt-2 grid grid-cols-7 gap-1 text-center" aria-hidden>
          {WEEKDAYS.map((w, i) => <span key={i} className="text-2xs font-semibold text-ink-400">{w}</span>)}
        </div>
        <div
          ref={gridRef}
          role="group"
          aria-label={`Giorni di ${monthTitle}`}
          className="mt-1 grid grid-cols-7 gap-1"
          onKeyDown={onGridKey}
        >
          {grid.map((date, i) => {
            const c = counts.get(date);
            const active = isDayActive(selection, date);
            const color = dayColor(date);
            const outside = monthOf(date).m0 !== m0;
            const isToday = date === todayStr;
            const label = `${cap(WEEKDAYS_LONG[i % 7])} ${longDayLabel(date).split(' ').slice(1).join(' ')}: ${countText(c)}${active ? ', attivo' : ''}${isToday ? ', oggi' : ''}`;
            return (
              <button
                key={date}
                type="button"
                data-date={date}
                data-testid={`calendar-day-${date}`}
                data-active={active ? 'true' : 'false'}
                data-color={active ? color : undefined}
                aria-pressed={active}
                aria-label={label}
                tabIndex={date === focusDate ? 0 : -1}
                onClick={() => pick(date)}
                onFocus={() => { if (date !== focusDate) setFocusDate(date); }}
                className={`relative flex flex-col items-center justify-start rounded-lg border pt-1 pb-0.5 ${mobile ? 'h-[54px]' : 'h-[50px]'} transition-colors
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-1
                  ${active ? 'border-transparent text-white shadow-card' : 'border-transparent hover:bg-slate-100 text-ink-800'}
                  ${outside && !active ? 'opacity-45' : ''}
                  ${isToday && !active ? 'ring-1 ring-inset ring-brand-400 bg-brand-50/60' : ''}`}
                style={active ? { backgroundColor: color } : undefined}
              >
                <span className={`text-[11px] leading-none ${isToday ? 'font-bold' : 'font-medium'} ${active ? 'text-white/90' : 'text-ink-500'}`}>
                  {Number(date.slice(8))}
                </span>
                {c && (
                  <span className="mt-1 flex items-baseline gap-0.5 leading-none num" data-testid="calendar-count">
                    {c.confirmed > 0 && <span className={`text-[15px] font-bold ${active ? 'text-white' : 'text-ink-950'}`} data-kind="confirmed">{c.confirmed}</span>}
                    {c.proposed > 0 && <span className={`text-[11px] font-medium ${active ? 'text-white/75' : 'text-sky-600/80'}`} data-kind="proposed">+{c.proposed}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Legenda dei numeri e azioni */}
        <div className="mt-2.5 flex items-center gap-2 flex-wrap text-xs text-ink-500">
          <span><span className="num font-bold text-ink-900">5</span> confermate</span>
          <span><span className="num text-sky-600/80">+2</span> proposte</span>
          <span className="ml-auto flex items-center gap-1.5">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onlyToday} data-testid="calendar-reset" title="Torna a un giorno solo: oggi">Solo oggi</button>
            {(multi || mobile) && <button type="button" className="btn btn-primary btn-sm" onClick={() => close()} data-testid="calendar-done">Fatto</button>}
          </span>
        </div>
        {multiActive && (
          <p className="mt-2 text-xs text-ink-600" data-testid="calendar-active-summary">
            {plural(days.length, 'giorno attivo', 'giorni attivi')}: {days.map(dayLabel).join(', ')}
          </p>
        )}
      </div>
    </>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? close(false) : openCal())}
        className="btn btn-secondary btn-sm h-9 min-w-0"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Calendario: ${selectionLabel(selection)}`}
        title="Scegli il giorno (o più giorni) da mostrare in agenda e sulla mappa"
        data-testid="calendar-open"
      >
        <CalendarRange size={15} strokeWidth={1.75} className="text-ink-500 shrink-0" aria-hidden />
        <span className="truncate">{selectionLabel(selection)}</span>
        {multiActive && (
          <span className="flex items-center -space-x-1" aria-hidden>
            {days.slice(0, 5).map(d => <span key={d} className="h-2.5 w-2.5 rounded-full ring-2 ring-white" style={{ backgroundColor: dayColor(d) }} />)}
          </span>
        )}
      </button>
      {panel && createPortal(panel, document.body)}
    </>
  );
};

export default DayCalendar;
