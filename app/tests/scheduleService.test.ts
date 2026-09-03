import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../src/application/errors.js';
import { createTestApp, ironSupplement, rosuvastatin, type TestApp } from './support/testApp.js';

/**
 * Builds the example cabinet from the brief:
 *
 *   08:00  Magnesium
 *   12:30  Magnesium
 *   18:30  Iron (with dinner)
 *   21:30  Rosuvastatin
 */
async function seedCabinet(app: TestApp) {
  const statin = await app.services.products.create(rosuvastatin);
  const iron = await app.services.products.create(ironSupplement);
  const magnesium = await app.services.products.create({
    name: 'Magnesium 150 mg',
    category: 'supplement',
    dosageForm: 'powder',
    packageSize: 300,
    packageUnit: 'grams',
    ingredients: [{ substanceName: 'Magnesium', amount: 150, unit: 'mg' }],
  });

  await app.services.treatments.start({
    productId: statin.id,
    indication: 'LDL reduction',
    startedOn: '2026-09-01',
    plan: {
      recurrenceType: 'daily',
      doses: [
        { timingType: 'fixed', targetTime: '21:30', doseAmount: 5, doseUnit: 'mg', packageUnitQuantity: 1 },
      ],
    },
  });

  await app.services.treatments.start({
    productId: iron.id,
    startedOn: '2026-09-01',
    plan: {
      recurrenceType: 'daily',
      doses: [
        {
          timingType: 'meal_relative',
          mealReference: 'dinner',
          doseAmount: 1,
          doseUnit: 'tablet',
          packageUnitQuantity: 1,
        },
      ],
    },
  });

  const magnesiumTreatment = await app.services.treatments.start({
    productId: magnesium.id,
    startedOn: '2026-09-01',
    plan: {
      recurrenceType: 'daily',
      doses: [
        { timingType: 'fixed', targetTime: '08:00', doseAmount: 1, doseUnit: 'dose', packageUnitQuantity: 5 },
        { timingType: 'fixed', targetTime: '12:30', doseAmount: 1, doseUnit: 'dose', packageUnitQuantity: 5 },
      ],
    },
  });

  return { statin, iron, magnesium, magnesiumTreatment };
}

describe('daily schedule', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-09-03T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers "what do I take today, and when"', async () => {
    await seedCabinet(app);
    const timeline = await app.services.schedule.dayTimeline('2026-09-03');

    expect(
      timeline.slots.map((slot) => [slot.time, slot.intakes.map((i) => i.productName)]),
    ).toEqual([
      ['08:00', ['Magnesium 150 mg']],
      ['12:30', ['Magnesium 150 mg']],
      ['18:30', ['Iron 20 mg + Vitamin C']],
      ['21:30', ['Rosuvastatin 5 mg']],
    ]);
  });

  it('resolves meal-relative doses from the configured day profile', async () => {
    await seedCabinet(app);
    await app.services.settings.updateDayProfile({ dinnerTime: '19:45' });

    const timeline = await app.services.schedule.dayTimeline('2026-09-03');
    const ironSlot = timeline.slots.find((slot) =>
      slot.intakes.some((intake) => intake.productName.startsWith('Iron')),
    );

    expect(ironSlot?.time).toBe('19:45');
    expect(ironSlot?.intakes[0]?.timeIsDerived).toBe(true);
  });

  it('stamps each occurrence with the right absolute instant for the timezone', async () => {
    await seedCabinet(app);
    const timeline = await app.services.schedule.dayTimeline('2026-09-03');

    expect(timeline.timeZone).toBe('Europe/Berlin');
    expect(timeline.slots.at(-1)?.intakes[0]?.scheduledAt).toBe('2026-09-03T19:30:00.000Z');
  });

  it('defaults to today in the configured timezone', async () => {
    await seedCabinet(app);
    expect(await app.services.schedule.today()).toBe('2026-09-03');

    const timeline = await app.services.schedule.dayTimeline();
    expect(timeline.date).toBe('2026-09-03');
  });

  it('reports the next pending intake, rolling into tomorrow', async () => {
    await seedCabinet(app);

    // 08:00 UTC is 10:00 in Berlin, so the 08:00 dose has passed.
    const next = await app.services.schedule.nextIntake();
    expect(next?.scheduledTime).toBe('12:30');

    const lateApp = await createTestApp('2026-09-03T20:00:00.000Z');
    try {
      await seedCabinet(lateApp);
      const tomorrow = await lateApp.services.schedule.nextIntake();
      expect(tomorrow?.occurrenceDate).toBe('2026-09-04');
      expect(tomorrow?.scheduledTime).toBe('08:00');
    } finally {
      await lateApp.close();
    }
  });
});

describe('moving an intake', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-09-03T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('moves one day only and leaves the plan version untouched', async () => {
    const { magnesiumTreatment } = await seedCabinet(app);
    const before = await app.services.schedule.dayTimeline('2026-09-03');
    const eightAm = before.slots[0]?.intakes[0];

    const moved = await app.services.schedule.moveIntake({
      planDoseId: eightAm?.planDoseId,
      occurrenceDate: '2026-09-03',
      time: '10:00',
      reason: 'slept in',
    });

    expect(moved.slots.map((slot) => slot.time)).toEqual(['10:00', '12:30', '18:30', '21:30']);
    expect(moved.slots[0]?.intakes[0]?.movedByUser).toBe(true);

    // Tomorrow is back on plan...
    const tomorrow = await app.services.schedule.dayTimeline('2026-09-04');
    expect(tomorrow.slots[0]?.time).toBe('08:00');

    // ...and the plan itself never changed: still one version, no new events.
    const history = await app.services.treatments.history(magnesiumTreatment.id);
    expect(history.planVersions).toHaveLength(1);
    expect(history.events).toHaveLength(1);
  });

  it('is idempotent and reversible', async () => {
    await seedCabinet(app);
    const first = await app.services.schedule.dayTimeline('2026-09-03');
    const planDoseId = first.slots[0]?.intakes[0]?.planDoseId;

    await app.services.schedule.moveIntake({ planDoseId, occurrenceDate: '2026-09-03', time: '10:00' });
    const second = await app.services.schedule.moveIntake({
      planDoseId,
      occurrenceDate: '2026-09-03',
      time: '11:00',
    });
    expect(second.slots[0]?.time).toBe('11:00');

    const overrides = app.opened.sqlite
      .prepare(`SELECT COUNT(*) AS total FROM schedule_override`)
      .get() as { total: number };
    expect(overrides.total).toBe(1);

    const cleared = await app.services.schedule.clearIntakeOverride({
      planDoseId,
      occurrenceDate: '2026-09-03',
    });
    expect(cleared.slots[0]?.time).toBe('08:00');
  });

  it('rejects a move for a dose that does not exist', async () => {
    await expect(
      app.services.schedule.moveIntake({
        planDoseId: 'missing',
        occurrenceDate: '2026-09-03',
        time: '10:00',
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('the timeline across a plan change', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-09-03T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('shows the old plan before the changeover and the new one after, with no gap', async () => {
    const product = await app.services.products.create(rosuvastatin);
    const treatment = await app.services.treatments.start({
      productId: product.id,
      startedOn: '2026-09-01',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 5, doseUnit: 'mg' }],
      },
    });

    await app.services.treatments.changePlan(treatment.id, {
      effectiveFrom: '2026-12-01',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '08:00', doseAmount: 10, doseUnit: 'mg' }],
      },
    });

    const lastOldDay = await app.services.schedule.dayTimeline('2026-11-30');
    expect(lastOldDay.slots).toHaveLength(1);
    expect(lastOldDay.slots[0]?.time).toBe('21:30');
    expect(lastOldDay.slots[0]?.intakes[0]?.doseAmount).toBe(5);

    const firstNewDay = await app.services.schedule.dayTimeline('2026-12-01');
    expect(firstNewDay.slots).toHaveLength(1);
    expect(firstNewDay.slots[0]?.time).toBe('08:00');
    expect(firstNewDay.slots[0]?.intakes[0]?.doseAmount).toBe(10);
  });

  it('keeps showing past days after the treatment is stopped', async () => {
    const product = await app.services.products.create(rosuvastatin);
    const treatment = await app.services.treatments.start({
      productId: product.id,
      startedOn: '2026-09-01',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 5, doseUnit: 'mg' }],
      },
    });

    await app.services.treatments.stop(treatment.id, { endedOn: '2026-09-30' });

    // The past is intact...
    expect((await app.services.schedule.dayTimeline('2026-09-15')).slots).toHaveLength(1);
    expect((await app.services.schedule.dayTimeline('2026-09-30')).slots).toHaveLength(1);
    // ...and the future is empty.
    expect((await app.services.schedule.dayTimeline('2026-10-01')).slots).toHaveLength(0);
  });

  it('hides doses while a treatment is paused and shows them again after', async () => {
    const product = await app.services.products.create(rosuvastatin);
    const treatment = await app.services.treatments.start({
      productId: product.id,
      startedOn: '2026-09-01',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 5, doseUnit: 'mg' }],
      },
    });

    await app.services.treatments.pause(treatment.id, { pausedFrom: '2026-09-10' });
    await app.services.treatments.resume(treatment.id, { resumedOn: '2026-09-15' });

    expect((await app.services.schedule.dayTimeline('2026-09-09')).slots).toHaveLength(1);
    expect((await app.services.schedule.dayTimeline('2026-09-12')).slots).toHaveLength(0);
    expect((await app.services.schedule.dayTimeline('2026-09-15')).slots).toHaveLength(1);
  });
});
