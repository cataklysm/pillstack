import {
  JSON_EXPORT_FORMAT,
  JSON_EXPORT_VERSION,
  jsonExportSchema,
  medicationPlanQuerySchema,
  treatmentHistoryQuerySchema,
  type ImportResult,
  type JsonExport,
  type LocalDate,
  type MedicationPlan,
  type TreatmentHistoryReport,
} from '@pillstack/contracts';
import {
  buildMedicationPlan,
  type PlanSource,
} from '../domain/exports/medicationPlan.js';
import {
  buildTreatmentHistoryReport,
  type HistorySource,
} from '../domain/exports/treatmentHistoryReport.js';
import { instantToLocalDate } from '../domain/schedules/calendar.js';
import { medicationPlanDocument } from '../exports/medicationPlanDocument.js';
import { renderPdf } from '../exports/pdfRenderer.js';
import { treatmentHistoryDocument } from '../exports/treatmentHistoryDocument.js';
import type { PillstackDatabase } from '../persistence/database.js';
import { ProductRepository } from '../persistence/repositories/productRepository.js';
import { SettingsRepository } from '../persistence/repositories/settingsRepository.js';
import { TreatmentRepository } from '../persistence/repositories/treatmentRepository.js';
import type { Clock } from './clock.js';
import { ConflictError, ValidationError } from './errors.js';

export const APP_VERSION = '0.1.0';

/**
 * Physician exports and the portable JSON export.
 *
 * The JSON export is deliberately not a backup: it is a readable, versioned
 * snapshot for moving the data to another application. Restoring PillStack
 * itself goes through BackupService.
 */
export class ExportService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
  ) {}

  async medicationPlan(rawQuery: unknown): Promise<MedicationPlan> {
    const parsed = medicationPlanQuerySchema.safeParse(rawQuery ?? {});
    if (!parsed.success) throw new ValidationError('invalid query', parsed.error.issues);

    const query = parsed.data;
    const asOf = (query.asOf as LocalDate | undefined) ?? (await this.today());

    return buildMedicationPlan({
      sources: await this.loadPlanSources(asOf),
      asOf,
      generatedAt: this.clock.now().toISOString(),
      patientName: query.patientName ?? (await this.storedPatientName()),
      dateOfBirth: query.dateOfBirth ?? (await this.storedDateOfBirth()),
      physicianNote: query.physicianNote ?? null,
    });
  }

  async medicationPlanPdf(rawQuery: unknown): Promise<Buffer> {
    return renderPdf(medicationPlanDocument(await this.medicationPlan(rawQuery)));
  }

  async treatmentHistoryReport(rawQuery: unknown): Promise<TreatmentHistoryReport> {
    const parsed = treatmentHistoryQuerySchema.safeParse(rawQuery ?? {});
    if (!parsed.success) throw new ValidationError('invalid query', parsed.error.issues);

    const query = parsed.data;

    return buildTreatmentHistoryReport({
      sources: await this.loadHistorySources(),
      generatedAt: this.clock.now().toISOString(),
      from: (query.from as LocalDate | undefined) ?? null,
      includeStopped: query.includeStopped !== false,
      patientName: query.patientName ?? (await this.storedPatientName()),
      dateOfBirth: query.dateOfBirth ?? (await this.storedDateOfBirth()),
      physicianNote: query.physicianNote ?? null,
    });
  }

  async treatmentHistoryPdf(rawQuery: unknown): Promise<Buffer> {
    return renderPdf(treatmentHistoryDocument(await this.treatmentHistoryReport(rawQuery)));
  }

  // -- portable JSON ---------------------------------------------------------

  /**
   * A nested, human-readable snapshot. Ids are preserved so the file can be
   * diffed and re-imported; the version is frozen, and a future version 2 would
   * get its own schema plus an upgrade step rather than changing this one.
   */
  async jsonExport(): Promise<JsonExport> {
    const settings = new SettingsRepository(this.db);

    const [
      substances,
      products,
      ingredients,
      treatments,
      plans,
      planDoses,
      events,
      pauses,
      constraints,
      policies,
      packages,
      transactions,
      intakeLog,
      dayProfiles,
      settingRows,
    ] = await Promise.all([
      this.db.selectFrom('substance').selectAll().execute(),
      this.db.selectFrom('product').selectAll().execute(),
      this.db.selectFrom('active_ingredient').selectAll().execute(),
      this.db.selectFrom('treatment').selectAll().execute(),
      this.db.selectFrom('intake_plan').selectAll().execute(),
      this.db.selectFrom('intake_plan_dose').selectAll().execute(),
      this.db.selectFrom('treatment_event').selectAll().execute(),
      this.db.selectFrom('treatment_pause').selectAll().execute(),
      this.db.selectFrom('intake_constraint').selectAll().execute(),
      this.db.selectFrom('inventory_policy').selectAll().execute(),
      this.db.selectFrom('inventory_package').selectAll().execute(),
      this.db.selectFrom('inventory_transaction').selectAll().execute(),
      this.db.selectFrom('intake_log_entry').selectAll().execute(),
      this.db.selectFrom('day_profile').selectAll().execute(),
      this.db.selectFrom('app_setting').selectAll().execute(),
    ]);

    const groupBy = <T, K extends keyof T>(rows: T[], key: K) => {
      const grouped = new Map<T[K], T[]>();
      for (const row of rows) {
        const list = grouped.get(row[key]) ?? [];
        list.push(row);
        grouped.set(row[key], list);
      }
      return grouped;
    };

    const ingredientsByProduct = groupBy(ingredients, 'product_id');
    const dosesByPlan = groupBy(planDoses, 'intake_plan_id');
    const plansByTreatment = groupBy(plans, 'treatment_id');
    const eventsByTreatment = groupBy(events, 'treatment_id');
    const pausesByTreatment = groupBy(pauses, 'treatment_id');
    const policyByProduct = new Map(policies.map((policy) => [policy.product_id, policy]));
    const packagesByProduct = groupBy(packages, 'product_id');
    const transactionsByProduct = groupBy(transactions, 'product_id');

    return {
      format: JSON_EXPORT_FORMAT,
      version: JSON_EXPORT_VERSION,
      exportedAt: this.clock.now().toISOString(),
      appVersion: APP_VERSION,
      timeZone: await settings.getTimeZone(),

      substances,

      products: products.map((product) => ({
        ...product,
        ingredients: ingredientsByProduct.get(product.id) ?? [],
      })),

      treatments: treatments.map((treatment) => ({
        ...treatment,
        plans: (plansByTreatment.get(treatment.id) ?? []).map((plan) => ({
          ...plan,
          doses: dosesByPlan.get(plan.id) ?? [],
        })),
        events: eventsByTreatment.get(treatment.id) ?? [],
        pauses: pausesByTreatment.get(treatment.id) ?? [],
      })),

      constraints,

      inventory: products.map((product) => ({
        productId: product.id,
        policy: policyByProduct.get(product.id) ?? null,
        packages: packagesByProduct.get(product.id) ?? [],
        transactions: transactionsByProduct.get(product.id) ?? [],
      })),

      intakeLog,
      dayProfiles,
      settings: Object.fromEntries(
        settingRows.map((row) => [row.key, JSON.parse(row.value) as unknown]),
      ),
    };
  }

  /**
   * Imports a JSON export into an empty database.
   *
   * Deliberately refuses a database that already holds products: merging two
   * histories needs conflict rules nobody has specified, and quietly guessing
   * at them is exactly how medication data gets corrupted. Restoring into an
   * existing install is what backups are for.
   */
  async jsonImport(rawDocument: unknown): Promise<ImportResult> {
    const parsed = jsonExportSchema.safeParse(rawDocument);
    if (!parsed.success) {
      throw new ValidationError('not a valid PillStack export', parsed.error.issues);
    }

    const existing = await this.db
      .selectFrom('product')
      .select((eb) => eb.fn.countAll().as('total'))
      .executeTakeFirst();

    if (Number(existing?.total ?? 0) > 0) {
      throw new ConflictError(
        'import needs an empty database; restore a backup instead of merging two histories',
      );
    }

    const document = parsed.data;
    const counts: ImportResult = {
      substances: 0,
      products: 0,
      treatments: 0,
      constraints: 0,
      inventoryTransactions: 0,
      intakeLogEntries: 0,
    };

    await this.db.transaction().execute(async (trx) => {
      const insertAll = async (table: string, rows: readonly unknown[]) => {
        if (rows.length === 0) return 0;
        await trx
          .insertInto(table as never)
          .values(rows as never)
          .execute();
        return rows.length;
      };

      counts.substances = await insertAll('substance', document.substances);

      const productRows = document.products.map((product) => omit(product, ['ingredients']));
      counts.products = await insertAll('product', productRows);
      await insertAll(
        'active_ingredient',
        document.products.flatMap((product) => asRows(product.ingredients)),
      );

      const treatmentRows = document.treatments.map((treatment) =>
        omit(treatment, ['plans', 'events', 'pauses']),
      );
      counts.treatments = await insertAll('treatment', treatmentRows);

      const planGroups = document.treatments.flatMap((treatment) => asRows(treatment.plans));
      await insertAll(
        'intake_plan',
        planGroups.map((plan) => omit(plan, ['doses'])),
      );
      await insertAll('intake_plan_dose', planGroups.flatMap((plan) => asRows(plan.doses)));
      await insertAll(
        'treatment_event',
        document.treatments.flatMap((treatment) => asRows(treatment.events)),
      );
      await insertAll(
        'treatment_pause',
        document.treatments.flatMap((treatment) => asRows(treatment.pauses)),
      );

      counts.constraints = await insertAll('intake_constraint', document.constraints);

      await insertAll(
        'inventory_policy',
        document.inventory.flatMap((entry) => (entry.policy ? [entry.policy] : [])),
      );
      await insertAll(
        'inventory_package',
        document.inventory.flatMap((entry) => asRows(entry.packages)),
      );
      counts.intakeLogEntries = await insertAll('intake_log_entry', document.intakeLog);
      // After the log, because transactions reference its rows.
      counts.inventoryTransactions = await insertAll(
        'inventory_transaction',
        document.inventory.flatMap((entry) => asRows(entry.transactions)),
      );

      await trx.deleteFrom('day_profile').execute();
      await insertAll('day_profile', document.dayProfiles);

      const now = this.clock.now().toISOString();
      for (const [key, value] of Object.entries(document.settings)) {
        await trx
          .insertInto('app_setting')
          .values({ key, value: JSON.stringify(value), updated_at: now })
          .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value) }))
          .execute();
      }
    });

    return counts;
  }

  // -- loading ---------------------------------------------------------------

  private async loadPlanSources(asOf: LocalDate): Promise<PlanSource[]> {
    const treatments = new TreatmentRepository(this.db);
    const products = new ProductRepository(this.db);

    const records = await treatments.listTreatments({});
    const sources: PlanSource[] = [];

    for (const record of records) {
      const product = await products.findById(record.productId);
      if (!product) continue;

      sources.push({
        treatmentId: record.id,
        productId: record.productId,
        productName: record.productName,
        category: product.category,
        ingredients: product.ingredients,
        startedOn: record.startedOn,
        endedOn: record.endedOn,
        indication: record.indication,
        status: record.status,
        plan: await treatments.findPlanOnDate(record.id, asOf),
      });
    }

    return sources;
  }

  private async loadHistorySources(): Promise<HistorySource[]> {
    const treatments = new TreatmentRepository(this.db);
    const products = new ProductRepository(this.db);

    const records = await treatments.listTreatments({});
    const sources: HistorySource[] = [];

    for (const record of records) {
      const product = await products.findById(record.productId);
      if (!product) continue;

      sources.push({
        treatmentId: record.id,
        productName: record.productName,
        category: product.category,
        ingredients: product.ingredients,
        startedOn: record.startedOn,
        endedOn: record.endedOn,
        indication: record.indication,
        prescriber: record.prescriber,
        stopReason: record.stopReason,
        status: record.status,
        events: await treatments.listEvents(record.id),
      });
    }

    return sources;
  }

  private async today(): Promise<LocalDate> {
    const timeZone = await new SettingsRepository(this.db).getTimeZone();
    return instantToLocalDate(this.clock.now(), timeZone);
  }

  private async storedPatientName(): Promise<string | null> {
    const value = await new SettingsRepository(this.db).get('patient_name');
    return typeof value === 'string' ? value : null;
  }

  private async storedDateOfBirth(): Promise<LocalDate | null> {
    const value = await new SettingsRepository(this.db).get('patient_date_of_birth');
    return typeof value === 'string' ? (value as LocalDate) : null;
  }
}

function omit<T extends Record<string, unknown>>(row: T, keys: readonly string[]): T {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

/** Narrow an unknown JSON field to an array of row objects. */
function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}
