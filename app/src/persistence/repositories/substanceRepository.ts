import { normalizeName } from '../../domain/products/normalize.js';
import type { PillstackDatabase } from '../database.js';

export interface Substance {
  id: string;
  name: string;
  normalizedName: string;
}

/**
 * Substances are the canonical identity behind active ingredients. Resolving by
 * normalized name means "Magnesium" typed on two different products becomes one
 * substance, which is what lets a single constraint cover both.
 */
export class SubstanceRepository {
  constructor(private readonly db: PillstackDatabase) {}

  async findOrCreate(name: string, id: string, now: string): Promise<Substance> {
    const normalizedName = normalizeName(name);

    const existing = await this.db
      .selectFrom('substance')
      .select(['id', 'name', 'normalized_name'])
      .where('normalized_name', '=', normalizedName)
      .executeTakeFirst();

    if (existing) {
      return { id: existing.id, name: existing.name, normalizedName: existing.normalized_name };
    }

    await this.db
      .insertInto('substance')
      .values({
        id,
        name: name.trim(),
        normalized_name: normalizedName,
        synonyms: null,
        notes: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    return { id, name: name.trim(), normalizedName };
  }

  async list(): Promise<Substance[]> {
    const rows = await this.db
      .selectFrom('substance')
      .select(['id', 'name', 'normalized_name'])
      .orderBy('name', 'asc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      normalizedName: row.normalized_name,
    }));
  }

  async search(term: string, limit = 20): Promise<Substance[]> {
    const rows = await this.db
      .selectFrom('substance')
      .select(['id', 'name', 'normalized_name'])
      .where('normalized_name', 'like', `%${normalizeName(term)}%`)
      .orderBy('name', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      normalizedName: row.normalized_name,
    }));
  }
}
