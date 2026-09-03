import type { IntakeConstraint } from '@pillstack/contracts';
import { describe, expect, it } from 'vitest';
import {
  acknowledgementKey,
  evaluateConstraints,
  type EvaluableIntake,
  type MealTimes,
} from '../src/domain/constraints/evaluation.js';
import { describeConstraint } from '../src/domain/constraints/summary.js';

const mealTimes: MealTimes = {
  breakfast: '08:00',
  lunch: '12:30',
  dinner: '18:30',
  wake_up: '07:00',
  bed_time: '23:00',
};

function intake(overrides: Partial<EvaluableIntake> = {}): EvaluableIntake {
  const planDoseId = overrides.planDoseId ?? 'dose-iron';
  return {
    occurrenceKey: `${planDoseId}:2026-09-03`,
    planDoseId,
    productId: 'product-iron',
    productName: 'Iron 20 mg',
    category: 'supplement',
    substanceIds: ['substance-iron'],
    occurrenceDate: '2026-09-03',
    scheduledTime: '18:30',
    ...overrides,
  };
}

function constraint(overrides: Partial<IntakeConstraint> = {}): IntakeConstraint {
  return {
    id: 'constraint-1',
    constraintType: 'minimum_separation',
    severity: 'warning',
    source: { kind: 'substance', substanceId: 'substance-iron', name: 'Iron' },
    target: { kind: 'substance', substanceId: 'substance-calcium', name: 'Calcium' },
    minimumDistanceMinutes: 120,
    foodOffsetMinutes: null,
    preferredTimeFrom: null,
    preferredTimeTo: null,
    explanation: 'Calcium reduces iron absorption.',
    origin: 'user',
    enabled: true,
    summary: '',
    ...overrides,
  };
}

const calcium = intake({
  planDoseId: 'dose-calcium',
  productId: 'product-calcium',
  productName: 'Calcium 500 mg',
  substanceIds: ['substance-calcium'],
  scheduledTime: '12:00',
});

describe('minimum separation', () => {
  it('is quiet when the gap is large enough', () => {
    const violations = evaluateConstraints({
      intakes: [intake({ scheduledTime: '18:30' }), calcium],
      constraints: [constraint()],
      mealTimes,
    });

    expect(violations).toHaveLength(0);
  });

  it('fires when the gap is too small, naming both products and the shortfall', () => {
    const violations = evaluateConstraints({
      // The brief's example: moving iron to 12:00 next to a conflicting substance.
      intakes: [intake({ scheduledTime: '12:00' }), calcium],
      constraints: [constraint()],
      mealTimes,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('Iron 20 mg');
    expect(violations[0]?.message).toContain('Calcium 500 mg');
    expect(violations[0]?.actualDistanceMinutes).toBe(0);
    expect(violations[0]?.requiredDistanceMinutes).toBe(120);
    expect(violations[0]?.explanation).toBe('Calcium reduces iron absorption.');
    expect(violations[0]?.occurrenceKeys).toHaveLength(2);
  });

  it('reports a clash once, not once per direction', () => {
    // A rule whose two sides both match both intakes would double-report.
    const violations = evaluateConstraints({
      intakes: [
        intake({ scheduledTime: '12:00' }),
        intake({ planDoseId: 'dose-iron-2', scheduledTime: '12:30' }),
      ],
      constraints: [
        constraint({
          source: { kind: 'substance', substanceId: 'substance-iron', name: 'Iron' },
          target: { kind: 'substance', substanceId: 'substance-iron', name: 'Iron' },
        }),
      ],
      mealTimes,
    });

    expect(violations).toHaveLength(1);
  });

  it('matches a substance across different products', () => {
    // One rule, written once, covers a second calcium product added later.
    const otherCalcium = intake({
      planDoseId: 'dose-calcium-2',
      productId: 'product-multivitamin',
      productName: 'Multivitamin',
      substanceIds: ['substance-calcium', 'substance-zinc'],
      scheduledTime: '12:15',
    });

    const violations = evaluateConstraints({
      intakes: [intake({ scheduledTime: '12:00' }), otherCalcium],
      constraints: [constraint()],
      mealTimes,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('Multivitamin');
  });

  it('matches a whole category', () => {
    const violations = evaluateConstraints({
      intakes: [intake({ scheduledTime: '12:00' }), calcium],
      constraints: [
        constraint({
          source: { kind: 'product', productId: 'product-iron', name: 'Iron 20 mg' },
          target: { kind: 'category', category: 'supplement' },
          minimumDistanceMinutes: 60,
        }),
      ],
      mealTimes,
    });

    expect(violations).toHaveLength(1);
  });

  it('ignores a disabled rule', () => {
    const violations = evaluateConstraints({
      intakes: [intake({ scheduledTime: '12:00' }), calcium],
      constraints: [constraint({ enabled: false })],
      mealTimes,
    });

    expect(violations).toHaveLength(0);
  });

  it('never compares an intake with itself', () => {
    const violations = evaluateConstraints({
      intakes: [intake({ scheduledTime: '12:00' })],
      constraints: [
        constraint({
          source: { kind: 'substance', substanceId: 'substance-iron', name: 'Iron' },
          target: { kind: 'substance', substanceId: 'substance-iron', name: 'Iron' },
        }),
      ],
      mealTimes,
    });

    expect(violations).toHaveLength(0);
  });
});

describe('avoid together', () => {
  it('fires only when two intakes share a time', () => {
    const rule = constraint({ constraintType: 'avoid_together', minimumDistanceMinutes: null });

    expect(
      evaluateConstraints({
        intakes: [intake({ scheduledTime: '12:00' }), calcium],
        constraints: [rule],
        mealTimes,
      }),
    ).toHaveLength(1);

    expect(
      evaluateConstraints({
        intakes: [intake({ scheduledTime: '12:01' }), calcium],
        constraints: [rule],
        mealTimes,
      }),
    ).toHaveLength(0);
  });
});

describe('food constraints', () => {
  it('with_food fires when the dose is far from every meal', () => {
    const rule = constraint({
      constraintType: 'with_food',
      target: null,
      minimumDistanceMinutes: null,
    });

    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '18:30' })], constraints: [rule], mealTimes }),
    ).toHaveLength(0);

    const violations = evaluateConstraints({
      intakes: [intake({ scheduledTime: '15:00' })],
      constraints: [rule],
      mealTimes,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('with food');
  });

  it('without_food fires when the dose is close to a meal', () => {
    const rule = constraint({
      constraintType: 'without_food',
      target: null,
      minimumDistanceMinutes: null,
      foodOffsetMinutes: 60,
    });

    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '18:30' })], constraints: [rule], mealTimes }),
    ).toHaveLength(1);

    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '16:00' })], constraints: [rule], mealTimes }),
    ).toHaveLength(0);
  });

  it('before_food requires the dose to precede a meal inside the window', () => {
    const rule = constraint({
      constraintType: 'before_food',
      target: { kind: 'meal', meal: 'breakfast' },
      minimumDistanceMinutes: null,
      foodOffsetMinutes: 30,
    });

    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '07:45' })], constraints: [rule], mealTimes }),
    ).toHaveLength(0);
    // After breakfast, not before it.
    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '08:15' })], constraints: [rule], mealTimes }),
    ).toHaveLength(1);
    // Too early to count.
    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '06:00' })], constraints: [rule], mealTimes }),
    ).toHaveLength(1);
  });

  it('after_food requires the dose to follow a meal inside the window', () => {
    const rule = constraint({
      constraintType: 'after_food',
      target: { kind: 'meal', meal: 'dinner' },
      minimumDistanceMinutes: null,
      foodOffsetMinutes: 60,
    });

    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '19:00' })], constraints: [rule], mealTimes }),
    ).toHaveLength(0);
    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '18:00' })], constraints: [rule], mealTimes }),
    ).toHaveLength(1);
  });

  it('stays silent when the anchor meal is not configured', () => {
    // Better to say nothing than to warn against a meal time we do not have.
    const violations = evaluateConstraints({
      intakes: [intake({ scheduledTime: '15:00' })],
      constraints: [
        constraint({ constraintType: 'with_food', target: { kind: 'meal', meal: 'dinner' } }),
      ],
      mealTimes: { breakfast: '08:00', dinner: null },
    });

    expect(violations).toHaveLength(0);
  });
});

describe('preferred time of day', () => {
  const rule = constraint({
    constraintType: 'preferred_time_of_day',
    target: null,
    minimumDistanceMinutes: null,
    preferredTimeFrom: '06:00',
    preferredTimeTo: '10:00',
  });

  it('accepts a time inside the window and flags one outside', () => {
    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '08:00' })], constraints: [rule], mealTimes }),
    ).toHaveLength(0);
    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '21:30' })], constraints: [rule], mealTimes }),
    ).toHaveLength(1);
  });

  it('handles a window that wraps past midnight', () => {
    const overnight = constraint({
      constraintType: 'preferred_time_of_day',
      target: null,
      minimumDistanceMinutes: null,
      preferredTimeFrom: '22:00',
      preferredTimeTo: '06:00',
    });

    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '23:30' })], constraints: [overnight], mealTimes }),
    ).toHaveLength(0);
    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '05:00' })], constraints: [overnight], mealTimes }),
    ).toHaveLength(0);
    expect(
      evaluateConstraints({ intakes: [intake({ scheduledTime: '12:00' })], constraints: [overnight], mealTimes }),
    ).toHaveLength(1);
  });
});

describe('acknowledgements', () => {
  it('silences a warning the user consciously overrode', () => {
    const intakes = [intake({ scheduledTime: '12:00' }), calcium];
    const rule = constraint();

    expect(evaluateConstraints({ intakes, constraints: [rule], mealTimes })).toHaveLength(1);

    const acknowledged = new Set(
      intakes.map((entry) => acknowledgementKey(entry.occurrenceKey, rule.id)),
    );
    expect(
      evaluateConstraints({ intakes, constraints: [rule], mealTimes, acknowledged }),
    ).toHaveLength(0);
  });

  it('keeps warning while only one side was acknowledged', () => {
    const intakes = [intake({ scheduledTime: '12:00' }), calcium];
    const rule = constraint();
    const acknowledged = new Set([acknowledgementKey(intakes[0]!.occurrenceKey, rule.id)]);

    expect(
      evaluateConstraints({ intakes, constraints: [rule], mealTimes, acknowledged }),
    ).toHaveLength(1);
  });
});

describe('ordering', () => {
  it('puts warnings before information', () => {
    const violations = evaluateConstraints({
      intakes: [intake({ scheduledTime: '12:00' }), calcium],
      constraints: [
        constraint({ id: 'info', severity: 'information' }),
        constraint({ id: 'warn', severity: 'warning' }),
      ],
      mealTimes,
    });

    expect(violations.map((violation) => violation.severity)).toEqual(['warning', 'information']);
  });
});

describe('rule summaries', () => {
  it('reads back as the sentence the user meant', () => {
    expect(describeConstraint(constraint())).toBe('Keep Iron at least 2 hours away from Calcium');

    expect(
      describeConstraint(constraint({ constraintType: 'avoid_together' })),
    ).toBe('Do not take Iron together with Calcium');

    expect(
      describeConstraint(
        constraint({ constraintType: 'with_food', target: null, foodOffsetMinutes: 30 }),
      ),
    ).toBe('Take Iron with food (within 30 minutes)');

    expect(
      describeConstraint(
        constraint({
          constraintType: 'preferred_time_of_day',
          target: null,
          preferredTimeFrom: '06:00',
          preferredTimeTo: '10:00',
        }),
      ),
    ).toBe('Prefer Iron between 06:00 and 10:00');

    expect(
      describeConstraint(
        constraint({
          source: { kind: 'category', category: 'medication' },
          target: { kind: 'category', category: 'supplement' },
          minimumDistanceMinutes: 60,
        }),
      ),
    ).toBe('Keep any medication at least 1 hour away from any supplement');
  });
});
