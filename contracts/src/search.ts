import { z } from 'zod';
import { identifierSchema, productCategorySchema } from './common.js';

export const searchHitSchema = z.object({
  kind: z.enum(['product', 'substance']),
  id: identifierSchema,
  name: z.string(),
  /** Where the match came from: manufacturer, an ingredient name, the product name. */
  matchedOn: z.string(),
  category: productCategorySchema.nullable(),
  productId: identifierSchema.nullable(),
});

export const searchResultSchema = z.object({
  query: z.string(),
  hits: z.array(searchHitSchema),
});

export type SearchHit = z.infer<typeof searchHitSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
