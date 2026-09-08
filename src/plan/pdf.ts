/**
 * Reading a floor plan out of a PDF.
 *
 * Most plans that exist as a file at all are PDFs: that is what an architect
 * sends, what an estate agent lists, and what a council archive scans to. An
 * app that only took images would be asking most of its users to screenshot
 * their plan first — at screen resolution, losing exactly the crispness the
 * line detector then needs.
 *
 * pdf.js is loaded ON DEMAND, so the eighty percent of people who never open a
 * PDF never download it. A page is rendered to a canvas at a resolution chosen
 * from the page's own size, and handed to the same import path an image takes,
 * which means everything downstream — straightening, calibrating, detecting —
 * has one kind of thing to deal with.
 */

/** What a PDF turned out to hold. */
export interface PdfDocumentInfo {
  pageCount: number;
  /** Renders one page, 1-based, and returns a canvas. */
  renderPage: (pageNumber: number, targetLongestSide: number) => Promise<HTMLCanvasElement>;
  /** Releases the worker and the parsed document. */
  close: () => Promise<void>;
}

/**
 * Opens a PDF.
 *
 * The import is dynamic on purpose — see the note above — and the worker is
 * pointed at the copy Vite bundles rather than at a CDN, so the app keeps
 * working offline and nothing about somebody's floor plan leaves their machine.
 */
export async function openPdf(data: ArrayBuffer): Promise<PdfDocumentInfo> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const task = pdfjs.getDocument({ data });
  const pdf = await task.promise;

  return {
    pageCount: pdf.numPages,

    async renderPage(pageNumber: number, targetLongestSide: number) {
      const page = await pdf.getPage(Math.min(Math.max(1, pageNumber), pdf.numPages));

      // A PDF page is described in points, not pixels, so the scale is chosen
      // to land the longest side at the resolution the detector wants: enough
      // to resolve a wall, not so much that the browser refuses the texture.
      const base = page.getViewport({ scale: 1 });
      const longest = Math.max(base.width, base.height);
      const scale = Math.max(0.2, Math.min(8, targetLongestSide / Math.max(1, longest)));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));

      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser would not give us a canvas to draw the PDF on.');

      // White first. A PDF page is transparent where nothing is drawn, and a
      // plan on a transparent background becomes black lines on black.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, canvasContext: context, viewport }).promise;
      page.cleanup();
      return canvas;
    },

    async close() {
      // Destroying the loading TASK is what shuts the worker down; the document
      // proxy itself has no destroy of its own.
      await task.destroy();
    },
  };
}

/** Whether a file looks like a PDF, by what it says it is and what it is called. */
export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}
