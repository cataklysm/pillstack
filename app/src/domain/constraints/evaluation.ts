import type {
  ConstraintEndpoint,
  ConstraintViolation,
  IntakeConstraint,
  LocalDate,
  LocalTime,
  MealReference,
  ProductCategory,
} from '@pillstack/contracts';
import { minutesFromLocalTime } from '../schedules/calendar.js';

/**
 * Evaluating the user's own rules against one day's arrangement.
 *
 * Two things this deliberately does not do. It hard-codes no medical knowledge
 * whatsoever — every rule evaluated here was entered by the user, and the
 * `origin` column reserves room for a curated catalogue later. And it never
 * blocks: a violation is advisory, the user may keep the schedule and
 * acknowledge it.
 */

export interface EvaluableIntake {
  occurrenceKey: string;
  planDoseId: string;
  productId: string;
  productName: string;
  category: ProductCategory;
  /** Canonical substances in this product, so substance rules match. */
  substanceIds: readonly string[];
  occurrenceDate: LocalDate;
  scheduledTime: LocalTime;
}

export type MealTimes = Partial<Record<MealReference, LocalTime | null>>;

export interface EvaluateConstraintsInput {
  intakes: readonly EvaluableIntake[];
  constraints: readonly IntakeConstraint[];
  mealTimes: MealTimes;
  /** `<occurrenceKey>:<constraintId>` pairs the user already waved through. */
  acknowledged?: ReadonlySet<string>;
}

/** How close to a meal still counts as "with food" when no offset is given. */
const DEFAULT_WITH_FOOD_MINUTES = 30;
/** How far from a meal "without food" requires when no offset is given. */
const DEFAULT_WITHOUT_FOOD_MINUTES = 60;
const DEFAULT_BEFORE_AFTER_FOOD_MINUTES = 60;

const MEAL_LABELS: Record<MealReference, string> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  wake_up: 'wake-up',
  bed_time: 'bedtime',
};

const FOOD_MEALS: MealReference[] = ['breakfast', 'lunch', 'dinner'];

export function acknowledgementKey(occurrenceKey: string, constraintId: string): string {
  return `${occurrenceKey}:${constraintId}`;
}

export function evaluateConstraints(input: EvaluateConstraintsInput): ConstraintViolation[] {
  const acknowledged = input.acknowledged ?? new Set<string>();
  const violations: ConstraintViolation[] = [];

  for (const constraint of input.constraints) {
    if (!constraint.enabled) continue;

    switch (constraint.constraintType) {
      case 'minimum_separation':
      case 'avoid_together':
        violations.push(...evaluatePairwise(constraint, input));
        break;

      case 'with_food':
      case 'without_food':
      case 'before_food':
      case 'after_food':
        violations.push(...evaluateFood(constraint, input));
        break;

      case 'preferred_time_of_day':
        violations.push(...evaluatePreferredTime(constraint, input));
        break;
    }
  }

  return violations
    .filter(
      (violation) =>
        !violation.occurrenceKeys.every((key) =>
          acknowledged.has(acknowledgementKey(key, violation.constraintId)),
        ),
    )
    .sort(bySeverityThenMessage);
}

function evaluatePairwise(
  constraint: IntakeConstraint,
  input: EvaluateConstraintsInput,
): ConstraintViolation[] {
  if (!constraint.target) return [];

  const required =
    constraint.constraintType === 'avoid_together'
      ? (constraint.minimumDistanceMinutes ?? 1)
      : (constraint.minimumDistanceMinutes ?? 0);

  const violations: ConstraintViolation[] = [];
  const reported = new Set<string>();

  for (const left of input.intakes) {
    for (const right of input.intakes) {
      if (left.occurrenceKey === right.occurrenceKey) continue;
      if (!matches(left, constraint.source) || !matches(right, constraint.target)) continue;

      // A rule whose two sides both match both intakes would otherwise report
      // the same clash twice.
      const pairKey = [left.occurrenceKey, right.occurrenceKey].sort().join('|');
      if (reported.has(pairKey)) continue;

      const distance = Math.abs(
        minutesFromLocalTime(left.scheduledTime) - minutesFromLocalTime(right.scheduledTime),
      );
      if (distance >= required) continue;

      reported.add(pairKey);
      violations.push({
        constraintId: constraint.id,
        constraintType: constraint.constraintType,
        severity: constraint.severity,
        message:
          constraint.constraintType === 'avoid_together'
            ? `${left.productName} and ${right.productName} are both at ${left.scheduledTime}; they should not be taken together.`
            : `${left.productName} and ${right.productName} are ${formatMinutes(distance)} apart; ${formatMinutes(required)} is required.`,
        explanation: constraint.explanation,
        occurrenceKeys: [left.occurrenceKey, right.occurrenceKey],
        actualDistanceMinutes: distance,
        requiredDistanceMinutes: required,
      });
    }
  }

  return violations;
}

function evaluateFood(
  constraint: IntakeConstraint,
  input: EvaluateConstraintsInput,
): ConstraintViolation[] {
  const meals = mealsInScope(constraint.target, input.mealTimes);
  // With no meal times configured there is nothing to measure against, so the
  // rule stays silent rather than firing spuriously.
  if (meals.length === 0) return [];

  const violations: ConstraintViolation[] = [];

  for (const intake of input.intakes) {
    if (!matches(intake, constraint.source)) continue;

    const intakeMinutes = minutesFromLocalTime(intake.scheduledTime);
    const distances = meals.map((meal) => ({
      meal: meal.reference,
      signed: intakeMinutes - minutesFromLocalTime(meal.time),
    }));

    const closest = distances.reduce((best, candidate) =>
      Math.abs(candidate.signed) < Math.abs(best.signed) ? candidate : best,
    );
    const label = MEAL_LABELS[closest.meal];
    let message: string | null = null;

    switch (constraint.constraintType) {
      case 'with_food': {
        const tolerance = constraint.foodOffsetMinutes ?? DEFAULT_WITH_FOOD_MINUTES;
        if (Math.abs(closest.signed) > tolerance) {
          message = `${intake.productName} at ${intake.scheduledTime} is ${formatMinutes(Math.abs(closest.signed))} from ${label}; it should be taken with food.`;
        }
        break;
      }

      case 'without_food': {
        const clearance = constraint.foodOffsetMinutes ?? DEFAULT_WITHOUT_FOOD_MINUTES;
        if (Math.abs(closest.signed) < clearance) {
          message = `${intake.productName} at ${intake.scheduledTime} is only ${formatMinutes(Math.abs(closest.signed))} from ${label}; it should be taken on an empty stomach.`;
        }
        break;
      }

      case 'before_food': {
        const window = constraint.foodOffsetMinutes ?? DEFAULT_BEFORE_AFTER_FOOD_MINUTES;
        // Must land in [meal - window, meal).
        const beforeAny = distances.some((d) => d.signed < 0 && Math.abs(d.signed) <= window);
        if (!beforeAny) {
          message = `${intake.productName} at ${intake.scheduledTime} should be taken within ${formatMinutes(window)} before ${label}.`;
        }
        break;
      }

      case 'after_food': {
        const window = constraint.foodOffsetMinutes ?? DEFAULT_BEFORE_AFTER_FOOD_MINUTES;
        const afterAny = distances.some((d) => d.signed > 0 && d.signed <= window);
        if (!afterAny) {
          message = `${intake.productName} at ${intake.scheduledTime} should be taken within ${formatMinutes(window)} after ${label}.`;
        }
        break;
      }
    }

    if (message) {
      violations.push({
        constraintId: constraint.id,
        constraintType: constraint.constraintType,
        severity: constraint.severity,
        message,
        explanation: constraint.explanation,
        occurrenceKeys: [intake.occurrenceKey],
        actualDistanceMinutes: Math.abs(closest.signed),
        requiredDistanceMinutes: constraint.foodOffsetMinutes,
      });
    }
  }

  return violations;
}

function evaluatePreferredTime(
  constraint: IntakeConstraint,
  input: EvaluateConstraintsInput,
): ConstraintViolation[] {
  if (!constraint.preferredTimeFrom || !constraint.preferredTimeTo) return [];

  const from = minutesFromLocalTime(constraint.preferredTimeFrom);
  const to = minutesFromLocalTime(constraint.preferredTimeTo);
  const violations: ConstraintViolation[] = [];

  for (const intake of input.intakes) {
    if (!matches(intake, constraint.source)) continue;

    const minutes = minutesFromLocalTime(intake.scheduledTime);
    // A window like 22:00-06:00 wraps past midnight.
    const inside = from <= to ? minutes >= from && minutes <= to : minutes >= from || minutes <= to;
    if (inside) continue;

    violations.push({
      constraintId: constraint.id,
      constraintType: constraint.constraintType,
      severity: constraint.severity,
      message: `${intake.productName} is at ${intake.scheduledTime}; it is preferred between ${constraint.preferredTimeFrom} and ${constraint.preferredTimeTo}.`,
      explanation: constraint.explanation,
      occurrenceKeys: [intake.occurrenceKey],
      actualDistanceMinutes: null,
      requiredDistanceMinutes: null,
    });
  }

  return violations;
}

/** Whether an intake is covered by one side of a rule. */
export function matches(intake: EvaluableIntake, endpoint: ConstraintEndpoint): boolean {
  switch (endpoint.kind) {
    case 'product':
      return intake.productId === endpoint.productId;
    case 'substance':
      return intake.substanceIds.includes(endpoint.substanceId);
    case 'category':
      return intake.category === endpoint.category;
    case 'meal':
    case 'food':
      // Meals and foods are targets, never the thing being scheduled.
      return false;
    default:
      return false;
  }
}

function mealsInScope(
  target: ConstraintEndpoint | null,
  mealTimes: MealTimes,
): { reference: MealReference; time: LocalTime }[] {
  const references =
    target?.kind === 'meal' ? [target.meal] : FOOD_MEALS;

  return references.flatMap((reference) => {
    const time = mealTimes[reference];
    return time ? [{ reference, time }] : [];
  });
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  const rendered = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${rendered} ${hours === 1 ? 'hour' : 'hours'}`;
}

function bySeverityThenMessage(left: ConstraintViolation, right: ConstraintViolation): number {
  if (left.severity !== right.severity) return left.severity === 'warning' ? -1 : 1;
  return left.message.localeCompare(right.message);
}
