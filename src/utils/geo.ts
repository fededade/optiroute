import { Appointment, Coordinates, RouteSummary } from '../types';
import { getRoadRoute } from '../services/routingService';

// Haversine formula to calculate distance between two points in km
export const calculateDistance = (coord1: Coordinates, coord2: Coordinates): number => {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(coord2.lat - coord1.lat);
  const dLon = deg2rad(coord2.lng - coord1.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(coord1.lat)) *
      Math.cos(deg2rad(coord2.lat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c; // Distance in km
  return d;
};

const deg2rad = (deg: number): number => {
  return deg * (Math.PI / 180);
};

// Fallback estimation if OSRM fails or is unavailable
// Logic updated to be more "pessimistic" and realistic for city driving
export const estimateTravelTimeMinutes = (distanceKm: number): number => {
  // Assume slower average speed for urban areas (approx 21 km/h or 0.35 km/min)
  // Old value was 0.5 km/min (30km/h) which is too optimistic for direct line calculations
  const AVERAGE_SPEED_KPM = 0.35; 
  const TORTUOSITY = 1.4; // Road factor (roads aren't straight)
  const BASE_PENALTY_MINUTES = 5; // Traffic lights, parking, getting out of car
  
  const estimatedDrive = Math.ceil((distanceKm * TORTUOSITY) / AVERAGE_SPEED_KPM);
  return estimatedDrive + BASE_PENALTY_MINUTES;
};

export const formatTime = (date: Date): string => {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
};

// "Furthest First, Closest Last" Logic (Reverse Greedy)
export const optimizeRoute = (
  appointments: Appointment[],
  baseLocation?: Coordinates | null
): Appointment[] => {
  if (appointments.length === 0) return [];
  if (appointments.length === 1) return appointments;

  let remaining = [...appointments];
  
  // Logic:
  // If we have a base, we build the route BACKWARDS from the base.
  // 1. Find closest point to Base -> This is the LAST stop.
  // 2. Find closest point to that stop -> This is the SECOND TO LAST stop.
  // ...
  // The last remaining point becomes the FIRST stop (which will naturally be far away).
  
  if (baseLocation) {
    const sortedInReverse: Appointment[] = [];
    let currentReference = baseLocation;

    while (remaining.length > 0) {
      let nearestIndex = -1;
      let minDistance = Infinity;

      // Find the point closest to the current reference (starting with Base)
      for (let i = 0; i < remaining.length; i++) {
        const dist = calculateDistance(currentReference, remaining[i].coords);
        if (dist < minDistance) {
          minDistance = dist;
          nearestIndex = i;
        }
      }

      if (nearestIndex !== -1) {
        const nextStopFromEnd = remaining[nearestIndex];
        sortedInReverse.push(nextStopFromEnd);
        
        // Move reference to this point to find the one preceding it
        currentReference = nextStopFromEnd.coords;
        remaining.splice(nearestIndex, 1);
      }
    }

    // Reverse the list to get Start -> End order
    return sortedInReverse.reverse();

  } else {
    // STANDARD LOGIC (No Base): Nearest Neighbor from the first added point
    const sorted: Appointment[] = [];
    let current = remaining[0];
    sorted.push(current);
    remaining.splice(0, 1);

    while (remaining.length > 0) {
      let nearestIndex = -1;
      let minDistance = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const dist = calculateDistance(current.coords, remaining[i].coords);
        if (dist < minDistance) {
          minDistance = dist;
          nearestIndex = i;
        }
      }

      if (nearestIndex !== -1) {
        const next = remaining[nearestIndex];
        remaining.splice(nearestIndex, 1);
        current = next;
        sorted.push(current);
      }
    }
    return sorted;
  }
};

interface ScheduleResult {
  scheduled: Appointment[];
  overflow: Appointment[];
}

// Async Schedule Calculation using Real Roads with Lunch Break & Daily Limits
export const calculateSchedule = async (
  sortedAppointments: Appointment[],
  baseLocation?: Coordinates | null,
  startTimeHours: number = 9,
  startTimeMinutes: number = 0,
  maxEndTimeHours: number = 18,
  durationMinutes: number = 20
): Promise<ScheduleResult> => {
  let currentTime = new Date();
  currentTime.setHours(startTimeHours, startTimeMinutes, 0, 0);

  const LUNCH_START_THRESHOLD_HOURS = 12; // Noon
  const LUNCH_DURATION_MINUTES = 45;
  let lunchTaken = false;

  const scheduled: Appointment[] = [];
  const overflow: Appointment[] = [];
  let isOverflowing = false;

  for (let i = 0; i < sortedAppointments.length; i++) {
    // If we already hit the limit in previous iteration, just dump rest to overflow
    if (isOverflowing) {
      overflow.push({ ...sortedAppointments[i], sequenceOrder: undefined, startTime: undefined, endTime: undefined });
      continue;
    }

    const appt = sortedAppointments[i];
    let travelTime = 0;
    let distance = 0;

    // Calculate Travel from Previous (or implicitly from start, though start is fixed time)
    if (i > 0) {
      const prev = scheduled[i - 1]; 
      
      const routeData = await getRoadRoute(prev.coords, appt.coords);
      
      if (routeData) {
        distance = routeData.distanceKm;
        travelTime = routeData.durationMinutes;
      } else {
        distance = parseFloat(calculateDistance(prev.coords, appt.coords).toFixed(2));
        travelTime = estimateTravelTimeMinutes(distance);
      }

      // Add travel time
      currentTime = new Date(currentTime.getTime() + travelTime * 60000);
    } else {
      // For the first appointment, technically we travel from base, 
      // but the requirement says "First appointment AT 09:00".
      // So travel time is consumed BEFORE 09:00. 
      // However, usually "start day at 9" means "leave base at 9".
      // Let's assume the user wants the MEETING to start at start time if it's the first one,
      // OR allow travel time. 
      // Standard logic: Clock starts ticking at StartTime. Travel counts.
      
      if (baseLocation) {
         // Calculate travel from base to first point
         // If we want the first meeting to strictly START at 09:00, we skip adding this to `currentTime`
         // BUT, usually schedule management counts the work day hours.
         // Let's assume StartTime is "Start of Shift/Departure".
         
         // User Prompt says: "ogni giornata... il primo è alle 09:00" -> The First Appointment IS AT 09:00.
         // This implies travel from base happens before.
         // So for i=0, travelTime doesn't push the clock forward from 9:00, or we reset to 9:00.
         currentTime.setHours(startTimeHours, startTimeMinutes, 0, 0);
      }
    }

    // LUNCH BREAK LOGIC
    let hasLunchBreakBefore = false;
    if (!lunchTaken) {
      const currentHour = currentTime.getHours();
      
      if (currentHour >= LUNCH_START_THRESHOLD_HOURS) {
         currentTime = new Date(currentTime.getTime() + LUNCH_DURATION_MINUTES * 60000);
         lunchTaken = true;
         hasLunchBreakBefore = true;
      }
    }

    const startString = formatTime(currentTime);
    
    // Add meeting duration
    const endTime = new Date(currentTime.getTime() + durationMinutes * 60000);
    const endString = formatTime(endTime);
    
    // LIMIT CHECK: If the meeting ENDS after maxEndTimeHours (e.g. 18:00), it's overflow.
    // Or if it starts after. Let's be strict: Needs to finish or at least start comfortably?
    // "conclude con l'ultimo sopralluogo alle 18:00" -> Ends at 18:00.
    
    // Create a comparison date for today at maxEndTimeHours
    const limitDate = new Date(currentTime);
    limitDate.setHours(maxEndTimeHours, 0, 0, 0);

    // If the MEETING START is already past the limit, or END is past limit?
    // "ultimo sopralluogo non deve essere concordato oltre le ore 18:00" -> Agreed/Started? Or Finished?
    // Usually "conclude con l'ultimo... alle 18:00" implies the day ends at 18.
    if (endTime > limitDate) {
      isOverflowing = true;
      overflow.push({ ...appt, sequenceOrder: undefined, startTime: undefined, endTime: undefined });
      continue; // Skip adding to scheduled
    }

    scheduled.push({
      ...appt,
      startTime: startString,
      endTime: endString,
      travelTimeFromPrev: travelTime,
      distanceFromPrev: distance,
      sequenceOrder: i + 1,
      hasLunchBreakBefore: hasLunchBreakBefore
    });

    // Update current time for next loop
    currentTime = endTime;
    
    // Polite rate limiting for OSRM public server
    // Increased from 600 to 800ms + the internal backoff inside routingService means more reliability
    if (i < sortedAppointments.length - 1) {
      await new Promise(r => setTimeout(r, 800)); 
    }
  }

  return { scheduled, overflow };
};

export const calculateRouteSummary = (appointments: Appointment[]): RouteSummary => {
  let totalDistance = 0;
  let totalTravelTime = 0;

  appointments.forEach((appt) => {
    if (appt.distanceFromPrev) {
      totalDistance += appt.distanceFromPrev;
    }
    if (appt.travelTimeFromPrev) {
      totalTravelTime += appt.travelTimeFromPrev;
    }
  });

  const lastAppt = appointments[appointments.length - 1];
  const finalEndTime = lastAppt?.endTime || '';

  return {
    totalDistance: parseFloat(totalDistance.toFixed(2)),
    totalTravelTime,
    finalEndTime,
  };
};