import type {
  InventoryStatus,
  LocalDate,
  LocalTime,
  NotificationType,
  ReminderRule,
  ReminderType,
  ScheduledIntake,
} from '@pillstack/contracts';
import {
  addDays,
  differenceInDays,
  instantToLocalDate,
  instantToLocalTime,
  minutesFromLocalTime,
  zonedTimeToInstant,
} from '../schedules/calendar.js';

/**
 * Deciding *what* should be announced and *when*.
 *
 * This module knows nothing about how a notification reaches a human. It emits
 * plain records that the application layer writes to an outbox; a delivery
 * adapter drains that outbox. Swapping browser notifications for native
 * desktop ones later touches the adapter and nothing here.
 *
 * Every record carries a `dedupeKey`, which is unique-indexed in the database,
 * so generation can be re-run as often as you like without producing
 * duplicates.
 */

export interface PendingNotification {
  dedupeKey: string;
  notificationType: NotificationType;
  reminderRuleId: string | null;
  dueAt: string;
  title: string;
  body: string;
  payload: unknown;
}

/** Reorder and prescription reminders land at this local time on their day. */
const STOCK_REMINDER_TIME: LocalTime = '09:00';
const DEFAULT_INTAKE_LEAD_MINUTES = 0;
/** How long an unconfirmed dose keeps reminding after its time has passed. */
const MISSED_DOSE_GRACE_MINUTES = 240;
const DEFAULT_STOCK_LEAD_DAYS = 14;

/**
 * The rule that applies to a given intake or product: the most specific one
 * wins, so a rule for one treatment overrides a product rule, which overrides
 * the global default.
 */
export function selectRule(
  rules: readonly ReminderRule[],
  criteria: { reminderType: ReminderType; productId?: string | null; treatmentId?: string | null },
): ReminderRule | null {
  const applicable = rules.filter((rule) => {
    if (!rule.enabled || rule.reminderType !== criteria.reminderType) return false;
    if (rule.scopeKind === 'treatment') return rule.treatmentId === criteria.treatmentId;
    if (rule.scopeKind === 'product') return rule.productId === criteria.productId;
    return true;
  });

  const rank = { treatment: 0, product: 1, global: 2 } as const;
  return (
    applicable.sort((left, right) => rank[left.scopeKind] - rank[right.scopeKind])[0] ?? null
  );
}

export interface IntakeNotificationInput {
  intakes: readonly ScheduledIntake[];
  rules: readonly ReminderRule[];
  timeZone: string;
  /** Used to drop occurrences whose time is long past. */
  now: string;
}

export function generateIntakeNotifications(
  input: IntakeNotificationInput,
): PendingNotification[] {
  const notifications: PendingNotification[] = [];

  for (const intake of input.intakes) {
    // Already taken, skipped or postponed: nothing to remind about.
    if (intake.status !== 'pending') continue;

    const rule = selectRule(input.rules, {
      reminderType: 'intake',
      productId: intake.productId,
      treatmentId: intake.treatmentId,
    });
    if (!rule) continue;

    const leadMinutes = rule.leadTimeMinutes ?? DEFAULT_INTAKE_LEAD_MINUTES;
    const rawDueAt = new Date(new Date(intake.scheduledAt).getTime() - leadMinutes * 60_000);
    const dueAt = applyQuietHours(rawDueAt.toISOString(), rule, input.timeZone);

    // A reminder whose moment has just passed is exactly the one worth showing:
    // opening the app at 22:00 should surface the unconfirmed 21:30 dose. Only
    // long-past occurrences are dropped, so a user who never confirms intakes
    // does not accumulate a pile of stale reminders.
    const missedBy = Date.parse(input.now) - Date.parse(intake.scheduledAt);
    if (missedBy > MISSED_DOSE_GRACE_MINUTES * 60_000) continue;

    notifications.push({
      dedupeKey: `intake:${intake.planDoseId}:${intake.occurrenceDate}`,
      notificationType: 'intake',
      reminderRuleId: rule.id,
      dueAt,
      title: `${intake.scheduledTime} · ${intake.productName}`,
      body: `${formatAmount(intake.doseAmount)} ${intake.doseUnit}`,
      payload: {
        planDoseId: intake.planDoseId,
        occurrenceDate: intake.occurrenceDate,
        productId: intake.productId,
      },
    });
  }

  return notifications;
}

export interface StockNotificationInput {
  statuses: readonly InventoryStatus[];
  rules: readonly ReminderRule[];
  /** Products needing a prescription get the prescription wording instead. */
  prescriptionRequired: ReadonlySet<string>;
  today: LocalDate;
  timeZone: string;
}

export function generateStockNotifications(
  input: StockNotificationInput,
): PendingNotification[] {
  const notifications: PendingNotification[] = [];

  for (const status of input.statuses) {
    if (!status.policy.trackingEnabled) continue;
    // No package or count was ever recorded, so there is nothing to run out of
    // and nothing worth nagging about.
    if (!status.stockRecorded) continue;
    if (status.reorderDate === null || status.runOutDate === null) continue;

    const needsPrescription = input.prescriptionRequired.has(status.productId);
    const reminderType: ReminderType = needsPrescription ? 'prescription' : 'reorder';

    const rule = selectRule(input.rules, { reminderType, productId: status.productId });
    if (!rule) continue;

    // The inventory policy says *when to order*; the reminder rule says how
    // many days ahead of that to start mentioning it. Before that window opens
    // there is nothing to say.
    const leadDays = rule.leadTimeDays ?? DEFAULT_STOCK_LEAD_DAYS;
    const remindFrom = addDays(status.reorderDate, -leadDays);
    if (input.today < remindFrom) continue;

    const daysLeft = differenceInDays(status.runOutDate, input.today);
    // Inside the window, the reminder belongs to today rather than to a date
    // that has already gone by.
    const dueDate = input.today;
    const dueAt = applyQuietHours(
      zonedTimeToInstant(dueDate, STOCK_REMINDER_TIME, input.timeZone),
      rule,
      input.timeZone,
    );

    const notificationType: NotificationType = needsPrescription ? 'prescription' : 'reorder';

    notifications.push({
      // Keyed by the run-out date so a changed projection announces afresh
      // rather than being silenced by the earlier key.
      dedupeKey: `${notificationType}:${status.productId}:${status.runOutDate}`,
      notificationType,
      reminderRuleId: rule.id,
      dueAt,
      title: status.productName,
      body: needsPrescription
        ? `${status.productName} will run out in ${formatDays(daysLeft)}. Request a new prescription.`
        : `${status.productName} will likely run out in ${formatDays(daysLeft)}.`,
      payload: {
        productId: status.productId,
        runOutDate: status.runOutDate,
        reorderDate: status.reorderDate,
      },
    });

    if (status.expiresBeforeDepletion && status.earliestExpiration) {
      notifications.push({
        dedupeKey: `expiry:${status.productId}:${status.earliestExpiration}`,
        notificationType: 'expiry',
        reminderRuleId: rule.id,
        dueAt,
        title: status.productName,
        body: `A package of ${status.productName} expires on ${status.earliestExpiration}, before the stock would be used up.`,
        payload: { productId: status.productId, expiresOn: status.earliestExpiration },
      });
    }
  }

  return notifications;
}

/**
 * Push a notification out of the user's quiet hours to the moment they end.
 * The reminder is delayed rather than dropped: a missed dose still deserves to
 * be mentioned, just not at 03:00.
 */
export function applyQuietHours(
  dueAt: string,
  rule: Pick<ReminderRule, 'quietHoursFrom' | 'quietHoursTo'>,
  timeZone: string,
): string {
  if (!rule.quietHoursFrom || !rule.quietHoursTo) return dueAt;

  const moment = new Date(dueAt);
  const localDate = instantToLocalDate(moment, timeZone);
  const localTime = instantToLocalTime(moment, timeZone);

  const minutes = minutesFromLocalTime(localTime);
  const from = minutesFromLocalTime(rule.quietHoursFrom);
  const to = minutesFromLocalTime(rule.quietHoursTo);

  const wraps = from > to;
  const insideQuietHours = wraps ? minutes >= from || minutes < to : minutes >= from && minutes < to;
  if (!insideQuietHours) return dueAt;

  // A window like 22:00-07:00 ends the following morning when we are in its
  // evening half.
  const endDate = wraps && minutes >= from ? addDays(localDate, 1) : localDate;
  return zonedTimeToInstant(endDate, rule.quietHoursTo, timeZone);
}

function formatDays(days: number): string {
  if (days <= 0) return 'less than a day';
  return `${days} day${days === 1 ? '' : 's'}`;
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
