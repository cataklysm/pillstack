import { z } from 'zod';
import { constraintViolationSchema } from './constraints.js';
import {
  doseFlexibilitySchema,
  identifierSchema,
  instantSchema,
  intakeStatusSchema,
  localDateSchema,
  localTimeSchema,
  mealReferenceSchema,
  productCategorySchema,
  timingTypeSchema,
  weekdayMaskSchema,
} from './common.js';

export const dayProfileSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  appliesToWeekdayMask: weekdayMaskSchema,
  wakeUpTime: localTimeSchema,
  bedTime: localTimeSchema,
  breakfastTime: localTimeSchema.nullable(),
  lunchTime: localTimeSchema.nullable(),
  dinnerTime: localTimeSchema.nullable(),
  isDefault: z.boolean(),
});

export const updateDayProfileInputSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  wakeUpTime: localTimeSchema.optional(),
  bedTime: localTimeSchema.optional(),
  breakfastTime: localTimeSchema.nullish(),
  lunchTime: localTimeSchema.nullish(),
  dinnerTime: localTimeSchema.nullish(),
});

/** A single dose placed on a concrete day. */
export const scheduledIntakeSchema = z.object({
  /** Stable key `<planDoseId>:<date>`, shared by overrides, the intake log and reminders. */
  occurrenceKey: z.string(),
  planDoseId: identifierSchema,
  intakePlanId: identifierSchema,
  treatmentId: identifierSchema,
  productId: identifierSchema,
  productName: z.string(),
  category: productCategorySchema,
  occurrenceDate: localDateSchema,
  scheduledTime: localTimeSchema,
  scheduledAt: instantSchema,
  timingType: timingTypeSchema,
  mealReference: mealReferenceSchema.nullable(),
  windowStartTime: localTimeSchema.nullable(),
  windowEndTime: localTimeSchema.nullable(),
  doseAmount: z.number(),
  doseUnit: z.string(),
  packageUnitQuantity: z.number().nullable(),
  label: z.string().nullable(),
  instructions: z.string().nullable(),
  /** Whether the optimizer may move this dose. */
  flexibility: doseFlexibilitySchema,
  /** True when the time was derived from a meal anchor rather than stated explicitly. */
  timeIsDerived: z.boolean(),
  movedByUser: z.boolean(),
  status: z.union([intakeStatusSchema, z.literal('pending')]),
});

export const timelineSlotSchema = z.object({
  time: localTimeSchema,
  intakes: z.array(scheduledIntakeSchema),
});

export const dayTimelineSchema = z.object({
  date: localDateSchema,
  timeZone: z.string(),
  slots: z.array(timelineSlotSchema),
  /** Rules broken by this arrangement. Advisory only — nothing is blocked. */
  violations: z.array(constraintViolationSchema),
  /** As-needed medication available on this day; not placed on the timeline. */
  asNeeded: z.array(scheduledIntakeSchema),
});

export const moveIntakeInputSchema = z.object({
  planDoseId: identifierSchema,
  occurrenceDate: localDateSchema,
  time: localTimeSchema,
  reason: z.string().max(500).nullish(),
  /** Constraint ids the user consciously overrode, so they stop nagging. */
  acknowledgeConstraintIds: z.array(identifierSchema).nullish(),
});

export const clearIntakeOverrideInputSchema = z.object({
  planDoseId: identifierSchema,
  occurrenceDate: localDateSchema,
});

export const nextIntakeSchema = z.object({
  intake: scheduledIntakeSchema.nullable(),
});

export type DayProfile = z.infer<typeof dayProfileSchema>;
export type UpdateDayProfileInput = z.input<typeof updateDayProfileInputSchema>;
export type ScheduledIntake = z.infer<typeof scheduledIntakeSchema>;
export type TimelineSlot = z.infer<typeof timelineSlotSchema>;
export type DayTimeline = z.infer<typeof dayTimelineSchema>;
export type MoveIntakeInput = z.input<typeof moveIntakeInputSchema>;
export type NextIntake = z.infer<typeof nextIntakeSchema>;
