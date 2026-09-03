import { fixedClock, type Clock } from '../../src/application/clock.js';
import type { Services } from '../../src/application/container.js';
import { ApplicationHost } from '../../src/application/host.js';
import {
  createTestDatabase,
  migrateToLatest,
  openDatabase,
  type OpenedDatabase,
} from '../../src/persistence/database.js';

export interface TestApp {
  /** Resolved fresh each time: a restore rebuilds the whole service graph. */
  readonly services: Services;
  readonly opened: OpenedDatabase;
  host: ApplicationHost;
  clock: Clock;
  close(): Promise<void>;
}

/**
 * An isolated in-memory application with a pinned clock and a fixed timezone,
 * so schedule and history assertions do not depend on when or where the suite
 * runs.
 */
export async function createTestApp(
  now = '2026-09-03T08:00:00.000Z',
  /** Pass a file path when the test needs a database that survives a restore. */
  location = ':memory:',
): Promise<TestApp> {
  const opened =
    location === ':memory:'
      ? await createTestDatabase()
      : await (async () => {
          const handle = openDatabase({ location });
          await migrateToLatest(handle.db);
          return handle;
        })();

  const clock = fixedClock(now);
  const host = new ApplicationHost(opened, clock, location);

  await host.services.settings.setTimeZone('Europe/Berlin');

  return {
    host,
    get services() {
      return host.services;
    },
    get opened() {
      return host.opened;
    },
    clock,
    close: () => host.close(),
  };
}

export const rosuvastatin = {
  name: 'Rosuvastatin 5 mg',
  manufacturer: 'Acme Pharma',
  category: 'medication' as const,
  dosageForm: 'tablet' as const,
  packageSize: 100,
  packageUnit: 'tablets' as const,
  prescriptionRequired: true,
  ingredients: [{ substanceName: 'Rosuvastatin', amount: 5, unit: 'mg' }],
};

export const ironSupplement = {
  name: 'Iron 20 mg + Vitamin C',
  manufacturer: 'Nordic Naturals',
  category: 'supplement' as const,
  dosageForm: 'tablet' as const,
  packageSize: 60,
  packageUnit: 'tablets' as const,
  prescriptionRequired: false,
  ingredients: [
    { substanceName: 'Iron', label: 'Iron (ferrous bisglycinate)', amount: 20, unit: 'mg' },
    { substanceName: 'Vitamin C', amount: 20, unit: 'mg' },
  ],
};

/** 5 mg every day at 21:30 — the example from the brief. */
export const dailyEveningPlan = {
  recurrenceType: 'daily' as const,
  doses: [
    {
      timingType: 'fixed' as const,
      targetTime: '21:30',
      doseAmount: 5,
      doseUnit: 'mg',
      packageUnitQuantity: 1,
    },
  ],
};
