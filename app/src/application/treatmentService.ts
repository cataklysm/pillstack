import {
  changePlanInputSchema,
  pauseTreatmentInputSchema,
  resumeTreatmentInputSchema,
  startTreatmentInputSchema,
  stopTreatmentInputSchema,
  type IntakePlan,
  type ParsedPlanDefinition,
  type Treatment,
  type TreatmentHistory,
} from '@pillstack/contracts';
import {
  PlanTransitionError,
  pauseSummary,
  planTransition,
  resumeSummary,
  startSummary,
  stopSummary,
} from '../domain/treatments/planVersioning.js';
import type { SummarizablePlan } from '../domain/treatments/scheduleSummary.js';
import type { PillstackDatabase } from '../persistence/database.js';
import { InventoryRepository } from '../persistence/repositories/inventoryRepository.js';
import { ProductRepository } from '../persistence/repositories/productRepository.js';
import {
  TreatmentRepository,
  type InsertPlanDoseRecord,
  type TreatmentRecord,
} from '../persistence/repositories/treatmentRepository.js';
import type { Clock } from './clock.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { createId } from './ids.js';

/**
 * Owns every write that touches a treatment's schedule.
 *
 * The invariant this service exists to protect: a plan is never edited in
 * place. Changing a dose or a time closes the current version and inserts a new
 * one, together with an event whose summary is frozen at write time.
 */
export class TreatmentService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
  ) {}

  async start(rawInput: unknown): Promise<Treatment> {
    const parsed = startTreatmentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid treatment', parsed.error.issues);

    const input = parsed.data;
    const now = this.clock.now().toISOString();

    const product = await new ProductRepository(this.db).findById(input.productId);
    if (!product) throw new NotFoundError('product', input.productId);

    const treatmentId = createId();
    const planId = createId();

    await this.db.transaction().execute(async (trx) => {
      const treatments = new TreatmentRepository(trx);

      await treatments.insertTreatment({
        id: treatmentId,
        productId: input.productId,
        indication: input.indication ?? null,
        prescriber: input.prescriber ?? null,
        startedOn: input.startedOn,
        notes: input.notes ?? null,
        createdAt: now,
      });

      await this.writePlanVersion(treatments, {
        planId,
        treatmentId,
        version: 1,
        supersedesPlanId: null,
        effectiveFrom: input.startedOn,
        changeReason: null,
        plan: input.plan,
        now,
      });

      await treatments.insertEvent({
        id: createId(),
        treatmentId,
        eventType: 'started',
        occurredOn: input.startedOn,
        recordedAt: now,
        fromPlanId: null,
        toPlanId: planId,
        reason: null,
        note: null,
        summary: startSummary(toSummarizable(input.plan)),
      });
    });

    return this.findById(treatmentId);
  }

  /**
   * Supersede the current plan with a new version effective from a given date.
   * The outgoing version is closed the day before and becomes immutable.
   */
  async changePlan(treatmentId: string, rawInput: unknown): Promise<Treatment> {
    const parsed = changePlanInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid plan change', parsed.error.issues);

    const input = parsed.data;
    const now = this.clock.now().toISOString();

    const treatments = new TreatmentRepository(this.db);
    const treatment = await treatments.findTreatment(treatmentId);
    if (!treatment) throw new NotFoundError('treatment', treatmentId);
    if (treatment.status === 'stopped') {
      throw new ConflictError('a stopped treatment cannot be rescheduled; start a new one instead');
    }

    const currentPlan = await treatments.findCurrentPlan(treatmentId);
    if (!currentPlan) throw new ConflictError('this treatment has no current plan version');

    let transition;
    try {
      transition = planTransition(
        planToSummarizable(currentPlan),
        toSummarizable(input.plan),
        {
          previousEffectiveFrom: currentPlan.effectiveFrom,
          nextEffectiveFrom: input.effectiveFrom,
        },
      );
    } catch (error) {
      if (error instanceof PlanTransitionError) throw new ConflictError(error.message);
      throw error;
    }

    const newPlanId = createId();
    const nextVersion = await treatments.nextVersionNumber(treatmentId);

    await this.db.transaction().execute(async (trx) => {
      const scoped = new TreatmentRepository(trx);

      await scoped.closePlan(currentPlan.id, transition.previousEffectiveTo);

      await this.writePlanVersion(scoped, {
        planId: newPlanId,
        treatmentId,
        version: nextVersion,
        supersedesPlanId: currentPlan.id,
        effectiveFrom: input.effectiveFrom,
        changeReason: input.changeReason ?? null,
        plan: input.plan,
        now,
      });

      await scoped.insertEvent({
        id: createId(),
        treatmentId,
        eventType: transition.kind,
        occurredOn: input.effectiveFrom,
        recordedAt: now,
        fromPlanId: currentPlan.id,
        toPlanId: newPlanId,
        reason: input.changeReason ?? null,
        note: null,
        summary: transition.summary,
      });
    });

    return this.findById(treatmentId);
  }

  async pause(treatmentId: string, rawInput: unknown): Promise<Treatment> {
    const parsed = pauseTreatmentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid pause', parsed.error.issues);

    const input = parsed.data;
    const now = this.clock.now().toISOString();

    const treatments = new TreatmentRepository(this.db);
    const treatment = await treatments.findTreatment(treatmentId);
    if (!treatment) throw new NotFoundError('treatment', treatmentId);
    if (treatment.status !== 'active') {
      throw new ConflictError(`only an active treatment can be paused (it is ${treatment.status})`);
    }

    await this.db.transaction().execute(async (trx) => {
      const scoped = new TreatmentRepository(trx);

      await scoped.insertPause({
        id: createId(),
        treatmentId,
        pausedFrom: input.pausedFrom,
        reason: input.reason ?? null,
        createdAt: now,
      });
      await scoped.setStatus(treatmentId, 'paused', now);

      // A zero-delta annotation so the inventory ledger explains the gap in
      // consumption rather than leaving an unexplained flat stretch.
      await new InventoryRepository(trx).insertTransaction({
        id: createId(),
        productId: treatment.productId,
        inventoryPackageId: null,
        transactionType: 'treatment_paused',
        quantityDelta: 0,
        absoluteQuantity: null,
        occurredAt: now,
        effectiveOn: input.pausedFrom,
        intakeLogEntryId: null,
        treatmentId,
        note: input.reason ?? null,
      });

      await scoped.insertEvent({
        id: createId(),
        treatmentId,
        eventType: 'paused',
        occurredOn: input.pausedFrom,
        recordedAt: now,
        fromPlanId: null,
        toPlanId: null,
        reason: input.reason ?? null,
        note: null,
        summary: pauseSummary(input.reason),
      });
    });

    return this.findById(treatmentId);
  }

  async resume(treatmentId: string, rawInput: unknown): Promise<Treatment> {
    const parsed = resumeTreatmentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid resume', parsed.error.issues);

    const input = parsed.data;
    const now = this.clock.now().toISOString();

    const treatments = new TreatmentRepository(this.db);
    const treatment = await treatments.findTreatment(treatmentId);
    if (!treatment) throw new NotFoundError('treatment', treatmentId);
    if (treatment.status !== 'paused') {
      throw new ConflictError(`only a paused treatment can be resumed (it is ${treatment.status})`);
    }

    const currentPlan = await treatments.findCurrentPlan(treatmentId);

    await this.db.transaction().execute(async (trx) => {
      const scoped = new TreatmentRepository(trx);

      const closed = await scoped.closeOpenPause(treatmentId, input.resumedOn);
      if (!closed) throw new ConflictError('there is no open pause to resume from');

      await scoped.setStatus(treatmentId, 'active', now);
      await scoped.insertEvent({
        id: createId(),
        treatmentId,
        eventType: 'resumed',
        occurredOn: input.resumedOn,
        recordedAt: now,
        fromPlanId: null,
        toPlanId: currentPlan?.id ?? null,
        reason: null,
        note: null,
        summary: currentPlan ? resumeSummary(planToSummarizable(currentPlan)) : 'Resumed',
      });
    });

    return this.findById(treatmentId);
  }

  /**
   * Stopping closes the current plan on the end date, so the treatment stops
   * producing doses from the next day while every past day still resolves to
   * the plan that was in force then.
   */
  async stop(treatmentId: string, rawInput: unknown): Promise<Treatment> {
    const parsed = stopTreatmentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid stop', parsed.error.issues);

    const input = parsed.data;
    const now = this.clock.now().toISOString();

    const treatments = new TreatmentRepository(this.db);
    const treatment = await treatments.findTreatment(treatmentId);
    if (!treatment) throw new NotFoundError('treatment', treatmentId);
    if (treatment.status === 'stopped') throw new ConflictError('this treatment is already stopped');
    if (input.endedOn < treatment.startedOn) {
      throw new ConflictError('a treatment cannot end before it started');
    }

    const currentPlan = await treatments.findCurrentPlan(treatmentId);

    await this.db.transaction().execute(async (trx) => {
      const scoped = new TreatmentRepository(trx);

      if (currentPlan) {
        const effectiveTo =
          input.endedOn < currentPlan.effectiveFrom ? currentPlan.effectiveFrom : input.endedOn;
        await scoped.closePlan(currentPlan.id, effectiveTo);
      }

      await scoped.setStatus(treatmentId, 'stopped', now, {
        endedOn: input.endedOn,
        stopReason: input.stopReason ?? null,
      });

      await scoped.insertEvent({
        id: createId(),
        treatmentId,
        eventType: 'stopped',
        occurredOn: input.endedOn,
        recordedAt: now,
        fromPlanId: currentPlan?.id ?? null,
        toPlanId: null,
        reason: input.stopReason ?? null,
        note: null,
        summary: stopSummary(currentPlan ? planToSummarizable(currentPlan) : null, input.stopReason),
      });
    });

    return this.findById(treatmentId);
  }

  async findById(id: string): Promise<Treatment> {
    const treatments = new TreatmentRepository(this.db);
    const record = await treatments.findTreatment(id);
    if (!record) throw new NotFoundError('treatment', id);

    const currentPlan = await treatments.findCurrentPlan(id);
    return toTreatment(record, currentPlan);
  }

  async list(filter: { productId?: string; status?: TreatmentRecord['status'] }): Promise<Treatment[]> {
    const treatments = new TreatmentRepository(this.db);
    const records = await treatments.listTreatments(filter);

    return Promise.all(
      records.map(async (record) => toTreatment(record, await treatments.findCurrentPlan(record.id))),
    );
  }

  async history(id: string): Promise<TreatmentHistory> {
    const treatments = new TreatmentRepository(this.db);
    const record = await treatments.findTreatment(id);
    if (!record) throw new NotFoundError('treatment', id);

    const [currentPlan, events, planVersions] = await Promise.all([
      treatments.findCurrentPlan(id),
      treatments.listEvents(id),
      treatments.listPlanVersions(id),
    ]);

    return { treatment: toTreatment(record, currentPlan), events, planVersions };
  }

  /** The plan in force on a given date — the point-in-time history query. */
  async planOn(treatmentId: string, date: string): Promise<IntakePlan | null> {
    return new TreatmentRepository(this.db).findPlanOnDate(treatmentId, date);
  }

  private async writePlanVersion(
    treatments: TreatmentRepository,
    options: {
      planId: string;
      treatmentId: string;
      version: number;
      supersedesPlanId: string | null;
      effectiveFrom: string;
      changeReason: string | null;
      plan: ParsedPlanDefinition;
      now: string;
    },
  ): Promise<void> {
    const { plan } = options;

    await treatments.insertPlan({
      id: options.planId,
      treatmentId: options.treatmentId,
      version: options.version,
      supersedesPlanId: options.supersedesPlanId,
      effectiveFrom: options.effectiveFrom,
      recurrenceType: plan.recurrenceType,
      intervalDays: plan.intervalDays ?? null,
      anchorDate: plan.anchorDate ?? null,
      weekdayMask: plan.weekdayMask ?? null,
      maxDosesPerDay: plan.maxDosesPerDay ?? null,
      instructions: plan.instructions ?? null,
      changeReason: options.changeReason,
      createdAt: options.now,
    });

    const doses: InsertPlanDoseRecord[] = plan.doses.map((dose, index) => ({
      id: createId(),
      intakePlanId: options.planId,
      sortOrder: index,
      label: dose.label ?? null,
      timingType: dose.timingType,
      targetTime: dose.targetTime ?? null,
      windowStartTime: dose.windowStartTime ?? null,
      windowEndTime: dose.windowEndTime ?? null,
      mealReference: dose.mealReference ?? null,
      mealOffsetMinutes: dose.mealOffsetMinutes,
      flexibility: dose.flexibility,
      doseAmount: dose.doseAmount,
      doseUnit: dose.doseUnit,
      packageUnitQuantity: dose.packageUnitQuantity ?? null,
    }));

    await treatments.insertPlanDoses(doses);
  }
}

function toTreatment(record: TreatmentRecord, currentPlan: IntakePlan | null): Treatment {
  return {
    id: record.id,
    productId: record.productId,
    productName: record.productName,
    indication: record.indication,
    prescriber: record.prescriber,
    status: record.status,
    startedOn: record.startedOn,
    endedOn: record.endedOn,
    stopReason: record.stopReason,
    notes: record.notes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    currentPlan,
  };
}

function toSummarizable(plan: ParsedPlanDefinition): SummarizablePlan {
  return {
    recurrenceType: plan.recurrenceType,
    intervalDays: plan.intervalDays ?? null,
    weekdayMask: plan.weekdayMask ?? null,
    maxDosesPerDay: plan.maxDosesPerDay ?? null,
    doses: plan.doses.map((dose) => ({
      timingType: dose.timingType,
      targetTime: dose.targetTime ?? null,
      windowStartTime: dose.windowStartTime ?? null,
      windowEndTime: dose.windowEndTime ?? null,
      mealReference: dose.mealReference ?? null,
      mealOffsetMinutes: dose.mealOffsetMinutes,
      doseAmount: dose.doseAmount,
      doseUnit: dose.doseUnit,
    })),
  };
}

function planToSummarizable(plan: IntakePlan): SummarizablePlan {
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
