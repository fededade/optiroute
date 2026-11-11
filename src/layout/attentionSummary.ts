import type { AttentionItem, AttentionKind } from '../services/autopilotService';

// Riassunto di "Da gestire" per la Panoramica: stesso raggruppamento per
// tipo della sezione (e stesso ordine di AttentionPanel), più gli slot da
// riservare per i rientri. Es. "1 slot da riservare · 2 numeri errati".

const KIND_WORDS: Record<AttentionKind, [string, string]> = {
  esito_da_verificare: ['esito da verificare', 'esiti da verificare'],
  chiamata_non_avviata: ['chiamata non partita', 'chiamate non partite'],
  irreperibile: ['non raggiungibile', 'non raggiungibili'],
  numero_errato: ['numero errato', 'numeri errati'],
  rifiutato: ['rifiutato dal cliente', 'rifiutati dal cliente'],
  referente_senza_numero: ['referente senza numero', 'referenti senza numero'],
  senza_telefono: ['senza telefono', 'senza telefono'],
  senza_tecnico: ['senza tecnico', 'senza tecnico'],
  posizione_approssimativa: ['posizione approssimativa', 'posizioni approssimative'],
};

export interface AttentionPart { key: string; count: number; text: string }

export const attentionBreakdown = (items: Pick<AttentionItem, 'kind'>[], slotCount: number): AttentionPart[] => {
  const parts: AttentionPart[] = [];
  if (slotCount > 0) parts.push({ key: 'slot', count: slotCount, text: `${slotCount} slot da riservare` });
  for (const kind of Object.keys(KIND_WORDS) as AttentionKind[]) {
    const n = items.filter(i => i.kind === kind).length;
    if (n === 0) continue;
    const [one, many] = KIND_WORDS[kind];
    parts.push({ key: kind, count: n, text: `${n} ${n === 1 ? one : many}` });
  }
  return parts;
};
