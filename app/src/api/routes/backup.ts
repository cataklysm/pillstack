import type { FastifyInstance } from 'fastify';
import type { ServiceProvider } from '../server.js';

export function registerBackupRoutes(app: FastifyInstance, host: ServiceProvider): void {
  app.get('/api/backup/settings', async () => host.services.backup.settings());

  app.put('/api/backup/settings', async (request) =>
    host.services.backup.setDirectory(request.body),
  );

  app.get('/api/backups', async () => host.services.backup.list());

  app.post('/api/backups', async (request, reply) => {
    const record = await host.services.backup.create(request.body);
    return reply.status(201).send(record);
  });

  /** Reads an archive and reports what is in it without changing anything. */
  app.post<{ Body: { filePath?: string } }>('/api/backups/inspect', async (request) =>
    host.services.backup.inspect(request.body?.filePath ?? ''),
  );

  /**
   * Destructive, and never implicit: the body must carry `confirm: true`, the
   * archive is validated first, and a safety backup of the current database is
   * taken before anything is replaced.
   */
  app.post('/api/backups/restore', async (request) =>
    host.services.backup.restore(request.body),
  );

  app.get<{ Querystring: { filePath?: string } }>(
    '/api/backups/download',
    async (request, reply) => {
      const filePath = request.query.filePath ?? '';
      const bytes = await host.services.backup.read(filePath);
      return reply
        .header('content-type', 'application/zip')
        .header(
          'content-disposition',
          `attachment; filename="${filePath.split(/[\/]/).pop() ?? 'backup.zip'}"`,
        )
        .send(bytes);
    },
  );
}
