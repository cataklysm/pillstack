import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../src/application/errors.js';
import { createTestApp, ironSupplement, rosuvastatin, type TestApp } from './support/testApp.js';

describe('products and ingredients', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('stores a product with several active ingredients in order', async () => {
    const product = await app.services.products.create(ironSupplement);

    expect(product.ingredients).toHaveLength(2);
    expect(product.ingredients[0]).toMatchObject({
      substanceName: 'Iron',
      label: 'Iron (ferrous bisglycinate)',
      amount: 20,
      unit: 'mg',
      sortOrder: 0,
    });
    expect(product.ingredients[1]?.substanceName).toBe('Vitamin C');
  });

  /**
   * Substances are shared across products, which is what will let a single
   * "keep iron away from calcium" rule cover every iron product later.
   */
  it('reuses one substance across products regardless of spelling', async () => {
    const first = await app.services.products.create(ironSupplement);
    const second = await app.services.products.create({
      ...ironSupplement,
      name: 'Iron Complex',
      ingredients: [{ substanceName: '  IRON  ', amount: 14, unit: 'mg' }],
    });

    expect(second.ingredients[0]?.substanceId).toBe(first.ingredients[0]?.substanceId);

    const substances = app.opened.sqlite
      .prepare(`SELECT COUNT(*) AS total FROM substance`)
      .get() as { total: number };
    expect(substances.total).toBe(2); // Iron and Vitamin C; the second product reused Iron
  });

  it('creates a reorder policy row alongside every product', async () => {
    const product = await app.services.products.create(rosuvastatin);

    const policy = app.opened.sqlite
      .prepare(`SELECT * FROM inventory_policy WHERE product_id = ?`)
      .get(product.id) as { reorder_lead_time_days: number; consumption_source: string };

    expect(policy.reorder_lead_time_days).toBe(7);
    expect(policy.consumption_source).toBe('planned');
  });

  it('replaces the ingredient list on update', async () => {
    const product = await app.services.products.create(ironSupplement);
    const updated = await app.services.products.update(product.id, {
      ingredients: [{ substanceName: 'Iron', amount: 14, unit: 'mg' }],
    });

    expect(updated.ingredients).toHaveLength(1);
    expect(updated.ingredients[0]?.amount).toBe(14);
  });

  it('leaves untouched fields alone on a partial update', async () => {
    const product = await app.services.products.create(rosuvastatin);
    const updated = await app.services.products.update(product.id, { notes: 'take with water' });

    expect(updated.notes).toBe('take with water');
    expect(updated.name).toBe(rosuvastatin.name);
    expect(updated.ingredients).toHaveLength(1);
  });

  it('rejects an invalid product', async () => {
    await expect(
      app.services.products.create({ ...rosuvastatin, packageSize: -1 }),
    ).rejects.toThrow(ValidationError);

    await expect(
      app.services.products.create({ ...rosuvastatin, category: 'vitamin' }),
    ).rejects.toThrow(ValidationError);
  });

  it('archives instead of deleting, keeping the row resolvable', async () => {
    const product = await app.services.products.create(rosuvastatin);
    const archived = await app.services.products.archive(product.id);

    expect(archived.active).toBe(false);
    expect(archived.archivedAt).not.toBeNull();
    expect(await app.services.products.findById(product.id)).toMatchObject({ active: false });
  });

  it('reports a missing product rather than returning null', async () => {
    await expect(app.services.products.findById('nope')).rejects.toThrow(NotFoundError);
  });

  it('filters by category and active flag', async () => {
    await app.services.products.create(rosuvastatin);
    const supplement = await app.services.products.create(ironSupplement);
    await app.services.products.archive(supplement.id);

    expect(await app.services.products.list({ category: 'medication' })).toHaveLength(1);
    expect(await app.services.products.list({ active: true })).toHaveLength(1);
    expect(await app.services.products.list({ active: false })).toHaveLength(1);
    expect(await app.services.products.list({})).toHaveLength(2);
  });
});

describe('search', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await createTestApp();
    await app.services.products.create(rosuvastatin);
    await app.services.products.create(ironSupplement);
  });

  afterEach(async () => {
    await app.close();
  });

  it('finds a product by name, case-insensitively and partially', async () => {
    const result = await app.services.search.search('rosuva');
    expect(result.hits[0]).toMatchObject({ name: 'Rosuvastatin 5 mg', matchedOn: 'product name' });
  });

  it('finds a product by manufacturer', async () => {
    const result = await app.services.search.search('nordic');
    expect(result.hits.some((hit) => hit.name === 'Iron 20 mg + Vitamin C')).toBe(true);
  });

  it('finds a product by an active ingredient its name does not mention', async () => {
    // The realistic case: a branded product whose substances are only on the label.
    await app.services.products.create({
      ...ironSupplement,
      name: 'Cardio Support Complex',
      ingredients: [
        { substanceName: 'Magnesium', amount: 150, unit: 'mg' },
        { substanceName: 'Potassium', amount: 99, unit: 'mg' },
      ],
    });

    const result = await app.services.search.search('magnesium');
    const productHit = result.hits.find((hit) => hit.kind === 'product');

    expect(productHit?.name).toBe('Cardio Support Complex');
    expect(productHit?.matchedOn).toBe('ingredient: Magnesium');
  });

  it('prefers a product-name match over an ingredient match for the same product', async () => {
    const result = await app.services.search.search('vitamin c');
    const productHit = result.hits.find((hit) => hit.kind === 'product');

    expect(productHit?.name).toBe('Iron 20 mg + Vitamin C');
    expect(productHit?.matchedOn).toBe('product name');
  });

  it('ignores accents and extra whitespace', async () => {
    await app.services.products.create({
      ...rosuvastatin,
      name: 'Ibuprofén  Forte',
      ingredients: [{ substanceName: 'Ibuprofen' }],
    });

    expect((await app.services.search.search('ibuprofen forte')).hits).not.toHaveLength(0);
  });

  it('returns nothing for a blank query instead of everything', async () => {
    expect((await app.services.search.search('   ')).hits).toHaveLength(0);
  });

  it('also lists matching products through the product filter', async () => {
    expect(await app.services.products.list({ query: 'iron' })).toHaveLength(1);
    expect(await app.services.products.list({ query: 'acme' })).toHaveLength(1);
  });
});
