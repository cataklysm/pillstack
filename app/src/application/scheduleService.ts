import {
  clearIntakeOverrideInputSchema,
  moveIntakeInputSchema,
  previewMoveInputSchema,
  type DayTimeline,
  type LocalDate,
  type LocalTime,
  type MovePreview,
  type ScheduledIntake,
} from '@pillstack/contracts';
import { addDays, instantToLocalDate } from '../domain/schedules/calendar.js';
import { buildDayTimeline, findNextIntake } from '../domain/schedules/timeline.js';
import type { PillstackDatabase } from '../persistence/database.js';
import { ScheduleRepository } from '../persistence/repositories/scheduleRepository.js';
import {
  DayProfileRepository,
  SettingsRepository,
} from '../persistence/repositories/settingsRepository.js';
import type { Clock } from './clock.js';
import type { ConstraintService } from './constraintService.js';
import { NotFoundError, ValidationError } from './errors.js';
import { createId } from './ids.js';

/** How far ahead `nextIntake` looks before giving up. */
const NEXT_INTAKE_HORIZON_DAYS = 14;

export class ScheduleService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
    private readonly constraints: ConstraintService,
  ) {}

  async today(): Promise<LocalDate> {
    const timeZone = await new SettingsRepository(this.db).getTimeZone();
    return instantToLocalDate(this.clock.now(), timeZone);
  }

  async dayTimeline(date?: string): Promise<DayTimeline> {
    const target = date ?? (await this.today());
    const timelines = await this.timelinesForRange(target, 0);
    const timeline = timelines[0];
    if (!timeline) throw new NotFoundError('timeline', target);

    const dayProfile = await new DayProfileRepository(this.db).getDefault(
      this.clock.now().toISOString(),
    );
    return { ...timeline, violations: await this.constraints.evaluateDay(timeline, dayProfile) };
  }

  /**
   * The next pending dose from now, scanning forward day by day.
   * Returns `null` when nothing is scheduled inside the horizon.
   */
  async nextIntake(): Promise<ScheduledIntake | null> {
    const today = await this.today();
    const timelines = await this.timelinesForRange(today, NEXT_INTAKE_HORIZON_DAYS);
    return findNextIntake(timelines, this.clock.now().toISOString());
  }

  /**
   * What would break if an intake moved, without saving anything.
   *
   * This is what makes the warning honest: it compares the violations the new
   * time would cause against the ones already present, so the user is only
   * asked about clashes their move actually introduces.
   */
  async previewMove(rawInput: unknown): Promise<MovePreview> {
    const parsed = previewMoveInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid preview', parsed.error.issues);

    const input = parsed.data;
    const timelines = await this.timelinesForRange(input.occurrenceDate, 0);
    const timeline = timelines[0];
    if (!timeline) throw new NotFoundError('timeline', input.occurrenceDate);

    const dayProfile = await new DayProfileRepository(this.db).getDefault(
      this.clock.now().toISOString(),
    );

    const [violations, currentViolations] = await Promise.all([
      this.constraints.evaluateDay(timeline, dayProfile, {
        replace: { planDoseId: input.planDoseId, time: input.time as LocalTime },
      }),
      this.constraints.evaluateDay(timeline, dayProfile),
    ]);

    return { violations, currentViolations };
  }

  /**
   * Move a single occurrence to a different time.
   *
   * Deliberately an exception for one day, recorded as a schedule override —
   * the plan version is untouched. A permanent change goes through
   * `TreatmentService.changePlan`, which creates a new version instead.
   *
   * Constraint warnings never block the move. Ids passed in
   * `acknowledgeConstraintIds` are recorded against the override so the same
   * warning, once consciously accepted, stops being raised.
   */
  async moveIntake(rawInput: unknown): Promise<DayTimeline> {
    const parsed = moveIntakeInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid move', parsed.error.issues);

    const input = parsed.data;
    const schedule = new ScheduleRepository(this.db);

    if (!(await schedule.planDoseExists(input.planDoseId))) {
      throw new NotFoundError('plan dose', input.planDoseId);
    }

    await schedule.upsertOverride({
      id: createId(),
      planDoseId: input.planDoseId,
      occurrenceDate: input.occurrenceDate,
      overrideType: 'moved',
      overriddenTime: input.time,
      reason: input.reason ?? null,
      createdAt: this.clock.now().toISOString(),
    });

    if (input.acknowledgeConstraintIds?.length) {
      await this.constraints.acknowledge(
        input.planDoseId,
        input.occurrenceDate,
        input.acknowledgeConstraintIds,
      );
    }

    return this.dayTimeline(input.occurrenceDate);
  }

  async clearIntakeOverride(rawInput: unknown): Promise<DayTimeline> {
    const parsed = clearIntakeOverrideInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid request', parsed.error.issues);

    const input = parsed.data;
    await new ScheduleRepository(this.db).deleteOverride(input.planDoseId, input.occurrenceDate);
    return this.dayTimeline(input.occurrenceDate);
  }

  /**
   * Builds timelines for `from` through `from + additionalDays`, loading the
   * whole range in one pass so a week view costs the same three queries as a
   * single day. Violations are not attached here — `dayTimeline` adds them for
   * the single day the user is looking at.
   */
  private async timelinesForRange(from: string, additionalDays: number): Promise<DayTimeline[]> {
    const to = addDays(from as LocalDate, additionalDays);
    const now = this.clock.now().toISOString();

    const settings = new SettingsRepository(this.db);
    const dayProfiles = new DayProfileRepository(this.db);
    const schedule = new ScheduleRepository(this.db);

    const [timeZone, dayProfile, candidates, overrides, logEntries] = await Promise.all([
      settings.getTimeZone(),
      dayProfiles.getDefault(now),
      schedule.loadCandidates(from as LocalDate, to),
      schedule.loadOverrides(from as LocalDate, to),
      schedule.loadLogEntries(from as LocalDate, to),
    ]);

    const timelines: DayTimeline[] = [];
    for (let offset = 0; offset <= additionalDays; offset += 1) {
      const date = addDays(from as LocalDate, offset);
      timelines.push(
        buildDayTimeline({
          date,
          timeZone,
          dayProfile,
          candidates,
          overrides: overrides.filter((override) => override.occurrenceDate === date),
          logEntries: logEntries.filter((entry) => entry.occurrenceDate === date),
        }),
      );
    }

    return timelines;
  }
}
