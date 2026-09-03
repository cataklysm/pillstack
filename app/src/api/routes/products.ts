import type { FastifyInstance } from 'fastify';
import type { ServiceProvider } from '../server.js';

interface IdParams {
  id: string;
}

export function registerProductRoutes(app: FastifyInstance, host: ServiceProvider): void {
  app.get<{ Querystring: { category?: string; active?: string; query?: string } }>(
    '/api/products',
    async (request) =>
      host.services.products.list({
        category: request.query.category,
        active:
          request.query.active === undefined ? undefined : request.query.active !== 'false',
        query: request.query.query,
      }),
  );

  app.get<{ Params: IdParams }>('/api/products/:id', async (request) =>
    host.services.products.findById(request.params.id),
  );

  app.post('/api/products', async (request, reply) => {
    const product = await host.services.products.create(request.body);
    return reply.status(201).send(product);
  });

  app.patch<{ Params: IdParams }>('/api/products/:id', async (request) =>
    host.services.products.update(request.params.id, request.body),
  );

  /** Archive rather than delete: history and the inventory ledger reference products. */
  app.post<{ Params: IdParams }>('/api/products/:id/archive', async (request) =>
    host.services.products.archive(request.params.id),
  );

  app.get<{ Params: IdParams }>('/api/products/:id/treatments', async (request) =>
    host.services.treatments.list({ productId: request.params.id }),
  );

  app.get<{ Querystring: { q?: string } }>('/api/search', async (request) =>
    host.services.search.search(request.query.q ?? ''),
  );
}
