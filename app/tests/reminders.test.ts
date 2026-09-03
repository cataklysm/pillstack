import type { ReminderRule } from '@pillstack/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyQuietHours,
  selectRule,
} from '../src/domain/reminders/generation.js';
import { createTestApp, rosuvastatin, type TestApp } from './support/testApp.js';

function rule(overrides: Partial<ReminderRule> = {}): ReminderRule {
  return {
    id: 'rule-global',
    reminderType: 'intake',
    scopeKind: 'global',
    productId: null,
    treatmentId: null,
    leadTimeMinutes: 0,
    leadTimeDays: null,
    repeatAfterMinutes: null,
    quietHoursFrom: null,
    quietHoursTo: null,
    enabled: true,
    summary: '',
    ...overrides,
  };
}

describe('choosing which rule applies', () => {
  it('prefers a treatment rule over a product rule over the global one', () => {
    const rules = [
      rule({ id: 'global' }),
      rule({ id: 'product', scopeKind: 'product', productId: 'product-1' }),
      rule({ id: 'treatment', scopeKind: 'treatment', treatmentId: 'treatment-1' }),
    ];

    expect(
      selectRule(rules, { reminderType: 'intake', productId: 'product-1', treatmentId: 'treatment-1' })?.id,
    ).toBe('treatment');

    expect(
      selectRule(rules, { reminderType: 'intake', productId: 'product-1', treatmentId: 'other' })?.id,
    ).toBe('product');

    expect(
      selectRule(rules, { reminderType: 'intake', productId: 'other', treatmentId: 'other' })?.id,
    ).toBe('global');
  });

  it('ignores disabled rules and other reminder types', () => {
    expect(selectRule([rule({ enabled: false })], { reminderType: 'intake' })).toBeNull();
    expect(selectRule([rule()], { reminderType: 'reorder' })).toBeNull();
  });
});

describe('quiet hours', () => {
  const timeZone = 'Europe/Berlin';

  it('leaves a reminder outside the window alone', () => {
    const dueAt = '2026-09-03T19:30:00.000Z'; // 21:30 Berlin
    expect(applyQuietHours(dueAt, rule({ quietHoursFrom: '23:00', quietHoursTo: '07:00' }), timeZone)).toBe(
      dueAt,
    );
  });

  it('holds an overnight reminder until the window ends the next morning', () => {
    const dueAt = '2026-09-03T22:30:00.000Z'; // 00:30 on the 4th, Berlin
    const shifted = applyQuietHours(
      dueAt,
      rule({ quietHoursFrom: '23:00', quietHoursTo: '07:00' }),
      timeZone,
    );
    // 07:00 Berlin on the 4th is 05:00 UTC.
    expect(shifted).toBe('2026-09-04T05:00:00.000Z');
  });

  it('rolls a late-evening reminder into the following morning', () => {
    const dueAt = '2026-09-03T21:30:00.000Z'; // 23:30 Berlin on the 3rd
    expect(
      applyQuietHours(dueAt, rule({ quietHoursFrom: '23:00', quietHoursTo: '07:00' }), timeZone),
    ).toBe('2026-09-04T05:00:00.000Z');
  });

  it('handles a window that does not cross midnight', () => {
    const dueAt = '2026-09-03T12:00:00.000Z'; // 14:00 Berlin
    expect(
      applyQuietHours(dueAt, rule({ quietHoursFrom: '13:00', quietHoursTo: '15:00' }), timeZone),
    ).toBe('2026-09-03T13:00:00.000Z'); // 15:00 Berlin
  });
});

describe('the reminder outbox', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-09-03T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedStatin() {
    const product = await app.services.products.create(rosuvastatin);
    const treatment = await app.services.treatments.start({
      productId: product.id,
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
    return { product, treatment };
  }

  it('produces nothing until a rule exists', async () => {
    await seedStatin();
    expect(await app.services.reminders.due()).toHaveLength(0);
  });

  it('announces the evening dose once a rule is set', async () => {
    await seedStatin();
    await app.services.reminders.createRule({ reminderType: 'intake', leadTimeMinutes: 15 });

    // Nothing is due yet: the dose is at 21:30 Berlin, it is 10:00 there now.
    expect(await app.services.reminders.due()).toHaveLength(0);

    const evening = await createTestApp('2026-09-03T19:20:00.000Z');
    try {
      await seedStatinIn(evening);
      await evening.services.reminders.createRule({ reminderType: 'intake', leadTimeMinutes: 15 });

      const due = await evening.services.reminders.due();
      expect(due).toHaveLength(1);
      expect(due[0]?.notificationType).toBe('intake');
      expect(due[0]?.title).toContain('21:30');
      expect(due[0]?.body).toBe('5 mg');
    } finally {
      await evening.close();
    }
  });

  it('generates the same notification only once, however often it runs', async () => {
    const evening = await createTestApp('2026-09-03T19:20:00.000Z');
    try {
      await seedStatinIn(evening);
      await evening.services.reminders.createRule({ reminderType: 'intake', leadTimeMinutes: 15 });

      await evening.services.reminders.refresh();
      await evening.services.reminders.refresh();
      await evening.services.reminders.refresh();

      // The unique dedupe key makes generation idempotent, so no scheduler or
      // background worker is needed.
      expect(await evening.services.reminders.due()).toHaveLength(1);
    } finally {
      await evening.close();
    }
  });

  it('withdraws a reminder once the dose is recorded', async () => {
    const evening = await createTestApp('2026-09-03T19:20:00.000Z');
    try {
      const { treatment } = await seedStatinIn(evening);
      await evening.services.reminders.createRule({ reminderType: 'intake', leadTimeMinutes: 15 });
      expect(await evening.services.reminders.due()).toHaveLength(1);

      const current = await evening.services.treatments.findById(treatment.id);
      await evening.services.intakeLog.record({
        planDoseId: current.currentPlan?.doses[0]?.id,
        occurrenceDate: '2026-09-03',
        status: 'taken',
      });

      expect(await evening.services.reminders.due()).toHaveLength(0);
    } finally {
      await evening.close();
    }
  });

  it('marks delivered only what the client confirms', async () => {
    const evening = await createTestApp('2026-09-03T19:20:00.000Z');
    try {
      await seedStatinIn(evening);
      await evening.services.reminders.createRule({ reminderType: 'intake', leadTimeMinutes: 15 });

      const due = await evening.services.reminders.due();
      expect(due).toHaveLength(1);
      const deliveredId = due[0]?.id as string;

      await evening.services.reminders.markDelivered([deliveredId]);
      expect(await evening.services.reminders.due()).toHaveLength(0);

      // Tomorrow's and the day after's reminders are already in the outbox but
      // not yet due, so look the confirmed one up rather than taking the first.
      const recent = await evening.services.reminders.recent();
      expect(recent.find((entry) => entry.id === deliveredId)?.deliveredAt).not.toBeNull();
      expect(recent.filter((entry) => entry.deliveredAt === null).length).toBeGreaterThan(0);
    } finally {
      await evening.close();
    }
  });

  it('raises a prescription reminder for a prescription-only product', async () => {
    const { product } = await seedStatin();
    await app.services.inventory.addPackage(product.id, { quantity: 12, opened: true });
    await app.services.inventory.updatePolicy(product.id, { reorderLeadTimeDays: 14 });
    await app.services.reminders.createRule({ reminderType: 'prescription', leadTimeDays: 30 });

    const due = await app.services.reminders.due();
    expect(due).toHaveLength(1);
    expect(due[0]?.notificationType).toBe('prescription');
    expect(due[0]?.body).toContain('Request a new prescription');
  });

  it('uses the reorder wording for a product that needs no prescription', async () => {
    const magnesium = await app.services.products.create({
      name: 'Magnesium 150 mg',
      category: 'supplement',
      dosageForm: 'powder',
      packageSize: 30,
      packageUnit: 'doses',
      prescriptionRequired: false,
      ingredients: [{ substanceName: 'Magnesium' }],
    });
    await app.services.treatments.start({
      productId: magnesium.id,
      startedOn: '2026-09-03',
      plan: {
        recurrenceType: 'daily',
        doses: [
          { timingType: 'fixed', targetTime: '08:00', doseAmount: 1, doseUnit: 'dose', packageUnitQuantity: 1 },
        ],
      },
    });
    await app.services.inventory.addPackage(magnesium.id, { quantity: 14, opened: true });
    await app.services.reminders.createRule({ reminderType: 'reorder', leadTimeDays: 30 });

    const due = await app.services.reminders.due();
    expect(due).toHaveLength(1);
    expect(due[0]?.notificationType).toBe('reorder');
    expect(due[0]?.body).toContain('will likely run out in');
    expect(due[0]?.body).not.toContain('prescription');
  });

  it('says nothing about a product whose stock was never recorded', async () => {
    // Without a package or a count there is no stock to run out of, and
    // reporting "runs out tomorrow" for every untracked product would be noise.
    await seedStatin();
    await app.services.reminders.createRule({ reminderType: 'prescription', leadTimeDays: 60 });

    expect(await app.services.reminders.due()).toHaveLength(0);

    const { product } = await seedStatin();
    await app.services.inventory.addPackage(product.id, { quantity: 5, opened: true });
    expect((await app.services.reminders.due()).length).toBeGreaterThan(0);
  });

  it('stays silent while the run-out date is still far off', async () => {
    const { product } = await seedStatin();
    await app.services.inventory.addPackage(product.id, { opened: true });
    await app.services.reminders.createRule({ reminderType: 'prescription', leadTimeDays: 14 });

    // 100 tablets at one a day: nothing to say for months.
    expect(await app.services.reminders.due()).toHaveLength(0);
  });

  it('dismisses a notification for good', async () => {
    const { product } = await seedStatin();
    await app.services.inventory.addPackage(product.id, { quantity: 12, opened: true });
    await app.services.reminders.createRule({ reminderType: 'prescription', leadTimeDays: 30 });

    const due = await app.services.reminders.due();
    await app.services.reminders.dismiss(due[0]?.id as string);

    expect(await app.services.reminders.due()).toHaveLength(0);
  });
});

async function seedStatinIn(app: TestApp) {
  const product = await app.services.products.create(rosuvastatin);
  const treatment = await app.services.treatments.start({
    productId: product.id,
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
  return { product, treatment };
}
