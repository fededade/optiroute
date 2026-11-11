import React from 'react';
import { Car, Coffee } from 'lucide-react';
import type { Appointment } from '../types';
import PraticaCard from './PraticaCard';
import type { Workspace } from './types';
import { kmLabel } from './format';

// Il giro di un tecnico come linea del tempo: orario a sinistra, filo
// verticale con il numero della tappa, fra una tappa e l'altra il tragitto
// e l'eventuale pausa pranzo. Le schede restano trascinabili per riordinare.

const RouteTimeline: React.FC<{
  items: Appointment[];
  ws: Workspace;
  color: string;
  draggable: boolean;
  dashed?: boolean; // giro proposto (non ancora confermato)
}> = ({ items, ws, color, draggable, dashed }) => (
  <ol className="timeline">
    {items.map((appt, i) => {
      const travel = appt.travelTimeFromPrev !== undefined && appt.travelTimeFromPrev !== null
        ? [`${Math.round(appt.travelTimeFromPrev)} min`, kmLabel(appt.distanceFromPrev)].filter(Boolean).join(' · ')
        : '';
      return (
        <React.Fragment key={appt.id}>
          {travel && (
            <li className="timeline-gap" aria-label={`Tragitto ${travel}`}>
              <span className="timeline-time" />
              <span className={`timeline-rail ${dashed ? 'timeline-rail-dashed' : ''}`} />
              <span className="flex items-center gap-1.5 text-xs text-ink-500 py-1.5">
                <Car size={14} strokeWidth={1.75} aria-hidden />
                <span className="num">{travel}</span>
                {i === 0 && <span>dalla base</span>}
              </span>
            </li>
          )}
          {appt.hasLunchBreakBefore && (
            <li className="timeline-gap">
              <span className="timeline-time" />
              <span className={`timeline-rail ${dashed ? 'timeline-rail-dashed' : ''}`} />
              <span className="my-1 inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 h-6 text-xs font-medium text-amber-800 w-fit">
                <Coffee size={13} strokeWidth={1.75} aria-hidden /> Pausa pranzo
              </span>
            </li>
          )}
          <li className="timeline-row">
            <span className="timeline-time">
              <span className="num text-[13px] font-semibold text-ink-900">{appt.startTime || '—'}</span>
              {appt.endTime && <span className="num text-xs text-ink-400">{appt.endTime}</span>}
            </span>
            <span className={`timeline-rail ${dashed ? 'timeline-rail-dashed' : ''}`}>
              <span className="timeline-node num" style={{ backgroundColor: dashed ? '#fff' : color, borderColor: color, color: dashed ? color : '#fff' }}>
                {appt.sequenceOrder ?? i + 1}
              </span>
            </span>
            <div className="min-w-0 pb-2">
              <PraticaCard appt={appt} ws={ws} variant="stop" draggable={draggable} />
            </div>
          </li>
        </React.Fragment>
      );
    })}
  </ol>
);

export default RouteTimeline;
