import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/application/errors.js';
import { createTestApp, type TestApp } from './support/testApp.js';

/**
 * The brief's own scenario: iron and calcium must stay apart, and moving iron
 * onto calcium's slot has to warn — while still letting the user go ahead.
 */
async function seedCabinet(app: TestApp) {
  const iron = await app.services.products.create({
    name: 'Iron 20 mg',
    category: 'supplement',
    dosageForm: 'tablet',
    packageSize: 60,
    packageUnit: 'tablets',
    ingredients: [{ substanceName: 'Iron', amount: 20, unit: 'mg' }],
  });
  const calcium = await app.services.products.create({
    name: 'Calcium 500 mg',
    category: 'supplement',
    dosageForm: 'tablet',
    packageSize: 60,
    packageUnit: 'tablets',
    ingredients: [{ substanceName: 'Calcium', amount: 500, unit: 'mg' }],
  });

  const ironTreatment = await app.services.treatments.start({
    productId: iron.id,
    startedOn: '2026-09-01',
    plan: {
      recurrenceType: 'daily',
      doses: [{ timingType: 'fixed', targetTime: '18:30', doseAmount: 1, doseUnit: 'tablet' }],
    },
  });
  await app.services.treatments.start({
    productId: calcium.id,
    startedOn: '2026-09-01',
    plan: {
      recurrenceType: 'daily',
      doses: [{ timingType: 'fixed', targetTime: '12:00', doseAmount: 1, doseUnit: 'tablet' }],
    },
  });

  const substances = await app.services.products.listSubstances();
  const ironSubstance = substances.find((entry) => entry.name === 'Iron');
  const calciumSubstance = substances.find((entry) => entry.name === 'Calcium');

  return { iron, calcium, ironTreatment, ironSubstance, calciumSubstance };
}

async function ironDoseId(app: TestApp, treatmentId: string): Promise<string> {
  const treatment = await app.services.treatments.findById(treatmentId);
  return treatment.currentPlan?.doses[0]?.id as string;
}

describe('constraints', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-09-03T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('stores a rule and reads it back as a sentence', async () => {
    const { ironSubstance, calciumSubstance } = await seedCabinet(app);

    const constraint = await app.services.constraints.create({
      constraintType: 'minimum_separation',
      source: { kind: 'substance', substanceId: ironSubstance?.id },
      target: { kind: 'substance', substanceId: calciumSubstance?.id },
      minimumDistanceMinutes: 120,
      explanation: 'Calcium reduces iron absorption.',
    });

    expect(constraint.summary).toBe('Keep Iron at least 2 hours away from Calcium');
    expect(constraint.origin).toBe('user');
    expect(constraint.enabled).toBe(true);
  });

  it('rejects a rule that cannot be evaluated', async () => {
    await expect(
      app.services.constraints.create({
        constraintType: 'minimum_separation',
        source: { kind: 'category', category: 'medication' },
        // no target, no distance
      }),
    ).rejects.toThrow(ValidationError);

    // The specifics travel in `details`, which the UI shows next to the field.
    await expect(
      app.services.constraints.create({
        constraintType: 'preferred_time_of_day',
        source: { kind: 'category', category: 'medication' },
      }),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      details: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('preferredTimeFrom') }),
      ]),
    });

    // A meal cannot be the thing being scheduled, only the thing scheduled around.
    await expect(
      app.services.constraints.create({
        constraintType: 'with_food',
        source: { kind: 'meal', meal: 'dinner' },
      }),
    ).rejects.toThrow(ValidationError);
  });

  describe('on the daily timeline', () => {
    beforeEach(async () => {
      const { ironSubstance, calciumSubstance } = await seedCabinet(app);
      await app.services.constraints.create({
        constraintType: 'minimum_separation',
        source: { kind: 'substance', substanceId: ironSubstance?.id },
        target: { kind: 'substance', substanceId: calciumSubstance?.id },
        minimumDistanceMinutes: 120,
        explanation: 'Calcium reduces iron absorption.',
      });
    });

    it('is quiet while the schedule respects the rule', async () => {
      const timeline = await app.services.schedule.dayTimeline('2026-09-03');
      expect(timeline.violations).toHaveLength(0);
    });

    it('warns once iron is moved next to calcium', async () => {
      const timeline = await app.services.schedule.dayTimeline('2026-09-03');
      const iron = timeline.slots
        .flatMap((slot) => slot.intakes)
        .find((intake) => intake.productName.startsWith('Iron'));

      const moved = await app.services.schedule.moveIntake({
        planDoseId: iron?.planDoseId,
        occurrenceDate: '2026-09-03',
        time: '12:00',
      });

      expect(moved.violations).toHaveLength(1);
      expect(moved.violations[0]?.severity).toBe('warning');
      expect(moved.violations[0]?.message).toContain('Iron 20 mg');
      expect(moved.violations[0]?.message).toContain('Calcium 500 mg');
      expect(moved.violations[0]?.explanation).toBe('Calcium reduces iron absorption.');

      // The move went through regardless: a warning never blocks.
      expect(moved.slots.find((slot) => slot.time === '12:00')?.intakes).toHaveLength(2);
    });

    it('previews the clash before anything is saved', async () => {
      const timeline = await app.services.schedule.dayTimeline('2026-09-03');
      const iron = timeline.slots
        .flatMap((slot) => slot.intakes)
        .find((intake) => intake.productName.startsWith('Iron'));

      const preview = await app.services.schedule.previewMove({
        planDoseId: iron?.planDoseId,
        occurrenceDate: '2026-09-03',
        time: '12:30',
      });

      expect(preview.currentViolations).toHaveLength(0);
      expect(preview.violations).toHaveLength(1);

      // Nothing was written: the timeline is untouched.
      const after = await app.services.schedule.dayTimeline('2026-09-03');
      expect(after.slots.find((slot) => slot.time === '18:30')).toBeDefined();
      expect(after.violations).toHaveLength(0);
    });

    it('stops warning once the user acknowledges the clash', async () => {
      const timeline = await app.services.schedule.dayTimeline('2026-09-03');
      const iron = timeline.slots
        .flatMap((slot) => slot.intakes)
        .find((intake) => intake.productName.startsWith('Iron'));

      const warned = await app.services.schedule.moveIntake({
        planDoseId: iron?.planDoseId,
        occurrenceDate: '2026-09-03',
        time: '12:00',
      });
      const constraintId = warned.violations[0]?.constraintId as string;

      const acknowledged = await app.services.schedule.moveIntake({
        planDoseId: iron?.planDoseId,
        occurrenceDate: '2026-09-03',
        time: '12:00',
        acknowledgeConstraintIds: [constraintId],
      });

      // Only the moved occurrence carries the acknowledgement, and the rule
      // needs every involved occurrence waved through before it goes quiet.
      expect(acknowledged.violations).toHaveLength(1);

      const calciumIntake = acknowledged.slots
        .flatMap((slot) => slot.intakes)
        .find((intake) => intake.productName.startsWith('Calcium'));

      await app.services.schedule.moveIntake({
        planDoseId: calciumIntake?.planDoseId,
        occurrenceDate: '2026-09-03',
        time: '12:00',
        acknowledgeConstraintIds: [constraintId],
      });

      const quiet = await app.services.schedule.dayTimeline('2026-09-03');
      expect(quiet.violations).toHaveLength(0);
    });

    it('warns again the next day, which was never acknowledged', async () => {
      const timeline = await app.services.schedule.dayTimeline('2026-09-03');
      const iron = timeline.slots
        .flatMap((slot) => slot.intakes)
        .find((intake) => intake.productName.startsWith('Iron'));

      await app.services.schedule.moveIntake({
        planDoseId: iron?.planDoseId,
        occurrenceDate: '2026-09-04',
        time: '12:00',
      });

      expect((await app.services.schedule.dayTimeline('2026-09-04')).violations).toHaveLength(1);
      expect((await app.services.schedule.dayTimeline('2026-09-05')).violations).toHaveLength(0);
    });

    it('goes quiet when the rule is disabled, and speaks up again when re-enabled', async () => {
      const timeline = await app.services.schedule.dayTimeline('2026-09-03');
      const iron = timeline.slots
        .flatMap((slot) => slot.intakes)
        .find((intake) => intake.productName.startsWith('Iron'));

      await app.services.schedule.moveIntake({
        planDoseId: iron?.planDoseId,
        occurrenceDate: '2026-09-03',
        time: '12:00',
      });

      const [constraint] = await app.services.constraints.list();
      await app.services.constraints.setEnabled(constraint?.id as string, false);
      expect((await app.services.schedule.dayTimeline('2026-09-03')).violations).toHaveLength(0);

      await app.services.constraints.setEnabled(constraint?.id as string, true);
      expect((await app.services.schedule.dayTimeline('2026-09-03')).violations).toHaveLength(1);
    });

    it('drops the warning when the rule is deleted', async () => {
      const timeline = await app.services.schedule.dayTimeline('2026-09-03');
      const iron = timeline.slots
        .flatMap((slot) => slot.intakes)
        .find((intake) => intake.productName.startsWith('Iron'));

      await app.services.schedule.moveIntake({
        planDoseId: iron?.planDoseId,
        occurrenceDate: '2026-09-03',
        time: '12:00',
      });

      const [constraint] = await app.services.constraints.list();
      await app.services.constraints.delete(constraint?.id as string);

      expect((await app.services.schedule.dayTimeline('2026-09-03')).violations).toHaveLength(0);
    });
  });

  it('applies a substance rule to a product added afterwards', async () => {
    const { ironSubstance, calciumSubstance, ironTreatment } = await seedCabinet(app);
    await app.services.constraints.create({
      constraintType: 'minimum_separation',
      source: { kind: 'substance', substanceId: ironSubstance?.id },
      target: { kind: 'substance', substanceId: calciumSubstance?.id },
      minimumDistanceMinutes: 120,
    });

    // A multivitamin bought later also contains calcium.
    const multivitamin = await app.services.products.create({
      name: 'Multivitamin Complete',
      category: 'supplement',
      dosageForm: 'tablet',
      packageSize: 90,
      packageUnit: 'tablets',
      ingredients: [{ substanceName: 'Calcium' }, { substanceName: 'Zinc' }],
    });
    await app.services.treatments.start({
      productId: multivitamin.id,
      startedOn: '2026-09-01',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '18:00', doseAmount: 1, doseUnit: 'tablet' }],
      },
    });

    // Iron is at 18:30, the multivitamin at 18:00 — half an hour apart.
    const timeline = await app.services.schedule.dayTimeline('2026-09-03');
    expect(timeline.violations).toHaveLength(1);
    expect(timeline.violations[0]?.message).toContain('Multivitamin Complete');

    // And the original rule still covers the original product too.
    const doseId = await ironDoseId(app, ironTreatment.id);
    const moved = await app.services.schedule.moveIntake({
      planDoseId: doseId,
      occurrenceDate: '2026-09-03',
      time: '12:00',
    });
    expect(moved.violations.length).toBeGreaterThanOrEqual(1);
  });

  it('evaluates a with-food rule against the day profile', async () => {
    const { iron } = await seedCabinet(app);
    await app.services.constraints.create({
      constraintType: 'with_food',
      source: { kind: 'product', productId: iron.id },
      foodOffsetMinutes: 30,
      severity: 'information',
    });

    // Iron is at 18:30, dinner is at 18:30 by default: no complaint.
    expect((await app.services.schedule.dayTimeline('2026-09-03')).violations).toHaveLength(0);

    await app.services.settings.updateDayProfile({ dinnerTime: '20:00' });
    const violations = (await app.services.schedule.dayTimeline('2026-09-03')).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('information');
  });
});
