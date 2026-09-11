/**
 * The floor plan, drawn to scale.
 *
 * -----------------------------------------------------------------------------
 * WHAT A FLOOR PLAN IS.
 *
 * A horizontal cut through the building about four feet above the floor,
 * looking down. Everything the cut passes through — walls — is drawn heavy and
 * filled. Everything below the cut that you can see — furniture, the treads of
 * a stair — is drawn light. Doors and windows are gaps in the cut wall with a
 * symbol showing what fills them. That convention is a century old and every
 * builder reads it without being told, which is exactly why it is followed here
 * rather than something prettier being invented.
 *
 * -----------------------------------------------------------------------------
 * THE DIMENSIONS.
 *
 * Two strings on each of the top and left sides, which is the standard
 * arrangement: an outer string giving the overall size, and an inner string
 * breaking it down wall by wall. The inner string is built from the CENTRELINES
 * of walls running across the direction being measured, which is what a framer
 * actually sets out to.
 *
 * The inner string only picks up walls that run square to the sides of the
 * building, because a chain of dimensions along an axis is only meaningful for
 * walls perpendicular to it. A plan with angled walls still gets its overall
 * dimensions and its room sizes; the angled walls are simply not in the chain,
 * which is honest, and is what a draughtsman would do too (they would dimension
 * those separately, by angle and length).
 */

import { PdfPage, type Colour } from './pdf';
import {
  GREY,
  HIDDEN_DASH,
  LIGHT,
  WEIGHTS,
  drawDimension,
  drawWitness,
} from './sheet';
import type { Frame, Projector } from './scale';
import { boundsOf } from './scale';
import { findRegions, resolveWalls, type Region } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { itemDimensions } from '@/physics/colliders';
import { obbCorners } from '@/physics/collision';
import { stairGeometry } from '@/building/stairs';
import { runGeometry } from '@/building/cabinetRun';
import { getFixture } from '@/fittings/fixtures';
import { floorHoles, stairsOn } from '@/state/levels';
import type { DesignDocument, Level, Opening, Point2 } from '@/state/types';

/*
 * How dark the cut material is.
 *
 * Dark enough that the walls read as solid at a glance from across a desk, and
 * light enough that a dimension or a door number over them stays legible. Pale
 * grey looks tidy on a screen and disappears entirely on a black-and-white
 * office printer, which is where most of these end up.
 */
const WALL_FILL: Colour = [0.6, 0.6, 0.6];

export interface PlanOptions {
  /** Draw the cabinetry and the fixtures. */
  showFittings?: boolean;
  /** How a length is written — the caller owns units. */
  format: (metres: number) => string;
  /** How an area is written. */
  formatArea: (squareMetres: number) => string;
  /** Draw the furniture as light outlines. */
  showFurniture: boolean;
  /** Draw the dimension strings. */
  showDimensions: boolean;
  /**
   * Marks to print beside the openings they name, keyed by opening id.
   *
   * Passed in rather than computed here, because the marks have to be the SAME
   * ones the door and window schedules use — D1 on the plan and D1 in the
   * schedule are the same door or the set is useless. Numbering them twice in
   * two files is how they come to disagree.
   */
  openingMarks?: ReadonlyMap<string, string>;
  /** Section cut lines to draw across the plan, with their marks. */
  sectionCuts?: ReadonlyArray<{
    mark: string;
    from: Point2;
    to: Point2;
    looks: 'left' | 'right';
  }>;
}

/**
 * Every point the drawing has to fit: the outside of every wall, and the plot
 * if it is being drawn.
 *
 * Taken from the wall FACES rather than the centrelines, because a wall's
 * outer face is what the building measures to and a plan clipped by half a
 * wall thickness looks like a mistake.
 */
export function planExtent(level: Level): Point2[] {
  const points: Point2[] = [];
  for (const segment of resolveWalls(level.plan)) {
    const half = segment.wall.thickness / 2;
    for (const end of [segment.start, segment.end]) {
      for (const side of [1, -1]) {
        points.push({
          x: end.x + segment.normal.x * half * side,
          z: end.z + segment.normal.z * half * side,
        });
      }
    }
  }
  return points;
}

/* -------------------------------- The plan -------------------------------- */

export function drawFloorPlan(
  page: PdfPage,
  doc: DesignDocument,
  level: Level,
  projector: Projector,
  frame: Frame,
  options: PlanOptions,
): void {
  const regions = findRegions(level.plan);

  drawVoids(page, doc, level, projector);
  if (options.showFurniture) drawFurniture(page, level, projector);
  if (options.showFittings !== false) drawFittings(page, doc, level, projector);
  drawStairs(page, doc, level, projector);
  drawWalls(page, level, projector);
  drawRoomLabels(page, level, regions, projector, options);
  if (options.openingMarks) drawOpeningMarks(page, level, projector, options.openingMarks);
  if (options.sectionCuts) drawSectionCuts(page, projector, options.sectionCuts);
  if (options.showDimensions) drawDimensions(page, level, projector, frame, options);
}

/* ------------------------------ Opening marks ----------------------------- */

/**
 * The mark beside each door and window.
 *
 * What ties the plan to the schedules. Without it a reader holding a sheet
 * listing "D3: 900 × 2040, solid core, serves Bedroom 1" has no way to find out
 * which of the seven doors on the plan that is, and the schedule might as well
 * not be there.
 *
 * Set just off the wall on the side the opening's normal points, so the mark
 * sits in the room rather than on top of the wall poché it would be unreadable
 * against.
 */
function drawOpeningMarks(
  page: PdfPage,
  level: Level,
  projector: Projector,
  marks: ReadonlyMap<string, string>,
): void {
  for (const segment of resolveWalls(level.plan)) {
    for (const opening of segment.wall.openings) {
      const mark = marks.get(opening.id);
      if (!mark) continue;

      const centre = {
        x: segment.start.x + segment.direction.x * opening.offset,
        z: segment.start.z + segment.direction.z * opening.offset,
      };
      const offset = segment.wall.thickness / 2 + 0.32;
      const at = projector.at({
        x: centre.x + segment.normal.x * offset,
        z: centre.z + segment.normal.z * offset,
      });

      // A disc behind the text, so the mark stays readable over a floor finish
      // or a piece of furniture.
      page.save().fillColour([1, 1, 1]).strokeColour(GREY).lineWidth(WEIGHTS.thin).dash(null);
      page.circle(at.x, at.y, 6).fillAndStroke();
      page.restore();

      page.text(mark, at.x, at.y - 2, { size: 5.4, align: 'center' });
    }
  }
}

/* ------------------------------ Section marks ----------------------------- */

/**
 * The section cut lines, with an arrow at each end saying which way it looks.
 *
 * The arrow is the whole point. A line alone says where the building was cut
 * and not which half was kept, and those are two different drawings — so the
 * arrowheads point the way the viewer faces, which is the convention every
 * drawing office uses and the one thing that makes the mark unambiguous.
 */
function drawSectionCuts(
  page: PdfPage,
  projector: Projector,
  cuts: ReadonlyArray<{ mark: string; from: Point2; to: Point2; looks: 'left' | 'right' }>,
): void {
  for (const cut of cuts) {
    const from = projector.at(cut.from);
    const to = projector.at(cut.to);

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;

    const along = { x: dx / length, y: dy / length };
    // On the page y runs up while z runs down the plan, so the left-hand side
    // of the walk is (along.y, -along.x) here — the mirror of the world-space
    // version in `building/section.ts`, and the reason it is written out
    // rather than imported.
    const left = { x: along.y, y: -along.x };
    const look = cut.looks === 'left' ? left : { x: -left.x, y: -left.y };

    page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash([9, 3, 2, 3]);
    page.line(from.x, from.y, to.x, to.y).stroke();
    page.restore();

    for (const end of [from, to]) {
      const inward = end === from ? along : { x: -along.x, y: -along.y };

      // The tail: a short leg running back along the line, then the arrow.
      const elbow = { x: end.x + inward.x * 16, y: end.y + inward.y * 16 };
      const tip = { x: elbow.x + look.x * 14, y: elbow.y + look.y * 14 };

      page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
      page.line(end.x, end.y, elbow.x, elbow.y).stroke();
      page.line(elbow.x, elbow.y, tip.x, tip.y).stroke();

      const back = { x: -look.x, y: -look.y };
      const side = { x: -look.y, y: look.x };
      page.fillColour([0, 0, 0]);
      page
        .path(
          [
            tip,
            { x: tip.x + back.x * 6 + side.x * 2.4, y: tip.y + back.y * 6 + side.y * 2.4 },
            { x: tip.x + back.x * 6 - side.x * 2.4, y: tip.y + back.y * 6 - side.y * 2.4 },
          ],
          true,
        )
        .fill();
      page.restore();

      // The mark, in a circle at the outer end.
      page.save().fillColour([1, 1, 1]).strokeColour([0, 0, 0]).lineWidth(WEIGHTS.object).dash(null);
      page.circle(end.x, end.y, 7.5).fillAndStroke();
      page.restore();
      page.text(cut.mark, end.x, end.y - 2.6, { size: 6.5, align: 'center', font: 'helvetica-bold' });
    }
  }
}

/* --------------------------------- Walls ---------------------------------- */

/**
 * Walls as poché: the cut material, filled and outlined heavily.
 *
 * Each wall is drawn as the run of solid between its openings, so a door is a
 * genuine gap in the wall rather than a symbol laid over an unbroken rectangle
 * — which matters, because the gap is what tells you the wall is not there.
 */
function drawWalls(page: PdfPage, level: Level, projector: Projector): void {
  page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).fillColour(WALL_FILL).dash(null);

  for (const segment of resolveWalls(level.plan)) {
    const half = segment.wall.thickness / 2;
    const openings = [...segment.wall.openings].sort((a, b) => a.offset - b.offset);

    /** A point on the wall: `along` from the start, `side` × half across. */
    const corner = (along: number, side: number) =>
      projector.at({
        x: segment.start.x + segment.direction.x * along + segment.normal.x * half * side,
        z: segment.start.z + segment.direction.z * along + segment.normal.z * half * side,
      });

    let cursor = 0;
    for (const opening of openings) {
      const from = Math.max(0, opening.offset - opening.width / 2);
      const to = Math.min(segment.length, opening.offset + opening.width / 2);
      if (from > cursor) {
        page
          .path([corner(cursor, 1), corner(from, 1), corner(from, -1), corner(cursor, -1)], true)
          .fillAndStroke();
      }
      cursor = Math.max(cursor, to);
    }
    if (cursor < segment.length) {
      page
        .path(
          [corner(cursor, 1), corner(segment.length, 1), corner(segment.length, -1), corner(cursor, -1)],
          true,
        )
        .fillAndStroke();
    }

    for (const opening of openings) {
      drawOpening(page, opening, segment.length, corner, projector, half);
    }
  }

  page.restore();
}

/**
 * A door or a window in the gap left for it.
 *
 * A door is a leaf and a quarter-circle swing, drawn on the side and hinge the
 * model says — those two facts are the difference between a door that opens
 * into a room and one that opens into a corridor, and they are on the drawing
 * because somebody has to build it that way round.
 *
 * A window is the conventional three lines: the two faces of the frame and the
 * glass between them.
 */
function drawOpening(
  page: PdfPage,
  opening: Opening,
  wallLength: number,
  corner: (along: number, side: number) => { x: number; y: number },
  projector: Projector,
  half: number,
): void {
  const from = Math.max(0, opening.offset - opening.width / 2);
  const to = Math.min(wallLength, opening.offset + opening.width / 2);
  const width = to - from;
  if (width <= 0) return;

  page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);

  if (opening.kind === 'window') {
    // The frame lines across the reveal, then the glass down the middle.
    page.path([corner(from, 1), corner(from, -1)]).stroke();
    page.path([corner(to, 1), corner(to, -1)]).stroke();
    page.lineWidth(WEIGHTS.thin);
    page.path([corner(from, 1), corner(to, 1)]).stroke();
    page.path([corner(from, -1), corner(to, -1)]).stroke();
    page.path([corner(from, 0), corner(to, 0)]).stroke();
    page.restore();
    return;
  }

  /* ---- A door: the jambs, the leaf, and the swing ---- */
  page.path([corner(from, 1), corner(from, -1)]).stroke();
  page.path([corner(to, 1), corner(to, -1)]).stroke();

  /*
   * The leaf is drawn OPEN — standing square to the wall — with an arc back to
   * where it would be closed. Which end it is hinged on and which side it
   * swings towards both come out of the model, because those two facts are the
   * difference between a door that opens into the room and one that opens into
   * the hall, and somebody has to build it that way round.
   *
   * Face "a" is the side the wall's normal points at, which is `side = +1` in
   * the corner helper. The outward direction on the page is derived by taking
   * the two faces of the wall at the hinge and subtracting — no assumption
   * about how the projector oriented the page is needed.
   */
  const hingeAlong = opening.hinge === 'start' ? from : to;
  const otherAlong = opening.hinge === 'start' ? to : from;
  const side = opening.swing === 'a' ? 1 : -1;

  const hinge = corner(hingeAlong, side);
  const inner = corner(hingeAlong, -side);
  const closed = corner(otherAlong, side);
  const radius = projector.length(width);

  const outX = hinge.x - inner.x;
  const outY = hinge.y - inner.y;
  const outRun = Math.hypot(outX, outY) || 1;
  const open = { x: hinge.x + (outX / outRun) * radius, y: hinge.y + (outY / outRun) * radius };

  page.lineWidth(WEIGHTS.object);
  page.path([hinge, open]).stroke();

  page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash(null);
  drawArc(
    page,
    hinge,
    radius,
    Math.atan2(open.y - hinge.y, open.x - hinge.x),
    Math.atan2(closed.y - hinge.y, closed.x - hinge.x),
  );
  page.restore();

  page.restore();
  void half;
}

/** An arc, as up to four Bézier segments — enough for any door swing. */
function drawArc(
  page: PdfPage,
  centre: { x: number; y: number },
  radius: number,
  from: number,
  to: number,
): void {
  let sweep = to - from;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;

  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / steps;
  const k = (4 / 3) * Math.tan(step / 4);

  let angle = from;
  page.moveTo(centre.x + Math.cos(angle) * radius, centre.y + Math.sin(angle) * radius);
  for (let i = 0; i < steps; i++) {
    const next = angle + step;
    const x1 = centre.x + Math.cos(angle) * radius - k * radius * Math.sin(angle);
    const y1 = centre.y + Math.sin(angle) * radius + k * radius * Math.cos(angle);
    const x2 = centre.x + Math.cos(next) * radius + k * radius * Math.sin(next);
    const y2 = centre.y + Math.sin(next) * radius - k * radius * Math.cos(next);
    page.curveTo(x1, y1, x2, y2, centre.x + Math.cos(next) * radius, centre.y + Math.sin(next) * radius);
    angle = next;
  }
  page.stroke();
}

/* -------------------------------- Contents -------------------------------- */

/** Furniture as light outlines: below the cut, so it is drawn thin. */
function drawFurniture(page: PdfPage, level: Level, projector: Projector): void {
  page.save().lineWidth(WEIGHTS.thin).strokeColour(LIGHT).dash(null);

  for (const item of level.furniture) {
    const size = itemDimensions(item);
    const corners = obbCorners({
      center: { x: item.x, z: item.z },
      halfWidth: size.width / 2,
      halfDepth: size.depth / 2,
      rotation: item.rotation,
    });
    page.path(corners.map(projector.at), true).stroke();
  }

  page.restore();
}

/**
 * The cabinetry and the fixtures.
 *
 * Drawn in the plan convention, which is not the same as drawing what is there:
 *
 *   • BASE UNITS are solid outlines, because the cut passes above them and you
 *     are looking down at a worktop.
 *   • WALL UNITS are DASHED, because they are above the cut line — you cannot
 *     see them from the cut, and hidden work is dashed on every drawing ever
 *     made. A kitchen plan that draws them solid reads as two rows of cabinets
 *     on the floor.
 *   • A LINE ACROSS each base unit marks where one carcass ends and the next
 *     begins, which is what makes a run read as cupboards rather than as a
 *     rectangle.
 */
function drawFittings(
  page: PdfPage,
  doc: DesignDocument,
  level: Level,
  projector: Projector,
): void {
  /* ---- Wall units first, so base units draw over them ---- */
  page.save().lineWidth(WEIGHTS.hidden).strokeColour(GREY).dash(HIDDEN_DASH);
  for (const run of doc.runs) {
    if (run.levelId !== level.id || run.kind !== 'wall') continue;
    for (const placed of runGeometry(run).units) {
      for (const polygon of placed.polygons) {
        page.path(polygon.map(projector.at), true).stroke();
      }
    }
  }
  page.restore();

  /* ---- Base and tall units ---- */
  page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);
  for (const run of doc.runs) {
    if (run.levelId !== level.id || run.kind === 'wall') continue;

    const geometry = runGeometry(run);
    for (const placed of geometry.units) {
      for (const polygon of placed.polygons) {
        page.path(polygon.map(projector.at), true).stroke();
      }

      // A filler is hatched, so it reads as a blank panel rather than as a
      // cupboard nobody drew a door on.
      if (placed.module.front === 'filler') {
        const polygon = placed.polygons[0];
        if (polygon && polygon.length === 4) {
          page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY);
          page
            .path([projector.at(polygon[0]!), projector.at(polygon[2]!)])
            .stroke();
          page.restore();
        }
      }
    }

    // The worktop edge, which is what overhangs the doors.
    page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY);
    for (const quad of geometry.worktop) {
      page.path(quad.map(projector.at), true).stroke();
    }
    page.restore();
  }
  page.restore();

  /* ---- Fixtures ---- */
  page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);
  for (const fixture of doc.fixtures) {
    if (fixture.levelId !== level.id) continue;
    const entry = getFixture(fixture.fixtureId);
    if (!entry) continue;

    const corners = obbCorners({
      center: fixture.at,
      halfWidth: entry.width / 2,
      halfDepth: entry.depth / 2,
      rotation: fixture.rotation,
    });
    page.path(corners.map(projector.at), true).stroke();

    /*
     * A basin and a WC get an ellipse inside their rectangle, which is the
     * symbol everybody reads. Drawn as a circle scaled by the transform rather
     * than as a true ellipse, because a scaled circle is what an ellipse is.
     */
    if (entry.kind === 'wc' || entry.kind === 'basin' || entry.kind === 'vanity-basin' || entry.kind === 'sink') {
      const centre = projector.at(fixture.at);
      const radius = projector.length(Math.min(entry.width, entry.depth) * 0.34);
      page.save().lineWidth(WEIGHTS.thin);
      page.circle(centre.x, centre.y, radius).stroke();
      page.restore();
    }

    // A hob gets its four rings, which is how you tell it from a worktop.
    if (entry.kind === 'hob') {
      const centre = projector.at(fixture.at);
      const spread = projector.length(entry.width * 0.22);
      const radius = projector.length(0.075);
      page.save().lineWidth(WEIGHTS.thin);
      for (const dx of [-spread, spread]) {
        for (const dy of [-spread, spread]) {
          page.circle(centre.x + dx, centre.y + dy, radius).stroke();
        }
      }
      page.restore();
    }
  }
  page.restore();
}

/**
 * Stairs: the treads, and an arrow saying which way is up.
 *
 * The arrow and the word are not decoration. A flight drawn without them is
 * ambiguous — the same rectangle of parallel lines serves for a stair going up
 * and one going down — and "UP" is what resolves it on every plan ever drawn.
 */
function drawStairs(page: PdfPage, doc: DesignDocument, level: Level, projector: Projector): void {
  page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);

  for (const stair of stairsOn(doc, level.id)) {
    const geometry = stairGeometry(doc, stair);
    for (const tread of geometry.treads) {
      page.path(tread.polygon.map(projector.at), true).stroke();
    }

    const line = geometry.handrailLine;
    if (line.length >= 2) {
      const start = projector.at(line[0]!.at);
      const end = projector.at(line[line.length - 1]!.at);
      page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY);
      page.path([start, end]).stroke();

      // The arrowhead at the top of the flight.
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const run = Math.hypot(dx, dy) || 1;
      const ux = dx / run;
      const uy = dy / run;
      page
        .path([
          { x: end.x - ux * 6 - uy * 3, y: end.y - uy * 6 + ux * 3 },
          { x: end.x, y: end.y },
          { x: end.x - ux * 6 + uy * 3, y: end.y - uy * 6 - ux * 3 },
        ])
        .stroke();
      page.text('UP', start.x - ux * 8, start.y - uy * 8 - 2, {
        size: 6.5,
        align: 'center',
        colour: GREY,
      });
      page.restore();
    }
  }

  page.restore();
}

/** Floor voids — holes in this floor — as the dashed outlines they are. */
function drawVoids(page: PdfPage, doc: DesignDocument, level: Level, projector: Projector): void {
  const holes = floorHoles(doc, level.id, (stair) => stairGeometry(doc, stair).wellOpening);
  if (holes.length === 0) return;

  page.save().lineWidth(WEIGHTS.hidden).strokeColour(GREY).dash(HIDDEN_DASH);
  for (const hole of holes) page.path(hole.polygon.map(projector.at), true).stroke();
  page.restore();
}

/* --------------------------------- Labels --------------------------------- */

/** The room's name and its area, in the middle of the room. */
function drawRoomLabels(
  page: PdfPage,
  level: Level,
  regions: readonly Region[],
  projector: Projector,
  options: PlanOptions,
): void {
  page.save().fillColour([0, 0, 0]);

  for (const region of regions) {
    const spec = resolveRoomSpec(level.plan, region.key);
    const at = projector.at(region.interiorPoint);
    page.text(spec.name.toUpperCase(), at.x, at.y + 2, {
      size: 8,
      align: 'center',
      font: 'helvetica-bold',
    });
    page.text(options.formatArea(region.area), at.x, at.y - 8, {
      size: 6.5,
      align: 'center',
      colour: GREY,
    });
  }

  page.restore();
}

/* ------------------------------- Dimensions ------------------------------- */

/**
 * Two dimension strings each on the top and the left.
 *
 * The inner string is the chain of wall centrelines crossing that axis; the
 * outer is the overall size. Drawn outside the building on the page, offset far
 * enough that the outer string clears the inner one.
 */
function drawDimensions(
  page: PdfPage,
  level: Level,
  projector: Projector,
  frame: Frame,
  options: PlanOptions,
): void {
  const extent = boundsOf(planExtent(level));
  if (extent.width <= 0 || extent.depth <= 0) return;

  // In page coordinates, +z is DOWN the model and so DOWN the page is +z.
  const topLeft = projector.at({ x: extent.minX, z: extent.minZ });
  const bottomRight = projector.at({ x: extent.maxX, z: extent.maxZ });

  const INNER = 16;
  const OUTER = 34;

  /* ---- Across the top ---- */
  const verticals = crossingLines(level, 'x', extent);
  const topInner = topLeft.y + INNER;
  const topOuter = topLeft.y + OUTER;

  drawWitness(page, { x: topLeft.x, y: topLeft.y }, { x: topLeft.x, y: topOuter });
  drawWitness(page, { x: bottomRight.x, y: topLeft.y }, { x: bottomRight.x, y: topOuter });
  drawDimension(
    page,
    { x: topLeft.x, y: topOuter },
    { x: bottomRight.x, y: topOuter },
    extent.width,
    { format: options.format },
  );

  if (verticals.length > 0) {
    const stops = [extent.minX, ...verticals, extent.maxX];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = projector.at({ x: stops[i]!, z: extent.minZ });
      const b = projector.at({ x: stops[i + 1]!, z: extent.minZ });
      drawWitness(page, { x: a.x, y: topLeft.y }, { x: a.x, y: topInner });
      drawWitness(page, { x: b.x, y: topLeft.y }, { x: b.x, y: topInner });
      drawDimension(page, { x: a.x, y: topInner }, { x: b.x, y: topInner }, stops[i + 1]! - stops[i]!, {
        format: options.format,
        size: 6.5,
      });
    }
  }

  /* ---- Down the left ---- */
  const horizontals = crossingLines(level, 'z', extent);
  const leftInner = topLeft.x - INNER;
  const leftOuter = topLeft.x - OUTER;

  drawWitness(page, { x: topLeft.x, y: topLeft.y }, { x: leftOuter, y: topLeft.y });
  drawWitness(page, { x: topLeft.x, y: bottomRight.y }, { x: leftOuter, y: bottomRight.y });
  drawDimension(
    page,
    { x: leftOuter, y: bottomRight.y },
    { x: leftOuter, y: topLeft.y },
    extent.depth,
    { format: options.format },
  );

  if (horizontals.length > 0) {
    const stops = [extent.minZ, ...horizontals, extent.maxZ];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = projector.at({ x: extent.minX, z: stops[i]! });
      const b = projector.at({ x: extent.minX, z: stops[i + 1]! });
      drawWitness(page, { x: topLeft.x, y: a.y }, { x: leftInner, y: a.y });
      drawWitness(page, { x: topLeft.x, y: b.y }, { x: leftInner, y: b.y });
      drawDimension(page, { x: leftInner, y: b.y }, { x: leftInner, y: a.y }, stops[i + 1]! - stops[i]!, {
        format: options.format,
        size: 6.5,
      });
    }
  }

  void frame;
}

/**
 * The coordinates where walls square to the given axis cross it.
 *
 * "Square to the axis" means a wall running north-south contributes an x, and
 * one running east-west contributes a z. Duplicates within a couple of
 * centimetres are merged, because two walls meeting at a corner should not
 * produce a dimension of 12 mm between them.
 */
function crossingLines(
  level: Level,
  axis: 'x' | 'z',
  extent: { minX: number; maxX: number; minZ: number; maxZ: number },
): number[] {
  const values: number[] = [];
  const tolerance = 0.02;

  for (const segment of resolveWalls(level.plan)) {
    // A wall contributes to the x chain when it runs along z, and vice versa.
    const alongOther = axis === 'x' ? Math.abs(segment.direction.x) : Math.abs(segment.direction.z);
    if (alongOther > 0.05) continue;

    const value = axis === 'x' ? segment.center.x : segment.center.z;
    const low = axis === 'x' ? extent.minX : extent.minZ;
    const high = axis === 'x' ? extent.maxX : extent.maxZ;
    // Only interior lines: the outside ones are the overall dimension already.
    if (value - low < tolerance * 8 || high - value < tolerance * 8) continue;

    values.push(value);
  }

  values.sort((a, b) => a - b);
  const merged: number[] = [];
  for (const value of values) {
    const last = merged[merged.length - 1];
    if (last === undefined || value - last > tolerance) merged.push(value);
  }
  return merged;
}
