import { z } from 'zod';
import { identifierSchema, instantSchema, localTimeSchema } from './common.js';

export const reminderTypeSchema = z.enum(['intake', 'reorder', 'prescription']);
export const notificationTypeSchema = z.enum(['intake', 'reorder', 'prescription', 'expiry']);

export const reminderRuleSchema = z.object({
  id: identifierSchema,
  reminderType: reminderTypeSchema,
  scopeKind: z.enum(['global', 'product', 'treatment']),
  productId: identifierSchema.nullable(),
  treatmentId: identifierSchema.nullable(),
  /** Intake reminders: fire this many minutes before the dose is due. */
  leadTimeMinutes: z.number().int().nullable(),
  /** Reorder and prescription reminders: fire this many days before running out. */
  leadTimeDays: z.number().int().nullable(),
  repeatAfterMinutes: z.number().int().nullable(),
  quietHoursFrom: localTimeSchema.nullable(),
  quietHoursTo: localTimeSchema.nullable(),
  enabled: z.boolean(),
  summary: z.string(),
});

export const reminderRuleInputSchema = z
  .object({
    reminderType: reminderTypeSchema,
    scopeKind: z.enum(['global', 'product', 'treatment']).default('global'),
    productId: identifierSchema.nullish(),
    treatmentId: identifierSchema.nullish(),
    leadTimeMinutes: z.number().int().min(0).max(1440).nullish(),
    leadTimeDays: z.number().int().min(0).max(365).nullish(),
    repeatAfterMinutes: z.number().int().min(1).max(1440).nullish(),
    quietHoursFrom: localTimeSchema.nullish(),
    quietHoursTo: localTimeSchema.nullish(),
    enabled: z.boolean().default(true),
  })
  .superRefine((rule, ctx) => {
    if (rule.scopeKind === 'product' && !rule.productId) {
      ctx.addIssue({ code: 'custom', message: 'a product-scoped rule needs a productId' });
    }
    if (rule.scopeKind === 'treatment' && !rule.treatmentId) {
      ctx.addIssue({ code: 'custom', message: 'a treatment-scoped rule needs a treatmentId' });
    }
    if ((rule.quietHoursFrom == null) !== (rule.quietHoursTo == null)) {
      ctx.addIssue({ code: 'custom', message: 'quiet hours need both a start and an end' });
    }
  });

export const notificationSchema = z.object({
  id: identifierSchema,
  notificationType: notificationTypeSchema,
  dedupeKey: z.string(),
  dueAt: instantSchema,
  title: z.string(),
  body: z.string(),
  payload: z.unknown().nullable(),
  deliveredAt: instantSchema.nullable(),
  dismissedAt: instantSchema.nullable(),
});

export type ReminderType = z.infer<typeof reminderTypeSchema>;
export type NotificationType = z.infer<typeof notificationTypeSchema>;
export type ReminderRule = z.infer<typeof reminderRuleSchema>;
export type ReminderRuleInput = z.input<typeof reminderRuleInputSchema>;
export type AppNotification = z.infer<typeof notificationSchema>;
