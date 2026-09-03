import type { AppNotification, LocalTime, ReminderRule } from '@pillstack/contracts';
import type { PendingNotification } from '../../domain/reminders/generation.js';
import type { PillstackDatabase } from '../database.js';
import type { NotificationTable, ReminderRuleTable } from '../schema.js';

export class ReminderRepository {
  constructor(private readonly db: PillstackDatabase) {}

  // -- rules -----------------------------------------------------------------

  async listRules(): Promise<ReminderRule[]> {
    const rows = await this.db
      .selectFrom('reminder_rule')
      .selectAll()
      .orderBy('reminder_type', 'asc')
      .orderBy('scope_kind', 'asc')
      .execute();

    return rows.map(toRule);
  }

  async findRule(id: string): Promise<ReminderRule | null> {
    const row = await this.db
      .selectFrom('reminder_rule')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? toRule(row) : null;
  }

  async insertRule(record: {
    id: string;
    reminderType: ReminderRuleTable['reminder_type'];
    scopeKind: ReminderRuleTable['scope_kind'];
    productId: string | null;
    treatmentId: string | null;
    leadTimeMinutes: number | null;
    leadTimeDays: number | null;
    repeatAfterMinutes: number | null;
    quietHoursFrom: string | null;
    quietHoursTo: string | null;
    enabled: boolean;
    now: string;
  }): Promise<void> {
    await this.db
      .insertInto('reminder_rule')
      .values({
        id: record.id,
        reminder_type: record.reminderType,
        scope_kind: record.scopeKind,
        product_id: record.productId,
        treatment_id: record.treatmentId,
        lead_time_minutes: record.leadTimeMinutes,
        lead_time_days: record.leadTimeDays,
        repeat_after_minutes: record.repeatAfterMinutes,
        quiet_hours_from: record.quietHoursFrom,
        quiet_hours_to: record.quietHoursTo,
        enabled: record.enabled ? 1 : 0,
        created_at: record.now,
        updated_at: record.now,
      })
      .execute();
  }

  async updateRule(id: string, record: Parameters<ReminderRepository['insertRule']>[0]): Promise<void> {
    await this.db
      .updateTable('reminder_rule')
      .set({
        reminder_type: record.reminderType,
        scope_kind: record.scopeKind,
        product_id: record.productId,
        treatment_id: record.treatmentId,
        lead_time_minutes: record.leadTimeMinutes,
        lead_time_days: record.leadTimeDays,
        repeat_after_minutes: record.repeatAfterMinutes,
        quiet_hours_from: record.quietHoursFrom,
        quiet_hours_to: record.quietHoursTo,
        enabled: record.enabled ? 1 : 0,
        updated_at: record.now,
      })
      .where('id', '=', id)
      .execute();
  }

  async deleteRule(id: string): Promise<void> {
    await this.db.deleteFrom('reminder_rule').where('id', '=', id).execute();
  }

  // -- outbox ----------------------------------------------------------------

  /**
   * Writes generated notifications, ignoring any whose `dedupe_key` is already
   * present. That unique index is what makes generation safe to re-run on every
   * request without producing duplicates or needing a scheduler.
   */
  async upsertNotifications(
    notifications: readonly PendingNotification[],
    now: string,
    idFor: () => string,
  ): Promise<number> {
    if (notifications.length === 0) return 0;

    const result = await this.db
      .insertInto('notification')
      .values(
        notifications.map((notification) => ({
          id: idFor(),
          reminder_rule_id: notification.reminderRuleId,
          notification_type: notification.notificationType,
          dedupe_key: notification.dedupeKey,
          due_at: notification.dueAt,
          title: notification.title,
          body: notification.body,
          payload: notification.payload === undefined ? null : JSON.stringify(notification.payload),
          delivered_at: null,
          dismissed_at: null,
          created_at: now,
        })),
      )
      .onConflict((oc) => oc.column('dedupe_key').doNothing())
      .executeTakeFirst();

    return Number(result.numInsertedOrUpdatedRows ?? 0);
  }

  /** Undelivered notifications whose time has come. */
  async listDue(now: string, limit = 50): Promise<AppNotification[]> {
    const rows = await this.db
      .selectFrom('notification')
      .selectAll()
      .where('due_at', '<=', now)
      .where('delivered_at', 'is', null)
      .where('dismissed_at', 'is', null)
      .orderBy('due_at', 'asc')
      .limit(limit)
      .execute();

    return rows.map(toNotification);
  }

  async listRecent(limit = 50): Promise<AppNotification[]> {
    const rows = await this.db
      .selectFrom('notification')
      .selectAll()
      .orderBy('due_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map(toNotification);
  }

  async markDelivered(ids: readonly string[], now: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .updateTable('notification')
      .set({ delivered_at: now })
      .where('id', 'in', ids)
      .where('delivered_at', 'is', null)
      .execute();
  }

  async dismiss(id: string, now: string): Promise<void> {
    await this.db
      .updateTable('notification')
      .set({ dismissed_at: now, delivered_at: now })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Drops undelivered notifications for occurrences that no longer stand — a
   * dose that moved, was taken, or whose plan version was superseded.
   */
  async discardStale(keepDedupeKeys: ReadonlySet<string>, prefix: string): Promise<void> {
    const rows = await this.db
      .selectFrom('notification')
      .select(['id', 'dedupe_key'])
      .where('delivered_at', 'is', null)
      .where('dedupe_key', 'like', `${prefix}%`)
      .execute();

    const stale = rows.filter((row) => !keepDedupeKeys.has(row.dedupe_key)).map((row) => row.id);
    if (stale.length === 0) return;

    await this.db.deleteFrom('notification').where('id', 'in', stale).execute();
  }
}

function toRule(row: ReminderRuleTable): ReminderRule {
  const rule = {
    id: row.id,
    reminderType: row.reminder_type,
    scopeKind: row.scope_kind,
    productId: row.product_id,
    treatmentId: row.treatment_id,
    leadTimeMinutes: row.lead_time_minutes,
    leadTimeDays: row.lead_time_days,
    repeatAfterMinutes: row.repeat_after_minutes,
    quietHoursFrom: row.quiet_hours_from as LocalTime | null,
    quietHoursTo: row.quiet_hours_to as LocalTime | null,
    enabled: row.enabled === 1,
  };

  return { ...rule, summary: describeRule(rule) };
}

function describeRule(rule: Omit<ReminderRule, 'summary'>): string {
  const scope =
    rule.scopeKind === 'global'
      ? 'everything'
      : rule.scopeKind === 'product'
        ? 'one product'
        : 'one treatment';

  const timing =
    rule.reminderType === 'intake'
      ? rule.leadTimeMinutes
        ? `${rule.leadTimeMinutes} minutes before the dose`
        : 'at the scheduled time'
      : `${rule.leadTimeDays ?? 14} days before the reorder date`;

  const quiet =
    rule.quietHoursFrom && rule.quietHoursTo
      ? `, held back between ${rule.quietHoursFrom} and ${rule.quietHoursTo}`
      : '';

  return `${capitalize(rule.reminderType)} reminders for ${scope}, ${timing}${quiet}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toNotification(row: NotificationTable): AppNotification {
  return {
    id: row.id,
    notificationType: row.notification_type,
    dedupeKey: row.dedupe_key,
    dueAt: row.due_at,
    title: row.title,
    body: row.body,
    payload: row.payload ? (JSON.parse(row.payload) as unknown) : null,
    deliveredAt: row.delivered_at,
    dismissedAt: row.dismissed_at,
  };
}
