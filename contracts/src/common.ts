import { z } from 'zod';

/** A calendar date in the user's timezone, `YYYY-MM-DD`. Never UTC-shifted. */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'expected YYYY-MM-DD');

/** A wall-clock time in the user's timezone, `HH:MM`. */
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

/** An absolute instant, ISO-8601 in UTC. */
export const instantSchema = z.string().datetime();

export const identifierSchema = z.string().min(1).max(64);

export const productCategorySchema = z.enum(['medication', 'supplement']);

export const dosageFormSchema = z.enum([
  'tablet',
  'capsule',
  'powder',
  'drops',
  'liquid',
  'injection',
  'other',
]);

export const packageUnitSchema = z.enum([
  'tablets',
  'capsules',
  'grams',
  'milliliters',
  'doses',
  'other',
]);

export const recurrenceTypeSchema = z.enum([
  'daily',
  'weekdays',
  'every_n_days',
  'as_needed',
]);

export const timingTypeSchema = z.enum([
  'fixed',
  'window',
  'meal_relative',
  'as_needed',
]);

export const mealReferenceSchema = z.enum([
  'breakfast',
  'lunch',
  'dinner',
  'wake_up',
  'bed_time',
]);

export const doseFlexibilitySchema = z.enum(['fixed', 'flexible']);

export const treatmentStatusSchema = z.enum(['active', 'paused', 'stopped']);

export const treatmentEventTypeSchema = z.enum([
  'started',
  'dose_changed',
  'schedule_changed',
  'paused',
  'resumed',
  'stopped',
  'product_changed',
  'note_added',
]);

export const intakeStatusSchema = z.enum(['taken', 'skipped', 'postponed']);

/**
 * Weekday bitfield: bit 0 (value 1) is Monday, bit 6 (value 64) is Sunday.
 * 127 means every day.
 */
export const weekdayMaskSchema = z.number().int().min(1).max(127);

export type LocalDate = z.infer<typeof localDateSchema>;
export type LocalTime = z.infer<typeof localTimeSchema>;
export type Instant = z.infer<typeof instantSchema>;
export type ProductCategory = z.infer<typeof productCategorySchema>;
export type DosageForm = z.infer<typeof dosageFormSchema>;
export type PackageUnit = z.infer<typeof packageUnitSchema>;
export type RecurrenceType = z.infer<typeof recurrenceTypeSchema>;
export type TimingType = z.infer<typeof timingTypeSchema>;
export type MealReference = z.infer<typeof mealReferenceSchema>;
export type DoseFlexibility = z.infer<typeof doseFlexibilitySchema>;
export type TreatmentStatus = z.infer<typeof treatmentStatusSchema>;
export type TreatmentEventType = z.infer<typeof treatmentEventTypeSchema>;
export type IntakeStatus = z.infer<typeof intakeStatusSchema>;
