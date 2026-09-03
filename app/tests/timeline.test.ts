import type { DayProfile } from '@pillstack/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildDayTimeline,
  findNextIntake,
  type TimelineCandidate,
} from '../src/domain/schedules/timeline.js';

const dayProfile: DayProfile = {
  id: 'default',
  name: 'Default day',
  appliesToWeekdayMask: 127,
  wakeUpTime: '07:00',
  bedTime: '23:00',
  breakfastTime: '08:00',
  lunchTime: '12:30',
  dinnerTime: '18:30',
  isDefault: true,
};

function candidate(overrides: Partial<TimelineCandidate> = {}): TimelineCandidate {
  return {
    planDoseId: 'dose-1',
    intakePlanId: 'plan-1',
    treatmentId: 'treatment-1',
    productId: 'product-1',
    productName: 'Rosuvastatin 5 mg',
    category: 'medication',
    instructions: null,
    label: null,
    doseAmount: 5,
    doseUnit: 'mg',
    packageUnitQuantity: 1,
    flexibility: 'flexible',
    timing: {
      timingType: 'fixed',
      targetTime: '21:30',
      windowStartTime: null,
      windowEndTime: null,
      mealReference: null,
      mealOffsetMinutes: 0,
    },
    recurrence: {
      recurrenceType: 'daily',
      intervalDays: null,
      anchorDate: null,
      weekdayMask: null,
    },
    effectivePeriod: { effectiveFrom: '2026-09-01', effectiveTo: null },
    pauses: [],
    ...overrides,
  };
}

function build(candidates: TimelineCandidate[], extra: Partial<Parameters<typeof buildDayTimeline>[0]> = {}) {
  return buildDayTimeline({
    date: '2026-09-03',
    timeZone: 'Europe/Berlin',
    dayProfile,
    candidates,
    overrides: [],
    logEntries: [],
    ...extra,
  });
}

describe('daily timeline', () => {
  it('places a fixed dose at its time and stamps the absolute instant', () => {
    const timeline = build([candidate()]);

    expect(timeline.slots).toHaveLength(1);
    expect(timeline.slots[0]?.time).toBe('21:30');
    expect(timeline.slots[0]?.intakes[0]?.scheduledAt).toBe('2026-09-03T19:30:00.000Z');
    expect(timeline.slots[0]?.intakes[0]?.occurrenceKey).toBe('dose-1:2026-09-03');
  });

  it('resolves a meal-relative dose against the day profile', () => {
    const timeline = build([
      candidate({
        planDoseId: 'iron-dose',
        productName: 'Iron 20 mg',
        category: 'supplement',
        timing: {
          timingType: 'meal_relative',
          targetTime: null,
          windowStartTime: null,
          windowEndTime: null,
          mealReference: 'dinner',
          mealOffsetMinutes: 0,
        },
      }),
    ]);

    expect(timeline.slots[0]?.time).toBe('18:30');
    expect(timeline.slots[0]?.intakes[0]?.timeIsDerived).toBe(true);
  });

  it('applies a meal offset before and after the meal', () => {
    const before = build([
      candidate({
        timing: {
          timingType: 'meal_relative',
          targetTime: null,
          windowStartTime: null,
          windowEndTime: null,
          mealReference: 'breakfast',
          mealOffsetMinutes: -30,
        },
      }),
    ]);
    expect(before.slots[0]?.time).toBe('07:30');

    const after = build([
      candidate({
        timing: {
          timingType: 'meal_relative',
          targetTime: null,
          windowStartTime: null,
          windowEndTime: null,
          mealReference: 'lunch',
          mealOffsetMinutes: 120,
        },
      }),
    ]);
    expect(after.slots[0]?.time).toBe('14:30');
  });

  it('omits a meal-relative dose when its anchor meal is not configured', () => {
    const timeline = buildDayTimeline({
      date: '2026-09-03',
      timeZone: 'Europe/Berlin',
      dayProfile: { ...dayProfile, dinnerTime: null },
      candidates: [
        candidate({
          timing: {
            timingType: 'meal_relative',
            targetTime: null,
            windowStartTime: null,
            windowEndTime: null,
            mealReference: 'dinner',
            mealOffsetMinutes: 0,
          },
        }),
      ],
      overrides: [],
      logEntries: [],
    });

    // Better to show nothing and prompt for the missing meal time than to
    // invent one and have the user take a dose at the wrong hour.
    expect(timeline.slots).toHaveLength(0);
  });

  it('groups doses that land on the same time into one slot, medications first', () => {
    const timeline = build([
      candidate({ planDoseId: 'a', productName: 'Magnesium', category: 'supplement' }),
      candidate({ planDoseId: 'b', productName: 'Rosuvastatin', category: 'medication' }),
      candidate({
        planDoseId: 'c',
        productName: 'Vitamin D',
        category: 'supplement',
        timing: {
          timingType: 'fixed',
          targetTime: '08:00',
          windowStartTime: null,
          windowEndTime: null,
          mealReference: null,
          mealOffsetMinutes: 0,
        },
      }),
    ]);

    expect(timeline.slots.map((slot) => slot.time)).toEqual(['08:00', '21:30']);
    expect(timeline.slots[1]?.intakes.map((intake) => intake.productName)).toEqual([
      'Rosuvastatin',
      'Magnesium',
    ]);
  });

  it('sorts slots chronologically, not lexically', () => {
    const times = ['09:00', '21:30', '08:00', '12:00'];
    const timeline = build(
      times.map((time, index) =>
        candidate({
          planDoseId: `dose-${index}`,
          timing: {
            timingType: 'fixed',
            targetTime: time,
            windowStartTime: null,
            windowEndTime: null,
            mealReference: null,
            mealOffsetMinutes: 0,
          },
        }),
      ),
    );

    expect(timeline.slots.map((slot) => slot.time)).toEqual(['08:00', '09:00', '12:00', '21:30']);
  });

  it('excludes days the plan does not cover', () => {
    const ended = build([
      candidate({ effectivePeriod: { effectiveFrom: '2026-09-01', effectiveTo: '2026-09-02' } }),
    ]);
    expect(ended.slots).toHaveLength(0);

    const notStarted = build([
      candidate({ effectivePeriod: { effectiveFrom: '2026-09-04', effectiveTo: null } }),
    ]);
    expect(notStarted.slots).toHaveLength(0);
  });

  it('suppresses doses on paused days', () => {
    const timeline = build([
      candidate({ pauses: [{ pausedFrom: '2026-09-01', resumedOn: null }] }),
    ]);
    expect(timeline.slots).toHaveLength(0);
  });

  it('offers as-needed doses separately from the clock', () => {
    const timeline = build([
      candidate({
        productName: 'Ibuprofen 400 mg',
        recurrence: {
          recurrenceType: 'as_needed',
          intervalDays: null,
          anchorDate: null,
          weekdayMask: null,
        },
        timing: {
          timingType: 'as_needed',
          targetTime: null,
          windowStartTime: null,
          windowEndTime: null,
          mealReference: null,
          mealOffsetMinutes: 0,
        },
      }),
    ]);

    expect(timeline.slots).toHaveLength(0);
    expect(timeline.asNeeded).toHaveLength(1);
    expect(timeline.asNeeded[0]?.productName).toBe('Ibuprofen 400 mg');
  });
});

describe('single-day overrides', () => {
  it('moves an occurrence without touching the plan', () => {
    const timeline = build([candidate()], {
      overrides: [
        {
          planDoseId: 'dose-1',
          occurrenceDate: '2026-09-03',
          overrideType: 'moved',
          overriddenTime: '12:00',
        },
      ],
    });

    expect(timeline.slots[0]?.time).toBe('12:00');
    expect(timeline.slots[0]?.intakes[0]?.movedByUser).toBe(true);
  });

  it('leaves other days alone', () => {
    const timeline = build([candidate()], {
      overrides: [
        {
          planDoseId: 'dose-1',
          occurrenceDate: '2026-09-04',
          overrideType: 'moved',
          overriddenTime: '12:00',
        },
      ],
    });

    expect(timeline.slots[0]?.time).toBe('21:30');
  });

  it('drops a skipped occurrence and adds an extra one', () => {
    expect(
      build([candidate()], {
        overrides: [
          {
            planDoseId: 'dose-1',
            occurrenceDate: '2026-09-03',
            overrideType: 'skipped',
            overriddenTime: null,
          },
        ],
      }).slots,
    ).toHaveLength(0);

    const added = build(
      [candidate({ recurrence: { recurrenceType: 'weekdays', intervalDays: null, anchorDate: null, weekdayMask: 1 } })],
      {
        overrides: [
          {
            planDoseId: 'dose-1',
            occurrenceDate: '2026-09-03',
            overrideType: 'added',
            overriddenTime: null,
          },
        ],
      },
    );
    // 2026-09-03 is a Thursday, so the weekly pattern would not fire.
    expect(added.slots[0]?.time).toBe('21:30');
  });

  it('reflects a confirmed intake in the occurrence status', () => {
    const timeline = build([candidate()], {
      logEntries: [{ planDoseId: 'dose-1', occurrenceDate: '2026-09-03', status: 'taken' }],
    });

    expect(timeline.slots[0]?.intakes[0]?.status).toBe('taken');
  });
});

describe('next intake', () => {
  it('picks the earliest pending dose at or after now', () => {
    const today = build([
      candidate({ planDoseId: 'morning', timing: { timingType: 'fixed', targetTime: '08:00', windowStartTime: null, windowEndTime: null, mealReference: null, mealOffsetMinutes: 0 } }),
      candidate({ planDoseId: 'evening' }),
    ]);

    const next = findNextIntake([today], '2026-09-03T09:00:00.000Z');
    expect(next?.planDoseId).toBe('evening');
  });

  it('skips doses that are already recorded', () => {
    const today = build([candidate()], {
      logEntries: [{ planDoseId: 'dose-1', occurrenceDate: '2026-09-03', status: 'taken' }],
    });

    expect(findNextIntake([today], '2026-09-03T06:00:00.000Z')).toBeNull();
  });

  it('rolls over into the following day', () => {
    const today = build([candidate()]);
    const tomorrow = build([candidate()], { date: '2026-09-04' });

    const next = findNextIntake([today, tomorrow], '2026-09-03T20:00:00.000Z');
    expect(next?.occurrenceDate).toBe('2026-09-04');
  });
});
