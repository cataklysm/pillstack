import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../src/application/errors.js';
import {
  createTestApp,
  dailyEveningPlan,
  rosuvastatin,
  type TestApp,
} from './support/testApp.js';

describe('treatment lifecycle', () => {
  let app: TestApp;
  let productId: string;

  beforeEach(async () => {
    app = await createTestApp();
    productId = (await app.services.products.create(rosuvastatin)).id;
  });

  afterEach(async () => {
    await app.close();
  });

  it('starts a treatment with version 1 of its plan and a started event', async () => {
    const treatment = await app.services.treatments.start({
      productId,
      indication: 'LDL reduction',
      prescriber: 'Dr. Meyer',
      startedOn: '2026-09-03',
      plan: dailyEveningPlan,
    });

    expect(treatment.status).toBe('active');
    expect(treatment.currentPlan?.version).toBe(1);
    expect(treatment.currentPlan?.effectiveFrom).toBe('2026-09-03');
    expect(treatment.currentPlan?.effectiveTo).toBeNull();
    expect(treatment.currentPlan?.summary).toBe('5 mg daily at 21:30');

    const history = await app.services.treatments.history(treatment.id);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]?.eventType).toBe('started');
    expect(history.events[0]?.summary).toBe('Started 5 mg daily at 21:30');
  });

  it('rejects a treatment for a product that does not exist', async () => {
    await expect(
      app.services.treatments.start({
        productId: 'missing',
        startedOn: '2026-09-03',
        plan: dailyEveningPlan,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  /**
   * The central guarantee of the whole design: raising the dose must not
   * destroy what the dose used to be.
   */
  describe('changing the dose', () => {
    let treatmentId: string;

    beforeEach(async () => {
      const treatment = await app.services.treatments.start({
        productId,
        indication: 'LDL reduction',
        startedOn: '2026-09-03',
        plan: dailyEveningPlan,
      });
      treatmentId = treatment.id;

      await app.services.treatments.changePlan(treatmentId, {
        effectiveFrom: '2026-12-01',
        changeReason: 'LDL still above target',
        plan: {
          recurrenceType: 'daily',
          doses: [
            {
              timingType: 'fixed',
              targetTime: '21:30',
              doseAmount: 10,
              doseUnit: 'mg',
              packageUnitQuantity: 1,
            },
          ],
        },
      });
    });

    it('keeps both versions, closing the old one the day before', async () => {
      const history = await app.services.treatments.history(treatmentId);

      expect(history.planVersions).toHaveLength(2);
      expect(history.planVersions[0]).toMatchObject({
        version: 1,
        effectiveFrom: '2026-09-03',
        effectiveTo: '2026-11-30',
        summary: '5 mg daily at 21:30',
      });
      expect(history.planVersions[1]).toMatchObject({
        version: 2,
        effectiveFrom: '2026-12-01',
        effectiveTo: null,
        supersedesPlanId: history.planVersions[0]?.id,
        summary: '10 mg daily at 21:30',
      });
    });

    it('answers what the plan was on any past date', async () => {
      expect((await app.services.treatments.planOn(treatmentId, '2026-10-15'))?.summary).toBe(
        '5 mg daily at 21:30',
      );
      expect((await app.services.treatments.planOn(treatmentId, '2026-11-30'))?.summary).toBe(
        '5 mg daily at 21:30',
      );
      expect((await app.services.treatments.planOn(treatmentId, '2026-12-01'))?.summary).toBe(
        '10 mg daily at 21:30',
      );
      expect(await app.services.treatments.planOn(treatmentId, '2026-09-02')).toBeNull();
    });

    it('records a dose_changed event linking both versions', async () => {
      const history = await app.services.treatments.history(treatmentId);
      const change = history.events[1];

      expect(change?.eventType).toBe('dose_changed');
      expect(change?.occurredOn).toBe('2026-12-01');
      expect(change?.reason).toBe('LDL still above target');
      expect(change?.summary).toBe('Dose changed: 5 mg daily at 21:30 → 10 mg daily at 21:30');
      expect(change?.fromPlanId).toBe(history.planVersions[0]?.id);
      expect(change?.toPlanId).toBe(history.planVersions[1]?.id);
    });

    it('physically prevents the superseded version from being edited', async () => {
      const history = await app.services.treatments.history(treatmentId);
      const supersededId = history.planVersions[0]?.id;

      expect(() =>
        app.opened.sqlite
          .prepare(`UPDATE intake_plan SET recurrence_type = 'weekdays' WHERE id = ?`)
          .run(supersededId),
      ).toThrow(/immutable/);
    });

    it('supports a third version on top of the second', async () => {
      await app.services.treatments.changePlan(treatmentId, {
        effectiveFrom: '2027-02-01',
        plan: {
          recurrenceType: 'daily',
          doses: [
            { timingType: 'fixed', targetTime: '08:00', doseAmount: 10, doseUnit: 'mg' },
          ],
        },
      });

      const history = await app.services.treatments.history(treatmentId);
      expect(history.planVersions.map((version) => version.version)).toEqual([1, 2, 3]);
      expect(history.planVersions[1]?.effectiveTo).toBe('2027-01-31');
      expect(history.events[2]?.eventType).toBe('schedule_changed');
    });
  });

  describe('rejected changes', () => {
    let treatmentId: string;

    beforeEach(async () => {
      treatmentId = (
        await app.services.treatments.start({
          productId,
          startedOn: '2026-09-03',
          plan: dailyEveningPlan,
        })
      ).id;
    });

    it('refuses a change that starts before the current version', async () => {
      await expect(
        app.services.treatments.changePlan(treatmentId, {
          effectiveFrom: '2026-09-01',
          plan: {
            recurrenceType: 'daily',
            doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 10, doseUnit: 'mg' }],
          },
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('refuses a change that changes nothing', async () => {
      await expect(
        app.services.treatments.changePlan(treatmentId, {
          effectiveFrom: '2026-12-01',
          plan: dailyEveningPlan,
        }),
      ).rejects.toThrow(/identical/);
    });

    it('leaves exactly one open version after a rejected change', async () => {
      await app.services.treatments
        .changePlan(treatmentId, { effectiveFrom: '2026-12-01', plan: dailyEveningPlan })
        .catch(() => undefined);

      const openVersions = app.opened.sqlite
        .prepare(`SELECT COUNT(*) AS total FROM intake_plan WHERE effective_to IS NULL`)
        .get() as { total: number };

      expect(openVersions.total).toBe(1);
    });
  });

  describe('pause and resume', () => {
    let treatmentId: string;

    beforeEach(async () => {
      treatmentId = (
        await app.services.treatments.start({
          productId,
          startedOn: '2026-09-03',
          plan: dailyEveningPlan,
        })
      ).id;
    });

    it('records the pause as a queryable interval and an event', async () => {
      const paused = await app.services.treatments.pause(treatmentId, {
        pausedFrom: '2026-09-10',
        reason: 'surgery',
      });
      expect(paused.status).toBe('paused');

      const resumed = await app.services.treatments.resume(treatmentId, {
        resumedOn: '2026-09-15',
      });
      expect(resumed.status).toBe('active');

      const history = await app.services.treatments.history(treatmentId);
      expect(history.events.map((event) => event.eventType)).toEqual([
        'started',
        'paused',
        'resumed',
      ]);
      expect(history.events[1]?.summary).toBe('Paused: surgery');

      // The plan itself is untouched by a pause.
      expect(history.planVersions).toHaveLength(1);
      expect(history.planVersions[0]?.effectiveTo).toBeNull();
    });

    it('refuses to pause twice or resume when not paused', async () => {
      await expect(
        app.services.treatments.resume(treatmentId, { resumedOn: '2026-09-15' }),
      ).rejects.toThrow(ConflictError);

      await app.services.treatments.pause(treatmentId, { pausedFrom: '2026-09-10' });
      await expect(
        app.services.treatments.pause(treatmentId, { pausedFrom: '2026-09-11' }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('stopping', () => {
    it('closes the plan on the end date and keeps the history readable', async () => {
      const treatment = await app.services.treatments.start({
        productId,
        indication: 'LDL reduction',
        startedOn: '2026-09-03',
        plan: dailyEveningPlan,
      });

      const stopped = await app.services.treatments.stop(treatment.id, {
        endedOn: '2027-03-01',
        stopReason: 'target LDL reached',
      });

      expect(stopped.status).toBe('stopped');
      expect(stopped.endedOn).toBe('2027-03-01');

      const history = await app.services.treatments.history(treatment.id);
      expect(history.planVersions[0]?.effectiveTo).toBe('2027-03-01');
      expect(history.events.at(-1)?.summary).toBe(
        'Stopped 5 mg daily at 21:30 — target LDL reached',
      );

      // Past dates still resolve to the plan that was in force then.
      expect((await app.services.treatments.planOn(treatment.id, '2026-10-01'))?.summary).toBe(
        '5 mg daily at 21:30',
      );
      expect(await app.services.treatments.planOn(treatment.id, '2027-03-02')).toBeNull();
    });

    it('refuses to reschedule or re-stop a stopped treatment', async () => {
      const treatment = await app.services.treatments.start({
        productId,
        startedOn: '2026-09-03',
        plan: dailyEveningPlan,
      });
      await app.services.treatments.stop(treatment.id, { endedOn: '2026-10-01' });

      await expect(
        app.services.treatments.stop(treatment.id, { endedOn: '2026-11-01' }),
      ).rejects.toThrow(ConflictError);

      await expect(
        app.services.treatments.changePlan(treatment.id, {
          effectiveFrom: '2026-12-01',
          plan: dailyEveningPlan,
        }),
      ).rejects.toThrow(ConflictError);
    });
  });
});
