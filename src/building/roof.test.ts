/**
 * Tests for the roof builder.
 *
 * The skeleton is tested on its own (`skeleton.test.ts`); what is checked here
 * is everything between that and a roof somebody could build:
 *
 *   • The eave line clears the outside of the wall and then the overhang, which
 *     is the difference between a roof that sheds water past the wall and one
 *     that runs it down the siding.
 *   • The eave sits on the wall plate, on the right storey.
 *   • Heights follow the pitch — a 6:12 roof rises six inches for every foot in,
 *     everywhere, or the planes are not all the same roof.
 *   • A gable drops the plane over that eave and leaves a wall in its place.
 *   • Areas: plan area for the drawings, sloped area for the shingles.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument, defaultRoofFor } from '@/state/defaults';
import { addRectangle, normalizePlan } from '@/state/planOps';
import { addLevel } from '@/state/buildingOps';
import type { DesignDocument, Point2, Roof } from '@/state/types';

import { footprintsOf, eaveOutline } from './footprint';
import { planeAt, roofArea, roofGeometry, roofHeightAt, roofPlanArea } from './roof';

/* -------------------------------- Fixtures -------------------------------- */

const THICKNESS = 0.2;
const WALL_HEIGHT = 2.6;

/** A building of one storey with a single rectangular room. */
function box(width: number, depth: number): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;

  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  level.wallHeight = WALL_HEIGHT;
  level.plan.defaultWallThickness = THICKNESS;
  level.plan.defaultWallHeight = WALL_HEIGHT;
  addRectangle(level.plan, { x: 0, z: 0 }, width, depth);
  normalizePlan(level.plan);

  return doc;
}

/** An L: a `long` x `depth` bar with a `depth` x `long` wing off one end. */
function ell(): DesignDocument {
  const doc = box(9, 4);
  const level = doc.levels[0]!;
  addRectangle(level.plan, { x: -2.5, z: 5 }, 4, 6);
  normalizePlan(level.plan);
  return doc;
}

function roofOn(doc: DesignDocument, changes: Partial<Roof> = {}): Roof {
  return { ...defaultRoofFor(doc.levels[0]!.id), ...changes };
}

/** Every corner of every plane, as flat points. */
function allPoints(doc: DesignDocument, roof: Roof): Point2[] {
  const geometry = roofGeometry(doc, roof)!;
  return geometry.planes.flatMap((plane) => plane.points.map((p) => ({ x: p.x, z: p.z })));
}

/* --------------------------------- Tests ---------------------------------- */

describe('the footprint a roof sits on', () => {
  it('finds one outline per free-standing structure', () => {
    const doc = box(6, 4);
    // A shed drawn well clear of the house is its own building.
    addRectangle(doc.levels[0]!.plan, { x: 20, z: 0 }, 3, 3);
    normalizePlan(doc.levels[0]!.plan);

    const footprints = footprintsOf(doc.levels[0]!);
    expect(footprints).toHaveLength(2);
    // Largest first, so the house leads and the shed follows.
    expect(footprints[0]!.outline).toHaveLength(4);
  });

  it('merges a wall that was split in two', () => {
    const doc = box(6, 4);
    const level = doc.levels[0]!;
    // Split one side by adding a vertex halfway along it, as inserting a corner
    // or hanging a door does.
    const wall = level.plan.walls[0]!;
    const start = level.plan.vertices.find((v) => v.id === wall.start)!;
    const end = level.plan.vertices.find((v) => v.id === wall.end)!;
    const midId = 'vmid';
    level.plan.vertices.push({ id: midId, x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 });
    level.plan.walls.push({ ...wall, id: 'wsplit', start: midId, end: wall.end });
    wall.end = midId;
    normalizePlan(level.plan);

    const footprint = footprintsOf(level)[0]!;
    // Still a four-sided building: one side is now carried by two walls.
    expect(footprint.outline).toHaveLength(4);
    expect(footprint.wallIds.some((ids) => ids.length === 2)).toBe(true);
  });

  it('straightens out two rectangles drawn overlapping', () => {
    // How most people draw an L: two rectangles sharing part of a side. The
    // traced boundary walks out along the shared line and straight back down
    // it, which encloses no area — so it does not look wrong, it just stops the
    // roof solver dead. The outline has to come back as the six-cornered L the
    // drawing meant.
    const doc = ell();
    const footprint = footprintsOf(doc.levels[0]!)[0]!;

    expect(footprint.outline).toHaveLength(6);
    expect(footprint.wallIds).toHaveLength(6);
    // 9 x 4 bar and a 4 x 6 wing, sharing their overlap: 36 + 24.
    let area = 0;
    for (let i = 0; i < footprint.outline.length; i++) {
      const here = footprint.outline[i]!;
      const next = footprint.outline[(i + 1) % footprint.outline.length]!;
      area += here.x * next.z - next.x * here.z;
    }
    expect(Math.abs(area / 2)).toBeCloseTo(60, 6);
  });

  it('pushes the eave past the outside of the wall, then by the overhang', () => {
    const doc = box(6, 4);
    const footprint = footprintsOf(doc.levels[0]!)[0]!;
    const eaves = eaveOutline(footprint, 0.5);

    // Centreline 6 x 4, half a wall (0.1) each side, half a metre of overhang:
    // 6 + 0.2 + 1.0 = 7.2 by 5.2.
    const xs = eaves.map((point) => point.x);
    const zs = eaves.map((point) => point.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(7.2, 6);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(5.2, 6);
  });
});

describe('a hip roof on a rectangle', () => {
  const doc = box(10, 6);
  const roof = roofOn(doc, { kind: 'hip', pitch: 0.5, overhang: 0.4 });
  const geometry = roofGeometry(doc, roof)!;

  it('has one plane per side and nothing to report', () => {
    expect(geometry.problems).toEqual([]);
    expect(geometry.planes).toHaveLength(4);
    expect(geometry.gables).toHaveLength(0);
  });

  it('sits on the wall plate', () => {
    // One storey, so the plate is the wall height above the floor.
    expect(geometry.eaveHeight).toBeCloseTo(WALL_HEIGHT, 6);
  });

  it('rises at the pitch it was given', () => {
    // Centreline 10 x 6, plus 0.1 of wall and 0.4 of overhang on every side:
    // an 11 x 7 eave outline. The ridge is therefore 3.5 m in from the long
    // sides, and at a 6:12 pitch that is 1.75 m up.
    expect(geometry.rise).toBeCloseTo(3.5 * 0.5, 6);
    expect(roofHeightAt(geometry, { x: 0, z: 0 })).toBeCloseTo(WALL_HEIGHT + 1.75, 6);
  });

  it('holds one pitch everywhere', () => {
    // Halfway up a slope is halfway up in height too, on every plane.
    for (const plane of geometry.planes) {
      for (const point of plane.points) {
        const height = roofHeightAt(geometry, { x: point.x, z: point.z });
        if (height === null) continue;
        expect(height).toBeCloseTo(point.y, 6);
      }
    }
  });

  it('reports the sloped area as bigger than the plan area, by the slope factor', () => {
    const plan = roofPlanArea(geometry);
    expect(plan).toBeCloseTo(11 * 7, 4);
    expect(roofArea(geometry)).toBeCloseTo(plan * Math.hypot(1, 0.5), 4);
  });

  it('names its ridges and hips', () => {
    const kinds = geometry.edges.map((edge) => edge.kind);
    expect(kinds.filter((kind) => kind === 'eave')).toHaveLength(4);
    // Four hips up from the four corners, and one ridge between them.
    expect(kinds.filter((kind) => kind === 'hip')).toHaveLength(4);
    expect(kinds.filter((kind) => kind === 'ridge').length).toBeGreaterThanOrEqual(1);
    expect(kinds).not.toContain('valley');
  });
});

describe('a gable roof', () => {
  const doc = box(10, 6);
  const roof = roofOn(doc, { kind: 'gable', pitch: 0.5, overhang: 0.4 });
  const geometry = roofGeometry(doc, roof)!;

  it('drops the planes over the gabled ends and puts walls there instead', () => {
    expect(geometry.problems).toEqual([]);
    expect(geometry.planes).toHaveLength(2);
    expect(geometry.gables).toHaveLength(2);
  });

  it('runs the ridge the full length of the building', () => {
    const ridges = geometry.edges.filter((edge) => edge.kind === 'ridge');
    expect(ridges).toHaveLength(1);
    const ridge = ridges[0]!;
    expect(Math.hypot(ridge.to.x - ridge.from.x, ridge.to.z - ridge.from.z)).toBeCloseTo(11, 4);
    expect(ridge.from.y).toBeCloseTo(ridge.to.y, 6);
  });

  it('builds the gable wall up to the ridge', () => {
    // Half of the 7 m span at a 6:12 pitch: the same 1.75 m the hip reached.
    for (const gable of geometry.gables) {
      expect(gable.peak).toBeCloseTo(1.75, 6);
    }
  });

  it('gables the ends the user names, and hips the rest', () => {
    const footprint = footprintsOf(doc.levels[0]!)[0]!;
    // Name a long side instead: an unusual but perfectly legal choice.
    const longSide = footprint.outline.findIndex((point, index) => {
      const next = footprint.outline[(index + 1) % footprint.outline.length]!;
      return Math.hypot(next.x - point.x, next.z - point.z) > 9;
    });
    const named = roofOn(doc, {
      kind: 'gable',
      gableWallIds: [footprint.wallIds[longSide]![0]!],
    });

    const result = roofGeometry(doc, named)!;
    expect(result.gables).toHaveLength(1);
    expect(result.gables[0]!.edgeIndex).toBe(longSide);
    expect(result.planes).toHaveLength(3);
  });

  it('refuses to gable every side, and says so', () => {
    const footprint = footprintsOf(doc.levels[0]!)[0]!;
    const everyWall = footprint.wallIds.flat();
    const result = roofGeometry(doc, roofOn(doc, { kind: 'gable', gableWallIds: everyWall }))!;

    // Nothing would slope, so it falls back to a hip and explains itself.
    expect(result.gables).toHaveLength(0);
    expect(result.planes).toHaveLength(4);
    expect(result.problems.join(' ')).toMatch(/hipped/i);
  });
});

describe('an L-shaped roof', () => {
  const doc = ell();
  const geometry = roofGeometry(doc, roofOn(doc, { kind: 'hip', overhang: 0.3 }))!;

  it('covers every side and finds the valley', () => {
    expect(geometry.problems).toEqual([]);
    expect(geometry.planes.length).toBeGreaterThanOrEqual(6);
    expect(geometry.edges.some((edge) => edge.kind === 'valley')).toBe(true);
  });

  it('keeps the whole footprint under cover', () => {
    // Every plane's plan area, summed, is the area inside the eave line.
    const footprint = footprintsOf(doc.levels[0]!)[0]!;
    const eaves = eaveOutline(footprint, 0.3);
    let area = 0;
    for (let i = 0; i < eaves.length; i++) {
      const here = eaves[i]!;
      const next = eaves[(i + 1) % eaves.length]!;
      area += here.x * next.z - next.x * here.z;
    }
    expect(roofPlanArea(geometry)).toBeCloseTo(Math.abs(area / 2), 3);
  });
});

describe('a shed roof', () => {
  const doc = box(8, 5);
  const geometry = roofGeometry(doc, roofOn(doc, { kind: 'shed', pitch: 0.25, overhang: 0.3 }))!;

  it('is one plane', () => {
    expect(geometry.problems).toEqual([]);
    expect(geometry.planes).toHaveLength(1);
    expect(geometry.gables).toHaveLength(0);
  });

  it('falls from the high side to the low one', () => {
    const heights = geometry.planes[0]!.points.map((point) => point.y);
    const low = Math.min(...heights);
    const high = Math.max(...heights);

    expect(low).toBeCloseTo(geometry.eaveHeight, 6);
    // 5 m deep plus two 0.3 m overhangs and two half-walls: 5.8 across, at 1:4.
    expect(high - low).toBeCloseTo(5.8 * 0.25, 6);
  });

  it('falls to the wall the user names', () => {
    const footprint = footprintsOf(doc.levels[0]!)[0]!;
    const shortSide = footprint.outline.findIndex((point, index) => {
      const next = footprint.outline[(index + 1) % footprint.outline.length]!;
      return Math.hypot(next.x - point.x, next.z - point.z) < 6;
    });
    const named = roofOn(doc, {
      kind: 'shed',
      pitch: 0.25,
      overhang: 0.3,
      lowWallId: footprint.wallIds[shortSide]![0]!,
    });

    const result = roofGeometry(doc, named)!;
    // Now it falls across the 8 m direction instead of the 5 m one.
    expect(result.rise).toBeCloseTo(8.8 * 0.25, 6);
  });
});

describe('a flat roof', () => {
  it('still falls, because a roof that does not fall ponds', () => {
    const doc = box(8, 5);
    const geometry = roofGeometry(doc, roofOn(doc, { kind: 'flat', pitch: 0.0208 }))!;
    expect(geometry.planes).toHaveLength(1);
    expect(geometry.rise).toBeGreaterThan(0);
  });
});

describe('a roof on an upper storey', () => {
  it('sits on top of the storey it covers, not on the ground', () => {
    const doc = box(8, 6);
    addLevel(doc, { copyWalls: true });
    const upper = doc.levels[1]!;

    const geometry = roofGeometry(doc, roofOn(doc, { overLevelId: upper.id }))!;
    // Ground floor wall plus its slab, then the upper storey's own wall.
    const expected =
      doc.levels[0]!.wallHeight + upper.slabThickness + upper.wallHeight;
    expect(geometry.eaveHeight).toBeCloseTo(expected, 6);
  });
});

describe('when a roof cannot be built', () => {
  it('says so when the walls do not enclose anything', () => {
    const doc = createDefaultDocument();
    doc.levels[0]!.plan.walls = [];
    doc.levels[0]!.plan.vertices = [];

    const geometry = roofGeometry(doc, roofOn(doc))!;
    expect(geometry.planes).toHaveLength(0);
    expect(geometry.problems.join(' ')).toMatch(/nothing for a roof to sit on/i);
  });

  it('returns null for a roof over a storey that is gone', () => {
    const doc = box(4, 4);
    expect(roofGeometry(doc, roofOn(doc, { overLevelId: 'nope' }))).toBeNull();
  });

  it('keeps every plane inside the eave line', () => {
    const doc = ell();
    const roof = roofOn(doc, { kind: 'hip', overhang: 0.3 });
    const eaves = eaveOutline(footprintsOf(doc.levels[0]!)[0]!, 0.3);

    for (const point of allPoints(doc, roof)) {
      // Inside, or on the line: a roof point outside the eaves is a plane
      // hanging in the air beside the house.
      const outside = eaves.every((corner, index) => {
        const next = eaves[(index + 1) % eaves.length]!;
        const cross =
          (next.x - corner.x) * (point.z - corner.z) -
          (next.z - corner.z) * (point.x - corner.x);
        return cross < -1e-6;
      });
      expect(outside).toBe(false);
    }
  });
});

describe('finding the roof over a point', () => {
  it('reports nothing outside the eaves', () => {
    const doc = box(6, 4);
    const geometry = roofGeometry(doc, roofOn(doc))!;
    expect(roofHeightAt(geometry, { x: 50, z: 50 })).toBeNull();
    expect(planeAt(geometry, { x: 50, z: 50 })).toBeNull();
  });

  it('names the plane a point falls on', () => {
    const doc = box(10, 6);
    const geometry = roofGeometry(doc, roofOn(doc))!;
    // Well over towards one long side: that side's plane, and low down.
    const plane = planeAt(geometry, { x: 0, z: -3 });
    expect(plane).not.toBeNull();
    expect(roofHeightAt(geometry, { x: 0, z: -3 })!).toBeLessThan(
      roofHeightAt(geometry, { x: 0, z: 0 })!,
    );
  });
});
