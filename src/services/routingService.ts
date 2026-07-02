import type { Coordinates } from '../types';

// OSRM fallback URL
const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Decode polyline (Google Polyline Algorithm)
const decodePolyline = (encoded: string): [number, number][] => {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
};

export interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
  geometry?: [number, number][];
}

// Google Maps via Vercel API proxy (handles CORS and keeps API key secure)
const getGoogleRoute = async (
  start: Coordinates,
  end: Coordinates,
  waypoints?: Coordinates[]
): Promise<RouteResult | null> => {
  try {
    const params = new URLSearchParams({
      originLat: start.lat.toString(),
      originLng: start.lng.toString(),
      destLat: end.lat.toString(),
      destLng: end.lng.toString(),
    });

    if (waypoints && waypoints.length > 0) {
      params.append('waypoints', waypoints.map(w => `${w.lat},${w.lng}`).join('|'));
    }

    const response = await fetch(`/api/directions?${params}`);
    
    if (!response.ok) {
      console.warn('Google API proxy returned error:', response.status);
      return null;
    }

    const data = await response.json();

    if (data.error) {
      console.warn('Google Directions error:', data.error);
      return null;
    }

    return {
      distanceKm: data.distanceKm,
      durationMinutes: data.durationMinutes,
      geometry: data.geometry ? decodePolyline(data.geometry) : undefined
    };
  } catch (error) {
    console.warn('Google route request failed:', error);
    return null;
  }
};

// OSRM fallback (free, no API key, but no real traffic data)
const TRAFFIC_FACTOR = 1.4;

// Internal rate-limit for the public OSRM demo server: callers no longer
// need to sleep between requests, we space them out here only when needed.
const OSRM_MIN_INTERVAL_MS = 800;
let lastOsrmRequestAt = 0;

const throttleOsrm = async () => {
  const waitMs = lastOsrmRequestAt + OSRM_MIN_INTERVAL_MS - Date.now();
  if (waitMs > 0) await wait(waitMs);
  lastOsrmRequestAt = Date.now();
};

const getOSRMRoute = async (
  start: Coordinates,
  end: Coordinates,
  includeGeometry = true,
  retries = 3
): Promise<RouteResult | null> => {
  const overview = includeGeometry ? 'full' : 'false';
  const url = `${OSRM_BASE_URL}/${start.lng},${start.lat};${end.lng},${end.lat}?overview=${overview}&geometries=polyline`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await throttleOsrm();
      const response = await fetch(url);
      
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          const delay = 1000 * Math.pow(2, attempt);
          await wait(delay);
          continue;
        }
        return null;
      }

      if (!response.ok) return null;
      
      const data = await response.json();
      
      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        return {
          distanceKm: parseFloat((route.distance / 1000).toFixed(2)),
          durationMinutes: Math.ceil((route.duration / 60) * TRAFFIC_FACTOR),
          geometry: route.geometry ? decodePolyline(route.geometry) : undefined
        };
      }
      return null;
    } catch (error) {
      if (attempt === retries) return null;
    }
  }
  return null;
};

// Cache of already computed legs: re-optimizing or swapping stops on the
// same day reuses results instantly instead of re-hitting the APIs.
const routeCache = new Map<string, RouteResult>();

const routeCacheKey = (start: Coordinates, end: Coordinates): string =>
  `${start.lat.toFixed(5)},${start.lng.toFixed(5)}|${end.lat.toFixed(5)},${end.lng.toFixed(5)}`;

// Main function: tries cache, then Google, falls back to OSRM
export const getRoadRoute = async (
  start: Coordinates,
  end: Coordinates
): Promise<RouteResult | null> => {
  const key = routeCacheKey(start, end);
  const cached = routeCache.get(key);
  if (cached) return cached;

  // Try Google Maps first (accurate traffic data)
  const googleResult = await getGoogleRoute(start, end);
  if (googleResult) {
    routeCache.set(key, googleResult);
    return googleResult;
  }

  // Fallback to OSRM
  const osrmResult = await getOSRMRoute(start, end);
  if (osrmResult) routeCache.set(key, osrmResult);
  return osrmResult;
};

// Get full route geometry through multiple waypoints
export const getFullRouteGeometry = async (
  waypoints: Coordinates[]
): Promise<[number, number][] | null> => {
  if (waypoints.length < 2) return null;

  // Try Google Maps first
  const start = waypoints[0];
  const end = waypoints[waypoints.length - 1];
  const middlePoints = waypoints.slice(1, -1);

  const googleResult = await getGoogleRoute(start, end, middlePoints);
  if (googleResult?.geometry) {
    return googleResult.geometry;
  }

  // Fallback to OSRM
  const coordsString = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
  const url = `${OSRM_BASE_URL}/${coordsString}?overview=full&geometries=polyline`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.routes?.[0]?.geometry) {
      return decodePolyline(data.routes[0].geometry);
    }
    return null;
  } catch (error) {
    console.warn('OSRM route geometry failed:', error);
    return null;
  }
};
