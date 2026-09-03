import { describe, expect, it } from 'vitest';
import {
  isPausedOn,
  isPlanEffectiveOn,
  planProducesDosesOn,
  recurrenceOccursOn,
  type PauseInterval,
  type RecurrencePattern,
} from '../src/domain/schedules/recurrence.js';

const daily: RecurrencePattern = {
  recurrenceType: 'daily',
  intervalDays: null,
  anchorDate: null,
  weekdayMask: null,
};

describe('recurrence', () => {
  it('produces a dose every day for a daily pattern', () => {
    expect(recurrenceOccursOn(daily, '2026-09-03')).toBe(true);
    expect(recurrenceOccursOn(daily, '2026-12-25')).toBe(true);
  });

  it('honours a weekday mask', () => {
    const monWedFri: RecurrencePattern = {
      recurrenceType: 'weekdays',
      intervalDays: null,
      anchorDate: null,
      weekdayMask: 0b0010101,
    };

    expect(recurrenceOccursOn(monWedFri, '2026-09-07')).toBe(true); // Monday
    expect(recurrenceOccursOn(monWedFri, '2026-09-08')).toBe(false); // Tuesday
    expect(recurrenceOccursOn(monWedFri, '2026-09-09')).toBe(true); // Wednesday
    expect(recurrenceOccursOn(monWedFri, '2026-09-13')).toBe(false); // Sunday
  });

  it('counts every-N-days from the anchor and never before it', () => {
    const everyThreeDays: RecurrencePattern = {
      recurrenceType: 'every_n_days',
      intervalDays: 3,
      anchorDate: '2026-09-03',
      weekdayMask: null,
    };

    expect(recurrenceOccursOn(everyThreeDays, '2026-09-03')).toBe(true);
    expect(recurrenceOccursOn(everyThreeDays, '2026-09-04')).toBe(false);
    expect(recurrenceOccursOn(everyThreeDays, '2026-09-06')).toBe(true);
    expect(recurrenceOccursOn(everyThreeDays, '2026-09-09')).toBe(true);
    // Before the anchor there is no dose, even where the modulo would match.
    expect(recurrenceOccursOn(everyThreeDays, '2026-08-31')).toBe(false);
  });

  it('keeps every-N-days aligned across a month boundary', () => {
    const everyThreeDays: RecurrencePattern = {
      recurrenceType: 'every_n_days',
      intervalDays: 3,
      anchorDate: '2026-01-30',
      weekdayMask: null,
    };

    expect(recurrenceOccursOn(everyThreeDays, '2026-02-02')).toBe(true);
    expect(recurrenceOccursOn(everyThreeDays, '2026-02-03')).toBe(false);
    expect(recurrenceOccursOn(everyThreeDays, '2026-02-05')).toBe(true);
  });

  it('never schedules an as-needed pattern', () => {
    const asNeeded: RecurrencePattern = {
      recurrenceType: 'as_needed',
      intervalDays: null,
      anchorDate: null,
      weekdayMask: null,
    };

    expect(recurrenceOccursOn(asNeeded, '2026-09-03')).toBe(false);
  });
});

describe('plan effective periods', () => {
  it('includes both boundary dates', () => {
    const period = { effectiveFrom: '2026-09-03', effectiveTo: '2026-11-30' };

    expect(isPlanEffectiveOn(period, '2026-09-02')).toBe(false);
    expect(isPlanEffectiveOn(period, '2026-09-03')).toBe(true);
    expect(isPlanEffectiveOn(period, '2026-11-30')).toBe(true);
    expect(isPlanEffectiveOn(period, '2026-12-01')).toBe(false);
  });

  it('treats an open period as running forever', () => {
    const period = { effectiveFrom: '2026-09-03', effectiveTo: null };
    expect(isPlanEffectiveOn(period, '2030-01-01')).toBe(true);
  });

  it('hands over from one version to the next with no gap and no overlap', () => {
    const version1 = { effectiveFrom: '2026-09-03', effectiveTo: '2026-11-30' };
    const version2 = { effectiveFrom: '2026-12-01', effectiveTo: null };

    for (const date of ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']) {
      const matches = [version1, version2].filter((period) => isPlanEffectiveOn(period, date));
      expect(matches, `exactly one version must apply on ${date}`).toHaveLength(1);
    }
  });
});

describe('pauses', () => {
  const pauses: PauseInterval[] = [{ pausedFrom: '2026-09-10', resumedOn: '2026-09-15' }];

  it('covers the paused days and excludes the resume day', () => {
    expect(isPausedOn(pauses, '2026-09-09')).toBe(false);
    expect(isPausedOn(pauses, '2026-09-10')).toBe(true);
    expect(isPausedOn(pauses, '2026-09-14')).toBe(true);
    expect(isPausedOn(pauses, '2026-09-15')).toBe(false);
  });

  it('treats an unresolved pause as still running', () => {
    expect(isPausedOn([{ pausedFrom: '2026-09-10', resumedOn: null }], '2030-01-01')).toBe(true);
  });

  it('suppresses doses while paused, without touching the plan', () => {
    const period = { effectiveFrom: '2026-09-03', effectiveTo: null };

    expect(planProducesDosesOn(daily, period, pauses, '2026-09-09')).toBe(true);
    expect(planProducesDosesOn(daily, period, pauses, '2026-09-12')).toBe(false);
    expect(planProducesDosesOn(daily, period, pauses, '2026-09-15')).toBe(true);
  });
});
