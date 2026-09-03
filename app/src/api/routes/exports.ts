import type { FastifyInstance } from 'fastify';
import type { ServiceProvider } from '../server.js';

interface PlanQuery {
  patientName?: string;
  dateOfBirth?: string;
  physicianNote?: string;
  asOf?: string;
  from?: string;
  includeStopped?: string;
}

/** Content-Disposition so the browser saves the file under a sensible name. */
function attachment(name: string): string {
  return `attachment; filename="${name}"`;
}

export function registerExportRoutes(app: FastifyInstance, host: ServiceProvider): void {
  app.get<{ Querystring: PlanQuery }>('/api/exports/medication-plan', async (request) =>
    host.services.exports.medicationPlan(request.query),
  );

  app.get<{ Querystring: PlanQuery }>(
    '/api/exports/medication-plan.pdf',
    async (request, reply) => {
      const pdf = await host.services.exports.medicationPlanPdf(request.query);
      const date = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', attachment(`medication-plan-${date}.pdf`))
        .send(pdf);
    },
  );

  app.get<{ Querystring: PlanQuery }>('/api/exports/treatment-history', async (request) =>
    host.services.exports.treatmentHistoryReport({
      ...request.query,
      includeStopped: request.query.includeStopped !== 'false',
    }),
  );

  app.get<{ Querystring: PlanQuery }>(
    '/api/exports/treatment-history.pdf',
    async (request, reply) => {
      const pdf = await host.services.exports.treatmentHistoryPdf({
        ...request.query,
        includeStopped: request.query.includeStopped !== 'false',
      });
      const date = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', attachment(`treatment-history-${date}.pdf`))
        .send(pdf);
    },
  );

  /** Portable, versioned, human-readable. Separate from a database backup. */
  app.get('/api/exports/data.json', async (_request, reply) => {
    const document = await host.services.exports.jsonExport();
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', attachment(`pillstack-export-${date}.json`))
      .send(JSON.stringify(document, null, 2));
  });

  app.post('/api/exports/import', async (request) =>
    host.services.exports.jsonImport(request.body),
  );
}
