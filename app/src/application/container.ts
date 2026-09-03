import { updateDayProfileInputSchema, type DayProfile } from '@pillstack/contracts';
import type { OpenedDatabase, PillstackDatabase } from '../persistence/database.js';
import { DayProfileRepository, SettingsRepository } from '../persistence/repositories/settingsRepository.js';
import { systemClock, type Clock } from './clock.js';
import { ValidationError } from './errors.js';
import { ConstraintService } from './constraintService.js';
import { InventoryService } from './inventoryService.js';
import { IntakeLogService } from './intakeLogService.js';
import { ProductService } from './productService.js';
import { ReminderService } from './reminderService.js';
import { ScheduleService } from './scheduleService.js';
import { SearchService } from './searchService.js';
import { TreatmentService } from './treatmentService.js';

export class SettingsService {
  constructor(
    private readonly db: PillstackDatabase,
    private readonly clock: Clock,
  ) {}

  async getDayProfile(): Promise<DayProfile> {
    return new DayProfileRepository(this.db).getDefault(this.clock.now().toISOString());
  }

  async updateDayProfile(rawInput: unknown): Promise<DayProfile> {
    const parsed = updateDayProfileInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ValidationError('invalid day profile', parsed.error.issues);

    return new DayProfileRepository(this.db).updateDefault(
      parsed.data,
      this.clock.now().toISOString(),
    );
  }

  async getTimeZone(): Promise<string> {
    return new SettingsRepository(this.db).getTimeZone();
  }

  async setTimeZone(timeZone: string): Promise<string> {
    if (!isValidTimeZone(timeZone)) throw new ValidationError(`unknown timezone: ${timeZone}`);
    await new SettingsRepository(this.db).setTimeZone(timeZone, this.clock.now().toISOString());
    return timeZone;
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface Services {
  products: ProductService;
  treatments: TreatmentService;
  schedule: ScheduleService;
  inventory: InventoryService;
  intakeLog: IntakeLogService;
  constraints: ConstraintService;
  reminders: ReminderService;
  search: SearchService;
  settings: SettingsService;
}

/**
 * Single wiring point. Everything downstream receives its collaborators
 * explicitly, so a test can build the same graph over an in-memory database
 * and a fixed clock.
 */
export function createServices(opened: OpenedDatabase, clock: Clock = systemClock): Services {
  const { db } = opened;

  // The schedule needs the constraint evaluator to annotate a day, and the
  // reminder generator needs both the schedule and the inventory projection.
  const constraints = new ConstraintService(db, clock);
  const schedule = new ScheduleService(db, clock, constraints);
  const inventory = new InventoryService(db, clock);

  return {
    products: new ProductService(db, clock),
    treatments: new TreatmentService(db, clock),
    schedule,
    inventory,
    intakeLog: new IntakeLogService(db, clock),
    constraints,
    reminders: new ReminderService(db, clock, schedule, inventory),
    search: new SearchService(db),
    settings: new SettingsService(db, clock),
  };
}
