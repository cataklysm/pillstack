import type { IntakePlan, PlanDose, TreatmentEvent } from '@pillstack/contracts';
import { describePlan } from '../../domain/treatments/scheduleSummary.js';
import type { PillstackDatabase } from '../database.js';
import type {
  IntakePlanDoseTable,
  IntakePlanTable,
  TreatmentEventTable,
  TreatmentTable,
} from '../schema.js';

export interface TreatmentRecord {
  id: string;
  productId: string;
  productName: string;
  indication: string | null;
  prescriber: string | null;
  status: TreatmentTable['status'];
  startedOn: string;
  endedOn: string | null;
  stopReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertPlanRecord {
  id: string;
  treatmentId: string;
  version: number;
  supersedesPlanId: string | null;
  effectiveFrom: string;
  recurrenceType: IntakePlanTable['recurrence_type'];
  intervalDays: number | null;
  anchorDate: string | null;
  weekdayMask: number | null;
  maxDosesPerDay: number | null;
  instructions: string | null;
  changeReason: string | null;
  createdAt: string;
}

export interface InsertPlanDoseRecord {
  id: string;
  intakePlanId: string;
  sortOrder: number;
  label: string | null;
  timingType: IntakePlanDoseTable['timing_type'];
  targetTime: string | null;
  windowStartTime: string | null;
  windowEndTime: string | null;
  mealReference: IntakePlanDoseTable['meal_reference'];
  mealOffsetMinutes: number;
  flexibility: IntakePlanDoseTable['flexibility'];
  doseAmount: number;
  doseUnit: string;
  packageUnitQuantity: number | null;
}

export interface InsertEventRecord {
  id: string;
  treatmentId: string;
  eventType: TreatmentEventTable['event_type'];
  occurredOn: string;
  recordedAt: string;
  fromPlanId: string | null;
  toPlanId: string | null;
  reason: string | null;
  note: string | null;
  summary: string;
}

export interface PauseRecord {
  id: string;
  treatmentId: string;
  pausedFrom: string;
  resumedOn: string | null;
  reason: string | null;
}

export class TreatmentRepository {
  constructor(private readonly db: PillstackDatabase) {}

  async insertTreatment(record: {
    id: string;
    productId: string;
    indication: string | null;
    prescriber: string | null;
    startedOn: string;
    notes: string | null;
    createdAt: string;
  }): Promise<void> {
    await this.db
      .insertInto('treatment')
      .values({
        id: record.id,
        product_id: record.productId,
        indication: record.indication,
        prescriber: record.prescriber,
        status: 'active',
        started_on: record.startedOn,
        ended_on: null,
        stop_reason: null,
        notes: record.notes,
        created_at: record.createdAt,
        updated_at: record.createdAt,
      })
      .execute();
  }

  async findTreatment(id: string): Promise<TreatmentRecord | null> {
    const row = await this.db
      .selectFrom('treatment')
      .innerJoin('product', 'product.id', 'treatment.product_id')
      .select([
        'treatment.id as id',
        'treatment.product_id as product_id',
        'product.name as product_name',
        'treatment.indication as indication',
        'treatment.prescriber as prescriber',
        'treatment.status as status',
        'treatment.started_on as started_on',
        'treatment.ended_on as ended_on',
        'treatment.stop_reason as stop_reason',
        'treatment.notes as notes',
        'treatment.created_at as created_at',
        'treatment.updated_at as updated_at',
      ])
      .where('treatment.id', '=', id)
      .executeTakeFirst();

    return row ? toTreatmentRecord(row) : null;
  }

  async listTreatments(filter: {
    productId?: string;
    status?: TreatmentTable['status'];
  }): Promise<TreatmentRecord[]> {
    let builder = this.db
      .selectFrom('treatment')
      .innerJoin('product', 'product.id', 'treatment.product_id')
      .select([
        'treatment.id as id',
        'treatment.product_id as product_id',
        'product.name as product_name',
        'treatment.indication as indication',
        'treatment.prescriber as prescriber',
        'treatment.status as status',
        'treatment.started_on as started_on',
        'treatment.ended_on as ended_on',
        'treatment.stop_reason as stop_reason',
        'treatment.notes as notes',
        'treatment.created_at as created_at',
        'treatment.updated_at as updated_at',
      ]);

    if (filter.productId) builder = builder.where('treatment.product_id', '=', filter.productId);
    if (filter.status) builder = builder.where('treatment.status', '=', filter.status);

    const rows = await builder.orderBy('treatment.started_on', 'desc').execute();
    return rows.map(toTreatmentRecord);
  }

  async setStatus(
    id: string,
    status: TreatmentTable['status'],
    updatedAt: string,
    ending?: { endedOn: string; stopReason: string | null },
  ): Promise<void> {
    await this.db
      .updateTable('treatment')
      .set({
        status,
        updated_at: updatedAt,
        ...(ending ? { ended_on: ending.endedOn, stop_reason: ending.stopReason } : {}),
      })
      .where('id', '=', id)
      .execute();
  }

  // -- plan versions ---------------------------------------------------------

  async insertPlan(record: InsertPlanRecord): Promise<void> {
    await this.db
      .insertInto('intake_plan')
      .values({
        id: record.id,
        treatment_id: record.treatmentId,
        version: record.version,
        supersedes_plan_id: record.supersedesPlanId,
        effective_from: record.effectiveFrom,
        effective_to: null,
        recurrence_type: record.recurrenceType,
        interval_days: record.intervalDays,
        anchor_date: record.anchorDate,
        weekday_mask: record.weekdayMask,
        max_doses_per_day: record.maxDosesPerDay,
        instructions: record.instructions,
        change_reason: record.changeReason,
        created_at: record.createdAt,
      })
      .execute();
  }

  async insertPlanDoses(doses: readonly InsertPlanDoseRecord[]): Promise<void> {
    if (doses.length === 0) return;

    await this.db
      .insertInto('intake_plan_dose')
      .values(
        doses.map((dose) => ({
          id: dose.id,
          intake_plan_id: dose.intakePlanId,
          sort_order: dose.sortOrder,
          label: dose.label,
          timing_type: dose.timingType,
          target_time: dose.targetTime,
          window_start_time: dose.windowStartTime,
          window_end_time: dose.windowEndTime,
          meal_reference: dose.mealReference,
          meal_offset_minutes: dose.mealOffsetMinutes,
          flexibility: dose.flexibility,
          dose_amount: dose.doseAmount,
          dose_unit: dose.doseUnit,
          package_unit_quantity: dose.packageUnitQuantity,
        })),
      )
      .execute();
  }

  /**
   * Closes the open version. The database rejects any later attempt to modify
   * it, which is what keeps history from being rewritten.
   */
  async closePlan(planId: string, effectiveTo: string): Promise<void> {
    await this.db
      .updateTable('intake_plan')
      .set({ effective_to: effectiveTo })
      .where('id', '=', planId)
      .where('effective_to', 'is', null)
      .execute();
  }

  async findCurrentPlan(treatmentId: string): Promise<IntakePlan | null> {
    const row = await this.db
      .selectFrom('intake_plan')
      .selectAll()
      .where('treatment_id', '=', treatmentId)
      .where('effective_to', 'is', null)
      .executeTakeFirst();

    if (!row) return null;
    const doses = await this.loadDoses([row.id]);
    return toIntakePlan(row, doses.get(row.id) ?? []);
  }

  /** The plan version in force on a given date, which may be a closed one. */
  async findPlanOnDate(treatmentId: string, date: string): Promise<IntakePlan | null> {
    const row = await this.db
      .selectFrom('intake_plan')
      .selectAll()
      .where('treatment_id', '=', treatmentId)
      .where('effective_from', '<=', date)
      .where((eb) =>
        eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', date)]),
      )
      .executeTakeFirst();

    if (!row) return null;
    const doses = await this.loadDoses([row.id]);
    return toIntakePlan(row, doses.get(row.id) ?? []);
  }

  async listPlanVersions(treatmentId: string): Promise<IntakePlan[]> {
    const rows = await this.db
      .selectFrom('intake_plan')
      .selectAll()
      .where('treatment_id', '=', treatmentId)
      .orderBy('version', 'asc')
      .execute();

    const doses = await this.loadDoses(rows.map((row) => row.id));
    return rows.map((row) => toIntakePlan(row, doses.get(row.id) ?? []));
  }

  async nextVersionNumber(treatmentId: string): Promise<number> {
    const row = await this.db
      .selectFrom('intake_plan')
      .select((eb) => eb.fn.max('version').as('highest'))
      .where('treatment_id', '=', treatmentId)
      .executeTakeFirst();

    return (row?.highest ?? 0) + 1;
  }

  private async loadDoses(planIds: readonly string[]): Promise<Map<string, PlanDose[]>> {
    const grouped = new Map<string, PlanDose[]>();
    if (planIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('intake_plan_dose')
      .selectAll()
      .where('intake_plan_id', 'in', planIds)
      .orderBy('sort_order', 'asc')
      .execute();

    for (const row of rows) {
      const list = grouped.get(row.intake_plan_id) ?? [];
      list.push(toPlanDose(row));
      grouped.set(row.intake_plan_id, list);
    }

    return grouped;
  }

  // -- history ---------------------------------------------------------------

  async insertEvent(record: InsertEventRecord): Promise<void> {
    await this.db
      .insertInto('treatment_event')
      .values({
        id: record.id,
        treatment_id: record.treatmentId,
        event_type: record.eventType,
        occurred_on: record.occurredOn,
        recorded_at: record.recordedAt,
        from_plan_id: record.fromPlanId,
        to_plan_id: record.toPlanId,
        reason: record.reason,
        note: record.note,
        summary: record.summary,
      })
      .execute();
  }

  async listEvents(treatmentId: string): Promise<TreatmentEvent[]> {
    const rows = await this.db
      .selectFrom('treatment_event')
      .selectAll()
      .where('treatment_id', '=', treatmentId)
      .orderBy('occurred_on', 'asc')
      .orderBy('recorded_at', 'asc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      treatmentId: row.treatment_id,
      eventType: row.event_type,
      occurredOn: row.occurred_on,
      recordedAt: row.recorded_at,
      fromPlanId: row.from_plan_id,
      toPlanId: row.to_plan_id,
      reason: row.reason,
      note: row.note,
      summary: row.summary,
    }));
  }

  // -- pauses ----------------------------------------------------------------

  async insertPause(record: {
    id: string;
    treatmentId: string;
    pausedFrom: string;
    reason: string | null;
    createdAt: string;
  }): Promise<void> {
    await this.db
      .insertInto('treatment_pause')
      .values({
        id: record.id,
        treatment_id: record.treatmentId,
        paused_from: record.pausedFrom,
        resumed_on: null,
        reason: record.reason,
        created_at: record.createdAt,
      })
      .execute();
  }

  async closeOpenPause(treatmentId: string, resumedOn: string): Promise<boolean> {
    const result = await this.db
      .updateTable('treatment_pause')
      .set({ resumed_on: resumedOn })
      .where('treatment_id', '=', treatmentId)
      .where('resumed_on', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows) > 0;
  }

  async listPauses(treatmentIds: readonly string[]): Promise<Map<string, PauseRecord[]>> {
    const grouped = new Map<string, PauseRecord[]>();
    if (treatmentIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('treatment_pause')
      .selectAll()
      .where('treatment_id', 'in', treatmentIds)
      .execute();

    for (const row of rows) {
      const list = grouped.get(row.treatment_id) ?? [];
      list.push({
        id: row.id,
        treatmentId: row.treatment_id,
        pausedFrom: row.paused_from,
        resumedOn: row.resumed_on,
        reason: row.reason,
      });
      grouped.set(row.treatment_id, list);
    }

    return grouped;
  }
}

function toTreatmentRecord(row: {
  id: string;
  product_id: string;
  product_name: string;
  indication: string | null;
  prescriber: string | null;
  status: TreatmentTable['status'];
  started_on: string;
  ended_on: string | null;
  stop_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}): TreatmentRecord {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    indication: row.indication,
    prescriber: row.prescriber,
    status: row.status,
    startedOn: row.started_on,
    endedOn: row.ended_on,
    stopReason: row.stop_reason,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPlanDose(row: IntakePlanDoseTable): PlanDose {
  return {
    id: row.id,
    intakePlanId: row.intake_plan_id,
    sortOrder: row.sort_order,
    label: row.label,
    timingType: row.timing_type,
    targetTime: row.target_time,
    windowStartTime: row.window_start_time,
    windowEndTime: row.window_end_time,
    mealReference: row.meal_reference,
    mealOffsetMinutes: row.meal_offset_minutes,
    flexibility: row.flexibility,
    doseAmount: row.dose_amount,
    doseUnit: row.dose_unit,
    packageUnitQuantity: row.package_unit_quantity,
  };
}

export function toIntakePlan(row: IntakePlanTable, doses: PlanDose[]): IntakePlan {
  return {
    id: row.id,
    treatmentId: row.treatment_id,
    version: row.version,
    supersedesPlanId: row.supersedes_plan_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    recurrenceType: row.recurrence_type,
    intervalDays: row.interval_days,
    anchorDate: row.anchor_date,
    weekdayMask: row.weekday_mask,
    maxDosesPerDay: row.max_doses_per_day,
    instructions: row.instructions,
    changeReason: row.change_reason,
    createdAt: row.created_at,
    doses,
    summary: describePlan({
      recurrenceType: row.recurrence_type,
      intervalDays: row.interval_days,
      weekdayMask: row.weekday_mask,
      maxDosesPerDay: row.max_doses_per_day,
      doses: doses.map((dose) => ({
        timingType: dose.timingType,
        targetTime: dose.targetTime,
        windowStartTime: dose.windowStartTime,
        windowEndTime: dose.windowEndTime,
        mealReference: dose.mealReference,
        mealOffsetMinutes: dose.mealOffsetMinutes,
        doseAmount: dose.doseAmount,
        doseUnit: dose.doseUnit,
      })),
    }),
  };
}
