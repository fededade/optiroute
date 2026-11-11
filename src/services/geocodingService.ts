import type { NominatimResult, NominatimAddress, Coordinates } from '../types';
import { provinceToCode } from '../utils/provinces';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

export interface GeocodeResult {
  coords: Coordinates;
  displayName: string;
  province?: string; // Sigla provincia (es. "MI") quando rilevabile
  comune?: string;
  approximate?: boolean; // true: trovato solo il comune, coordinate al suo centro
}

// Estrae provincia (sigla) e comune dai dettagli Nominatim di un indirizzo italiano
const extractPlaceInfo = (address?: NominatimAddress): { province?: string; comune?: string } => {
  if (!address) return {};
  const provinceRaw =
    address['ISO3166-2-lvl6'] || address.county || address.province || address.state_district;
  const comune =
    address.city || address.town || address.village || address.municipality || address.hamlet;
  return { province: provinceToCode(provinceRaw), comune };
};

// Cache results (including misses) so repeated addresses — common when
// importing Excel files — don't re-hit Nominatim and its 1 req/s limit.
const geocodeCache = new Map<string, GeocodeResult | null>();

const normalizeKey = (address: string): string => address.trim().toLowerCase();

// Throttle unico per TUTTE le richieste Nominatim (search + reverse):
// il servizio impone 1 req/s; le cache hit non consumano lo slot.
let lastNominatimAt = 0;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const waitForNominatimSlot = async (): Promise<void> => {
  const waitMs = lastNominatimAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
  if (waitMs > 0) await wait(waitMs);
  lastNominatimAt = Date.now();
};

export const geocodeAddress = async (address: string): Promise<GeocodeResult | null> => {
  const key = normalizeKey(address);
  if (geocodeCache.has(key)) {
    return geocodeCache.get(key) ?? null;
  }

  try {
    await waitForNominatimSlot();

    const params = new URLSearchParams({
      q: address,
      format: 'json',
      limit: '1',
      addressdetails: '1',
    });

    const response = await fetch(`${NOMINATIM_BASE_URL}?${params.toString()}`);

    if (!response.ok) {
      throw new Error('Network response was not ok');
    }

    const data: NominatimResult[] = await response.json();

    if (data && data.length > 0) {
      const result: GeocodeResult = {
        coords: {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
        },
        displayName: data[0].display_name,
        ...extractPlaceInfo(data[0].address),
      };
      geocodeCache.set(key, result);
      return result;
    }

    geocodeCache.set(key, null);
    return null;
  } catch (error) {
    // Do not cache network errors: they may be transient
    console.error("Geocoding error:", error);
    return null;
  }
};

// --- Geocoding con fallback per indirizzi strutturati (import Excel) ---

export interface AddressParts {
  street?: string;   // Es. "VIA SAN PROTASO"
  civic?: string;    // Es. "14"
  comune?: string;   // Es. "CASORATE PRIMO"
  province?: string; // Sigla o nome, es. "PV"
}

// Prefissi odonimici italiani: spesso il file dice "VIA" ma su OpenStreetMap
// la strada è censita come "Piazza"/"Corso"/ecc. (o viceversa). Toglierli
// permette a Nominatim di trovare la strada per nome.
const ROAD_PREFIX_RE = /^(via|viale|v\.?le|piazza|p\.?zza|p\.?za|piazzale|p\.?le|piazzetta|corso|c\.?so|largo|l\.?go|vicolo|v\.?lo|strada|str\.|localita'?|località|loc\.?|frazione|fraz\.?|contrada|c\.?da|borgo|salita|discesa|traversa|trav\.?|lungomare|lungolago|galleria)\s+/i;

const stripRoadPrefix = (street: string): string =>
  street.trim().replace(ROAD_PREFIX_RE, '').trim();

// Prova l'indirizzo completo e, se non trovato, varianti sempre più permissive:
// 1. via + civico + comune + provincia (query storica)
// 2. senza civico
// 3. senza prefisso via/piazza/corso (con e senza civico)
// 4. solo comune + provincia → risultato "approximate" (centro del comune)
export const geocodeAddressParts = async (parts: AddressParts): Promise<GeocodeResult | null> => {
  const street = parts.street?.trim();
  const civic = parts.civic?.trim();
  const comune = parts.comune?.trim();
  const province = parts.province?.trim();

  const locality = [comune, province].filter(Boolean).join(', ');

  const attempts: string[] = [];
  const addAttempt = (streetPart?: string) => {
    if (!streetPart) return;
    const q = [streetPart, comune, province].filter(Boolean).join(', ');
    if (q && !attempts.includes(q)) attempts.push(q);
  };

  if (street) {
    const stripped = stripRoadPrefix(street);
    addAttempt(civic ? `${street} ${civic}` : street);
    addAttempt(street);
    if (stripped && stripped.toLowerCase() !== street.toLowerCase()) {
      addAttempt(civic ? `${stripped} ${civic}` : stripped);
      addAttempt(stripped);
    }
  }

  for (const query of attempts) {
    const result = await geocodeAddress(query);
    if (result) return result;
  }

  // Ultima spiaggia: centro del comune, marcato come approssimativo così
  // l'operatore sa che il pin non è sull'indirizzo esatto.
  if (comune) {
    const fallback = (await geocodeAddress(locality)) || (province ? await geocodeAddress(comune) : null);
    if (fallback) return { ...fallback, approximate: true };
  }

  return null;
};

// --- Reverse geocoding (coordinate -> provincia/comune) ---
// Serve per gli appuntamenti salvati prima dell'introduzione delle zone,
// che hanno le coordinate ma non la provincia. Rispetta il rate limit
// Nominatim (1 req/s) con un throttle interno + cache.

const reverseCache = new Map<string, { province?: string; comune?: string } | null>();
const reverseKey = (c: Coordinates) => `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;

export const hasCachedReverse = (coords: Coordinates): boolean =>
  reverseCache.has(reverseKey(coords));

export const reverseGeocodePlace = async (
  coords: Coordinates
): Promise<{ province?: string; comune?: string } | null> => {
  const key = reverseKey(coords);
  if (reverseCache.has(key)) {
    return reverseCache.get(key) ?? null;
  }

  try {
    await waitForNominatimSlot();

    const params = new URLSearchParams({
      lat: coords.lat.toString(),
      lon: coords.lng.toString(),
      format: 'json',
      zoom: '10', // livello comune
      addressdetails: '1',
    });

    const response = await fetch(`${NOMINATIM_REVERSE_URL}?${params.toString()}`);
    if (!response.ok) throw new Error('Reverse geocoding failed');

    const data: NominatimResult = await response.json();
    const info = extractPlaceInfo(data?.address);
    reverseCache.set(key, info);
    return info;
  } catch (error) {
    console.error('Reverse geocoding error:', error);
    return null; // errori di rete: non cachare
  }
};
