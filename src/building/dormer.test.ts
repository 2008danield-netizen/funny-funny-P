/**
 * Tests for dormers and skylights.
 *
 * The property that matters most is that these things MEET the roof they are
 * cut into. A dormer whose roof stops short of the main roof, or a skylight
 * whose glass floats above it, still renders — it just has a gap in it, and a
 * gap in a roof is the one defect a drawing must never contain.
 *
 * So most of what is checked here is contact: the derived depth, the height
 * where the sides die in, and the refusal to place anything that would run off
 * the plane it belongs to.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument, defaultRoofFor } from '@/state/defaults';
import { addRectangle, normalizePlan } from '@/state/planOps';
import type { DesignDocument, Dormer, Roof, Skylight } from '@/state/types';

import { dormerGeometry, holesInPlane, roofOpenings, skylightGeometry } from './dormer';
import { planeAt, roofGeometry, roofHeightAt } from './roof';

const WALL_HEIGHT = 2.6;

function box(width: number, depth: number): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  level.wallHeight = WALL_HEIGHT;
  level.plan.defaultWallThickness = 0.2;
  level.plan.defaultWallHeight = WALL_HEIGHT;
  addRectangle(level.plan, { x: 0, z: 0 }, width, depth);
  normalizePlan(level.plan);
  return doc;
}

/** A 12 x 8 house with a 6:12 gable roof: eaves at 13 x 9, ridge down the middle. */
function gabledHouse(): { doc: DesignDocument; roof: Roof } {
  const doc = box(12, 8);
  const roof: Roof = {
    ...defaultRoofFor(doc.levels[0]!.id),
    kind: 'gable',
    pitch: 0.5,
    overhang: 0.4,
  };
  return { doc, roof };
}

function dormerAt(at: { x: number; z: number }, changes: Partial<Dormer> = {}): Dormer {
  return {
    id: 'd1',
    kind: 'gable',
    at,
    width: 1.6,
    faceHeight: 1,
    pitch: 0.5,
    window: { width: 0.9, height: 0.9, sillHeight: 0.1 },
    ...changes,
  };
}

function skylightAt(at: { x: number; z: number }, changes: Partial<Skylight> = {}): Skylight {
  return {
    id: 's1',
    at,
    width: 0.8,
    length: 1.2,
    kind: 'fixed',
    glazing: 'laminated',
    curb: 0.15,
    ...changes,
  };
}

describe('a gable dormer', () => {
  const { doc, roof } = gabledHouse();
  const geometry = roofGeometry(doc, roof)!;
  /*
   * Set down near the eave on the front slope, which is where dormers go — and
   * where there is room for one. A dormer reaches back up the slope by an
   * amount it works out for itself, so putting one halfway up a roof is asking
   * it to climb over the ridge.
   */
  const dormer = dormerAt({ x: 0, z: -3.6 });
  const built = dormerGeometry(geometry, dormer);

  it('sits on the plane under it, with nothing to report', () => {
    expect(built.problems).toEqual([]);
    expect(built.edgeIndex).toBe(planeAt(geometry, dormer.at)!.edgeIndex);
  });

  it('works out its own depth from the two pitches', () => {
    // The ridge is 1 m of face plus half the width at the dormer's own pitch
    // above the roof, and the main roof climbs at 1:2 — so it dies in at twice
    // that height.
    const expected = (dormer.faceHeight + (dormer.width / 2) * dormer.pitch) / 0.5;
    expect(built.depth).toBeCloseTo(expected, 6);
  });

  it('meets the main roof exactly where its ridge runs out', () => {
    const back = built.ridge!.to;
    const roofHere = roofHeightAt(geometry, { x: back.x, z: back.z })!;
    // Dead level with the roof: any gap here is a hole in the building.
    expect(back.y).toBeCloseTo(roofHere, 6);
  });

  it('meets the main roof along its cheeks too', () => {
    // Uphill on this slope is +z, so the back corner of each cheek is its
    // furthest point that way — and that corner is where the cheek dies into
    // the roof. Picking the HIGHEST point instead finds the top of the front
    // wall, which is a metre clear of the roof by design.
    for (const cheek of built.cheeks) {
      const back = cheek.points.reduce((furthest, point) =>
        point.z > furthest.z ? point : furthest,
      );
      expect(back.y).toBeCloseTo(roofHeightAt(geometry, { x: back.x, z: back.z })!, 6);
    }
  });

  it('faces down the slope', () => {
    // The front is the lowest part, and it is further from the ridge than the
    // back is — a dormer facing the wrong way is a very quiet bug.
    const front = built.front.points[0]!;
    const back = built.ridge!.to;
    expect(Math.abs(front.z)).toBeGreaterThan(Math.abs(back.z));
  });

  it('gives the front a gable, and the window inside it', () => {
    // Two corners at the base, two at the eaves, one apex.
    expect(built.front.points).toHaveLength(5);
    const apex = Math.max(...built.front.points.map((point) => point.y));
    expect(built.ridge!.from.y).toBeCloseTo(apex, 6);

    const window = built.window!.points;
    const lowest = Math.min(...window.map((point) => point.y));
    const highest = Math.max(...window.map((point) => point.y));
    expect(lowest).toBeGreaterThan(Math.min(...built.front.points.map((p) => p.y)));
    expect(highest).toBeLessThan(apex);
  });

  it('cuts a five-sided hole in the roof', () => {
    expect(built.hole).toHaveLength(5);
  });
});

describe('a shed dormer', () => {
  const { doc, roof } = gabledHouse();
  const geometry = roofGeometry(doc, roof)!;

  it('reaches further back the shallower it is', () => {
    const steep = dormerGeometry(geometry, dormerAt({ x: 0, z: -3.6 }, { kind: 'shed', pitch: 0.2 }));
    const shallow = dormerGeometry(
      geometry,
      dormerAt({ x: 0, z: -3.6 }, { kind: 'shed', pitch: 0.1 }),
    );

    expect(steep.problems).toEqual([]);
    expect(shallow.depth).toBeLessThan(steep.depth);
    // faceHeight / (mainPitch - dormerPitch).
    expect(steep.depth).toBeCloseTo(1 / (0.5 - 0.2), 6);
  });

  it('eases a pitch that could never meet the roof, and says so', () => {
    // A shed dormer as steep as the roof runs parallel to it for ever.
    const built = dormerGeometry(
      geometry,
      dormerAt({ x: 0, z: -3.6 }, { kind: 'shed', pitch: 0.5 }),
    );

    expect(built.problems.join(' ')).toMatch(/shallower/i);
    expect(Number.isFinite(built.depth)).toBe(true);
    expect(built.depth).toBeGreaterThan(0);
  });

  it('has a flat front with no gable on it', () => {
    const built = dormerGeometry(geometry, dormerAt({ x: 0, z: -3.6 }, { kind: 'shed', pitch: 0.2 }));
    expect(built.front.points).toHaveLength(4);
    expect(built.hole).toHaveLength(4);
  });
});

describe('a hipped dormer', () => {
  it('slopes on the front as well, so its ridge starts further back', () => {
    const { doc, roof } = gabledHouse();
    const geometry = roofGeometry(doc, roof)!;
    const built = dormerGeometry(geometry, dormerAt({ x: 0, z: -3.6 }, { kind: 'hipped' }));

    expect(built.problems).toEqual([]);
    // Four planes: the front hip, the two sides, and no gable triangle in front.
    expect(built.planes).toHaveLength(3);
    expect(built.front.points).toHaveLength(4);
    // The ridge starts half a width in from the face.
    const start = built.ridge!.from;
    const front = built.front.points[0]!;
    expect(Math.hypot(start.x - front.x, start.z - front.z)).toBeGreaterThan(0.7);
  });
});

describe('a dormer that will not fit', () => {
  const { doc, roof } = gabledHouse();
  const geometry = roofGeometry(doc, roof)!;

  it('says so when it runs over the ridge', () => {
    // Tall enough that it climbs past the top of the roof.
    const built = dormerGeometry(geometry, dormerAt({ x: 0, z: -1 }, { faceHeight: 2.5 }));
    expect(built.problems.join(' ')).toMatch(/off the edge/i);
  });

  it('says so when it is placed off the roof entirely', () => {
    const built = dormerGeometry(geometry, dormerAt({ x: 40, z: 40 }));
    expect(built.problems.join(' ')).toMatch(/not on a sloping part|outside the roof/i);
    expect(built.planes).toEqual([]);
  });

  it('says so on a flat roof, where there is no slope to face', () => {
    const flatDoc = box(8, 6);
    const flat = roofGeometry(flatDoc, {
      ...defaultRoofFor(flatDoc.levels[0]!.id),
      kind: 'flat',
      pitch: 0.0208,
    })!;
    // A flat roof does slope, just barely — so this one is placed on a roof
    // with no fall at all to be sure the guard itself works.
    const level = roofGeometry(flatDoc, {
      ...defaultRoofFor(flatDoc.levels[0]!.id),
      kind: 'flat',
      pitch: 0,
    })!;

    expect(dormerGeometry(flat, dormerAt({ x: 0, z: 0 })).problems.length).toBeGreaterThan(0);
    expect(dormerGeometry(level, dormerAt({ x: 0, z: 0 })).problems.join(' ')).toMatch(
      /not on a sloping part/i,
    );
  });
});

describe('a skylight', () => {
  const { doc, roof } = gabledHouse();
  const geometry = roofGeometry(doc, roof)!;

  it('lies in the plane of the roof, lifted by its curb', () => {
    const built = skylightGeometry(geometry, skylightAt({ x: 0, z: -2.5 }));
    expect(built.problems).toEqual([]);

    for (const corner of built.pane.points) {
      const deck = roofHeightAt(geometry, { x: corner.x, z: corner.z })!;
      // Every corner is the same distance above the roof: the glass is parallel
      // to the roof, not tipped out of it.
      expect(corner.y - deck).toBeCloseTo(0.15 * Math.hypot(1, 0.5), 6);
    }
  });

  it('sits flush when it has no curb', () => {
    const built = skylightGeometry(geometry, skylightAt({ x: 0, z: -2.5 }, { curb: 0 }));
    expect(built.curb).toEqual([]);
    for (const corner of built.pane.points) {
      expect(corner.y).toBeCloseTo(roofHeightAt(geometry, { x: corner.x, z: corner.z })!, 6);
    }
  });

  it('refuses to straddle a ridge', () => {
    // Right on the ridge line: half of it would be on each slope.
    const built = skylightGeometry(geometry, skylightAt({ x: 0, z: 0 }, { length: 2 }));
    expect(built.problems.join(' ')).toMatch(/ridge or a valley|within one plane/i);
  });

  it('refuses to hang off the eave', () => {
    const built = skylightGeometry(geometry, skylightAt({ x: 0, z: -4.4 }, { length: 2 }));
    expect(built.problems.length).toBeGreaterThan(0);
  });
});

describe('openings on a roof', () => {
  it('gathers the holes per plane', () => {
    const { doc, roof } = gabledHouse();
    const withOpenings: Roof = {
      ...roof,
      dormers: [dormerAt({ x: -3, z: -3.6 })],
      skylights: [skylightAt({ x: 3, z: -2.5 }), skylightAt({ x: 3, z: 2.5 })],
    };

    const geometry = roofGeometry(doc, withOpenings)!;
    const openings = roofOpenings(geometry, withOpenings);
    expect(openings.problems).toEqual([]);

    const front = planeAt(geometry, { x: 0, z: -2.5 })!;
    const back = planeAt(geometry, { x: 0, z: 2.5 })!;
    // The dormer and one skylight are on the front slope, one on the back.
    expect(holesInPlane(front, openings)).toHaveLength(2);
    expect(holesInPlane(back, openings)).toHaveLength(1);
  });
});
