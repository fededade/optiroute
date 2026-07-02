import type { NominatimResult, Coordinates } from '../types';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';

export interface GeocodeResult {
  coords: Coordinates;
  displayName: string;
}

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
