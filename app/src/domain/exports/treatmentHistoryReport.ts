import type {
  ActiveIngredient,
  LocalDate,
  ProductCategory,
  TreatmentEvent,
  TreatmentHistoryEntry,
  TreatmentHistoryReport,
} from '@pillstack/contracts';
import { describeIngredients } from './medicationPlan.js';

/**
 * The longitudinal report a physician reads: for each treatment, when it
 * started, every dose change, every pause, and when it stopped.
 *
 * The event summaries are not rendered here — they were frozen onto each event
 * when it was written, so a report produced years later still says what was
 * meant at the time.
 */

export interface HistorySource {
  treatmentId: string;
  productName: string;
  category: ProductCategory;
  ingredients: readonly ActiveIngredient[];
  startedOn: LocalDate;
  endedOn: LocalDate | null;
  indication: string | null;
  prescriber: string | null;
  stopReason: string | null;
  status: 'active' | 'paused' | 'stopped';
  events: readonly TreatmentEvent[];
}

export interface BuildTreatmentHistoryInput {
  sources: readonly HistorySource[];
  generatedAt: string;
  from?: LocalDate | null;
  includeStopped?: boolean;
  patientName?: string | null;
  dateOfBirth?: LocalDate | null;
  physicianNote?: string | null;
}

export function buildTreatmentHistoryReport(
  input: BuildTreatmentHistoryInput,
): TreatmentHistoryReport {
  const includeStopped = input.includeStopped !== false;
  const entries: TreatmentHistoryEntry[] = [];

  for (const source of input.sources) {
    if (!includeStopped && source.status === 'stopped') continue;

    const events = source.events
      .filter((event) => !input.from || event.occurredOn >= input.from)
      .map((event) => ({
        occurredOn: event.occurredOn,
        eventType: event.eventType,
        summary: event.summary,
        reason: event.reason,
      }));

    // A treatment that ended before the window and has nothing to say in it
    // would only pad the report.
    if (input.from && events.length === 0) continue;

    entries.push({
      treatmentId: source.treatmentId,
      productName: source.productName,
      activeIngredients: describeIngredients(source.ingredients),
      category: source.category,
      startedOn: source.startedOn,
      endedOn: source.endedOn,
      indication: source.indication,
      prescriber: source.prescriber,
      stopReason: source.stopReason,
      events,
    });
  }

  // Newest first: what is happening now matters most in consultation.
  entries.sort((left, right) => {
    if (left.startedOn !== right.startedOn) return right.startedOn.localeCompare(left.startedOn);
    return left.productName.localeCompare(right.productName);
  });

  return {
    generatedAt: input.generatedAt,
    patientName: input.patientName ?? null,
    dateOfBirth: input.dateOfBirth ?? null,
    physicianNote: input.physicianNote ?? null,
    from: input.from ?? null,
    entries,
  };
}
