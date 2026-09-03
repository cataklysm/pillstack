import { describe, expect, it } from 'vitest';
import {
  PlanTransitionError,
  classifyPlanChange,
  planTransition,
  startSummary,
  stopSummary,
} from '../src/domain/treatments/planVersioning.js';
import { describePlan, type SummarizablePlan } from '../src/domain/treatments/scheduleSummary.js';

function plan(overrides: Partial<SummarizablePlan> = {}): SummarizablePlan {
  return {
    recurrenceType: 'daily',
    intervalDays: null,
    weekdayMask: null,
    maxDosesPerDay: null,
    doses: [
      {
        timingType: 'fixed',
        targetTime: '21:30',
        windowStartTime: null,
        windowEndTime: null,
        mealReference: null,
        mealOffsetMinutes: 0,
        doseAmount: 5,
        doseUnit: 'mg',
      },
    ],
    ...overrides,
  };
}

function withDose(amount: number): SummarizablePlan {
  return plan({ doses: [{ ...(plan().doses[0] as never), doseAmount: amount }] });
}

describe('describePlan', () => {
  it('renders the brief\'s own examples', () => {
    expect(describePlan(plan())).toBe('5 mg daily at 21:30');

    expect(
      describePlan(
        plan({
          doses: [
            {
              timingType: 'meal_relative',
              targetTime: null,
              windowStartTime: null,
              windowEndTime: null,
              mealReference: 'dinner',
              mealOffsetMinutes: 0,
              doseAmount: 1,
              doseUnit: 'tablet',
            },
          ],
        }),
      ),
    ).toBe('1 tablet daily with dinner');
  });

  it('renders multiple doses a day in chronological order', () => {
    const magnesium = plan({
      doses: [
        {
          timingType: 'fixed',
          targetTime: '12:00',
          windowStartTime: null,
          windowEndTime: null,
          mealReference: null,
          mealOffsetMinutes: 0,
          doseAmount: 1,
          doseUnit: 'dose',
        },
        {
          timingType: 'fixed',
          targetTime: '08:00',
          windowStartTime: null,
          windowEndTime: null,
          mealReference: null,
          mealOffsetMinutes: 0,
          doseAmount: 1,
          doseUnit: 'dose',
        },
      ],
    });

    expect(describePlan(magnesium)).toBe('1 dose daily at 08:00 and 12:00');
  });

  it('spells out asymmetric doses instead of collapsing them', () => {
    const asymmetric = plan({
      doses: [
        {
          timingType: 'fixed',
          targetTime: '08:00',
          windowStartTime: null,
          windowEndTime: null,
          mealReference: null,
          mealOffsetMinutes: 0,
          doseAmount: 2,
          doseUnit: 'tablet',
        },
        {
          timingType: 'fixed',
          targetTime: '20:00',
          windowStartTime: null,
          windowEndTime: null,
          mealReference: null,
          mealOffsetMinutes: 0,
          doseAmount: 1,
          doseUnit: 'tablet',
        },
      ],
    });

    expect(describePlan(asymmetric)).toBe('daily 2 tablets at 08:00 and 1 tablet at 20:00');
  });

  it('renders weekdays, intervals and windows', () => {
    expect(describePlan(plan({ recurrenceType: 'weekdays', weekdayMask: 0b0010101 }))).toBe(
      '5 mg on Mon, Wed and Fri at 21:30',
    );
    expect(describePlan(plan({ recurrenceType: 'every_n_days', intervalDays: 2 }))).toBe(
      '5 mg every other day at 21:30',
    );
    expect(describePlan(plan({ recurrenceType: 'every_n_days', intervalDays: 3 }))).toBe(
      '5 mg every 3 days at 21:30',
    );
    expect(
      describePlan(
        plan({
          doses: [
            {
              timingType: 'window',
              targetTime: null,
              windowStartTime: '08:00',
              windowEndTime: '10:00',
              mealReference: null,
              mealOffsetMinutes: 0,
              doseAmount: 5,
              doseUnit: 'mg',
            },
          ],
        }),
      ),
    ).toBe('5 mg daily between 08:00 and 10:00');
  });

  it('renders meal offsets in both directions', () => {
    const before = plan({
      doses: [
        {
          timingType: 'meal_relative',
          targetTime: null,
          windowStartTime: null,
          windowEndTime: null,
          mealReference: 'breakfast',
          mealOffsetMinutes: -30,
          doseAmount: 1,
          doseUnit: 'capsule',
        },
      ],
    });
    expect(describePlan(before)).toBe('1 capsule daily 30 minutes before breakfast');

    const after = plan({
      doses: [
        {
          timingType: 'meal_relative',
          targetTime: null,
          windowStartTime: null,
          windowEndTime: null,
          mealReference: 'lunch',
          mealOffsetMinutes: 120,
          doseAmount: 1,
          doseUnit: 'capsule',
        },
      ],
    });
    expect(describePlan(after)).toBe('1 capsule daily 2 hours after lunch');
  });

  it('renders as-needed medication with its daily cap', () => {
    const asNeeded = plan({
      recurrenceType: 'as_needed',
      maxDosesPerDay: 3,
      doses: [
        {
          timingType: 'as_needed',
          targetTime: null,
          windowStartTime: null,
          windowEndTime: null,
          mealReference: null,
          mealOffsetMinutes: 0,
          doseAmount: 400,
          doseUnit: 'mg',
        },
      ],
    });

    expect(describePlan(asNeeded)).toBe('400 mg as needed, up to 3 doses per day');
  });
});

describe('classifying a plan change', () => {
  it('reports a dose change when only the amount moves', () => {
    expect(classifyPlanChange(withDose(5), withDose(10))).toBe('dose_changed');
  });

  it('reports a schedule change when the timing moves', () => {
    const moved = plan({ doses: [{ ...(plan().doses[0] as never), targetTime: '08:00' }] });
    expect(classifyPlanChange(plan(), moved)).toBe('schedule_changed');
  });

  it('reports a schedule change when the recurrence moves', () => {
    expect(
      classifyPlanChange(plan(), plan({ recurrenceType: 'weekdays', weekdayMask: 0b0010101 })),
    ).toBe('schedule_changed');
  });

  it('prefers schedule_changed when dose and timing both move', () => {
    const both = plan({
      doses: [{ ...(plan().doses[0] as never), doseAmount: 10, targetTime: '08:00' }],
    });
    expect(classifyPlanChange(plan(), both)).toBe('schedule_changed');
  });

  it('detects an added dose as a schedule change', () => {
    const twiceDaily = plan({
      doses: [
        plan().doses[0] as never,
        { ...(plan().doses[0] as never), targetTime: '09:00' },
      ],
    });
    expect(classifyPlanChange(plan(), twiceDaily)).toBe('schedule_changed');
  });

  it('returns null when nothing actually changed', () => {
    expect(classifyPlanChange(plan(), plan())).toBeNull();
  });
});

describe('plan transition', () => {
  it('closes the outgoing version the day before the new one starts', () => {
    const transition = planTransition(withDose(5), withDose(10), {
      previousEffectiveFrom: '2026-09-03',
      nextEffectiveFrom: '2026-12-01',
    });

    expect(transition.previousEffectiveTo).toBe('2026-11-30');
    expect(transition.kind).toBe('dose_changed');
    expect(transition.summary).toBe(
      'Dose changed: 5 mg daily at 21:30 → 10 mg daily at 21:30',
    );
  });

  it('refuses a version that would start before the current one', () => {
    expect(() =>
      planTransition(withDose(5), withDose(10), {
        previousEffectiveFrom: '2026-09-03',
        nextEffectiveFrom: '2026-09-01',
      }),
    ).toThrow(PlanTransitionError);
  });

  it('refuses a version that would start on the same day as the current one', () => {
    // Otherwise the outgoing version would be closed before it began.
    expect(() =>
      planTransition(withDose(5), withDose(10), {
        previousEffectiveFrom: '2026-09-03',
        nextEffectiveFrom: '2026-09-03',
      }),
    ).toThrow(PlanTransitionError);
  });

  it('refuses a change that changes nothing', () => {
    expect(() =>
      planTransition(plan(), plan(), {
        previousEffectiveFrom: '2026-09-03',
        nextEffectiveFrom: '2026-12-01',
      }),
    ).toThrow(/identical/);
  });
});

describe('event summaries', () => {
  it('are complete sentences that stand on their own in a report', () => {
    expect(startSummary(plan())).toBe('Started 5 mg daily at 21:30');
    expect(stopSummary(plan(), 'target LDL reached')).toBe(
      'Stopped 5 mg daily at 21:30 — target LDL reached',
    );
    expect(stopSummary(plan(), null)).toBe('Stopped 5 mg daily at 21:30');
  });
});
