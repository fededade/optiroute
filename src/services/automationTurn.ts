// Dove girano gli automatismi rimasti nel browser (funzioni PURE).
//
// Con il cloud acceso smistamento automatico e inbox del bridge girano su un
// solo dispositivo alla volta: quello che ha il "turno" del cloud.
// Eccezione: dentro il gestionale il bridge sta sul PC dell'operatore e si
// raggiunge solo dalla SUA pagina del gestionale, quindi l'inbox del bridge
// gira nella scheda principale di ogni browser, con o senza turno. È sicuro:
// il server non duplica una pratica con un codice già presente, e un
// dispositivo senza bridge riceve solo "bridge non avviato".
// Dentro il gestionale però l'inbox aspetta il primo scaricamento completo
// dal cloud (elenco e tecnici): prima confronterebbe le pratiche del bridge
// con l'elenco locale, magari vuoto o vecchio, e userebbe tecnici che nel
// cloud non esistono. Fuori dal gestionale non serve: il turno si conosce
// solo dopo il primo scaricamento.

export interface AutomationPlace {
  embedded: boolean;         // dentro la pagina del gestionale
  isAutomationTab: boolean;  // scheda principale di questo browser
  cloudActive: boolean;
  leaseHolder: boolean;      // questo dispositivo ha il turno del cloud
  cloudLoaded: boolean;      // primo scaricamento completo dal cloud applicato
}

// Smistamento automatico (e tutto ciò che dipende dal turno)
export const turnAutomationsHere = (p: AutomationPlace): boolean =>
  p.isAutomationTab && (!p.cloudActive || p.leaseHolder);

// Inbox del bridge
export const bridgeInboxHere = (p: AutomationPlace): boolean =>
  p.embedded ? p.isAutomationTab && p.cloudLoaded : turnAutomationsHere(p);
