// Entry di api/cloud.js (impacchettato da scripts/build-api.mjs).
// './tz' DEVE restare il primo import: imposta il fuso prima di tutto il resto.
import './tz';
import { createCloudHandler } from './http';

export default createCloudHandler();
