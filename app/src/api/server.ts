import Fastify, { type FastifyInstance } from 'fastify';
import { ConflictError, NotFoundError, ValidationError } from '../application/errors.js';
import type { Services } from '../application/container.js';
import { registerBackupRoutes } from './routes/backup.js';
import { registerConstraintRoutes } from './routes/constraints.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerIntakeLogRoutes } from './routes/intakeLog.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerProductRoutes } from './routes/products.js';
import { registerReminderRoutes } from './routes/reminders.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTreatmentRoutes } from './routes/treatments.js';

/**
 * Routes resolve services through this rather than capturing them, so restoring
 * a backup can rebuild the whole service graph without restarting the server.
 */
export interface ServiceProvider {
  readonly services: Services;
}

export interface ServerOptions {
  host: ServiceProvider;
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
    // Fastify's own errors (schema validation, malformed or empty JSON,
    // payload too large) already carry the right status. Honour it rather than
    // flattening a 400 into a 500 and hiding what actually went wrong.
    if (error instanceof Error && 'statusCode' in error) {
      const statusCode = Number((error as { statusCode?: unknown }).statusCode);
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return reply.status(statusCode).send({ error: error.message });
      }
    }

    app.log.error(error);
    return reply.status(500).send({ error: 'internal error' });
  });

  // A parameterless POST (dismiss, archive) may legitimately arrive with a JSON
  // content type and no body; treat that as an empty object rather than an error.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body.trim().length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch {
        // A raw SyntaxError carries no status and would surface as a 500.
        const failure = new Error('invalid JSON body') as Error & { statusCode: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerProductRoutes(app, options.host);
  registerTreatmentRoutes(app, options.host);
  registerScheduleRoutes(app, options.host);
  registerInventoryRoutes(app, options.host);
  registerIntakeLogRoutes(app, options.host);
  registerConstraintRoutes(app, options.host);
  registerReminderRoutes(app, options.host);
  registerSettingsRoutes(app, options.host);
  registerExportRoutes(app, options.host);
  registerBackupRoutes(app, options.host);

  return app;
}
