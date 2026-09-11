/**
 * Drawing a section.
 *
 * -----------------------------------------------------------------------------
 * CUT IS HEAVY AND FILLED. BEYOND IS LIGHT AND EMPTY.
 *
 * That one convention carries most of the meaning on a section, and getting it
 * wrong is how a section misleads rather than merely disappoints. A cut surface
 * is solid matter you are looking at the raw end of, so it is drawn with the
 * heaviest line on the sheet and filled with the hatch of whatever it is made
 * of. A surface behind the cut is seen at a distance, so it is a thin grey
 * outline and nothing else.
 *
 * A wall drawn heavy that is actually eight metres away reads as an enclosure
 * that is not there — and somebody prices the wrong building.
 *
 * -----------------------------------------------------------------------------
 * THE LAYERS ARE DRAWN AT THEIR REAL THICKNESS.
 *
 * Not scaled to fit the wall somebody drew. If the two disagree, the drawing
 * says so in a note rather than drawing a plausible lie at the convenient size.
 * See `building/buildUp.ts` for why that argument is worth having.
 *
 * -----------------------------------------------------------------------------
 * HATCHING IS DRAWN BY HAND, LINE BY LINE.
 *
 * The PDF writer this app ships has no pattern fills and no clipping paths, and
 * adding either for this would be a great deal of machinery for one drawing.
 * Every hatch here is therefore a loop emitting strokes inside a rectangle it
 * computes itself — which is also why the hatches thin out rather than
 * disappearing as the scale gets small.
 */

import { PdfPage, type Colour } from './pdf';
import { GREY, LIGHT, WEIGHTS, drawParagraph } from './sheet';
import { pointsPerMetre, type DrawingScale, type Frame } from './scale';
import {
  FLOOR_BUILD_UPS,
  INTERMEDIATE_FLOOR_BUILD_UP,
  PARTITION_BUILD_UP,
  ROOF_BUILD_UPS,
  WALL_BUILD_UPS,
  buildUpThickness,
  thicknessMismatch,
  type BuildUp,
  type Hatch,
  type Layer,
} from '@/building/buildUp';
import { toSection, type CutWall, type Profile, type SectionModel } from '@/building/section';
import { elevationOf } from '@/state/levels';
import { sizeAllDucts } from '@/services/ductSize';
import { sizeAllDrainage, sizeAllSupply } from '@/services/plumbingSize';
import type { BuildingLoad } from '@/services/manualJ';
import type { SystemSelection } from '@/services/manualS';
import type { DesignDocument, PipePoint } from '@/state/types';

/** Section coordinates onto the page. */
export interface SectionProjector {
  at: (u: number, y: number) => { x: number; y: number };
  perMetre: number;
}

const CUT_FILL: Colour = [0.88, 0.88, 0.87];
const INSULATION_FILL: Colour = [0.95, 0.93, 0.86];

export interface SectionSheetOptions {
  imperial: boolean;
  /** Which services to draw where the cut passes through them. */
  showPlumbing: boolean;
  showDucts: boolean;
  showElectrical: boolean;
  /** Leader-line callouts naming each layer. Busy on a small sheet. */
  showCallouts: boolean;
}

/* -------------------------------- Hatching -------------------------------- */

/**
 * Fills a rectangle with the hatch for one material.
 *
 * Spacing is in POINTS rather than in metres, so the pattern stays legible at
 * any scale instead of collapsing into a solid block on a 1:100 drawing or
 * spreading into three lines on a 1:20 one. That is how hatching works on a
 * real drawing too: it is a notation, not a picture of the material.
 */
function hatchRect(
  page: PdfPage,
  hatch: Hatch,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (width <= 0.2 || height <= 0.2) return;

  page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash(null);

  switch (hatch) {
    case 'timber': {
      // Diagonals at 45 degrees, which is the universal notation for framing.
      const step = 4;
      for (let offset = -height; offset < width; offset += step) {
        const x1 = Math.max(x, x + offset);
        const y1 = y + (x1 - (x + offset));
        const x2 = Math.min(x + width, x + offset + height);
        const y2 = y + (x2 - (x + offset));
        if (x2 > x1 && y2 <= y + height) page.line(x1, y1, x2, y2);
      }
      break;
    }

    case 'batt': {
      /*
       * The batt squiggle. Drawn as a run of shallow arcs across the layer,
       * because that is what everybody draws and everybody reads — a hatched
       * rectangle would be indistinguishable from timber.
       */
      const amplitude = Math.min(height / 2.5, 3);
      const step = 5;
      page.moveTo(x, y + height / 2);
      let up = true;
      for (let cursor = x; cursor < x + width; cursor += step) {
        const next = Math.min(cursor + step, x + width);
        page.curveTo(
          cursor + step / 3,
          y + height / 2 + (up ? amplitude : -amplitude),
          next - step / 3,
          y + height / 2 + (up ? amplitude : -amplitude),
          next,
          y + height / 2,
        );
        up = !up;
      }
      page.stroke();
      break;
    }

    case 'rigid': {
      // Cross-hatch, distinct from timber's single direction.
      const step = 5;
      for (let offset = -height; offset < width; offset += step) {
        const x1 = Math.max(x, x + offset);
        const y1 = y + (x1 - (x + offset));
        const x2 = Math.min(x + width, x + offset + height);
        const y2 = y + (x2 - (x + offset));
        if (x2 > x1 && y2 <= y + height) page.line(x1, y1, x2, y2);

        const bx1 = Math.max(x, x + offset);
        const by1 = y + height - (bx1 - (x + offset));
        const bx2 = Math.min(x + width, x + offset + height);
        const by2 = y + height - (bx2 - (x + offset));
        if (bx2 > bx1 && by2 >= y) page.line(bx1, by1, bx2, by2);
      }
      break;
    }

    case 'concrete': {
      // Stipple: a scatter of dots and short ticks, positioned by a fixed
      // pseudo-random walk so the same wall hatches the same way every export.
      let seed = 1;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const count = Math.max(4, Math.floor((width * height) / 24));
      for (let i = 0; i < count; i += 1) {
        const px = x + random() * width;
        const py = y + random() * height;
        page.line(px, py, px + 0.8, py);
      }
      break;
    }

    case 'fill': {
      let seed = 7;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const count = Math.max(3, Math.floor((width * height) / 40));
      for (let i = 0; i < count; i += 1) {
        const px = x + random() * width;
        const py = y + random() * height;
        page.line(px - 1.2, py, px + 1.2, py);
        page.line(px, py - 1.2, px, py + 1.2);
      }
      break;
    }

    case 'membrane':
    case 'plain':
    case 'void':
    default:
      break;
  }

  page.stroke();
  page.restore();
}

/** Whether a layer reads as insulation, which gets a warm tint behind it. */
const isInsulation = (layer: Layer): boolean => layer.hatch === 'batt' || layer.hatch === 'rigid';

/* ------------------------------ Layered bands ----------------------------- */

/**
 * Draws a build-up across a rectangle, layer by layer.
 *
 * `across` says which way the layers stack: 'x' for a wall, where the layers
 * run through the thickness left to right, and 'y' for a floor or roof, where
 * they stack up through it.
 */
function drawLayers(
  page: PdfPage,
  buildUp: BuildUp,
  rect: { x: number; y: number; width: number; height: number },
  across: 'x' | 'y',
  perMetre: number,
): Array<{ layer: Layer; x: number; y: number; width: number; height: number }> {
  const placed: Array<{ layer: Layer; x: number; y: number; width: number; height: number }> = [];
  const total = buildUpThickness(buildUp);
  if (total <= 0) return placed;

  /*
   * The layers are drawn at their real thickness, so they are laid out from
   * the real total rather than stretched to the rectangle. Where the drawn
   * element is a different thickness the caller reports it; here the band is
   * simply centred, which keeps the drawing readable while the note explains.
   */
  const span = across === 'x' ? rect.width : rect.height;
  const drawn = total * perMetre;
  const start = (across === 'x' ? rect.x : rect.y) + (span - drawn) / 2;

  let cursor = start;
  for (const layer of buildUp.layers) {
    const size = layer.thickness * perMetre;

    const box =
      across === 'x'
        ? { x: cursor, y: rect.y, width: size, height: rect.height }
        : { x: rect.x, y: cursor, width: rect.width, height: size };

    if (isInsulation(layer)) {
      page.save().fillColour(INSULATION_FILL);
      page.rect(box.x, box.y, box.width, box.height).fill();
      page.restore();
    }

    hatchRect(page, layer.hatch, box.x, box.y, box.width, box.height);

    // The line between one layer and the next, thin — the heavy line is the
    // outside of the whole element, drawn by the caller.
    if (cursor > start + 0.01) {
      page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash(null);
      if (across === 'x') page.line(box.x, rect.y, box.x, rect.y + rect.height);
      else page.line(rect.x, box.y, rect.x + rect.width, box.y);
      page.stroke();
      page.restore();
    }

    placed.push({ layer, ...box });
    cursor += size;
  }

  return placed;
}

/* -------------------------------- The sheet ------------------------------- */

export interface SectionDrawResult {
  scaleLabel: string;
  /** Anything the drawing wants to say about itself, for the notes block. */
  notes: string[];
}

export function drawSection(
  page: PdfPage,
  doc: DesignDocument,
  model: SectionModel,
  hvac: { load: BuildingLoad; selection: SystemSelection } | null,
  scale: DrawingScale,
  frame: Frame,
  options: SectionSheetOptions,
): SectionDrawResult {
  const perMetre = pointsPerMetre(scale);
  const notes = [...model.notes];

  const { minU, maxU, minY, maxY } = model.extent;
  const originX = frame.x + frame.width / 2 - ((minU + maxU) / 2) * perMetre;
  const groundY = frame.y + 46;

  const projector: SectionProjector = {
    perMetre,
    at: (u, y) => ({ x: originX + u * perMetre, y: groundY + (y - minY) * perMetre }),
  };

  drawGround(page, model.ground, projector, frame);
  drawBeyond(page, model, projector);
  drawFloors(page, doc, model, projector, notes);
  drawCutWalls(page, doc, model, projector, notes, options);
  drawRoofs(page, doc, model, projector);
  drawStairs(page, model, projector);

  if (hvac || options.showPlumbing || options.showElectrical) {
    drawServices(page, doc, model, hvac, projector, options);
  }

  drawLevels(page, doc, model, projector, frame, options);

  void maxY;
  return { scaleLabel: scale.label, notes };
}

/* --------------------------------- Ground --------------------------------- */

function drawGround(
  page: PdfPage,
  ground: Profile,
  projector: SectionProjector,
  frame: Frame,
): void {
  if (ground.points.length < 2) return;

  page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
  page.path(ground.points.map((point) => projector.at(point.u, point.y))).stroke();
  page.restore();

  // Short hatch below the ground line, the universal "this is earth" notation.
  page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash(null);
  for (const point of ground.points) {
    const at = projector.at(point.u, point.y);
    if (at.x < frame.x || at.x > frame.x + frame.width) continue;
    page.line(at.x, at.y, at.x - 4, at.y - 5);
  }
  page.stroke();
  page.restore();
}

/* --------------------------------- Beyond --------------------------------- */

function drawBeyond(page: PdfPage, model: SectionModel, projector: SectionProjector): void {
  // Furthest first, so nearer surfaces draw over them — a poor man's depth
  // sort, and enough for surfaces that are all vertical rectangles.
  const sorted = [...model.beyond].sort((a, b) => b.depth - a.depth);

  page.save().lineWidth(WEIGHTS.thin).strokeColour(LIGHT).dash(null);
  for (const wall of sorted) {
    const bottomLeft = projector.at(wall.span.from, wall.base);
    const topRight = projector.at(wall.span.to, wall.top);
    page.rect(bottomLeft.x, bottomLeft.y, topRight.x - bottomLeft.x, topRight.y - bottomLeft.y);

    for (const opening of wall.openings) {
      const a = projector.at(opening.span.from, opening.sill);
      const b = projector.at(opening.span.to, opening.head);
      page.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
  }
  page.stroke();
  page.restore();
}

/* --------------------------------- Floors --------------------------------- */

function drawFloors(
  page: PdfPage,
  doc: DesignDocument,
  model: SectionModel,
  projector: SectionProjector,
  notes: string[],
): void {
  const lowest = doc.levels[0]?.id;

  for (const floor of model.floors) {
    /*
     * The lowest floor is the one that meets the ground, so it gets the
     * ground-floor build-up from the envelope spec. Every floor above it is an
     * intermediate floor between two heated storeys, which is a completely
     * different construction and is not part of the thermal envelope at all.
     */
    const buildUp =
      floor.levelId === lowest
        ? (FLOOR_BUILD_UPS[doc.hvac.envelope.floorAssemblyId] ?? FLOOR_BUILD_UPS['floor-slab']!)
        : INTERMEDIATE_FLOOR_BUILD_UP;

    const real = buildUpThickness(buildUp);

    for (const span of floor.spans) {
      const top = projector.at(span.from, floor.top);
      const bottom = projector.at(span.to, floor.top - real);

      const rect = {
        x: top.x,
        y: bottom.y,
        width: bottom.x - top.x,
        height: top.y - bottom.y,
      };

      page.save().fillColour(CUT_FILL).dash(null);
      page.rect(rect.x, rect.y, rect.width, rect.height).fill();
      page.restore();

      // Layers stack upward through a floor, so the build-up is reversed: it is
      // listed outside face first, and for a floor the outside is underneath.
      drawLayers(
        page,
        { ...buildUp, layers: [...buildUp.layers].reverse() },
        rect,
        'y',
        projector.perMetre,
      );

      page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
      page.rect(rect.x, rect.y, rect.width, rect.height).stroke();
      page.restore();
    }

    const mismatch = thicknessMismatch(floor.thickness, buildUp);
    if (mismatch) {
      notes.push(
        `${floor.levelName}: the floor is modelled ${Math.round(mismatch.drawn * 1000)} mm thick but "${buildUp.label}" builds up to ${Math.round(mismatch.real * 1000)} mm. The layers are drawn at their real thickness.`,
      );
    }
  }
}

/* ------------------------------- Cut walls -------------------------------- */

function drawCutWalls(
  page: PdfPage,
  doc: DesignDocument,
  model: SectionModel,
  projector: SectionProjector,
  notes: string[],
  options: SectionSheetOptions,
): void {
  const reported = new Set<string>();

  for (const wall of model.walls) {
    const buildUp = buildUpForWall(doc, wall);
    const real = buildUpThickness(buildUp);

    const bottomLeft = projector.at(wall.span.from, wall.base);
    const topRight = projector.at(wall.span.to, wall.top);

    // Centred on the wall's own position, at the build-up's real width.
    const centreX = (bottomLeft.x + topRight.x) / 2;
    const width = real * projector.perMetre;

    const rect = {
      x: centreX - width / 2,
      y: bottomLeft.y,
      width,
      height: topRight.y - bottomLeft.y,
    };

    page.save().fillColour(CUT_FILL).dash(null);
    page.rect(rect.x, rect.y, rect.width, rect.height).fill();
    page.restore();

    const placed = drawLayers(page, buildUp, rect, 'x', projector.perMetre);

    /* ---- The openings, punched back out ---- */

    for (const opening of wall.openings) {
      const sill = projector.at(wall.span.from, opening.sill);
      const head = projector.at(wall.span.to, opening.head);

      page.save().fillColour([1, 1, 1]).dash(null);
      page.rect(rect.x, sill.y, rect.width, head.y - sill.y).fill();
      page.restore();

      page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);
      page.rect(rect.x, sill.y, rect.width, head.y - sill.y).stroke();
      page.restore();

      // A window gets its glazing line; a door does not.
      if (opening.kind === 'window') {
        page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash(null);
        page.line(rect.x + rect.width / 2, sill.y, rect.x + rect.width / 2, head.y).stroke();
        page.restore();
      }
    }

    page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
    page.rect(rect.x, rect.y, rect.width, rect.height).stroke();
    page.restore();

    /* ---- Callouts, once per distinct build-up ---- */

    if (options.showCallouts && !reported.has(buildUp.label)) {
      reported.add(buildUp.label);
      drawCallouts(page, buildUp, placed, rect);
    }

    const mismatch = thicknessMismatch(wall.thickness, buildUp);
    if (mismatch && !reported.has(`t:${buildUp.label}`)) {
      reported.add(`t:${buildUp.label}`);
      notes.push(
        `A wall is drawn ${Math.round(mismatch.drawn * 1000)} mm thick but "${buildUp.label}" builds up to ${Math.round(mismatch.real * 1000)} mm. Those two facts disagree — the layers are drawn at their real thickness and the plan is not.`,
      );
    }
  }
}

function buildUpForWall(doc: DesignDocument, wall: CutWall): BuildUp {
  if (!wall.exterior) return PARTITION_BUILD_UP;
  return WALL_BUILD_UPS[doc.hvac.envelope.wallAssemblyId] ?? WALL_BUILD_UPS['wall-2x6-r21']!;
}

/**
 * Leader lines naming each layer.
 *
 * Drawn once per build-up rather than on every wall: a section through a house
 * cuts the same exterior wall three or four times, and annotating all of them
 * turns the sheet into a thicket saying the same thing repeatedly.
 */
function drawCallouts(
  page: PdfPage,
  buildUp: BuildUp,
  placed: Array<{ layer: Layer; x: number; y: number; width: number; height: number }>,
  rect: { x: number; y: number; width: number; height: number },
): void {
  if (placed.length === 0) return;

  const startY = rect.y + rect.height * 0.72;
  const textX = rect.x + rect.width + 42;
  let cursor = startY;

  page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash(null);
  for (const entry of placed) {
    if (entry.layer.hatch === 'membrane') continue;

    const anchorX = entry.x + entry.width / 2;
    const anchorY = rect.y + rect.height * 0.62;

    page.moveTo(anchorX, anchorY);
    page.lineTo(anchorX, cursor);
    page.lineTo(textX - 3, cursor);
    page.stroke();

    cursor += 9;
  }
  page.restore();

  cursor = startY;
  for (const entry of placed) {
    if (entry.layer.hatch === 'membrane') continue;
    const suffix = entry.layer.rValue > 0 ? `  R-${entry.layer.rValue}` : '';
    page.text(`${entry.layer.name}${suffix}`, textX, cursor - 2, { size: 5.6, colour: GREY });
    cursor += 9;
  }

  page.text(buildUp.label.toUpperCase(), textX, startY - 12, { size: 6, font: 'helvetica-bold' });
}

/* ---------------------------------- Roofs --------------------------------- */

function drawRoofs(
  page: PdfPage,
  doc: DesignDocument,
  model: SectionModel,
  projector: SectionProjector,
): void {
  const buildUp =
    ROOF_BUILD_UPS[doc.hvac.envelope.roofAssemblyId] ?? ROOF_BUILD_UPS['roof-r49']!;

  /*
   * A loft build-up is not drawn as a band following the slope — the
   * insulation lies on the ceiling, not on the rafters. So the sloping part is
   * drawn as the deck and covering only, and the insulation is drawn flat
   * where it actually is. Drawing the whole build-up down the slope would
   * depict a completely different roof with completely different ventilation.
   */
  const slopeThickness = buildUp.layers
    .filter((layer) => layer.hatch !== 'batt' && layer.hatch !== 'void')
    .reduce((total, layer) => total + layer.thickness, 0);

  for (const roof of model.roofs) {
    const points = roof.profile.points;
    if (points.length < 2) continue;

    const outer = points.map((point) => projector.at(point.u, point.y));
    const inner = points.map((point) => projector.at(point.u, point.y - slopeThickness));

    page.save().fillColour(CUT_FILL).dash(null);
    page.path([...outer, ...[...inner].reverse()], true).fill();
    page.restore();

    page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
    page.path(outer).stroke();
    page.path(inner).stroke();
    page.restore();
  }
}

/* --------------------------------- Stairs --------------------------------- */

function drawStairs(page: PdfPage, model: SectionModel, projector: SectionProjector): void {
  for (const stair of model.stairs) {
    const points = stair.profile.points;
    if (points.length < 2) continue;

    page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);
    page.path(points.map((point) => projector.at(point.u, point.y))).stroke();
    page.restore();
  }
}

/* -------------------------------- Services -------------------------------- */

/**
 * Anything crossing the cut plane, drawn as the circle it really is.
 *
 * A pipe or a duct passing through a section plane shows as a circle of its
 * own diameter, and that is the whole point of putting them on this drawing:
 * a 400 mm duct and a 240 mm joist wanting the same void is obvious here and
 * invisible on every other sheet in the set.
 */
function drawServices(
  page: PdfPage,
  doc: DesignDocument,
  model: SectionModel,
  hvac: { load: BuildingLoad; selection: SystemSelection } | null,
  projector: SectionProjector,
  options: SectionSheetOptions,
): void {
  const crossings: Array<{ u: number; y: number; radius: number; label: string; colour: Colour }> = [];

  const walk = (
    points: readonly PipePoint[],
    radius: number,
    label: string,
    colour: Colour,
  ): void => {
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;

      const pa = toSection(model.frame, a.at);
      const pb = toSection(model.frame, b.at);
      if (pa.depth === pb.depth) continue;
      if (pa.depth > 0 === pb.depth > 0) continue;

      const t = pa.depth / (pa.depth - pb.depth);
      const u = pa.u + (pb.u - pa.u) * t;

      const ya = elevationOf(doc, a.levelId) + a.height;
      const yb = elevationOf(doc, b.levelId) + b.height;
      crossings.push({ u, y: ya + (yb - ya) * t, radius, label, colour });
    }
  };

  if (options.showPlumbing) {
    for (const entry of sizeAllDrainage(doc)) {
      walk(entry.run.points, entry.size.size / 2, entry.size.asWritten, [0.35, 0.33, 0.28]);
    }
    for (const entry of sizeAllSupply(doc)) {
      walk(entry.run.points, entry.size.size / 2, entry.size.asWritten, [0.14, 0.4, 0.6]);
    }
  }

  if (options.showDucts && hvac) {
    for (const duct of sizeAllDucts(doc, hvac.load, hvac.selection)) {
      walk(
        duct.run.points,
        (duct.size.inches * 0.0254) / 2,
        duct.size.asWritten,
        duct.run.system === 'supply' ? [0.29, 0.56, 0.72] : [0.6, 0.56, 0.5],
      );
    }
  }

  for (const crossing of crossings) {
    const at = projector.at(crossing.u, crossing.y);
    const radius = Math.max(1.2, crossing.radius * projector.perMetre);

    page.save().lineWidth(WEIGHTS.object).strokeColour(crossing.colour).fillColour([1, 1, 1]).dash(null);
    page.circle(at.x, at.y, radius).fillAndStroke();
    page.restore();

    if (radius > 3) {
      page.text(crossing.label, at.x + radius + 2, at.y - 2, { size: 4.6, colour: GREY });
    }
  }
}

/* --------------------------------- Levels --------------------------------- */

/**
 * A level line at each finished floor, with its height.
 *
 * The measurement a section exists to give. Everything else on the sheet can be
 * read off a plan or an elevation; the floor-to-floor heights cannot.
 */
function drawLevels(
  page: PdfPage,
  doc: DesignDocument,
  model: SectionModel,
  projector: SectionProjector,
  frame: Frame,
  options: SectionSheetOptions,
): void {
  const left = frame.x + 6;

  page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash([3, 2]);
  for (const level of doc.levels) {
    const y = elevationOf(doc, level.id);
    const at = projector.at(model.extent.minU, y);
    page.line(left, at.y, frame.x + frame.width - 6, at.y);
  }
  page.stroke();
  page.restore();

  for (const level of doc.levels) {
    const y = elevationOf(doc, level.id);
    const at = projector.at(model.extent.minU, y);
    const label = options.imperial
      ? `${Math.floor(y / 0.3048)}' ${Math.round(((y / 0.3048) % 1) * 12)}"`
      : `+${y.toFixed(3)}`;

    page.text(`${level.name}   ${label}`, left + 2, at.y + 3, { size: 5.8, colour: GREY });
  }
}

/* ---------------------------------- Notes --------------------------------- */

/** The standing caveats, plus anything this particular section discovered. */
export function drawSectionNotes(
  page: PdfPage,
  notes: readonly string[],
  x: number,
  y: number,
  width: number,
): number {
  let cursor = y;

  page.text('NOTES', x, cursor, { size: 7 });
  cursor -= 12;

  const all = [
    ...notes,
    'Construction layers are a representative build-up for the assembly specified, not a designed detail. Nobody should order material off this drawing.',
    'No structural design has been done: joists, beams, headers and lintels are not sized and are not shown.',
    'Services are drawn where they cross the cut plane. They have not been checked against the structure they pass through.',
  ];

  for (const note of all) {
    cursor = drawParagraph(page, note, x, cursor, width, { size: 6.2, colour: GREY }) - 6;
  }

  return cursor;
}
