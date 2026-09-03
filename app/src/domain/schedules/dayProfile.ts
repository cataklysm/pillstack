import type { DayProfile, LocalTime, MealReference, TimingType } from '@pillstack/contracts';
import { localTimeFromMinutes, minutesFromLocalTime } from './calendar.js';

export interface DoseTiming {
  timingType: TimingType;
  targetTime: LocalTime | null;
  windowStartTime: LocalTime | null;
  windowEndTime: LocalTime | null;
  mealReference: MealReference | null;
  mealOffsetMinutes: number;
}

export interface ResolvedDoseTime {
  time: LocalTime;
  /** True when the time came from a meal anchor rather than an explicit clock time. */
  derived: boolean;
}

export function mealTime(profile: DayProfile, reference: MealReference): LocalTime | null {
  switch (reference) {
    case 'breakfast':
      return profile.breakfastTime;
    case 'lunch':
      return profile.lunchTime;
    case 'dinner':
      return profile.dinnerTime;
    case 'wake_up':
      return profile.wakeUpTime;
    case 'bed_time':
      return profile.bedTime;
    default:
      return null;
  }
}

/**
 * Place a dose on the clock.
 *
 * Returns `null` for as-needed doses, which have no scheduled time, and for
 * meal-relative doses whose anchor meal is not configured in the day profile —
 * the caller surfaces that as a prompt to fill in the missing meal time rather
 * than silently guessing one.
 */
export function resolveDoseTime(
  timing: DoseTiming,
  profile: DayProfile,
): ResolvedDoseTime | null {
  switch (timing.timingType) {
    case 'fixed':
      return timing.targetTime ? { time: timing.targetTime, derived: false } : null;

    case 'window':
      return timing.windowStartTime
        ? { time: timing.windowStartTime, derived: false }
        : null;

    case 'meal_relative': {
      if (!timing.mealReference) return null;
      const anchor = mealTime(profile, timing.mealReference);
      if (!anchor) return null;
      const minutes = minutesFromLocalTime(anchor) + timing.mealOffsetMinutes;
      return { time: localTimeFromMinutes(minutes), derived: true };
    }

    case 'as_needed':
      return null;

    default:
      return null;
  }
}
