import {
  addPackageInputSchema,
  correctStockInputSchema,
  updateInventoryPolicyInputSchema,
  type InventoryStatus,
  type InventoryTransaction,
  type LocalDate,
} from '@pillstack/contracts';
import {
  inferredConsumptionOn,
  loggedOccurrenceKeys,
  plannedConsumptionOn,
  type ConsumptionDose,
  type LoggedOccurrence,
} from '../domain/inventory/consumption.js';
import {
  correctionDelta,
  currentQuantity,
  projectDepletion,
  type LedgerEntry,
} from '../domain/inventory/projection.js';
import { instantToLocalDate } from '../domain/schedules/calendar.js';
import type { PillstackDatabase } from '../persistence/database.js';
import { InventoryRepository } from '../persistence/repositories/inventoryRepository.js';
import { ProductRepository } from '../persistence/repositories/productRepository.js';
import { SettingsRepository } from '../persistence/repositories/settingsRepository.js';
import type { Clock } from './clock.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { createId } from './ids.js';

/**
 * Reads the append-only ledger and turns it into the four answers the user
 * wants: how much is left, how long it lasts, when it runs out, when to
 * reorder. Nothing is cached — every figure is re-derived from the ledger, so
 * it cannot drift out of step with what actually happened.
 */
export class InventoryService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
  ) {}

  async statusFor(productId: string): Promise<InventoryStatus> {
    const all = await this.statuses([productId]);
    const status = all[0];
    if (!status) throw new NotFoundError('product', productId);
    return status;
  }

  /** Everything tracked, for the inventory overview and the low-stock warnings. */
  async listStatuses(): Promise<InventoryStatus[]> {
    const products = await new ProductRepository(this.db).list({ active: true });
    return this.statuses(products.map((product) => product.id));
  }

  async ledgerFor(productId: string): Promise<InventoryTransaction[]> {
    await this.requireProduct(productId);
    return new InventoryRepository(this.db).listTransactions(productId);
  }

  /**
   * Records a new package. The quantity added defaults to the full package
   * size, but a part-used package can be entered with an explicit quantity.
   */
  async addPackage(productId: string, rawInput: unknown): Promise<InventoryStatus> {
    const parsed = addPackageInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) throw new ValidationError('invalid package', parsed.error.issues);

    const input = parsed.data;
    const product = await this.requireProduct(productId);
    const now = this.clock.now();
    const today = await this.today();

    const packageSize = input.packageSize ?? product.packageSize;
    const quantity = input.quantity ?? packageSize;
    if (quantity > packageSize) {
      throw new ConflictError('the quantity added cannot exceed the package size');
    }

    const packageId = createId();

    await this.db.transaction().execute(async (trx) => {
      const inventory = new InventoryRepository(trx);

      await inventory.insertPackage({
        id: packageId,
        productId,
        packageSize,
        unit: product.packageUnit,
        acquiredOn: (input.acquiredOn as LocalDate | undefined) ?? today,
        openedAt: input.opened ? today : null,
        expirationDate: (input.expirationDate as LocalDate | undefined) ?? null,
        lotNumber: input.lotNumber ?? null,
        notes: input.notes ?? null,
        createdAt: now.toISOString(),
      });

      await inventory.insertTransaction({
        id: createId(),
        productId,
        inventoryPackageId: packageId,
        transactionType: 'package_added',
        quantityDelta: quantity,
        absoluteQuantity: null,
        occurredAt: now.toISOString(),
        effectiveOn: (input.acquiredOn as LocalDate | undefined) ?? today,
        intakeLogEntryId: null,
        treatmentId: null,
        note: input.notes ?? null,
      });
    });

    return this.statusFor(productId);
  }

  /**
   * The user counted what is actually there. Both the counted figure and the
   * derived delta are stored, and the correction becomes the anchor that later
   * projections start from.
   */
  async correctStock(productId: string, rawInput: unknown): Promise<InventoryStatus> {
    const parsed = correctStockInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid correction', parsed.error.issues);

    const input = parsed.data;
    await this.requireProduct(productId);

    const now = this.clock.now();
    const today = await this.today();
    const effectiveOn = (input.effectiveOn as LocalDate | undefined) ?? today;
    if (effectiveOn > today) {
      throw new ConflictError('a stock count cannot be dated in the future');
    }

    const inventory = new InventoryRepository(this.db);
    const ledger = (await inventory.loadLedger([productId])).get(productId) ?? [];
    const delta = correctionDelta(ledger, effectiveOn, input.countedQuantity);

    await inventory.insertTransaction({
      id: createId(),
      productId,
      inventoryPackageId: null,
      transactionType: 'manual_correction',
      quantityDelta: delta,
      absoluteQuantity: input.countedQuantity,
      occurredAt: now.toISOString(),
      effectiveOn,
      intakeLogEntryId: null,
      treatmentId: null,
      note: input.note ?? null,
    });

    return this.statusFor(productId);
  }

  async discardPackage(productId: string, packageId: string, note?: string | null): Promise<InventoryStatus> {
    await this.requireProduct(productId);

    const inventory = new InventoryRepository(this.db);
    const stockPackage = await inventory.findPackage(packageId);
    if (!stockPackage || stockPackage.productId !== productId) {
      throw new NotFoundError('package', packageId);
    }
    if (stockPackage.status === 'discarded') {
      throw new ConflictError('this package has already been discarded');
    }

    const now = this.clock.now();
    const today = await this.today();

    // What is discarded is whatever is left overall, capped at this package.
    const status = await this.statusFor(productId);
    const discarded = Math.min(Math.max(status.currentQuantity, 0), stockPackage.packageSize);

    await this.db.transaction().execute(async (trx) => {
      const scoped = new InventoryRepository(trx);
      await scoped.setPackageStatus(packageId, 'discarded');
      await scoped.insertTransaction({
        id: createId(),
        productId,
        inventoryPackageId: packageId,
        transactionType: 'package_discarded',
        quantityDelta: -discarded,
        absoluteQuantity: null,
        occurredAt: now.toISOString(),
        effectiveOn: today,
        intakeLogEntryId: null,
        treatmentId: null,
        note: note ?? null,
      });
    });

    return this.statusFor(productId);
  }

  async updatePolicy(productId: string, rawInput: unknown): Promise<InventoryStatus> {
    const parsed = updateInventoryPolicyInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid policy', parsed.error.issues);

    await this.requireProduct(productId);
    await new InventoryRepository(this.db).upsertPolicy(
      productId,
      {
        ...(parsed.data.trackingEnabled !== undefined
          ? { trackingEnabled: parsed.data.trackingEnabled }
          : {}),
        ...(parsed.data.consumptionSource !== undefined
          ? { consumptionSource: parsed.data.consumptionSource }
          : {}),
        ...(parsed.data.reorderThresholdQuantity !== undefined
          ? { reorderThresholdQuantity: parsed.data.reorderThresholdQuantity ?? null }
          : {}),
        ...(parsed.data.reorderThresholdDays !== undefined
          ? { reorderThresholdDays: parsed.data.reorderThresholdDays ?? null }
          : {}),
        ...(parsed.data.reorderLeadTimeDays !== undefined
          ? { reorderLeadTimeDays: parsed.data.reorderLeadTimeDays }
          : {}),
      },
      this.clock.now().toISOString(),
    );

    return this.statusFor(productId);
  }

  private async statuses(productIds: readonly string[]): Promise<InventoryStatus[]> {
    if (productIds.length === 0) return [];

    const inventory = new InventoryRepository(this.db);
    const products = new ProductRepository(this.db);
    const today = await this.today();

    const [ledgers, policies, packages, doses, logged] = await Promise.all([
      inventory.loadLedger(productIds),
      inventory.listPolicies(),
      inventory.listPackages(productIds),
      inventory.loadConsumptionDoses(productIds),
      inventory.loadLoggedOccurrences(productIds),
    ]);

    const statuses: InventoryStatus[] = [];

    for (const productId of productIds) {
      const product = await products.findById(productId);
      if (!product) continue;

      const policy = policies.get(productId) ?? {
        trackingEnabled: true,
        consumptionSource: 'planned' as const,
        reorderThresholdQuantity: null,
        reorderThresholdDays: null,
        reorderLeadTimeDays: 7,
      };

      statuses.push(
        buildStatus({
          product: {
            id: product.id,
            name: product.name,
            category: product.category,
            packageUnit: product.packageUnit,
          },
          policy,
          today,
          ledger: ledgers.get(productId) ?? [],
          doses: doses.get(productId) ?? [],
          logged: logged.get(productId) ?? [],
          packages: packages.get(productId) ?? [],
        }),
      );
    }

    return statuses;
  }

  private async today(): Promise<LocalDate> {
    const timeZone = await new SettingsRepository(this.db).getTimeZone();
    return instantToLocalDate(this.clock.now(), timeZone);
  }

  private async requireProduct(productId: string) {
    const product = await new ProductRepository(this.db).findById(productId);
    if (!product) throw new NotFoundError('product', productId);
    return product;
  }
}

interface StatusProduct {
  id: string;
  name: string;
  category: InventoryStatus['category'];
  packageUnit: InventoryStatus['packageUnit'];
}

interface BuildStatusInput {
  product: StatusProduct;
  policy: InventoryStatus['policy'];
  today: LocalDate;
  ledger: readonly LedgerEntry[];
  doses: readonly ConsumptionDose[];
  logged: readonly LoggedOccurrence[];
  packages: InventoryStatus['packages'];
}

/**
 * Pure assembly of one product's inventory status, kept separate from the
 * repository calls so the whole calculation is easy to follow in one place.
 */
export function buildStatus(input: BuildStatusInput): InventoryStatus {
  const loggedKeys = loggedOccurrenceKeys(input.logged);

  const quantity = currentQuantity({
    ledger: input.ledger,
    asOf: input.today,
    inferredConsumptionOn: (date) =>
      inferredConsumptionOn(
        { doses: input.doses, loggedKeys, consumptionSource: input.policy.consumptionSource },
        date,
      ),
  });

  const projection = projectDepletion({
    startQuantity: quantity,
    asOf: input.today,
    plannedConsumptionOn: (date) => plannedConsumptionOn(input.doses, date),
    reorderLeadTimeDays: input.policy.reorderLeadTimeDays,
    reorderThresholdQuantity: input.policy.reorderThresholdQuantity,
    reorderThresholdDays: input.policy.reorderThresholdDays,
  });

  const expirations = input.packages
    .map((stockPackage) => stockPackage.expirationDate)
    .filter((date): date is LocalDate => date !== null)
    .sort();
  const earliestExpiration = expirations[0] ?? null;

  return {
    productId: input.product.id,
    productName: input.product.name,
    category: input.product.category,
    packageUnit: input.product.packageUnit,
    policy: input.policy,
    currentQuantity: quantity,
    asOf: input.today,
    estimatedDailyConsumption: projection.estimatedDailyConsumption,
    daysOfCover: projection.daysOfCover,
    runOutDate: projection.runOutDate,
    reorderDate: projection.reorderDate,
    reorderReason: projection.reorderReason,
    reorderDue: projection.reorderDate !== null && projection.reorderDate <= input.today,
    packages: input.packages,
    earliestExpiration,
    // Worth flagging: the package goes off before the stock would be used up.
    expiresBeforeDepletion:
      earliestExpiration !== null &&
      (projection.runOutDate === null || earliestExpiration < projection.runOutDate),
  };
}
