import { useEffect, useState } from 'react';

// UNA SOLA SCHEDA per gli automatismi (motore chiamate, smistamento
// automatico, inbox del bridge): con due schede aperte i clienti verrebbero
// chiamati due volte. Si usa la Web Locks API: la scheda che ottiene il lock
// lo tiene finché vive; le altre restano in attesa e subentrano da sole
// quando quella si chiude. Senza Web Locks la scheda si comporta da unica.

export type TabLockState = 'pending' | 'leader' | 'follower';

interface LockManagerLike {
  request: (
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void
  ) => Promise<unknown>;
}

export const useTabLock = (name: string): TabLockState => {
  const [state, setState] = useState<TabLockState>(() =>
    typeof navigator !== 'undefined' && (navigator as any).locks ? 'pending' : 'leader'
  );

  useEffect(() => {
    const locks: LockManagerLike | undefined = (navigator as any).locks;
    if (!locks) {
      setState('leader');
      return;
    }

    let disposed = false;
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const abort = new AbortController();

    const hold = async () => {
      if (disposed) return;
      setState('leader');
      await held; // il lock resta nostro finché la scheda (o il componente) vive
    };

    locks
      .request(name, { ifAvailable: true }, async lock => {
        if (lock) return hold();
        // Un'altra scheda ha il lock: si attende in coda il suo rilascio
        if (disposed) return;
        setState('follower');
        locks
          .request(name, { signal: abort.signal }, () => hold())
          .catch(() => { /* richiesta annullata allo smontaggio */ });
      })
      .catch(() => {
        // Web Locks non utilizzabile (es. contesto non sicuro): scheda unica
        if (!disposed) setState('leader');
      });

    return () => {
      disposed = true;
      abort.abort();
      release();
    };
  }, [name]);

  return state;
};
