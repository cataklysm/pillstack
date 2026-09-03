import type { FastifyInstance } from 'fastify';
import type { Services } from '../../application/container.js';

interface ProductParams {
  id: string;
}

export function registerInventoryRoutes(app: FastifyInstance, services: Services): void {
  /** Everything tracked, for the overview and the low-stock warnings. */
  app.get('/api/inventory', async () => services.inventory.listStatuses());

  app.get<{ Params: ProductParams }>('/api/products/:id/inventory', async (request) =>
    services.inventory.statusFor(request.params.id),
  );

  /** The append-only ledger: every change to this product's stock, in order. */
  app.get<{ Params: ProductParams }>('/api/products/:id/inventory/ledger', async (request) =>
    services.inventory.ledgerFor(request.params.id),
  );

  app.post<{ Params: ProductParams }>('/api/products/:id/inventory/packages', async (request, reply) => {
    const status = await services.inventory.addPackage(request.params.id, request.body);
    return reply.status(201).send(status);
  });

  app.post<{ Params: ProductParams; Body: { packageId?: string; note?: string } }>(
    '/api/products/:id/inventory/discard',
    async (request) =>
      services.inventory.discardPackage(
        request.params.id,
        request.body?.packageId ?? '',
        request.body?.note ?? null,
      ),
  );

  /** Record a counted stock figure; it becomes the anchor for later projections. */
  app.post<{ Params: ProductParams }>('/api/products/:id/inventory/correction', async (request) =>
    services.inventory.correctStock(request.params.id, request.body),
  );

  app.put<{ Params: ProductParams }>('/api/products/:id/inventory/policy', async (request) =>
    services.inventory.updatePolicy(request.params.id, request.body),
  );
}
