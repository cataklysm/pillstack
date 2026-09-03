import type {
  DayProfile,
  DayTimeline,
  IntakeStatus,
  LocalDate,
  LocalTime,
  ProductCategory,
  ScheduledIntake,
  TimelineSlot,
} from '@pillstack/contracts';
import { minutesFromLocalTime, zonedTimeToInstant } from './calendar.js';
import { resolveDoseTime, type DoseTiming } from './dayProfile.js';
import {
  planProducesDosesOn,
  type PauseInterval,
  type PlanEffectivePeriod,
  type RecurrencePattern,
} from './recurrence.js';

/**
 * Everything the timeline needs about one dose of one plan, flattened by the
 * repository so the builder itself stays a pure function over plain data.
 */
export interface TimelineCandidate {
  planDoseId: string;
  intakePlanId: string;
  treatmentId: string;
  productId: string;
  productName: string;
  category: ProductCategory;
  instructions: string | null;
  label: string | null;
  doseAmount: number;
  doseUnit: string;
  packageUnitQuantity: number | null;
  timing: DoseTiming;
  recurrence: RecurrencePattern;
  effectivePeriod: PlanEffectivePeriod;
  pauses: PauseInterval[];
}

export interface OccurrenceOverride {
  planDoseId: string;
  occurrenceDate: LocalDate;
  overrideType: 'moved' | 'skipped' | 'added';
  overriddenTime: LocalTime | null;
}

export interface OccurrenceLogEntry {
  planDoseId: string;
  occurrenceDate: LocalDate;
  status: IntakeStatus;
}

export interface BuildDayTimelineInput {
  date: LocalDate;
  timeZone: string;
  dayProfile: DayProfile;
  candidates: readonly TimelineCandidate[];
  overrides: readonly OccurrenceOverride[];
  logEntries: readonly OccurrenceLogEntry[];
}

export function occurrenceKeyFor(planDoseId: string, occurrenceDate: LocalDate): string {
  return `${planDoseId}:${occurrenceDate}`;
}

/**
 * Build the day's timeline.
 *
 * Pure and deterministic: the same inputs always produce the same slots, which
 * is what makes it testable without a database and reusable by the reminder
 * generator and the future schedule optimizer.
 */
export function buildDayTimeline(input: BuildDayTimelineInput): DayTimeline {
  const { date, timeZone, dayProfile } = input;

  const overrideByKey = new Map<string, OccurrenceOverride>();
  for (const override of input.overrides) {
    overrideByKey.set(occurrenceKeyFor(override.planDoseId, override.occurrenceDate), override);
  }

  const statusByKey = new Map<string, IntakeStatus>();
  for (const entry of input.logEntries) {
    statusByKey.set(occurrenceKeyFor(entry.planDoseId, entry.occurrenceDate), entry.status);
  }

  const scheduled: ScheduledIntake[] = [];
  const asNeeded: ScheduledIntake[] = [];

  for (const candidate of input.candidates) {
    const occurrenceKey = occurrenceKeyFor(candidate.planDoseId, date);
    const override = overrideByKey.get(occurrenceKey);

    const producedByPlan = planProducesDosesOn(
      candidate.recurrence,
      candidate.effectivePeriod,
      candidate.pauses,
      date,
    );

    const isAsNeeded =
      candidate.recurrence.recurrenceType === 'as_needed' ||
      candidate.timing.timingType === 'as_needed';

    if (isAsNeeded) {
      // As-needed doses are offered whenever the plan is in force, but they are
      // never placed on the clock — the user decides if and when to take one.
      const available =
        candidate.effectivePeriod.effectiveFrom <= date &&
        (candidate.effectivePeriod.effectiveTo == null ||
          date <= candidate.effectivePeriod.effectiveTo);
      if (available) {
        asNeeded.push(
          toScheduledIntake(candidate, date, timeZone, '00:00', false, false, statusByKey.get(occurrenceKey)),
        );
      }
      continue;
    }

    if (override?.overrideType === 'skipped') continue;

    const includedToday = producedByPlan || override?.overrideType === 'added';
    if (!includedToday) continue;

    const resolved = resolveDoseTime(candidate.timing, dayProfile);
    const moved = override?.overrideType === 'moved' && override.overriddenTime != null;
    const time = moved ? (override.overriddenTime as LocalTime) : resolved?.time;

    // A meal-relative dose whose anchor meal is not configured cannot be placed.
    if (!time) continue;

    scheduled.push(
      toScheduledIntake(
        candidate,
        date,
        timeZone,
        time,
        resolved?.derived === true && !moved,
        moved,
        statusByKey.get(occurrenceKey),
      ),
    );
  }

  return {
    date,
    timeZone,
    slots: groupIntoSlots(scheduled),
    // Constraint evaluation needs the user's rules, which are I/O; the
    // application layer fills this in after building the arrangement.
    violations: [],
    asNeeded: asNeeded.sort((left, right) => left.productName.localeCompare(right.productName)),
  };
}

function toScheduledIntake(
  candidate: TimelineCandidate,
  date: LocalDate,
  timeZone: string,
  time: LocalTime,
  timeIsDerived: boolean,
  movedByUser: boolean,
  status: IntakeStatus | undefined,
): ScheduledIntake {
  return {
    occurrenceKey: occurrenceKeyFor(candidate.planDoseId, date),
    planDoseId: candidate.planDoseId,
    intakePlanId: candidate.intakePlanId,
    treatmentId: candidate.treatmentId,
    productId: candidate.productId,
    productName: candidate.productName,
    category: candidate.category,
    occurrenceDate: date,
    scheduledTime: time,
    scheduledAt: zonedTimeToInstant(date, time, timeZone),
    timingType: candidate.timing.timingType,
    mealReference: candidate.timing.mealReference,
    windowStartTime: candidate.timing.windowStartTime,
    windowEndTime: candidate.timing.windowEndTime,
    doseAmount: candidate.doseAmount,
    doseUnit: candidate.doseUnit,
    packageUnitQuantity: candidate.packageUnitQuantity,
    label: candidate.label,
    instructions: candidate.instructions,
    timeIsDerived,
    movedByUser,
    status: status ?? 'pending',
  };
}

/** Doses landing on the same clock time share a slot, matching how people take them. */
function groupIntoSlots(intakes: readonly ScheduledIntake[]): TimelineSlot[] {
  const byTime = new Map<LocalTime, ScheduledIntake[]>();
  for (const intake of intakes) {
    const bucket = byTime.get(intake.scheduledTime);
    if (bucket) bucket.push(intake);
    else byTime.set(intake.scheduledTime, [intake]);
  }

  return [...byTime.entries()]
    .sort(([left], [right]) => minutesFromLocalTime(left) - minutesFromLocalTime(right))
    .map(([time, slotIntakes]) => ({
      time,
      intakes: slotIntakes.sort((left, right) => {
        if (left.category !== right.category) return left.category === 'medication' ? -1 : 1;
        return left.productName.localeCompare(right.productName);
      }),
    }));
}

/**
 * The next intake at or after `fromInstant`, scanning forward day by day.
 * `loadDay` is supplied by the caller so this stays free of I/O.
 */
export function findNextIntake(
  timelines: readonly DayTimeline[],
  fromInstant: string,
): ScheduledIntake | null {
  let best: ScheduledIntake | null = null;
  for (const timeline of timelines) {
    for (const slot of timeline.slots) {
      for (const intake of slot.intakes) {
        if (intake.status !== 'pending') continue;
        if (intake.scheduledAt < fromInstant) continue;
        if (best === null || intake.scheduledAt < best.scheduledAt) best = intake;
      }
    }
  }
  return best;
}
