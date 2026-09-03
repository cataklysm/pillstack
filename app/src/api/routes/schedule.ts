import type { FastifyInstance } from 'fastify';
import type { ServiceProvider } from '../server.js';

export function registerScheduleRoutes(app: FastifyInstance, host: ServiceProvider): void {
  app.get<{ Querystring: { date?: string } }>('/api/schedule/day', async (request) =>
    host.services.schedule.dayTimeline(request.query.date),
  );

  app.get('/api/schedule/next', async () => ({
    intake: await host.services.schedule.nextIntake(),
  }));

  app.get('/api/schedule/today', async () => ({ date: await host.services.schedule.today() }));

  /** Moves one occurrence for one day. The plan version is untouched. */
  /** What would break if this intake moved, without saving anything. */
  app.post('/api/schedule/preview-move', async (request) =>
    host.services.schedule.previewMove(request.body),
  );

  app.post('/api/schedule/move', async (request) => host.services.schedule.moveIntake(request.body));

  app.post('/api/schedule/clear-override', async (request) =>
    host.services.schedule.clearIntakeOverride(request.body),
  );
}
