/**
 * A PDF writer, written from scratch.
 *
 * -----------------------------------------------------------------------------
 * WHY NOT A LIBRARY.
 *
 * Because a drawing set is the one output of this app that somebody takes to a
 * builder, and it has to be RIGHT — drawn to a stated scale, printable at that
 * scale, with lines that mean what the legend says they mean. The PDF format's
 * graphics model is a few dozen operators, all of which map directly onto what
 * a plan needs (move, line, stroke, fill, dash, transform, text), and writing
 * them out is less code than configuring a library to stop doing things.
 *
 * It also keeps the promise the rest of the app makes: everything stays on the
 * user's machine, and the bundle does not grow by half a megabyte to draw
 * straight lines. `pdfjs` is already a dependency for READING plans, but it
 * cannot write, and the writing libraries are all much bigger than this file.
 *
 * -----------------------------------------------------------------------------
 * WHAT A PDF IS, IN ONE PARAGRAPH.
 *
 * A header, a set of numbered objects, a cross-reference table giving each
 * object's byte offset, and a trailer pointing at the catalogue. Objects are a
 * tiny dictionary syntax; page content is a stream of postfix operators in an
 * ordinary graphics model. The only genuinely fiddly part is that the xref
 * table holds BYTE OFFSETS, so the file has to be assembled in order and
 * measured as it goes — which is why this builds a string and converts it at
 * the end rather than concatenating buffers.
 *
 * -----------------------------------------------------------------------------
 * COORDINATES.
 *
 * PDF's origin is the BOTTOM-LEFT of the page and y runs UP, in points at
 * 72 to the inch. This module keeps that convention rather than flipping it,
 * because it is the convention every other tool that opens the file will use,
 * and one flip in the drawing code is easier to reason about than a hidden
 * flip in the writer.
 */

/* ------------------------------- Page sizes ------------------------------- */

export interface PageSize {
  /** Width in points, 72 to the inch. */
  width: number;
  height: number;
  label: string;
}

const inches = (value: number) => value * 72;

/**
 * The sheet sizes a set of drawings is actually printed on.
 *
 * ANSI and ISO both, because a drawing set is a US-code document that people
 * outside the US will still want on A3.
 */
export const PAGE_SIZES = {
  letter: { width: inches(8.5), height: inches(11), label: 'Letter' },
  tabloid: { width: inches(11), height: inches(17), label: 'Tabloid' },
  'arch-b': { width: inches(12), height: inches(18), label: 'Arch B' },
  'arch-d': { width: inches(24), height: inches(36), label: 'Arch D' },
  a4: { width: 595.28, height: 841.89, label: 'A4' },
  a3: { width: 841.89, height: 1190.55, label: 'A3' },
} as const satisfies Record<string, PageSize>;

export type PageSizeId = keyof typeof PAGE_SIZES;

/** A size turned on its side, which is how nearly every drawing is printed. */
export function landscape(size: PageSize): PageSize {
  return { width: size.height, height: size.width, label: `${size.label} landscape` };
}

/* ---------------------------------- Fonts --------------------------------- */

export type FontId = 'helvetica' | 'helvetica-bold' | 'courier';

const FONT_NAMES: Record<FontId, string> = {
  helvetica: 'Helvetica',
  'helvetica-bold': 'Helvetica-Bold',
  courier: 'Courier',
};

/**
 * Character widths, in thousandths of the font size.
 *
 * From the Adobe Font Metrics for the base-14 fonts, which every PDF reader is
 * required to have. They are here rather than measured because measurement
 * needs a rendering engine, and a drawing that centres its title by guessing
 * looks like a drawing made by guessing.
 *
 * Indexed from character 32 (space) to 126 (~).
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * The width of a string, in points.
 *
 * Everything aligned right or centred in the drawing set goes through here —
 * schedule columns, the title block, the scale bar's caption. A character
 * outside the table falls back to the width of a lowercase 'n', which is close
 * enough that a stray symbol never throws the layout out badly.
 */
export function textWidth(text: string, font: FontId, size: number): number {
  if (font === 'courier') return text.length * 0.6 * size;
  const table = font === 'helvetica-bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const fallback = table[110 - 32]!;

  let total = 0;
  for (const character of text) {
    const code = toWinAnsi(character);
    total += code >= 32 && code <= 126 ? table[code - 32]! : fallback;
  }
  return (total / 1000) * size;
}

/**
 * A character in WinAnsiEncoding, which is what the text strings are written in.
 *
 * The base-14 fonts are single-byte, so anything outside Latin-1 has to be
 * mapped or dropped. The handful mapped here are the ones this app actually
 * prints — the multiplication sign in "4.2 × 3.4 m", the middle dot between
 * fields, the em dash, the degree and the superscript two in "m²" — and
 * everything else becomes a question mark rather than a corrupted byte.
 */
const WIN_ANSI_EXTRAS: Record<string, number> = {
  '·': 0xb7,
  '×': 0xd7,
  '÷': 0xf7,
  '°': 0xb0,
  '²': 0xb2,
  '³': 0xb3,
  '½': 0xbd,
  '¼': 0xbc,
  '¾': 0xbe,
  '—': 0x97,
  '–': 0x96,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '…': 0x85,
  '•': 0x95,
  '€': 0x80,
  '£': 0xa3,
  '±': 0xb1,
  '→': 0x3e, // no arrow in WinAnsi; ">" is the honest stand-in
  // The prime and double prime that `formatLength` writes feet and inches with.
  // WinAnsi has neither, and the typewriter apostrophe and quote are what every
  // drawing used before Unicode existed — a far better stand-in than "?".
  '′': 0x27,
  '″': 0x22,
  '‵': 0x27,
  '〞': 0x22,
};

function toWinAnsi(character: string): number {
  const code = character.codePointAt(0) ?? 63;
  if (code <= 0xff) return code;
  return WIN_ANSI_EXTRAS[character] ?? 63;
}

/* -------------------------------- The page -------------------------------- */

export interface TextOptions {
  font?: FontId;
  size?: number;
  /** Where `x` is measured from. */
  align?: 'left' | 'center' | 'right';
  /** Rotation about the anchor, in radians, anticlockwise. */
  rotate?: number;
  colour?: Colour;
}

/** A colour as three components, 0-1. */
export type Colour = readonly [number, number, number];

export const BLACK: Colour = [0, 0, 0];

/**
 * One page, and the operators drawn on it.
 *
 * The graphics state is PDF's, not a model of it: `save()` and `restore()` push
 * and pop the real thing, and the transform operators are the real ones. That
 * means a caller can set up a scale once — "one point is one inch of building
 * at 1/4 inch to the foot" — and then draw in building coordinates, which is
 * exactly how a plan wants to be drawn.
 */
export class PdfPage {
  /** The operator stream, joined at the end. */
  private ops: string[] = [];

  /**
   * Where the path currently being built started, or null if none is open.
   *
   * -----------------------------------------------------------------------
   * THE ONE RULE OF PDF CONTENT STREAMS THAT IS EASY TO BREAK.
   *
   * Between starting a path (`m`, `re`) and painting it (`S`, `f`, `B`), NO
   * graphics-state operator is allowed. Setting a colour there is illegal, and
   * a strict reader does not merely ignore it: it abandons the rest of the
   * content stream, so every symbol drawn AFTER the mistake silently vanishes
   * too. That is a horrible failure mode, because the drawing looks almost
   * right and the missing half looks like a layout bug.
   *
   * It is also the most natural thing in the world to write —
   * `page.rect(...).fillColour(BLACK).fillAndStroke()` reads perfectly. So
   * rather than forbidding it, a state operator issued while a path is open is
   * HOISTED to just before the path started, which is where the author meant
   * it and where it is legal. The drawing comes out identical and the class of
   * bug cannot be written.
   * -----------------------------------------------------------------------
   */
  private pathStart: number | null = null;

  constructor(readonly size: PageSize) {}

  /** Emits a graphics-state operator, hoisting it out of an open path. */
  private state(op: string): this {
    if (this.pathStart === null) {
      this.ops.push(op);
    } else {
      this.ops.splice(this.pathStart, 0, op);
      // So the next hoisted operator lands after this one, keeping their order.
      this.pathStart += 1;
    }
    return this;
  }

  /** Marks the start of a path, if one is not already open. */
  private beginPath(): void {
    if (this.pathStart === null) this.pathStart = this.ops.length;
  }

  /** Paints and closes the open path. */
  private paint(op: string): this {
    this.ops.push(op);
    this.pathStart = null;
    return this;
  }

  /* ---- Graphics state ---- */

  save(): this {
    return this.state('q');
  }

  restore(): this {
    return this.state('Q');
  }

  /** Multiplies in an affine transform: [a b c d e f]. */
  transform(a: number, b: number, c: number, d: number, e: number, f: number): this {
    return this.state(`${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)} cm`);
  }

  translate(x: number, y: number): this {
    return this.transform(1, 0, 0, 1, x, y);
  }

  scale(x: number, y = x): this {
    return this.transform(x, 0, 0, y, 0, 0);
  }

  rotate(radians: number): this {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return this.transform(cos, sin, -sin, cos, 0, 0);
  }

  lineWidth(points: number): this {
    return this.state(`${num(points)} w`);
  }

  /**
   * A dash pattern, in points, or `null` for a solid line.
   *
   * Dashes carry meaning on a drawing — hidden work below, a line of section,
   * the swing of a door — so they are a first-class operation rather than
   * something a caller has to emit by hand.
   */
  dash(pattern: readonly number[] | null, phase = 0): this {
    return this.state(
      !pattern || pattern.length === 0
        ? '[] 0 d'
        : `[${pattern.map(num).join(' ')}] ${num(phase)} d`,
    );
  }

  strokeColour(colour: Colour): this {
    return this.state(`${num(colour[0])} ${num(colour[1])} ${num(colour[2])} RG`);
  }

  fillColour(colour: Colour): this {
    return this.state(`${num(colour[0])} ${num(colour[1])} ${num(colour[2])} rg`);
  }

  /* ---- Paths ---- */

  moveTo(x: number, y: number): this {
    this.beginPath();
    this.ops.push(`${num(x)} ${num(y)} m`);
    return this;
  }

  lineTo(x: number, y: number): this {
    this.ops.push(`${num(x)} ${num(y)} l`);
    return this;
  }

  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    this.ops.push(
      `${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x3)} ${num(y3)} c`,
    );
    return this;
  }

  closePath(): this {
    this.ops.push('h');
    return this;
  }

  stroke(): this {
    return this.paint('S');
  }

  fill(): this {
    return this.paint('f');
  }

  fillAndStroke(): this {
    return this.paint('B');
  }

  /** A single straight line, which is most of a drawing. */
  line(x1: number, y1: number, x2: number, y2: number): this {
    return this.moveTo(x1, y1).lineTo(x2, y2).stroke();
  }

  /** A run of points, optionally closed. Nothing is stroked or filled yet. */
  path(points: ReadonlyArray<{ x: number; y: number }>, close = false): this {
    if (points.length === 0) return this;
    this.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) this.lineTo(points[i]!.x, points[i]!.y);
    if (close) this.closePath();
    return this;
  }

  rect(x: number, y: number, width: number, height: number): this {
    this.beginPath();
    this.ops.push(`${num(x)} ${num(y)} ${num(width)} ${num(height)} re`);
    return this;
  }

  /**
   * A circle, as four Bézier arcs.
   *
   * The magic constant is the standard one for approximating a quarter circle:
   * the control points sit 4/3 × tan(π/8) of the radius along the tangents,
   * which is accurate to about one part in a thousand — far finer than a
   * plotter or a printer resolves.
   */
  circle(cx: number, cy: number, radius: number): this {
    const k = radius * 0.5522847498;
    this.moveTo(cx + radius, cy);
    this.curveTo(cx + radius, cy + k, cx + k, cy + radius, cx, cy + radius);
    this.curveTo(cx - k, cy + radius, cx - radius, cy + k, cx - radius, cy);
    this.curveTo(cx - radius, cy - k, cx - k, cy - radius, cx, cy - radius);
    this.curveTo(cx + k, cy - radius, cx + radius, cy - k, cx + radius, cy);
    return this.closePath();
  }

  /* ---- Text ---- */

  /**
   * A line of text, anchored left, centred or right on `x`.
   *
   * Alignment is done here with the metrics above rather than left to the
   * reader, because PDF has no notion of alignment at all — it places a string
   * at a point, and everything else is arithmetic somebody has to do.
   */
  text(content: string, x: number, y: number, options: TextOptions = {}): this {
    const font = options.font ?? 'helvetica';
    const size = options.size ?? 9;
    const width = textWidth(content, font, size);
    const shift = options.align === 'center' ? -width / 2 : options.align === 'right' ? -width : 0;

    this.ops.push('BT');
    if (options.colour) {
      this.ops.push(
        `${num(options.colour[0])} ${num(options.colour[1])} ${num(options.colour[2])} rg`,
      );
    }
    this.ops.push(`/${fontResource(font)} ${num(size)} Tf`);

    if (options.rotate) {
      const cos = Math.cos(options.rotate);
      const sin = Math.sin(options.rotate);
      // The anchor shift is applied in the ROTATED frame, so centred rotated
      // text centres along its own baseline rather than along the page.
      this.ops.push(
        `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(x + shift * cos)} ${num(
          y + shift * sin,
        )} Tm`,
      );
    } else {
      this.ops.push(`1 0 0 1 ${num(x + shift)} ${num(y)} Tm`);
    }

    this.ops.push(`${escapeText(content)} Tj`);
    this.ops.push('ET');
    return this;
  }

  /** The finished operator stream. */
  content(): string {
    return this.ops.join('\n');
  }
}

/* ------------------------------- The document ----------------------------- */

/**
 * A PDF being built.
 *
 * Pages are drawn into as they are added, and the whole file is assembled once
 * at the end — which is the only order that works, because the cross-reference
 * table has to know where every object landed.
 */
export class PdfWriter {
  private pages: PdfPage[] = [];

  constructor(
    private readonly meta: { title?: string; author?: string; subject?: string } = {},
  ) {}

  addPage(size: PageSize): PdfPage {
    const page = new PdfPage(size);
    this.pages.push(page);
    return page;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * Assembles the file.
   *
   * Object numbering, laid out here so the offsets below are readable:
   *   1            the catalogue
   *   2            the page tree
   *   3, 4, 5      the three fonts
   *   6 + 2n       page n
   *   7 + 2n       page n's content stream
   */
  toBytes(): Uint8Array {
    if (this.pages.length === 0) {
      // A zero-page PDF is invalid, and a reader shows an error rather than an
      // empty document — so an empty set gets one blank sheet instead.
      this.addPage(PAGE_SIZES.letter);
    }

    const objects: string[] = [];
    const FIRST_PAGE_OBJECT = 6;

    const pageIds = this.pages.map((_, index) => FIRST_PAGE_OBJECT + index * 2);

    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
    objects.push(
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${this.pages.length} >>`,
    );

    for (const font of ['helvetica', 'helvetica-bold', 'courier'] as const) {
      objects.push(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[font]} /Encoding /WinAnsiEncoding >>`,
      );
    }

    for (const [index, page] of this.pages.entries()) {
      const contentId = pageIds[index]! + 1;
      objects.push(
        `<< /Type /Page /Parent 2 0 R ` +
          `/MediaBox [0 0 ${num(page.size.width)} ${num(page.size.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> ` +
          `/Contents ${contentId} 0 R >>`,
      );

      const stream = page.content();
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }

    // Document information, last so its number is known: it is the only object
    // whose position in the list does not matter to anything else.
    const infoId = objects.length + 1;
    objects.push(
      `<< ${metaEntry('Title', this.meta.title)}${metaEntry('Author', this.meta.author)}` +
        `${metaEntry('Subject', this.meta.subject)}/Producer ${escapeText('havavamama')} >>`,
    );

    /* ---- Lay the file out, measuring as we go ---- */

    let file = '%PDF-1.4\n';
    // A comment of high bytes, which is the convention that tells anything
    // handling the file that it is binary and must not be line-ending mangled.
    file += '%\xE2\xE3\xCF\xD3\n';

    const offsets: number[] = [];
    for (const [index, body] of objects.entries()) {
      offsets.push(file.length);
      file += `${index + 1} 0 obj\n${body}\nendobj\n`;
    }

    const xrefOffset = file.length;
    file += `xref\n0 ${objects.length + 1}\n`;
    file += '0000000000 65535 f \n';
    for (const offset of offsets) {
      file += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }

    file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\n`;
    file += `startxref\n${xrefOffset}\n%%EOF\n`;

    return latin1Bytes(file);
  }

  toBlob(): Blob {
    // A fresh ArrayBuffer, because a Uint8Array view of a larger buffer would
    // hand the Blob more bytes than the document has.
    return new Blob([this.toBytes().slice().buffer as ArrayBuffer], { type: 'application/pdf' });
  }
}

/* -------------------------------- Internals ------------------------------- */

function fontResource(font: FontId): string {
  return font === 'helvetica' ? 'F1' : font === 'helvetica-bold' ? 'F2' : 'F3';
}

/**
 * A number, formatted the way PDF requires.
 *
 * No exponent — `1e-7` is not a PDF number and readers reject the page it
 * appears on — and no more precision than a printer can resolve. Four decimal
 * places of a point is a fortieth of the width of a hairline.
 */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  // Clamped as well as rounded: `String(1e21)` is "1e+21", and a single such
  // number makes a reader reject the whole page it appears on. Nothing on a
  // drawing is a billion points from the corner of the sheet.
  const clamped = Math.max(-1e9, Math.min(1e9, value));
  const text = clamped
    .toFixed(4)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  return text === '-0' ? '0' : text;
}

/** A PDF string literal: parentheses and backslashes escaped, WinAnsi bytes. */
function escapeText(text: string): string {
  let out = '(';
  for (const character of text) {
    const code = toWinAnsi(character);
    const byte = String.fromCharCode(code);
    if (byte === '(' || byte === ')' || byte === '\\') out += `\\${byte}`;
    else if (code < 32) out += ' ';
    else out += byte;
  }
  return `${out})`;
}

/**
 * `/Key (value)` for the document information dictionary, or nothing.
 *
 * The catch that makes this different from `escapeText`: a string in the
 * document information is NOT read in the font's encoding, because it has no
 * font — a reader takes it as PDFDocEncoding, where the WinAnsi byte for an em
 * dash is a completely different character. So anything outside plain ASCII is
 * written as a UTF-16BE hex string with a byte-order mark, which is the
 * mechanism the specification provides for exactly this, and which is why the
 * window title used to read "Willow Cottage S drawing set".
 */
function metaEntry(key: string, value: string | undefined): string {
  if (!value) return '';
  const plain = [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code <= 126;
  });
  return `/${key} ${plain ? escapeText(value) : utf16Hex(value)} `;
}

/** A PDF text string as UTF-16BE, hex-encoded, with the byte-order mark. */
function utf16Hex(text: string): string {
  let hex = 'FEFF';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code > 0xffff) {
      // Outside the basic plane: a surrogate pair, as UTF-16 requires.
      const offset = code - 0x10000;
      hex += (0xd800 + (offset >> 10)).toString(16).padStart(4, '0').toUpperCase();
      hex += (0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, '0').toUpperCase();
    } else {
      hex += code.toString(16).padStart(4, '0').toUpperCase();
    }
  }
  return `<${hex}>`;
}

/** The string as bytes, one byte per character. */
function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}
