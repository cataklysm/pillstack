import { z } from 'zod';
import {
  identifierSchema,
  instantSchema,
  localDateSchema,
  packageUnitSchema,
  productCategorySchema,
} from './common.js';

export const inventoryTransactionTypeSchema = z.enum([
  'package_added',
  'dose_consumed',
  'manual_correction',
  'package_discarded',
  'treatment_paused',
  'other',
]);

export const inventoryPackageStatusSchema = z.enum(['sealed', 'open', 'depleted', 'discarded']);

export const consumptionSourceSchema = z.enum(['planned', 'logged']);

export const inventoryPackageSchema = z.object({
  id: identifierSchema,
  productId: identifierSchema,
  packageSize: z.number().positive(),
  unit: z.string(),
  acquiredOn: localDateSchema.nullable(),
  openedAt: localDateSchema.nullable(),
  expirationDate: localDateSchema.nullable(),
  lotNumber: z.string().nullable(),
  status: inventoryPackageStatusSchema,
  notes: z.string().nullable(),
});

export const inventoryTransactionSchema = z.object({
  id: identifierSchema,
  productId: identifierSchema,
  inventoryPackageId: identifierSchema.nullable(),
  transactionType: inventoryTransactionTypeSchema,
  quantityDelta: z.number(),
  absoluteQuantity: z.number().nullable(),
  occurredAt: instantSchema,
  effectiveOn: localDateSchema,
  note: z.string().nullable(),
});

export const inventoryPolicySchema = z.object({
  trackingEnabled: z.boolean(),
  consumptionSource: consumptionSourceSchema,
  reorderThresholdQuantity: z.number().nullable(),
  reorderThresholdDays: z.number().int().nullable(),
  reorderLeadTimeDays: z.number().int(),
});

/** Why the reorder date is what it is — shown so the number is never a black box. */
export const reorderReasonSchema = z.enum(['lead_time', 'threshold_quantity', 'threshold_days']);

export const inventoryStatusSchema = z.object({
  productId: identifierSchema,
  productName: z.string(),
  category: productCategorySchema,
  packageUnit: packageUnitSchema,
  policy: inventoryPolicySchema,

  /** Stock at the end of `asOf`, derived from the ledger — never a stored number. */
  currentQuantity: z.number(),
  /** False when no package or count has ever been recorded for this product. */
  stockRecorded: z.boolean(),
  asOf: localDateSchema,

  estimatedDailyConsumption: z.number(),
  /** Days from `asOf` until the run-out date; null when nothing is scheduled. */
  daysOfCover: z.number().int().nullable(),
  runOutDate: localDateSchema.nullable(),
  reorderDate: localDateSchema.nullable(),
  reorderReason: reorderReasonSchema.nullable(),
  reorderDue: z.boolean(),

  packages: z.array(inventoryPackageSchema),
  earliestExpiration: localDateSchema.nullable(),
  /** True when a package expires before the stock would be used up. */
  expiresBeforeDepletion: z.boolean(),
});

export const addPackageInputSchema = z.object({
  packageSize: z.number().positive().nullish(),
  quantity: z.number().positive().nullish(),
  acquiredOn: localDateSchema.nullish(),
  opened: z.boolean().nullish(),
  expirationDate: localDateSchema.nullish(),
  lotNumber: z.string().max(80).nullish(),
  notes: z.string().max(1000).nullish(),
});

/**
 * The user counts what is actually in the drawer. Both the counted figure and
 * the derived delta are stored, so the ledger stays readable.
 */
export const correctStockInputSchema = z.object({
  countedQuantity: z.number().min(0),
  effectiveOn: localDateSchema.nullish(),
  note: z.string().max(1000).nullish(),
});

export const discardPackageInputSchema = z.object({
  packageId: identifierSchema,
  note: z.string().max(1000).nullish(),
});

export const updateInventoryPolicyInputSchema = z.object({
  trackingEnabled: z.boolean().optional(),
  consumptionSource: consumptionSourceSchema.optional(),
  reorderThresholdQuantity: z.number().min(0).nullish(),
  reorderThresholdDays: z.number().int().min(0).nullish(),
  reorderLeadTimeDays: z.number().int().min(0).optional(),
});

export type InventoryPackage = z.infer<typeof inventoryPackageSchema>;
export type InventoryTransaction = z.infer<typeof inventoryTransactionSchema>;
export type InventoryPolicy = z.infer<typeof inventoryPolicySchema>;
export type InventoryStatus = z.infer<typeof inventoryStatusSchema>;
export type ReorderReason = z.infer<typeof reorderReasonSchema>;
export type ConsumptionSource = z.infer<typeof consumptionSourceSchema>;
export type AddPackageInput = z.input<typeof addPackageInputSchema>;
export type CorrectStockInput = z.input<typeof correctStockInputSchema>;
export type UpdateInventoryPolicyInput = z.input<typeof updateInventoryPolicyInputSchema>;
