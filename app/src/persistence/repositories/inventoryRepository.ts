import type {
  InventoryPackage,
  InventoryPolicy,
  InventoryTransaction,
  LocalDate,
} from '@pillstack/contracts';
import type { ConsumptionDose, LoggedOccurrence } from '../../domain/inventory/consumption.js';
import type { LedgerEntry } from '../../domain/inventory/projection.js';
import type { PillstackDatabase } from '../database.js';
import type { InventoryPackageTable, InventoryTransactionTable } from '../schema.js';

export interface InsertTransactionRecord {
  id: string;
  productId: string;
  inventoryPackageId: string | null;
  transactionType: InventoryTransactionTable['transaction_type'];
  quantityDelta: number;
  absoluteQuantity: number | null;
  occurredAt: string;
  effectiveOn: LocalDate;
  intakeLogEntryId: string | null;
  treatmentId: string | null;
  note: string | null;
}

export class InventoryRepository {
  constructor(private readonly db: PillstackDatabase) {}

  // -- policy ----------------------------------------------------------------

  async getPolicy(productId: string): Promise<InventoryPolicy | null> {
    const row = await this.db
      .selectFrom('inventory_policy')
      .selectAll()
      .where('product_id', '=', productId)
      .executeTakeFirst();

    return row ? toPolicy(row) : null;
  }

  async listPolicies(): Promise<Map<string, InventoryPolicy>> {
    const rows = await this.db.selectFrom('inventory_policy').selectAll().execute();
    return new Map(rows.map((row) => [row.product_id, toPolicy(row)]));
  }

  async upsertPolicy(
    productId: string,
    changes: Partial<InventoryPolicy>,
    now: string,
  ): Promise<void> {
    const values: Record<string, unknown> = { updated_at: now };
    if (changes.trackingEnabled !== undefined) {
      values.tracking_enabled = changes.trackingEnabled ? 1 : 0;
    }
    if (changes.consumptionSource !== undefined) {
      values.consumption_source = changes.consumptionSource;
    }
    if (changes.reorderThresholdQuantity !== undefined) {
      values.reorder_threshold_quantity = changes.reorderThresholdQuantity;
    }
    if (changes.reorderThresholdDays !== undefined) {
      values.reorder_threshold_days = changes.reorderThresholdDays;
    }
    if (changes.reorderLeadTimeDays !== undefined) {
      values.reorder_lead_time_days = changes.reorderLeadTimeDays;
    }

    await this.db
      .insertInto('inventory_policy')
      .values({
        product_id: productId,
        tracking_enabled: changes.trackingEnabled === false ? 0 : 1,
        consumption_source: changes.consumptionSource ?? 'planned',
        reorder_threshold_quantity: changes.reorderThresholdQuantity ?? null,
        reorder_threshold_days: changes.reorderThresholdDays ?? null,
        reorder_lead_time_days: changes.reorderLeadTimeDays ?? 7,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('product_id').doUpdateSet(values))
      .execute();
  }

  // -- packages --------------------------------------------------------------

  async insertPackage(record: {
    id: string;
    productId: string;
    packageSize: number;
    unit: string;
    acquiredOn: LocalDate | null;
    openedAt: LocalDate | null;
    expirationDate: LocalDate | null;
    lotNumber: string | null;
    notes: string | null;
    createdAt: string;
  }): Promise<void> {
    await this.db
      .insertInto('inventory_package')
      .values({
        id: record.id,
        product_id: record.productId,
        package_size: record.packageSize,
        unit: record.unit,
        acquired_on: record.acquiredOn,
        opened_at: record.openedAt,
        expiration_date: record.expirationDate,
        lot_number: record.lotNumber,
        status: record.openedAt ? 'open' : 'sealed',
        notes: record.notes,
        created_at: record.createdAt,
      })
      .execute();
  }

  async listPackages(productIds: readonly string[]): Promise<Map<string, InventoryPackage[]>> {
    const grouped = new Map<string, InventoryPackage[]>();
    if (productIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('inventory_package')
      .selectAll()
      .where('product_id', 'in', productIds)
      .where('status', '!=', 'discarded')
      .orderBy('expiration_date', 'asc')
      .execute();

    for (const row of rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push(toPackage(row));
      grouped.set(row.product_id, list);
    }

    return grouped;
  }

  async findPackage(id: string): Promise<InventoryPackage | null> {
    const row = await this.db
      .selectFrom('inventory_package')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row ? toPackage(row) : null;
  }

  async setPackageStatus(id: string, status: InventoryPackageTable['status']): Promise<void> {
    await this.db
      .updateTable('inventory_package')
      .set({ status })
      .where('id', '=', id)
      .execute();
  }

  // -- ledger ----------------------------------------------------------------

  async insertTransaction(record: InsertTransactionRecord): Promise<void> {
    await this.db
      .insertInto('inventory_transaction')
      .values({
        id: record.id,
        product_id: record.productId,
        inventory_package_id: record.inventoryPackageId,
        transaction_type: record.transactionType,
        quantity_delta: record.quantityDelta,
        absolute_quantity: record.absoluteQuantity,
        occurred_at: record.occurredAt,
        effective_on: record.effectiveOn,
        intake_log_entry_id: record.intakeLogEntryId,
        treatment_id: record.treatmentId,
        note: record.note,
        created_at: record.occurredAt,
      })
      .execute();
  }

  async deleteTransactionsForLogEntry(intakeLogEntryId: string): Promise<void> {
    await this.db
      .deleteFrom('inventory_transaction')
      .where('intake_log_entry_id', '=', intakeLogEntryId)
      .execute();
  }

  async loadLedger(productIds: readonly string[]): Promise<Map<string, LedgerEntry[]>> {
    const grouped = new Map<string, LedgerEntry[]>();
    if (productIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('inventory_transaction')
      .select(['product_id', 'transaction_type', 'quantity_delta', 'effective_on'])
      .where('product_id', 'in', productIds)
      .orderBy('effective_on', 'asc')
      .execute();

    for (const row of rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push({
        transactionType: row.transaction_type,
        quantityDelta: row.quantity_delta,
        effectiveOn: row.effective_on as LocalDate,
      });
      grouped.set(row.product_id, list);
    }

    return grouped;
  }

  async listTransactions(productId: string, limit = 200): Promise<InventoryTransaction[]> {
    const rows = await this.db
      .selectFrom('inventory_transaction')
      .selectAll()
      .where('product_id', '=', productId)
      .orderBy('effective_on', 'desc')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      inventoryPackageId: row.inventory_package_id,
      transactionType: row.transaction_type,
      quantityDelta: row.quantity_delta,
      absoluteQuantity: row.absolute_quantity,
      occurredAt: row.occurred_at,
      effectiveOn: row.effective_on,
      note: row.note,
    }));
  }

  // -- consumption inputs ----------------------------------------------------

  /**
   * Every dose of every plan version for these products, with the effective
   * period and pauses needed to decide which days it applies to.
   *
   * All versions are loaded rather than a date window: the projection walks
   * both backwards over history and forwards into the future, and versions
   * never overlap, so nothing is double-counted.
   */
  async loadConsumptionDoses(
    productIds: readonly string[],
  ): Promise<Map<string, ConsumptionDose[]>> {
    const grouped = new Map<string, ConsumptionDose[]>();
    if (productIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('intake_plan_dose')
      .innerJoin('intake_plan', 'intake_plan.id', 'intake_plan_dose.intake_plan_id')
      .innerJoin('treatment', 'treatment.id', 'intake_plan.treatment_id')
      .select([
        'intake_plan_dose.id as dose_id',
        'intake_plan_dose.package_unit_quantity as package_unit_quantity',
        'intake_plan.effective_from as effective_from',
        'intake_plan.effective_to as effective_to',
        'intake_plan.recurrence_type as recurrence_type',
        'intake_plan.interval_days as interval_days',
        'intake_plan.anchor_date as anchor_date',
        'intake_plan.weekday_mask as weekday_mask',
        'treatment.id as treatment_id',
        'treatment.product_id as product_id',
      ])
      .where('treatment.product_id', 'in', productIds)
      .execute();

    const pauses = await this.loadPauses([...new Set(rows.map((row) => row.treatment_id))]);

    for (const row of rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push({
        planDoseId: row.dose_id,
        packageUnitQuantity: row.package_unit_quantity,
        recurrence: {
          recurrenceType: row.recurrence_type,
          intervalDays: row.interval_days,
          anchorDate: row.anchor_date as LocalDate | null,
          weekdayMask: row.weekday_mask,
        },
        effectivePeriod: {
          effectiveFrom: row.effective_from as LocalDate,
          effectiveTo: row.effective_to as LocalDate | null,
        },
        pauses: pauses.get(row.treatment_id) ?? [],
      });
      grouped.set(row.product_id, list);
    }

    return grouped;
  }

  private async loadPauses(
    treatmentIds: readonly string[],
  ): Promise<Map<string, { pausedFrom: LocalDate; resumedOn: LocalDate | null }[]>> {
    const grouped = new Map<string, { pausedFrom: LocalDate; resumedOn: LocalDate | null }[]>();
    if (treatmentIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('treatment_pause')
      .select(['treatment_id', 'paused_from', 'resumed_on'])
      .where('treatment_id', 'in', treatmentIds)
      .execute();

    for (const row of rows) {
      const list = grouped.get(row.treatment_id) ?? [];
      list.push({
        pausedFrom: row.paused_from as LocalDate,
        resumedOn: row.resumed_on as LocalDate | null,
      });
      grouped.set(row.treatment_id, list);
    }

    return grouped;
  }

  /** Occurrences the user has confirmed, skipped or postponed. */
  async loadLoggedOccurrences(
    productIds: readonly string[],
  ): Promise<Map<string, LoggedOccurrence[]>> {
    const grouped = new Map<string, LoggedOccurrence[]>();
    if (productIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('intake_log_entry')
      .select(['product_id', 'intake_plan_dose_id', 'occurrence_date', 'status'])
      .where('product_id', 'in', productIds)
      .where('intake_plan_dose_id', 'is not', null)
      .where('occurrence_date', 'is not', null)
      .where('is_ad_hoc', '=', 0)
      .execute();

    for (const row of rows) {
      if (!row.intake_plan_dose_id || !row.occurrence_date) continue;
      const list = grouped.get(row.product_id) ?? [];
      list.push({
        planDoseId: row.intake_plan_dose_id,
        occurrenceDate: row.occurrence_date as LocalDate,
        status: row.status,
      });
      grouped.set(row.product_id, list);
    }

    return grouped;
  }
}

function toPolicy(row: {
  tracking_enabled: number;
  consumption_source: 'planned' | 'logged';
  reorder_threshold_quantity: number | null;
  reorder_threshold_days: number | null;
  reorder_lead_time_days: number;
}): InventoryPolicy {
  return {
    trackingEnabled: row.tracking_enabled === 1,
    consumptionSource: row.consumption_source,
    reorderThresholdQuantity: row.reorder_threshold_quantity,
    reorderThresholdDays: row.reorder_threshold_days,
    reorderLeadTimeDays: row.reorder_lead_time_days,
  };
}

function toPackage(row: InventoryPackageTable): InventoryPackage {
  return {
    id: row.id,
    productId: row.product_id,
    packageSize: row.package_size,
    unit: row.unit,
    acquiredOn: row.acquired_on,
    openedAt: row.opened_at,
    expirationDate: row.expiration_date,
    lotNumber: row.lot_number,
    status: row.status,
    notes: row.notes,
  };
}
