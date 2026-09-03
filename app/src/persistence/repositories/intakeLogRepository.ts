import type { IntakeLogEntry, IntakeStatus, LocalDate } from '@pillstack/contracts';
import type { PillstackDatabase } from '../database.js';
import type { IntakeLogEntryTable } from '../schema.js';

/** Everything needed to record an intake, resolved from the plan dose. */
export interface PlanDoseContext {
  planDoseId: string;
  treatmentId: string;
  productId: string;
  doseAmount: number;
  doseUnit: string;
  packageUnitQuantity: number | null;
}

export class IntakeLogRepository {
  constructor(private readonly db: PillstackDatabase) {}

  async findPlanDoseContext(planDoseId: string): Promise<PlanDoseContext | null> {
    const row = await this.db
      .selectFrom('intake_plan_dose')
      .innerJoin('intake_plan', 'intake_plan.id', 'intake_plan_dose.intake_plan_id')
      .innerJoin('treatment', 'treatment.id', 'intake_plan.treatment_id')
      .select([
        'intake_plan_dose.id as dose_id',
        'intake_plan_dose.dose_amount as dose_amount',
        'intake_plan_dose.dose_unit as dose_unit',
        'intake_plan_dose.package_unit_quantity as package_unit_quantity',
        'treatment.id as treatment_id',
        'treatment.product_id as product_id',
      ])
      .where('intake_plan_dose.id', '=', planDoseId)
      .executeTakeFirst();

    if (!row) return null;

    return {
      planDoseId: row.dose_id,
      treatmentId: row.treatment_id,
      productId: row.product_id,
      doseAmount: row.dose_amount,
      doseUnit: row.dose_unit,
      packageUnitQuantity: row.package_unit_quantity,
    };
  }

  async findByOccurrence(
    planDoseId: string,
    occurrenceDate: LocalDate,
  ): Promise<IntakeLogEntry | null> {
    const row = await this.db
      .selectFrom('intake_log_entry')
      .selectAll()
      .where('intake_plan_dose_id', '=', planDoseId)
      .where('occurrence_date', '=', occurrenceDate)
      .where('is_ad_hoc', '=', 0)
      .executeTakeFirst();

    return row ? toEntry(row) : null;
  }

  async insert(record: {
    id: string;
    productId: string;
    treatmentId: string | null;
    intakePlanDoseId: string | null;
    occurrenceDate: LocalDate | null;
    scheduledAt: string | null;
    actualAt: string | null;
    recordedAt: string;
    status: IntakeStatus;
    postponedTo: string | null;
    doseAmount: number | null;
    doseUnit: string | null;
    packageUnitQuantity: number | null;
    note: string | null;
  }): Promise<void> {
    await this.db
      .insertInto('intake_log_entry')
      .values({
        id: record.id,
        product_id: record.productId,
        treatment_id: record.treatmentId,
        intake_plan_dose_id: record.intakePlanDoseId,
        is_ad_hoc: 0,
        occurrence_date: record.occurrenceDate,
        scheduled_at: record.scheduledAt,
        actual_at: record.actualAt,
        recorded_at: record.recordedAt,
        status: record.status,
        postponed_to: record.postponedTo,
        dose_amount: record.doseAmount,
        dose_unit: record.doseUnit,
        package_unit_quantity: record.packageUnitQuantity,
        note: record.note,
      })
      .execute();
  }

  async deleteByOccurrence(planDoseId: string, occurrenceDate: LocalDate): Promise<void> {
    await this.db
      .deleteFrom('intake_log_entry')
      .where('intake_plan_dose_id', '=', planDoseId)
      .where('occurrence_date', '=', occurrenceDate)
      .where('is_ad_hoc', '=', 0)
      .execute();
  }

  async listForProduct(productId: string, limit = 200): Promise<IntakeLogEntry[]> {
    const rows = await this.db
      .selectFrom('intake_log_entry')
      .selectAll()
      .where('product_id', '=', productId)
      .orderBy('occurrence_date', 'desc')
      .orderBy('recorded_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map(toEntry);
  }
}

function toEntry(row: IntakeLogEntryTable): IntakeLogEntry {
  return {
    id: row.id,
    productId: row.product_id,
    treatmentId: row.treatment_id,
    intakePlanDoseId: row.intake_plan_dose_id,
    occurrenceDate: row.occurrence_date,
    scheduledAt: row.scheduled_at,
    actualAt: row.actual_at,
    recordedAt: row.recorded_at,
    status: row.status,
    doseAmount: row.dose_amount,
    doseUnit: row.dose_unit,
    packageUnitQuantity: row.package_unit_quantity,
    note: row.note,
  };
}
