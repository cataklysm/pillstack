import type { LocalDate, LocalTime } from '@pillstack/contracts';
import type {
  OccurrenceLogEntry,
  OccurrenceOverride,
  TimelineCandidate,
} from '../../domain/schedules/timeline.js';
import type { PillstackDatabase } from '../database.js';

/**
 * Reads for the daily timeline.
 *
 * The repository flattens plans, doses, treatments, products and pauses into
 * plain `TimelineCandidate` records so the timeline builder itself stays a pure
 * function with no knowledge of SQL.
 */
export class ScheduleRepository {
  constructor(private readonly db: PillstackDatabase) {}

  /**
   * Every dose of every plan version in force across `[from, to]`.
   *
   * The date range matters: a plan version that ends mid-range and its
   * successor must both be returned, or the timeline would show a gap on the
   * changeover day.
   */
  async loadCandidates(from: LocalDate, to: LocalDate): Promise<TimelineCandidate[]> {
    const rows = await this.db
      .selectFrom('intake_plan_dose')
      .innerJoin('intake_plan', 'intake_plan.id', 'intake_plan_dose.intake_plan_id')
      .innerJoin('treatment', 'treatment.id', 'intake_plan.treatment_id')
      .innerJoin('product', 'product.id', 'treatment.product_id')
      .select([
        'intake_plan_dose.id as dose_id',
        'intake_plan_dose.label as dose_label',
        'intake_plan_dose.timing_type as timing_type',
        'intake_plan_dose.target_time as target_time',
        'intake_plan_dose.window_start_time as window_start_time',
        'intake_plan_dose.window_end_time as window_end_time',
        'intake_plan_dose.meal_reference as meal_reference',
        'intake_plan_dose.meal_offset_minutes as meal_offset_minutes',
        'intake_plan_dose.flexibility as flexibility',
        'intake_plan_dose.dose_amount as dose_amount',
        'intake_plan_dose.dose_unit as dose_unit',
        'intake_plan_dose.package_unit_quantity as package_unit_quantity',
        'intake_plan.id as plan_id',
        'intake_plan.effective_from as effective_from',
        'intake_plan.effective_to as effective_to',
        'intake_plan.recurrence_type as recurrence_type',
        'intake_plan.interval_days as interval_days',
        'intake_plan.anchor_date as anchor_date',
        'intake_plan.weekday_mask as weekday_mask',
        'intake_plan.instructions as instructions',
        'treatment.id as treatment_id',
        'product.id as product_id',
        'product.name as product_name',
        'product.category as category',
      ])
      // Overlap test: the plan's effective period intersects the requested range.
      //
      // Deliberately not filtered by treatment status. Stopping a treatment
      // closes its plan's effective period, which already excludes it from
      // future days — while a status filter would also erase it from past days
      // and make historical timelines lie.
      .where('intake_plan.effective_from', '<=', to)
      .where((eb) =>
        eb.or([eb('intake_plan.effective_to', 'is', null), eb('intake_plan.effective_to', '>=', from)]),
      )
      .execute();

    const treatmentIds = [...new Set(rows.map((row) => row.treatment_id))];
    const pauses = await this.loadPauses(treatmentIds);

    return rows.map((row) => ({
      planDoseId: row.dose_id,
      intakePlanId: row.plan_id,
      treatmentId: row.treatment_id,
      productId: row.product_id,
      productName: row.product_name,
      category: row.category,
      instructions: row.instructions,
      label: row.dose_label,
      doseAmount: row.dose_amount,
      doseUnit: row.dose_unit,
      packageUnitQuantity: row.package_unit_quantity,
      flexibility: row.flexibility,
      timing: {
        timingType: row.timing_type,
        targetTime: row.target_time as LocalTime | null,
        windowStartTime: row.window_start_time as LocalTime | null,
        windowEndTime: row.window_end_time as LocalTime | null,
        mealReference: row.meal_reference,
        mealOffsetMinutes: row.meal_offset_minutes,
      },
      recurrence: {
        recurrenceType: row.recurrence_type,
        intervalDays: row.interval_days,
        anchorDate: row.anchor_date as LocalDate | null,
        weekdayMask: row.weekday_mask,
      },
      effectivePeriod: {
        effectiveFrom: row.effective_from as LocalDate,
        effectiveTo: row.effective_to as LocalDate | null,
      },
      pauses: pauses.get(row.treatment_id) ?? [],
    }));
  }

  private async loadPauses(
    treatmentIds: readonly string[],
  ): Promise<Map<string, { pausedFrom: LocalDate; resumedOn: LocalDate | null }[]>> {
    const grouped = new Map<string, { pausedFrom: LocalDate; resumedOn: LocalDate | null }[]>();
    if (treatmentIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('treatment_pause')
      .select(['treatment_id', 'paused_from', 'resumed_on'])
      .where('treatment_id', 'in', treatmentIds)
      .execute();

    for (const row of rows) {
      const list = grouped.get(row.treatment_id) ?? [];
      list.push({
        pausedFrom: row.paused_from as LocalDate,
        resumedOn: row.resumed_on as LocalDate | null,
      });
      grouped.set(row.treatment_id, list);
    }

    return grouped;
  }

  async loadOverrides(from: LocalDate, to: LocalDate): Promise<OccurrenceOverride[]> {
    const rows = await this.db
      .selectFrom('schedule_override')
      .select(['intake_plan_dose_id', 'occurrence_date', 'override_type', 'overridden_time'])
      .where('occurrence_date', '>=', from)
      .where('occurrence_date', '<=', to)
      .execute();

    return rows.map((row) => ({
      planDoseId: row.intake_plan_dose_id,
      occurrenceDate: row.occurrence_date as LocalDate,
      overrideType: row.override_type,
      overriddenTime: row.overridden_time as LocalTime | null,
    }));
  }

  async loadLogEntries(from: LocalDate, to: LocalDate): Promise<OccurrenceLogEntry[]> {
    const rows = await this.db
      .selectFrom('intake_log_entry')
      .select(['intake_plan_dose_id', 'occurrence_date', 'status'])
      .where('intake_plan_dose_id', 'is not', null)
      .where('is_ad_hoc', '=', 0)
      .where('occurrence_date', '>=', from)
      .where('occurrence_date', '<=', to)
      .execute();

    return rows.flatMap((row) =>
      row.intake_plan_dose_id && row.occurrence_date
        ? [
            {
              planDoseId: row.intake_plan_dose_id,
              occurrenceDate: row.occurrence_date as LocalDate,
              status: row.status,
            },
          ]
        : [],
    );
  }

  async upsertOverride(record: {
    id: string;
    planDoseId: string;
    occurrenceDate: LocalDate;
    overrideType: 'moved' | 'skipped' | 'added';
    overriddenTime: LocalTime | null;
    reason: string | null;
    createdAt: string;
  }): Promise<void> {
    await this.db
      .insertInto('schedule_override')
      .values({
        id: record.id,
        intake_plan_dose_id: record.planDoseId,
        occurrence_date: record.occurrenceDate,
        override_type: record.overrideType,
        overridden_time: record.overriddenTime,
        acknowledged_constraints: null,
        reason: record.reason,
        created_at: record.createdAt,
      })
      .onConflict((oc) =>
        oc.columns(['intake_plan_dose_id', 'occurrence_date']).doUpdateSet({
          override_type: record.overrideType,
          overridden_time: record.overriddenTime,
          reason: record.reason,
        }),
      )
      .execute();
  }

  async deleteOverride(planDoseId: string, occurrenceDate: LocalDate): Promise<void> {
    await this.db
      .deleteFrom('schedule_override')
      .where('intake_plan_dose_id', '=', planDoseId)
      .where('occurrence_date', '=', occurrenceDate)
      .execute();
  }

  async planDoseExists(planDoseId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('intake_plan_dose')
      .select('id')
      .where('id', '=', planDoseId)
      .executeTakeFirst();

    return row !== undefined;
  }
}
