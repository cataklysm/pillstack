import SQLite from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  migrateToLatest,
  openDatabase,
  type OpenedDatabase,
} from '../src/persistence/database.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const schemaDocumentPath = resolve(repositoryRoot, 'docs/schema.sql');

interface ColumnDefinition {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function describeStructure(database: SQLite.Database) {
  const objects = database
    .prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kysely_%'
       ORDER BY type, name`,
    )
    .all() as { type: string; name: string }[];

  const columns = new Map<string, ColumnDefinition[]>();
  for (const object of objects) {
    if (object.type !== 'table') continue;
    columns.set(
      object.name,
      (database.prepare(`PRAGMA table_info(${object.name})`).all() as ColumnDefinition[]).map(
        (column) => ({
          name: column.name,
          type: column.type,
          notnull: column.notnull,
          dflt_value: column.dflt_value,
          pk: column.pk,
        }),
      ),
    );
  }

  return { objects, columns };
}

describe('migrations', () => {
  let opened: OpenedDatabase;

  beforeEach(async () => {
    opened = await createTestDatabase();
  });

  afterEach(async () => {
    await opened.close();
  });

  it('creates every table, index, trigger and view', () => {
    const { objects } = describeStructure(opened.sqlite);
    const byType = (type: string) => objects.filter((o) => o.type === type).map((o) => o.name);

    expect(byType('table')).toContain('product');
    expect(byType('table')).toContain('intake_plan');
    expect(byType('table')).toContain('inventory_transaction');
    expect(byType('view')).toEqual(['current_intake_plan', 'ledger_stock']);
    expect(byType('trigger')).toEqual(['intake_plan_closed_is_immutable']);
    expect(byType('table').length).toBe(19);
  });

  it('leaves the database consistent', () => {
    expect(opened.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(opened.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(opened.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is idempotent: running it twice applies nothing the second time', async () => {
    const secondRun = await migrateToLatest(opened.db);
    expect(secondRun).toEqual([]);
  });

  it('records what it applied on a fresh database', async () => {
    const fresh = openDatabase({ location: ':memory:' });
    try {
      expect(await migrateToLatest(fresh.db)).toEqual(['001_initial']);
    } finally {
      await fresh.close();
    }
  });

  /**
   * docs/schema.sql is the reviewed, commented reference for the schema and the
   * migration is generated from it. This test fails the build if the two ever
   * diverge, so the document cannot quietly go stale.
   */
  it('matches docs/schema.sql exactly', () => {
    const fromDocument = new SQLite(':memory:');
    try {
      fromDocument.exec(readFileSync(schemaDocumentPath, 'utf8'));

      const migrated = describeStructure(opened.sqlite);
      const documented = describeStructure(fromDocument);

      expect(migrated.objects).toEqual(documented.objects);

      for (const [table, columns] of documented.columns) {
        expect(migrated.columns.get(table), `columns of ${table}`).toEqual(columns);
      }
    } finally {
      fromDocument.close();
    }
  });
});

describe('schema invariants the domain depends on', () => {
  let opened: OpenedDatabase;

  beforeEach(async () => {
    opened = await createTestDatabase();
    seedTreatment(opened.sqlite);
  });

  afterEach(async () => {
    await opened.close();
  });

  it('allows only one open plan version per treatment', () => {
    expect(() =>
      opened.sqlite
        .prepare(
          `INSERT INTO intake_plan (id, treatment_id, version, effective_from, recurrence_type, meal_offset_placeholder)
           VALUES ('plan-2','treatment-1',2,'2026-12-01','daily', NULL)`,
        )
        .run(),
    ).toThrow();

    // The same insert without the bogus column still fails, on the partial index.
    expect(() =>
      opened.sqlite
        .prepare(
          `INSERT INTO intake_plan (id, treatment_id, version, effective_from, recurrence_type, created_at)
           VALUES ('plan-2','treatment-1',2,'2026-12-01','daily','2026-12-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('makes a superseded plan version immutable', () => {
    opened.sqlite
      .prepare(`UPDATE intake_plan SET effective_to = '2026-11-30' WHERE id = 'plan-1'`)
      .run();

    expect(() =>
      opened.sqlite.prepare(`UPDATE intake_plan SET recurrence_type = 'weekdays' WHERE id = 'plan-1'`).run(),
    ).toThrow(/immutable/);
  });

  it('refuses to delete a product that history references', () => {
    expect(() => opened.sqlite.prepare(`DELETE FROM product WHERE id = 'product-1'`).run()).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('allows only one open pause per treatment', () => {
    const insert = opened.sqlite.prepare(
      `INSERT INTO treatment_pause (id, treatment_id, paused_from, resumed_on, reason, created_at)
       VALUES (?, 'treatment-1', ?, NULL, NULL, '2026-09-10T00:00:00.000Z')`,
    );

    insert.run('pause-1', '2026-09-10');
    expect(() => insert.run('pause-2', '2026-09-20')).toThrow(/UNIQUE/);
  });

  it('rejects a dose whose timing does not match its type', () => {
    const insertDose = (id: string, timingType: string, targetTime: string | null) =>
      opened.sqlite
        .prepare(
          `INSERT INTO intake_plan_dose
             (id, intake_plan_id, sort_order, timing_type, target_time, meal_offset_minutes,
              flexibility, dose_amount, dose_unit)
           VALUES (?, 'plan-1', (SELECT COALESCE(MAX(sort_order),0)+1 FROM intake_plan_dose), ?, ?, 0, 'fixed', 5, 'mg')`,
        )
        .run(id, timingType, targetTime);

    expect(() => insertDose('bad-dose', 'fixed', null)).toThrow(/CHECK/);
    expect(() => insertDose('good-dose', 'fixed', '08:00')).not.toThrow();
  });
});

function seedTreatment(database: SQLite.Database): void {
  const now = '2026-09-03T08:00:00.000Z';
  database.exec(`
    INSERT INTO substance VALUES ('substance-1','Rosuvastatin','rosuvastatin',NULL,NULL,'${now}','${now}');
    INSERT INTO product VALUES ('product-1','Rosuvastatin 5 mg','rosuvastatin 5 mg','Acme',
      'medication','tablet',100,'tablets',1,NULL,1,NULL,'${now}','${now}');
    INSERT INTO active_ingredient VALUES ('ingredient-1','product-1','substance-1',NULL,5,'mg',NULL,0);
    INSERT INTO treatment VALUES ('treatment-1','product-1','LDL reduction','Dr. Meyer','active',
      '2026-09-03',NULL,NULL,NULL,'${now}','${now}');
    INSERT INTO intake_plan VALUES ('plan-1','treatment-1',1,NULL,'2026-09-03',NULL,'daily',
      NULL,NULL,NULL,NULL,NULL,NULL,'${now}');
    INSERT INTO intake_plan_dose VALUES ('dose-1','plan-1',0,'evening','fixed','21:30',
      NULL,NULL,NULL,0,'fixed',5,'mg',1.0);
  `);
}
