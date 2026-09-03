/**
 * Time is injected rather than read from the ambient environment, so schedule
 * and history tests can pin "now" instead of depending on when they run.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(instant: string | Date): Clock {
  const moment = typeof instant === 'string' ? new Date(instant) : instant;
  return { now: () => new Date(moment.getTime()) };
}
