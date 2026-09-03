import { z } from 'zod';
import {
  doseFlexibilitySchema,
  identifierSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  mealReferenceSchema,
  recurrenceTypeSchema,
  timingTypeSchema,
  weekdayMaskSchema,
} from './common.js';

/**
 * One dose occurrence inside a recurrence pattern. Two rows means twice a day.
 *
 * `doseAmount`/`doseUnit` is the clinical dose shown to the user and printed on
 * the physician plan ("5 mg"). `packageUnitQuantity` is what the dose consumes
 * from stock ("1 tablet"). They are kept separate on purpose: no implicit
 * mg-to-tablet arithmetic happens anywhere in the system.
 */
export const planDoseInputSchema = z
  .object({
    label: z.string().max(80).nullish(),
    timingType: timingTypeSchema,
    targetTime: localTimeSchema.nullish(),
    windowStartTime: localTimeSchema.nullish(),
    windowEndTime: localTimeSchema.nullish(),
    mealReference: mealReferenceSchema.nullish(),
    mealOffsetMinutes: z.number().int().min(-720).max(720).default(0),
    flexibility: doseFlexibilitySchema.default('flexible'),
    doseAmount: z.number().positive(),
    doseUnit: z.string().min(1).max(20),
    packageUnitQuantity: z.number().min(0).nullish(),
  })
  .superRefine((dose, ctx) => {
    if (dose.timingType === 'fixed' && !dose.targetTime) {
      ctx.addIssue({ code: 'custom', message: 'targetTime is required for a fixed dose' });
    }
    if (dose.timingType === 'window' && !(dose.windowStartTime && dose.windowEndTime)) {
      ctx.addIssue({ code: 'custom', message: 'a window dose needs windowStartTime and windowEndTime' });
    }
    if (dose.timingType === 'meal_relative' && !dose.mealReference) {
      ctx.addIssue({ code: 'custom', message: 'mealReference is required for a meal-relative dose' });
    }
  });

export const planDefinitionSchema = z
  .object({
    recurrenceType: recurrenceTypeSchema,
    intervalDays: z.number().int().min(1).max(365).nullish(),
    anchorDate: localDateSchema.nullish(),
    weekdayMask: weekdayMaskSchema.nullish(),
    maxDosesPerDay: z.number().positive().nullish(),
    instructions: z.string().max(2000).nullish(),
    doses: z.array(planDoseInputSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    if (plan.recurrenceType === 'every_n_days' && !(plan.intervalDays && plan.anchorDate)) {
      ctx.addIssue({ code: 'custom', message: 'every_n_days needs intervalDays and anchorDate' });
    }
    if (plan.recurrenceType === 'weekdays' && !plan.weekdayMask) {
      ctx.addIssue({ code: 'custom', message: 'weekdays needs a weekdayMask' });
    }
  });

export const planDoseSchema = z.object({
  id: identifierSchema,
  intakePlanId: identifierSchema,
  sortOrder: z.number().int(),
  label: z.string().nullable(),
  timingType: timingTypeSchema,
  targetTime: localTimeSchema.nullable(),
  windowStartTime: localTimeSchema.nullable(),
  windowEndTime: localTimeSchema.nullable(),
  mealReference: mealReferenceSchema.nullable(),
  mealOffsetMinutes: z.number().int(),
  flexibility: doseFlexibilitySchema,
  doseAmount: z.number(),
  doseUnit: z.string(),
  packageUnitQuantity: z.number().nullable(),
});

export const intakePlanSchema = z.object({
  id: identifierSchema,
  treatmentId: identifierSchema,
  version: z.number().int(),
  supersedesPlanId: identifierSchema.nullable(),
  effectiveFrom: localDateSchema,
  effectiveTo: localDateSchema.nullable(),
  recurrenceType: recurrenceTypeSchema,
  intervalDays: z.number().int().nullable(),
  anchorDate: localDateSchema.nullable(),
  weekdayMask: z.number().int().nullable(),
  maxDosesPerDay: z.number().nullable(),
  instructions: z.string().nullable(),
  changeReason: z.string().nullable(),
  createdAt: instantSchema,
  doses: z.array(planDoseSchema),
  /** Rendered description such as "daily at 21:30". */
  summary: z.string(),
});

export type PlanDoseInput = z.input<typeof planDoseInputSchema>;
export type PlanDefinition = z.input<typeof planDefinitionSchema>;
export type ParsedPlanDefinition = z.infer<typeof planDefinitionSchema>;
export type PlanDose = z.infer<typeof planDoseSchema>;
export type IntakePlan = z.infer<typeof intakePlanSchema>;
