import type {
  ConstraintViolation,
  DayProfile,
  DoseFlexibility,
  IntakeConstraint,
  LocalTime,
  TimingType,
} from '@pillstack/contracts';
import {
  evaluateConstraints,
  type EvaluableIntake,
  type MealTimes,
} from '../constraints/evaluation.js';
import { minutesFromLocalTime } from './calendar.js';

/**
 * Tidying a day into fewer separate intake events.
 *
 * The goal from the brief is to minimise the number of times the user has to
 * stop and take something, while respecting every constraint they wrote. The
 * approach is deliberately a greedy merge rather than a search: it is
 * deterministic, it is explainable — every move can be justified in one
 * sentence — and it can only ever propose moving a dose *into an event that
 * already exists*, so it never invents a new time of day.
 *
 * Three properties it guarantees:
 *   - it never introduces a constraint violation that was not already there;
 *   - it never moves a dose the user pinned, or one defined relative to a meal;
 *   - it only proposes a move that actually removes an intake event.
 *
 * The result is a proposal. Nothing is written, and the plan is never touched:
 * accepting it records single-day schedule overrides.
 */

export interface OptimizableIntake extends EvaluableIntake {
  flexibility: DoseFlexibility;
  timingType: TimingType;
  windowStartTime: LocalTime | null;
  windowEndTime: LocalTime | null;
}

export interface ProposedMove {
  occurrenceKey: string;
  planDoseId: string;
  productName: string;
  from: LocalTime;
  to: LocalTime;
  /** One sentence the UI shows next to the move. */
  reason: string;
}

export interface OptimizationProposal {
  moves: ProposedMove[];
  eventsBefore: number;
  eventsAfter: number;
  /** Violations the day still has after the proposal; never more than before. */
  remainingViolations: ConstraintViolation[];
  /** Doses that could not be tidied, and why. */
  untouched: { productName: string; time: LocalTime; reason: string }[];
}

export interface OptimizeDayInput {
  intakes: readonly OptimizableIntake[];
  constraints: readonly IntakeConstraint[];
  dayProfile: DayProfile;
  /** How far a flexible dose may be shifted from where it sits now. */
  maximumShiftMinutes?: number;
}

const DEFAULT_MAXIMUM_SHIFT_MINUTES = 180;

export function optimizeDay(input: OptimizeDayInput): OptimizationProposal {
  const maximumShift = input.maximumShiftMinutes ?? DEFAULT_MAXIMUM_SHIFT_MINUTES;
  const mealTimes = toMealTimes(input.dayProfile);

  // The working arrangement, mutated as moves are accepted.
  const placement = new Map<string, LocalTime>(
    input.intakes.map((intake) => [intake.occurrenceKey, intake.scheduledTime]),
  );
  const eventsBefore = countEvents(placement);

  const untouched: OptimizationProposal['untouched'] = [];
  const movable: OptimizableIntake[] = [];

  for (const intake of input.intakes) {
    const reason = immovableReason(intake);
    if (reason) {
      untouched.push({ productName: intake.productName, time: intake.scheduledTime, reason });
    } else {
      movable.push(intake);
    }
  }

  // Sorted for determinism: the same day always yields the same proposal.
  movable.sort((left, right) => {
    const byTime =
      minutesFromLocalTime(left.scheduledTime) - minutesFromLocalTime(right.scheduledTime);
    return byTime !== 0 ? byTime : left.planDoseId.localeCompare(right.planDoseId);
  });

  const moves: ProposedMove[] = [];

  for (const intake of movable) {
    const currentTime = placement.get(intake.occurrenceKey) as LocalTime;

    // Merging only pays off when the dose is currently alone: moving one of two
    // doses out of an event does not remove the event.
    if (occupancyAt(placement, currentTime) > 1) {
      untouched.push({
        productName: intake.productName,
        time: currentTime,
        reason: 'already shares an intake with something else',
      });
      continue;
    }

    const target = bestMergeTarget(intake, currentTime, placement, {
      constraints: input.constraints,
      intakes: input.intakes,
      mealTimes,
      maximumShift,
    });

    if (!target) {
      untouched.push({
        productName: intake.productName,
        time: currentTime,
        reason: 'no other intake it can safely join',
      });
      continue;
    }

    placement.set(intake.occurrenceKey, target);
    moves.push({
      occurrenceKey: intake.occurrenceKey,
      planDoseId: intake.planDoseId,
      productName: intake.productName,
      from: currentTime,
      to: target,
      reason: `joins the ${target} intake, one fewer time to remember`,
    });
  }

  return {
    moves,
    eventsBefore,
    eventsAfter: countEvents(placement),
    remainingViolations: evaluateAt(placement, input.intakes, input.constraints, mealTimes),
    untouched,
  };
}

/** Why a dose cannot be moved, or `null` when it can. */
function immovableReason(intake: OptimizableIntake): string | null {
  if (intake.flexibility === 'fixed') return 'pinned to a fixed time';
  if (intake.timingType === 'meal_relative') return 'tied to a meal';
  if (intake.timingType === 'as_needed') return 'taken as needed';
  return null;
}

/**
 * The existing intake event this dose should join, or `null` if none is both
 * allowed and free of new violations.
 */
function bestMergeTarget(
  intake: OptimizableIntake,
  currentTime: LocalTime,
  placement: ReadonlyMap<string, LocalTime>,
  context: {
    constraints: readonly IntakeConstraint[];
    intakes: readonly OptimizableIntake[];
    mealTimes: MealTimes;
    maximumShift: number;
  },
): LocalTime | null {
  const baseline = bySignature(
    evaluateAt(placement, context.intakes, context.constraints, context.mealTimes),
  );

  const candidates = [...new Set(placement.values())]
    .filter((time) => time !== currentTime)
    .filter((time) => isAllowed(intake, currentTime, time, context.maximumShift))
    .sort((left, right) => {
      // Prefer the busiest event, then the smallest shift, then the earlier time.
      const byOccupancy = occupancyAt(placement, right) - occupancyAt(placement, left);
      if (byOccupancy !== 0) return byOccupancy;

      const leftShift = Math.abs(minutesFromLocalTime(left) - minutesFromLocalTime(currentTime));
      const rightShift = Math.abs(minutesFromLocalTime(right) - minutesFromLocalTime(currentTime));
      if (leftShift !== rightShift) return leftShift - rightShift;

      return minutesFromLocalTime(left) - minutesFromLocalTime(right);
    });

  for (const candidate of candidates) {
    const trial = new Map(placement);
    trial.set(intake.occurrenceKey, candidate);

    const trialViolations = evaluateAt(
      trial,
      context.intakes,
      context.constraints,
      context.mealTimes,
    );

    if (!makesAnythingWorse(baseline, trialViolations)) return candidate;
  }

  return null;
}

/**
 * Whether a trial arrangement breaks something new — or aggravates something
 * already broken.
 *
 * Comparing identity alone is not enough: pushing two substances that are
 * already too close together from 60 minutes apart to 0 keeps the same
 * violation on the books while plainly making the day worse, so the distance
 * has to be compared as well.
 */
function makesAnythingWorse(
  baseline: ReadonlyMap<string, ConstraintViolation>,
  trial: readonly ConstraintViolation[],
): boolean {
  for (const violation of trial) {
    const existing = baseline.get(signatureOf(violation));
    if (!existing) return true;

    if (
      violation.actualDistanceMinutes != null &&
      existing.actualDistanceMinutes != null &&
      violation.actualDistanceMinutes < existing.actualDistanceMinutes
    ) {
      return true;
    }
  }

  return false;
}

function isAllowed(
  intake: OptimizableIntake,
  currentTime: LocalTime,
  candidate: LocalTime,
  maximumShift: number,
): boolean {
  const candidateMinutes = minutesFromLocalTime(candidate);

  // A window dose may go anywhere inside its window, and nowhere outside it.
  if (intake.timingType === 'window' && intake.windowStartTime && intake.windowEndTime) {
    return (
      candidateMinutes >= minutesFromLocalTime(intake.windowStartTime) &&
      candidateMinutes <= minutesFromLocalTime(intake.windowEndTime)
    );
  }

  // Otherwise it may drift, but not so far that it stops resembling the plan.
  const shift = Math.abs(candidateMinutes - minutesFromLocalTime(currentTime));
  return shift <= maximumShift;
}

function evaluateAt(
  placement: ReadonlyMap<string, LocalTime>,
  intakes: readonly OptimizableIntake[],
  constraints: readonly IntakeConstraint[],
  mealTimes: MealTimes,
): ConstraintViolation[] {
  return evaluateConstraints({
    intakes: intakes.map((intake) => ({
      ...intake,
      scheduledTime: placement.get(intake.occurrenceKey) ?? intake.scheduledTime,
    })),
    constraints,
    mealTimes,
  });
}

/** Identifies a violation independently of the wording of its message. */
function signatureOf(violation: ConstraintViolation): string {
  return `${violation.constraintId}|${[...violation.occurrenceKeys].sort().join(',')}`;
}

function bySignature(
  violations: readonly ConstraintViolation[],
): Map<string, ConstraintViolation> {
  return new Map(violations.map((violation) => [signatureOf(violation), violation]));
}

function occupancyAt(placement: ReadonlyMap<string, LocalTime>, time: LocalTime): number {
  let total = 0;
  for (const placed of placement.values()) if (placed === time) total += 1;
  return total;
}

function countEvents(placement: ReadonlyMap<string, LocalTime>): number {
  return new Set(placement.values()).size;
}

export function toMealTimes(dayProfile: DayProfile): MealTimes {
  return {
    breakfast: dayProfile.breakfastTime,
    lunch: dayProfile.lunchTime,
    dinner: dayProfile.dinnerTime,
    wake_up: dayProfile.wakeUpTime,
    bed_time: dayProfile.bedTime,
  };
}
