import type { NominatimResult, NominatimAddress, Coordinates } from '../types';
import { provinceToCode } from '../utils/provinces';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

export interface GeocodeResult {
  coords: Coordinates;
  displayName: string;
  province?: string; // Sigla provincia (es. "MI") quando rilevabile
  comune?: string;
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

export const hasCachedGeocode = (address: string): boolean =>
  geocodeCache.has(normalizeKey(address));

export const geocodeAddress = async (address: string): Promise<GeocodeResult | null> => {
  const key = normalizeKey(address);
  if (geocodeCache.has(key)) {
    return geocodeCache.get(key) ?? null;
  }

  try {
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

// --- Reverse geocoding (coordinate -> provincia/comune) ---
// Serve per gli appuntamenti salvati prima dell'introduzione delle zone,
// che hanno le coordinate ma non la provincia. Rispetta il rate limit
// Nominatim (1 req/s) con un throttle interno + cache.

const reverseCache = new Map<string, { province?: string; comune?: string } | null>();
const reverseKey = (c: Coordinates) => `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;

let lastReverseAt = 0;
const REVERSE_MIN_INTERVAL_MS = 1100;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    const waitMs = lastReverseAt + REVERSE_MIN_INTERVAL_MS - Date.now();
    if (waitMs > 0) await wait(waitMs);
    lastReverseAt = Date.now();

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
