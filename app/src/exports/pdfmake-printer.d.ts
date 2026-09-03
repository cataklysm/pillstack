/**
 * `@types/pdfmake` describes the browser bundle; the Node printer entry point
 * has no declaration. Only the small surface actually used is declared here.
 */
declare module 'pdfmake/src/printer.js' {
  import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';

  interface FontFamily {
    normal: string;
    bold: string;
    italics: string;
    bolditalics: string;
  }

  /** A readable stream of PDF bytes. */
  interface PdfKitDocument {
    on(event: 'data', listener: (chunk: Buffer) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
    end(): void;
  }

  export default class PdfPrinter {
    constructor(fonts: Record<string, FontFamily>);
    createPdfKitDocument(definition: TDocumentDefinitions): PdfKitDocument;
  }
}
