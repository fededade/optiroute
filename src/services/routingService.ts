import { Coordinates } from '../types';

const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';

interface OSRMResponse {
  routes: {
    distance: number; // meters
    duration: number; // seconds
  }[];
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const getRoadRoute = async (start: Coordinates, end: Coordinates, retries = 3): Promise<{ distanceKm: number; durationMinutes: number } | null> => {
  const url = `${OSRM_BASE_URL}/${start.lng},${start.lat};${end.lng},${end.lat}?overview=false`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      
      // If rate limited (429) or server error (5xx), wait and retry
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          const delay = 1000 * Math.pow(2, attempt); // Exponential backoff: 1s, 2s, 4s
          console.warn(`OSRM Rate limit/Error. Retrying in ${delay}ms...`);
          await wait(delay);
          continue;
        } else {
          throw new Error('OSRM Max retries reached');
        }
      }

      if (!response.ok) throw new Error('OSRM request failed');
      
      const data: OSRMResponse = await response.json();
      
      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        return {
          distanceKm: parseFloat((route.distance / 1000).toFixed(2)),
          durationMinutes: Math.ceil(route.duration / 60)
        };
      }
      return null;
    } catch (error) {
      console.warn(`Routing error attempt ${attempt + 1}:`, error);
      if (attempt === retries) return null;
    }
  }
  return null;
};