import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/testApp.js';

/**
 * Tidying a day end to end: the proposal comes from the real timeline and the
 * user's real rules, and accepting it writes single-day overrides that leave
 * the plan versions alone.
 */
describe('tidying a day, end to end', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-09-03T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  async function addSupplement(options: {
    name: string;
    time: string;
    substance: string;
    flexibility?: 'fixed' | 'flexible';
  }) {
    const product = await app.services.products.create({
      name: options.name,
      category: 'supplement',
      dosageForm: 'tablet',
      packageSize: 60,
      packageUnit: 'tablets',
      ingredients: [{ substanceName: options.substance }],
    });

    const treatment = await app.services.treatments.start({
      productId: product.id,
      startedOn: '2026-09-01',
      plan: {
        recurrenceType: 'daily',
        doses: [
          {
            timingType: 'fixed',
            targetTime: options.time,
            flexibility: options.flexibility ?? 'flexible',
            doseAmount: 1,
            doseUnit: 'tablet',
          },
        ],
      },
    });

    return { product, treatment };
  }

  it('proposes fewer intake events and explains each move', async () => {
    await addSupplement({ name: 'Vitamin D3', time: '08:00', substance: 'Vitamin D3' });
    await addSupplement({ name: 'Zinc 15 mg', time: '09:00', substance: 'Zinc' });
    await addSupplement({ name: 'Vitamin C', time: '10:00', substance: 'Vitamin C' });

    const proposal = await app.services.schedule.proposeOptimization('2026-09-03');

    expect(proposal.eventsBefore).toBe(3);
    expect(proposal.eventsAfter).toBe(1);
    expect(proposal.moves).toHaveLength(2);
    expect(proposal.moves[0]?.reason).toMatch(/one fewer time/);

    // Proposing changes nothing: the timeline is untouched until it is applied.
    const before = await app.services.schedule.dayTimeline('2026-09-03');
    expect(before.slots).toHaveLength(3);
  });

  it('applies the accepted moves as single-day overrides', async () => {
    const { treatment } = await addSupplement({
      name: 'Vitamin D3',
      time: '08:00',
      substance: 'Vitamin D3',
    });
    await addSupplement({ name: 'Zinc 15 mg', time: '09:00', substance: 'Zinc' });

    const proposal = await app.services.schedule.proposeOptimization('2026-09-03');
    const timeline = await app.services.schedule.applyOptimization({
      date: '2026-09-03',
      moves: proposal.moves.map((move) => ({ planDoseId: move.planDoseId, to: move.to })),
    });

    expect(timeline.slots).toHaveLength(1);
    expect(timeline.slots[0]?.intakes).toHaveLength(2);
    // Exactly one dose moved; the other is the event it joined and was never
    // touched, so it carries no override.
    expect(timeline.slots[0]?.intakes.filter((intake) => intake.movedByUser)).toHaveLength(1);

    // Tomorrow is back on plan, and the plan itself never changed.
    const tomorrow = await app.services.schedule.dayTimeline('2026-09-04');
    expect(tomorrow.slots).toHaveLength(2);

    const history = await app.services.treatments.history(treatment.id);
    expect(history.planVersions).toHaveLength(1);
    expect(history.events).toHaveLength(1);
  });

  it('accepts only the moves the user picked', async () => {
    await addSupplement({ name: 'Vitamin D3', time: '08:00', substance: 'Vitamin D3' });
    await addSupplement({ name: 'Zinc 15 mg', time: '09:00', substance: 'Zinc' });
    await addSupplement({ name: 'Vitamin C', time: '10:00', substance: 'Vitamin C' });

    const proposal = await app.services.schedule.proposeOptimization('2026-09-03');
    const timeline = await app.services.schedule.applyOptimization({
      date: '2026-09-03',
      moves: [
        {
          planDoseId: proposal.moves[0]?.planDoseId as string,
          to: proposal.moves[0]?.to as string,
        },
      ],
    });

    expect(timeline.slots).toHaveLength(2);
  });

  it('will not merge two substances the user keeps apart', async () => {
    await addSupplement({ name: 'Iron 20 mg', time: '09:00', substance: 'Iron' });
    await addSupplement({
      name: 'Calcium 500 mg',
      time: '06:00',
      substance: 'Calcium',
      flexibility: 'fixed',
    });

    const substances = await app.services.products.listSubstances();
    await app.services.constraints.create({
      constraintType: 'minimum_separation',
      source: { kind: 'substance', substanceId: substances.find((s) => s.name === 'Iron')?.id },
      target: { kind: 'substance', substanceId: substances.find((s) => s.name === 'Calcium')?.id },
      minimumDistanceMinutes: 120,
    });

    const proposal = await app.services.schedule.proposeOptimization('2026-09-03');

    expect(proposal.moves).toHaveLength(0);
    expect(proposal.eventsAfter).toBe(2);
    expect(proposal.untouched.some((entry) => entry.reason.includes('safely join'))).toBe(true);
  });

  it('leaves a meal-relative dose where the meal puts it', async () => {
    const product = await app.services.products.create({
      name: 'Iron 20 mg',
      category: 'supplement',
      dosageForm: 'tablet',
      packageSize: 60,
      packageUnit: 'tablets',
      ingredients: [{ substanceName: 'Iron' }],
    });
    await app.services.treatments.start({
      productId: product.id,
      startedOn: '2026-09-01',
      plan: {
        recurrenceType: 'daily',
        doses: [
          { timingType: 'meal_relative', mealReference: 'dinner', doseAmount: 1, doseUnit: 'tablet' },
        ],
      },
    });
    await addSupplement({ name: 'Magnesium', time: '17:30', substance: 'Magnesium' });

    const proposal = await app.services.schedule.proposeOptimization('2026-09-03');

    // Magnesium joins dinner; the meal-relative dose stays put.
    expect(proposal.moves.map((move) => move.productName)).toEqual(['Magnesium']);
    expect(proposal.moves[0]?.to).toBe('18:30');
    expect(proposal.untouched.some((entry) => entry.reason.includes('meal'))).toBe(true);
  });

  it('has nothing to propose for an empty day', async () => {
    const proposal = await app.services.schedule.proposeOptimization('2026-09-03');
    expect(proposal.moves).toHaveLength(0);
    expect(proposal.eventsBefore).toBe(0);
  });
});
