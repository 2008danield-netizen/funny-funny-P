/**
 * Filling a run of cabinetry, and placing what fills it.
 *
 * -----------------------------------------------------------------------------
 * THE PROBLEM, WHICH IS NOT THE OBVIOUS ONE.
 *
 * Given three metres of wall and a set of module widths, which units go in it?
 * The obvious answer is "the widest that fits, then the next widest" — and that
 * is wrong often enough to matter. Greedy on {1000, 800, 600, 450, 400, 300,
 * 200} leaves 3.05 m as 1000 + 1000 + 1000 and 50 mm of filler, when
 * 1000 + 1000 + 600 + 450 fills it exactly. The leftover is not cosmetic: a
 * filler is a blank panel, and a kitchen with 50 mm of blank panel in the middle
 * of a run is a kitchen that was planned badly.
 *
 * So it is solved properly, as an unbounded knapsack over the widths in 5 mm
 * steps: cover as much of the length as possible, and whatever cannot be
 * covered becomes filler. A 30 m run is 6,000 steps against seven widths, which
 * is 42,000 operations — nothing, and it runs only when a run is drawn.
 *
 * -----------------------------------------------------------------------------
 * THE FILLER GOES AT THE ENDS.
 *
 * Split between them, because that is where a fitter puts it: against the wall
 * at each end, where a 20 mm blank reads as a scribe rather than as a mistake.
 * Filler in the middle of a run is what you get from software.
 *
 * -----------------------------------------------------------------------------
 * A CORNER IS NOT TWO CABINETS.
 *
 * Where a run turns, the two legs would otherwise overlap in a square the depth
 * of the carcass on a side — and both doors would open into the same space and
 * neither would open at all. A corner unit takes that square and a bit more:
 * 880 mm along each leg for a base, which is the carcass depth plus a 280 mm
 * door, the narrowest opening a person can reach through. It is placed FIRST,
 * and the stretches between corners are filled independently.
 */

import { rotationFacing } from '@/advisor/geometry';
import {
  CARCASS,
  WORKTOP,
  cornerFor,
  fillerFor,
  getModule,
  modulesOfKind,
  widthsOfKind,
  type CabinetModule,
} from '@/fittings/modules';
import type { CabinetKind, CabinetRun, CabinetUnit, Point2 } from '@/state/types';

/** Widths are solved in 5 mm steps — finer than anything is manufactured to. */
const STEP = 0.005;

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

/** Starts the numbering again, so a fill is reproducible in a test. */
export function resetUnitIds(): void {
  counter = 0;
}

/* ------------------------------ Path geometry ----------------------------- */

export interface RunSegment {
  from: Point2;
  to: Point2;
  /** Unit vector along the segment. */
  direction: Point2;
  /**
   * Unit normal, 90 degrees anticlockwise — the direction the units face.
   *
   * The run tool orients the path so this points INTO the room. That one
   * convention is what lets everything downstream — the carcass, the worktop,
   * the door swing, the plan symbol — grow forward without asking again which
   * side the wall is on.
   */
  normal: Point2;
  length: number;
  /** Distance from the start of the whole run to this segment's start. */
  startsAt: number;
}

/** The path resolved into segments, with the running distance along it. */
export function runSegments(path: readonly Point2[]): RunSegment[] {
  const segments: RunSegment[] = [];
  let travelled = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;

    const direction = { x: dx / length, z: dz / length };
    segments.push({
      from,
      to,
      direction,
      normal: { x: -direction.z, z: direction.x },
      length,
      startsAt: travelled,
    });
    travelled += length;
  }

  return segments;
}

/** Total length of a run, along its path. */
export function runLength(path: readonly Point2[]): number {
  return runSegments(path).reduce((total, segment) => total + segment.length, 0);
}

/* -------------------------------- Filling --------------------------------- */

export interface Anchor {
  moduleId: string;
  /** Where the module's CENTRE wants to be, in metres along the path. */
  at: number;
}

export interface FillOptions {
  /**
   * Modules that must appear, in this order, before the rest is filled.
   *
   * The simple case: "put a sink base and a hob base in this run somewhere".
   */
  required?: readonly string[];
  /**
   * Modules that must appear at a PARTICULAR place along the run.
   *
   * This is what "the sink goes under the window" means. An anchored module is
   * placed as near its wanted position as it will fit, and the cupboards are
   * fitted into the gaps between anchors afterwards — which is the order a
   * planner works in, and the opposite of what filling left to right produces.
   */
  anchored?: readonly Anchor[];
  /** Put a corner unit where the run turns. On by default. */
  corners?: boolean;
}

/**
 * Chooses the units that fill a run.
 *
 * Returns them in order along the path, each with the offset of its left edge.
 * A run too short for anything comes back as a single filler, which is honest:
 * 150 mm of wall between a door and a corner really is a blank panel.
 */
export function fillRun(
  path: readonly Point2[],
  kind: CabinetKind,
  options: FillOptions = {},
): CabinetUnit[] {
  const segments = runSegments(path);
  if (segments.length === 0) return [];

  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  const corner = options.corners === false ? null : cornerFor(kind);
  const filler = fillerFor(kind);

  /*
   * The stretches between corners. With no interior vertex there is one
   * stretch, the whole run; with one there are two, each shortened by the
   * corner's width at the end that meets it.
   */
  interface Stretch {
    from: number;
    to: number;
  }
  const stretches: Stretch[] = [];
  const cornerAt: number[] = [];

  let cursor = 0;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const cornerWidth = corner && !last ? corner.width : 0;

    const end = segment.startsAt + segment.length - cornerWidth;
    if (end > cursor) stretches.push({ from: cursor, to: end });

    if (cornerWidth > 0) {
      cornerAt.push(end);
      // The corner eats its width from the far side of the vertex too.
      cursor = end + cornerWidth * 2;
    } else {
      cursor = end;
    }
  }

  const units: CabinetUnit[] = [];
  const required = [...(options.required ?? [])];
  const widths = widthsOfKind(kind);

  /** Fills one uninterrupted gap, with the leftover split between its ends. */
  const fillGap = (from: number, to: number, lead: CabinetModule[] = []) => {
    const length = to - from;
    if (length <= 1e-6) return;

    let used = lead.reduce((sum, module) => sum + module.width, 0);
    const chosen = solveWidths(length - used, widths);
    used += chosen.covered;

    const modules = [...lead, ...chosen.widths.map((width) => moduleOfWidth(kind, width))];

    /*
     * The leftover is split between the two ends. Half at each is what a fitter
     * does: a scribe against the wall at either end, rather than one wide blank
     * panel somewhere in the middle where everybody can see it.
     *
     * Unless there is nothing to put between them — a 150 mm stretch is one
     * blank panel, not two touching ones, and splitting it would put a joint in
     * a piece of board for no reason.
     */
    const leftover = length - used;
    const split = modules.length > 0 && leftover > STEP;
    const head = split ? leftover / 2 : 0;
    const tail = leftover - head;

    let offset = from;
    if (head > 1e-6) {
      units.push({ id: nextId('u'), moduleId: filler.id, width: head, offset });
      offset += head;
    }
    for (const module of modules) {
      units.push({ id: nextId('u'), moduleId: module.id, width: module.width, offset });
      offset += module.width;
    }
    if (tail > 1e-6) {
      units.push({ id: nextId('u'), moduleId: filler.id, width: tail, offset });
    }
  };

  for (const stretch of stretches) {
    const length = stretch.to - stretch.from;
    if (length <= 0) continue;

    /* ---- The anchored modules, placed where they were asked for ---- */
    const anchors = placeAnchors(options.anchored ?? [], stretch.from, stretch.to);

    /* ---- The unpositioned ones, as far as they fit in what is left ---- */
    const free = length - anchors.reduce((sum, anchor) => sum + anchor.module.width, 0);
    const lead: CabinetModule[] = [];
    let leadWidth = 0;
    while (required.length > 0) {
      const module = getModule(required[0]!);
      if (!module || leadWidth + module.width > free + 1e-9) break;
      lead.push(module);
      leadWidth += module.width;
      required.shift();
    }

    if (anchors.length === 0) {
      fillGap(stretch.from, stretch.to, lead);
      continue;
    }

    // The gaps between the anchors, filled independently. Whatever was asked
    // for without a position goes in the first gap wide enough to take it.
    let cursor = stretch.from;
    let leadUsed = false;
    for (const anchor of anchors) {
      const gap = anchor.from - cursor;
      const useLead = !leadUsed && leadWidth <= gap + 1e-9;
      fillGap(cursor, anchor.from, useLead ? lead : []);
      if (useLead) leadUsed = true;

      units.push({
        id: nextId('u'),
        moduleId: anchor.module.id,
        width: anchor.module.width,
        offset: anchor.from,
      });
      cursor = anchor.from + anchor.module.width;
    }
    fillGap(cursor, stretch.to, leadUsed ? [] : lead);
  }

  /*
   * The corners. Each consumes its width on BOTH legs — the path turns inside
   * the unit — so it takes twice its module width out of the run. Without that
   * the units of an L-shaped run do not sum to its length, and every worktop
   * and every dimension downstream is short by one corner.
   */
  if (corner) {
    for (const at of cornerAt) {
      units.push({ id: nextId('u'), moduleId: corner.id, width: corner.width * 2, offset: at });
    }
  }

  units.sort((a, b) => a.offset - b.offset);
  void total;
  return units;
}

/**
 * Turns wanted centres into non-overlapping positions inside one stretch.
 *
 * Anchors are honoured in the order they are given, each clamped inside the
 * stretch and pushed clear of the one before it. Anything that will not fit at
 * all is dropped rather than squeezed — a sink base half a module wide is not
 * a sink base.
 */
function placeAnchors(
  wanted: readonly Anchor[],
  from: number,
  to: number,
): Array<{ module: CabinetModule; from: number }> {
  const placed: Array<{ module: CabinetModule; from: number }> = [];

  const inside = wanted
    .map((anchor) => ({ anchor, module: getModule(anchor.moduleId) }))
    .filter(
      (entry): entry is { anchor: Anchor; module: CabinetModule } =>
        entry.module !== null && entry.anchor.at >= from && entry.anchor.at <= to,
    )
    .sort((a, b) => a.anchor.at - b.anchor.at);

  let cursor = from;
  for (const { anchor, module } of inside) {
    const left = Math.max(cursor, Math.min(anchor.at - module.width / 2, to - module.width));
    if (left < cursor - 1e-9 || left + module.width > to + 1e-9) continue;
    placed.push({ module, from: snap(left) });
    cursor = left + module.width;
  }

  return placed;
}

/** To the 5 mm grid the widths themselves are solved on. */
function snap(value: number): number {
  return Math.round(value / STEP) * STEP;
}

/**
 * The best set of module widths fitting inside a length.
 *
 * An unbounded knapsack in 5 mm steps: `covered[i]` is the most of `i` steps
 * that can be filled exactly by whole modules. Reconstructed by walking the
 * choice back, widest first so the run reads as a few big units rather than
 * many small ones — which is both cheaper and what a planner would draw.
 */
export function solveWidths(
  length: number,
  widths: readonly number[],
): { widths: number[]; covered: number } {
  const steps = Math.floor(length / STEP + 1e-6);
  if (steps <= 0 || widths.length === 0) return { widths: [], covered: 0 };

  const inSteps = widths
    .map((width) => Math.round(width / STEP))
    .filter((width) => width > 0 && width <= steps);
  if (inSteps.length === 0) return { widths: [], covered: 0 };

  const best = new Int32Array(steps + 1);
  const choice = new Int32Array(steps + 1).fill(-1);

  for (let i = 1; i <= steps; i++) {
    best[i] = best[i - 1]!;
    for (const width of inSteps) {
      if (width > i) continue;
      const candidate = best[i - width]! + width;
      if (candidate > best[i]!) {
        best[i] = candidate;
        choice[i] = width;
      }
    }
  }

  const chosen: number[] = [];
  let at = steps;
  while (at > 0) {
    const width = choice[at]!;
    if (width < 0) {
      at -= 1;
      continue;
    }
    chosen.push(width * STEP);
    at -= width;
  }

  chosen.sort((a, b) => b - a);
  return { widths: chosen, covered: best[steps]! * STEP };
}

/** The module of a given width — the first listed, which is the usual one. */
function moduleOfWidth(kind: CabinetKind, width: number): CabinetModule {
  const match = modulesOfKind(kind).find((entry) => Math.abs(entry.width - width) < 1e-6);
  return match ?? fillerFor(kind);
}

/* ------------------------------- Placement -------------------------------- */

export interface PlacedUnit {
  unit: CabinetUnit;
  module: CabinetModule;
  /** Centre of the carcass footprint, in world metres. */
  at: Point2;
  /** About Y. Zero faces +Z, like everything else in the document. */
  rotation: number;
  width: number;
  depth: number;
  height: number;
  /** Bottom of the carcass above the storey's floor. */
  lift: number;
  /**
   * The footprint, as one rectangle — or TWO for a corner unit, which is an L.
   *
   * Two polygons rather than one L-shaped one because the union of two
   * rectangles meeting at an arbitrary angle is fiddly to compute exactly and
   * nothing downstream needs it as a single ring: the plan draws both, and
   * collision tests both.
   */
  polygons: Point2[][];
  /** Which leg of the path it sits on. */
  segmentIndex: number;
}

export interface RunGeometry {
  runId: string;
  kind: CabinetKind;
  length: number;
  units: PlacedUnit[];
  /** One quad per leg, for a base run. Empty for wall and tall runs. */
  worktop: Point2[][];
  /** Worktop area in square metres, with the corner overlap taken off once. */
  worktopArea: number;
}

/** Where along the path a distance falls, and on which segment. */
function locate(segments: readonly RunSegment[], distance: number): { segment: RunSegment; index: number; local: number } | null {
  for (const [index, segment] of segments.entries()) {
    if (distance <= segment.startsAt + segment.length + 1e-6) {
      return { segment, index, local: Math.max(0, distance - segment.startsAt) };
    }
  }
  const last = segments[segments.length - 1];
  return last ? { segment: last, index: segments.length - 1, local: last.length } : null;
}

/** A rectangle standing on a segment, its back on the path. */
function rectangleOn(
  segment: RunSegment,
  from: number,
  width: number,
  depth: number,
): { at: Point2; polygon: Point2[] } {
  const back = (along: number): Point2 => ({
    x: segment.from.x + segment.direction.x * along,
    z: segment.from.z + segment.direction.z * along,
  });
  const forward = (point: Point2, by: number): Point2 => ({
    x: point.x + segment.normal.x * by,
    z: point.z + segment.normal.z * by,
  });

  const a = back(from);
  const b = back(from + width);
  return {
    at: forward(back(from + width / 2), depth / 2),
    polygon: [a, b, forward(b, depth), forward(a, depth)],
  };
}

/**
 * Resolves a run into world geometry.
 *
 * Everything that draws, prices, checks or collides with a kitchen goes through
 * here, so a unit is in exactly one place and the plan, the 3D view and the
 * collision solver can never disagree about where it is.
 */
export function runGeometry(run: CabinetRun): RunGeometry {
  const segments = runSegments(run.path);
  const carcass = CARCASS[run.kind];
  const placed: PlacedUnit[] = [];

  for (const unit of run.units) {
    const module = getModule(unit.moduleId);
    if (!module) continue;

    const found = locate(segments, unit.offset);
    if (!found) continue;

    if (module.front === 'corner') {
      /*
       * A corner sits ON the vertex: it runs back along the leg it arrives on
       * and forward along the leg it leaves on. Both legs are needed, so a
       * corner at the very end of a run — which should not happen, but a
       * hand-edited file can produce one — is drawn as a plain unit rather
       * than dropped.
       */
      const arriving = found.segment;
      const leaving = segments[found.index + 1];
      const first = rectangleOn(arriving, arriving.length - module.width, module.width, carcass.depth);

      if (!leaving) {
        placed.push({
          unit,
          module,
          at: first.at,
          rotation: rotationFacing(arriving.normal),
          width: module.width,
          depth: carcass.depth,
          height: carcass.height,
          lift: carcass.lift,
          polygons: [first.polygon],
          segmentIndex: found.index,
        });
        continue;
      }

      const second = rectangleOn(leaving, 0, module.width, carcass.depth);
      placed.push({
        unit,
        module,
        // The centre of the L is taken as the vertex itself pushed into the
        // room — the mean of the two rectangles' centres would sit outside it.
        at: {
          x: arriving.to.x + (arriving.normal.x + leaving.normal.x) * carcass.depth * 0.35,
          z: arriving.to.z + (arriving.normal.z + leaving.normal.z) * carcass.depth * 0.35,
        },
        rotation: rotationFacing({
          x: arriving.normal.x + leaving.normal.x,
          z: arriving.normal.z + leaving.normal.z,
        }),
        width: module.width,
        depth: carcass.depth,
        height: carcass.height,
        lift: carcass.lift,
        polygons: [first.polygon, second.polygon],
        segmentIndex: found.index,
      });
      continue;
    }

    const rectangle = rectangleOn(found.segment, found.local, unit.width, carcass.depth);
    placed.push({
      unit,
      module,
      at: rectangle.at,
      rotation: rotationFacing(found.segment.normal),
      width: unit.width,
      depth: carcass.depth,
      height: carcass.height,
      lift: carcass.lift,
      polygons: [rectangle.polygon],
      segmentIndex: found.index,
    });
  }

  /* ------------------------------- Worktop ------------------------------- */

  const worktop: Point2[][] = [];
  let worktopArea = 0;

  if (run.kind === 'base' && run.worktop) {
    for (const segment of segments) {
      const quad = rectangleOn(segment, 0, segment.length, WORKTOP.depth);
      worktop.push(quad.polygon);
      worktopArea += segment.length * WORKTOP.depth;
    }
    // Each interior corner is covered by both legs, so its square is in the
    // total twice. A fabricator prices from a cutting list, not from this, but
    // a figure that is knowingly 0.4 m² high is not worth printing.
    worktopArea -= Math.max(0, segments.length - 1) * WORKTOP.depth * WORKTOP.depth;
  }

  return {
    runId: run.id,
    kind: run.kind,
    length: segments.reduce((total, segment) => total + segment.length, 0),
    units: placed,
    worktop,
    worktopArea: Math.max(0, worktopArea),
  };
}

/**
 * The stretch of worktop each base run contributes, as centrelines.
 *
 * This is what NEC 210.52(C) measures along — "counter space" — so it is
 * derived once here rather than being re-derived by the check and by the
 * layout, which is how the two would come to disagree.
 */
export function counterLines(run: CabinetRun): Array<{ from: Point2; to: Point2; length: number }> {
  if (run.kind !== 'base') return [];
  return runSegments(run.path).map((segment) => ({
    from: {
      x: segment.from.x + segment.normal.x * (WORKTOP.depth / 2),
      z: segment.from.z + segment.normal.z * (WORKTOP.depth / 2),
    },
    to: {
      x: segment.to.x + segment.normal.x * (WORKTOP.depth / 2),
      z: segment.to.z + segment.normal.z * (WORKTOP.depth / 2),
    },
    length: segment.length,
  }));
}

/** Every unit of a run that a fixture can be built into. */
export function hostsIn(run: CabinetRun, appliance: string): CabinetUnit[] {
  return run.units.filter((unit) => {
    const module = getModule(unit.moduleId);
    return module ? module.hosts.some((entry) => entry === appliance) : false;
  });
}
