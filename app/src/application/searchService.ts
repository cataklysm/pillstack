import type { SearchHit, SearchResult } from '@pillstack/contracts';
import { normalizeName } from '../domain/products/normalize.js';
import type { PillstackDatabase } from '../persistence/database.js';

/**
 * Search across product names, manufacturers and active ingredients.
 *
 * At single-user scale (tens to low hundreds of products) a LIKE scan over the
 * stored `normalized_name` columns is instant, so no FTS5 index is carried.
 * Those columns are the upgrade path if that ever stops being true.
 */
export class SearchService {
  constructor(private readonly db: PillstackDatabase) {}

  async search(rawQuery: string, limit = 25): Promise<SearchResult> {
    const query = rawQuery.trim();
    if (query.length === 0) return { query, hits: [] };

    const term = `%${normalizeName(query)}%`;

    const [productRows, ingredientRows, substanceRows] = await Promise.all([
      this.db
        .selectFrom('product')
        .select(['id', 'name', 'manufacturer', 'category', 'normalized_name'])
        .where((eb) =>
          eb.or([
            eb('normalized_name', 'like', term),
            eb(eb.fn('lower', ['manufacturer']), 'like', term),
          ]),
        )
        .orderBy('name', 'asc')
        .limit(limit)
        .execute(),

      this.db
        .selectFrom('active_ingredient')
        .innerJoin('substance', 'substance.id', 'active_ingredient.substance_id')
        .innerJoin('product', 'product.id', 'active_ingredient.product_id')
        .select([
          'product.id as product_id',
          'product.name as product_name',
          'product.category as category',
          'substance.name as substance_name',
        ])
        .where('substance.normalized_name', 'like', term)
        .orderBy('product.name', 'asc')
        .limit(limit)
        .execute(),

      this.db
        .selectFrom('substance')
        .select(['id', 'name'])
        .where('normalized_name', 'like', term)
        .orderBy('name', 'asc')
        .limit(limit)
        .execute(),
    ]);

    const hits: SearchHit[] = [];
    const seen = new Set<string>();

    const push = (hit: SearchHit) => {
      const key = `${hit.kind}:${hit.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push(hit);
    };

    for (const row of productRows) {
      const matchedOn =
        row.normalized_name.includes(normalizeName(query)) ? 'product name' : 'manufacturer';
      push({
        kind: 'product',
        id: row.id,
        name: row.name,
        matchedOn,
        category: row.category,
        productId: row.id,
      });
    }

    for (const row of ingredientRows) {
      push({
        kind: 'product',
        id: row.product_id,
        name: row.product_name,
        matchedOn: `ingredient: ${row.substance_name}`,
        category: row.category,
        productId: row.product_id,
      });
    }

    for (const row of substanceRows) {
      push({
        kind: 'substance',
        id: row.id,
        name: row.name,
        matchedOn: 'active ingredient',
        category: null,
        productId: null,
      });
    }

    return { query, hits: hits.slice(0, limit) };
  }
}
