import type { MealReference, RecurrenceType } from '@pillstack/contracts';
import type { DoseTiming } from '../schedules/dayProfile.js';

/**
 * Renders a plan as the sentence a physician reads on the medication plan, and
 * the frozen `summary` stored on every treatment event.
 */

export interface SummarizableDose extends DoseTiming {
  doseAmount: number;
  doseUnit: string;
}

export interface SummarizablePlan {
  recurrenceType: RecurrenceType;
  intervalDays: number | null;
  weekdayMask: number | null;
  maxDosesPerDay: number | null;
  doses: readonly SummarizableDose[];
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const MEAL_NAMES: Record<MealReference, string> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  wake_up: 'wake-up',
  bed_time: 'bedtime',
};

export function formatDose(dose: SummarizableDose): string {
  const amount = formatNumber(dose.doseAmount);
  const unit = pluralizeUnit(dose.doseUnit, dose.doseAmount);
  return `${amount} ${unit}`;
}

export function describeRecurrence(plan: SummarizablePlan): string {
  switch (plan.recurrenceType) {
    case 'daily':
      return 'daily';
    case 'weekdays':
      return plan.weekdayMask == null ? 'on selected days' : `on ${describeWeekdays(plan.weekdayMask)}`;
    case 'every_n_days':
      if (plan.intervalDays == null) return 'at intervals';
      if (plan.intervalDays === 1) return 'daily';
      if (plan.intervalDays === 2) return 'every other day';
      return `every ${plan.intervalDays} days`;
    case 'as_needed':
      return 'as needed';
    default:
      return '';
  }
}

export function describeDoseTiming(timing: DoseTiming): string {
  switch (timing.timingType) {
    case 'fixed':
      return timing.targetTime ? `at ${timing.targetTime}` : '';
    case 'window':
      return timing.windowStartTime && timing.windowEndTime
        ? `between ${timing.windowStartTime} and ${timing.windowEndTime}`
        : '';
    case 'meal_relative': {
      if (!timing.mealReference) return '';
      const meal = MEAL_NAMES[timing.mealReference];
      const offset = timing.mealOffsetMinutes;
      if (offset === 0) {
        return timing.mealReference === 'wake_up' || timing.mealReference === 'bed_time'
          ? `at ${meal}`
          : `with ${meal}`;
      }
      const direction = offset < 0 ? 'before' : 'after';
      return `${formatDuration(Math.abs(offset))} ${direction} ${meal}`;
    }
    case 'as_needed':
      return '';
    default:
      return '';
  }
}

export function describePlan(plan: SummarizablePlan): string {
  const doses = [...plan.doses];
  if (doses.length === 0) return describeRecurrence(plan);

  const recurrence = describeRecurrence(plan);

  if (plan.recurrenceType === 'as_needed') {
    const dosePart = uniformDose(doses) ?? doses.map(formatDose).join(' + ');
    const cap =
      plan.maxDosesPerDay != null
        ? `, up to ${formatNumber(plan.maxDosesPerDay)} ${plan.maxDosesPerDay === 1 ? 'dose' : 'doses'} per day`
        : '';
    return `${dosePart} as needed${cap}`;
  }

  const sorted = doses.slice().sort(compareByTiming);
  const shared = uniformDose(sorted);

  if (shared) {
    // Several fixed times share one "at", so a twice-daily plan reads
    // "at 08:00 and 12:00" rather than "at 08:00 and at 12:00".
    const allFixed = sorted.every((dose) => dose.timingType === 'fixed' && dose.targetTime);
    const timing = allFixed
      ? `at ${joinList(sorted.map((dose) => dose.targetTime as string))}`
      : joinList(sorted.map(describeDoseTiming).filter(Boolean));

    return joinWords([shared, recurrence, timing]);
  }

  // Asymmetric doses (2 tablets morning, 1 tablet evening) are spelled out.
  const parts = sorted.map((dose) => joinWords([formatDose(dose), describeDoseTiming(dose)]));
  return joinWords([recurrence, joinList(parts)]);
}

function compareByTiming(left: SummarizableDose, right: SummarizableDose): number {
  const leftTime = left.targetTime ?? left.windowStartTime ?? '';
  const rightTime = right.targetTime ?? right.windowStartTime ?? '';
  if (leftTime && rightTime) return leftTime.localeCompare(rightTime);
  return 0;
}

/** The shared dose text when every dose is identical, otherwise `null`. */
function uniformDose(doses: readonly SummarizableDose[]): string | null {
  const first = doses[0];
  if (!first) return null;
  const allSame = doses.every(
    (dose) => dose.doseAmount === first.doseAmount && dose.doseUnit === first.doseUnit,
  );
  return allSame ? formatDose(first) : null;
}

export function describeWeekdays(weekdayMask: number): string {
  if (weekdayMask === 127) return 'every day';
  const names = WEEKDAY_NAMES.filter((_, index) => (weekdayMask & (1 << index)) !== 0);
  return joinList(names);
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  const rendered = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${rendered} ${hours === 1 ? 'hour' : 'hours'}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function pluralizeUnit(unit: string, amount: number): string {
  const countable = ['tablet', 'capsule', 'drop', 'dose', 'sachet', 'puff'];
  if (amount === 1 || !countable.includes(unit.toLowerCase())) return unit;
  return `${unit}s`;
}

function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function joinWords(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.length > 0)).join(' ');
}
