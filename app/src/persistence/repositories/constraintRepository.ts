import type { ConstraintEndpoint, IntakeConstraint, LocalTime } from '@pillstack/contracts';
import { describeConstraint } from '../../domain/constraints/summary.js';
import type { PillstackDatabase } from '../database.js';
import type { IntakeConstraintTable } from '../schema.js';

/**
 * Constraints are stored with typed foreign keys per endpoint kind rather than
 * a generic reference column, so deleting a product or substance cannot leave
 * a rule pointing at nothing.
 */
export class ConstraintRepository {
  constructor(private readonly db: PillstackDatabase) {}

  async list(): Promise<IntakeConstraint[]> {
    const rows = await this.db
      .selectFrom('intake_constraint')
      .leftJoin('product as source_product', 'source_product.id', 'intake_constraint.source_product_id')
      .leftJoin('substance as source_substance', 'source_substance.id', 'intake_constraint.source_substance_id')
      .leftJoin('product as target_product', 'target_product.id', 'intake_constraint.target_product_id')
      .leftJoin('substance as target_substance', 'target_substance.id', 'intake_constraint.target_substance_id')
      .selectAll('intake_constraint')
      .select([
        'source_product.name as source_product_name',
        'source_substance.name as source_substance_name',
        'target_product.name as target_product_name',
        'target_substance.name as target_substance_name',
      ])
      .orderBy('intake_constraint.created_at', 'asc')
      .execute();

    return rows.map(toConstraint);
  }

  async findById(id: string): Promise<IntakeConstraint | null> {
    const all = await this.list();
    return all.find((constraint) => constraint.id === id) ?? null;
  }

  async insert(record: {
    id: string;
    constraintType: IntakeConstraintTable['constraint_type'];
    severity: string;
    source: ConstraintEndpoint;
    target: ConstraintEndpoint | null;
    minimumDistanceMinutes: number | null;
    foodOffsetMinutes: number | null;
    preferredTimeFrom: string | null;
    preferredTimeTo: string | null;
    explanation: string | null;
    enabled: boolean;
    now: string;
  }): Promise<void> {
    await this.db
      .insertInto('intake_constraint')
      .values({
        id: record.id,
        constraint_type: record.constraintType,
        severity: record.severity,
        ...sourceColumns(record.source),
        ...targetColumns(record.target),
        minimum_distance_minutes: record.minimumDistanceMinutes,
        food_offset_minutes: record.foodOffsetMinutes,
        preferred_time_from: record.preferredTimeFrom,
        preferred_time_to: record.preferredTimeTo,
        explanation: record.explanation,
        origin: 'user',
        catalog_ref: null,
        enabled: record.enabled ? 1 : 0,
        created_at: record.now,
        updated_at: record.now,
      })
      .execute();
  }

  async replace(
    id: string,
    record: Parameters<ConstraintRepository['insert']>[0],
  ): Promise<void> {
    await this.db
      .updateTable('intake_constraint')
      .set({
        constraint_type: record.constraintType,
        severity: record.severity,
        ...sourceColumns(record.source),
        ...targetColumns(record.target),
        minimum_distance_minutes: record.minimumDistanceMinutes,
        food_offset_minutes: record.foodOffsetMinutes,
        preferred_time_from: record.preferredTimeFrom,
        preferred_time_to: record.preferredTimeTo,
        explanation: record.explanation,
        enabled: record.enabled ? 1 : 0,
        updated_at: record.now,
      })
      .where('id', '=', id)
      .execute();
  }

  async setEnabled(id: string, enabled: boolean, now: string): Promise<void> {
    await this.db
      .updateTable('intake_constraint')
      .set({ enabled: enabled ? 1 : 0, updated_at: now })
      .where('id', '=', id)
      .execute();
  }

  /** User-authored rules can be removed outright; they are not history. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('intake_constraint').where('id', '=', id).execute();
  }

  /** Substances per product, so substance-level rules match a scheduled intake. */
  async loadSubstancesByProduct(): Promise<Map<string, string[]>> {
    const rows = await this.db
      .selectFrom('active_ingredient')
      .select(['product_id', 'substance_id'])
      .execute();

    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const list = grouped.get(row.product_id) ?? [];
      list.push(row.substance_id);
      grouped.set(row.product_id, list);
    }
    return grouped;
  }
}

/**
 * The endpoint columns, written out per side rather than built from computed
 * keys so the column names stay visible to the type checker and a typo becomes
 * a compile error instead of a silent null.
 */
function sourceColumns(endpoint: ConstraintEndpoint) {
  return {
    source_kind: endpoint.kind,
    source_product_id: endpoint.kind === 'product' ? endpoint.productId : null,
    source_substance_id: endpoint.kind === 'substance' ? endpoint.substanceId : null,
    source_category: endpoint.kind === 'category' ? endpoint.category : null,
  };
}

function targetColumns(endpoint: ConstraintEndpoint | null) {
  return {
    target_kind: endpoint?.kind ?? null,
    target_product_id: endpoint?.kind === 'product' ? endpoint.productId : null,
    target_substance_id: endpoint?.kind === 'substance' ? endpoint.substanceId : null,
    target_category: endpoint?.kind === 'category' ? endpoint.category : null,
    target_meal: endpoint?.kind === 'meal' ? endpoint.meal : null,
    target_food_label: endpoint?.kind === 'food' ? endpoint.label : null,
  };
}

interface ConstraintRow extends IntakeConstraintTable {
  source_product_name: string | null;
  source_substance_name: string | null;
  target_product_name: string | null;
  target_substance_name: string | null;
}

function toConstraint(row: ConstraintRow): IntakeConstraint {
  const source = readEndpoint('source', row);
  const target = readEndpoint('target', row);

  const base = {
    id: row.id,
    constraintType: row.constraint_type as IntakeConstraint['constraintType'],
    severity: row.severity as IntakeConstraint['severity'],
    // A row that somehow lost its source is unusable; fall back to a category
    // endpoint so the list still renders rather than throwing.
    source: source ?? { kind: 'category' as const, category: 'medication' as const },
    target,
    minimumDistanceMinutes: row.minimum_distance_minutes,
    foodOffsetMinutes: row.food_offset_minutes,
    preferredTimeFrom: row.preferred_time_from as LocalTime | null,
    preferredTimeTo: row.preferred_time_to as LocalTime | null,
    explanation: row.explanation,
    origin: row.origin as IntakeConstraint['origin'],
    enabled: row.enabled === 1,
  };

  return { ...base, summary: describeConstraint(base) };
}

function readEndpoint(side: 'source' | 'target', row: ConstraintRow): ConstraintEndpoint | null {
  const kind = side === 'source' ? row.source_kind : row.target_kind;
  if (!kind) return null;

  switch (kind) {
    case 'product': {
      const productId = side === 'source' ? row.source_product_id : row.target_product_id;
      const name = side === 'source' ? row.source_product_name : row.target_product_name;
      return productId ? { kind: 'product', productId, name } : null;
    }
    case 'substance': {
      const substanceId = side === 'source' ? row.source_substance_id : row.target_substance_id;
      const name = side === 'source' ? row.source_substance_name : row.target_substance_name;
      return substanceId ? { kind: 'substance', substanceId, name } : null;
    }
    case 'category': {
      const category = side === 'source' ? row.source_category : row.target_category;
      return category === 'medication' || category === 'supplement'
        ? { kind: 'category', category }
        : null;
    }
    case 'meal':
      return row.target_meal
        ? { kind: 'meal', meal: row.target_meal as 'breakfast' | 'lunch' | 'dinner' }
        : null;
    case 'food':
      return row.target_food_label ? { kind: 'food', label: row.target_food_label } : null;
    default:
      return null;
  }
}
