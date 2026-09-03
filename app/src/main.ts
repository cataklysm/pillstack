import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPillstack } from './embedded.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../..');

/**
 * The command-line entry point: a thin wrapper over `startPillstack`, which a
 * desktop shell would call in exactly the same way.
 *
 * Local-first defaults: the database sits in a plain directory the user owns,
 * and the server binds to the loopback interface only. Exposing PillStack to
 * the LAN takes a deliberate PILLSTACK_HOST override, because this database
 * holds health information.
 */
const dataDirectory = process.env.PILLSTACK_DATA_DIR ?? resolve(repositoryRoot, 'data');
const bindAddress = process.env.PILLSTACK_HOST ?? '127.0.0.1';
const port = Number(process.env.PILLSTACK_PORT ?? 5174);

async function main(): Promise<void> {
  const instance = await startPillstack({
    dataDirectory,
    port,
    bindAddress,
    // In a packaged build the built SPA sits next to the server bundle and is
    // served from the same origin, so the app works with no network at all.
    webRoot: resolve(repositoryRoot, 'web/dist'),
    logger: true,
  });

  if (instance.appliedMigrations.length > 0) {
    console.log(`applied migrations: ${instance.appliedMigrations.join(', ')}`);
  }

  const shutdown = async (signal: string) => {
    console.log(`
${signal} received, closing`);
    await instance.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(`PillStack listening on ${instance.url}`);
  console.log(`database: ${instance.databaseLocation}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
