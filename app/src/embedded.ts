import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from './api/server.js';
import { systemClock, type Clock } from './application/clock.js';
import { ApplicationHost } from './application/host.js';
import { migrateToLatest, openDatabase } from './persistence/database.js';

/**
 * Starting PillStack inside another process.
 *
 * The command-line entry point uses this, and so would a desktop shell: an
 * Electron main process calls `startPillstack`, then points a BrowserWindow at
 * the returned URL. The domain, persistence and application layers are not
 * involved in the difference — which is the whole point of keeping the shell
 * this thin.
 */
export interface StartOptions {
  /** Directory holding pillstack.sqlite and, by default, the backups folder. */
  dataDirectory: string;
  /** 0 asks the operating system for a free port, which a desktop shell wants. */
  port?: number;
  /**
   * Loopback by default. Health data should not be reachable from the network
   * without someone deciding that on purpose.
   */
  bindAddress?: string;
  /** Directory of the built SPA, served from the same origin. */
  webRoot?: string | null;
  logger?: boolean;
  clock?: Clock;
}

export interface PillstackInstance {
  url: string;
  port: number;
  databaseLocation: string;
  host: ApplicationHost;
  server: FastifyInstance;
  /** Applied on this start; empty when the database was already current. */
  appliedMigrations: string[];
  stop(): Promise<void>;
}

export async function startPillstack(options: StartOptions): Promise<PillstackInstance> {
  const databaseLocation = resolve(options.dataDirectory, 'pillstack.sqlite');
  const bindAddress = options.bindAddress ?? '127.0.0.1';

  const opened = openDatabase({ location: databaseLocation });
  const appliedMigrations = await migrateToLatest(opened.db);

  const host = new ApplicationHost(opened, options.clock ?? systemClock, databaseLocation);
  const server = createServer({ host, logger: options.logger ?? false });

  if (options.webRoot && existsSync(options.webRoot)) {
    await server.register(fastifyStatic, { root: resolve(options.webRoot) });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'unknown endpoint' });
      }
      // Anything else is a client-side route.
      return reply.sendFile('index.html');
    });
  }

  await server.listen({ host: bindAddress, port: options.port ?? 5174 });

  const address = server.server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 5174);

  return {
    url: `http://${bindAddress}:${port}`,
    port,
    databaseLocation,
    host,
    server,
    appliedMigrations,
    async stop() {
      await server.close();
      await host.close();
    },
  };
}
