import type { FastifyInstance } from 'fastify';
import type { Services } from '../../application/container.js';

export function registerScheduleRoutes(app: FastifyInstance, services: Services): void {
  app.get<{ Querystring: { date?: string } }>('/api/schedule/day', async (request) =>
    services.schedule.dayTimeline(request.query.date),
  );

  app.get('/api/schedule/next', async () => ({
    intake: await services.schedule.nextIntake(),
  }));

  app.get('/api/schedule/today', async () => ({ date: await services.schedule.today() }));

  /** Moves one occurrence for one day. The plan version is untouched. */
  /** What would break if this intake moved, without saving anything. */
  app.post('/api/schedule/preview-move', async (request) =>
    services.schedule.previewMove(request.body),
  );

  app.post('/api/schedule/move', async (request) => services.schedule.moveIntake(request.body));

  app.post('/api/schedule/clear-override', async (request) =>
    services.schedule.clearIntakeOverride(request.body),
  );
}
