import type { TreatmentHistoryEntry, TreatmentHistoryReport } from '@pillstack/contracts';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { documentHeader, formatDate, sharedStyles } from './pdfRenderer.js';

const EVENT_LABELS: Record<string, string> = {
  started: 'Started',
  dose_changed: 'Dose changed',
  schedule_changed: 'Schedule changed',
  paused: 'Paused',
  resumed: 'Resumed',
  stopped: 'Stopped',
  product_changed: 'Product changed',
  note_added: 'Note',
};

/**
 * The longitudinal report: what was taken, when it changed, and why.
 *
 * Each treatment gets its own block so a physician can read one substance's
 * course from start to finish without hopping between pages.
 */
export function treatmentHistoryDocument(report: TreatmentHistoryReport): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 48],
    info: { title: 'Treatment history', author: 'PillStack' },

    content: [
      ...documentHeader({
        title: 'Treatment history',
        generatedAt: report.generatedAt,
        patientName: report.patientName,
        dateOfBirth: report.dateOfBirth,
        subtitle: report.from ? `From ${formatDate(report.from)}` : 'Complete history',
      }),

      ...(report.entries.length === 0
        ? [{ text: 'No treatments recorded.', style: 'meta' }]
        : report.entries.flatMap(treatmentBlock)),

      ...(report.physicianNote
        ? [{ text: 'Notes', style: 'sectionHeading' }, { text: report.physicianNote, fontSize: 9.5 }]
        : []),
    ],

    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: 'Self-reported history, maintained by the patient in PillStack.', style: 'footnote' },
        { text: `${currentPage} / ${pageCount}`, alignment: 'right', style: 'footnote' },
      ],
      margin: [40, 12, 40, 0],
    }),

    styles: sharedStyles,
  };
}

function treatmentBlock(entry: TreatmentHistoryEntry) {
  const period = `${formatDate(entry.startedOn)} – ${entry.endedOn ? formatDate(entry.endedOn) : 'ongoing'}`;
  const details = [
    entry.category === 'medication' ? 'Medication' : 'Supplement',
    entry.indication,
    entry.prescriber,
  ]
    .filter(Boolean)
    .join(' · ');

  return [
    {
      // Keeps a treatment's heading from being orphaned at the foot of a page.
      unbreakable: true,
      stack: [
        {
          columns: [
            { text: entry.productName, bold: true, fontSize: 11 },
            { text: period, alignment: 'right' as const, style: 'meta' },
          ],
        },
        { text: entry.activeIngredients, style: 'meta' },
        ...(details ? [{ text: details, style: 'meta' }] : []),
      ],
      margin: [0, 12, 0, 4] as [number, number, number, number],
    },

    {
      table: {
        widths: ['auto', 'auto', '*'],
        body: entry.events.map((event) => [
          { text: formatDate(event.occurredOn), style: 'meta' },
          { text: EVENT_LABELS[event.eventType] ?? event.eventType, fontSize: 9 },
          {
            stack: [
              { text: event.summary, fontSize: 9 },
              ...(event.reason ? [{ text: event.reason, style: 'meta' }] : []),
            ],
          },
        ]),
      },
      layout: {
        hLineWidth: () => 0.4,
        vLineWidth: () => 0,
        hLineColor: () => '#eeeeee',
        paddingTop: () => 3,
        paddingBottom: () => 3,
        paddingLeft: (columnIndex: number) => (columnIndex === 0 ? 0 : 8),
      },
    },

    ...(entry.stopReason
      ? [
          {
            text: `Stopped: ${entry.stopReason}`,
            style: 'meta',
            margin: [0, 4, 0, 0] as [number, number, number, number],
          },
        ]
      : []),
  ];
}
