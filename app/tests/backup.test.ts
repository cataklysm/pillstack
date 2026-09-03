import JSZip from 'jszip';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../src/application/errors.js';
import { createTestApp, rosuvastatin, type TestApp } from './support/testApp.js';

/**
 * Backup and restore against real files on disk. An in-memory database cannot
 * exercise the part that matters: closing the connection, swapping the file,
 * and coming back up on the restored data.
 */
describe('backup and restore', () => {
  let workspace: string;
  let app: TestApp;
  let databasePath: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pillstack-backup-'));
    databasePath = join(workspace, 'pillstack.sqlite');
    app = await createTestApp('2026-09-03T08:00:00.000Z', databasePath);
    await app.services.backup.setDirectory({ directory: join(workspace, 'backups') });
  });

  afterEach(async () => {
    await app.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  async function seed() {
    const product = await app.services.products.create(rosuvastatin);
    await app.services.treatments.start({
      productId: product.id,
      indication: 'LDL reduction',
      startedOn: '2026-09-03',
      plan: {
        recurrenceType: 'daily',
        doses: [
          { timingType: 'fixed', targetTime: '21:30', doseAmount: 5, doseUnit: 'mg', packageUnitQuantity: 1 },
        ],
      },
    });
    return product;
  }

  it('writes an archive holding the database, a manifest and readable settings', async () => {
    await seed();
    const record = await app.services.backup.create({ note: 'before the appointment' });

    expect(existsSync(record.filePath)).toBe(true);
    expect(record.fileName).toMatch(/^pillstack-backup-.*\.zip$/);
    expect(record.note).toBe('before the appointment');

    const archive = await JSZip.loadAsync(readFileSync(record.filePath));
    expect(Object.keys(archive.files).sort()).toEqual([
      'database.sqlite',
      'manifest.json',
      'settings.json',
    ]);

    const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'));
    expect(manifest.format).toBe('pillstack/backup');
    expect(manifest.createdAt).toBe('2026-09-03T08:00:00.000Z');
    expect(manifest.rowCounts.product).toBe(1);
    expect(manifest.rowCounts.treatment).toBe(1);
    expect(manifest.checksumSha256).toHaveLength(64);

    // Settings are readable without SQLite, so a human can see what is inside.
    const settings = JSON.parse(await archive.file('settings.json')!.async('string'));
    expect(settings.timezone).toBe('Europe/Berlin');
  });

  it('never overwrites an existing archive, however close together backups are taken', async () => {
    await seed();
    // The clock is pinned, so both land on the same timestamp. A backup that
    // clobbered another would be worse than useless — and during a restore the
    // safety copy would land on the very archive being restored.
    const first = await app.services.backup.create({ note: 'one' });
    const second = await app.services.backup.create({ note: 'two' });

    expect(second.filePath).not.toBe(first.filePath);
    expect(existsSync(first.filePath)).toBe(true);
    expect(existsSync(second.filePath)).toBe(true);
  });

  it('records when the last backup was taken', async () => {
    expect((await app.services.backup.settings()).lastBackupAt).toBeNull();
    await app.services.backup.create({});
    expect((await app.services.backup.settings()).lastBackupAt).toBe('2026-09-03T08:00:00.000Z');
  });

  it('lists backups newest first and forgets files deleted outside PillStack', async () => {
    await seed();
    const first = await app.services.backup.create({ note: 'one' });
    const second = await app.services.backup.create({ note: 'two' });

    expect(await app.services.backup.list()).toHaveLength(2);

    rmSync(first.filePath);
    const listed = await app.services.backup.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(second.id);
  });

  describe('inspection', () => {
    it('reports what an archive holds without touching anything', async () => {
      await seed();
      const record = await app.services.backup.create({});

      const inspection = await app.services.backup.inspect(record.filePath);
      expect(inspection.valid).toBe(true);
      expect(inspection.problems).toEqual([]);
      expect(inspection.manifest?.rowCounts.product).toBe(1);
      // Shown next to the archive's counts so the user can compare before restoring.
      expect(inspection.currentRowCounts.product).toBe(1);
    });

    it('refuses a file that is not an archive', async () => {
      const bogus = join(workspace, 'not-a-backup.zip');
      writeFileSync(bogus, 'hello');

      const inspection = await app.services.backup.inspect(bogus);
      expect(inspection.valid).toBe(false);
      expect(inspection.problems.join(' ')).toContain('not a readable archive');
    });

    it('refuses an archive whose database does not match its checksum', async () => {
      await seed();
      const record = await app.services.backup.create({});

      const archive = await JSZip.loadAsync(readFileSync(record.filePath));
      archive.file('database.sqlite', Buffer.from('corrupted'));
      writeFileSync(record.filePath, await archive.generateAsync({ type: 'nodebuffer' }));

      const inspection = await app.services.backup.inspect(record.filePath);
      expect(inspection.valid).toBe(false);
      expect(inspection.problems.join(' ')).toContain('does not match its checksum');
    });

    it('refuses an archive written by a newer PillStack', async () => {
      await seed();
      const record = await app.services.backup.create({});

      const archive = await JSZip.loadAsync(readFileSync(record.filePath));
      const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'));
      manifest.schemaVersion = '999_from_the_future';
      archive.file('manifest.json', JSON.stringify(manifest));
      writeFileSync(record.filePath, await archive.generateAsync({ type: 'nodebuffer' }));

      const inspection = await app.services.backup.inspect(record.filePath);
      expect(inspection.valid).toBe(false);
      expect(inspection.problems.join(' ')).toContain('newer version of PillStack');
    });

    it('reports a missing file rather than throwing', async () => {
      const inspection = await app.services.backup.inspect(join(workspace, 'nope.zip'));
      expect(inspection.valid).toBe(false);
      expect(inspection.problems).toContain('the file does not exist');
    });
  });

  describe('restoring', () => {
    it('brings back the data as it was, and keeps working afterwards', async () => {
      await seed();
      const backup = await app.services.backup.create({ note: 'known good' });

      // Change the world after the backup.
      const later = await app.services.products.create({
        name: 'Magnesium 150 mg',
        category: 'supplement',
        dosageForm: 'powder',
        packageSize: 60,
        packageUnit: 'doses',
        ingredients: [{ substanceName: 'Magnesium' }],
      });
      expect(await app.services.products.list({})).toHaveLength(2);

      const result = await app.services.backup.restore({
        filePath: backup.filePath,
        confirm: true,
      });

      expect(result.rowCounts.product).toBe(1);
      expect(result.restoredFrom).toBe(backup.filePath);

      // The service graph was rebuilt on the restored file and still answers.
      const products = await app.services.products.list({});
      expect(products).toHaveLength(1);
      expect(products[0]?.name).toBe('Rosuvastatin 5 mg');
      expect(products.some((product) => product.id === later.id)).toBe(false);

      // And the restored database is fully usable, not just readable.
      const timeline = await app.services.schedule.dayTimeline('2026-09-03');
      expect(timeline.slots[0]?.time).toBe('21:30');
      await app.services.products.create({
        name: 'Vitamin D3',
        category: 'supplement',
        dosageForm: 'drops',
        packageSize: 30,
        packageUnit: 'milliliters',
        ingredients: [{ substanceName: 'Vitamin D3' }],
      });
      expect(await app.services.products.list({})).toHaveLength(2);
    });

    it('takes a safety backup of the current database first', async () => {
      await seed();
      const backup = await app.services.backup.create({});
      await app.services.products.create({
        name: 'Magnesium 150 mg',
        category: 'supplement',
        dosageForm: 'powder',
        packageSize: 60,
        packageUnit: 'doses',
        ingredients: [{ substanceName: 'Magnesium' }],
      });

      const result = await app.services.backup.restore({
        filePath: backup.filePath,
        confirm: true,
      });

      // The safety copy holds what was there a moment ago, so the restore is
      // itself reversible.
      expect(existsSync(result.safetyBackupPath)).toBe(true);
      const safety = await app.services.backup.inspect(result.safetyBackupPath);
      expect(safety.valid).toBe(true);
      expect(safety.manifest?.trigger).toBe('pre_restore_safety');
      expect(safety.manifest?.rowCounts.product).toBe(2);
    });

    it('can be undone by restoring the safety backup', async () => {
      await seed();
      const backup = await app.services.backup.create({});
      await app.services.products.create({
        name: 'Magnesium 150 mg',
        category: 'supplement',
        dosageForm: 'powder',
        packageSize: 60,
        packageUnit: 'doses',
        ingredients: [{ substanceName: 'Magnesium' }],
      });

      const result = await app.services.backup.restore({
        filePath: backup.filePath,
        confirm: true,
      });
      expect(await app.services.products.list({})).toHaveLength(1);

      await app.services.backup.restore({ filePath: result.safetyBackupPath, confirm: true });
      expect(await app.services.products.list({})).toHaveLength(2);
    });

    it('refuses without an explicit confirmation', async () => {
      await seed();
      const backup = await app.services.backup.create({});

      await expect(
        app.services.backup.restore({ filePath: backup.filePath }),
      ).rejects.toThrow(/invalid restore request/);
    });

    it('refuses an invalid archive and leaves the database untouched', async () => {
      await seed();
      const bogus = join(workspace, 'broken.zip');
      writeFileSync(bogus, 'not a zip at all');

      await expect(
        app.services.backup.restore({ filePath: bogus, confirm: true }),
      ).rejects.toThrow(ConflictError);

      // Still open, still working.
      expect(await app.services.products.list({})).toHaveLength(1);
    });

    it('leaves no stale write-ahead log behind', async () => {
      await seed();
      const backup = await app.services.backup.create({});
      await app.services.products.create({
        name: 'Magnesium 150 mg',
        category: 'supplement',
        dosageForm: 'powder',
        packageSize: 60,
        packageUnit: 'doses',
        ingredients: [{ substanceName: 'Magnesium' }],
      });

      await app.services.backup.restore({ filePath: backup.filePath, confirm: true });

      // A leftover -wal from the old database would be replayed onto the
      // restored one and quietly resurrect the discarded rows.
      const products = await app.services.products.list({});
      expect(products).toHaveLength(1);
    });
  });

  it('exposes the archive bytes for saving elsewhere', async () => {
    await seed();
    const record = await app.services.backup.create({});
    const bytes = await app.services.backup.read(record.filePath);

    expect(bytes.byteLength).toBe(record.fileSizeBytes);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
