// Entry di api/cloud.js (impacchettato da scripts/build-api.mjs).
// './tz' DEVE restare il primo import: imposta il fuso prima di tutto il resto.
import './tz';
import { createCloudHandler } from './http';

export default createCloudHandler();

// Per lo strumento locale scripts/dev-cloud-server.mjs (prove con il
// gestionale finto o con gli emulatori di Firebase): costruisce la funzione
// con le dipendenze sostituite. Vercel usa solo l'export predefinito.
export { createCloudHandler };
export { checkFirebaseClaims, decodeJwt } from './gestionale';
