import type { FastifyInstance } from 'fastify';
import type { Services } from '../../application/container.js';

export function registerSettingsRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/settings/day-profile', async () => services.settings.getDayProfile());

  app.put('/api/settings/day-profile', async (request) =>
    services.settings.updateDayProfile(request.body),
  );

  app.get('/api/settings/timezone', async () => ({
    timeZone: await services.settings.getTimeZone(),
  }));

  app.put<{ Body: { timeZone?: string } }>('/api/settings/timezone', async (request) => ({
    timeZone: await services.settings.setTimeZone(request.body?.timeZone ?? ''),
  }));
}
