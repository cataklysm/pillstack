import Fastify, { type FastifyInstance } from 'fastify';
import { ConflictError, NotFoundError, ValidationError } from '../application/errors.js';
import type { Services } from '../application/container.js';
import { registerIntakeLogRoutes } from './routes/intakeLog.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerProductRoutes } from './routes/products.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTreatmentRoutes } from './routes/treatments.js';

export interface ServerOptions {
  services: Services;
  logger?: boolean;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // Health data never leaves this machine: no CORS headers are emitted, so a
  // page served from any other origin cannot read these responses.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) {
      return reply.status(400).send({ error: error.message, details: error.details });
    }
    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: error.message });
    }
    if (error instanceof ConflictError) {
      return reply.status(409).send({ error: error.message });
    }
    // Fastify's own schema validation failures.
    if (error instanceof Error && 'validation' in error) {
      return reply.status(400).send({ error: error.message });
    }

    app.log.error(error);
    return reply.status(500).send({ error: 'internal error' });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerProductRoutes(app, options.services);
  registerTreatmentRoutes(app, options.services);
  registerScheduleRoutes(app, options.services);
  registerInventoryRoutes(app, options.services);
  registerIntakeLogRoutes(app, options.services);
  registerSettingsRoutes(app, options.services);

  return app;
}
