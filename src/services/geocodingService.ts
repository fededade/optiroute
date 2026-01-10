import { NominatimResult, Coordinates } from '../types';

// Use OpenStreetMap Nominatim for Geocoding (Free, no key required for low volume)
const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';

export const geocodeAddress = async (address: string): Promise<{ coords: Coordinates; displayName: string } | null> => {
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
      return {
        coords: {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
        },
        displayName: data[0].display_name,
      };
    }

    return null;
  } catch (error) {
    console.error("Geocoding error:", error);
    return null;
  }
};