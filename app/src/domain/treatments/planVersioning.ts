import type { LocalDate, TreatmentEventType } from '@pillstack/contracts';
import { addDays } from '../schedules/calendar.js';
import { describePlan, type SummarizableDose, type SummarizablePlan } from './scheduleSummary.js';

/**
 * Rules for moving a treatment from one plan version to the next.
 *
 * A plan is never edited in place. The current version is closed the day before
 * the replacement takes effect, and a new version is inserted. These functions
 * decide what kind of change happened and produce the summary line that is
 * frozen onto the treatment event, so the history reads correctly years later
 * even if this rendering code changes.
 */

export type PlanChangeKind = Extract<TreatmentEventType, 'dose_changed' | 'schedule_changed'>;

export interface PlanTransition {
  kind: PlanChangeKind;
  summary: string;
  /** Last day the outgoing version applies to. */
  previousEffectiveTo: LocalDate;
}

export class PlanTransitionError extends Error {}

/**
 * `null` when the two plans are equivalent — the caller should then reject the
 * change rather than write a version that says nothing happened.
 */
export function classifyPlanChange(
  previous: SummarizablePlan,
  next: SummarizablePlan,
): PlanChangeKind | null {
  const timingChanged = timingSignature(previous) !== timingSignature(next);
  const doseChanged = doseSignature(previous) !== doseSignature(next);

  if (timingChanged) return 'schedule_changed';
  if (doseChanged) return 'dose_changed';
  return null;
}

export function planTransition(
  previous: SummarizablePlan,
  next: SummarizablePlan,
  options: { previousEffectiveFrom: LocalDate; nextEffectiveFrom: LocalDate },
): PlanTransition {
  if (options.nextEffectiveFrom <= options.previousEffectiveFrom) {
    throw new PlanTransitionError(
      `a new plan version must start after the current one (current starts ${options.previousEffectiveFrom}, new starts ${options.nextEffectiveFrom})`,
    );
  }

  const kind = classifyPlanChange(previous, next);
  if (kind === null) {
    throw new PlanTransitionError('the new plan is identical to the current one');
  }

  const verb = kind === 'dose_changed' ? 'Dose changed' : 'Schedule changed';
  return {
    kind,
    summary: `${verb}: ${describePlan(previous)} → ${describePlan(next)}`,
    previousEffectiveTo: addDays(options.nextEffectiveFrom, -1),
  };
}

export function startSummary(plan: SummarizablePlan): string {
  return `Started ${describePlan(plan)}`;
}

export function pauseSummary(reason: string | null | undefined): string {
  return reason ? `Paused: ${reason}` : 'Paused';
}

export function resumeSummary(plan: SummarizablePlan): string {
  return `Resumed ${describePlan(plan)}`;
}

export function stopSummary(
  plan: SummarizablePlan | null,
  reason: string | null | undefined,
): string {
  const what = plan ? `Stopped ${describePlan(plan)}` : 'Stopped';
  return reason ? `${what} — ${reason}` : what;
}

/** Everything that decides *when* doses happen. */
function timingSignature(plan: SummarizablePlan): string {
  const doses = plan.doses
    .map((dose) =>
      [
        dose.timingType,
        dose.targetTime ?? '',
        dose.windowStartTime ?? '',
        dose.windowEndTime ?? '',
        dose.mealReference ?? '',
        dose.mealOffsetMinutes,
      ].join('~'),
    )
    .sort()
    .join('|');

  return [
    plan.recurrenceType,
    plan.intervalDays ?? '',
    plan.weekdayMask ?? '',
    plan.maxDosesPerDay ?? '',
    doses,
  ].join('#');
}

/** Everything that decides *how much*. */
function doseSignature(plan: SummarizablePlan): string {
  return plan.doses
    .map((dose: SummarizableDose) => `${dose.doseAmount}~${dose.doseUnit}`)
    .sort()
    .join('|');
}
