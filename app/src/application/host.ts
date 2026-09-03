import { openDatabase, type OpenedDatabase } from '../persistence/database.js';
import type { Clock } from './clock.js';
import { createServices, type Services } from './container.js';

/**
 * Holds the live database and the service graph built on top of it.
 *
 * Restoring a backup replaces the database file, which means every service
 * holding a connection has to be rebuilt. Routes therefore read
 * `host.services` at request time rather than capturing it once at startup, so
 * a restore swaps the whole graph underneath them without a restart.
 */
export class ApplicationHost {
  opened: OpenedDatabase;
  services!: Services;

  constructor(
    opened: OpenedDatabase,
    private readonly clock: Clock,
    readonly databaseLocation: string,
  ) {
    this.opened = opened;
    this.rebuild();
  }

  /** Point the application at a different database file. */
  async reload(location: string): Promise<void> {
    this.opened = openDatabase({ location });
    this.rebuild();
  }

  async close(): Promise<void> {
    await this.opened.close();
  }

  private rebuild(): void {
    this.services = createServices(this, this.clock, this.databaseLocation);
  }
}
