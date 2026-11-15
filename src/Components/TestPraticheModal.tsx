import React, { useId, useState } from 'react';
import { FlaskConical, Trash2, Upload } from 'lucide-react';
import ModalShell from './modal/ModalShell';
import { Field, ic } from './modal/parts';
import { safeLocalStorage } from '../services/safeStorage';
import { normalizePhone } from '../utils/phone';
import { TEST_PRATICHE_COUNT } from '../services/testPratiche';

// Finestra delle pratiche di prova (solo nella versione di prova): numero da
// chiamare, caricamento delle 16 pratiche finte (ricomincia da capo) e
// rimozione. Le modifiche le fa l'app con i suoi percorsi di sempre.

export const TEST_PHONE_KEY = 'optiroute_test_phone_v1';

const loadPhone = (): string => {
  try {
    return safeLocalStorage.getItem(TEST_PHONE_KEY) || '';
  } catch {
    return '';
  }
};

const savePhone = (phone: string): void => {
  try {
    safeLocalStorage.setItem(TEST_PHONE_KEY, phone);
  } catch {
    // memoria piena o bloccata: il numero si riscrive la prossima volta
  }
};

interface TestPraticheModalProps {
  testCount: number;                       // pratiche di prova presenti ora
  testNumbersConfigured: boolean;
  onLoad: (phone: string) => string | null; // null = fatto, altrimenti l'errore
  onRemove: () => void;
  onClose: () => void;
}

const TestPraticheModal: React.FC<TestPraticheModalProps> = ({ testCount, testNumbersConfigured, onLoad, onRemove, onClose }) => {
  const fid = useId();
  const [phone, setPhone] = useState<string>(loadPhone);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = () => {
    const normalized = normalizePhone(phone.trim());
    if (!phone.trim()) {
      setError('Scrivi il numero da chiamare.');
      setDone(null);
      return;
    }
    if (!normalized) {
      setError('Numero non valido: scrivilo con il prefisso, per esempio +39 333 1234567.');
      setDone(null);
      return;
    }
    const failure = onLoad(normalized);
    if (failure) {
      setError(failure);
      setDone(null);
      return;
    }
    savePhone(normalized);
    setPhone(normalized);
    setError(null);
    setDone(`Caricate ${TEST_PRATICHE_COUNT} pratiche di prova in attesa, tutte con il numero ${normalized}.`);
  };

  const remove = () => {
    onRemove();
    setError(null);
    setDone('Pratiche di prova tolte.');
  };

  return (
    <ModalShell
      icon={FlaskConical}
      tone="brand"
      title="Pratiche di prova"
      subtitle="Solo nella versione di prova: dati finti, separati da quelli veri"
      onClose={onClose}
      size="lg"
      testId="test-pratiche-modal"
      footer={
        <>
          <button type="button" className="btn btn-danger mr-auto" onClick={remove} disabled={testCount === 0} data-testid="test-pratiche-remove">
            <Trash2 {...ic} />Togli le pratiche di prova
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Chiudi</button>
          <button type="button" className="btn btn-primary" onClick={load} data-testid="test-pratiche-load">
            <Upload {...ic} />Carica le pratiche di prova
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Numero da chiamare"
          htmlFor={`${fid}-phone`}
          hint="Tutte le pratiche di prova avranno questo numero: deve essere fra quelli ammessi (RETELL_TEST_NUMBERS)."
        >
          <input
            id={`${fid}-phone`}
            type="tel"
            required
            className="input num"
            value={phone}
            onChange={e => { setPhone(e.target.value); setError(null); }}
            onKeyDown={e => { if (e.key === 'Enter') load(); }}
            placeholder="+39 333 1234567"
            aria-invalid={!!error || undefined}
            data-testid="test-pratiche-phone"
          />
        </Field>

        <div className="rounded-control border border-line bg-slate-50/70 px-3 py-2.5 text-[13px] leading-5 text-ink-700 space-y-1.5">
          <p>
            <strong>Carica</strong> toglie le pratiche di prova già presenti (in qualunque stato) e ne crea{' '}
            {TEST_PRATICHE_COUNT} nuove <strong>in attesa</strong>: si ricomincia da capo ogni volta.
          </p>
          <p>
            Due gruppi da 8, per ipotizzare due giri: Oltrepò pavese (base a Stradella) e Milano ovest con Novara
            (base a Magenta), ognuno con il suo tecnico. Se manca un tecnico competente se ne aggiunge uno di prova.
          </p>
          <p>
            Nomi di fantasia e casi diversi per l'operatore AI: un'urgente, un referente, un nome tutto maiuscolo,
            una senza intestatario, note pratiche (citofono, scala) e una visita da 40 minuti.
          </p>
        </div>

        {!testNumbersConfigured && (
          <p className="text-[13px] leading-5 text-rose-700" data-testid="test-pratiche-no-numbers">
            Le chiamate restano bloccate finché non imposti RETELL_TEST_NUMBERS su Vercel (ambiente Preview).
          </p>
        )}
        <p className="text-xs text-ink-500" data-testid="test-pratiche-count">
          Pratiche di prova presenti ora: <span className="num">{testCount}</span>
        </p>
        {error && <p role="alert" className="text-[13px] font-medium text-rose-700" data-testid="test-pratiche-error">{error}</p>}
        {done && <p role="status" className="text-[13px] font-medium text-emerald-700" data-testid="test-pratiche-done">{done}</p>}
      </div>
    </ModalShell>
  );
};

export default TestPraticheModal;
