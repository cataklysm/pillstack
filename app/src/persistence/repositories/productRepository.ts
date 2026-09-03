import type { ActiveIngredient, Product, ProductListQuery } from '@pillstack/contracts';
import { normalizeName } from '../../domain/products/normalize.js';
import type { PillstackDatabase } from '../database.js';
import type { ActiveIngredientTable, ProductTable } from '../schema.js';

export interface ProductRow {
  product: Omit<ProductTable, 'normalized_name'> & { normalized_name: string };
  ingredients: ActiveIngredient[];
}

export interface InsertProductRecord {
  id: string;
  name: string;
  manufacturer: string | null;
  category: ProductTable['category'];
  dosageForm: ProductTable['dosage_form'];
  packageSize: number;
  packageUnit: ProductTable['package_unit'];
  prescriptionRequired: boolean;
  notes: string | null;
  createdAt: string;
}

export interface InsertIngredientRecord {
  id: string;
  productId: string;
  substanceId: string;
  label: string | null;
  amount: number | null;
  unit: string | null;
  description: string | null;
  sortOrder: number;
}

export class ProductRepository {
  constructor(private readonly db: PillstackDatabase) {}

  async insert(record: InsertProductRecord): Promise<void> {
    await this.db
      .insertInto('product')
      .values({
        id: record.id,
        name: record.name,
        normalized_name: normalizeName(record.name),
        manufacturer: record.manufacturer,
        category: record.category,
        dosage_form: record.dosageForm,
        package_size: record.packageSize,
        package_unit: record.packageUnit,
        prescription_required: record.prescriptionRequired ? 1 : 0,
        notes: record.notes,
        active: 1,
        archived_at: null,
        created_at: record.createdAt,
        updated_at: record.createdAt,
      })
      .execute();
  }

  async update(
    id: string,
    changes: Partial<Omit<InsertProductRecord, 'id' | 'createdAt'>> & { active?: boolean },
    updatedAt: string,
  ): Promise<void> {
    const values: Record<string, unknown> = { updated_at: updatedAt };

    if (changes.name !== undefined) {
      values.name = changes.name;
      values.normalized_name = normalizeName(changes.name);
    }
    if (changes.manufacturer !== undefined) values.manufacturer = changes.manufacturer;
    if (changes.category !== undefined) values.category = changes.category;
    if (changes.dosageForm !== undefined) values.dosage_form = changes.dosageForm;
    if (changes.packageSize !== undefined) values.package_size = changes.packageSize;
    if (changes.packageUnit !== undefined) values.package_unit = changes.packageUnit;
    if (changes.prescriptionRequired !== undefined) {
      values.prescription_required = changes.prescriptionRequired ? 1 : 0;
    }
    if (changes.notes !== undefined) values.notes = changes.notes;
    if (changes.active !== undefined) values.active = changes.active ? 1 : 0;

    await this.db.updateTable('product').set(values).where('id', '=', id).execute();
  }

  /**
   * Products are archived, never deleted: treatment history, the intake log and
   * the inventory ledger all reference them and must keep resolving.
   */
  async archive(id: string, archivedAt: string): Promise<void> {
    await this.db
      .updateTable('product')
      .set({ active: 0, archived_at: archivedAt, updated_at: archivedAt })
      .where('id', '=', id)
      .execute();
  }

  async replaceIngredients(
    productId: string,
    ingredients: readonly InsertIngredientRecord[],
  ): Promise<void> {
    await this.db.deleteFrom('active_ingredient').where('product_id', '=', productId).execute();

    if (ingredients.length === 0) return;

    await this.db
      .insertInto('active_ingredient')
      .values(
        ingredients.map((ingredient) => ({
          id: ingredient.id,
          product_id: ingredient.productId,
          substance_id: ingredient.substanceId,
          label: ingredient.label,
          amount: ingredient.amount,
          unit: ingredient.unit,
          description: ingredient.description,
          sort_order: ingredient.sortOrder,
        })),
      )
      .execute();
  }

  async findById(id: string): Promise<Product | null> {
    const row = await this.db
      .selectFrom('product')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return null;

    const ingredients = await this.loadIngredients([id]);
    return toProduct(row, ingredients.get(id) ?? []);
  }

  async list(query: ProductListQuery): Promise<Product[]> {
    let builder = this.db.selectFrom('product').selectAll();

    if (query.category) builder = builder.where('category', '=', query.category);
    if (query.active !== undefined) builder = builder.where('active', '=', query.active ? 1 : 0);

    if (query.query) {
      const term = `%${normalizeName(query.query)}%`;
      // Matches product name, manufacturer, or any of its active ingredients.
      builder = builder.where((eb) =>
        eb.or([
          eb('normalized_name', 'like', term),
          eb(eb.fn('lower', ['manufacturer']), 'like', term),
          eb.exists(
            eb
              .selectFrom('active_ingredient')
              .innerJoin('substance', 'substance.id', 'active_ingredient.substance_id')
              .select('active_ingredient.id')
              .whereRef('active_ingredient.product_id', '=', 'product.id')
              .where('substance.normalized_name', 'like', term),
          ),
        ]),
      );
    }

    const rows = await builder.orderBy('name', 'asc').execute();
    const ingredients = await this.loadIngredients(rows.map((row) => row.id));

    return rows.map((row) => toProduct(row, ingredients.get(row.id) ?? []));
  }

  private async loadIngredients(productIds: readonly string[]): Promise<Map<string, ActiveIngredient[]>> {
    const grouped = new Map<string, ActiveIngredient[]>();
    if (productIds.length === 0) return grouped;

    const rows = await this.db
      .selectFrom('active_ingredient')
      .innerJoin('substance', 'substance.id', 'active_ingredient.substance_id')
      .select([
        'active_ingredient.id as id',
        'active_ingredient.product_id as product_id',
        'active_ingredient.substance_id as substance_id',
        'active_ingredient.label as label',
        'active_ingredient.amount as amount',
        'active_ingredient.unit as unit',
        'active_ingredient.description as description',
        'active_ingredient.sort_order as sort_order',
        'substance.name as substance_name',
      ])
      .where('active_ingredient.product_id', 'in', productIds)
      .orderBy('active_ingredient.sort_order', 'asc')
      .execute();

    for (const row of rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push({
        id: row.id,
        substanceId: row.substance_id,
        substanceName: row.substance_name,
        label: row.label,
        amount: row.amount,
        unit: row.unit,
        description: row.description,
        sortOrder: row.sort_order,
      });
      grouped.set(row.product_id, list);
    }

    return grouped;
  }
}

function toProduct(row: ProductTable, ingredients: ActiveIngredient[]): Product {
  return {
    id: row.id,
    name: row.name,
    manufacturer: row.manufacturer,
    category: row.category,
    dosageForm: row.dosage_form,
    packageSize: row.package_size,
    packageUnit: row.package_unit,
    prescriptionRequired: row.prescription_required === 1,
    notes: row.notes,
    active: row.active === 1,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ingredients,
  };
}

export type { ActiveIngredientTable };
