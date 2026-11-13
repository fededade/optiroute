// Memoria del browser (localStorage) "a prova di gestionale".
//
// Quando OptiRoute è aperta dentro una pagina di un altro sito (il
// gestionale), il browser può separare, svuotare o addirittura BLOCCARE la
// memoria: in quel caso già leggere `localStorage` genera un errore. Qui si
// prova una volta sola: se la memoria del browser funziona la si usa esattamente
// come prima (stesse chiavi, stessi errori in scrittura, che i chiamanti già
// gestiscono); se è bloccata si usa una memoria temporanea, che dura finché la
// pagina resta aperta. Così l'app si apre comunque.

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// native: memoria del browser · memory: bloccata, memoria temporanea ·
// absent: nessuna memoria del browser (server, test)
export type SafeStorageMode = 'native' | 'memory' | 'absent';

export interface SafeStorage extends StorageLike {
  mode(): SafeStorageMode;
}

const memoryStorage = (): StorageLike => {
  const map = new Map<string, string>();
  return {
    getItem: key => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
};

// `getNative` restituisce la memoria del browser (può lanciare un errore o
// restituire undefined)
export const createSafeStorage = (getNative: () => StorageLike | undefined | null): SafeStorage => {
  let resolved: { mode: SafeStorageMode; store: StorageLike } | null = null;
  const fallback = memoryStorage();

  const resolve = () => {
    if (resolved) return resolved;
    try {
      const native = getNative();
      if (!native) {
        resolved = { mode: 'absent', store: fallback };
      } else {
        // prova di lettura: con la memoria bloccata qui arriva l'errore
        native.getItem('optiroute_prova_memoria');
        resolved = { mode: 'native', store: native };
      }
    } catch {
      resolved = { mode: 'memory', store: fallback };
    }
    return resolved;
  };

  return {
    mode: () => resolve().mode,
    getItem: key => {
      const r = resolve();
      if (r.mode !== 'native') return r.store.getItem(key);
      try {
        return r.store.getItem(key);
      } catch {
        return null; // lettura fallita: come se la chiave non ci fosse
      }
    },
    setItem: (key, value) => resolve().store.setItem(key, value),
    removeItem: key => resolve().store.removeItem(key),
  };
};

export const safeLocalStorage: SafeStorage = createSafeStorage(() =>
  typeof localStorage === 'undefined' ? undefined : localStorage
);
