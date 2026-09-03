import {
  createProductInputSchema,
  productListQuerySchema,
  updateProductInputSchema,
  type Product,
  type ProductListQuery,
} from '@pillstack/contracts';
import type { PillstackDatabase } from '../persistence/database.js';
import { ProductRepository } from '../persistence/repositories/productRepository.js';
import { SubstanceRepository } from '../persistence/repositories/substanceRepository.js';
import type { Clock } from './clock.js';
import { NotFoundError, ValidationError } from './errors.js';
import { createId } from './ids.js';

export class ProductService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
  ) {}

  async create(rawInput: unknown): Promise<Product> {
    const parsed = createProductInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid product', parsed.error.issues);

    const input = parsed.data;
    const now = this.clock.now().toISOString();
    const productId = createId();

    await this.db.transaction().execute(async (trx) => {
      const products = new ProductRepository(trx);
      const substances = new SubstanceRepository(trx);

      await products.insert({
        id: productId,
        name: input.name,
        manufacturer: input.manufacturer ?? null,
        category: input.category,
        dosageForm: input.dosageForm,
        packageSize: input.packageSize,
        packageUnit: input.packageUnit,
        prescriptionRequired: input.prescriptionRequired,
        notes: input.notes ?? null,
        createdAt: now,
      });

      await this.writeIngredients(products, substances, productId, input.ingredients, now);

      // Every product gets a reorder policy row so inventory (Milestone 2) has
      // somewhere to record settings without a special case for older products.
      await trx
        .insertInto('inventory_policy')
        .values({
          product_id: productId,
          tracking_enabled: 1,
          consumption_source: 'planned',
          reorder_threshold_quantity: null,
          reorder_threshold_days: null,
          reorder_lead_time_days: 7,
          updated_at: now,
        })
        .execute();
    });

    const created = await new ProductRepository(this.db).findById(productId);
    if (!created) throw new NotFoundError('product', productId);
    return created;
  }

  async update(id: string, rawInput: unknown): Promise<Product> {
    const parsed = updateProductInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid product', parsed.error.issues);

    const input = parsed.data;
    const now = this.clock.now().toISOString();

    const existing = await new ProductRepository(this.db).findById(id);
    if (!existing) throw new NotFoundError('product', id);

    await this.db.transaction().execute(async (trx) => {
      const products = new ProductRepository(trx);
      const substances = new SubstanceRepository(trx);

      await products.update(
        id,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.manufacturer !== undefined ? { manufacturer: input.manufacturer ?? null } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.dosageForm !== undefined ? { dosageForm: input.dosageForm } : {}),
          ...(input.packageSize !== undefined ? { packageSize: input.packageSize } : {}),
          ...(input.packageUnit !== undefined ? { packageUnit: input.packageUnit } : {}),
          ...(input.prescriptionRequired !== undefined
            ? { prescriptionRequired: input.prescriptionRequired }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
        now,
      );

      if (input.ingredients !== undefined) {
        await this.writeIngredients(products, substances, id, input.ingredients, now);
      }
    });

    const updated = await new ProductRepository(this.db).findById(id);
    if (!updated) throw new NotFoundError('product', id);
    return updated;
  }

  /**
   * Archiving keeps the row and every reference to it intact. Hard deletion is
   * deliberately not offered: the treatment history, intake log and inventory
   * ledger all point at products and must keep resolving.
   */
  async archive(id: string): Promise<Product> {
    const products = new ProductRepository(this.db);
    const existing = await products.findById(id);
    if (!existing) throw new NotFoundError('product', id);

    await products.archive(id, this.clock.now().toISOString());

    const archived = await products.findById(id);
    if (!archived) throw new NotFoundError('product', id);
    return archived;
  }

  async list(rawQuery: unknown): Promise<Product[]> {
    const parsed = productListQuerySchema.safeParse(rawQuery ?? {});
    if (!parsed.success) throw new ValidationError('invalid query', parsed.error.issues);
    return new ProductRepository(this.db).list(parsed.data as ProductListQuery);
  }

  async findById(id: string): Promise<Product> {
    const product = await new ProductRepository(this.db).findById(id);
    if (!product) throw new NotFoundError('product', id);
    return product;
  }

  /** Canonical substances, for the endpoint picker when writing a constraint. */
  async listSubstances(query?: string) {
    const substances = new SubstanceRepository(this.db);
    return query ? substances.search(query) : substances.list();
  }

  private async writeIngredients(
    products: ProductRepository,
    substances: SubstanceRepository,
    productId: string,
    ingredients: readonly {
      substanceName: string;
      label?: string | null | undefined;
      amount?: number | null | undefined;
      unit?: string | null | undefined;
      description?: string | null | undefined;
    }[],
    now: string,
  ): Promise<void> {
    const records = [];

    for (const [index, ingredient] of ingredients.entries()) {
      const substance = await substances.findOrCreate(ingredient.substanceName, createId(), now);
      records.push({
        id: createId(),
        productId,
        substanceId: substance.id,
        label: ingredient.label ?? null,
        amount: ingredient.amount ?? null,
        unit: ingredient.unit ?? null,
        description: ingredient.description ?? null,
        sortOrder: index,
      });
    }

    await products.replaceIngredients(productId, records);
  }
}
