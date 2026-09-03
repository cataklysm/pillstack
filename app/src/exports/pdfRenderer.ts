import PdfPrinter from 'pdfmake/src/printer.js';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';

/**
 * PDF generation using only the 14 standard PDF fonts.
 *
 * No font files are bundled and no headless browser is downloaded, which keeps
 * PillStack small and means the physician export works with no network at all.
 */
const STANDARD_FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

const printer = new PdfPrinter(STANDARD_FONTS);

/**
 * The standard fonts only cover Latin-1. Anything outside it is not merely
 * unstyled: an arrow prints as "!", and en dashes, ellipses and curly quotes
 * vanish without trace. Since event summaries are frozen in the database at
 * write time — and render correctly everywhere else — the substitution belongs
 * here, at the moment of drawing, rather than in what we store.
 */
const CHARACTER_SUBSTITUTIONS: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '–': '-',
  '—': '-',
  '−': '-',
  '…': '...',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '•': '*',
  '≥': '>=',
  '≤': '<=',
  '×': 'x',
  ' ': ' ',
};

export function toPdfSafeText(value: string): string {
  let result = '';

  for (const character of value) {
    const substitute = CHARACTER_SUBSTITUTIONS[character];
    if (substitute !== undefined) {
      result += substitute;
      continue;
    }
    if (character.codePointAt(0)! <= 0xff) {
      result += character;
      continue;
    }
    // Accented letters outside Latin-1 keep their base letter; anything else
    // becomes a visible marker rather than disappearing silently.
    const stripped = character.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    result += /^[\x20-\xff]*$/.test(stripped) && stripped.length > 0 ? stripped : '?';
  }

  return result;
}

/**
 * Applies the substitution to every string in a document definition.
 * Functions — the header and footer callbacks, and table layout measurements —
 * are wrapped so what they *return* is sanitised too, since that is where the
 * page furniture text actually comes from.
 */
function sanitizeDocument<T>(node: T): T {
  if (typeof node === 'string') return toPdfSafeText(node) as T;
  if (typeof node === 'function') {
    return ((...args: unknown[]) =>
      sanitizeDocument((node as (...a: unknown[]) => unknown)(...args))) as T;
  }
  if (Array.isArray(node)) return node.map(sanitizeDocument) as T;
  if (node && typeof node === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) copy[key] = sanitizeDocument(value);
    return copy as T;
  }
  return node;
}

export async function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  const document = printer.createPdfKitDocument({
    ...sanitizeDocument(definition),
    defaultStyle: { font: 'Helvetica', fontSize: 9.5, ...definition.defaultStyle },
  });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.end();
  });
}

/** Shared page furniture: nothing decorative, just what a physician needs. */
export function documentHeader(options: {
  title: string;
  generatedAt: string;
  patientName: string | null;
  dateOfBirth: string | null;
  subtitle?: string;
}) {
  const details: string[] = [];
  if (options.patientName) details.push(options.patientName);
  if (options.dateOfBirth) details.push(`born ${formatDate(options.dateOfBirth)}`);

  return [
    {
      columns: [
        { text: options.title, style: 'title' },
        {
          text: `Generated ${formatDateTime(options.generatedAt)}`,
          alignment: 'right' as const,
          style: 'meta',
        },
      ],
    },
    ...(details.length > 0
      ? [{ text: details.join(' · '), style: 'patient', margin: [0, 4, 0, 0] as [number, number, number, number] }]
      : []),
    ...(options.subtitle
      ? [{ text: options.subtitle, style: 'meta', margin: [0, 2, 0, 0] as [number, number, number, number] }]
      : []),
    {
      canvas: [{ type: 'line' as const, x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.8, lineColor: '#333333' }],
      margin: [0, 8, 0, 12] as [number, number, number, number],
    },
  ];
}

export const sharedStyles = {
  title: { fontSize: 16, bold: true },
  patient: { fontSize: 10 },
  meta: { fontSize: 8.5, color: '#555555' },
  sectionHeading: { fontSize: 11, bold: true, margin: [0, 12, 0, 6] as [number, number, number, number] },
  tableHeader: { fontSize: 8, bold: true, color: '#555555' },
  footnote: { fontSize: 8, color: '#555555', italics: true },
};

export function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

export function formatDateTime(instant: string): string {
  const moment = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(moment.getDate())}.${pad(moment.getMonth() + 1)}.${moment.getFullYear()} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}
