import { z } from 'zod';
import { identifierSchema, instantSchema, localDateSchema } from './common.js';

/** Optional patient details printed on the physician plan. */
export const patientDetailsSchema = z.object({
  patientName: z.string().max(200).nullish(),
  dateOfBirth: localDateSchema.nullish(),
  physicianNote: z.string().max(4000).nullish(),
});

export const medicationPlanQuerySchema = patientDetailsSchema.extend({
  /** The plan as it stood on this date; defaults to today. */
  asOf: localDateSchema.nullish(),
});

export const treatmentHistoryQuerySchema = patientDetailsSchema.extend({
  from: localDateSchema.nullish(),
  includeStopped: z.boolean().nullish(),
});

/** One printed line of the medication plan. */
export const medicationPlanEntrySchema = z.object({
  productId: identifierSchema,
  productName: z.string(),
  activeIngredients: z.string(),
  dose: z.string(),
  schedule: z.string(),
  since: localDateSchema,
  indication: z.string().nullable(),
  note: z.string().nullable(),
});

export const medicationPlanSchema = z.object({
  generatedAt: instantSchema,
  asOf: localDateSchema,
  patientName: z.string().nullable(),
  dateOfBirth: localDateSchema.nullable(),
  physicianNote: z.string().nullable(),
  medications: z.array(medicationPlanEntrySchema),
  supplements: z.array(medicationPlanEntrySchema),
});

export const treatmentHistoryEntrySchema = z.object({
  treatmentId: identifierSchema,
  productName: z.string(),
  activeIngredients: z.string(),
  category: z.enum(['medication', 'supplement']),
  startedOn: localDateSchema,
  endedOn: localDateSchema.nullable(),
  indication: z.string().nullable(),
  prescriber: z.string().nullable(),
  stopReason: z.string().nullable(),
  events: z.array(
    z.object({
      occurredOn: localDateSchema,
      eventType: z.string(),
      summary: z.string(),
      reason: z.string().nullable(),
    }),
  ),
});

export const treatmentHistoryReportSchema = z.object({
  generatedAt: instantSchema,
  patientName: z.string().nullable(),
  dateOfBirth: localDateSchema.nullable(),
  physicianNote: z.string().nullable(),
  from: localDateSchema.nullable(),
  entries: z.array(treatmentHistoryEntrySchema),
});

/**
 * The human-readable export, deliberately separate from a database backup.
 * A backup restores PillStack; this is for moving the data somewhere else.
 * The version is frozen: a future version 2 gets its own schema and an upgrade
 * function so old files stay importable.
 */
export const JSON_EXPORT_FORMAT = 'pillstack/export';
export const JSON_EXPORT_VERSION = 1;

export const jsonExportSchema = z.object({
  format: z.literal(JSON_EXPORT_FORMAT),
  version: z.literal(JSON_EXPORT_VERSION),
  exportedAt: instantSchema,
  appVersion: z.string(),
  timeZone: z.string(),
  substances: z.array(z.record(z.string(), z.unknown())),
  products: z.array(z.record(z.string(), z.unknown())),
  treatments: z.array(z.record(z.string(), z.unknown())),
  constraints: z.array(z.record(z.string(), z.unknown())),
  inventory: z.array(z.record(z.string(), z.unknown())),
  intakeLog: z.array(z.record(z.string(), z.unknown())),
  dayProfiles: z.array(z.record(z.string(), z.unknown())),
  settings: z.record(z.string(), z.unknown()),
});

export const importResultSchema = z.object({
  substances: z.number().int(),
  products: z.number().int(),
  treatments: z.number().int(),
  constraints: z.number().int(),
  inventoryTransactions: z.number().int(),
  intakeLogEntries: z.number().int(),
});

export type PatientDetails = z.input<typeof patientDetailsSchema>;
export type MedicationPlanEntry = z.infer<typeof medicationPlanEntrySchema>;
export type MedicationPlan = z.infer<typeof medicationPlanSchema>;
export type TreatmentHistoryEntry = z.infer<typeof treatmentHistoryEntrySchema>;
export type TreatmentHistoryReport = z.infer<typeof treatmentHistoryReportSchema>;
export type JsonExport = z.infer<typeof jsonExportSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
