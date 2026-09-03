import {
  clearIntakeInputSchema,
  recordIntakeInputSchema,
  type IntakeLogEntry,
  type LocalDate,
} from '@pillstack/contracts';
import { instantToLocalDate, zonedTimeToInstant } from '../domain/schedules/calendar.js';
import type { PillstackDatabase } from '../persistence/database.js';
import { InventoryRepository } from '../persistence/repositories/inventoryRepository.js';
import { IntakeLogRepository } from '../persistence/repositories/intakeLogRepository.js';
import { SettingsRepository } from '../persistence/repositories/settingsRepository.js';
import type { Clock } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { createId } from './ids.js';

/**
 * Confirming an intake is optional throughout — the inventory projection falls
 * back to the plan for anything unconfirmed. What confirming does add is
 * precision: a `taken` entry writes an explicit `dose_consumed` row so the
 * ledger records what really happened, and a `skipped` entry stops that day's
 * dose from being counted against stock at all.
 */
export class IntakeLogService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
  ) {}

  async record(rawInput: unknown): Promise<IntakeLogEntry> {
    const parsed = recordIntakeInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid intake', parsed.error.issues);

    const input = parsed.data;
    const now = this.clock.now();
    const log = new IntakeLogRepository(this.db);
    const context = await log.findPlanDoseContext(input.planDoseId);
    if (!context) throw new NotFoundError('plan dose', input.planDoseId);

    const entryId = createId();
    const occurrenceDate = input.occurrenceDate as LocalDate;

    await this.db.transaction().execute(async (trx) => {
      const scopedLog = new IntakeLogRepository(trx);
      const inventory = new InventoryRepository(trx);

      // Re-recording the same occurrence replaces the previous answer rather
      // than stacking a second entry on top of it.
      const existing = await scopedLog.findByOccurrence(input.planDoseId, occurrenceDate);
      if (existing) {
        await inventory.deleteTransactionsForLogEntry(existing.id);
        await scopedLog.deleteByOccurrence(input.planDoseId, occurrenceDate);
      }

      await scopedLog.insert({
        id: entryId,
        productId: context.productId,
        treatmentId: context.treatmentId,
        intakePlanDoseId: input.planDoseId,
        occurrenceDate,
        scheduledAt: input.scheduledAt ?? null,
        actualAt: input.status === 'taken' ? (input.actualAt ?? now.toISOString()) : null,
        recordedAt: now.toISOString(),
        status: input.status,
        postponedTo: input.postponedTo ?? null,
        doseAmount: context.doseAmount,
        doseUnit: context.doseUnit,
        packageUnitQuantity: context.packageUnitQuantity,
        note: input.note ?? null,
      });

      if (input.status === 'taken' && context.packageUnitQuantity != null) {
        await inventory.insertTransaction({
          id: createId(),
          productId: context.productId,
          inventoryPackageId: null,
          transactionType: 'dose_consumed',
          quantityDelta: -context.packageUnitQuantity,
          absoluteQuantity: null,
          occurredAt: now.toISOString(),
          effectiveOn: occurrenceDate,
          intakeLogEntryId: entryId,
          treatmentId: context.treatmentId,
          note: null,
        });
      }
    });

    const saved = await log.findByOccurrence(input.planDoseId, occurrenceDate);
    if (!saved) throw new NotFoundError('intake log entry', entryId);
    return saved;
  }

  /** Undo a confirmation, removing its ledger row so the plan takes over again. */
  async clear(rawInput: unknown): Promise<void> {
    const parsed = clearIntakeInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid request', parsed.error.issues);

    const input = parsed.data;
    const occurrenceDate = input.occurrenceDate as LocalDate;

    await this.db.transaction().execute(async (trx) => {
      const log = new IntakeLogRepository(trx);
      const existing = await log.findByOccurrence(input.planDoseId, occurrenceDate);
      if (!existing) return;

      await new InventoryRepository(trx).deleteTransactionsForLogEntry(existing.id);
      await log.deleteByOccurrence(input.planDoseId, occurrenceDate);
    });
  }

  async listForProduct(productId: string): Promise<IntakeLogEntry[]> {
    return new IntakeLogRepository(this.db).listForProduct(productId);
  }

  async today(): Promise<LocalDate> {
    const timeZone = await new SettingsRepository(this.db).getTimeZone();
    return instantToLocalDate(this.clock.now(), timeZone);
  }

  /** Exposed for callers that want the scheduled instant of an occurrence. */
  scheduledInstant(date: LocalDate, time: string, timeZone: string): string {
    return zonedTimeToInstant(date, time, timeZone);
  }
}
