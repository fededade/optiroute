import type { VercelRequest, VercelResponse } from '@vercel/node';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({ error: 'Google Maps API key not configured' });
  }

  const { originLat, originLng, destLat, destLng, waypoints } = req.query;

  if (!originLat || !originLng || !destLat || !destLng) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originLat},${originLng}&destination=${destLat},${destLng}&departure_time=now&traffic_model=best_guess&key=${GOOGLE_MAPS_API_KEY}`;

    // Add waypoints if provided
    if (waypoints && typeof waypoints === 'string') {
      url += `&waypoints=${encodeURIComponent(waypoints)}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      console.error('Google Directions API error:', data.status, data.error_message);
      return res.status(400).json({ 
        error: data.error_message || data.status 
      });
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    // Calculate total distance and duration for multi-leg routes
    let totalDistance = 0;
    let totalDuration = 0;

    for (const l of route.legs) {
      totalDistance += l.distance.value;
      // Prefer duration_in_traffic for real traffic data
      totalDuration += l.duration_in_traffic?.value || l.duration.value;
    }

    return res.status(200).json({
      distanceKm: parseFloat((totalDistance / 1000).toFixed(2)),
      durationMinutes: Math.ceil(totalDuration / 60),
      geometry: route.overview_polyline?.points || null
    });

  } catch (error) {
    console.error('Directions API error:', error);
    return res.status(500).json({ error: 'Failed to fetch directions' });
  }
}
