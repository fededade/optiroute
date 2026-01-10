import type { Appointment, Coordinates, RouteSummary } from '../types';
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
export const estimateTravelTimeMinutes = (distanceKm: number): number => {
  const AVERAGE_SPEED_KPM = 0.35; 
  const TORTUOSITY = 1.4; 
  const BASE_PENALTY_MINUTES = 5; 
  
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
  
  if (baseLocation) {
    const sortedInReverse: Appointment[] = [];
    let currentReference = baseLocation;

    while (remaining.length > 0) {
      let nearestIndex = -1;
      let minDistance = Infinity;

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
        currentReference = nextStopFromEnd.coords;
        remaining.splice(nearestIndex, 1);
      }
    }
    return sortedInReverse.reverse();

  } else {
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

// Async Schedule Calculation using Real Roads
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
    if (isOverflowing) {
      overflow.push({ ...sortedAppointments[i], sequenceOrder: undefined, startTime: undefined, endTime: undefined });
      continue;
    }

    const appt = sortedAppointments[i];
    let travelTime = 0;
    let distance = 0;

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

      currentTime = new Date(currentTime.getTime() + travelTime * 60000);
    } else {
      if (baseLocation) {
         currentTime.setHours(startTimeHours, startTimeMinutes, 0, 0);
      }
    }

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
    const endTime = new Date(currentTime.getTime() + durationMinutes * 60000);
    const endString = formatTime(endTime);
    
    const limitDate = new Date(currentTime);
    limitDate.setHours(maxEndTimeHours, 0, 0, 0);

    if (endTime > limitDate) {
      isOverflowing = true;
      overflow.push({ ...appt, sequenceOrder: undefined, startTime: undefined, endTime: undefined });
      continue;
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

    currentTime = endTime;
    
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