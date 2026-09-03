import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  backupManifestSchema,
  createBackupInputSchema,
  restoreBackupInputSchema,
  setBackupDirectoryInputSchema,
  type BackupInspection,
  type BackupManifest,
  type BackupRecord,
  type BackupSettings,
  type RestoreResult,
} from '@pillstack/contracts';
import SQLite from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import JSZip from 'jszip';
import type { Clock } from '../application/clock.js';
import { APP_VERSION } from '../application/exportService.js';
import { ConflictError, NotFoundError, ValidationError } from '../application/errors.js';
import { createId } from '../application/ids.js';
import { migrateToLatest, openDatabase, type OpenedDatabase } from '../persistence/database.js';
import { SettingsRepository } from '../persistence/repositories/settingsRepository.js';

const DATABASE_ENTRY = 'database.sqlite';
const MANIFEST_ENTRY = 'manifest.json';
const SETTINGS_ENTRY = 'settings.json';
const INDEX_FILE = 'index.json';

/** The migration this build understands; a newer archive is refused. */
const CURRENT_SCHEMA_VERSION = '001_initial';

/** Tables counted into the manifest so a restore can be sanity-checked first. */
const COUNTED_TABLES = [
  'product',
  'substance',
  'treatment',
  'intake_plan',
  'intake_log_entry',
  'inventory_transaction',
  'intake_constraint',
  'treatment_event',
] as const;

/**
 * Backup and restore.
 *
 * Two properties matter more than anything else here. A backup is a *consistent*
 * copy, taken through SQLite's own online backup API rather than by copying a
 * file out from under a live connection. And a restore never silently
 * overwrites: the archive is validated, its integrity checked, its schema
 * version compared, and the current database is itself backed up first.
 */
export class BackupService {
  constructor(
    private readonly host: { opened: OpenedDatabase; reload(location: string): Promise<void> },
    private readonly clock: Clock,
    private readonly databaseLocation: string,
  ) {}

  private get db() {
    return this.host.opened.db;
  }

  async settings(): Promise<BackupSettings> {
    return {
      directory: await this.directory(),
      lastBackupAt: await this.lastBackupAt(),
    };
  }

  async setDirectory(rawInput: unknown): Promise<BackupSettings> {
    const parsed = setBackupDirectoryInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid directory', parsed.error.issues);

    const directory = resolve(parsed.data.directory);
    try {
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      throw new ValidationError(
        `cannot use that directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await new SettingsRepository(this.db).set(
      'backup_directory',
      directory,
      this.clock.now().toISOString(),
    );
    return this.settings();
  }

  async list(): Promise<BackupRecord[]> {
    const directory = await this.directory();
    const index = readIndex(directory);

    // The directory is the source of truth: a file deleted outside PillStack
    // should disappear from the list rather than linger as a broken entry.
    return index
      .filter((record) => fileExists(record.filePath))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create(rawInput: unknown): Promise<BackupRecord> {
    const parsed = createBackupInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) throw new ValidationError('invalid backup request', parsed.error.issues);

    return this.write({ trigger: 'manual', note: parsed.data.note ?? null });
  }

  /**
   * Reads an archive and reports what is in it, without changing anything.
   * The UI shows this and asks for confirmation before a restore.
   */
  async inspect(filePath: string): Promise<BackupInspection> {
    const resolved = resolve(filePath);
    const inspection: BackupInspection = {
      fileName: basename(resolved),
      filePath: resolved,
      valid: false,
      problems: [],
      manifest: null,
      currentRowCounts: this.rowCounts(this.host.opened.sqlite),
    };

    if (!fileExists(resolved)) {
      inspection.problems.push('the file does not exist');
      return inspection;
    }

    let archive: JSZip;
    try {
      archive = await JSZip.loadAsync(readFileSync(resolved));
    } catch {
      inspection.problems.push('the file is not a readable archive');
      return inspection;
    }

    const manifestEntry = archive.file(MANIFEST_ENTRY);
    const databaseEntry = archive.file(DATABASE_ENTRY);

    if (!manifestEntry) inspection.problems.push(`the archive has no ${MANIFEST_ENTRY}`);
    if (!databaseEntry) inspection.problems.push(`the archive has no ${DATABASE_ENTRY}`);
    if (!manifestEntry || !databaseEntry) return inspection;

    const parsedManifest = backupManifestSchema.safeParse(
      JSON.parse(await manifestEntry.async('string')) as unknown,
    );
    if (!parsedManifest.success) {
      inspection.problems.push('the manifest is not a PillStack backup manifest');
      return inspection;
    }

    const manifest = parsedManifest.data;
    inspection.manifest = manifest;

    const databaseBytes = await databaseEntry.async('nodebuffer');
    const checksum = sha256(databaseBytes);
    if (checksum !== manifest.checksumSha256) {
      inspection.problems.push('the database inside the archive does not match its checksum');
    }

    if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
      inspection.problems.push(
        `the backup was written by a newer version of PillStack (schema ${manifest.schemaVersion}); upgrade before restoring`,
      );
    }

    // Open the candidate read-only and let SQLite check itself before we
    // consider putting it in place of a working database.
    const temporaryPath = join(dirname(resolved), `.pillstack-verify-${createId()}.sqlite`);
    try {
      writeFileSync(temporaryPath, databaseBytes);
      const candidate = new SQLite(temporaryPath, { readonly: true });
      try {
        if (candidate.pragma('integrity_check', { simple: true }) !== 'ok') {
          inspection.problems.push('the database inside the archive fails its integrity check');
        }
        if ((candidate.pragma('foreign_key_check') as unknown[]).length > 0) {
          inspection.problems.push('the database inside the archive has broken references');
        }
      } finally {
        candidate.close();
      }
    } catch (error) {
      inspection.problems.push(
        `the database inside the archive cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      rmSync(temporaryPath, { force: true });
    }

    inspection.valid = inspection.problems.length === 0;
    return inspection;
  }

  /**
   * Replace the live database with the contents of an archive.
   *
   * Order matters: validate, take a safety backup of what is there now, close
   * the connection, swap the files, then reopen and migrate forward. If
   * anything fails after the swap, the safety backup is the way back and its
   * path is returned to the caller.
   */
  async restore(rawInput: unknown): Promise<RestoreResult> {
    const parsed = restoreBackupInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid restore request', parsed.error.issues);

    const filePath = resolve(parsed.data.filePath);
    const inspection = await this.inspect(filePath);

    if (!inspection.valid) {
      throw new ConflictError(
        `this backup cannot be restored: ${inspection.problems.join('; ')}`,
      );
    }

    // Read the archive into memory *before* writing anything, so nothing that
    // happens next can affect the bytes being restored.
    const archive = await JSZip.loadAsync(readFileSync(filePath));
    const databaseBytes = await archive.file(DATABASE_ENTRY)!.async('nodebuffer');

    const safety = await this.write({
      trigger: 'pre_restore_safety',
      note: `taken automatically before restoring ${basename(filePath)}`,
    });

    // Close before replacing: on Windows the file cannot be swapped while a
    // connection holds it, and the WAL sidecars must go with it or SQLite will
    // replay them onto the restored database.
    await this.host.opened.close();
    writeFileSync(this.databaseLocation, databaseBytes);
    rmSync(`${this.databaseLocation}-wal`, { force: true });
    rmSync(`${this.databaseLocation}-shm`, { force: true });

    await this.host.reload(this.databaseLocation);
    await migrateToLatest(this.host.opened.db);

    return {
      restoredFrom: filePath,
      safetyBackupPath: safety.filePath,
      rowCounts: this.rowCounts(this.host.opened.sqlite),
    };
  }

  async read(filePath: string): Promise<Buffer> {
    const resolved = resolve(filePath);
    if (!fileExists(resolved)) throw new NotFoundError('backup', resolved);
    return readFileSync(resolved);
  }

  // -- writing ---------------------------------------------------------------

  private async write(options: {
    trigger: BackupManifest['trigger'];
    note: string | null;
  }): Promise<BackupRecord> {
    const directory = await this.directory();
    mkdirSync(directory, { recursive: true });

    const now = this.clock.now();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const suffix = options.trigger === 'pre_restore_safety' ? '-safety' : '';
    // A backup must never overwrite another one, however close together they
    // are taken; the timestamp alone is not a guarantee of uniqueness.
    const { fileName, filePath } = uniqueTarget(directory, `pillstack-backup-${stamp}${suffix}`);

    // SQLite's own online backup: a consistent snapshot even mid-write, which
    // copying the file by hand would not give.
    const snapshotPath = join(directory, `.pillstack-snapshot-${createId()}.sqlite`);
    await this.host.opened.sqlite.backup(snapshotPath);

    try {
      const databaseBytes = readFileSync(snapshotPath);
      const settingsRows = await this.db.selectFrom('app_setting').selectAll().execute();

      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: now.toISOString(),
        appVersion: APP_VERSION,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        checksumSha256: sha256(databaseBytes),
        databaseBytes: databaseBytes.byteLength,
        rowCounts: this.rowCounts(this.host.opened.sqlite),
        trigger: options.trigger,
        note: options.note,
      };

      const archive = new JSZip();
      archive.file(DATABASE_ENTRY, databaseBytes);
      archive.file(MANIFEST_ENTRY, JSON.stringify(manifest, null, 2));
      // Readable without SQLite, so a human can see what a backup holds.
      archive.file(
        SETTINGS_ENTRY,
        JSON.stringify(
          Object.fromEntries(settingsRows.map((row) => [row.key, JSON.parse(row.value)])),
          null,
          2,
        ),
      );

      const archiveBytes = await archive.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      writeFileSync(filePath, archiveBytes);

      const record: BackupRecord = {
        id: createId(),
        createdAt: manifest.createdAt,
        fileName,
        filePath,
        fileSizeBytes: archiveBytes.byteLength,
        checksumSha256: manifest.checksumSha256,
        appVersion: APP_VERSION,
        trigger: options.trigger,
        note: options.note,
      };

      await this.recordBackup(record, directory);
      return record;
    } finally {
      rmSync(snapshotPath, { force: true });
      rmSync(`${snapshotPath}-wal`, { force: true });
      rmSync(`${snapshotPath}-shm`, { force: true });
    }
  }

  /**
   * The journal is written both to the database and to a plain file beside the
   * backups. Only the file survives a restore of an older database, which would
   * otherwise have no idea the newer backups exist.
   */
  private async recordBackup(record: BackupRecord, directory: string): Promise<void> {
    await this.db
      .insertInto('backup_record')
      .values({
        id: record.id,
        created_at: record.createdAt,
        file_path: record.filePath,
        file_size_bytes: record.fileSizeBytes,
        checksum_sha256: record.checksumSha256,
        schema_version: 1,
        app_version: record.appVersion,
        trigger_source: record.trigger,
        note: record.note,
      })
      .execute();

    await new SettingsRepository(this.db).set(
      'last_backup_at',
      record.createdAt,
      this.clock.now().toISOString(),
    );

    const index = readIndex(directory).filter((entry) => entry.id !== record.id);
    index.push(record);
    writeFileSync(join(directory, INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');
  }

  private rowCounts(sqlite: SQLite.Database): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
        total: number;
      };
      counts[table] = row.total;
    }
    return counts;
  }

  private async directory(): Promise<string> {
    const stored = await new SettingsRepository(this.db).get('backup_directory');
    if (typeof stored === 'string' && stored.length > 0) return stored;
    return join(dirname(this.databaseLocation), 'backups');
  }

  private async lastBackupAt(): Promise<string | null> {
    const stored = await new SettingsRepository(this.db).get('last_backup_at');
    return typeof stored === 'string' ? stored : null;
  }
}

/** `name.zip`, or `name-2.zip`, `name-3.zip` … if that is already taken. */
function uniqueTarget(directory: string, baseName: string): { fileName: string; filePath: string } {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const fileName = attempt === 1 ? `${baseName}.zip` : `${baseName}-${attempt}.zip`;
    const filePath = join(directory, fileName);
    if (!fileExists(filePath)) return { fileName, filePath };
  }
  throw new ConflictError(`cannot find a free backup file name in ${directory}`);
}

function readIndex(directory: string): BackupRecord[] {
  const indexPath = join(directory, INDEX_FILE);
  if (!fileExists(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as BackupRecord[]) : [];
  } catch {
    return [];
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Archives sitting in the backup directory that the index does not know about. */
export function discoverArchives(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.zip'))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

export { openDatabase };
