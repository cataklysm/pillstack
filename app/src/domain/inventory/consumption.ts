import type { ConsumptionSource, IntakeStatus, LocalDate } from '@pillstack/contracts';
import {
  planProducesDosesOn,
  type PauseInterval,
  type PlanEffectivePeriod,
  type RecurrencePattern,
} from '../schedules/recurrence.js';

/**
 * How much of a product a given day consumes.
 *
 * Two different questions are answered here, and keeping them apart is what
 * makes the inventory numbers trustworthy:
 *
 *   plannedConsumptionOn   what the schedule says will be taken — used to
 *                          project forward into the future.
 *   inferredConsumptionOn  what to subtract when reconstructing the past.
 *                          Occurrences the user confirmed are already in the
 *                          ledger as `dose_consumed` rows, so only unconfirmed
 *                          ones are inferred. Confirmed skips count as zero.
 */

export interface ConsumptionDose {
  planDoseId: string;
  /** Units of `product.package_unit`. Null means this dose does not draw on stock. */
  packageUnitQuantity: number | null;
  recurrence: RecurrencePattern;
  effectivePeriod: PlanEffectivePeriod;
  pauses: readonly PauseInterval[];
}

export interface LoggedOccurrence {
  planDoseId: string;
  occurrenceDate: LocalDate;
  status: IntakeStatus;
}

export function occurrenceKey(planDoseId: string, occurrenceDate: LocalDate): string {
  return `${planDoseId}:${occurrenceDate}`;
}

export function loggedOccurrenceKeys(entries: readonly LoggedOccurrence[]): ReadonlySet<string> {
  return new Set(entries.map((entry) => occurrenceKey(entry.planDoseId, entry.occurrenceDate)));
}

/** What the plan alone says is taken on `date`, ignoring the intake log. */
export function plannedConsumptionOn(
  doses: readonly ConsumptionDose[],
  date: LocalDate,
): number {
  let total = 0;

  for (const dose of doses) {
    if (dose.packageUnitQuantity == null) continue;
    if (!planProducesDosesOn(dose.recurrence, dose.effectivePeriod, dose.pauses, date)) continue;
    total += dose.packageUnitQuantity;
  }

  return total;
}

export interface InferredConsumptionOptions {
  doses: readonly ConsumptionDose[];
  /** Keys of occurrences that already have an intake log entry. */
  loggedKeys: ReadonlySet<string>;
  consumptionSource: ConsumptionSource;
}

/**
 * What to subtract for `date` on top of the ledger.
 *
 * In `logged` mode nothing is inferred: only confirmed intakes move the stock.
 * That is the right behaviour for as-needed medication, where the plan says
 * nothing useful about how much is actually taken.
 */
export function inferredConsumptionOn(
  options: InferredConsumptionOptions,
  date: LocalDate,
): number {
  if (options.consumptionSource === 'logged') return 0;

  let total = 0;

  for (const dose of options.doses) {
    if (dose.packageUnitQuantity == null) continue;
    if (!planProducesDosesOn(dose.recurrence, dose.effectivePeriod, dose.pauses, date)) continue;
    // Confirmed occurrences are already represented in the ledger; inferring
    // them again would double-count.
    if (options.loggedKeys.has(occurrenceKey(dose.planDoseId, date))) continue;
    total += dose.packageUnitQuantity;
  }

  return total;
}
