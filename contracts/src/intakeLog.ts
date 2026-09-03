import { z } from 'zod';
import {
  identifierSchema,
  instantSchema,
  intakeStatusSchema,
  localDateSchema,
} from './common.js';

export const intakeLogEntrySchema = z.object({
  id: identifierSchema,
  productId: identifierSchema,
  treatmentId: identifierSchema.nullable(),
  intakePlanDoseId: identifierSchema.nullable(),
  occurrenceDate: localDateSchema.nullable(),
  scheduledAt: instantSchema.nullable(),
  actualAt: instantSchema.nullable(),
  recordedAt: instantSchema,
  status: intakeStatusSchema,
  doseAmount: z.number().nullable(),
  doseUnit: z.string().nullable(),
  packageUnitQuantity: z.number().nullable(),
  note: z.string().nullable(),
});

/**
 * Recording an intake is always optional. Inventory projections fall back to
 * the plan for any occurrence that was never confirmed, so the numbers stay
 * useful whether or not the user ticks every dose off.
 */
export const recordIntakeInputSchema = z.object({
  planDoseId: identifierSchema,
  occurrenceDate: localDateSchema,
  status: intakeStatusSchema,
  /** When the dose was due, as shown on the timeline. */
  scheduledAt: instantSchema.nullish(),
  actualAt: instantSchema.nullish(),
  postponedTo: instantSchema.nullish(),
  note: z.string().max(1000).nullish(),
});

export const clearIntakeInputSchema = z.object({
  planDoseId: identifierSchema,
  occurrenceDate: localDateSchema,
});

export type IntakeLogEntry = z.infer<typeof intakeLogEntrySchema>;
export type RecordIntakeInput = z.input<typeof recordIntakeInputSchema>;
export type ClearIntakeInput = z.input<typeof clearIntakeInputSchema>;
