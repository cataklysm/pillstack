import { describe, expect, it } from 'vitest';
import {
  inferredConsumptionOn,
  loggedOccurrenceKeys,
  plannedConsumptionOn,
  type ConsumptionDose,
} from '../src/domain/inventory/consumption.js';
import {
  correctionDelta,
  currentQuantity,
  inferenceStartDate,
  projectDepletion,
  type LedgerEntry,
} from '../src/domain/inventory/projection.js';

function dose(overrides: Partial<ConsumptionDose> = {}): ConsumptionDose {
  return {
    planDoseId: 'dose-1',
    packageUnitQuantity: 1,
    recurrence: {
      recurrenceType: 'daily',
      intervalDays: null,
      anchorDate: null,
      weekdayMask: null,
    },
    effectivePeriod: { effectiveFrom: '2026-09-03', effectiveTo: null },
    pauses: [],
    ...overrides,
  };
}

const packageOf100: LedgerEntry = {
  transactionType: 'package_added',
  quantityDelta: 100,
  effectiveOn: '2026-09-03',
};

describe('planned consumption', () => {
  it('adds up every dose scheduled on the day', () => {
    const doses = [
      dose({ planDoseId: 'morning' }),
      dose({ planDoseId: 'evening', packageUnitQuantity: 2 }),
    ];
    expect(plannedConsumptionOn(doses, '2026-09-10')).toBe(3);
  });

  it('is zero on days the pattern skips', () => {
    const everyOtherDay = dose({
      recurrence: {
        recurrenceType: 'every_n_days',
        intervalDays: 2,
        anchorDate: '2026-09-03',
        weekdayMask: null,
      },
    });

    expect(plannedConsumptionOn([everyOtherDay], '2026-09-03')).toBe(1);
    expect(plannedConsumptionOn([everyOtherDay], '2026-09-04')).toBe(0);
  });

  it('is zero while the treatment is paused', () => {
    const paused = dose({ pauses: [{ pausedFrom: '2026-09-10', resumedOn: '2026-09-15' }] });

    expect(plannedConsumptionOn([paused], '2026-09-09')).toBe(1);
    expect(plannedConsumptionOn([paused], '2026-09-12')).toBe(0);
    expect(plannedConsumptionOn([paused], '2026-09-15')).toBe(1);
  });

  it('ignores doses that do not draw on stock', () => {
    expect(plannedConsumptionOn([dose({ packageUnitQuantity: null })], '2026-09-10')).toBe(0);
  });
});

describe('inferred consumption', () => {
  const doses = [dose()];

  it('falls back to the plan for occurrences that were never confirmed', () => {
    const options = {
      doses,
      loggedKeys: loggedOccurrenceKeys([]),
      consumptionSource: 'planned' as const,
    };
    expect(inferredConsumptionOn(options, '2026-09-10')).toBe(1);
  });

  it('infers nothing for an occurrence already in the ledger', () => {
    const options = {
      doses,
      loggedKeys: loggedOccurrenceKeys([
        { planDoseId: 'dose-1', occurrenceDate: '2026-09-10', status: 'taken' as const },
      ]),
      consumptionSource: 'planned' as const,
    };

    // The confirmed intake wrote its own dose_consumed row; inferring it again
    // would subtract the dose twice.
    expect(inferredConsumptionOn(options, '2026-09-10')).toBe(0);
    expect(inferredConsumptionOn(options, '2026-09-11')).toBe(1);
  });

  it('infers nothing for a day the user explicitly skipped', () => {
    const options = {
      doses,
      loggedKeys: loggedOccurrenceKeys([
        { planDoseId: 'dose-1', occurrenceDate: '2026-09-10', status: 'skipped' as const },
      ]),
      consumptionSource: 'planned' as const,
    };
    expect(inferredConsumptionOn(options, '2026-09-10')).toBe(0);
  });

  it('infers nothing at all in logged mode', () => {
    const options = {
      doses,
      loggedKeys: loggedOccurrenceKeys([]),
      consumptionSource: 'logged' as const,
    };
    expect(inferredConsumptionOn(options, '2026-09-10')).toBe(0);
  });
});

describe('inference start', () => {
  it('begins when the first package arrived', () => {
    expect(inferenceStartDate([packageOf100])).toBe('2026-09-03');
  });

  it('restarts the day after the most recent correction', () => {
    const ledger: LedgerEntry[] = [
      packageOf100,
      { transactionType: 'manual_correction', quantityDelta: -8, effectiveOn: '2026-09-20' },
      { transactionType: 'manual_correction', quantityDelta: 2, effectiveOn: '2026-10-05' },
    ];
    expect(inferenceStartDate(ledger)).toBe('2026-10-06');
  });

  it('is null for an empty ledger', () => {
    expect(inferenceStartDate([])).toBeNull();
  });
});

describe('current quantity', () => {
  const oneADay = (rate = 1) => () => rate;

  it('subtracts one dose per day since the package was opened', () => {
    // 100 tablets, 1 per day, started 3 September - the brief's own example.
    expect(
      currentQuantity({
        ledger: [packageOf100],
        asOf: '2026-09-03',
        inferredConsumptionOn: oneADay(),
      }),
    ).toBe(99);

    expect(
      currentQuantity({
        ledger: [packageOf100],
        asOf: '2026-09-12',
        inferredConsumptionOn: oneADay(),
      }),
    ).toBe(90);
  });

  it('reaches zero after exactly one package of doses', () => {
    expect(
      currentQuantity({
        ledger: [packageOf100],
        asOf: '2026-12-11',
        inferredConsumptionOn: oneADay(),
      }),
    ).toBe(0);
  });

  it('treats a manual correction as the truth and restarts from it', () => {
    // The plan predicts 82 on 20 September; the drawer actually holds 80.
    const delta = correctionDelta([packageOf100], '2026-09-20', 80);
    expect(delta).toBe(-20); // cancels the package so the ledger sum *is* 80

    const ledger: LedgerEntry[] = [
      packageOf100,
      { transactionType: 'manual_correction', quantityDelta: delta, effectiveOn: '2026-09-20' },
    ];

    expect(
      currentQuantity({ ledger, asOf: '2026-09-20', inferredConsumptionOn: oneADay() }),
    ).toBe(80);
    expect(
      currentQuantity({ ledger, asOf: '2026-09-25', inferredConsumptionOn: oneADay() }),
    ).toBe(75);
  });

  it('lets a later correction supersede an earlier one', () => {
    const first = correctionDelta([packageOf100], '2026-09-20', 80);
    const ledgerAfterFirst: LedgerEntry[] = [
      packageOf100,
      { transactionType: 'manual_correction', quantityDelta: first, effectiveOn: '2026-09-20' },
    ];

    const second = correctionDelta(ledgerAfterFirst, '2026-10-01', 60);
    const ledger: LedgerEntry[] = [
      ...ledgerAfterFirst,
      { transactionType: 'manual_correction', quantityDelta: second, effectiveOn: '2026-10-01' },
    ];

    expect(currentQuantity({ ledger, asOf: '2026-10-01', inferredConsumptionOn: oneADay() })).toBe(60);
    expect(currentQuantity({ ledger, asOf: '2026-10-06', inferredConsumptionOn: oneADay() })).toBe(55);
  });

  it('keeps a package bought after a correction', () => {
    const delta = correctionDelta([packageOf100], '2026-09-20', 80);
    const ledger: LedgerEntry[] = [
      packageOf100,
      { transactionType: 'manual_correction', quantityDelta: delta, effectiveOn: '2026-09-20' },
      { transactionType: 'package_added', quantityDelta: 100, effectiveOn: '2026-09-25' },
    ];

    // 80 counted, five days of doses, plus the new package.
    expect(currentQuantity({ ledger, asOf: '2026-09-25', inferredConsumptionOn: oneADay() })).toBe(175);
  });

  it('counts a second package added later', () => {
    const ledger: LedgerEntry[] = [
      packageOf100,
      { transactionType: 'package_added', quantityDelta: 100, effectiveOn: '2026-10-01' },
    ];

    // 28 days of doses gone, 200 bought.
    expect(
      currentQuantity({ ledger, asOf: '2026-09-30', inferredConsumptionOn: oneADay() }),
    ).toBe(72);
    expect(
      currentQuantity({ ledger, asOf: '2026-10-01', inferredConsumptionOn: oneADay() }),
    ).toBe(171);
  });

  it('subtracts a discarded package', () => {
    const ledger: LedgerEntry[] = [
      packageOf100,
      { transactionType: 'package_discarded', quantityDelta: -40, effectiveOn: '2026-09-10' },
    ];

    expect(
      currentQuantity({ ledger, asOf: '2026-09-10', inferredConsumptionOn: oneADay() }),
    ).toBe(52);
  });

  it('ignores zero-delta annotations', () => {
    const ledger: LedgerEntry[] = [
      packageOf100,
      { transactionType: 'treatment_paused', quantityDelta: 0, effectiveOn: '2026-09-10' },
    ];

    expect(
      currentQuantity({ ledger, asOf: '2026-09-05', inferredConsumptionOn: oneADay() }),
    ).toBe(97);
  });

  it('does not go looking for consumption before there was any stock', () => {
    expect(
      currentQuantity({
        ledger: [packageOf100],
        asOf: '2026-09-01',
        inferredConsumptionOn: oneADay(),
      }),
    ).toBe(0);
  });

  it('handles fractional doses without float noise', () => {
    expect(
      currentQuantity({
        ledger: [{ transactionType: 'package_added', quantityDelta: 30, effectiveOn: '2026-09-03' }],
        asOf: '2026-09-12',
        inferredConsumptionOn: oneADay(0.5),
      }),
    ).toBe(25);
  });
});

describe('depletion projection', () => {
  const daily = (rate: number) => () => rate;

  it('projects the run-out date and days of cover', () => {
    const projection = projectDepletion({
      startQuantity: 90,
      asOf: '2026-09-12',
      plannedConsumptionOn: daily(1),
      reorderLeadTimeDays: 7,
      reorderThresholdQuantity: null,
      reorderThresholdDays: null,
    });

    // 90 left on the evening of the 12th, one a day: the 91st day is the first
    // that cannot be covered.
    expect(projection.runOutDate).toBe('2026-12-12');
    expect(projection.daysOfCover).toBe(91);
    expect(projection.estimatedDailyConsumption).toBe(1);
  });

  it('sets the reorder date a lead time ahead of running out', () => {
    const projection = projectDepletion({
      startQuantity: 20,
      asOf: '2026-09-12',
      plannedConsumptionOn: daily(1),
      reorderLeadTimeDays: 7,
      reorderThresholdQuantity: null,
      reorderThresholdDays: null,
    });

    expect(projection.runOutDate).toBe('2026-10-03');
    expect(projection.reorderDate).toBe('2026-09-26');
    expect(projection.reorderReason).toBe('lead_time');
  });

  it('uses a quantity threshold when it fires first', () => {
    const projection = projectDepletion({
      startQuantity: 20,
      asOf: '2026-09-12',
      plannedConsumptionOn: daily(1),
      reorderLeadTimeDays: 3,
      reorderThresholdQuantity: 12,
      reorderThresholdDays: null,
    });

    // Stock reaches 12 on 20 September, earlier than run-out minus three days.
    expect(projection.reorderDate).toBe('2026-09-20');
    expect(projection.reorderReason).toBe('threshold_quantity');
  });

  it('uses a days-of-cover threshold when it fires first', () => {
    const projection = projectDepletion({
      startQuantity: 20,
      asOf: '2026-09-12',
      plannedConsumptionOn: daily(1),
      reorderLeadTimeDays: 3,
      reorderThresholdQuantity: null,
      reorderThresholdDays: 14,
    });

    expect(projection.runOutDate).toBe('2026-10-03');
    expect(projection.reorderDate).toBe('2026-09-19');
    expect(projection.reorderReason).toBe('threshold_days');
  });

  it('flags a reorder that is already overdue', () => {
    const projection = projectDepletion({
      startQuantity: 3,
      asOf: '2026-09-12',
      plannedConsumptionOn: daily(1),
      reorderLeadTimeDays: 7,
      reorderThresholdQuantity: null,
      reorderThresholdDays: null,
    });

    expect(projection.runOutDate).toBe('2026-09-16');
    expect(projection.reorderDate).toBe('2026-09-09');
    expect(projection.reorderDate! < '2026-09-12').toBe(true);
  });

  it('reports no run-out when nothing is scheduled', () => {
    const projection = projectDepletion({
      startQuantity: 50,
      asOf: '2026-09-12',
      plannedConsumptionOn: daily(0),
      reorderLeadTimeDays: 7,
      reorderThresholdQuantity: null,
      reorderThresholdDays: null,
    });

    expect(projection.runOutDate).toBeNull();
    expect(projection.daysOfCover).toBeNull();
    expect(projection.reorderDate).toBeNull();
    expect(projection.estimatedDailyConsumption).toBe(0);
  });

  it('stretches the run-out date for an intermittent schedule', () => {
    // Every other day: 10 doses cover roughly twice as long.
    const projection = projectDepletion({
      startQuantity: 10,
      asOf: '2026-09-12',
      plannedConsumptionOn: (date) => (date.endsWith('1') || date.endsWith('3') || date.endsWith('5') || date.endsWith('7') || date.endsWith('9') ? 1 : 0),
      reorderLeadTimeDays: 0,
      reorderThresholdQuantity: null,
      reorderThresholdDays: null,
    });

    expect(projection.daysOfCover).toBeGreaterThan(15);
  });

  it('respects a dose change that starts tomorrow', () => {
    // The projection reads the plan day by day, so doubling the dose from
    // 1 October immediately halves the remaining cover.
    const projection = projectDepletion({
      startQuantity: 40,
      asOf: '2026-09-12',
      plannedConsumptionOn: (date) => (date >= '2026-10-01' ? 2 : 1),
      reorderLeadTimeDays: 0,
      reorderThresholdQuantity: null,
      reorderThresholdDays: null,
    });

    // 18 days at 1/day through 30 September leaves 22, then 2/day covers
    // 1-11 October exactly; 12 October is the first day that cannot be met.
    expect(projection.runOutDate).toBe('2026-10-12');
  });
});
