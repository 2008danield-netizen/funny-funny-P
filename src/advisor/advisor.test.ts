/**
 * Tests for the design advisor.
 *
 * The advisor is the part of this app most able to be confidently wrong, and
 * the part where being wrong costs the most: a collision bug is obvious the
 * moment you look at the screen, whereas a rule that quietly gives bad interior
 * advice is invisible until somebody has rearranged their actual living room on
 * the strength of it.
 *
 * So these tests are written around three questions:
 *
 *   1. Does a rule fire when it should, and stay QUIET when it should not? The
 *      second half matters more. A panel that cries wolf gets closed.
 *   2. Does every fix it offers actually apply? An Apply button that does
 *      nothing is experienced as the app being broken, not as advice being
 *      unavailable.
 *   3. Does applying a fix leave the design legal? Nothing the advisor does may
 *      produce a layout the user could not have dragged into place themselves.
 */

import { describe, expect, it } from 'vitest';

import { adviseDesign, bandFor, scoreFrom } from './advise';
import { applyFix } from './fixes';
import { FLOOR_SWATCHES } from './rules';
import { roleOf, inferProgram, describeItem } from './rooms';
import {
  angleBetween,
  axisAngleBetween,
  blankSpans,
  edgeGap,
  forwardOf,
  rotationFacing,
  roomWalls,
  tablePerimeterSlots,
} from './geometry';
import { contrast, hexToHsl, hslToHex, hueFamily, luminance, temperatureOf } from './colour';
import { CATALOG, getCatalogEntry } from '@/furniture/catalog';
import { createDefaultDocument } from '@/state/defaults';
import { addRectangle, addOpening } from '@/state/planOps';
import { collidersFor, itemFootprint } from '@/physics/colliders';
import { obbIntersects } from '@/physics/collision';
import { findRegions, pointInPolygon } from '@/scene/planGraph';
import type { DesignDocument, FurnitureItem } from '@/state/types';
import type { Finding } from './types';

/* -------------------------------- Fixtures ------------------------------ */

/** A document with one rectangular room, centred on the origin. */
function roomDocument(width = 6, depth = 5): DesignDocument {
  const doc = createDefaultDocument();
  doc.plan.vertices = [];
  doc.plan.walls = [];
  doc.plan.rooms = {};
  addRectangle(doc.plan, { x: 0, z: 0 }, width, depth);
  return doc;
}

/**
 * Puts a piece in the document at an exact spot, bypassing the solver.
 *
 * The tests need to construct SPECIFIC bad layouts — a sofa 3.4 m from an
 * armchair, a coffee table 90 cm out of reach — and `placeFurniture` would
 * helpfully nudge them somewhere legal, which is exactly what must not happen
 * when the point of the fixture is the distance.
 */
function put(
  doc: DesignDocument,
  catalogId: string,
  x: number,
  z: number,
  rotation = 0,
): FurnitureItem {
  const item: FurnitureItem = {
    id: `t${doc.furniture.length + 1}`,
    catalogId,
    x,
    z,
    y: 0,
    rotation,
  };
  doc.furniture.push(item);
  return item;
}

/** Every finding the advisor produces for a document. */
function findingsFor(doc: DesignDocument): Finding[] {
  return adviseDesign(doc).findings;
}

/** Findings from one named rule. */
function fromRule(doc: DesignDocument, rule: string): Finding[] {
  return findingsFor(doc).filter((found) => found.rule === rule);
}

/** Asserts nothing in the document overlaps a wall or another piece. */
function expectLegalLayout(doc: DesignDocument): void {
  const regions = findRegions(doc.plan);
  for (const item of doc.furniture) {
    const footprint = itemFootprint(item);
    for (const collider of collidersFor(doc.plan, doc.furniture, item.id)) {
      expect(
        obbIntersects(footprint, collider),
        `${item.catalogId} (${item.id}) overlaps ${collider.kind} ${collider.id}`,
      ).toBe(false);
    }
    expect(
      regions.some((region) => pointInPolygon({ x: item.x, z: item.z }, region.polygon)),
      `${item.catalogId} (${item.id}) ended up outside every room`,
    ).toBe(true);
  }
}

/* ------------------------------- Geometry ------------------------------- */

describe('advisor geometry', () => {
  it('agrees with the app about which way a piece faces', () => {
    // At rotation zero a piece faces +Z. This is the convention the builders,
    // the wall snapper and every rule depend on; if it ever flips, sofas end up
    // facing walls and the advisor confidently tells you to leave them there.
    expect(forwardOf(0).z).toBeCloseTo(1, 9);
    expect(forwardOf(0).x).toBeCloseTo(0, 9);

    // A quarter turn faces -X.
    expect(forwardOf(Math.PI / 2).x).toBeCloseTo(-1, 9);
  });

  it('round-trips a direction through rotationFacing', () => {
    for (const angle of [0, 0.4, 1.2, -2.1, Math.PI]) {
      const direction = forwardOf(angle);
      expect(angleBetween(rotationFacing(direction), angle)).toBeLessThan(1e-9);
    }
  });

  it('treats back-to-back pieces as parallel', () => {
    // Two sofas facing opposite ways are still aligned with the same wall, so
    // the alignment rule must not report them as 180 degrees out.
    expect(axisAngleBetween(0, Math.PI)).toBeCloseTo(0, 9);
    expect(axisAngleBetween(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('measures the gap between two boxes edge to edge', () => {
    const a = { center: { x: 0, z: 0 }, halfWidth: 1, halfDepth: 0.5, rotation: 0 };
    const b = { center: { x: 0, z: 2 }, halfWidth: 1, halfDepth: 0.5, rotation: 0 };
    // Centres are 2 m apart, each box reaches 0.5 m, so the gap is 1 m.
    expect(edgeGap(a, b)).toBeCloseTo(1, 6);

    // Overlapping boxes report a negative gap.
    const c = { center: { x: 0, z: 0.5 }, halfWidth: 1, halfDepth: 0.5, rotation: 0 };
    expect(edgeGap(a, c)).toBeLessThan(0);
  });

  it('finds the blank stretches of a wall with a door in it', () => {
    const doc = roomDocument(6, 5);
    const wall = doc.plan.walls[0]!;
    // A 0.9 m door two metres along a 6 m wall.
    addOpening(
      doc.plan,
      wall.id,
      'door',
      'door-single',
      { width: 0.9, height: 2.04, sillHeight: 0 },
      2,
    );

    const region = findRegions(doc.plan)[0]!;
    const roomWall = roomWalls(doc.plan, region).find(
      (candidate) => candidate.wallId === wall.id,
    )!;

    const spans = blankSpans(roomWall, 0.05, 0.3);
    expect(spans.length).toBe(2);
    // No span may overlap the door's own span.
    const door = wall.openings[0]!;
    for (const span of spans) {
      const overlaps =
        span.from < door.offset + door.width / 2 && span.to > door.offset - door.width / 2;
      expect(overlaps).toBe(false);
    }
  });

  it('spaces table chairs evenly and faces every one of them inwards', () => {
    const table = { center: { x: 0, z: 0 }, halfWidth: 0.6, halfDepth: 0.4, rotation: 0 };
    const slots = tablePerimeterSlots(table, 0.26);

    // A 1.2 m table takes two per long side; at 0.8 m deep the ends are too
    // shallow to seat anybody, so four in total.
    expect(slots).toHaveLength(4);

    for (const slot of slots) {
      const facing = forwardOf(slot.rotation);
      /*
       * A chair at a place setting faces SQUARE ON to the edge it sits at, not
       * at the middle of the table — a diner at the corner of a long side does
       * not sit skewed towards the centrepiece. So the test is that the chair
       * looks straight across the edge it is at: the table is axis-aligned
       * here, so a long-side chair faces purely along Z, towards z = 0.
       */
      expect(Math.abs(facing.x)).toBeLessThan(1e-9);
      expect(Math.sign(facing.z)).toBe(-Math.sign(slot.at.z));
      // And it is beyond the table's own edge rather than on top of it.
      expect(Math.abs(slot.at.z)).toBeGreaterThan(table.halfDepth);
    }
  });
});

/* --------------------------------- Colour ------------------------------- */

describe('colour analysis', () => {
  it('round-trips hex through HSL', () => {
    for (const hex of ['#b9755c', '#2f3b4d', '#f4f2ee', '#000000', '#ffffff']) {
      expect(hslToHex(hexToHsl(hex))).toBe(hex);
    }
  });

  it('uses perceived luminance, not HSL lightness', () => {
    /*
     * The whole point of using relative luminance: pure yellow and pure blue
     * have identical HSL lightness (0.5) and are nowhere near equally bright.
     * If this ever regresses to HSL L, the contrast rule starts approving a
     * navy floor under a yellow wall as low contrast, which is the opposite of
     * the truth.
     */
    expect(hexToHsl('#ffff00').l).toBeCloseTo(hexToHsl('#0000ff').l, 6);
    expect(luminance('#ffff00')).toBeGreaterThan(luminance('#0000ff') + 0.5);
  });

  it('calls a near-neutral colour neutral rather than warm', () => {
    // An off-white technically has a hue; advising somebody about it would be
    // advising them about a colour nobody can see.
    expect(temperatureOf('#f4f2ee')).toBe('neutral');
    expect(temperatureOf('#b9755c')).toBe('warm');
    expect(temperatureOf('#6a7f96')).toBe('cool');
  });

  it('groups colours into families coarsely enough to be useful', () => {
    // Rust and terracotta are one scheme, not two colours.
    expect(hueFamily('#a4614a')).toBe(hueFamily('#b9755c'));
    expect(hueFamily('#93a089')).toBe('green');
    expect(hueFamily('#3d4c63')).toBe('blue');
  });

  it('reports no contrast between a colour and itself', () => {
    expect(contrast('#b9755c', '#b9755c')).toBeCloseTo(0, 9);
  });

  it('keeps the floor swatch table in step with the material presets', async () => {
    /*
     * `rules.ts` duplicates each floor preset's swatch colour so the advisor
     * stays free of Three.js and can run under Node. Duplication is a debt; this
     * test is the interest payment. If a preset is added, renamed or recoloured
     * and the advisor's copy is not updated, this fails rather than the advisor
     * silently judging every wall against the wrong floor.
     */
    const { FLOOR_PRESETS } = await import('@/scene/materials/presets');

    for (const preset of FLOOR_PRESETS) {
      expect(
        FLOOR_SWATCHES[preset.id],
        `advisor is missing a swatch for the "${preset.id}" floor preset`,
      ).toBe(preset.swatchColor);
    }
    expect(Object.keys(FLOOR_SWATCHES)).toHaveLength(FLOOR_PRESETS.length);
  });
});

/* ---------------------------------- Roles ------------------------------- */

describe('furniture roles', () => {
  it('classifies every catalogue entry without throwing', () => {
    for (const entry of CATALOG) {
      expect(typeof roleOf(entry)).toBe('string');
    }
  });

  it('tells a wardrobe from a television unit from a chest', () => {
    // All three are `cabinet` builds; only their dimensions separate them.
    expect(roleOf(getCatalogEntry('pax-150'))).toBe('wardrobe');
    expect(roleOf(getCatalogEntry('besta-tv'))).toBe('tvUnit');
    expect(roleOf(getCatalogEntry('malm-chest-6'))).toBe('chest');
    expect(roleOf(getCatalogEntry('alex-drawers'))).toBe('drawerUnit');
  });

  it('tells a coffee table from a dining table by its height', () => {
    expect(roleOf(getCatalogEntry('lack-coffee'))).toBe('coffeeTable');
    expect(roleOf(getCatalogEntry('lack-side'))).toBe('sideTable');
    expect(roleOf(getCatalogEntry('ekedalen-table'))).toBe('diningTable');
  });

  it('reads a bed as a bedroom even when a sofa is also present', () => {
    // Studio flats are real. The bed wins because it is the piece the rest of
    // the layout has to work around.
    const doc = roomDocument(8, 7);
    put(doc, 'malm-bed-140', 0, 0);
    put(doc, 'klippan-2', 2, 2);
    expect(inferProgram(doc.furniture.map(describeItem))).toBe('bedroom');
  });

  it('needs chairs before it calls a room a dining room', () => {
    const doc = roomDocument();
    put(doc, 'ekedalen-table', 0, 0);
    put(doc, 'ingolf-chair', 0, 0.8);
    put(doc, 'ingolf-chair', 0, -0.8);
    expect(inferProgram(doc.furniture.map(describeItem))).toBe('dining');
  });
});

/* ---------------------------------- Rules ------------------------------- */

describe('the empty-room rule', () => {
  it('offers to furnish an empty room', () => {
    const found = fromRule(roomDocument(5, 4), 'empty-room');
    expect(found).toHaveLength(1);
    expect(found[0]!.fix?.kind).toBe('furnish');
  });

  it('says nothing about a cupboard', () => {
    // Under 4 m² is a hallway or a store, and telling somebody to furnish it
    // would be the panel talking for the sake of it.
    expect(fromRule(roomDocument(1.6, 1.6), 'empty-room')).toHaveLength(0);
  });

  it('goes quiet the moment anything is placed', () => {
    const doc = roomDocument(5, 4);
    put(doc, 'lack-coffee', 0, 0);
    expect(fromRule(doc, 'empty-room')).toHaveLength(0);
  });
});

describe('the focal-point rule', () => {
  /** A living room with the sofa on the south wall facing north (+Z is north). */
  function livingRoom(sofaRotation: number): DesignDocument {
    const doc = roomDocument(6, 5);
    put(doc, 'kivik-3', 0, -1.9, sofaRotation);
    put(doc, 'besta-tv', 0, 2.2, Math.PI);
    return doc;
  }

  it('flags a sofa with its back to the television', () => {
    const found = fromRule(livingRoom(Math.PI), 'seating-focal');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('critical');
    expect(found[0]!.fix?.kind).toBe('rotate');
  });

  it('praises a sofa that faces it', () => {
    const found = fromRule(livingRoom(0), 'seating-focal');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('praise');
  });

  it('turns the sofa the right way when the fix is applied', () => {
    const doc = livingRoom(Math.PI);
    const fix = fromRule(doc, 'seating-focal')[0]!.fix!;
    expect(applyFix(doc, fix).applied).toBe(true);

    // After the fix, the rule must be satisfied — an advisor whose own fix does
    // not clear its own finding is arguing with itself.
    const after = fromRule(doc, 'seating-focal');
    expect(after[0]!.severity).toBe('praise');
    expectLegalLayout(doc);
  });

  it('says nothing in a room with no focal point at all', () => {
    // No television and no window: there is nothing to face, so an opinion
    // about which way the sofa points would be invented.
    const doc = roomDocument(6, 5);
    put(doc, 'kivik-3', 0, -1.9, 0);
    expect(fromRule(doc, 'seating-focal')).toHaveLength(0);
  });
});

describe('the coffee-table rule', () => {
  function withGap(gap: number): DesignDocument {
    const doc = roomDocument(6, 5);
    const sofa = getCatalogEntry('kivik-3');
    const table = getCatalogEntry('lisabo-coffee');
    put(doc, 'kivik-3', 0, -1.9, 0);
    // The sofa faces +Z, so the table goes that far in front of its front face.
    put(doc, 'lisabo-coffee', 0, -1.9 + sofa.depth / 2 + gap + table.depth / 2, 0);
    return doc;
  }

  it('praises a table at a comfortable reach', () => {
    const found = fromRule(withGap(0.38), 'coffee-table-reach');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('praise');
  });

  it('flags one you would have to stand up to reach', () => {
    const found = fromRule(withGap(0.95), 'coffee-table-reach');
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toContain('out of reach');
    expect(found[0]!.detail).toContain('95 cm');
  });

  it('flags one crowding the sofa', () => {
    const found = fromRule(withGap(0.14), 'coffee-table-reach');
    expect(found[0]!.title).toContain('crowding');
  });

  it('moves it into range when the fix is applied', () => {
    const doc = withGap(0.95);
    const fix = fromRule(doc, 'coffee-table-reach')[0]!.fix!;
    expect(applyFix(doc, fix).applied).toBe(true);

    expect(fromRule(doc, 'coffee-table-reach')[0]!.severity).toBe('praise');
    expectLegalLayout(doc);
  });
});

describe('the conversation-group rule', () => {
  it('flags seats too far apart to talk across', () => {
    const doc = roomDocument(8, 7);
    put(doc, 'kivik-3', 0, -2.8, 0);
    put(doc, 'strandmon', 0, 2.6, Math.PI);

    const found = fromRule(doc, 'conversation-group');
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toContain('too far apart');
  });

  it('praises a group within talking distance', () => {
    const doc = roomDocument(8, 7);
    put(doc, 'kivik-3', 0, -1.2, 0);
    put(doc, 'strandmon', 1.3, 0.6, -2.2);

    expect(fromRule(doc, 'conversation-group')[0]!.severity).toBe('praise');
  });

  it('says nothing about a single seat', () => {
    const doc = roomDocument(6, 5);
    put(doc, 'kivik-3', 0, -1.9, 0);
    expect(fromRule(doc, 'conversation-group')).toHaveLength(0);
  });

  it('pulls the chair in when the fix is applied', () => {
    const doc = roomDocument(8, 7);
    put(doc, 'kivik-3', 0, -2.8, 0);
    const chair = put(doc, 'strandmon', 0, 2.6, Math.PI);

    const fix = fromRule(doc, 'conversation-group')[0]!.fix;
    // The fix is only offered when the target position validates; if it was
    // offered, applying it must both work and satisfy the rule.
    if (fix) {
      expect(applyFix(doc, fix).applied).toBe(true);
      const moved = doc.furniture.find((item) => item.id === chair.id)!;
      expect(Math.hypot(moved.x - 0, moved.z + 2.8)).toBeLessThan(2.75);
      expectLegalLayout(doc);
    }
  });
});

describe('the bed rule', () => {
  it('flags a bed under a window and moves it to a blank wall', () => {
    const doc = roomDocument(4.4, 4);
    // A window in the north wall, then a bed with its headboard against it.
    const northWall = doc.plan.walls.find((wall) => {
      const start = doc.plan.vertices.find((v) => v.id === wall.start)!;
      const end = doc.plan.vertices.find((v) => v.id === wall.end)!;
      return Math.abs(start.z - 2) < 0.01 && Math.abs(end.z - 2) < 0.01;
    })!;
    addOpening(
      doc.plan,
      northWall.id,
      'window',
      'window-picture',
      { width: 1.6, height: 1.2, sillHeight: 0.9 },
      2.2,
    );

    const bed = getCatalogEntry('malm-bed-140');
    // Headboard to the north wall means the bed faces south (-Z).
    put(doc, 'malm-bed-140', 0, 2 - 0.05 - bed.depth / 2, Math.PI);

    const found = fromRule(doc, 'bed-placement').filter(
      (item) => item.id.endsWith('bed-window'),
    );
    expect(found).toHaveLength(1);

    const fix = found[0]!.fix;
    expect(fix, 'a room this size has three other walls; a fix should exist').not.toBeNull();
    expect(applyFix(doc, fix!).applied).toBe(true);
    expectLegalLayout(doc);

    // And the complaint is gone.
    expect(
      fromRule(doc, 'bed-placement').filter((item) => item.id.endsWith('bed-window')),
    ).toHaveLength(0);
  });

  it('flags a bed floating in the middle of the room', () => {
    const doc = roomDocument(5, 5);
    put(doc, 'malm-bed-140', 0, 0, 0);

    const found = fromRule(doc, 'bed-placement').filter((item) =>
      item.id.endsWith('bed-floating'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.fix?.kind).toBe('move');
  });

  it('praises a bed against a solid wall', () => {
    const doc = roomDocument(4.4, 4);
    const bed = getCatalogEntry('malm-bed-140');
    put(doc, 'malm-bed-140', 0, 2 - 0.05 - bed.depth / 2, Math.PI);

    const found = fromRule(doc, 'bed-placement').filter((item) =>
      item.id.endsWith('bed-good'),
    );
    expect(found).toHaveLength(1);
  });
});

describe('the dining rule', () => {
  it('sets scattered chairs round the table', () => {
    const doc = roomDocument(6, 5);
    put(doc, 'ekedalen-table', 0, 0, 0);
    // Four chairs shoved against the walls, as a room looks before people sit.
    put(doc, 'ingolf-chair', -2.4, -1.9, 0);
    put(doc, 'ingolf-chair', -2.4, -1.2, 0);
    put(doc, 'ingolf-chair', 2.4, -1.9, 0);
    put(doc, 'ingolf-chair', 2.4, -1.2, 0);

    const found = fromRule(doc, 'dining');
    const scatter = found.find((item) => item.id.endsWith('dining-scatter'));
    expect(scatter, 'four chairs against the walls should be reported').toBeDefined();

    const fix = scatter!.fix;
    expect(fix?.kind).toBe('moveMany');
    expect(applyFix(doc, fix!).applied).toBe(true);
    expectLegalLayout(doc);

    // Every chair now sits at the table.
    const table = doc.furniture.find((item) => item.catalogId === 'ekedalen-table')!;
    for (const chair of doc.furniture.filter((item) => item.catalogId === 'ingolf-chair')) {
      expect(edgeGap(itemFootprint(table), itemFootprint(chair))).toBeLessThan(0.5);
    }
  });

  it('praises a table that is already laid', () => {
    const doc = roomDocument(6, 5);
    put(doc, 'ekedalen-table', 0, 0, 0);
    const table = getCatalogEntry('ekedalen-table');
    const chair = getCatalogEntry('ingolf-chair');
    const offset = table.depth / 2 + chair.depth / 2 + 0.02;
    put(doc, 'ingolf-chair', -0.3, -offset, 0);
    put(doc, 'ingolf-chair', 0.3, -offset, 0);
    put(doc, 'ingolf-chair', -0.3, offset, Math.PI);
    put(doc, 'ingolf-chair', 0.3, offset, Math.PI);

    const found = fromRule(doc, 'dining');
    expect(found.some((item) => item.id.endsWith('dining-good'))).toBe(true);
    expect(found.some((item) => item.id.endsWith('dining-scatter'))).toBe(false);
  });
});

describe('the alignment rule', () => {
  it('flags a piece a few degrees off square', () => {
    const doc = roomDocument(6, 5);
    // Four degrees out: near enough to read as a mistake.
    put(doc, 'billy-80', 0, -1.9, (4 * Math.PI) / 180);

    const found = fromRule(doc, 'alignment');
    expect(found).toHaveLength(1);
    expect(found[0]!.fix?.kind).toBe('rotate');
  });

  it('leaves a deliberately angled piece alone', () => {
    const doc = roomDocument(6, 5);
    // Thirty degrees is obviously on purpose.
    put(doc, 'billy-80', 0, -1.5, (30 * Math.PI) / 180);
    expect(fromRule(doc, 'alignment')).toHaveLength(0);
  });

  it('squares it up without spinning it round', () => {
    const doc = roomDocument(6, 5);
    const shelf = put(doc, 'billy-80', 0, -1.9, (4 * Math.PI) / 180);

    const fix = fromRule(doc, 'alignment')[0]!.fix!;
    expect(applyFix(doc, fix).applied).toBe(true);

    // The bookcase must not have been turned to face the wall it stands against.
    const after = doc.furniture.find((item) => item.id === shelf.id)!;
    expect(angleBetween(after.rotation, (4 * Math.PI) / 180)).toBeLessThan(0.2);
    expect(fromRule(doc, 'alignment')).toHaveLength(0);
  });

  it('never lists more than three at once', () => {
    const doc = roomDocument(8, 7);
    for (let i = 0; i < 6; i++) {
      put(doc, 'lack-side', -3 + i * 1.1, -3, (3 * Math.PI) / 180);
    }
    expect(fromRule(doc, 'alignment').length).toBeLessThanOrEqual(3);
  });
});

describe('the lighting rule', () => {
  it('notices a furnished room with no lamp', () => {
    const doc = roomDocument(6, 5);
    put(doc, 'kivik-3', 0, -1.9, 0);
    put(doc, 'lisabo-coffee', 0, -0.5, 0);

    const found = fromRule(doc, 'lighting-layers');
    expect(found).toHaveLength(1);
    expect(found[0]!.fix?.kind).toBe('add');
  });

  it('adds a lamp somewhere legal when the fix is applied', () => {
    const doc = roomDocument(6, 5);
    put(doc, 'kivik-3', 0, -1.9, 0);
    put(doc, 'lisabo-coffee', 0, -0.5, 0);

    const before = doc.furniture.length;
    const fix = fromRule(doc, 'lighting-layers')[0]!.fix!;
    expect(applyFix(doc, fix).applied).toBe(true);
    expect(doc.furniture).toHaveLength(before + 1);
    expectLegalLayout(doc);
  });

  it('says nothing about an empty room', () => {
    // The lighting rule must not be the reason an untouched room scores badly.
    expect(fromRule(roomDocument(6, 5), 'lighting-layers')).toHaveLength(0);
  });
});

describe('the palette rule', () => {
  it('flags walls and floor at the same brightness, and offers a repaint', () => {
    const doc = roomDocument(6, 5);
    put(doc, 'kivik-3', 0, -1.9, 0);

    const key = findRegions(doc.plan)[0]!.key;
    // Oak plank reads around #b98b57; paint the walls to match it.
    doc.plan.rooms[key] = {
      ...doc.plan.defaultRoom,
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 2 },
      wall: { color: '#b98b57', roughness: 0.9 },
    };

    const found = fromRule(doc, 'palette').filter((item) =>
      item.id.endsWith('colour-contrast'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.fix?.kind).toBe('paint');

    expect(applyFix(doc, found[0]!.fix!).applied).toBe(true);
    // The repaint must actually resolve the complaint it was offered for.
    expect(
      fromRule(doc, 'palette').filter((item) => item.id.endsWith('colour-contrast')),
    ).toHaveLength(0);
  });

  it('keeps the wall finish the user chose when it repaints', () => {
    const doc = roomDocument(6, 5);
    const key = findRegions(doc.plan)[0]!.key;
    doc.plan.rooms[key] = {
      ...doc.plan.defaultRoom,
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 2 },
      wall: { color: '#b98b57', roughness: 0.55 },
    };

    const fix = fromRule(doc, 'palette').find((item) =>
      item.id.endsWith('colour-contrast'),
    )!.fix!;
    applyFix(doc, fix);
    expect(doc.plan.rooms[key]!.wall.roughness).toBeCloseTo(0.55, 6);
  });

  it('does not complain about the starter room', () => {
    // The colours the app ships with must not fail its own advice on load. If
    // this ever fails, either the defaults or the rule needs changing — and
    // greeting a new user with a complaint about a room they did not choose is
    // not the answer.
    const doc = roomDocument(6, 5);
    expect(fromRule(doc, 'palette')).toHaveLength(0);
  });
});

/* ------------------------------ Score & report -------------------------- */

describe('the score', () => {
  it('gives a clean design full marks', () => {
    expect(scoreFrom([])).toBe(100);
  });

  it('ignores praise', () => {
    const praise: Finding = {
      id: 'p',
      rule: 'r',
      category: 'focal',
      severity: 'praise',
      title: '',
      detail: '',
      why: '',
      roomKey: null,
      focus: null,
      at: null,
      weight: 0,
      fix: null,
    };
    expect(scoreFrom([praise, praise, praise])).toBe(100);
  });

  it('never lets small notes alone sink a room', () => {
    /*
     * Twenty polish notes is a furnished room somebody has not tidied, not a
     * disaster. A linear score would put it below zero; the softened curve
     * keeps it in the "fair" band, which is what it actually is.
     */
    const note = (n: number): Finding => ({
      id: `n${n}`,
      rule: 'r',
      category: 'alignment',
      severity: 'polish',
      title: '',
      detail: '',
      why: '',
      roomKey: null,
      focus: null,
      at: null,
      weight: 2,
      fix: null,
    });
    const many = Array.from({ length: 20 }, (_, i) => note(i));
    expect(scoreFrom(many)).toBeGreaterThanOrEqual(55);
  });

  it('lets one critical finding outweigh a pile of polish', () => {
    const polish: Finding = {
      id: 'p',
      rule: 'r',
      category: 'alignment',
      severity: 'polish',
      title: '',
      detail: '',
      why: '',
      roomKey: null,
      focus: null,
      at: null,
      weight: 2,
      fix: null,
    };
    const critical: Finding = { ...polish, id: 'c', severity: 'critical', weight: 14 };

    // Five small notes against one thing you cannot walk to: the second is worse.
    const withNotes = scoreFrom([polish, polish, polish, polish, polish]);
    const withCritical = scoreFrom([critical]);
    expect(withCritical).toBeLessThan(withNotes);
  });

  it('bands the score the way the panel colours it', () => {
    expect(bandFor(100)).toBe('excellent');
    expect(bandFor(80)).toBe('good');
    expect(bandFor(60)).toBe('fair');
    expect(bandFor(30)).toBe('needs-work');
  });
});

describe('the report as a whole', () => {
  it('survives a design with no rooms at all', () => {
    const doc = createDefaultDocument();
    doc.plan.vertices = [];
    doc.plan.walls = [];
    doc.plan.rooms = {};
    const report = adviseDesign(doc);
    expect(report.findings).toEqual([]);
    expect(report.score).toBe(100);
  });

  it('puts the worst findings first', () => {
    const doc = roomDocument(6, 5);
    put(doc, 'kivik-3', 0, -1.9, Math.PI);
    put(doc, 'besta-tv', 0, 2.2, Math.PI);
    put(doc, 'billy-80', -2, 0, (4 * Math.PI) / 180);

    const order = ['critical', 'improve', 'polish', 'praise'];
    const ranks = adviseDesign(doc).findings.map((found) => order.indexOf(found.severity));
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
    }
  });

  it('gives every room a summary', () => {
    const doc = roomDocument(6, 5);
    const report = adviseDesign(doc);
    expect(report.rooms).toHaveLength(1);
    expect(report.rooms[0]!.area).toBeCloseTo(findRegions(doc.plan)[0]!.area, 6);
  });

  it('offers no fix it cannot honour', () => {
    /*
     * The contract that matters most: every Apply button in the panel does
     * something. This walks a deliberately awkward layout, applies every fix
     * the advisor offers one at a time from a fresh copy, and insists each one
     * both succeeds and leaves the design legal.
     */
    const build = (): DesignDocument => {
      const doc = roomDocument(7, 6);
      // A sofa with its back to the television, a coffee table a shade out of
      // square, an armchair marooned in the far corner, and a bookcase three
      // degrees off the west wall.
      put(doc, 'kivik-3', 0, -2.4, Math.PI);
      put(doc, 'besta-tv', 0, 2.7, Math.PI);
      put(doc, 'lisabo-coffee', 0, 1.2, 0.06);
      put(doc, 'strandmon', 2.6, 2.0, 0);
      put(doc, 'billy-80', -3.27, 0, -Math.PI / 2 + (3 * Math.PI) / 180);
      return doc;
    };

    // `put` bypasses the solver, so an awkward fixture can accidentally be an
    // ILLEGAL one — and then every fix below fails for a reason that has
    // nothing to do with the advisor. Check the starting point first, so a bad
    // fixture is reported as a bad fixture.
    expectLegalLayout(build());

    const fixes = findingsFor(build())
      .map((found) => found.fix)
      .filter((fix): fix is NonNullable<typeof fix> => fix !== null && fix.kind !== 'furnish');

    expect(fixes.length).toBeGreaterThan(2);

    for (const fix of fixes) {
      const doc = build();
      const result = applyFix(doc, fix);
      expect(result.applied, `"${fix.label}" was offered but would not apply`).toBe(true);
      expectLegalLayout(doc);
    }
  });
});
