import { z } from 'zod';
import {
  identifierSchema,
  localTimeSchema,
  mealReferenceSchema,
  productCategorySchema,
} from './common.js';

export const constraintTypeSchema = z.enum([
  'minimum_separation',
  'avoid_together',
  'with_food',
  'without_food',
  'before_food',
  'after_food',
  'preferred_time_of_day',
]);

export const constraintSeveritySchema = z.enum(['information', 'warning']);

/**
 * Either side of a rule. Pointing at a *substance* rather than a product is
 * what makes one rule cover every product containing it, including ones added
 * later.
 */
export const constraintEndpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('product'), productId: identifierSchema, name: z.string().nullish() }),
  z.object({
    kind: z.literal('substance'),
    substanceId: identifierSchema,
    name: z.string().nullish(),
  }),
  z.object({ kind: z.literal('category'), category: productCategorySchema }),
  z.object({ kind: z.literal('meal'), meal: mealReferenceSchema }),
  z.object({ kind: z.literal('food'), label: z.string().min(1).max(120) }),
]);

export const intakeConstraintSchema = z.object({
  id: identifierSchema,
  constraintType: constraintTypeSchema,
  severity: constraintSeveritySchema,
  source: constraintEndpointSchema,
  target: constraintEndpointSchema.nullable(),
  minimumDistanceMinutes: z.number().int().nullable(),
  foodOffsetMinutes: z.number().int().nullable(),
  preferredTimeFrom: localTimeSchema.nullable(),
  preferredTimeTo: localTimeSchema.nullable(),
  explanation: z.string().nullable(),
  /** `user` for hand-entered rules; `catalog` is reserved for a curated set. */
  origin: z.enum(['user', 'catalog']),
  enabled: z.boolean(),
  /** Rendered sentence, e.g. "Keep Iron at least 2 hours from Calcium". */
  summary: z.string(),
});

export const constraintInputSchema = z
  .object({
    constraintType: constraintTypeSchema,
    severity: constraintSeveritySchema.default('warning'),
    source: constraintEndpointSchema,
    target: constraintEndpointSchema.nullish(),
    minimumDistanceMinutes: z.number().int().min(0).max(1440).nullish(),
    foodOffsetMinutes: z.number().int().min(0).max(720).nullish(),
    preferredTimeFrom: localTimeSchema.nullish(),
    preferredTimeTo: localTimeSchema.nullish(),
    explanation: z.string().max(2000).nullish(),
    enabled: z.boolean().default(true),
  })
  .superRefine((rule, ctx) => {
    const needsTarget = rule.constraintType === 'minimum_separation' || rule.constraintType === 'avoid_together';
    if (needsTarget && !rule.target) {
      ctx.addIssue({ code: 'custom', message: `${rule.constraintType} needs a target` });
    }
    if (rule.constraintType === 'minimum_separation' && rule.minimumDistanceMinutes == null) {
      ctx.addIssue({ code: 'custom', message: 'minimum_separation needs minimumDistanceMinutes' });
    }
    if (
      rule.constraintType === 'preferred_time_of_day' &&
      !(rule.preferredTimeFrom && rule.preferredTimeTo)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'preferred_time_of_day needs preferredTimeFrom and preferredTimeTo',
      });
    }
    if (rule.source.kind === 'meal' || rule.source.kind === 'food') {
      ctx.addIssue({ code: 'custom', message: 'the source must be a product, substance or category' });
    }
  });

/**
 * A rule broken by the current arrangement of a day. Never blocking: the user
 * may always keep the schedule and acknowledge the warning.
 */
export const constraintViolationSchema = z.object({
  constraintId: identifierSchema,
  constraintType: constraintTypeSchema,
  severity: constraintSeveritySchema,
  /** One sentence naming what clashes and by how much. */
  message: z.string(),
  explanation: z.string().nullable(),
  /** The occurrences involved, so the timeline can highlight them. */
  occurrenceKeys: z.array(z.string()),
  actualDistanceMinutes: z.number().int().nullable(),
  requiredDistanceMinutes: z.number().int().nullable(),
});

/** What would break if an intake moved to a given time, without saving it. */
export const previewMoveInputSchema = z.object({
  planDoseId: identifierSchema,
  occurrenceDate: z.string(),
  time: localTimeSchema,
});

export const movePreviewSchema = z.object({
  violations: z.array(constraintViolationSchema),
  /** Violations that already exist at the current time, for comparison. */
  currentViolations: z.array(constraintViolationSchema),
});

export type ConstraintType = z.infer<typeof constraintTypeSchema>;
export type ConstraintSeverity = z.infer<typeof constraintSeveritySchema>;
export type ConstraintEndpoint = z.infer<typeof constraintEndpointSchema>;
export type IntakeConstraint = z.infer<typeof intakeConstraintSchema>;
export type ConstraintInput = z.input<typeof constraintInputSchema>;
export type ConstraintViolation = z.infer<typeof constraintViolationSchema>;
export type MovePreview = z.infer<typeof movePreviewSchema>;
