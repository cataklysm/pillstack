import type { LocalDate, LocalTime } from '@pillstack/contracts';

/**
 * Calendar arithmetic for wall-clock dates and times.
 *
 * Clinical dates are plain `YYYY-MM-DD` strings and are never routed through a
 * UTC conversion: a treatment started on 3 September stays 3 September no
 * matter which timezone the machine is in. Where an absolute instant really is
 * needed (a reminder must fire at a moment in time), `zonedTimeToInstant`
 * converts explicitly against a named IANA timezone.
 */

const MILLISECONDS_PER_DAY = 86_400_000;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export function parseLocalDate(date: LocalDate): CalendarDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new RangeError(`invalid local date: ${date}`);
  }
  return { year, month, day };
}

export function formatLocalDate({ year, month, day }: CalendarDate): LocalDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Days since the epoch. Uses UTC arithmetic purely as a stable day counter. */
export function toEpochDay(date: LocalDate): number {
  const { year, month, day } = parseLocalDate(date);
  return Math.floor(Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY);
}

export function fromEpochDay(epochDay: number): LocalDate {
  const moment = new Date(epochDay * MILLISECONDS_PER_DAY);
  return formatLocalDate({
    year: moment.getUTCFullYear(),
    month: moment.getUTCMonth() + 1,
    day: moment.getUTCDate(),
  });
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/** `later` minus `earlier`, in whole days. */
export function differenceInDays(later: LocalDate, earlier: LocalDate): number {
  return toEpochDay(later) - toEpochDay(earlier);
}

export function compareLocalDate(left: LocalDate, right: LocalDate): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isDateWithin(
  date: LocalDate,
  from: LocalDate,
  to: LocalDate | null | undefined,
): boolean {
  if (date < from) return false;
  return to == null || date <= to;
}

export function eachDayInRange(from: LocalDate, to: LocalDate): LocalDate[] {
  const days: LocalDate[] = [];
  for (let epochDay = toEpochDay(from); epochDay <= toEpochDay(to); epochDay += 1) {
    days.push(fromEpochDay(epochDay));
  }
  return days;
}

/** 0 is Monday, 6 is Sunday — matching the weekday bitfield in the schema. */
export function weekdayIndex(date: LocalDate): number {
  const { year, month, day } = parseLocalDate(date);
  const jsWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (jsWeekday + 6) % 7;
}

export function isWeekdayInMask(date: LocalDate, weekdayMask: number): boolean {
  return (weekdayMask & (1 << weekdayIndex(date))) !== 0;
}

export function minutesFromLocalTime(time: LocalTime): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function localTimeFromMinutes(minutes: number): LocalTime {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  return `${String(hours).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/**
 * Offset of `timeZone` from UTC, in milliseconds, at a given instant.
 * Positive east of Greenwich.
 */
function timeZoneOffsetMilliseconds(instantMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  // Some engines render midnight as hour 24 under hour12:false.
  const hour = parts.hour === 24 ? 0 : (parts.hour ?? 0);
  const asIfUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    hour,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return asIfUtc - instantMs;
}

/**
 * Convert a wall-clock date and time in `timeZone` to an absolute instant.
 * Two passes settle the offset correctly across daylight-saving transitions.
 */
export function zonedTimeToInstant(
  date: LocalDate,
  time: LocalTime,
  timeZone: string,
): string {
  const { year, month, day } = parseLocalDate(date);
  const naiveMs = Date.UTC(year, month - 1, day, 0, 0, 0) + minutesFromLocalTime(time) * 60_000;
  let instantMs = naiveMs - timeZoneOffsetMilliseconds(naiveMs, timeZone);
  instantMs = naiveMs - timeZoneOffsetMilliseconds(instantMs, timeZone);
  return new Date(instantMs).toISOString();
}

/** The calendar date that `instant` falls on, as seen in `timeZone`. */
export function instantToLocalDate(instant: Date, timeZone: string): LocalDate {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(instant) as LocalDate;
}

export function instantToLocalTime(instant: Date, timeZone: string): LocalTime {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const formatted = formatter.format(instant);
  return (formatted === '24:00' ? '00:00' : formatted) as LocalTime;
}
