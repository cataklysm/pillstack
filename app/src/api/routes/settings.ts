import type { FastifyInstance } from 'fastify';
import type { ServiceProvider } from '../server.js';

export function registerSettingsRoutes(app: FastifyInstance, host: ServiceProvider): void {
  app.get('/api/settings/day-profile', async () => host.services.settings.getDayProfile());

  app.put('/api/settings/day-profile', async (request) =>
    host.services.settings.updateDayProfile(request.body),
  );

  app.get('/api/settings/timezone', async () => ({
    timeZone: await host.services.settings.getTimeZone(),
  }));

  app.put<{ Body: { timeZone?: string } }>('/api/settings/timezone', async (request) => ({
    timeZone: await host.services.settings.setTimeZone(request.body?.timeZone ?? ''),
  }));
}
