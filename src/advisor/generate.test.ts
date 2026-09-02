/**
 * Tests for the room generator.
 *
 * A generator has two ways to fail and only one of them is visible in a
 * screenshot. It can produce something ILLEGAL — furniture in a wall — which
 * the collision system already makes hard, or it can produce something legal
 * and STUPID: a sofa facing the wall, a bed under the window, chairs nowhere
 * near the table, a wardrobe blocking the door. The second failure looks
 * perfectly fine in a still image and is worthless as a starting point.
 *
 * So these tests check the arrangement, not just the fit: which way things
 * face, what they are next to, and how far apart they are. Where the advisor's
 * own rules already encode the right answer, the strongest check available is
 * to run them over the generated room and insist it does not fail its own
 * guidelines — a generator that produces layouts its own critic objects to is
 * two features arguing with each other.
 */

import { describe, expect, it } from 'vitest';

import { furnishRoom, suggestProgram } from './generate';
import { adviseDesign } from './advise';
import { describeItem, roleOf, type FurnitureRole } from './rooms';
import { edgeGap, forwardOf } from './geometry';
import { getCatalogEntry } from '@/furniture/catalog';
import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle } from '@/state/planOps';
import { collidersFor, itemFootprint } from '@/physics/colliders';
import { obbIntersects } from '@/physics/collision';
import { findRegions, pointInPolygon } from '@/scene/planGraph';
import { priceOf } from '@/furniture/pricing';
import type { DesignDocument, FurnitureItem } from '@/state/types';

/* -------------------------------- Fixtures ------------------------------ */

function roomDocument(width = 6, depth = 5): DesignDocument {
  const doc = createDefaultDocument();
  doc.plan.vertices = [];
  doc.plan.walls = [];
  doc.plan.rooms = {};
  addRectangle(doc.plan, { x: 0, z: 0 }, width, depth);
  return doc;
}

function onlyRoomKey(doc: DesignDocument): string {
  return findRegions(doc.plan)[0]!.key;
}

/** Adds a window to whichever wall lies at the given z. */
function windowAtZ(doc: DesignDocument, z: number, offset: number): void {
  const wall = doc.plan.walls.find((candidate) => {
    const start = doc.plan.vertices.find((v) => v.id === candidate.start)!;
    const end = doc.plan.vertices.find((v) => v.id === candidate.end)!;
    return Math.abs(start.z - z) < 0.01 && Math.abs(end.z - z) < 0.01;
  })!;
  addOpening(
    doc.plan,
    wall.id,
    'window',
    'window-picture',
    { width: 1.6, height: 1.2, sillHeight: 0.9 },
    offset,
  );
}

function rolesIn(doc: DesignDocument): Set<FurnitureRole> {
  return new Set(doc.furniture.map((item) => roleOf(getCatalogEntry(item.catalogId))));
}

function firstOfRole(doc: DesignDocument, role: FurnitureRole): FurnitureItem | undefined {
  return doc.furniture.find((item) => roleOf(getCatalogEntry(item.catalogId)) === role);
}

/** Nothing overlaps a wall or another piece, and everything is in a room. */
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
      `${item.catalogId} ended up outside every room`,
    ).toBe(true);
  }
}

/* ------------------------------- The basics ----------------------------- */

describe('furnishRoom', () => {
  it('produces a legal layout in an ordinary living room', () => {
    const doc = roomDocument(6, 5);
    const result = furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    expect(result.placed.length).toBeGreaterThan(3);
    expect(doc.furniture).toHaveLength(result.placed.length);
    expectLegalLayout(doc);
  });

  it('refuses gracefully when the room no longer exists', () => {
    const doc = roomDocument();
    const result = furnishRoom(doc, 'not-a-room', { program: 'living' });
    expect(result.placed).toEqual([]);
    expect(result.skipped[0]!.reason).toContain('no longer in the plan');
  });

  it('places nothing at all in a cupboard rather than forcing something in', () => {
    // 68 x 58 cm of usable floor: not even a POÄNG fits, and the right answer
    // is to leave the cupboard alone and say why.
    const doc = roomDocument(0.8, 0.7);
    const result = furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    expect(result.placed).toEqual([]);
    expect(doc.furniture).toEqual([]);
    expect(result.skipped[0]!.reason).toBe('no wall long enough');
  });

  it('scales the seating down rather than skipping a genuinely tiny room', () => {
    // 88 x 78 cm takes an armchair turned sideways and nothing more. Placing
    // the one piece that fits beats both an empty room and a wedged-in sofa.
    const doc = roomDocument(1.0, 0.9);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    expect(doc.furniture.length).toBeLessThanOrEqual(1);
    for (const item of doc.furniture) {
      expect(getCatalogEntry(item.catalogId).width).toBeLessThan(0.9);
    }
    expectLegalLayout(doc);
  });

  it('leaves the rest of the plan alone', () => {
    // Two rooms side by side; furnishing one must not touch the other.
    const doc = roomDocument(6, 5);
    addRectangle(doc.plan, { x: 12, z: 0 }, 6, 5);
    const regions = findRegions(doc.plan);
    const first = regions.find((region) => region.interiorPoint.x < 6)!;
    const second = regions.find((region) => region.interiorPoint.x > 6)!;

    furnishRoom(doc, first.key, { program: 'living' });

    for (const item of doc.furniture) {
      expect(pointInPolygon({ x: item.x, z: item.z }, second.polygon)).toBe(false);
    }
  });

  it('is deterministic', () => {
    // A generator that reshuffles on every press is a slot machine, not a
    // tool: the user cannot tell whether their change or the dice made the
    // difference.
    const a = roomDocument(6, 5);
    const b = roomDocument(6, 5);
    furnishRoom(a, onlyRoomKey(a), { program: 'living' });
    furnishRoom(b, onlyRoomKey(b), { program: 'living' });

    expect(a.furniture.map((item) => item.catalogId)).toEqual(
      b.furniture.map((item) => item.catalogId),
    );
    for (let i = 0; i < a.furniture.length; i++) {
      expect(a.furniture[i]!.x).toBeCloseTo(b.furniture[i]!.x, 9);
      expect(a.furniture[i]!.z).toBeCloseTo(b.furniture[i]!.z, 9);
    }
  });

  it('adds to a room by default and replaces it only when asked', () => {
    const doc = roomDocument(6, 5);
    doc.furniture.push({ id: 'keep', catalogId: 'lack-side', x: 2.4, z: 1.9, y: 0, rotation: 0 });

    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });
    expect(doc.furniture.some((item) => item.id === 'keep')).toBe(true);

    const result = furnishRoom(doc, onlyRoomKey(doc), {
      program: 'living',
      clearExisting: true,
    });
    expect(result.removed).toBeGreaterThan(0);
    expect(doc.furniture.some((item) => item.id === 'keep')).toBe(false);
  });
});

/* ------------------------------ Living rooms ---------------------------- */

describe('a generated living room', () => {
  it('puts a sofa, a table and a rug in it', () => {
    const doc = roomDocument(6, 5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    const roles = rolesIn(doc);
    expect(roles.has('sofa')).toBe(true);
    expect(roles.has('coffeeTable')).toBe(true);
    expect(roles.has('rug')).toBe(true);
  });

  it('sets the coffee table at the reach the guidelines name', () => {
    const doc = roomDocument(6, 5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    const sofa = firstOfRole(doc, 'sofa')!;
    const table = firstOfRole(doc, 'coffeeTable')!;
    const gap = edgeGap(itemFootprint(sofa), itemFootprint(table));

    expect(gap).toBeGreaterThanOrEqual(0.3);
    expect(gap).toBeLessThanOrEqual(0.45);
  });

  it('faces the sofa into the room rather than at the wall it stands on', () => {
    const doc = roomDocument(6, 5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    const sofa = firstOfRole(doc, 'sofa')!;
    const facing = forwardOf(sofa.rotation);
    const toCentre = { x: -sofa.x, z: -sofa.z };
    const span = Math.hypot(toCentre.x, toCentre.z);
    // The room is centred on the origin, so "towards the middle" is towards 0.
    expect((facing.x * toCentre.x + facing.z * toCentre.z) / span).toBeGreaterThan(0.7);
  });

  it('lays the rug so that EVERY seat stands on it', () => {
    /*
     * Not just the sofa. The generator used to place the rug immediately after
     * the sofa and add the armchair afterwards, which left the armchair off the
     * edge — and the advisor's own rug rule then reported "the rug is off to
     * one side of the seating" about a room the app had just built. The rug is
     * laid last for this reason, and this test is what holds it there.
     */
    const doc = roomDocument(6, 5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    const rug = firstOfRole(doc, 'rug')!;
    const seats = doc.furniture.filter((item) => {
      const role = roleOf(getCatalogEntry(item.catalogId));
      return role === 'sofa' || role === 'armchair';
    });
    expect(seats.length).toBeGreaterThanOrEqual(2);

    for (const seat of seats) {
      // A negative gap means they overlap, which for a rug is the point.
      expect(
        edgeGap(itemFootprint(rug), itemFootprint(seat)),
        `${seat.catalogId} is not standing on the rug`,
      ).toBeLessThan(-0.05);
    }

    // And the advisor agrees.
    const complaints = adviseDesign(doc).findings.filter(
      (found) => found.rule === 'rug-fit' && found.severity !== 'praise',
    );
    expect(complaints, complaints.map((f) => f.title).join('; ')).toHaveLength(0);
  });

  it('never chooses a piece its own scale rule would object to', () => {
    // "It fits" is not the same question as "it belongs". A 2.18 m sofa slides
    // along the wall of the starter room and leaves a corridor.
    for (const [width, depth] of [
      [4.2, 3.4],
      [6, 5],
      [8, 6],
    ] as const) {
      const doc = roomDocument(width, depth);
      furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

      const oversized = adviseDesign(doc).findings.filter((found) =>
        found.title.includes('large for this room'),
      );
      expect(
        oversized,
        `${width}x${depth}: ${oversized.map((f) => f.title).join('; ')}`,
      ).toHaveLength(0);
    }
  });

  it('drops to a smaller sofa in a small room rather than skipping it', () => {
    const small = roomDocument(3.6, 3.2);
    furnishRoom(small, onlyRoomKey(small), { program: 'living' });
    const sofa = firstOfRole(small, 'sofa');

    expect(sofa, 'a small room should still get some seating').toBeDefined();
    expect(getCatalogEntry(sofa!.catalogId).width).toBeLessThan(2.2);
  });
});

/* -------------------------------- Bedrooms ------------------------------ */

describe('a generated bedroom', () => {
  it('puts the bed against a wall with no window in it', () => {
    const doc = roomDocument(5, 4.4);
    // A window in the north wall — the bed must choose one of the other three.
    windowAtZ(doc, 2.2, 2.5);

    furnishRoom(doc, onlyRoomKey(doc), { program: 'bedroom' });
    expectLegalLayout(doc);

    const bed = firstOfRole(doc, 'bed');
    expect(bed).toBeDefined();

    // The advisor's own bed rule is the authority on this; if it objects to
    // the generator's choice, one of the two is wrong.
    const complaints = adviseDesign(doc).findings.filter(
      (found) => found.rule === 'bed-placement' && found.severity !== 'praise',
    );
    const placement = complaints.filter(
      (found) => found.id.endsWith('bed-window') || found.id.endsWith('bed-floating'),
    );
    expect(placement, placement.map((f) => f.title).join('; ')).toHaveLength(0);
  });

  it('flanks the bed with bedside tables at the head, not the foot', () => {
    const doc = roomDocument(5, 4.4);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'bedroom' });

    const bed = firstOfRole(doc, 'bed')!;
    const bedEntry = getCatalogEntry(bed.catalogId);
    const bedsides = doc.furniture.filter(
      (item) => roleOf(getCatalogEntry(item.catalogId)) === 'sideTable',
    );
    expect(bedsides.length).toBeGreaterThanOrEqual(1);

    const forward = forwardOf(bed.rotation);
    for (const table of bedsides) {
      // Project the table onto the bed's own front-to-back axis. Negative is
      // towards the headboard, which is where a bedside table belongs.
      const along = (table.x - bed.x) * forward.x + (table.z - bed.z) * forward.z;
      expect(along, 'a bedside table at the foot of the bed is a side table').toBeLessThan(
        -bedEntry.depth / 4,
      );
    }
  });

  it('does not put the wardrobe where it cannot be opened', () => {
    const doc = roomDocument(5, 4.4);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'bedroom' });
    expectLegalLayout(doc);

    const wardrobe = firstOfRole(doc, 'wardrobe');
    if (!wardrobe) return;

    // Nothing may stand in the space the doors need.
    const entry = getCatalogEntry(wardrobe.catalogId);
    const swing = entry.clearances?.find((spec) => spec.side === 'front');
    if (!swing) return;

    const forward = forwardOf(wardrobe.rotation);
    const zone = {
      center: {
        x: wardrobe.x + forward.x * (entry.depth / 2 + swing.depth / 2),
        z: wardrobe.z + forward.z * (entry.depth / 2 + swing.depth / 2),
      },
      halfWidth: entry.width / 2,
      halfDepth: swing.depth / 2,
      rotation: wardrobe.rotation,
    };

    for (const item of doc.furniture) {
      if (item.id === wardrobe.id) continue;
      if (getCatalogEntry(item.catalogId).layer === 'floor') continue;
      expect(
        obbIntersects(zone, itemFootprint(item)),
        `${item.catalogId} is standing in the wardrobe's door swing`,
      ).toBe(false);
    }
  });
});

/* ------------------------------ Dining rooms ---------------------------- */

describe('a generated dining room', () => {
  it('centres the table and sets chairs round it', () => {
    const doc = roomDocument(5, 4.5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'dining' });
    expectLegalLayout(doc);

    const table = firstOfRole(doc, 'diningTable');
    expect(table).toBeDefined();

    const chairs = doc.furniture.filter(
      (item) => roleOf(getCatalogEntry(item.catalogId)) === 'diningChair',
    );
    expect(chairs.length).toBeGreaterThanOrEqual(2);

    for (const chair of chairs) {
      // Every chair is at the table...
      expect(edgeGap(itemFootprint(table!), itemFootprint(chair))).toBeLessThan(0.35);

      // ...and looking at it.
      const facing = forwardOf(chair.rotation);
      const toTable = { x: table!.x - chair.x, z: table!.z - chair.z };
      const span = Math.hypot(toTable.x, toTable.z);
      expect((facing.x * toTable.x + facing.z * toTable.z) / span).toBeGreaterThan(0.6);
    }
  });

  it("satisfies the advisor's own dining rule", () => {
    const doc = roomDocument(5, 4.5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'dining' });

    const scatter = adviseDesign(doc).findings.filter((found) =>
      found.id.endsWith('dining-scatter'),
    );
    expect(scatter).toHaveLength(0);
  });
});

/* -------------------------------- Offices ------------------------------- */

describe('a generated workspace', () => {
  it('puts a desk and a chair in, with the chair at the desk', () => {
    const doc = roomDocument(4, 3.4);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'office' });
    expectLegalLayout(doc);

    const desk = firstOfRole(doc, 'desk');
    expect(desk).toBeDefined();

    const chair = firstOfRole(doc, 'taskChair');
    expect(chair).toBeDefined();
    expect(edgeGap(itemFootprint(desk!), itemFootprint(chair!))).toBeLessThan(0.4);
  });

  it('keeps the window off the screen axis', () => {
    // The one arrangement every ergonomics guide agrees on: daylight from the
    // side, not from in front of or behind the screen.
    const doc = roomDocument(4.4, 4);
    windowAtZ(doc, 2, 2.2);

    furnishRoom(doc, onlyRoomKey(doc), { program: 'office' });
    const desk = firstOfRole(doc, 'desk')!;

    const screen = forwardOf(desk.rotation);
    const toWindow = { x: 0 - desk.x, z: 2 - desk.z };
    const span = Math.hypot(toWindow.x, toWindow.z);
    const alignment = Math.abs((screen.x * toWindow.x + screen.z * toWindow.z) / span);

    // 1 would be dead ahead or dead behind; the generator should be well off it.
    expect(alignment).toBeLessThan(0.75);
  });
});

/* --------------------------------- Budget ------------------------------- */

describe('the budget', () => {
  it('stays under a ceiling', () => {
    const doc = roomDocument(6, 5);
    const result = furnishRoom(doc, onlyRoomKey(doc), { program: 'living', budget: 400 });

    expect(result.spend).toBeLessThanOrEqual(400);

    // And the reported figure matches what the shopping list would total.
    const total = doc.furniture.reduce(
      (sum, item) => sum + (priceOf(item).amount ?? 0),
      0,
    );
    expect(total).toBeCloseTo(result.spend, 6);
  });

  it('says what the budget cost, rather than silently doing less', () => {
    const doc = roomDocument(6, 5);
    const result = furnishRoom(doc, onlyRoomKey(doc), { program: 'living', budget: 250 });
    expect(result.skipped.some((entry) => entry.reason.includes('budget'))).toBe(true);
  });

  it('buys more with more money', () => {
    const lean = roomDocument(6, 5);
    const rich = roomDocument(6, 5);
    furnishRoom(lean, onlyRoomKey(lean), { program: 'living', budget: 500 });
    furnishRoom(rich, onlyRoomKey(rich), { program: 'living' });
    expect(rich.furniture.length).toBeGreaterThan(lean.furniture.length);
  });
});

/* --------------------------------- Style -------------------------------- */

describe('style', () => {
  it('changes the colours without changing the layout', () => {
    const calm = roomDocument(6, 5);
    const bold = roomDocument(6, 5);
    furnishRoom(calm, onlyRoomKey(calm), { program: 'living', style: 'calm' });
    furnishRoom(bold, onlyRoomKey(bold), { program: 'living', style: 'bold' });

    // Same pieces in the same places...
    expect(calm.furniture.map((item) => item.catalogId)).toEqual(
      bold.furniture.map((item) => item.catalogId),
    );
    // ...but the upholstery differs somewhere.
    const differs = calm.furniture.some(
      (item, index) => item.colorwayId !== bold.furniture[index]!.colorwayId,
    );
    expect(differs).toBe(true);
  });

  it('only ever names a colourway the product actually comes in', () => {
    const doc = roomDocument(6, 5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living', style: 'bold' });

    for (const item of doc.furniture) {
      if (!item.colorwayId) continue;
      const entry = getCatalogEntry(item.catalogId);
      expect(
        entry.colorways.some((colourway) => colourway.id === item.colorwayId),
        `${entry.name} does not come in "${item.colorwayId}"`,
      ).toBe(true);
    }
  });
});

/* -------------------------- Against its own critic ---------------------- */

describe('the generator against the advisor', () => {
  it('picks a program that suits the room size', () => {
    expect(suggestProgram(5)).toBe('office');
    expect(suggestProgram(9)).toBe('bedroom');
    expect(suggestProgram(24)).toBe('living');
  });

  it.each([
    ['living' as const, 6, 5],
    ['bedroom' as const, 5, 4.4],
    ['dining' as const, 5, 4.5],
    ['office' as const, 4.4, 4],
  ])('produces a %s the advisor does not object to', (program, width, depth) => {
    /*
     * The strongest check available: run the critic over the generator's own
     * output. The two halves of this session encode the same guidelines from
     * opposite directions, so a layout the generator produces and the advisor
     * calls critical means one of them has the rule wrong.
     *
     * Advisory notes are allowed — the generator cannot buy a second lamp it
     * has no budget line for, and a first draft is allowed to have notes on
     * it. What it may not do is produce something seriously wrong.
     */
    const doc = roomDocument(width, depth);
    furnishRoom(doc, onlyRoomKey(doc), { program });
    expectLegalLayout(doc);

    const report = adviseDesign(doc);
    const serious = report.findings.filter((found) => found.severity === 'critical');
    expect(serious, serious.map((found) => found.title).join('; ')).toHaveLength(0);

    // And it should land in a respectable band rather than merely avoiding
    // disaster: a generated room that scores badly is not a starting point.
    expect(report.score, `${program} scored ${report.score}`).toBeGreaterThanOrEqual(70);
  });

  it('keeps a room walkable, and only takes out what is in the way', () => {
    /*
     * The generator trims optional pieces until the route through the room
     * clears, and WHICH piece it takes out matters as much as that it does.
     *
     * Removing in plain importance order emptied half a 30 m² living room to
     * fix a pinch one bookcase was causing: the side table went first because
     * it mattered least, made no difference, then the lamp, then finally the
     * bookcase responsible. Three pieces gone to fix one problem. The trim now
     * tries each candidate and keeps the removal that actually helps.
     */
    const doc = roomDocument(6, 5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    // The route is clear...
    const squeeze = adviseDesign(doc).findings.filter((found) =>
      found.id.endsWith('circulation-tight'),
    );
    expect(squeeze, squeeze.map((f) => f.detail).join('; ')).toHaveLength(0);

    // ...and the room is still furnished rather than stripped back to the
    // anchor. A 30 m² living room that ends up with four pieces in it is not a
    // starting point anybody wants.
    expect(doc.furniture.length).toBeGreaterThanOrEqual(6);
  });

  it('never leaves a piece the advisor considers unreachable', () => {
    const doc = roomDocument(6, 5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });

    const marooned = adviseDesign(doc).findings.filter((found) =>
      found.id.endsWith('circulation-marooned'),
    );
    expect(marooned).toHaveLength(0);
  });

  it('describes everything it places', () => {
    // Every generated item must classify into a role, or the advisor is blind
    // to a piece its own generator put there.
    const doc = roomDocument(6, 5);
    furnishRoom(doc, onlyRoomKey(doc), { program: 'living' });
    for (const item of doc.furniture) {
      expect(describeItem(item).role).toBeTruthy();
    }
  });
});
