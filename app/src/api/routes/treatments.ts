import type { FastifyInstance } from 'fastify';
import type { Services } from '../../application/container.js';

interface IdParams {
  id: string;
}

export function registerTreatmentRoutes(app: FastifyInstance, services: Services): void {
  app.get<{ Querystring: { status?: 'active' | 'paused' | 'stopped'; productId?: string } }>(
    '/api/treatments',
    async (request) =>
      services.treatments.list({
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.productId ? { productId: request.query.productId } : {}),
      }),
  );

  app.get<{ Params: IdParams }>('/api/treatments/:id', async (request) =>
    services.treatments.findById(request.params.id),
  );

  app.post('/api/treatments', async (request, reply) => {
    const treatment = await services.treatments.start(request.body);
    return reply.status(201).send(treatment);
  });

  /**
   * Supersedes the current plan with a new version. There is deliberately no
   * PATCH on a plan: schedules are versioned, never edited in place.
   */
  app.post<{ Params: IdParams }>('/api/treatments/:id/plan', async (request) =>
    services.treatments.changePlan(request.params.id, request.body),
  );

  app.post<{ Params: IdParams }>('/api/treatments/:id/pause', async (request) =>
    services.treatments.pause(request.params.id, request.body),
  );

  app.post<{ Params: IdParams }>('/api/treatments/:id/resume', async (request) =>
    services.treatments.resume(request.params.id, request.body),
  );

  app.post<{ Params: IdParams }>('/api/treatments/:id/stop', async (request) =>
    services.treatments.stop(request.params.id, request.body),
  );

  app.get<{ Params: IdParams }>('/api/treatments/:id/history', async (request) =>
    services.treatments.history(request.params.id),
  );

  /** The plan that was in force on a given date — the point-in-time query. */
  app.get<{ Params: IdParams; Querystring: { date?: string } }>(
    '/api/treatments/:id/plan-on',
    async (request) =>
      services.treatments.planOn(
        request.params.id,
        request.query.date ?? (await services.schedule.today()),
      ),
  );
}
