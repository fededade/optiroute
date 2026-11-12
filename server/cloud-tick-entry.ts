// Entry di api/cloud-tick.js (impacchettato da scripts/build-api.mjs).
// './tz' DEVE restare il primo import: imposta il fuso prima di tutto il resto.
import './tz';
import { createTickHandler } from './http';

export default createTickHandler();
