import type { LocalDate, ReorderReason } from '@pillstack/contracts';
import { addDays, differenceInDays } from '../schedules/calendar.js';

/**
 * Turning the ledger into the four numbers the user actually asks for:
 * how much is left, how long it lasts, when it runs out, when to reorder.
 *
 * Everything here is a pure function of the ledger plus a consumption
 * function, so the result is fully re-derivable and never drifts. Nothing is
 * cached and no background job posts rows behind the user's back.
 */

export interface LedgerEntry {
  transactionType:
    | 'package_added'
    | 'dose_consumed'
    | 'manual_correction'
    | 'package_discarded'
    | 'treatment_paused'
    | 'other';
  quantityDelta: number;
  effectiveOn: LocalDate;
}

/** Guards against walking decades of history if a date is nonsense. */
const MAXIMUM_INFERENCE_DAYS = 3650;
const DEFAULT_PROJECTION_HORIZON_DAYS = 730;
const DAILY_AVERAGE_WINDOW_DAYS = 28;

/**
 * The first day whose consumption has to be inferred.
 *
 * A manual correction is the user telling us what is really in the drawer, so
 * it supersedes everything before it and inference restarts the day after.
 * Without a correction, inference starts when the first package arrived —
 * there is nothing to consume before that.
 *
 * Returns null when the ledger is empty, in which case there is nothing to
 * infer against.
 */
export function inferenceStartDate(ledger: readonly LedgerEntry[]): LocalDate | null {
  let latestCorrection: LocalDate | null = null;
  let firstPackage: LocalDate | null = null;

  for (const entry of ledger) {
    if (entry.transactionType === 'manual_correction') {
      if (latestCorrection === null || entry.effectiveOn > latestCorrection) {
        latestCorrection = entry.effectiveOn;
      }
    }
    if (entry.transactionType === 'package_added') {
      if (firstPackage === null || entry.effectiveOn < firstPackage) {
        firstPackage = entry.effectiveOn;
      }
    }
  }

  if (latestCorrection !== null) return addDays(latestCorrection, 1);
  return firstPackage;
}

/**
 * The delta to store for a manual correction.
 *
 * The invariant a correction has to establish is that the cumulative ledger
 * sum through that day *equals* what the user counted — that is what lets
 * inference restart cleanly the next day and never re-derive the days before.
 * So the delta cancels everything prior rather than being the difference from
 * the projected figure.
 *
 * The projected figure is still what the user is shown when correcting, and
 * `absolute_quantity` on the row records what they counted.
 */
export function correctionDelta(
  ledger: readonly LedgerEntry[],
  effectiveOn: LocalDate,
  countedQuantity: number,
): number {
  let priorSum = 0;
  for (const entry of ledger) {
    if (entry.effectiveOn <= effectiveOn) priorSum += entry.quantityDelta;
  }
  return round(countedQuantity - priorSum);
}

export interface CurrentQuantityInput {
  ledger: readonly LedgerEntry[];
  /** Stock is reported as at the *end* of this day. */
  asOf: LocalDate;
  inferredConsumptionOn: (date: LocalDate) => number;
}

export function currentQuantity(input: CurrentQuantityInput): number {
  let total = 0;
  for (const entry of input.ledger) {
    if (entry.effectiveOn <= input.asOf) total += entry.quantityDelta;
  }

  const start = inferenceStartDate(input.ledger);
  if (start === null || start > input.asOf) return round(total);

  const days = Math.min(differenceInDays(input.asOf, start), MAXIMUM_INFERENCE_DAYS);
  for (let offset = 0; offset <= days; offset += 1) {
    total -= input.inferredConsumptionOn(addDays(start, offset));
  }

  return round(total);
}

export interface DepletionInput {
  startQuantity: number;
  /** Projection begins the day after this, since `startQuantity` already includes it. */
  asOf: LocalDate;
  plannedConsumptionOn: (date: LocalDate) => number;
  reorderLeadTimeDays: number;
  reorderThresholdQuantity: number | null;
  reorderThresholdDays: number | null;
  horizonDays?: number;
}

export interface DepletionProjection {
  estimatedDailyConsumption: number;
  /** First day the full planned dose can no longer be taken. */
  runOutDate: LocalDate | null;
  daysOfCover: number | null;
  reorderDate: LocalDate | null;
  reorderReason: ReorderReason | null;
}

export function projectDepletion(input: DepletionInput): DepletionProjection {
  const horizon = input.horizonDays ?? DEFAULT_PROJECTION_HORIZON_DAYS;

  let remaining = input.startQuantity;
  let runOutDate: LocalDate | null = null;
  let thresholdQuantityDate: LocalDate | null = null;
  let consumptionWindowTotal = 0;

  // Stock already reflects everything up to and including `asOf`.
  if (input.reorderThresholdQuantity != null && remaining <= input.reorderThresholdQuantity) {
    thresholdQuantityDate = input.asOf;
  }

  for (let offset = 1; offset <= horizon; offset += 1) {
    const date = addDays(input.asOf, offset);
    const planned = input.plannedConsumptionOn(date);

    if (offset <= DAILY_AVERAGE_WINDOW_DAYS) consumptionWindowTotal += planned;

    if (planned <= 0) continue;

    if (remaining < planned) {
      runOutDate = date;
      break;
    }

    remaining = round(remaining - planned);

    if (
      thresholdQuantityDate === null &&
      input.reorderThresholdQuantity != null &&
      remaining <= input.reorderThresholdQuantity
    ) {
      thresholdQuantityDate = date;
    }
  }

  const estimatedDailyConsumption = round(consumptionWindowTotal / DAILY_AVERAGE_WINDOW_DAYS);
  const daysOfCover = runOutDate === null ? null : differenceInDays(runOutDate, input.asOf);

  const { reorderDate, reorderReason } = chooseReorderDate({
    runOutDate,
    thresholdQuantityDate,
    reorderLeadTimeDays: input.reorderLeadTimeDays,
    reorderThresholdDays: input.reorderThresholdDays,
  });

  return { estimatedDailyConsumption, runOutDate, daysOfCover, reorderDate, reorderReason };
}

/**
 * The earliest of the configured triggers wins, and the reason is reported
 * alongside so the date is explainable rather than magic.
 */
function chooseReorderDate(options: {
  runOutDate: LocalDate | null;
  thresholdQuantityDate: LocalDate | null;
  reorderLeadTimeDays: number;
  reorderThresholdDays: number | null;
}): { reorderDate: LocalDate | null; reorderReason: ReorderReason | null } {
  const candidates: { date: LocalDate; reason: ReorderReason }[] = [];

  if (options.runOutDate !== null) {
    candidates.push({
      date: addDays(options.runOutDate, -options.reorderLeadTimeDays),
      reason: 'lead_time',
    });

    if (options.reorderThresholdDays != null) {
      candidates.push({
        date: addDays(options.runOutDate, -options.reorderThresholdDays),
        reason: 'threshold_days',
      });
    }
  }

  if (options.thresholdQuantityDate !== null) {
    candidates.push({ date: options.thresholdQuantityDate, reason: 'threshold_quantity' });
  }

  if (candidates.length === 0) return { reorderDate: null, reorderReason: null };

  const earliest = candidates.reduce((best, candidate) =>
    candidate.date < best.date ? candidate : best,
  );

  return { reorderDate: earliest.date, reorderReason: earliest.reason };
}

/** Doses like 0.5 tablets accumulate binary float error; keep it presentable. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
