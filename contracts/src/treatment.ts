import { z } from 'zod';
import {
  identifierSchema,
  instantSchema,
  localDateSchema,
  treatmentEventTypeSchema,
  treatmentStatusSchema,
} from './common.js';
import { intakePlanSchema, planDefinitionSchema } from './schedule.js';

export const treatmentSchema = z.object({
  id: identifierSchema,
  productId: identifierSchema,
  productName: z.string(),
  indication: z.string().nullable(),
  prescriber: z.string().nullable(),
  status: treatmentStatusSchema,
  startedOn: localDateSchema,
  endedOn: localDateSchema.nullable(),
  stopReason: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  currentPlan: intakePlanSchema.nullable(),
});

export const startTreatmentInputSchema = z.object({
  productId: identifierSchema,
  indication: z.string().max(500).nullish(),
  prescriber: z.string().max(200).nullish(),
  startedOn: localDateSchema,
  notes: z.string().max(4000).nullish(),
  plan: planDefinitionSchema,
});

/**
 * Replaces the current plan with a new version from `effectiveFrom` onward.
 * The previous version is closed, never edited, so the history stays intact.
 */
export const changePlanInputSchema = z.object({
  effectiveFrom: localDateSchema,
  changeReason: z.string().max(500).nullish(),
  plan: planDefinitionSchema,
});

export const pauseTreatmentInputSchema = z.object({
  pausedFrom: localDateSchema,
  reason: z.string().max(500).nullish(),
});

export const resumeTreatmentInputSchema = z.object({
  resumedOn: localDateSchema,
});

export const stopTreatmentInputSchema = z.object({
  endedOn: localDateSchema,
  stopReason: z.string().max(500).nullish(),
});

export const treatmentEventSchema = z.object({
  id: identifierSchema,
  treatmentId: identifierSchema,
  eventType: treatmentEventTypeSchema,
  occurredOn: localDateSchema,
  recordedAt: instantSchema,
  fromPlanId: identifierSchema.nullable(),
  toPlanId: identifierSchema.nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  summary: z.string(),
});

export const treatmentHistorySchema = z.object({
  treatment: treatmentSchema,
  events: z.array(treatmentEventSchema),
  planVersions: z.array(intakePlanSchema),
});

export type Treatment = z.infer<typeof treatmentSchema>;
export type StartTreatmentInput = z.input<typeof startTreatmentInputSchema>;
export type ChangePlanInput = z.input<typeof changePlanInputSchema>;
export type PauseTreatmentInput = z.input<typeof pauseTreatmentInputSchema>;
export type ResumeTreatmentInput = z.input<typeof resumeTreatmentInputSchema>;
export type StopTreatmentInput = z.input<typeof stopTreatmentInputSchema>;
export type TreatmentEvent = z.infer<typeof treatmentEventSchema>;
export type TreatmentHistory = z.infer<typeof treatmentHistorySchema>;
