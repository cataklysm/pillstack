import type { DayProfile, LocalTime, UpdateDayProfileInput } from '@pillstack/contracts';
import type { PillstackDatabase } from '../database.js';

export const DEFAULT_DAY_PROFILE_ID = 'day-profile-default';

export class SettingsRepository {
  constructor(private readonly db: PillstackDatabase) {}

  async get(key: string): Promise<unknown | null> {
    const row = await this.db
      .selectFrom('app_setting')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();

    return row ? (JSON.parse(row.value) as unknown) : null;
  }

  async set(key: string, value: unknown, now: string): Promise<void> {
    await this.db
      .insertInto('app_setting')
      .values({ key, value: JSON.stringify(value), updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: now }))
      .execute();
  }

  /**
   * The timezone every wall-clock calculation resolves against. Defaults to the
   * machine's zone on first run and is then stored, so moving the database to
   * another machine does not silently reinterpret existing schedules.
   */
  async getTimeZone(): Promise<string> {
    const stored = await this.get('timezone');
    if (typeof stored === 'string' && stored.length > 0) return stored;
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  async setTimeZone(timeZone: string, now: string): Promise<void> {
    await this.set('timezone', timeZone, now);
  }
}

export class DayProfileRepository {
  constructor(private readonly db: PillstackDatabase) {}

  /**
   * The default profile is created on first read rather than seeded by a
   * migration, so a restored backup that predates it still works.
   */
  async getDefault(now: string): Promise<DayProfile> {
    const existing = await this.db
      .selectFrom('day_profile')
      .selectAll()
      .where('is_default', '=', 1)
      .executeTakeFirst();

    if (existing) return toDayProfile(existing);

    await this.db
      .insertInto('day_profile')
      .values({
        id: DEFAULT_DAY_PROFILE_ID,
        name: 'Default day',
        applies_to_weekday_mask: 127,
        wake_up_time: '07:00',
        bed_time: '23:00',
        breakfast_time: '08:00',
        lunch_time: '12:30',
        dinner_time: '18:30',
        is_default: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();

    return {
      id: DEFAULT_DAY_PROFILE_ID,
      name: 'Default day',
      appliesToWeekdayMask: 127,
      wakeUpTime: '07:00',
      bedTime: '23:00',
      breakfastTime: '08:00',
      lunchTime: '12:30',
      dinnerTime: '18:30',
      isDefault: true,
    };
  }

  async updateDefault(changes: UpdateDayProfileInput, now: string): Promise<DayProfile> {
    await this.getDefault(now);

    const values: Record<string, unknown> = { updated_at: now };
    if (changes.name !== undefined) values.name = changes.name;
    if (changes.wakeUpTime !== undefined) values.wake_up_time = changes.wakeUpTime;
    if (changes.bedTime !== undefined) values.bed_time = changes.bedTime;
    if (changes.breakfastTime !== undefined) values.breakfast_time = changes.breakfastTime ?? null;
    if (changes.lunchTime !== undefined) values.lunch_time = changes.lunchTime ?? null;
    if (changes.dinnerTime !== undefined) values.dinner_time = changes.dinnerTime ?? null;

    await this.db.updateTable('day_profile').set(values).where('is_default', '=', 1).execute();

    return this.getDefault(now);
  }
}

function toDayProfile(row: {
  id: string;
  name: string;
  applies_to_weekday_mask: number;
  wake_up_time: string;
  bed_time: string;
  breakfast_time: string | null;
  lunch_time: string | null;
  dinner_time: string | null;
  is_default: number;
}): DayProfile {
  return {
    id: row.id,
    name: row.name,
    appliesToWeekdayMask: row.applies_to_weekday_mask,
    wakeUpTime: row.wake_up_time as LocalTime,
    bedTime: row.bed_time as LocalTime,
    breakfastTime: row.breakfast_time as LocalTime | null,
    lunchTime: row.lunch_time as LocalTime | null,
    dinnerTime: row.dinner_time as LocalTime | null,
    isDefault: row.is_default === 1,
  };
}
