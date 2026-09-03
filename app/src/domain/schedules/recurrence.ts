import type { LocalDate, RecurrenceType } from '@pillstack/contracts';
import { differenceInDays, isDateWithin, isWeekdayInMask } from './calendar.js';

export interface RecurrencePattern {
  recurrenceType: RecurrenceType;
  intervalDays: number | null;
  anchorDate: LocalDate | null;
  weekdayMask: number | null;
}

export interface PlanEffectivePeriod {
  effectiveFrom: LocalDate;
  effectiveTo: LocalDate | null;
}

/**
 * Whether a recurrence pattern produces doses on `date`, ignoring the plan's
 * effective period and any pauses. `as_needed` never produces scheduled
 * occurrences — those doses exist, but the user decides when.
 */
export function recurrenceOccursOn(pattern: RecurrencePattern, date: LocalDate): boolean {
  switch (pattern.recurrenceType) {
    case 'daily':
      return true;

    case 'weekdays':
      return pattern.weekdayMask != null && isWeekdayInMask(date, pattern.weekdayMask);

    case 'every_n_days': {
      if (pattern.intervalDays == null || pattern.anchorDate == null) return false;
      if (pattern.intervalDays < 1) return false;
      const offset = differenceInDays(date, pattern.anchorDate);
      return offset >= 0 && offset % pattern.intervalDays === 0;
    }

    case 'as_needed':
      return false;

    default:
      return false;
  }
}

export function isPlanEffectiveOn(period: PlanEffectivePeriod, date: LocalDate): boolean {
  return isDateWithin(date, period.effectiveFrom, period.effectiveTo);
}

export interface PauseInterval {
  pausedFrom: LocalDate;
  /** Exclusive. `null` means the pause is still open. */
  resumedOn: LocalDate | null;
}

export function isPausedOn(pauses: readonly PauseInterval[], date: LocalDate): boolean {
  return pauses.some(
    (pause) => date >= pause.pausedFrom && (pause.resumedOn == null || date < pause.resumedOn),
  );
}

/**
 * The single question the timeline, the depletion projection and the reminder
 * generator all ask: does this plan produce doses on this day?
 */
export function planProducesDosesOn(
  pattern: RecurrencePattern,
  period: PlanEffectivePeriod,
  pauses: readonly PauseInterval[],
  date: LocalDate,
): boolean {
  return (
    isPlanEffectiveOn(period, date) &&
    !isPausedOn(pauses, date) &&
    recurrenceOccursOn(pattern, date)
  );
}
