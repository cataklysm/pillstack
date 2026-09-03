import type { FastifyInstance } from 'fastify';
import type { ServiceProvider } from '../server.js';

interface IdParams {
  id: string;
}

export function registerReminderRoutes(app: FastifyInstance, host: ServiceProvider): void {
  app.get('/api/reminders/rules', async () => host.services.reminders.listRules());

  app.post('/api/reminders/rules', async (request, reply) => {
    const rule = await host.services.reminders.createRule(request.body);
    return reply.status(201).send(rule);
  });

  app.put<{ Params: IdParams }>('/api/reminders/rules/:id', async (request) =>
    host.services.reminders.updateRule(request.params.id, request.body),
  );

  app.delete<{ Params: IdParams }>('/api/reminders/rules/:id', async (request, reply) => {
    await host.services.reminders.deleteRule(request.params.id);
    return reply.status(204).send();
  });

  /**
   * Regenerates the outbox and returns what is due. The client polls this;
   * generation is idempotent, so there is no scheduler or background worker.
   */
  app.get('/api/notifications/due', async () => host.services.reminders.due());

  app.get('/api/notifications', async () => host.services.reminders.recent());

  /** The UI confirms which notifications it actually displayed. */
  app.post<{ Body: { ids?: string[] } }>('/api/notifications/delivered', async (request, reply) => {
    await host.services.reminders.markDelivered(request.body?.ids ?? []);
    return reply.status(204).send();
  });

  app.post<{ Params: IdParams }>('/api/notifications/:id/dismiss', async (request, reply) => {
    await host.services.reminders.dismiss(request.params.id);
    return reply.status(204).send();
  });
}
