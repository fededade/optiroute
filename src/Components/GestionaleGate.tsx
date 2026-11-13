import React, { useEffect, useState } from 'react';
import { ExternalLink, KeyRound, Lock, RefreshCw, ShieldAlert, Unplug } from 'lucide-react';
import { setCallCredential } from '../services/callService';
import { GestionaleHost, candidateParentOrigin, hello, requestIdToken, type GestionaleUser, type WindowLike } from '../services/gestionaleHost';
import { GestionaleSession, GestionaleSessionError, checkParent } from '../services/gestionaleSession';
import { Spinner } from './modal/parts';

// OptiRoute dentro una pagina di un altro sito (iframe).
//  1. il server dice se quella pagina è del gestionale (?op=ping&parent=...);
//  2. si saluta la pagina del gestionale e le si chiede il biglietto di
//     Firebase della persona collegata;
//  3. il server lo verifica e rilascia il biglietto di sessione (solo
//     amministratori).
// Se un passo non riesce si mostra un avviso a tutta pagina, in chiaro: mai
// l'app con i soli dati del browser, dentro il gestionale.

export interface GestionaleContext {
  user: { name: string; role: string; email: string };
  session: GestionaleSession;
  host: GestionaleHost;
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'ready'; ctx: GestionaleContext }
  | { kind: 'not_allowed'; disabled: boolean }
  | { kind: 'forbidden'; user: GestionaleUser | null }
  | { kind: 'not_configured' }
  | { kind: 'auth'; message: string }
  | { kind: 'network'; message: string };

const failurePhase = (err: GestionaleSessionError, user: GestionaleUser | null): Phase => {
  switch (err.kind) {
    case 'forbidden': return { kind: 'forbidden', user };
    case 'not_configured': return { kind: 'not_configured' };
    case 'auth': return { kind: 'auth', message: err.message };
    default: return { kind: 'network', message: err.message };
  }
};

interface GateProps {
  children: (ctx: GestionaleContext) => React.ReactNode;
}

const GestionaleGate: React.FC<GateProps> = ({ children }) => {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let host: GestionaleHost | null = null;
    let session: GestionaleSession | null = null;
    setPhase({ kind: 'checking' });

    (async () => {
      const win = window as unknown as WindowLike;
      const origin = candidateParentOrigin(win);
      const check = await checkParent(origin);
      if (cancelled) return;
      if (check.kind === 'network') { setPhase({ kind: 'network', message: 'Il server di OptiRoute non risponde.' }); return; }
      if (check.kind !== 'allowed') { setPhase({ kind: 'not_allowed', disabled: check.kind === 'disabled' }); return; }

      host = new GestionaleHost({ win, parentOrigin: origin });
      host.start();
      let user: GestionaleUser | null = null;
      try {
        user = (await hello(host, 10_000)).user;
      } catch {
        if (!cancelled) setPhase({ kind: 'network', message: 'La pagina del gestionale non risponde.' });
        return;
      }
      if (cancelled) return;
      const h = host;
      session = new GestionaleSession({ getIdToken: () => requestIdToken(h) });
      try {
        const sessionUser = await session.start();
        if (cancelled) return;
        setCallCredential(session.credential);
        session.onLost(err => { if (!cancelled) setPhase(failurePhase(err, user)); });
        setPhase({
          kind: 'ready',
          ctx: {
            user: { name: sessionUser.name || user.name, role: sessionUser.role || user.role, email: user.email },
            session,
            host: h,
          },
        });
      } catch (err) {
        if (cancelled) return;
        setPhase(failurePhase(err instanceof GestionaleSessionError ? err : new GestionaleSessionError('network', 'Collegamento non riuscito.'), user));
      }
    })();

    return () => {
      cancelled = true;
      setCallCredential(null);
      session?.destroy();
      host?.stop();
    };
  }, [attempt]);

  if (phase.kind === 'ready') return <>{children(phase.ctx)}</>;
  return <GestionaleNotice phase={phase} onRetry={() => setAttempt(n => n + 1)} />;
};

// --- Avvisi a tutta pagina ---

const selfUrl = (): string => (typeof location !== 'undefined' ? location.href : '/');

const NoticeShell: React.FC<{ kind: string; icon: React.ReactNode; title: string; children?: React.ReactNode }> = ({ kind, icon, title, children }) => (
  <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
    <div data-testid="gestionale-notice" data-kind={kind} role="alert" className="card w-full max-w-[520px] p-6 sm:p-8">
      <div className="mb-4 flex items-center gap-3">
        <img src="/Logo.png" alt="" className="h-9 w-9 rounded-lg object-cover" />
        <span className="text-[15px] font-semibold text-ink-900">OptiRoute</span>
      </div>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-ink-500">{icon}</span>
        <div className="min-w-0 space-y-3 text-sm leading-6 text-ink-700">
          <h1 className="text-lg font-semibold leading-7 text-ink-950">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  </div>
);

const RetryButton: React.FC<{ onRetry: () => void }> = ({ onRetry }) => (
  <button type="button" onClick={onRetry} className="btn btn-primary" data-testid="gestionale-retry">
    <RefreshCw size={16} strokeWidth={1.75} aria-hidden />
    Riprova
  </button>
);

const ICON = { size: 22, strokeWidth: 1.75, 'aria-hidden': true } as const;

export const GestionaleNotice: React.FC<{ phase: Exclude<Phase, { kind: 'ready' }>; onRetry: () => void }> = ({ phase, onRetry }) => {
  switch (phase.kind) {
    case 'checking':
      return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
          <p data-testid="gestionale-checking" role="status" className="flex items-center gap-2 text-sm text-ink-600">
            <Spinner />
            Collegamento al gestionale...
          </p>
        </div>
      );
    case 'not_allowed':
      return (
        <NoticeShell kind="not_allowed" icon={<ShieldAlert {...ICON} />} title="OptiRoute non può essere aperta dentro questa pagina">
          <p>Per sicurezza OptiRoute si apre dentro un'altra pagina solo se è una pagina autorizzata del gestionale.</p>
          {phase.disabled && (
            <p className="text-ink-500">
              Se questa è la pagina del gestionale: sul server di OptiRoute il collegamento con il gestionale non è attivo.
            </p>
          )}
          <p>
            <a href={selfUrl()} target="_blank" rel="noopener noreferrer" className="btn btn-primary" data-testid="gestionale-open-standalone">
              <ExternalLink size={16} strokeWidth={1.75} aria-hidden />
              Apri OptiRoute in una nuova scheda
            </a>
          </p>
        </NoticeShell>
      );
    case 'forbidden':
      return (
        <NoticeShell kind="forbidden" icon={<Lock {...ICON} />} title="Area riservata agli amministratori">
          <p>
            OptiRoute, dentro il gestionale, è disponibile solo per chi ha il ruolo di Super Amministratore o Amministratore.
          </p>
          {phase.user?.name && (
            <p className="text-ink-500">
              Accesso effettuato come {phase.user.name}{phase.user.role ? ` (${phase.user.role})` : ''}.
            </p>
          )}
        </NoticeShell>
      );
    case 'not_configured':
      return (
        <NoticeShell kind="not_configured" icon={<Unplug {...ICON} />} title="Collegamento con il gestionale da completare">
          <p>
            Sul server di OptiRoute (Vercel → Settings → Environment Variables) mancano due impostazioni:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li><code className="font-mono text-[13px]">GESTIONALE_ORIGINS</code>: l'indirizzo della pagina del gestionale;</li>
            <li><code className="font-mono text-[13px]">GESTIONALE_FIREBASE_PROJECTS</code>: il progetto Firebase del gestionale.</li>
          </ul>
          <p className="text-ink-500">Dopo averle aggiunte serve un nuovo deploy.</p>
          <RetryButton onRetry={onRetry} />
        </NoticeShell>
      );
    case 'auth':
      return (
        <NoticeShell kind="auth" icon={<KeyRound {...ICON} />} title="Accesso non riconosciuto">
          <p>Il server di OptiRoute non ha riconosciuto l'accesso fatto nel gestionale. Esci e rientra nel gestionale, poi riprova.</p>
          <RetryButton onRetry={onRetry} />
        </NoticeShell>
      );
    case 'network':
      return (
        <NoticeShell kind="network" icon={<Unplug {...ICON} />} title="Collegamento non riuscito">
          <p>{phase.message} Controlla la connessione e riprova.</p>
          <RetryButton onRetry={onRetry} />
        </NoticeShell>
      );
  }
};

export default GestionaleGate;
