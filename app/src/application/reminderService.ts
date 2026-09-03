import {
  reminderRuleInputSchema,
  type AppNotification,
  type LocalDate,
  type ReminderRule,
} from '@pillstack/contracts';
import {
  generateIntakeNotifications,
  generateStockNotifications,
  type PendingNotification,
} from '../domain/reminders/generation.js';
import { addDays, instantToLocalDate } from '../domain/schedules/calendar.js';
import type { NotificationDeliveryPort } from '../notifications/deliveryPort.js';
import { OutboxDeliveryPort } from '../notifications/deliveryPort.js';
import type { PillstackDatabase } from '../persistence/database.js';
import { ProductRepository } from '../persistence/repositories/productRepository.js';
import { ReminderRepository } from '../persistence/repositories/reminderRepository.js';
import { SettingsRepository } from '../persistence/repositories/settingsRepository.js';
import type { Clock } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { createId } from './ids.js';
import type { InventoryService } from './inventoryService.js';
import type { ScheduleService } from './scheduleService.js';

/** How far ahead intake reminders are generated. */
const INTAKE_HORIZON_DAYS = 2;

/**
 * Turns plans and stock levels into notifications, parks them in the outbox,
 * and hands them out.
 *
 * Generation is idempotent — every notification carries a `dedupeKey` that is
 * unique-indexed — so it simply runs whenever the client asks, with no cron job
 * and no background worker. Nothing is lost when the app is closed for a week.
 */
export class ReminderService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
    private readonly schedule: ScheduleService,
    private readonly inventory: InventoryService,
    private readonly delivery: NotificationDeliveryPort = new OutboxDeliveryPort(),
  ) {}

  // -- rules -----------------------------------------------------------------

  async listRules(): Promise<ReminderRule[]> {
    return new ReminderRepository(this.db).listRules();
  }

  async createRule(rawInput: unknown): Promise<ReminderRule> {
    const input = this.parseRule(rawInput);
    const id = createId();

    await new ReminderRepository(this.db).insertRule({
      id,
      ...this.toRuleRecord(input),
      now: this.clock.now().toISOString(),
    });

    return this.requireRule(id);
  }

  async updateRule(id: string, rawInput: unknown): Promise<ReminderRule> {
    const input = this.parseRule(rawInput);
    await this.requireRule(id);

    await new ReminderRepository(this.db).updateRule(id, {
      id,
      ...this.toRuleRecord(input),
      now: this.clock.now().toISOString(),
    });

    return this.requireRule(id);
  }

  async deleteRule(id: string): Promise<void> {
    await this.requireRule(id);
    await new ReminderRepository(this.db).deleteRule(id);
  }

  // -- notifications ---------------------------------------------------------

  /**
   * Regenerate the outbox from the current plans and stock, then return what is
   * due. Called by the client on a poll, so the notifications a user sees always
   * reflect the schedule as it stands right now.
   */
  async due(): Promise<AppNotification[]> {
    await this.refresh();
    const now = this.clock.now().toISOString();
    return new ReminderRepository(this.db).listDue(now);
  }

  async recent(): Promise<AppNotification[]> {
    return new ReminderRepository(this.db).listRecent();
  }

  /** Called back by the UI with the ids it actually displayed. */
  async markDelivered(ids: readonly string[]): Promise<void> {
    await new ReminderRepository(this.db).markDelivered(ids, this.clock.now().toISOString());
  }

  async dismiss(id: string): Promise<void> {
    await new ReminderRepository(this.db).dismiss(id, this.clock.now().toISOString());
  }

  /**
   * Rebuild the pending notifications. Safe to call as often as you like: the
   * dedupe key makes inserts idempotent, and notifications for occurrences that
   * no longer stand are discarded rather than left to fire wrongly.
   */
  async refresh(): Promise<{ created: number }> {
    const reminders = new ReminderRepository(this.db);
    const rules = await reminders.listRules();
    if (rules.length === 0) return { created: 0 };

    const now = this.clock.now();
    const nowIso = now.toISOString();
    const timeZone = await new SettingsRepository(this.db).getTimeZone();
    const today = instantToLocalDate(now, timeZone);

    const pending: PendingNotification[] = [];

    if (rules.some((rule) => rule.reminderType === 'intake')) {
      const intakes = [];
      for (let offset = 0; offset <= INTAKE_HORIZON_DAYS; offset += 1) {
        const timeline = await this.schedule.dayTimeline(addDays(today, offset));
        intakes.push(...timeline.slots.flatMap((slot) => slot.intakes));
      }

      const intakeNotifications = generateIntakeNotifications({
        intakes,
        rules,
        timeZone,
        now: nowIso,
      });
      pending.push(...intakeNotifications);

      // A dose that was taken, skipped or moved should stop nagging.
      await reminders.discardStale(
        new Set(intakeNotifications.map((notification) => notification.dedupeKey)),
        'intake:',
      );
    }

    if (rules.some((rule) => rule.reminderType !== 'intake')) {
      const statuses = await this.inventory.listStatuses();
      const products = await new ProductRepository(this.db).list({ active: true });
      const prescriptionRequired = new Set(
        products.filter((product) => product.prescriptionRequired).map((product) => product.id),
      );

      pending.push(
        ...generateStockNotifications({ statuses, rules, prescriptionRequired, today, timeZone }),
      );
    }

    const created = await reminders.upsertNotifications(pending, nowIso, createId);
    return { created };
  }

  /**
   * Hand due notifications to the configured channel. With the default outbox
   * channel this is a no-op and the UI does the presenting; a desktop build
   * registers a native port and the rest of the system is unchanged.
   */
  async deliverDue(): Promise<AppNotification[]> {
    const due = await this.due();
    const delivered: AppNotification[] = [];

    for (const notification of due) {
      if (await this.delivery.deliver(notification)) delivered.push(notification);
    }

    await this.markDelivered(delivered.map((notification) => notification.id));
    return delivered;
  }

  private async requireRule(id: string): Promise<ReminderRule> {
    const rule = await new ReminderRepository(this.db).findRule(id);
    if (!rule) throw new NotFoundError('reminder rule', id);
    return rule;
  }

  private parseRule(rawInput: unknown) {
    const parsed = reminderRuleInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid reminder rule', parsed.error.issues);
    return parsed.data;
  }

  private toRuleRecord(input: ReturnType<ReminderService['parseRule']>) {
    return {
      reminderType: input.reminderType,
      scopeKind: input.scopeKind,
      productId: input.productId ?? null,
      treatmentId: input.treatmentId ?? null,
      leadTimeMinutes: input.leadTimeMinutes ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      repeatAfterMinutes: input.repeatAfterMinutes ?? null,
      quietHoursFrom: input.quietHoursFrom ?? null,
      quietHoursTo: input.quietHoursTo ?? null,
      enabled: input.enabled,
    };
  }
}

export type { LocalDate };
