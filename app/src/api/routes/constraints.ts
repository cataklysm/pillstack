import type { FastifyInstance } from 'fastify';
import type { Services } from '../../application/container.js';

interface IdParams {
  id: string;
}

export function registerConstraintRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/constraints', async () => services.constraints.list());

  app.post('/api/constraints', async (request, reply) => {
    const constraint = await services.constraints.create(request.body);
    return reply.status(201).send(constraint);
  });

  app.put<{ Params: IdParams }>('/api/constraints/:id', async (request) =>
    services.constraints.update(request.params.id, request.body),
  );

  app.post<{ Params: IdParams; Body: { enabled?: boolean } }>(
    '/api/constraints/:id/enabled',
    async (request) => services.constraints.setEnabled(request.params.id, request.body?.enabled !== false),
  );

  app.delete<{ Params: IdParams }>('/api/constraints/:id', async (request, reply) => {
    await services.constraints.delete(request.params.id);
    return reply.status(204).send();
  });

  /** Substances, for the endpoint picker when writing a rule. */
  app.get<{ Querystring: { q?: string } }>('/api/substances', async (request) =>
    services.products.listSubstances(request.query.q),
  );
}
