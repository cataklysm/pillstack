import {
  constraintInputSchema,
  type ConstraintViolation,
  type DayProfile,
  type DayTimeline,
  type IntakeConstraint,
  type LocalDate,
  type LocalTime,
  type ScheduledIntake,
} from '@pillstack/contracts';
import {
  acknowledgementKey,
  evaluateConstraints,
  type EvaluableIntake,
  type MealTimes,
} from '../domain/constraints/evaluation.js';
import type { PillstackDatabase } from '../persistence/database.js';
import { ConstraintRepository } from '../persistence/repositories/constraintRepository.js';
import type { Clock } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { createId } from './ids.js';

/**
 * Owns the user's rules and evaluates them against a day.
 *
 * No medical knowledge is built in: every rule here was entered by the user.
 * The `origin` column already distinguishes `user` from `catalog`, so a curated
 * interaction set can be layered in later without touching what the user wrote.
 */
export class ConstraintService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<IntakeConstraint[]> {
    return new ConstraintRepository(this.db).list();
  }

  async create(rawInput: unknown): Promise<IntakeConstraint> {
    const input = this.parse(rawInput);
    const id = createId();

    await new ConstraintRepository(this.db).insert({
      id,
      ...this.toRecord(input),
      now: this.clock.now().toISOString(),
    });

    return this.requireById(id);
  }

  async update(id: string, rawInput: unknown): Promise<IntakeConstraint> {
    const input = this.parse(rawInput);
    const constraints = new ConstraintRepository(this.db);
    await this.requireById(id);

    await constraints.replace(id, {
      id,
      ...this.toRecord(input),
      now: this.clock.now().toISOString(),
    });

    return this.requireById(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<IntakeConstraint> {
    const constraints = new ConstraintRepository(this.db);
    await this.requireById(id);
    await constraints.setEnabled(id, enabled, this.clock.now().toISOString());
    return this.requireById(id);
  }

  async delete(id: string): Promise<void> {
    await this.requireById(id);
    await new ConstraintRepository(this.db).delete(id);
  }

  /**
   * Evaluate a day's arrangement. `extraAcknowledged` lets a move preview ask
   * "what would break?" without first writing the override.
   */
  async evaluateDay(
    timeline: DayTimeline,
    dayProfile: DayProfile,
    options: { replace?: { planDoseId: string; time: LocalTime } } = {},
  ): Promise<ConstraintViolation[]> {
    const constraints = new ConstraintRepository(this.db);
    const [rules, substancesByProduct, acknowledged] = await Promise.all([
      constraints.list(),
      constraints.loadSubstancesByProduct(),
      this.loadAcknowledgements(timeline.date),
    ]);

    if (rules.length === 0) return [];

    const intakes = toEvaluable(timeline, substancesByProduct, options.replace);

    return evaluateConstraints({
      intakes,
      constraints: rules,
      mealTimes: toMealTimes(dayProfile),
      acknowledged,
    });
  }

  /**
   * The rules and the substance lookup, shared with the optimizer so both
   * reason about exactly the same inputs.
   */
  async evaluationInputs(): Promise<{
    constraints: IntakeConstraint[];
    substancesByProduct: Map<string, string[]>;
  }> {
    const repository = new ConstraintRepository(this.db);
    const [constraints, substancesByProduct] = await Promise.all([
      repository.list(),
      repository.loadSubstancesByProduct(),
    ]);
    return { constraints, substancesByProduct };
  }

  /** Acknowledgements recorded against overrides on this date. */
  private async loadAcknowledgements(date: LocalDate): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('schedule_override')
      .select(['intake_plan_dose_id', 'occurrence_date', 'acknowledged_constraints'])
      .where('occurrence_date', '=', date)
      .where('acknowledged_constraints', 'is not', null)
      .execute();

    const keys = new Set<string>();
    for (const row of rows) {
      if (!row.acknowledged_constraints) continue;
      let constraintIds: unknown;
      try {
        constraintIds = JSON.parse(row.acknowledged_constraints);
      } catch {
        continue;
      }
      if (!Array.isArray(constraintIds)) continue;

      const occurrenceKey = `${row.intake_plan_dose_id}:${row.occurrence_date}`;
      for (const constraintId of constraintIds) {
        if (typeof constraintId === 'string') keys.add(acknowledgementKey(occurrenceKey, constraintId));
      }
    }

    return keys;
  }

  /** Records which warnings the user chose to override for one occurrence. */
  async acknowledge(
    planDoseId: string,
    occurrenceDate: LocalDate,
    constraintIds: readonly string[],
  ): Promise<void> {
    if (constraintIds.length === 0) return;

    const existing = await this.db
      .selectFrom('schedule_override')
      .select(['id', 'acknowledged_constraints'])
      .where('intake_plan_dose_id', '=', planDoseId)
      .where('occurrence_date', '=', occurrenceDate)
      .executeTakeFirst();

    if (!existing) return;

    const previous = parseIdList(existing.acknowledged_constraints);
    const merged = [...new Set([...previous, ...constraintIds])];

    await this.db
      .updateTable('schedule_override')
      .set({ acknowledged_constraints: JSON.stringify(merged) })
      .where('id', '=', existing.id)
      .execute();
  }

  private async requireById(id: string): Promise<IntakeConstraint> {
    const constraint = await new ConstraintRepository(this.db).findById(id);
    if (!constraint) throw new NotFoundError('constraint', id);
    return constraint;
  }

  private parse(rawInput: unknown) {
    const parsed = constraintInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid constraint', parsed.error.issues);
    return parsed.data;
  }

  private toRecord(input: ReturnType<ConstraintService['parse']>) {
    return {
      constraintType: input.constraintType,
      severity: input.severity,
      source: input.source,
      target: input.target ?? null,
      minimumDistanceMinutes: input.minimumDistanceMinutes ?? null,
      foodOffsetMinutes: input.foodOffsetMinutes ?? null,
      preferredTimeFrom: input.preferredTimeFrom ?? null,
      preferredTimeTo: input.preferredTimeTo ?? null,
      explanation: input.explanation ?? null,
      enabled: input.enabled,
    };
  }
}

/**
 * Flattens a timeline into what the evaluator needs, optionally with one
 * occurrence relocated so a move can be checked before it is saved.
 */
export function toEvaluable(
  timeline: DayTimeline,
  substancesByProduct: ReadonlyMap<string, string[]>,
  replace?: { planDoseId: string; time: LocalTime },
): EvaluableIntake[] {
  const all: ScheduledIntake[] = timeline.slots.flatMap((slot) => slot.intakes);

  return all.map((intake) => ({
    occurrenceKey: intake.occurrenceKey,
    planDoseId: intake.planDoseId,
    productId: intake.productId,
    productName: intake.productName,
    category: intake.category,
    substanceIds: substancesByProduct.get(intake.productId) ?? [],
    occurrenceDate: intake.occurrenceDate,
    scheduledTime:
      replace && intake.planDoseId === replace.planDoseId ? replace.time : intake.scheduledTime,
  }));
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

function parseIdList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
