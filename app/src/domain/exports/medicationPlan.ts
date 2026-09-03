import type {
  ActiveIngredient,
  IntakePlan,
  LocalDate,
  MedicationPlan,
  MedicationPlanEntry,
  ProductCategory,
} from '@pillstack/contracts';
import { isDateWithin } from '../schedules/calendar.js';
import { describePlan, formatDose } from '../treatments/scheduleSummary.js';

/**
 * Builds the physician plan as plain data.
 *
 * Kept apart from PDF rendering on purpose: what goes on the page is decided
 * here and can be asserted in a test without generating a document, and the
 * same structure feeds a future print view or a different file format.
 */

export interface PlanSource {
  treatmentId: string;
  productId: string;
  productName: string;
  category: ProductCategory;
  ingredients: readonly ActiveIngredient[];
  startedOn: LocalDate;
  endedOn: LocalDate | null;
  indication: string | null;
  status: 'active' | 'paused' | 'stopped';
  /** The version in force on the report date, which may be a superseded one. */
  plan: IntakePlan | null;
}

export interface BuildMedicationPlanInput {
  sources: readonly PlanSource[];
  asOf: LocalDate;
  generatedAt: string;
  patientName?: string | null;
  dateOfBirth?: LocalDate | null;
  physicianNote?: string | null;
}

export function buildMedicationPlan(input: BuildMedicationPlanInput): MedicationPlan {
  const entries: { category: ProductCategory; entry: MedicationPlanEntry }[] = [];

  for (const source of input.sources) {
    // Only what the patient is actually taking on the report date belongs on a
    // medication plan; the history report covers everything else.
    if (source.status === 'stopped') continue;
    if (!source.plan) continue;
    if (!isDateWithin(input.asOf, source.plan.effectiveFrom, source.plan.effectiveTo)) continue;

    entries.push({
      category: source.category,
      entry: {
        productId: source.productId,
        productName: source.productName,
        activeIngredients: describeIngredients(source.ingredients),
        dose: describeDoses(source.plan),
        schedule: describePlan(toSummarizable(source.plan)),
        since: source.startedOn,
        indication: source.indication,
        note: buildNote(source),
      },
    });
  }

  const byName = (left: { entry: MedicationPlanEntry }, right: { entry: MedicationPlanEntry }) =>
    left.entry.productName.localeCompare(right.entry.productName);

  return {
    generatedAt: input.generatedAt,
    asOf: input.asOf,
    patientName: input.patientName ?? null,
    dateOfBirth: input.dateOfBirth ?? null,
    physicianNote: input.physicianNote ?? null,
    medications: entries
      .filter((row) => row.category === 'medication')
      .sort(byName)
      .map((row) => row.entry),
    supplements: entries
      .filter((row) => row.category === 'supplement')
      .sort(byName)
      .map((row) => row.entry),
  };
}

/** "Rosuvastatin 5 mg" or "Iron 20 mg, Vitamin C 20 mg". */
export function describeIngredients(ingredients: readonly ActiveIngredient[]): string {
  if (ingredients.length === 0) return '—';

  return ingredients
    .map((ingredient) => {
      const amount =
        ingredient.amount == null
          ? ''
          : ` ${formatNumber(ingredient.amount)}${ingredient.unit ? ` ${ingredient.unit}` : ''}`;
      return `${ingredient.substanceName}${amount}`;
    })
    .join(', ');
}

/** "5 mg", or "2 tablets + 1 tablet" when the doses differ across the day. */
export function describeDoses(plan: IntakePlan): string {
  const first = plan.doses[0];
  if (!first) return '—';

  const uniform = plan.doses.every(
    (dose) => dose.doseAmount === first.doseAmount && dose.doseUnit === first.doseUnit,
  );

  if (uniform) return formatDose(first);
  return plan.doses.map(formatDose).join(' + ');
}

function buildNote(source: PlanSource): string | null {
  const parts: string[] = [];
  if (source.status === 'paused') parts.push('currently paused');
  if (source.plan?.instructions) parts.push(source.plan.instructions);
  return parts.length > 0 ? parts.join(' — ') : null;
}

function toSummarizable(plan: IntakePlan) {
  return {
    recurrenceType: plan.recurrenceType,
    intervalDays: plan.intervalDays,
    weekdayMask: plan.weekdayMask,
    maxDosesPerDay: plan.maxDosesPerDay,
    doses: plan.doses.map((dose) => ({
      timingType: dose.timingType,
      targetTime: dose.targetTime,
      windowStartTime: dose.windowStartTime,
      windowEndTime: dose.windowEndTime,
      mealReference: dose.mealReference,
      mealOffsetMinutes: dose.mealOffsetMinutes,
      doseAmount: dose.doseAmount,
      doseUnit: dose.doseUnit,
    })),
  };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
