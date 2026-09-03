import type { MedicationPlan, MedicationPlanEntry } from '@pillstack/contracts';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { documentHeader, formatDate, sharedStyles } from './pdfRenderer.js';

/**
 * The current medication plan, laid out for handing to a physician.
 *
 * Medications and supplements are kept apart, and the page carries nothing
 * decorative — no logos, no colour blocks, no chart junk. One or two pages
 * wherever the cabinet allows it.
 */
export function medicationPlanDocument(plan: MedicationPlan): TDocumentDefinitions {
  const sections = [
    section('MEDICATIONS', plan.medications),
    section('SUPPLEMENTS', plan.supplements),
  ].flat();

  const nothingToShow = plan.medications.length === 0 && plan.supplements.length === 0;

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 48],
    info: { title: 'Medication plan', author: 'PillStack' },

    content: [
      ...documentHeader({
        title: 'Medication plan',
        generatedAt: plan.generatedAt,
        patientName: plan.patientName,
        dateOfBirth: plan.dateOfBirth,
        subtitle: `As at ${formatDate(plan.asOf)}`,
      }),

      ...(nothingToShow
        ? [{ text: 'No current medication or supplements recorded.', style: 'meta' }]
        : sections),

      ...(plan.physicianNote
        ? [
            { text: 'Notes', style: 'sectionHeading' },
            { text: plan.physicianNote, fontSize: 9.5 },
          ]
        : []),
    ],

    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        {
          text: 'Self-reported plan, maintained by the patient in PillStack.',
          style: 'footnote',
        },
        {
          text: `${currentPage} / ${pageCount}`,
          alignment: 'right',
          style: 'footnote',
        },
      ],
      margin: [40, 12, 40, 0],
    }),

    styles: sharedStyles,
  };
}

function section(heading: string, entries: readonly MedicationPlanEntry[]) {
  if (entries.length === 0) return [];

  return [
    { text: heading, style: 'sectionHeading' },
    {
      table: {
        headerRows: 1,
        // Product, dose and schedule carry the weight; the rest flexes.
        widths: ['*', 'auto', 'auto', 'auto', '*'],
        body: [
          [
            { text: 'Product / active ingredient', style: 'tableHeader' },
            { text: 'Dose', style: 'tableHeader' },
            { text: 'Schedule', style: 'tableHeader' },
            { text: 'Since', style: 'tableHeader' },
            { text: 'Indication / note', style: 'tableHeader' },
          ],
          ...entries.map((entry) => [
            {
              stack: [
                { text: entry.productName, bold: true },
                { text: entry.activeIngredients, style: 'meta' },
              ],
            },
            { text: entry.dose },
            { text: entry.schedule },
            { text: formatDate(entry.since) },
            { text: [entry.indication, entry.note].filter(Boolean).join(' — ') || '' },
          ]),
        ],
      },
      layout: {
        // Horizontal rules only: vertical grid lines add noise, not meaning.
        hLineWidth: (rowIndex: number) => (rowIndex === 1 ? 0.8 : 0.4),
        vLineWidth: () => 0,
        hLineColor: (rowIndex: number) => (rowIndex === 1 ? '#333333' : '#dddddd'),
        paddingTop: () => 5,
        paddingBottom: () => 5,
        paddingLeft: (columnIndex: number) => (columnIndex === 0 ? 0 : 8),
      },
    },
  ];
}
