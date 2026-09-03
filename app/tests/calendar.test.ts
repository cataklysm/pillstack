import { describe, expect, it } from 'vitest';
import {
  addDays,
  differenceInDays,
  eachDayInRange,
  instantToLocalDate,
  isWeekdayInMask,
  localTimeFromMinutes,
  minutesFromLocalTime,
  weekdayIndex,
  zonedTimeToInstant,
} from '../src/domain/schedules/calendar.js';

describe('calendar arithmetic', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('handles leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(differenceInDays('2028-03-01', '2028-02-28')).toBe(2);
    expect(differenceInDays('2026-03-01', '2026-02-28')).toBe(1);
  });

  it('treats weekday 0 as Monday, matching the schema bitfield', () => {
    // 2026-09-03 is a Thursday.
    expect(weekdayIndex('2026-09-03')).toBe(3);
    expect(weekdayIndex('2026-09-07')).toBe(0);
    expect(weekdayIndex('2026-09-06')).toBe(6);
  });

  it('matches weekday masks', () => {
    const mondayWednesdayFriday = 0b0010101;
    expect(isWeekdayInMask('2026-09-07', mondayWednesdayFriday)).toBe(true);
    expect(isWeekdayInMask('2026-09-08', mondayWednesdayFriday)).toBe(false);
    expect(isWeekdayInMask('2026-09-09', mondayWednesdayFriday)).toBe(true);
    expect(isWeekdayInMask('2026-09-11', mondayWednesdayFriday)).toBe(true);
  });

  it('enumerates inclusive ranges', () => {
    expect(eachDayInRange('2026-09-03', '2026-09-05')).toEqual([
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ]);
    expect(eachDayInRange('2026-09-03', '2026-09-03')).toEqual(['2026-09-03']);
  });

  it('round-trips local times through minutes', () => {
    expect(minutesFromLocalTime('21:30')).toBe(1290);
    expect(localTimeFromMinutes(1290)).toBe('21:30');
    expect(localTimeFromMinutes(0)).toBe('00:00');
    // Meal offsets that would fall outside the day are clamped, not wrapped:
    // a dose does not silently jump to the previous day.
    expect(localTimeFromMinutes(-30)).toBe('00:00');
    expect(localTimeFromMinutes(1500)).toBe('23:59');
  });
});

describe('timezone conversion', () => {
  it('resolves a wall-clock time to the right instant in summer and winter', () => {
    // Berlin is UTC+2 in summer, UTC+1 in winter.
    expect(zonedTimeToInstant('2026-09-03', '21:30', 'Europe/Berlin')).toBe(
      '2026-09-03T19:30:00.000Z',
    );
    expect(zonedTimeToInstant('2026-01-15', '21:30', 'Europe/Berlin')).toBe(
      '2026-01-15T20:30:00.000Z',
    );
  });

  it('stays correct on both sides of a daylight-saving change', () => {
    // European DST starts on 2026-03-29.
    expect(zonedTimeToInstant('2026-03-28', '08:00', 'Europe/Berlin')).toBe(
      '2026-03-28T07:00:00.000Z',
    );
    expect(zonedTimeToInstant('2026-03-30', '08:00', 'Europe/Berlin')).toBe(
      '2026-03-30T06:00:00.000Z',
    );
  });

  it('keeps calendar dates stable regardless of timezone', () => {
    // The point of storing clinical dates as plain strings: a treatment that
    // started on 3 September stays 3 September everywhere.
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(differenceInDays('2026-03-30', '2026-03-29')).toBe(1);
  });

  it('reads the local date of an instant', () => {
    // 22:30 UTC is already the next day in Berlin.
    expect(instantToLocalDate(new Date('2026-09-03T22:30:00Z'), 'Europe/Berlin')).toBe(
      '2026-09-04',
    );
    expect(instantToLocalDate(new Date('2026-09-03T22:30:00Z'), 'UTC')).toBe('2026-09-03');
  });
});
