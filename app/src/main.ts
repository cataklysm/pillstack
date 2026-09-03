import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './api/server.js';
import { createServices } from './application/container.js';
import { systemClock } from './application/clock.js';
import { migrateToLatest, openDatabase } from './persistence/database.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../..');

/**
 * Local-first defaults: the database sits in a plain directory the user owns,
 * and the server binds to the loopback interface only. Exposing PillStack to
 * the LAN takes a deliberate PILLSTACK_HOST override, because this database
 * holds health information.
 */
const dataDirectory = process.env.PILLSTACK_DATA_DIR ?? resolve(repositoryRoot, 'data');
const databaseLocation = resolve(dataDirectory, 'pillstack.sqlite');
const host = process.env.PILLSTACK_HOST ?? '127.0.0.1';
const port = Number(process.env.PILLSTACK_PORT ?? 5174);

async function main(): Promise<void> {
  const opened = openDatabase({ location: databaseLocation });
  const applied = await migrateToLatest(opened.db);

  if (applied.length > 0) {
    console.log(`applied migrations: ${applied.join(', ')}`);
  }

  const services = createServices(opened, systemClock);
  const app = createServer({ services, logger: true });

  // In a packaged build the built SPA sits next to the server bundle and is
  // served from the same origin, so the app works with no network at all.
  const webRoot = resolve(repositoryRoot, 'web/dist');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'unknown endpoint' });
      }
      return reply.sendFile('index.html');
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, closing`);
    await app.close();
    await opened.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host, port });
  console.log(`PillStack listening on http://${host}:${port}`);
  console.log(`database: ${databaseLocation}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
