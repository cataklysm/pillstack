import { z } from 'zod';
import {
  dosageFormSchema,
  identifierSchema,
  instantSchema,
  packageUnitSchema,
  productCategorySchema,
} from './common.js';

export const activeIngredientSchema = z.object({
  id: identifierSchema,
  substanceId: identifierSchema,
  substanceName: z.string(),
  label: z.string().nullable(),
  amount: z.number().nullable(),
  unit: z.string().nullable(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
});

export const productSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  manufacturer: z.string().nullable(),
  category: productCategorySchema,
  dosageForm: dosageFormSchema,
  packageSize: z.number().positive(),
  packageUnit: packageUnitSchema,
  prescriptionRequired: z.boolean(),
  notes: z.string().nullable(),
  active: z.boolean(),
  archivedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  ingredients: z.array(activeIngredientSchema),
});

/**
 * Ingredients are supplied by substance *name*. The service resolves each name
 * to a canonical `substance` row, creating it on first use, so that constraints
 * written against a substance apply to every product containing it.
 */
export const ingredientInputSchema = z.object({
  substanceName: z.string().min(1).max(200),
  label: z.string().max(200).nullish(),
  amount: z.number().positive().nullish(),
  unit: z.string().max(20).nullish(),
  description: z.string().max(1000).nullish(),
});

export const createProductInputSchema = z.object({
  name: z.string().min(1).max(200),
  manufacturer: z.string().max(200).nullish(),
  category: productCategorySchema,
  dosageForm: dosageFormSchema,
  packageSize: z.number().positive(),
  packageUnit: packageUnitSchema,
  prescriptionRequired: z.boolean().default(false),
  notes: z.string().max(4000).nullish(),
  ingredients: z.array(ingredientInputSchema).default([]),
});

/**
 * Spelled out rather than derived from `createProductInputSchema.partial()`.
 * Deriving it would inherit that schema's defaults, so a request that only
 * changed a note would arrive carrying `ingredients: []` and silently wipe the
 * product's ingredient list. Here, absent means absent.
 */
export const updateProductInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  manufacturer: z.string().max(200).nullish(),
  category: productCategorySchema.optional(),
  dosageForm: dosageFormSchema.optional(),
  packageSize: z.number().positive().optional(),
  packageUnit: packageUnitSchema.optional(),
  prescriptionRequired: z.boolean().optional(),
  notes: z.string().max(4000).nullish(),
  ingredients: z.array(ingredientInputSchema).optional(),
  active: z.boolean().optional(),
});

export const productListQuerySchema = z.object({
  category: productCategorySchema.optional(),
  active: z.boolean().optional(),
  query: z.string().max(200).optional(),
});

export type ActiveIngredient = z.infer<typeof activeIngredientSchema>;
export type Product = z.infer<typeof productSchema>;
export type IngredientInput = z.infer<typeof ingredientInputSchema>;
export type CreateProductInput = z.input<typeof createProductInputSchema>;
export type UpdateProductInput = z.input<typeof updateProductInputSchema>;
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
