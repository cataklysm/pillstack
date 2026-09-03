import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/api/server.js';
import { createTestApp, rosuvastatin, type TestApp } from './support/testApp.js';

/**
 * The HTTP edge, where a mistake turns a clear 4xx into an opaque 500 and
 * makes every client-side error message useless.
 */
describe('the API error surface', () => {
  let app: TestApp;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = await createTestApp();
    server = createServer({ host: app.host });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    await app.close();
  });

  it('accepts a parameterless POST sent with a JSON content type and no body', async () => {
    const product = await app.services.products.create(rosuvastatin);

    const response = await server.inject({
      method: 'POST',
      url: `/api/products/${product.id}/archive`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ active: false });
  });

  it('reports malformed JSON as a 400, not a 500', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/products',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(400);
  });

  it('maps the application errors onto their status codes', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/products/missing' })).statusCode).toBe(404);

    // Invalid body -> 400, with the field issues in `details`.
    const invalid = await server.inject({
      method: 'POST',
      url: '/api/products',
      payload: { name: '' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().details).toBeDefined();

    // A conflicting state -> 409.
    const product = await app.services.products.create(rosuvastatin);
    const treatment = await app.services.treatments.start({
      productId: product.id,
      startedOn: '2026-09-03',
      plan: {
        recurrenceType: 'daily',
        doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 5, doseUnit: 'mg' }],
      },
    });
    const conflict = await server.inject({
      method: 'POST',
      url: `/api/treatments/${treatment.id}/plan`,
      payload: {
        effectiveFrom: '2026-08-01',
        plan: {
          recurrenceType: 'daily',
          doses: [{ timingType: 'fixed', targetTime: '21:30', doseAmount: 10, doseUnit: 'mg' }],
        },
      },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('does not emit CORS headers, so no other origin can read health data', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers an unknown API path with a JSON 404', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
  });
});
