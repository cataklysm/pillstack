import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/application/errors.js';
import { createTestApp, rosuvastatin, type TestApp } from './support/testApp.js';

/**
 * The brief's example, end to end: 100 tablets, one a day, started 3 September.
 * "=> estimated depletion after 100 doses", and skipped doses, pauses, dose
 * changes and manual corrections all have to move that estimate.
 */
async function seed(app: TestApp) {
  const product = await app.services.products.create(rosuvastatin);
  const treatment = await app.services.treatments.start({
    productId: product.id,
    indication: 'LDL reduction',
    startedOn: '2026-09-03',
    plan: {
      recurrenceType: 'daily',
      doses: [
        {
          timingType: 'fixed',
          targetTime: '21:30',
          doseAmount: 5,
          doseUnit: 'mg',
          packageUnitQuantity: 1,
        },
      ],
    },
  });
  await app.services.inventory.addPackage(product.id, { acquiredOn: '2026-09-03', opened: true });

  return { product, treatment };
}

/** The plan dose id for the treatment's current plan. */
async function planDoseId(app: TestApp, treatmentId: string): Promise<string> {
  const treatment = await app.services.treatments.findById(treatmentId);
  return treatment.currentPlan?.doses[0]?.id as string;
}

describe('inventory', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-09-03T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('starts a fresh package at full size minus the first day', async () => {
    const { product } = await seed(app);
    const status = await app.services.inventory.statusFor(product.id);

    expect(status.currentQuantity).toBe(99);
    expect(status.estimatedDailyConsumption).toBe(1);
    expect(status.packages).toHaveLength(1);
    expect(status.packages[0]?.status).toBe('open');
  });

  it('projects depletion 100 doses out', async () => {
    const { product } = await seed(app);
    const status = await app.services.inventory.statusFor(product.id);

    // Started 3 September, one a day: the 100th dose is 11 December, so the
    // 101st day is the first that cannot be covered.
    expect(status.runOutDate).toBe('2026-12-12');
    expect(status.daysOfCover).toBe(100);
  });

  it('sets a reorder date a lead time before running out', async () => {
    const { product } = await seed(app);
    await app.services.inventory.updatePolicy(product.id, { reorderLeadTimeDays: 14 });

    const status = await app.services.inventory.statusFor(product.id);
    expect(status.reorderDate).toBe('2026-11-28');
    expect(status.reorderReason).toBe('lead_time');
    expect(status.reorderDue).toBe(false);
  });

  it('honours a quantity threshold when it fires earlier', async () => {
    const { product } = await seed(app);
    await app.services.inventory.updatePolicy(product.id, {
      reorderLeadTimeDays: 3,
      reorderThresholdQuantity: 30,
    });

    const status = await app.services.inventory.statusFor(product.id);
    expect(status.reorderReason).toBe('threshold_quantity');
    // 99 in stock, one a day: the 30-tablet mark is reached on 11 November.
    expect(status.reorderDate).toBe('2026-11-11');
  });

  it('flags a reorder that is already due', async () => {
    const { product } = await seed(app);
    await app.services.inventory.correctStock(product.id, { countedQuantity: 5 });
    await app.services.inventory.updatePolicy(product.id, { reorderLeadTimeDays: 14 });

    const status = await app.services.inventory.statusFor(product.id);
    expect(status.reorderDue).toBe(true);
    expect(status.runOutDate).toBe('2026-09-09');
  });

  describe('what moves the estimate', () => {
    it('a skipped dose leaves the stock untouched', async () => {
      const { product, treatment } = await seed(app);
      const doseId = await planDoseId(app, treatment.id);

      await app.services.intakeLog.record({
        planDoseId: doseId,
        occurrenceDate: '2026-09-03',
        status: 'skipped',
      });

      const status = await app.services.inventory.statusFor(product.id);
      expect(status.currentQuantity).toBe(100);
      expect(status.runOutDate).toBe('2026-12-13');
    });

    it('a confirmed dose is recorded explicitly rather than inferred', async () => {
      const { product, treatment } = await seed(app);
      const doseId = await planDoseId(app, treatment.id);

      await app.services.intakeLog.record({
        planDoseId: doseId,
        occurrenceDate: '2026-09-03',
        status: 'taken',
      });

      const status = await app.services.inventory.statusFor(product.id);
      // Still 99: the confirmation replaced the inference, it did not add to it.
      expect(status.currentQuantity).toBe(99);

      const ledger = await app.services.inventory.ledgerFor(product.id);
      expect(ledger.map((entry) => entry.transactionType)).toContain('dose_consumed');
    });

    it('undoing a confirmation hands the day back to the plan', async () => {
      const { product, treatment } = await seed(app);
      const doseId = await planDoseId(app, treatment.id);

      await app.services.intakeLog.record({
        planDoseId: doseId,
        occurrenceDate: '2026-09-03',
        status: 'skipped',
      });
      expect((await app.services.inventory.statusFor(product.id)).currentQuantity).toBe(100);

      await app.services.intakeLog.clear({ planDoseId: doseId, occurrenceDate: '2026-09-03' });
      expect((await app.services.inventory.statusFor(product.id)).currentQuantity).toBe(99);
    });

    it('changing a confirmation does not stack two entries', async () => {
      const { product, treatment } = await seed(app);
      const doseId = await planDoseId(app, treatment.id);

      await app.services.intakeLog.record({
        planDoseId: doseId,
        occurrenceDate: '2026-09-03',
        status: 'taken',
      });
      await app.services.intakeLog.record({
        planDoseId: doseId,
        occurrenceDate: '2026-09-03',
        status: 'skipped',
      });

      const status = await app.services.inventory.statusFor(product.id);
      expect(status.currentQuantity).toBe(100);

      const consumed = (await app.services.inventory.ledgerFor(product.id)).filter(
        (entry) => entry.transactionType === 'dose_consumed',
      );
      expect(consumed).toHaveLength(0);
    });

    it('a pause stops consumption and pushes the run-out date back', async () => {
      const later = await createTestApp('2026-09-20T08:00:00.000Z');
      try {
        const { product, treatment } = await seed(later);

        const before = await later.services.inventory.statusFor(product.id);
        expect(before.currentQuantity).toBe(82); // 3 to 20 September inclusive

        await later.services.treatments.pause(treatment.id, {
          pausedFrom: '2026-09-10',
          reason: 'surgery',
        });

        const paused = await later.services.inventory.statusFor(product.id);
        // The eleven paused days are given back.
        expect(paused.currentQuantity).toBe(93);
        expect(paused.runOutDate).toBeNull(); // nothing scheduled while paused

        const ledger = await later.services.inventory.ledgerFor(product.id);
        expect(ledger.some((entry) => entry.transactionType === 'treatment_paused')).toBe(true);
      } finally {
        await later.close();
      }
    });

    it('a dose increase immediately shortens the remaining cover', async () => {
      const { product, treatment } = await seed(app);
      const before = await app.services.inventory.statusFor(product.id);

      await app.services.treatments.changePlan(treatment.id, {
        effectiveFrom: '2026-10-01',
        changeReason: 'LDL still above target',
        plan: {
          recurrenceType: 'daily',
          doses: [
            {
              timingType: 'fixed',
              targetTime: '21:30',
              doseAmount: 10,
              doseUnit: 'mg',
              packageUnitQuantity: 2,
            },
          ],
        },
      });

      const after = await app.services.inventory.statusFor(product.id);
      expect(after.currentQuantity).toBe(before.currentQuantity);
      // Same stock, twice the dose from October: it runs out much sooner.
      expect(after.runOutDate!.localeCompare(before.runOutDate!)).toBeLessThan(0);
      // 27 days at 1/day leaves 72 on 30 September; 2/day covers 1 October to
      // 5 November exactly, so 6 November is the first day that falls short.
      expect(after.runOutDate).toBe('2026-11-06');
    });

    it('an intermittent schedule stretches the package', async () => {
      const { product, treatment } = await seed(app);

      await app.services.treatments.changePlan(treatment.id, {
        effectiveFrom: '2026-09-04',
        plan: {
          recurrenceType: 'weekdays',
          weekdayMask: 0b0010101, // Mon, Wed, Fri
          doses: [
            {
              timingType: 'fixed',
              targetTime: '21:30',
              doseAmount: 5,
              doseUnit: 'mg',
              packageUnitQuantity: 1,
            },
          ],
        },
      });

      const status = await app.services.inventory.statusFor(product.id);
      expect(status.estimatedDailyConsumption).toBeCloseTo(3 / 7, 1);
      expect(status.daysOfCover).toBeGreaterThan(200);
    });
  });

  describe('corrections', () => {
    it('takes the counted figure as the truth and projects from there', async () => {
      const later = await createTestApp('2026-09-20T08:00:00.000Z');
      try {
        const { product } = await seed(later);
        expect((await later.services.inventory.statusFor(product.id)).currentQuantity).toBe(82);

        const corrected = await later.services.inventory.correctStock(product.id, {
          countedQuantity: 75,
          note: 'recounted the blister packs',
        });
        expect(corrected.currentQuantity).toBe(75);

        const ledger = await later.services.inventory.ledgerFor(product.id);
        const correction = ledger.find((entry) => entry.transactionType === 'manual_correction');
        // Both the counted figure and the derived delta are kept.
        expect(correction?.absoluteQuantity).toBe(75);
        expect(correction?.quantityDelta).toBe(-25);
      } finally {
        await later.close();
      }
    });

    it('keeps counting down from the correction on later days', async () => {
      const later = await createTestApp('2026-09-25T08:00:00.000Z');
      try {
        const { product } = await seed(later);

        // Counted 75 on the 20th; five more days of doses have passed since.
        await later.services.inventory.correctStock(product.id, {
          countedQuantity: 75,
          effectiveOn: '2026-09-20',
        });

        expect((await later.services.inventory.statusFor(product.id)).currentQuantity).toBe(70);
      } finally {
        await later.close();
      }
    });

    it('lets a newer correction supersede an older one', async () => {
      const later = await createTestApp('2026-09-25T08:00:00.000Z');
      try {
        const { product } = await seed(later);

        await later.services.inventory.correctStock(product.id, {
          countedQuantity: 75,
          effectiveOn: '2026-09-20',
        });
        await later.services.inventory.correctStock(product.id, {
          countedQuantity: 60,
          effectiveOn: '2026-09-23',
        });

        // Only the newer count matters, minus the two days after it.
        expect((await later.services.inventory.statusFor(product.id)).currentQuantity).toBe(58);
      } finally {
        await later.close();
      }
    });

    it('refuses a count dated in the future', async () => {
      const { product } = await seed(app);
      await expect(
        app.services.inventory.correctStock(product.id, {
          countedQuantity: 50,
          effectiveOn: '2026-12-01',
        }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('packages', () => {
    it('adds a second package on top of the first', async () => {
      const { product } = await seed(app);
      await app.services.inventory.addPackage(product.id, {});

      const status = await app.services.inventory.statusFor(product.id);
      expect(status.currentQuantity).toBe(199);
      expect(status.packages).toHaveLength(2);
    });

    it('accepts a part-used package', async () => {
      const { product } = await seed(app);
      const status = await app.services.inventory.addPackage(product.id, { quantity: 40 });
      expect(status.currentQuantity).toBe(139);
    });

    it('refuses more than fits in the package', async () => {
      const { product } = await seed(app);
      await expect(
        app.services.inventory.addPackage(product.id, { quantity: 500 }),
      ).rejects.toThrow(ConflictError);
    });

    it('flags a package that expires before the stock is used up', async () => {
      const { product } = await seed(app);
      const status = await app.services.inventory.addPackage(product.id, {
        expirationDate: '2026-10-01',
      });

      expect(status.earliestExpiration).toBe('2026-10-01');
      expect(status.expiresBeforeDepletion).toBe(true);
    });

    it('discards a package and removes its stock', async () => {
      const { product } = await seed(app);
      const withPackages = await app.services.inventory.statusFor(product.id);
      const packageId = withPackages.packages[0]?.id as string;

      const status = await app.services.inventory.discardPackage(product.id, packageId, 'spilled');
      expect(status.currentQuantity).toBe(0);
      expect(status.packages).toHaveLength(0);

      await expect(
        app.services.inventory.discardPackage(product.id, packageId),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('products without a schedule', () => {
    it('reports stock but no run-out date', async () => {
      const product = await app.services.products.create(rosuvastatin);
      await app.services.inventory.addPackage(product.id, {});

      const status = await app.services.inventory.statusFor(product.id);
      expect(status.currentQuantity).toBe(100);
      expect(status.runOutDate).toBeNull();
      expect(status.daysOfCover).toBeNull();
      expect(status.reorderDate).toBeNull();
    });
  });

  describe('logged-only products', () => {
    it('does not infer consumption from the plan', async () => {
      const { product, treatment } = await seed(app);
      await app.services.inventory.updatePolicy(product.id, { consumptionSource: 'logged' });

      // Nothing confirmed yet, so nothing has left the package.
      expect((await app.services.inventory.statusFor(product.id)).currentQuantity).toBe(100);

      const doseId = await planDoseId(app, treatment.id);
      await app.services.intakeLog.record({
        planDoseId: doseId,
        occurrenceDate: '2026-09-03',
        status: 'taken',
      });

      expect((await app.services.inventory.statusFor(product.id)).currentQuantity).toBe(99);
    });
  });

  describe('the overview', () => {
    it('reports every active product', async () => {
      await seed(app);
      const magnesium = await app.services.products.create({
        name: 'Magnesium 150 mg',
        category: 'supplement',
        dosageForm: 'powder',
        packageSize: 60,
        packageUnit: 'doses',
        ingredients: [{ substanceName: 'Magnesium' }],
      });
      await app.services.inventory.addPackage(magnesium.id, {});

      const statuses = await app.services.inventory.listStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses.map((status) => status.productName).sort()).toEqual([
        'Magnesium 150 mg',
        'Rosuvastatin 5 mg',
      ]);
    });
  });
});
