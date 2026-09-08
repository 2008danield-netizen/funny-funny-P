/**
 * Tests for the PDF writer.
 *
 * A PDF is checked by a reader we do not control, and a file that is one byte
 * wrong in the cross-reference table opens as "damaged" with nothing on the
 * page — so the structural tests here parse the file back the way a reader
 * would: find the xref, walk its offsets, and check each one lands on the
 * object it claims.
 */

import { describe, expect, it } from 'vitest';

import { PAGE_SIZES, PdfWriter, landscape, textWidth } from './pdf';

/** The file as a string, one character per byte, which is how it is written. */
function asText(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

describe('the shape of the file', () => {
  it('starts with a header and ends with the marker every reader looks for', () => {
    const pdf = new PdfWriter({ title: 'Test' });
    pdf.addPage(PAGE_SIZES.letter).text('Hello', 72, 720);
    const text = asText(pdf.toBytes());

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('writes a cross-reference table whose offsets are true', () => {
    const pdf = new PdfWriter();
    pdf.addPage(PAGE_SIZES.letter).line(0, 0, 100, 100);
    pdf.addPage(landscape(PAGE_SIZES.a4)).text('Second', 20, 20);
    const text = asText(pdf.toBytes());

    // Where the reader is told to start.
    const startxref = /startxref\s+(\d+)/.exec(text);
    expect(startxref).not.toBeNull();
    const xrefAt = Number(startxref![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');

    // Every entry must point at "<n> 0 obj" for its own object number.
    const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)];
    expect(entries.length).toBeGreaterThan(5);
    entries.forEach((entry, index) => {
      const offset = Number(entry[1]);
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('declares each content stream at its true length', () => {
    const pdf = new PdfWriter();
    // Text with characters that are one byte in WinAnsi but not in UTF-8, which
    // is where a length in characters and a length in bytes come apart.
    pdf.addPage(PAGE_SIZES.a4).text('4.2 × 3.4 m · 30 m²', 40, 400);
    const bytes = pdf.toBytes();
    const text = asText(bytes);

    for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const declared = Number(match[1]);
      const start = match.index! + match[0].length;
      expect(text.slice(start + declared, start + declared + 10)).toBe('\nendstream');
    }
  });

  it('never writes a number in exponent form, which no reader accepts', () => {
    const pdf = new PdfWriter();
    const page = pdf.addPage(PAGE_SIZES.a4);
    page.moveTo(0.00000001, 1e21).lineTo(5, 5).stroke();
    page.scale(0.0000004);

    const text = asText(pdf.toBytes());
    expect(text).not.toMatch(/\de[+-]?\d/);
  });

  it('writes a title outside ASCII as UTF-16, not as the wrong character', () => {
    // The document information dictionary has no font, so a reader takes it as
    // PDFDocEncoding — where the WinAnsi byte for an em dash is something else
    // entirely. Non-ASCII therefore has to go out as a UTF-16BE hex string.
    const pdf = new PdfWriter({ title: 'Willow Cottage — drawing set' });
    pdf.addPage(PAGE_SIZES.a4);
    const text = asText(pdf.toBytes());

    expect(text).toMatch(/\/Title <FEFF[0-9A-F]+>/);
    // "Wi" as UTF-16BE, right after the byte-order mark.
    expect(text).toContain('<FEFF00570069');
    // And the em dash as its real code point, not as a WinAnsi byte.
    expect(text).toContain('2014');

    // A plain-ASCII title still goes out as a readable literal string.
    const plain = new PdfWriter({ title: 'Plain title' });
    plain.addPage(PAGE_SIZES.a4);
    expect(asText(plain.toBytes())).toContain('/Title (Plain title)');
  });

  it('makes a one-page document out of an empty one rather than an invalid file', () => {
    const text = asText(new PdfWriter().toBytes());
    expect(text).toMatch(/\/Count 1/);
  });
});

describe('the page', () => {
  it('lays out a landscape sheet as the same paper turned round', () => {
    const wide = landscape(PAGE_SIZES.tabloid);
    expect(wide.width).toBe(PAGE_SIZES.tabloid.height);
    expect(wide.height).toBe(PAGE_SIZES.tabloid.width);
  });

  it('writes the operators for what it was asked to draw', () => {
    const pdf = new PdfWriter();
    const page = pdf.addPage(PAGE_SIZES.a4);
    page.save().lineWidth(0.5).dash([3, 2]).rect(10, 10, 50, 20).stroke().restore();

    const content = page.content();
    expect(content).toContain('q');
    expect(content).toContain('0.5 w');
    expect(content).toContain('[3 2] 0 d');
    expect(content).toContain('10 10 50 20 re');
    expect(content).toContain('S');
    expect(content).toContain('Q');
  });

  it('hoists a colour set inside a path to where it is legal', () => {
    // `rect(...).fillColour(...).fillAndStroke()` is the natural way to write
    // it and is illegal PDF: a state operator between `re` and `B` makes a
    // strict reader abandon the rest of the stream. The writer moves it.
    const pdf = new PdfWriter();
    const page = pdf.addPage(PAGE_SIZES.a4);
    page.rect(0, 0, 10, 10).fillColour([1, 0, 0]).fillAndStroke();

    const ops = page.content().split('\n');
    expect(ops).toEqual(['1 0 0 rg', '0 0 10 10 re', 'B']);
  });

  it('keeps hoisted operators in the order they were written', () => {
    const pdf = new PdfWriter();
    const page = pdf.addPage(PAGE_SIZES.a4);
    page.moveTo(0, 0).lineTo(5, 5).lineWidth(2).strokeColour([0, 0, 1]).stroke();

    expect(page.content().split('\n')).toEqual([
      '2 w',
      '0 0 1 RG',
      '0 0 m',
      '5 5 l',
      'S',
    ]);
  });

  it('closes a circle with four curves, not a polygon', () => {
    const pdf = new PdfWriter();
    const page = pdf.addPage(PAGE_SIZES.a4);
    page.circle(50, 50, 10);
    expect([...page.content().matchAll(/ c$/gm)]).toHaveLength(4);
  });

  it('escapes the characters that would end a string early', () => {
    const pdf = new PdfWriter();
    const page = pdf.addPage(PAGE_SIZES.a4);
    page.text('Bed (queen) \\ 1.5 m', 10, 10);
    expect(page.content()).toContain('(Bed \\(queen\\) \\\\ 1.5 m)');
  });
});

/*
 * The test that matters most: a real PDF reader opening the file.
 *
 * Every other test here checks that the bytes look the way the specification
 * says they should, which is exactly the kind of check that can pass while the
 * file still fails to open. `pdfjs` is already a dependency for READING plans,
 * so it costs nothing to point it at what the writer produced and ask it what
 * it sees — pages, sheet size, and the text back out again.
 */
describe('a real reader opens it', () => {
  it('parses back with the page count, the sheet size and the text intact', async () => {
    const pdf = new PdfWriter({ title: 'Drawing set' });
    const page = pdf.addPage(landscape(PAGE_SIZES.tabloid));
    page.lineWidth(0.7).line(50, 50, 500, 300);
    page.text('GROUND FLOOR PLAN', 100, 700, { font: 'helvetica-bold', size: 14 });
    // With the characters that have to survive the WinAnsi mapping.
    page.text('4.2 × 3.4 m · 30 m²', 100, 680, { size: 9 });
    pdf.addPage(PAGE_SIZES.a4).text('Second sheet', 40, 700);

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({
      data: pdf.toBytes(),
      useWorkerFetch: false,
      disableFontFace: true,
    }).promise;

    expect(document.numPages).toBe(2);

    const first = await document.getPage(1);
    const viewport = first.getViewport({ scale: 1 });
    expect(viewport.width).toBeCloseTo(1224, 1);
    expect(viewport.height).toBeCloseTo(792, 1);

    const content = await first.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    expect(text).toContain('GROUND FLOOR PLAN');
    expect(text).toContain('4.2 × 3.4 m · 30 m²');
  });
});

describe('measuring text', () => {
  it('knows a bold string is wider than the same string light', () => {
    const plain = textWidth('Ground Floor Plan', 'helvetica', 10);
    const bold = textWidth('Ground Floor Plan', 'helvetica-bold', 10);
    expect(bold).toBeGreaterThan(plain);
  });

  it('scales with the font size', () => {
    expect(textWidth('Kitchen', 'helvetica', 20)).toBeCloseTo(
      textWidth('Kitchen', 'helvetica', 10) * 2,
      6,
    );
  });

  it('measures the monospaced font by counting', () => {
    expect(textWidth('12345', 'courier', 10)).toBeCloseTo(5 * 6, 6);
  });

  it('maps the feet and inches marks to something a reader can print', () => {
    // WinAnsi has no prime or double prime, and "44? 8?" on a dimension string
    // is worse than useless. The typewriter marks are the honest stand-in.
    const pdf = new PdfWriter();
    const page = pdf.addPage(PAGE_SIZES.a4);
    page.text('44\u2032 8\u2033', 10, 10);
    expect(page.content()).toContain("(44' 8\")");
  });

  it('gives a plausible width to a character it has no metric for', () => {
    // Not zero, which would let a stray symbol overlap whatever is beside it.
    expect(textWidth('◆', 'helvetica', 10)).toBeGreaterThan(2);
  });

  it('centres by half its own width', () => {
    const pdf = new PdfWriter();
    const page = pdf.addPage(PAGE_SIZES.a4);
    page.text('Plan', 100, 100, { align: 'center', size: 10 });

    const half = textWidth('Plan', 'helvetica', 10) / 2;
    expect(page.content()).toContain(`1 0 0 1 ${(100 - half).toFixed(4).replace(/0+$/, '')} 100 Tm`);
  });
});
