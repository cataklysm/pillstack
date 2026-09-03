import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startPillstack, type PillstackInstance } from '../src/embedded.js';

/**
 * The seam a desktop shell would use.
 *
 * PillStack is embedded in a host process rather than being a process of its
 * own: an Electron main process would call `startPillstack` and point a window
 * at the returned URL. Testing that seam is what actually substantiates the
 * claim that packaging is a change of shell rather than a rewrite — the same
 * function the command-line entry point uses is the one exercised here.
 */
describe('embedding PillStack in a host process', () => {
  let workspace: string;
  let instance: PillstackInstance | null = null;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pillstack-embedded-'));
  });

  afterEach(async () => {
    await instance?.stop();
    instance = null;
    rmSync(workspace, { recursive: true, force: true });
  });

  it('starts on a free port, migrates, and serves the API', async () => {
    // Port 0 asks the operating system for a free port, which is what a desktop
    // shell wants rather than fighting over a fixed one.
    instance = await startPillstack({ dataDirectory: workspace, port: 0 });

    expect(instance.port).toBeGreaterThan(0);
    expect(instance.url).toBe(`http://127.0.0.1:${instance.port}`);
    expect(instance.appliedMigrations).toEqual(['001_initial']);
    expect(instance.databaseLocation).toBe(join(workspace, 'pillstack.sqlite'));

    const health = await fetch(`${instance.url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
  });

  it('binds to loopback only, so health data is not on the network', async () => {
    instance = await startPillstack({ dataDirectory: workspace, port: 0 });

    const address = instance.server.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
  });

  it('runs the whole application, not just a health endpoint', async () => {
    instance = await startPillstack({ dataDirectory: workspace, port: 0 });

    const created = await fetch(`${instance.url}/api/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Rosuvastatin 5 mg',
        category: 'medication',
        dosageForm: 'tablet',
        packageSize: 100,
        packageUnit: 'tablets',
        ingredients: [{ substanceName: 'Rosuvastatin', amount: 5, unit: 'mg' }],
      }),
    });
    expect(created.status).toBe(201);

    const listed = (await (await fetch(`${instance.url}/api/products`)).json()) as unknown[];
    expect(listed).toHaveLength(1);
  });

  it('serves the built SPA from the same origin when one is supplied', async () => {
    const webRoot = join(workspace, 'web');
    mkdtempSync(join(tmpdir(), 'unused-'));
    rmSync(webRoot, { recursive: true, force: true });
    writeFileSync(join(workspace, 'index.html'), '<!doctype html><title>PillStack</title>');

    instance = await startPillstack({ dataDirectory: workspace, port: 0, webRoot: workspace });

    const page = await fetch(`${instance.url}/products/anything`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('PillStack');

    // API paths still answer as an API, not with the SPA shell.
    const missing = await fetch(`${instance.url}/api/nope`);
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { error: string }).toMatchObject({ error: 'unknown endpoint' });
  });

  it('reopens the same data on a restart', async () => {
    instance = await startPillstack({ dataDirectory: workspace, port: 0 });
    await fetch(`${instance.url}/api/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Magnesium 150 mg',
        category: 'supplement',
        dosageForm: 'powder',
        packageSize: 60,
        packageUnit: 'doses',
        ingredients: [{ substanceName: 'Magnesium' }],
      }),
    });
    await instance.stop();

    instance = await startPillstack({ dataDirectory: workspace, port: 0 });
    // Already migrated, so nothing to apply the second time.
    expect(instance.appliedMigrations).toEqual([]);

    const listed = (await (await fetch(`${instance.url}/api/products`)).json()) as unknown[];
    expect(listed).toHaveLength(1);
  });
});
