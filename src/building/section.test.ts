/**
 * Tests for the section geometry.
 *
 * A section is the drawing where a wrong answer is hardest to spot — a plausible
 * wall in the wrong place looks exactly like a correct one. So these are built
 * around a house whose dimensions are known exactly, and they check positions
 * rather than merely counting things.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, drawWall, normalizePlan } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import { buildSection, sectionFrame, toSection, toWorld } from './section';
import type { DesignDocument, SectionCut } from '@/state/types';

/**
 * A 12 × 8 house spanning x 0–12 and z 0–8, with a partition at x = 6.
 *
 * `addRectangle` takes the CENTRE, not a corner, so the centre is (6, 4). Get
 * that wrong and the partition lands outside the rectangle as a pair of
 * dangling walls enclosing nothing — which still produces a plan, still
 * produces one room, and quietly makes every assertion about position
 * meaningless.
 */
function house(): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  addRectangle(level.plan, { x: 6, z: 4 }, 12, 8);
  drawWall(level.plan, { x: 6, z: 0 }, { x: 6, z: 8 });
  normalizePlan(level.plan);

  findRegions(level.plan).forEach((region, index) => {
    level.plan.rooms[region.key] = {
      name: index === 0 ? 'Living Room' : 'Bedroom 1',
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  });

  return doc;
}

function cut(overrides: Partial<SectionCut> = {}): SectionCut {
  return {
    id: 'sec1',
    mark: 'A',
    name: 'Section A',
    // Straight across the house at z = 4, running past it at both ends.
    from: { x: -2, z: 4 },
    to: { x: 14, z: 4 },
    looks: 'left',
    automatic: false,
    ...overrides,
  };
}

describe('the section frame', () => {
  it('measures u from the start of the line', () => {
    const frame = sectionFrame(cut());
    expect(frame.length).toBeCloseTo(16, 6);
    expect(toSection(frame, { x: -2, z: 4 }).u).toBeCloseTo(0, 6);
    expect(toSection(frame, { x: 14, z: 4 }).u).toBeCloseTo(16, 6);
    expect(toSection(frame, { x: 6, z: 4 }).u).toBeCloseTo(8, 6);
  });

  it('puts the half being kept at positive depth, and flips with the direction', () => {
    /*
     * The whole of what `looks` means. The same cut through the same house
     * gives two completely different drawings depending which half is thrown
     * away, and getting it backwards is how a section ends up showing the
     * kitchen when it was drawn to show the stair.
     */
    const left = sectionFrame(cut({ looks: 'left' }));
    const right = sectionFrame(cut({ looks: 'right' }));

    const probe = { x: 6, z: 7 };
    expect(Math.sign(toSection(left, probe).depth)).toBe(
      -Math.sign(toSection(right, probe).depth),
    );
  });

  it('round-trips a point through section coordinates and back', () => {
    const frame = sectionFrame(cut({ from: { x: 1, z: 1 }, to: { x: 9, z: 7 } }));
    const original = { x: 5, z: 2 };
    const { u, depth } = toSection(frame, original);
    const back = toWorld(frame, u, depth);

    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.z).toBeCloseTo(original.z, 6);
  });

  it('survives a line with no length rather than dividing by zero', () => {
    const frame = sectionFrame(cut({ to: { x: -2, z: 4 } }));
    expect(frame.length).toBe(0);
    expect(Number.isFinite(toSection(frame, { x: 0, z: 0 }).u)).toBe(true);
  });
});

describe('cutting the walls', () => {
  it('cuts every wall the line crosses, and no others', () => {
    // Across the middle: the west wall, the partition, the east wall. The north
    // and south walls run parallel to the cut and are not cut by it.
    const model = buildSection(house(), cut());
    expect(model.walls).toHaveLength(3);
  });

  it('puts each cut wall where it actually is', () => {
    const model = buildSection(house(), cut());
    const middles = model.walls
      .map((wall) => (wall.span.from + wall.span.to) / 2)
      .sort((a, b) => a - b);

    // The line starts 2 m west of the house, so the walls are at u = 2, 8, 14.
    expect(middles[0]).toBeCloseTo(2, 1);
    expect(middles[1]).toBeCloseTo(8, 1);
    expect(middles[2]).toBeCloseTo(14, 1);
  });

  it('gives each cut wall the thickness it really has', () => {
    const model = buildSection(house(), cut());
    for (const wall of model.walls) {
      expect(wall.span.to - wall.span.from).toBeCloseTo(wall.thickness, 2);
    }
  });

  it('knows which cut walls are outside walls', () => {
    const model = buildSection(house(), cut());
    const sorted = [...model.walls].sort((a, b) => a.span.from - b.span.from);

    expect(sorted[0]!.exterior).toBe(true);
    expect(sorted[1]!.exterior).toBe(false); // The partition.
    expect(sorted[2]!.exterior).toBe(true);
  });

  it('draws the far half beyond and throws the near half away', () => {
    /*
     * A wall between the viewer and the cut is in the half the section removed.
     * Drawing it would show an enclosure the drawing says is not there.
     */
    const model = buildSection(house(), cut({ looks: 'left' }));
    const flipped = buildSection(house(), cut({ looks: 'right' }));

    expect(model.beyond.length).toBeGreaterThan(0);
    expect(flipped.beyond.length).toBeGreaterThan(0);

    // Every wall drawn beyond is genuinely behind the plane.
    for (const wall of [...model.beyond, ...flipped.beyond]) {
      expect(wall.depth).toBeGreaterThan(0);
    }

    // And the two directions do not report the same walls beyond.
    const ids = new Set(model.beyond.map((wall) => wall.wallId));
    const others = new Set(flipped.beyond.map((wall) => wall.wallId));
    expect([...ids].some((id) => !others.has(id))).toBe(true);
  });

  it('says so when the line misses the building entirely', () => {
    const model = buildSection(house(), cut({ from: { x: -5, z: 20 }, to: { x: 20, z: 20 } }));
    expect(model.walls).toHaveLength(0);
    expect(model.notes.join(' ')).toMatch(/does not pass through any wall/i);
  });
});

describe('cutting the openings', () => {
  it('cuts through a door the line passes through', () => {
    const doc = house();
    const level = doc.levels[0]!;
    // The partition runs from (6,0) to (6,8); a door at 4 m along it is at z = 4,
    // which is exactly where the cut crosses.
    const partition = level.plan.walls.find((wall) => {
      const vertices = level.plan.vertices;
      const a = vertices.find((v) => v.id === wall.start);
      const b = vertices.find((v) => v.id === wall.end);
      return a && b && Math.abs(a.x - 6) < 0.01 && Math.abs(b.x - 6) < 0.01;
    })!;
    addOpening(level.plan, partition.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 4);

    const model = buildSection(doc, cut());
    const inPartition = model.walls.find((wall) => wall.wallId === partition.id)!;

    expect(inPartition.openings).toHaveLength(1);
    expect(inPartition.openings[0]!.kind).toBe('door');
    expect(inPartition.openings[0]!.sill).toBeCloseTo(0, 6);
    expect(inPartition.openings[0]!.head).toBeCloseTo(2.04, 6);
  });

  it('does not cut through a door four metres away from the line', () => {
    /*
     * The bug this exists for. Projecting an opening into section coordinates
     * and testing the overlap there looks right and is wrong: every point of a
     * wall running square across the cut projects to almost the same u, so
     * every opening in it appeared to be on the cut. The test has to be made
     * along the wall.
     */
    const doc = house();
    const level = doc.levels[0]!;
    const partition = level.plan.walls.find((wall) => {
      const vertices = level.plan.vertices;
      const a = vertices.find((v) => v.id === wall.start);
      const b = vertices.find((v) => v.id === wall.end);
      return a && b && Math.abs(a.x - 6) < 0.01 && Math.abs(b.x - 6) < 0.01;
    })!;
    // A door near the north end, nowhere near the cut at z = 4.
    addOpening(level.plan, partition.id, 'door', 'door-single', { width: 0.9, height: 2.04, sillHeight: 0 }, 0.8);

    const model = buildSection(doc, cut());
    const inPartition = model.walls.find((wall) => wall.wallId === partition.id)!;

    expect(inPartition.openings).toHaveLength(0);
  });

  it('carries a window’s sill and head at their real heights', () => {
    const doc = house();
    const level = doc.levels[0]!;
    const west = level.plan.walls.find((wall) => {
      const vertices = level.plan.vertices;
      const a = vertices.find((v) => v.id === wall.start);
      const b = vertices.find((v) => v.id === wall.end);
      return a && b && Math.abs(a.x) < 0.01 && Math.abs(b.x) < 0.01;
    })!;
    addOpening(level.plan, west.id, 'window', 'window-casement', { width: 1.5, height: 1.4, sillHeight: 0.9 }, 4);

    const model = buildSection(doc, cut());
    const inWest = model.walls.find((wall) => wall.wallId === west.id)!;

    expect(inWest.openings).toHaveLength(1);
    expect(inWest.openings[0]!.sill).toBeCloseTo(0.9, 6);
    expect(inWest.openings[0]!.head).toBeCloseTo(2.3, 6);
  });
});

describe('cutting the floors', () => {
  it('spans the whole footprint, not just the rooms', () => {
    // A slab runs under the partitions. A section showing the floor stopping at
    // each internal wall would be nonsense.
    const model = buildSection(house(), cut());
    expect(model.floors).toHaveLength(1);

    const spans = model.floors[0]!.spans;
    expect(spans).toHaveLength(1);
    // The house runs from u = 2 to u = 14 on this cut, plus the wall thickness
    // either side.
    expect(spans[0]!.from).toBeLessThan(2.1);
    expect(spans[0]!.to).toBeGreaterThan(13.9);
  });

  it('gives a detached second building its own span', () => {
    const doc = house();
    const level = doc.levels[0]!;
    addRectangle(level.plan, { x: 18, z: 4 }, 6, 8);
    normalizePlan(level.plan);

    const model = buildSection(doc, cut({ from: { x: -2, z: 4 }, to: { x: 28, z: 4 } }));
    expect(model.floors[0]!.spans.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the extent', () => {
  it('reaches from the ground to the top of the building', () => {
    const doc = house();
    const model = buildSection(doc, cut());

    expect(model.extent.minU).toBe(0);
    expect(model.extent.maxU).toBeCloseTo(16, 6);
    expect(model.extent.maxY).toBeCloseTo(doc.levels[0]!.wallHeight, 1);
  });

  it('grows upward when a storey is added', () => {
    const doc = house();
    const one = buildSection(doc, cut()).extent.maxY;

    const ground = doc.levels[0]!;
    doc.levels.push({ ...structuredClone(ground), id: 'lv2', name: 'Second Floor' });

    expect(buildSection(doc, cut()).extent.maxY).toBeGreaterThan(one);
  });
});
