import type { DayProfile, IntakeConstraint } from '@pillstack/contracts';
import { describe, expect, it } from 'vitest';
import { optimizeDay, type OptimizableIntake } from '../src/domain/schedules/optimizer.js';

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

let counter = 0;

function intake(overrides: Partial<OptimizableIntake> = {}): OptimizableIntake {
  const planDoseId = overrides.planDoseId ?? `dose-${(counter += 1)}`;
  return {
    occurrenceKey: `${planDoseId}:2026-09-03`,
    planDoseId,
    productId: `product-${planDoseId}`,
    productName: `Product ${planDoseId}`,
    category: 'supplement',
    substanceIds: [],
    occurrenceDate: '2026-09-03',
    scheduledTime: '08:00',
    flexibility: 'flexible',
    timingType: 'fixed',
    windowStartTime: null,
    windowEndTime: null,
    ...overrides,
  };
}

function separation(overrides: Partial<IntakeConstraint> = {}): IntakeConstraint {
  return {
    id: 'keep-apart',
    constraintType: 'minimum_separation',
    severity: 'warning',
    source: { kind: 'substance', substanceId: 'iron' },
    target: { kind: 'substance', substanceId: 'calcium' },
    minimumDistanceMinutes: 120,
    foodOffsetMinutes: null,
    preferredTimeFrom: null,
    preferredTimeTo: null,
    explanation: null,
    origin: 'user',
    enabled: true,
    summary: '',
    ...overrides,
  };
}

describe('tidying a day into fewer intake events', () => {
  it('merges three lone flexible doses into one', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'a', scheduledTime: '08:00' }),
        intake({ planDoseId: 'b', scheduledTime: '09:00' }),
        intake({ planDoseId: 'c', scheduledTime: '10:00' }),
      ],
      constraints: [],
      dayProfile,
    });

    expect(proposal.eventsBefore).toBe(3);
    expect(proposal.eventsAfter).toBe(1);
    expect(proposal.moves).toHaveLength(2);
    // They meet in the middle: one event, and the least total disruption.
    expect(new Set(proposal.moves.map((move) => move.to))).toEqual(new Set(['09:00']));
  });

  it('leaves an already tidy day alone', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'a', scheduledTime: '08:00' }),
        intake({ planDoseId: 'b', scheduledTime: '08:00' }),
      ],
      constraints: [],
      dayProfile,
    });

    expect(proposal.moves).toHaveLength(0);
    expect(proposal.eventsAfter).toBe(2 - 1);
  });

  it('produces the same proposal every time', () => {
    const build = () => [
      intake({ planDoseId: 'a', scheduledTime: '10:00' }),
      intake({ planDoseId: 'b', scheduledTime: '08:00' }),
      intake({ planDoseId: 'c', scheduledTime: '09:00' }),
    ];

    const first = optimizeDay({ intakes: build(), constraints: [], dayProfile });
    const second = optimizeDay({ intakes: build(), constraints: [], dayProfile });

    expect(first.moves).toEqual(second.moves);
  });
});

describe('what it refuses to touch', () => {
  it('never moves a dose pinned to a fixed time', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'statin', scheduledTime: '21:30', flexibility: 'fixed' }),
        intake({ planDoseId: 'flexible', scheduledTime: '20:00' }),
      ],
      constraints: [],
      dayProfile,
    });

    // The flexible one comes to the pinned one, never the other way round.
    expect(proposal.moves).toHaveLength(1);
    expect(proposal.moves[0]?.planDoseId).toBe('flexible');
    expect(proposal.moves[0]?.to).toBe('21:30');
    expect(proposal.untouched.some((entry) => entry.reason.includes('pinned'))).toBe(true);
  });

  it('never moves a meal-relative dose away from its meal', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'with-dinner', scheduledTime: '18:30', timingType: 'meal_relative' }),
        intake({ planDoseId: 'flexible', scheduledTime: '17:00' }),
      ],
      constraints: [],
      dayProfile,
    });

    expect(proposal.moves.map((move) => move.planDoseId)).toEqual(['flexible']);
    expect(proposal.untouched.some((entry) => entry.reason.includes('meal'))).toBe(true);
  });

  it('keeps a window dose inside its window', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({
          planDoseId: 'morning-window',
          scheduledTime: '08:00',
          timingType: 'window',
          windowStartTime: '08:00',
          windowEndTime: '10:00',
        }),
        // Inside the maximum shift, but outside the window.
        intake({ planDoseId: 'other', scheduledTime: '11:00', flexibility: 'fixed' }),
      ],
      constraints: [],
      dayProfile,
    });

    expect(proposal.moves).toHaveLength(0);
  });

  it('moves a window dose to another time inside its window', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({
          planDoseId: 'morning-window',
          scheduledTime: '08:00',
          timingType: 'window',
          windowStartTime: '08:00',
          windowEndTime: '10:00',
        }),
        intake({ planDoseId: 'other', scheduledTime: '09:30', flexibility: 'fixed' }),
      ],
      constraints: [],
      dayProfile,
    });

    expect(proposal.moves[0]?.to).toBe('09:30');
  });

  it('will not shift a dose further than the allowed drift', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'morning', scheduledTime: '08:00' }),
        intake({ planDoseId: 'evening', scheduledTime: '21:00', flexibility: 'fixed' }),
      ],
      constraints: [],
      dayProfile,
      maximumShiftMinutes: 180,
    });

    expect(proposal.moves).toHaveLength(0);
    expect(proposal.eventsAfter).toBe(2);
  });

  it('leaves a dose alone when it already shares an event', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'a', scheduledTime: '08:00' }),
        intake({ planDoseId: 'b', scheduledTime: '08:00' }),
        intake({ planDoseId: 'c', scheduledTime: '09:00' }),
      ],
      constraints: [],
      dayProfile,
    });

    // Only the lone 09:00 dose moves; shuffling one of the pair would not
    // remove an event.
    expect(proposal.moves.map((move) => move.planDoseId)).toEqual(['c']);
    expect(proposal.eventsAfter).toBe(1);
  });
});

describe('respecting the constraints', () => {
  const iron = () =>
    intake({
      planDoseId: 'iron',
      productName: 'Iron 20 mg',
      substanceIds: ['iron'],
      scheduledTime: '09:00',
    });

  /** Far enough from iron's 09:00 that the day starts out compliant. */
  const calcium = (scheduledTime = '06:00') =>
    intake({
      planDoseId: 'calcium',
      productName: 'Calcium 500 mg',
      substanceIds: ['calcium'],
      scheduledTime,
      flexibility: 'fixed',
    });

  it('refuses a merge that would break a rule', () => {
    const proposal = optimizeDay({
      intakes: [iron(), calcium()],
      constraints: [separation()],
      dayProfile,
    });

    expect(proposal.moves).toHaveLength(0);
    expect(proposal.remainingViolations).toHaveLength(0);
    expect(proposal.untouched.some((entry) => entry.reason.includes('safely join'))).toBe(true);
  });

  it('merges into a different event that does not break the rule', () => {
    const proposal = optimizeDay({
      intakes: [
        iron(),
        // Close enough that iron joining calcium would break the rule.
        calcium('08:00'),
        // Far enough from calcium for iron to join it instead.
        intake({ planDoseId: 'magnesium', scheduledTime: '11:00', flexibility: 'fixed' }),
      ],
      constraints: [separation()],
      dayProfile,
    });

    expect(proposal.moves).toHaveLength(1);
    expect(proposal.moves[0]?.planDoseId).toBe('iron');
    expect(proposal.moves[0]?.to).toBe('11:00');
    expect(proposal.remainingViolations).toHaveLength(0);
  });

  it('tidies around a violation that was already there without making it worse', () => {
    // Iron and calcium already clash; that is not the optimizer's doing and
    // must not stop it tidying the rest of the day.
    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'iron', substanceIds: ['iron'], scheduledTime: '08:00', flexibility: 'fixed' }),
        intake({ planDoseId: 'calcium', substanceIds: ['calcium'], scheduledTime: '08:00', flexibility: 'fixed' }),
        intake({ planDoseId: 'vitamin-d', scheduledTime: '09:00' }),
      ],
      constraints: [separation()],
      dayProfile,
    });

    expect(proposal.remainingViolations).toHaveLength(1);
    expect(proposal.moves.map((move) => move.planDoseId)).toEqual(['vitamin-d']);
    expect(proposal.eventsAfter).toBe(1);
  });

  it('will not aggravate a clash that already exists', () => {
    // Iron and calcium are already inside the 2-hour window at 60 minutes
    // apart. Merging them would keep the *same* violation on the books while
    // making the day materially worse, so identity alone is not enough — the
    // distance has to be compared too.
    const proposal = optimizeDay({
      intakes: [iron(), calcium('08:00')],
      constraints: [separation()],
      dayProfile,
    });

    expect(proposal.moves).toHaveLength(0);
    expect(proposal.remainingViolations).toHaveLength(1);
    expect(proposal.remainingViolations[0]?.actualDistanceMinutes).toBe(60);
  });

  it('never leaves the day with more violations than it started with', () => {
    const proposal = optimizeDay({
      intakes: [
        iron(),
        calcium('08:00'),
        intake({ planDoseId: 'zinc', substanceIds: ['calcium'], scheduledTime: '10:00' }),
        intake({ planDoseId: 'vitamin-c', scheduledTime: '10:30' }),
      ],
      constraints: [separation()],
      dayProfile,
    });

    const before = optimizeDay({
      intakes: [
        iron(),
        calcium('08:00'),
        intake({ planDoseId: 'zinc', substanceIds: ['calcium'], scheduledTime: '10:00' }),
        intake({ planDoseId: 'vitamin-c', scheduledTime: '10:30' }),
      ],
      constraints: [separation()],
      dayProfile,
      maximumShiftMinutes: 0,
    }).remainingViolations.length;

    expect(proposal.remainingViolations.length).toBeLessThanOrEqual(before);
  });

  it('honours a preferred time of day', () => {
    const morningOnly = separation({
      id: 'mornings',
      constraintType: 'preferred_time_of_day',
      source: { kind: 'substance', substanceId: 'iron' },
      target: null,
      minimumDistanceMinutes: null,
      preferredTimeFrom: '06:00',
      preferredTimeTo: '10:00',
    });

    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'iron', substanceIds: ['iron'], scheduledTime: '09:00' }),
        intake({ planDoseId: 'evening', scheduledTime: '11:30', flexibility: 'fixed' }),
      ],
      constraints: [morningOnly],
      dayProfile,
    });

    // Moving iron to 11:30 would put it outside its preferred window.
    expect(proposal.moves).toHaveLength(0);
  });
});

describe('the proposal itself', () => {
  it('explains each move and what it saves', () => {
    const proposal = optimizeDay({
      intakes: [
        intake({ planDoseId: 'a', productName: 'Magnesium', scheduledTime: '09:00' }),
        intake({ planDoseId: 'b', scheduledTime: '08:00', flexibility: 'fixed' }),
      ],
      constraints: [],
      dayProfile,
    });

    expect(proposal.moves[0]).toMatchObject({
      planDoseId: 'a',
      productName: 'Magnesium',
      from: '09:00',
      to: '08:00',
    });
    expect(proposal.moves[0]?.reason).toContain('08:00');
    expect(proposal.eventsBefore - proposal.eventsAfter).toBe(1);
  });

  it('handles an empty day', () => {
    const proposal = optimizeDay({ intakes: [], constraints: [], dayProfile });

    expect(proposal.moves).toHaveLength(0);
    expect(proposal.eventsBefore).toBe(0);
    expect(proposal.eventsAfter).toBe(0);
  });
});
