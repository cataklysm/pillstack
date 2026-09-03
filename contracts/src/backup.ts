import { z } from 'zod';
import { identifierSchema, instantSchema } from './common.js';

export const BACKUP_FORMAT = 'pillstack/backup';
export const BACKUP_FORMAT_VERSION = 1;

/**
 * What sits inside the archive next to `database.sqlite`. Everything needed to
 * decide whether a backup is safe to restore *before* touching the live
 * database: what wrote it, when, what it holds, and whether the bytes survived.
 */
export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  createdAt: instantSchema,
  appVersion: z.string(),
  /** The migration the database was on when written. */
  schemaVersion: z.string(),
  checksumSha256: z.string().length(64),
  databaseBytes: z.number().int().nonnegative(),
  rowCounts: z.record(z.string(), z.number().int().nonnegative()),
  trigger: z.enum(['manual', 'automatic', 'pre_restore_safety']),
  note: z.string().nullable(),
});

export const backupRecordSchema = z.object({
  id: identifierSchema,
  createdAt: instantSchema,
  fileName: z.string(),
  filePath: z.string(),
  fileSizeBytes: z.number().int(),
  checksumSha256: z.string(),
  appVersion: z.string(),
  trigger: z.enum(['manual', 'automatic', 'pre_restore_safety']),
  note: z.string().nullable(),
});

/**
 * The result of inspecting an archive without changing anything. The UI shows
 * this and asks for confirmation; a backup is never restored silently.
 */
export const backupInspectionSchema = z.object({
  fileName: z.string(),
  filePath: z.string(),
  valid: z.boolean(),
  problems: z.array(z.string()),
  manifest: backupManifestSchema.nullable(),
  /** How the archive compares with the database currently in use. */
  currentRowCounts: z.record(z.string(), z.number().int()),
});

export const createBackupInputSchema = z.object({
  note: z.string().max(500).nullish(),
});

export const restoreBackupInputSchema = z.object({
  filePath: z.string().min(1),
  /** Must be true. Restoring is destructive, so it is never implicit. */
  confirm: z.literal(true),
});

export const restoreResultSchema = z.object({
  restoredFrom: z.string(),
  safetyBackupPath: z.string(),
  rowCounts: z.record(z.string(), z.number().int()),
});

export const backupSettingsSchema = z.object({
  directory: z.string(),
  lastBackupAt: instantSchema.nullable(),
});

export const setBackupDirectoryInputSchema = z.object({
  directory: z.string().min(1).max(400),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type BackupRecord = z.infer<typeof backupRecordSchema>;
export type BackupInspection = z.infer<typeof backupInspectionSchema>;
export type RestoreResult = z.infer<typeof restoreResultSchema>;
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
