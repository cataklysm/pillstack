import SQLite from 'better-sqlite3';
import { Kysely, Migrator, SqliteDialect, type MigrationProvider } from 'kysely';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as initialMigration from './migrations/001_initial.js';
import type { Database } from './schema.js';

export type PillstackDatabase = Kysely<Database>;

export interface OpenDatabaseOptions {
  /** File path, or `:memory:` for tests. */
  location: string;
}

export interface OpenedDatabase {
  db: PillstackDatabase;
  /** The underlying handle, needed for the online backup API and PRAGMAs. */
  sqlite: SQLite.Database;
  close(): Promise<void>;
}

/**
 * Migrations are listed explicitly rather than discovered from disk, so a
 * bundled or packaged build behaves exactly like a development checkout.
 */
export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      '001_initial': { up: initialMigration.up, down: initialMigration.down },
    };
  },
};

export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  if (options.location !== ':memory:') {
    mkdirSync(dirname(options.location), { recursive: true });
  }

  const sqlite = new SQLite(options.location);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });

  return {
    db,
    sqlite,
    async close() {
      await db.destroy();
    },
  };
}

export class MigrationError extends Error {}

export async function migrateToLatest(db: PillstackDatabase): Promise<string[]> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    throw new MigrationError(
      `migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return (results ?? [])
    .filter((result) => result.status === 'Success')
    .map((result) => result.migrationName);
}

/** Convenience for tests: an isolated, migrated, in-memory database. */
export async function createTestDatabase(): Promise<OpenedDatabase> {
  const opened = openDatabase({ location: ':memory:' });
  await migrateToLatest(opened.db);
  return opened;
}
