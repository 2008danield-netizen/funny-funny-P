/**
 * The furniture of a drawing sheet: the border, the title block, the scale bar,
 * the north point, and dimension strings.
 *
 * -----------------------------------------------------------------------------
 * WHY A DRAWING NEEDS ALL OF THIS.
 *
 * A plan on its own is a picture. What makes it a DRAWING — something a builder
 * or a plan checker can work from — is the apparatus around it: what it is,
 * which storey, at what scale, which way is north, when it was drawn, and what
 * it does not claim. Every one of those has been left off a real set at some
 * point and every one of them has caused a building to be built wrong.
 *
 * The scale bar in particular is not decoration. A PDF printed "fit to page"
 * is no longer at its stated scale, and the printed bar is the only thing on
 * the sheet that stays true — you measure the bar, and if it is not the length
 * it says, nothing else on the sheet may be scaled either.
 *
 * -----------------------------------------------------------------------------
 * LINE WEIGHTS.
 *
 * The one convention that makes a drawing readable rather than merely correct:
 * cut material heaviest, things you can see lighter, things you cannot see
 * lighter still and dashed, and annotation lightest of all. They are named
 * rather than written as numbers at the call sites so that the hierarchy stays
 * consistent across five different drawing modules.
 */

import { BLACK, PdfPage, textWidth, type Colour, type FontId } from './pdf';
import type { Frame, Projector } from './scale';

/** Line weights, in points, heaviest first. */
export const WEIGHTS = {
  /** Material the drawing cuts through: walls in plan, ground in section. */
  cut: 1.1,
  /** The outline of the building in elevation, and other major edges. */
  outline: 0.8,
  /** Ordinary visible edges. */
  object: 0.45,
  /** Work that is there but not visible from here. Always dashed. */
  hidden: 0.35,
  /** Dimensions, leaders, hatching, and everything else that is annotation. */
  thin: 0.25,
} as const;

export const GREY: Colour = [0.45, 0.45, 0.45];
export const LIGHT: Colour = [0.72, 0.72, 0.72];

/** The dash pattern for hidden work, in points. */
export const HIDDEN_DASH = [3, 2];

/* -------------------------------- The sheet ------------------------------- */

export interface TitleBlock {
  /** The project — usually the name the user gave the design. */
  project: string;
  /** What this sheet shows, e.g. "Ground Floor Plan". */
  title: string;
  /** "A1.1". */
  number: string;
  /** How it is written on the drawing, e.g. "1/4 in = 1 ft-0 in". */
  scale: string;
  date: string;
  /** Total sheets in the set, for "1 of 6". */
  index: number;
  total: number;
}

/** How much of the sheet the border leaves for drawing. */
export const MARGIN = 24;
export const TITLE_HEIGHT = 62;

/**
 * The drawing area of a sheet.
 *
 * Exported because the sheet furniture is drawn LAST — a drawing has to know
 * its frame before the title block can state the scale it chose — so callers
 * need the frame before `drawSheet` has run. One function, so the two can never
 * disagree about where the border is.
 */
export function frameOf(page: PdfPage): Frame {
  const blockTop = MARGIN + TITLE_HEIGHT;
  return {
    x: MARGIN + 8,
    y: blockTop + 8,
    width: page.size.width - MARGIN * 2 - 16,
    height: page.size.height - blockTop - MARGIN - 8,
  };
}

/**
 * Draws the border and title block, and returns the frame left for the drawing.
 *
 * The title block runs along the BOTTOM rather than down the right-hand side,
 * because these sheets are as likely to be read on a screen as pinned to a
 * wall, and a full-width strip at the bottom leaves the drawing area the same
 * proportion as the paper.
 */
export function drawSheet(page: PdfPage, block: TitleBlock): Frame {
  const { width, height } = page.size;

  page.strokeColour(BLACK).lineWidth(WEIGHTS.outline);
  page.rect(MARGIN, MARGIN, width - MARGIN * 2, height - MARGIN * 2).stroke();

  const blockTop = MARGIN + TITLE_HEIGHT;
  page.lineWidth(WEIGHTS.object);
  page.line(MARGIN, blockTop, width - MARGIN, blockTop);

  /* ---- The title block's own contents ---- */

  const left = MARGIN + 10;
  const right = width - MARGIN - 10;

  page.text(block.project, left, blockTop - 20, { font: 'helvetica-bold', size: 13 });
  page.text(block.title.toUpperCase(), left, blockTop - 36, {
    font: 'helvetica-bold',
    size: 10,
  });

  page.text(`Scale ${block.scale}`, left, blockTop - 50, { size: 8, colour: GREY });
  page.text(block.date, left + 130, blockTop - 50, { size: 8, colour: GREY });

  page.text(block.number, right, blockTop - 20, { font: 'helvetica-bold', size: 13, align: 'right' });
  page.text(`Sheet ${block.index} of ${block.total}`, right, blockTop - 36, {
    size: 8,
    align: 'right',
    colour: GREY,
  });

  // The disclaimer is on EVERY sheet, not just the cover, because sheets get
  // separated and one of them ends up on a site notice board on its own.
  page.text(
    'Not for construction. Produced by havavamama from a user model; not checked or stamped by a licensed professional.',
    right,
    blockTop - 50,
    { size: 7, align: 'right', colour: GREY },
  );

  return frameOf(page);
}

/* ------------------------------- Scale bar -------------------------------- */

/**
 * A printed scale bar, in feet or metres.
 *
 * Drawn as the alternating black-and-white bar everybody recognises, at the
 * drawing's own scale, so that measuring it with a rule tells you whether the
 * print is true. The divisions are chosen to come out at round numbers of feet
 * or metres, which is the entire point of a scale bar.
 */
export function drawScaleBar(
  page: PdfPage,
  projector: Projector,
  x: number,
  y: number,
  imperial: boolean,
): void {
  // A bar somewhere near 130 points long, in whole units.
  const unitMetres = imperial ? 0.3048 : 1;
  const target = 130 / projector.perMetre / unitMetres;
  const step = niceStep(target / 4);
  const divisions = 4;
  const segment = projector.length(step * unitMetres);
  const barHeight = 5;

  page.save().strokeColour(BLACK).lineWidth(WEIGHTS.thin);

  for (let i = 0; i < divisions; i++) {
    page.rect(x + i * segment, y, segment, barHeight);
    if (i % 2 === 0) page.fillColour(BLACK).fillAndStroke();
    else page.stroke();
  }

  page.fillColour(BLACK);
  for (let i = 0; i <= divisions; i++) {
    const value = i * step;
    page.text(String(Math.round(value * 100) / 100), x + i * segment, y - 9, {
      size: 6.5,
      align: 'center',
      colour: GREY,
    });
  }

  page.text(imperial ? 'feet' : 'metres', x + divisions * segment + 6, y - 1, {
    size: 6.5,
    colour: GREY,
  });
  page.restore();
}

/** A round number near `value`: 1, 2, 5, 10, 20, 50 and so on. */
function niceStep(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised < 1.5 ? 1 : normalised < 3.5 ? 2 : normalised < 7.5 ? 5 : 10;
  return step * magnitude;
}

/* ------------------------------ North point ------------------------------- */

/**
 * The north point.
 *
 * An arrow with an N at its head, rotated to the model's north angle. Every
 * plan needs one, and a plan drawn from a model that knows which way it faces
 * has no excuse for leaving it off.
 */
export function drawNorthPoint(page: PdfPage, x: number, y: number, northAngle: number): void {
  const radius = 13;

  page.save().translate(x, y);
  // The model's north angle is measured clockwise from "up the screen"; the
  // page's rotation is anticlockwise, so it is negated.
  page.rotate(-northAngle);

  page.strokeColour(BLACK).fillColour(BLACK).lineWidth(WEIGHTS.thin);
  page.circle(0, 0, radius).stroke();

  // A slim arrowhead, filled on one side and open on the other, which is how a
  // north point is drawn and which reads correctly at any size.
  page
    .path([
      { x: 0, y: radius - 1 },
      { x: -3.6, y: -radius + 3 },
      { x: 0, y: -radius + 7 },
    ], true)
    .fill();
  page
    .path([
      { x: 0, y: radius - 1 },
      { x: 3.6, y: -radius + 3 },
      { x: 0, y: -radius + 7 },
    ], true)
    .stroke();

  page.text('N', 0, radius + 4, { size: 7, align: 'center', font: 'helvetica-bold' });
  page.restore();
}

/* ------------------------------- Dimensions ------------------------------- */

export interface DimensionStyle {
  /** How the number is written — the caller owns units. */
  format: (metres: number) => string;
  size?: number;
}

/**
 * A dimension string: extension lines, a dimension line, ticks and a number.
 *
 * Ticks rather than arrowheads, which is the architectural convention (and the
 * engineering one uses arrows) — a 45-degree slash at each witness line. The
 * number goes ABOVE the line when it fits between the ticks and beside the run
 * when it does not, because a dimension whose number overlaps its neighbour is
 * a dimension nobody can read.
 */
export function drawDimension(
  page: PdfPage,
  from: { x: number; y: number },
  to: { x: number; y: number },
  metres: number,
  style: DimensionStyle,
): void {
  const size = style.size ?? 7;
  const label = style.format(metres);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const run = Math.hypot(dx, dy);
  if (run < 0.5) return;

  const ux = dx / run;
  const uy = dy / run;

  page.save().strokeColour(BLACK).lineWidth(WEIGHTS.thin).dash(null);
  page.line(from.x, from.y, to.x, to.y);

  // The 45-degree ticks, drawn along the bisector of the line and the witness.
  const tick = 3;
  for (const point of [from, to]) {
    page.line(
      point.x - (ux + uy) * tick,
      point.y - (uy - ux) * tick,
      point.x + (ux + uy) * tick,
      point.y + (uy - ux) * tick,
    );
  }

  // Text reads along the dimension line, and never upside down.
  let angle = Math.atan2(dy, dx);
  if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;

  const width = textWidth(label, 'helvetica', size);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  // Perpendicular to the line, on the side text sits on.
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);

  if (width + 8 < run) {
    page.text(label, mid.x + nx * 2.5, mid.y + ny * 2.5, {
      size,
      align: 'center',
      rotate: angle,
    });
  } else {
    // Too tight: put it past the end, on the line's own axis.
    page.text(label, to.x + ux * 4 + nx * 2.5, to.y + uy * 4 + ny * 2.5, { size, rotate: angle });
  }

  page.restore();
}

/** Witness lines from the thing being measured out to the dimension line. */
export function drawWitness(
  page: PdfPage,
  at: { x: number; y: number },
  towards: { x: number; y: number },
): void {
  const dx = towards.x - at.x;
  const dy = towards.y - at.y;
  const run = Math.hypot(dx, dy);
  if (run < 0.5) return;

  page.save().strokeColour(GREY).lineWidth(WEIGHTS.thin).dash(null);
  // A gap at the building end, so the witness line never touches the wall it
  // measures — the convention that keeps a dimension from reading as a wall.
  page.line(at.x + (dx / run) * 2, at.y + (dy / run) * 2, towards.x + (dx / run) * 3, towards.y + (dy / run) * 3);
  page.restore();
}

/* ---------------------------------- Text ---------------------------------- */

/** Splits text into lines that fit a width, breaking on spaces. */
export function wrapText(text: string, font: FontId, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, font, size) <= maxWidth || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A block of wrapped text, returning the y it finished at. */
export function drawParagraph(
  page: PdfPage,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  options: { size?: number; font?: FontId; colour?: Colour; leading?: number } = {},
): number {
  const size = options.size ?? 7.5;
  const font = options.font ?? 'helvetica';
  const leading = options.leading ?? size * 1.35;

  let cursor = y;
  for (const line of wrapText(text, font, size, maxWidth)) {
    page.text(line, x, cursor, { size, font, colour: options.colour });
    cursor -= leading;
  }
  return cursor;
}

/* --------------------------------- Tables --------------------------------- */

export interface Column {
  header: string;
  /** Width in points. */
  width: number;
  align?: 'left' | 'right';
}

/**
 * A schedule table.
 *
 * Returns the y it finished at so a caller can stack several, and takes a
 * `pageBreak` callback for when a schedule is longer than the sheet — a door
 * schedule for a large house genuinely is, and silently truncating it would
 * lose doors.
 */
export function drawTable(
  page: PdfPage,
  columns: readonly Column[],
  rows: readonly string[][],
  x: number,
  y: number,
  options: {
    size?: number;
    rowHeight?: number;
    /** Stop and call this when the next row would fall below `bottom`. */
    bottom?: number;
    onOverflow?: () => { page: PdfPage; y: number } | null;
  } = {},
): { page: PdfPage; y: number } {
  const size = options.size ?? 7.5;
  const rowHeight = options.rowHeight ?? size * 1.8;
  const bottom = options.bottom ?? 0;
  const total = columns.reduce((sum, column) => sum + column.width, 0);

  let sheet = page;
  let cursor = y;

  const header = () => {
    sheet.save().strokeColour(BLACK).lineWidth(WEIGHTS.object);
    let cell = x;
    for (const column of columns) {
      sheet.text(column.header.toUpperCase(), column.align === 'right' ? cell + column.width - 3 : cell + 3, cursor - size, {
        size: size - 0.8,
        font: 'helvetica-bold',
        align: column.align === 'right' ? 'right' : 'left',
      });
      cell += column.width;
    }
    cursor -= rowHeight;
    sheet.line(x, cursor + rowHeight * 0.25, x + total, cursor + rowHeight * 0.25);
    sheet.restore();
  };

  header();

  sheet.save().lineWidth(WEIGHTS.thin).strokeColour(LIGHT);
  for (const row of rows) {
    if (cursor - rowHeight < bottom) {
      sheet.restore();
      const next = options.onOverflow?.();
      if (!next) return { page: sheet, y: cursor };
      sheet = next.page;
      cursor = next.y;
      header();
      sheet.save().lineWidth(WEIGHTS.thin).strokeColour(LIGHT);
    }

    let cell = x;
    for (const [index, column] of columns.entries()) {
      const value = row[index] ?? '';
      sheet.text(
        value,
        column.align === 'right' ? cell + column.width - 3 : cell + 3,
        cursor - size,
        { size, align: column.align === 'right' ? 'right' : 'left' },
      );
      cell += column.width;
    }
    cursor -= rowHeight;
    sheet.line(x, cursor + rowHeight * 0.2, x + total, cursor + rowHeight * 0.2);
  }
  sheet.restore();

  return { page: sheet, y: cursor };
}
