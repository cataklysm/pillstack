import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/application/errors.js';
import { toPdfSafeText } from '../src/exports/pdfRenderer.js';
import { createTestApp, ironSupplement, rosuvastatin, type TestApp } from './support/testApp.js';

/**
 * The physician exports, and the portable JSON snapshot.
 *
 * The report *content* is asserted here rather than the PDF bytes: what goes on
 * the page is decided in the domain and is the part worth pinning down. A
 * separate check confirms the bytes really are a PDF.
 */
async function seedCabinet(app: TestApp) {
  const statin = await app.services.products.create(rosuvastatin);
  const iron = await app.services.products.create(ironSupplement);

  const statinTreatment = await app.services.treatments.start({
    productId: statin.id,
    indication: 'LDL reduction',
    prescriber: 'Dr. Meyer',
    startedOn: '2026-09-03',
    plan: {
      recurrenceType: 'daily',
      instructions: 'swallow whole with water',
      doses: [
        { timingType: 'fixed', targetTime: '21:30', doseAmount: 5, doseUnit: 'mg', packageUnitQuantity: 1 },
      ],
    },
  });

  await app.services.treatments.start({
    productId: iron.id,
    startedOn: '2026-09-03',
    plan: {
      recurrenceType: 'daily',
      doses: [
        { timingType: 'meal_relative', mealReference: 'dinner', doseAmount: 1, doseUnit: 'tablet' },
      ],
    },
  });

  return { statin, iron, statinTreatment };
}

describe('the physician medication plan', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-12-15T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('separates medications from supplements, as the brief asks', async () => {
    await seedCabinet(app);
    const plan = await app.services.exports.medicationPlan({});

    expect(plan.medications.map((entry) => entry.productName)).toEqual(['Rosuvastatin 5 mg']);
    expect(plan.supplements.map((entry) => entry.productName)).toEqual(['Iron 20 mg + Vitamin C']);
  });

  it('prints the columns the brief lists', async () => {
    await seedCabinet(app);
    const plan = await app.services.exports.medicationPlan({});

    expect(plan.medications[0]).toMatchObject({
      productName: 'Rosuvastatin 5 mg',
      activeIngredients: 'Rosuvastatin 5 mg',
      dose: '5 mg',
      schedule: '5 mg daily at 21:30',
      since: '2026-09-03',
      indication: 'LDL reduction',
      note: 'swallow whole with water',
    });

    expect(plan.supplements[0]).toMatchObject({
      activeIngredients: 'Iron 20 mg, Vitamin C 20 mg',
      dose: '1 tablet',
      schedule: '1 tablet daily with dinner',
    });
  });

  it('shows the plan as it stood on a past date, not as it stands now', async () => {
    const { statinTreatment } = await seedCabinet(app);
    await app.services.treatments.changePlan(statinTreatment.id, {
      effectiveFrom: '2026-12-01',
      plan: {
        recurrenceType: 'daily',
        doses: [
          { timingType: 'fixed', targetTime: '21:30', doseAmount: 10, doseUnit: 'mg', packageUnitQuantity: 1 },
        ],
      },
    });

    expect((await app.services.exports.medicationPlan({})).medications[0]?.dose).toBe('10 mg');
    expect(
      (await app.services.exports.medicationPlan({ asOf: '2026-10-15' })).medications[0]?.dose,
    ).toBe('5 mg');
  });

  it('leaves a stopped treatment off the current plan', async () => {
    const { statinTreatment } = await seedCabinet(app);
    await app.services.treatments.stop(statinTreatment.id, { endedOn: '2026-11-01' });

    const plan = await app.services.exports.medicationPlan({});
    expect(plan.medications).toHaveLength(0);
    expect(plan.supplements).toHaveLength(1);
  });

  it('marks a paused treatment rather than hiding it', async () => {
    const { statinTreatment } = await seedCabinet(app);
    await app.services.treatments.pause(statinTreatment.id, { pausedFrom: '2026-12-01' });

    const plan = await app.services.exports.medicationPlan({});
    expect(plan.medications[0]?.note).toContain('currently paused');
  });

  it('carries the optional patient details and physician note', async () => {
    await seedCabinet(app);
    const plan = await app.services.exports.medicationPlan({
      patientName: 'Alex Fischer',
      dateOfBirth: '1979-04-12',
      physicianNote: 'Please review the statin dose.',
    });

    expect(plan.patientName).toBe('Alex Fischer');
    expect(plan.dateOfBirth).toBe('1979-04-12');
    expect(plan.physicianNote).toBe('Please review the statin dose.');
    expect(plan.generatedAt).toBe('2026-12-15T08:00:00.000Z');
  });

  it('renders to a real PDF', async () => {
    await seedCabinet(app);
    const pdf = await app.services.exports.medicationPlanPdf({ patientName: 'Alex Fischer' });

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(1000);
    // Uncompressed metadata still carries the title, so this is a real document.
    expect(pdf.toString('latin1')).toContain('Medication plan');
  });

  it('produces a document even with nothing recorded', async () => {
    const pdf = await app.services.exports.medicationPlanPdf({});
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('the treatment history report', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-12-15T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('carries every event, including for stopped treatments', async () => {
    const { statinTreatment } = await seedCabinet(app);
    await app.services.treatments.changePlan(statinTreatment.id, {
      effectiveFrom: '2026-12-01',
      changeReason: 'LDL still above target',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 10, doseUnit: 'mg' }],
      },
    });
    await app.services.treatments.stop(statinTreatment.id, {
      endedOn: '2026-12-10',
      stopReason: 'target reached',
    });

    const report = await app.services.exports.treatmentHistoryReport({});
    const statin = report.entries.find((entry) => entry.productName === 'Rosuvastatin 5 mg');

    expect(statin?.endedOn).toBe('2026-12-10');
    expect(statin?.stopReason).toBe('target reached');
    expect(statin?.prescriber).toBe('Dr. Meyer');
    expect(statin?.events.map((event) => event.eventType)).toEqual([
      'started',
      'dose_changed',
      'stopped',
    ]);
    // The summaries were frozen when written, so they still read correctly.
    expect(statin?.events[1]?.summary).toBe(
      'Dose changed: 5 mg daily at 21:30 → 10 mg daily at 21:30',
    );
    expect(statin?.events[1]?.reason).toBe('LDL still above target');
  });

  it('can be limited to a window, dropping treatments with nothing to say in it', async () => {
    const { statinTreatment } = await seedCabinet(app);
    await app.services.treatments.changePlan(statinTreatment.id, {
      effectiveFrom: '2026-12-01',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 10, doseUnit: 'mg' }],
      },
    });

    const report = await app.services.exports.treatmentHistoryReport({ from: '2026-11-01' });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.events).toHaveLength(1);
    expect(report.entries[0]?.events[0]?.eventType).toBe('dose_changed');
  });

  it('can exclude stopped treatments', async () => {
    const { statinTreatment } = await seedCabinet(app);
    await app.services.treatments.stop(statinTreatment.id, { endedOn: '2026-12-10' });

    expect((await app.services.exports.treatmentHistoryReport({})).entries).toHaveLength(2);
    expect(
      (await app.services.exports.treatmentHistoryReport({ includeStopped: false })).entries,
    ).toHaveLength(1);
  });

  it('renders to a real PDF', async () => {
    await seedCabinet(app);
    const pdf = await app.services.exports.treatmentHistoryPdf({});

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('Treatment history');
  });
});

describe('the portable JSON export', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-12-15T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('is a versioned envelope', async () => {
    await seedCabinet(app);
    const document = await app.services.exports.jsonExport();

    expect(document.format).toBe('pillstack/export');
    expect(document.version).toBe(1);
    expect(document.exportedAt).toBe('2026-12-15T08:00:00.000Z');
    expect(document.timeZone).toBe('Europe/Berlin');
  });

  it('nests the graph so it reads as a document, not a table dump', async () => {
    await seedCabinet(app);
    const document = await app.services.exports.jsonExport();

    const statin = document.products.find((product) => product.name === 'Rosuvastatin 5 mg');
    expect((statin?.ingredients as unknown[]).length).toBe(1);

    const treatment = document.treatments[0] as Record<string, unknown>;
    expect(Array.isArray(treatment.plans)).toBe(true);
    expect(Array.isArray(treatment.events)).toBe(true);
    expect(Array.isArray((treatment.plans as Record<string, unknown>[])[0]?.doses)).toBe(true);
  });

  it('round-trips through import into an empty database', async () => {
    const { statinTreatment } = await seedCabinet(app);
    await app.services.treatments.changePlan(statinTreatment.id, {
      effectiveFrom: '2026-12-01',
      changeReason: 'LDL still above target',
      plan: {
        recurrenceType: 'daily',
        doses: [
          { timingType: 'fixed', targetTime: '21:30', doseAmount: 10, doseUnit: 'mg', packageUnitQuantity: 1 },
        ],
      },
    });
    await app.services.inventory.addPackage((await app.services.products.list({}))[0]!.id, {
      quantity: 40,
      opened: true,
    });

    const exported = await app.services.exports.jsonExport();

    const restored = await createTestApp('2026-12-15T08:00:00.000Z');
    try {
      const result = await restored.services.exports.jsonImport(exported);
      expect(result.products).toBe(2);
      expect(result.treatments).toBe(2);

      // The whole graph survives, versioned history included.
      const reExported = await restored.services.exports.jsonExport();
      expect(reExported.products).toEqual(exported.products);
      expect(reExported.treatments).toEqual(exported.treatments);
      expect(reExported.inventory).toEqual(exported.inventory);
      expect(reExported.substances).toEqual(exported.substances);

      const history = await restored.services.exports.treatmentHistoryReport({});
      expect(
        history.entries.find((entry) => entry.productName === 'Rosuvastatin 5 mg')?.events,
      ).toHaveLength(2);
    } finally {
      await restored.close();
    }
  });

  it('refuses to merge into a database that already holds products', async () => {
    await seedCabinet(app);
    const exported = await app.services.exports.jsonExport();

    // Merging two medication histories needs conflict rules nobody specified;
    // guessing at them is how data gets corrupted.
    await expect(app.services.exports.jsonImport(exported)).rejects.toThrow(ConflictError);
  });

  it('rejects a file that is not a PillStack export', async () => {
    await expect(app.services.exports.jsonImport({ hello: 'world' })).rejects.toThrow(
      /not a valid PillStack export/,
    );
    await expect(
      app.services.exports.jsonImport({ format: 'pillstack/export', version: 99 }),
    ).rejects.toThrow(/not a valid PillStack export/);
  });
});

describe('PDF character handling', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp('2026-12-15T08:00:00.000Z');
  });

  afterEach(async () => {
    await app.close();
  });

  it('substitutes characters the standard fonts cannot draw', async () => {
    // The 14 standard PDF fonts cover Latin-1 only. An arrow came out as "!",
    // and en dashes, ellipses and curly quotes disappeared entirely — which on
    // a medication document is worse than a wrong glyph.
    expect(toPdfSafeText('5 mg → 10 mg')).toBe('5 mg -> 10 mg');
    expect(toPdfSafeText('2026 – ongoing')).toBe('2026 - ongoing');
    expect(toPdfSafeText('one… two')).toBe('one... two');
    expect(toPdfSafeText('it’s “fine”')).toBe('it\'s "fine"');
    // Latin-1 is left exactly as it is.
    expect(toPdfSafeText('Ibuprofén 400 µg · 37°C')).toBe('Ibuprofén 400 µg · 37°C');
    // Anything else is marked rather than silently lost.
    expect(toPdfSafeText('dose \u4e2d')).toBe('dose ?');
  });

  it('draws the arrow in a real dose-change document', async () => {
    const { statinTreatment } = await seedCabinet(app);
    await app.services.treatments.changePlan(statinTreatment.id, {
      effectiveFrom: '2026-12-01',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 10, doseUnit: 'mg' }],
      },
    });

    const report = await app.services.exports.treatmentHistoryReport({});
    const summary = report.entries
      .flatMap((entry) => entry.events)
      .find((event) => event.eventType === 'dose_changed')?.summary;

    // The stored summary keeps the real character; only the PDF substitutes.
    expect(summary).toContain('→');
    expect(toPdfSafeText(summary as string)).toContain('->');

    const pdf = await app.services.exports.treatmentHistoryPdf({});
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
