import React from 'react';
import { FlaskConical, TriangleAlert } from 'lucide-react';

// Scritta della versione di prova, sempre in cima all'app: chi la vede sa che
// i dati sono finti e che le telefonate partono solo verso i numeri ammessi.

interface TestModeBannerProps {
  testNumbersConfigured: boolean;
  onOpenPratiche: () => void;
}

// Telefono: prima riga la scritta, seconda l'avviso (se c'è) e il pulsante;
// schermi larghi: tutto su una riga, se ci sta.
const TestModeBanner: React.FC<TestModeBannerProps> = ({ testNumbersConfigured, onOpenPratiche }) => (
  <div
    role="status"
    data-testid="test-mode-banner"
    className="shrink-0 border-b-2 border-amber-400 bg-amber-100 text-amber-950 px-4 md:px-6 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-[13px] leading-[18px] sm:leading-5 relative z-[35]"
  >
    <p className="min-w-0 max-sm:basis-full sm:flex-1 flex items-start gap-2">
      <FlaskConical size={16} strokeWidth={2} aria-hidden className="shrink-0 mt-px text-amber-800" />
      <span>
        <strong className="font-bold tracking-wide">VERSIONE DI PROVA</strong>
        {' · dati finti, separati da quelli veri · le telefonate partono solo verso i numeri ammessi'}
      </span>
    </p>
    {!testNumbersConfigured && (
      <p data-testid="test-mode-no-numbers" className="min-w-0 flex-1 sm:flex-initial flex items-start gap-1.5 font-medium text-rose-800">
        <TriangleAlert size={15} strokeWidth={2} aria-hidden className="shrink-0 mt-px" />
        <span>Chiamate bloccate finché non imposti RETELL_TEST_NUMBERS su Vercel (ambiente Preview).</span>
      </p>
    )}
    <button
      type="button"
      onClick={onOpenPratiche}
      className="btn btn-secondary btn-sm h-7 px-2.5 border-amber-300 shrink-0 ml-auto"
      data-testid="test-mode-open"
    >
      Pratiche di prova
    </button>
  </div>
);

export default TestModeBanner;
