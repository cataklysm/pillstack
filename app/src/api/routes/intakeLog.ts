import type { FastifyInstance } from 'fastify';
import type { Services } from '../../application/container.js';

export function registerIntakeLogRoutes(app: FastifyInstance, services: Services): void {
  /**
   * Confirm, skip or postpone one scheduled occurrence. Always optional:
   * inventory falls back to the plan for anything left unrecorded.
   */
  app.post('/api/intake-log', async (request, reply) => {
    const entry = await services.intakeLog.record(request.body);
    return reply.status(201).send(entry);
  });

  app.post('/api/intake-log/clear', async (request, reply) => {
    await services.intakeLog.clear(request.body);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/products/:id/intake-log', async (request) =>
    services.intakeLog.listForProduct(request.params.id),
  );
}
