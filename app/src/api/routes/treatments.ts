import type { FastifyInstance } from 'fastify';
import type { ServiceProvider } from '../server.js';

interface IdParams {
  id: string;
}

export function registerTreatmentRoutes(app: FastifyInstance, host: ServiceProvider): void {
  app.get<{ Querystring: { status?: 'active' | 'paused' | 'stopped'; productId?: string } }>(
    '/api/treatments',
    async (request) =>
      host.services.treatments.list({
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.productId ? { productId: request.query.productId } : {}),
      }),
  );

  app.get<{ Params: IdParams }>('/api/treatments/:id', async (request) =>
    host.services.treatments.findById(request.params.id),
  );

  app.post('/api/treatments', async (request, reply) => {
    const treatment = await host.services.treatments.start(request.body);
    return reply.status(201).send(treatment);
  });

  /**
   * Supersedes the current plan with a new version. There is deliberately no
   * PATCH on a plan: schedules are versioned, never edited in place.
   */
  app.post<{ Params: IdParams }>('/api/treatments/:id/plan', async (request) =>
    host.services.treatments.changePlan(request.params.id, request.body),
  );

  app.post<{ Params: IdParams }>('/api/treatments/:id/pause', async (request) =>
    host.services.treatments.pause(request.params.id, request.body),
  );

  app.post<{ Params: IdParams }>('/api/treatments/:id/resume', async (request) =>
    host.services.treatments.resume(request.params.id, request.body),
  );

  app.post<{ Params: IdParams }>('/api/treatments/:id/stop', async (request) =>
    host.services.treatments.stop(request.params.id, request.body),
  );

  app.get<{ Params: IdParams }>('/api/treatments/:id/history', async (request) =>
    host.services.treatments.history(request.params.id),
  );

  /** The plan that was in force on a given date — the point-in-time query. */
  app.get<{ Params: IdParams; Querystring: { date?: string } }>(
    '/api/treatments/:id/plan-on',
    async (request) =>
      host.services.treatments.planOn(
        request.params.id,
        request.query.date ?? (await host.services.schedule.today()),
      ),
  );
}
