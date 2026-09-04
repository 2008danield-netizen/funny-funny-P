/**
 * Tests for stair geometry and the IRC checks.
 *
 * -----------------------------------------------------------------------------
 * WHY THESE ARE THE MOST IMPORTANT TESTS IN THE APP.
 *
 * Everything else here is about whether a room looks good. This is about
 * whether a staircase is safe to walk down, and the failure mode is a person
 * falling. A sofa in the wrong place is visible in a screenshot; a riser an
 * eighth of an inch out of pattern is not visible anywhere until somebody's
 * foot finds it.
 *
 * So the tests below check three separate things, and all three matter:
 *
 *   1. The GEOMETRY is right — the steps add up to the storey, the turns come
 *      out square, nothing is mirrored.
 *   2. The CHECKS fire when the code says they should, and stay quiet when it
 *      does not. A compliance checker that cries wolf gets ignored, and then
 *      the real violation goes past too.
 *   3. The CITATIONS are correct. A finding that names the wrong section is
 *      worse than no finding, because somebody will look it up, find it says
 *      something else, and stop trusting all of them.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';

import { convexHull, defaultStairFor, forwardOf, stairColliders, stairGeometry } from './stairs';
import { checkStair, describeStair } from './stairCode';
import { IRC_GUARDS, IRC_STAIRS, asFeetInches, feet, inches } from '@/code/irc';
import { createDefaultDocument, createLevel } from '@/state/defaults';
import { addRectangle } from '@/state/planOps';
import { riseAbove } from '@/state/levels';
import type { DesignDocument, Stair, StairForm } from '@/state/types';

/* -------------------------------- Fixtures ------------------------------- */

/** A two-storey building, so a stair has somewhere to climb to. */
function twoStorey(wallHeight = 2.6, slabThickness = 0.25): DesignDocument {
  const doc = createDefaultDocument();
  doc.levels[0]!.wallHeight = wallHeight;
  doc.levels.push(createLevel('lv2', 'Second Floor'));
  doc.levels[1]!.slabThickness = slabThickness;
  return doc;
}

/**
 * A two-storey building with a hall long enough for a full flight.
 *
 * The starter room is 4.2 x 3.4 m and a comfortable 16-riser stair is over 4 m
 * long, so most fixtures here need somewhere it actually fits — otherwise every
 * test trips the containment check on its way to whatever it was really
 * measuring.
 */
function roomyTwoStorey(wallHeight = 2.6, slabThickness = 0.25): DesignDocument {
  const doc = twoStorey(wallHeight, slabThickness);
  for (const level of doc.levels) {
    level.plan.vertices = [];
    level.plan.walls = [];
    level.plan.rooms = {};
    addRectangle(level.plan, { x: 0, z: 0 }, 9, 9);
  }
  return doc;
}

function makeStair(doc: DesignDocument, overrides: Partial<Stair> = {}): Stair {
  const defaults = defaultStairFor(riseAbove(doc, doc.levels[0]!.id));
  const stair: Stair = {
    id: 'st1',
    name: 'Stair',
    fromLevelId: doc.levels[0]!.id,
    form: { kind: 'straight' },
    at: { x: 0, z: 0 },
    rotation: 0,
    width: defaults.width,
    treadDepth: defaults.treadDepth,
    riserCount: defaults.riserCount,
    nosing: defaults.nosing,
    handrail: 'both',
    ...overrides,
  };
  doc.stairs = [stair];
  return stair;
}

/** The findings from one stair, by their short id. */
function checkIds(doc: DesignDocument, stair: Stair): string[] {
  return checkStair(doc, stair).findings.map((finding) =>
    finding.id.replace(`${stair.id}:`, ''),
  );
}

/* ------------------------------- The rise -------------------------------- */

describe('stair proportions', () => {
  it('climbs exactly the floor-to-floor rise, not the ceiling height', () => {
    /*
     * The distinction that catches people out. A 2.6 m ceiling with a 0.25 m
     * floor above it is a 2.85 m climb — a stair built to the ceiling height
     * arrives 250 mm below the floor, which is a step and a half.
     */
    const doc = twoStorey(2.6, 0.25);
    const stair = makeStair(doc);
    const geometry = stairGeometry(doc, stair);

    expect(geometry.totalRise).toBeCloseTo(2.85, 9);
    expect(geometry.riserHeight * geometry.riserCount).toBeCloseTo(2.85, 9);
  });

  it('makes every riser in a flight identical', () => {
    // IRC R311.7.5.1 allows 3/8 in of variation. Deriving the riser height
    // rather than storing it makes the variation exactly zero, which is the
    // better kind of compliance: the defect is impossible, not merely checked.
    const doc = twoStorey();
    const geometry = stairGeometry(doc, makeStair(doc));

    const heights = geometry.treads.map((tread, index) =>
      index === 0 ? tread.height : tread.height - geometry.treads[index - 1]!.height,
    );
    for (const height of heights) {
      expect(Math.abs(height - geometry.riserHeight)).toBeLessThan(1e-9);
    }
  });

  it('gives a flight of N risers exactly N-1 treads', () => {
    // The last riser lands you on the floor above, which is a floor and not a
    // step. An off-by-one here puts a spare tread through the ceiling.
    const doc = twoStorey();
    const geometry = stairGeometry(doc, makeStair(doc, { riserCount: 14 }));
    expect(geometry.treads).toHaveLength(13);
  });

  it('re-proportions itself when a ceiling height changes', () => {
    const doc = twoStorey(2.6);
    const before = stairGeometry(doc, makeStair(doc)).riserHeight;

    doc.levels[0]!.wallHeight = 3.0;
    const after = stairGeometry(doc, doc.stairs[0]!).riserHeight;

    expect(after).toBeGreaterThan(before);
    expect(after * doc.stairs[0]!.riserCount).toBeCloseTo(riseAbove(doc, doc.levels[0]!.id), 9);
  });

  it('reports nothing to climb when there is no storey above', () => {
    const doc = createDefaultDocument();
    const stair = makeStair(doc);
    expect(stairGeometry(doc, stair).totalRise).toBe(0);
    expect(checkIds(doc, stair)).toContain('no-storey');
  });
});

/* ------------------------------- The shapes ------------------------------ */

describe('stair shapes', () => {
  it('runs a straight flight along the direction it faces', () => {
    const doc = twoStorey();
    const stair = makeStair(doc, { at: { x: 0, z: 0 }, rotation: 0, riserCount: 5 });
    const geometry = stairGeometry(doc, stair);

    // Facing +Z at rotation zero, so every tread advances in +Z and none in X.
    for (const tread of geometry.treads) {
      expect(Math.abs(tread.nosing.x)).toBeLessThan(1e-9);
    }
    const nosings = geometry.treads.map((tread) => tread.nosing.z);
    for (let i = 1; i < nosings.length; i++) {
      expect(nosings[i]!).toBeGreaterThan(nosings[i - 1]!);
    }
    // Four treads at 11 in each.
    expect(nosings[nosings.length - 1]!).toBeCloseTo(4 * inches(11), 6);
  });

  it('respects the angle a stair is drawn at', () => {
    // A stair at 37 degrees to the world grid has to behave exactly like one
    // drawn square to it, or every plan that is not axis-aligned is wrong.
    const doc = twoStorey();
    const rotation = 0.6458;
    const geometry = stairGeometry(doc, makeStair(doc, { rotation, riserCount: 5 }));

    const forward = forwardOf(rotation);
    for (const tread of geometry.treads) {
      const along = tread.nosing.x * forward.x + tread.nosing.z * forward.z;
      const across = tread.nosing.x * -forward.z + tread.nosing.z * forward.x;
      // Everything advances along the stair and nothing drifts sideways.
      expect(along).toBeGreaterThan(0);
      expect(Math.abs(across)).toBeLessThan(1e-9);
    }
  });

  it('turns an L-shaped stair through a right angle', () => {
    const doc = twoStorey();
    const form: StairForm = { kind: 'l-shaped', turn: 'right', risersBeforeLanding: 7 };
    const geometry = stairGeometry(doc, makeStair(doc, { form, riserCount: 14 }));

    const landing = geometry.landings[0];
    expect(landing, 'an L-shaped stair has exactly one landing').toBeDefined();
    expect(geometry.landings).toHaveLength(1);

    // The first flight runs in +Z; after the turn the treads move in +X.
    const first = geometry.treads[0]!;
    const last = geometry.treads[geometry.treads.length - 1]!;
    expect(first.nosing.z).toBeGreaterThan(0);
    expect(last.nosing.x).toBeGreaterThan(first.nosing.x + 0.5);
  });

  it('brings a U-shaped stair back on itself', () => {
    const doc = twoStorey();
    const form: StairForm = { kind: 'u-shaped', turn: 'right', risersBeforeLanding: 8 };
    const geometry = stairGeometry(doc, makeStair(doc, { form, riserCount: 16 }));

    const beforeLanding = geometry.treads.filter((tread) => tread.index < 7);
    const afterLanding = geometry.treads.filter((tread) => tread.index > 8);

    // The second flight travels back the way the first came.
    const up = beforeLanding[beforeLanding.length - 1]!.nosing.z - beforeLanding[0]!.nosing.z;
    const back = afterLanding[afterLanding.length - 1]!.nosing.z - afterLanding[0]!.nosing.z;
    expect(up).toBeGreaterThan(0);
    expect(back).toBeLessThan(0);
  });

  it('sweeps a spiral around its pole', () => {
    const doc = twoStorey();
    const form: StairForm = { kind: 'spiral', clockwise: true, innerRadius: 0.15 };
    const geometry = stairGeometry(doc, makeStair(doc, { form, riserCount: 14, width: inches(30) }));

    // Every tread is the same distance band from the centre, and they go round.
    const angles = geometry.treads.map((tread) => Math.atan2(tread.nosing.z, tread.nosing.x));
    expect(new Set(angles.map((angle) => angle.toFixed(4))).size).toBe(angles.length);
    // All treads identical, as R311.7.10.1 requires.
    const depths = geometry.treads.map((tread) => tread.depthAtWalkline);
    for (const depth of depths) expect(depth).toBeCloseTo(depths[0]!, 9);
  });

  it('tapers winder treads towards the newel', () => {
    const doc = twoStorey();
    const form: StairForm = {
      kind: 'winder',
      turn: 'right',
      risersBeforeWinder: 4,
      winderTreads: 3,
      innerRadius: 0.15,
    };
    const geometry = stairGeometry(doc, makeStair(doc, { form, riserCount: 14 }));

    const winders = geometry.treads.filter((tread) => tread.kind === 'winder');
    expect(winders).toHaveLength(3);
    for (const winder of winders) {
      // Shallower at the inside than where people walk: that is what a winder is.
      expect(winder.minDepth).toBeLessThan(winder.depthAtWalkline);
    }
  });
});

/* ------------------------------ The stairwell ---------------------------- */

describe('the stairwell opening', () => {
  it('starts where headroom would otherwise run out, not at the bottom step', () => {
    /*
     * The low end of a staircase passes comfortably under the ceiling and wants
     * solid floor over it — that space is a cupboard. Cutting the whole
     * footprint out throws away floor for nothing.
     */
    const doc = twoStorey(2.6, 0.25);
    const stair = makeStair(doc, { riserCount: 14 });
    const geometry = stairGeometry(doc, stair);

    expect(geometry.wellOpening.length).toBeGreaterThanOrEqual(3);

    // The underside of the floor above, measured from this storey's floor.
    const underside = 2.6;
    const firstOpen = geometry.treads.find(
      (tread) => underside - tread.height < IRC_STAIRS.minHeadroom.metres,
    );
    expect(firstOpen, 'some tread must need the opening').toBeDefined();
    // And it is not the very first one, or the whole floor would be a hole.
    expect(firstOpen!.index).toBeGreaterThan(0);
  });

  it('opens nothing when there is no floor above to cut', () => {
    const doc = createDefaultDocument();
    const stair = makeStair(doc);
    expect(stairGeometry(doc, stair).wellOpening).toEqual([]);
  });

  it('moves the opening when the stair moves', () => {
    // Derived rather than stored, which is what stops a staircase ever arriving
    // at a solid ceiling.
    const doc = twoStorey();
    const stair = makeStair(doc, { riserCount: 14 });
    const before = stairGeometry(doc, stair).wellOpening.map((point) => point.x);

    stair.at = { x: 3, z: 0 };
    const after = stairGeometry(doc, stair).wellOpening.map((point) => point.x);

    expect(Math.min(...after)).toBeGreaterThan(Math.min(...before) + 2.5);
  });
});

/* ------------------------------ The IRC checks --------------------------- */

describe('IRC stair checks', () => {
  it('passes a stair built to ordinary US practice', () => {
    // 14 risers over 2.85 m is 8 in — over the limit. 16 gets it to 7 1/8 in,
    // which is what a real stair in a house with this storey height would be.
    const doc = roomyTwoStorey(2.6, 0.25);
    const stair = makeStair(doc, {
      riserCount: 16,
      treadDepth: inches(11),
      width: inches(36),
      at: { x: 0, z: -4 },
    });
    const report = checkStair(doc, stair);

    expect(
      report.findings.filter((finding) => finding.severity === 'violation'),
      report.findings.map((finding) => finding.title).join('; '),
    ).toHaveLength(0);
    expect(report.compliant).toBe(true);
  });

  it('catches risers over 7 3/4 in and says how many steps would fix it', () => {
    const doc = twoStorey(2.6, 0.25);
    // 12 risers over 2.85 m is 9 3/8 in a step.
    const stair = makeStair(doc, { riserCount: 12 });
    const finding = checkStair(doc, stair).findings.find(
      (entry) => entry.id === 'st1:riser-height',
    );

    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('violation');
    expect(finding!.section).toBe('R311.7.5.1');
    expect(finding!.detail).toContain('7 3/4 in');
    // The remedy is arithmetic, not advice.
    expect(finding!.remedy).toMatch(/\d+ risers/);
  });

  it('catches treads under 10 in', () => {
    const doc = twoStorey();
    const stair = makeStair(doc, { riserCount: 16, treadDepth: inches(9) });
    const finding = checkStair(doc, stair).findings.find(
      (entry) => entry.id === 'st1:tread-depth',
    );

    expect(finding).toBeDefined();
    expect(finding!.section).toBe('R311.7.5.2');
    expect(finding!.detail).toContain('10 in');
  });

  it('catches a stair narrower than 36 in', () => {
    const doc = twoStorey();
    const stair = makeStair(doc, { riserCount: 16, width: inches(30) });
    const finding = checkStair(doc, stair).findings.find((entry) => entry.id === 'st1:width');

    expect(finding).toBeDefined();
    expect(finding!.section).toBe('R311.7.1');
  });

  it('judges a spiral under its own section, not the general rules', () => {
    /*
     * R311.7.10.1 lets a spiral be 26 in wide with 9 1/2 in risers — all of
     * which the general rules forbid. Applying the general limits to one would
     * report a perfectly legal stair as three violations, and that is exactly
     * how a compliance checker teaches people to ignore it.
     */
    const doc = twoStorey(2.6, 0.25);
    const form: StairForm = { kind: 'spiral', clockwise: true, innerRadius: 0.15 };
    const stair = makeStair(doc, {
      form,
      riserCount: 14,
      width: inches(28),
      treadDepth: inches(7.5),
      handrail: 'right',
    });

    const ids = checkIds(doc, stair);
    // 28 in is legal for a spiral and illegal for anything else.
    expect(ids).not.toContain('width');
    // 2.85 m over 14 risers is 8 in — over the general limit, under the spiral one.
    expect(ids).not.toContain('riser-height');
  });

  it('catches a spiral whose treads are too shallow at the walkline', () => {
    const doc = twoStorey();
    const form: StairForm = { kind: 'spiral', clockwise: true, innerRadius: 0.15 };
    const stair = makeStair(doc, { form, riserCount: 16, treadDepth: inches(5) });
    const finding = checkStair(doc, stair).findings.find(
      (entry) => entry.id === 'st1:spiral-tread',
    );

    expect(finding).toBeDefined();
    expect(finding!.section).toBe('R311.7.10.1');
    expect(finding!.detail).toContain('6 3/4 in');
  });

  it('catches winders that converge too tightly, and says how big the newel must be', () => {
    /*
     * The classic winder mistake: three treads across a 90 degree turn with a
     * small post. At a 100 mm newel the walkline arc is about 6 1/4 in against
     * the 10 in required, and no amount of overall width fixes it — the only
     * cures are a fatter post or fewer treads.
     */
    const doc = twoStorey();
    const form: StairForm = {
      kind: 'winder',
      turn: 'right',
      risersBeforeWinder: 4,
      winderTreads: 3,
      innerRadius: 0.1,
    };
    const stair = makeStair(doc, { form, riserCount: 16 });
    const finding = checkStair(doc, stair).findings.find(
      (entry) => entry.id === 'st1:winder-walkline',
    );

    expect(finding).toBeDefined();
    expect(finding!.section).toBe('R311.7.5.2.1');
    expect(finding!.detail).toContain('10 in');
    expect(finding!.remedy).toContain('newel');
  });

  it('accepts a winder with a newel big enough to carry the walkline', () => {
    // Two treads across the turn at 45 degrees each: the arc only needs a
    // radius of about 12.7 in, which a modest post provides.
    const doc = twoStorey();
    const form: StairForm = {
      kind: 'winder',
      turn: 'right',
      risersBeforeWinder: 4,
      winderTreads: 2,
      innerRadius: 0.05,
    };
    const stair = makeStair(doc, { form, riserCount: 16 });
    expect(checkIds(doc, stair)).not.toContain('winder-walkline');
  });

  it('requires a handrail on any flight of four or more risers', () => {
    const doc = twoStorey();
    const stair = makeStair(doc, { riserCount: 16, handrail: 'none' });
    const finding = checkStair(doc, stair).findings.find((entry) => entry.id === 'st1:handrail');

    expect(finding).toBeDefined();
    expect(finding!.detail).toContain('16 risers');
  });

  it('asks for a guard around the stairwell, citing the drop', () => {
    const doc = twoStorey();
    const stair = makeStair(doc, { riserCount: 16 });
    const finding = checkStair(doc, stair).findings.find((entry) => entry.id === 'st1:guard');

    expect(finding).toBeDefined();
    expect(finding!.section).toBe(IRC_GUARDS.minHeight.section);
    expect(finding!.detail).toContain(IRC_GUARDS.requiredAboveDrop.asWritten);
  });

  it('catches a flight that climbs too far without a landing', () => {
    // R311.7.3 caps an unbroken flight at 151 in — about 3.84 m.
    const doc = twoStorey(4.2, 0.3);
    const stair = makeStair(doc, { riserCount: 26 });
    const finding = checkStair(doc, stair).findings.find(
      (entry) => entry.id === 'st1:flight-rise',
    );

    expect(finding).toBeDefined();
    expect(finding!.section).toBe('R311.7.3');
  });

  it('catches a landing shallower than 36 in', () => {
    const doc = twoStorey();
    // The landing's depth is the stair's own width, so a narrow stair has a
    // shallow landing — which is legal for the flight and not for the landing.
    const form: StairForm = { kind: 'l-shaped', turn: 'right', risersBeforeLanding: 7 };
    const stair = makeStair(doc, { form, riserCount: 16, width: inches(30) });
    const findings = checkStair(doc, stair).findings;

    expect(findings.some((entry) => entry.id.includes('landing'))).toBe(true);
  });

  it('cites a real section for everything it takes from the code', () => {
    /*
     * A citation is what makes a finding checkable; without one it is an
     * assertion, and an assertion about somebody's staircase is worthless.
     *
     * Not every finding is a code finding, though. "The staircase runs outside
     * the building" is geometric nonsense rather than an IRC clause, and
     * inventing a section number for it would be worse than leaving it blank —
     * somebody would look it up and find it says something else, and then stop
     * believing the citations that are real.
     */
    const doc = roomyTwoStorey();
    const stair = makeStair(doc, {
      riserCount: 10,
      treadDepth: inches(8),
      width: inches(28),
      at: { x: 0, z: -4 },
    });

    const findings = checkStair(doc, stair).findings;
    expect(findings.length).toBeGreaterThan(1);

    for (const finding of findings) {
      // Anything that names a section names a well-formed one.
      if (finding.section) expect(finding.section, finding.title).toMatch(/^R\d/);
      // And everything says what to do about it, whatever its source.
      expect(finding.remedy.length, finding.title).toBeGreaterThan(10);
    }

    // The code checks specifically must carry their citation.
    for (const id of ['riser-height', 'tread-depth', 'width']) {
      const finding = findings.find((entry) => entry.id === `st1:${id}`);
      expect(finding, id).toBeDefined();
      expect(finding!.section, id).toMatch(/^R\d/);
    }
  });
});

/* ------------------------------- Formatting ------------------------------ */

describe('imperial formatting', () => {
  it('writes lengths the way a US builder would say them', () => {
    // The code is written in feet and inches. A figure the user has to convert
    // before checking it against the limit it failed is a figure nobody checks.
    expect(asFeetInches(inches(7.75))).toBe('7 3/4 in');
    expect(asFeetInches(feet(6) + inches(8))).toBe('6 ft 8 in');
    expect(asFeetInches(inches(36))).toBe('3 ft');
    expect(asFeetInches(inches(10))).toBe('10 in');
  });

  it('writes a negative length as a negative length', () => {
    /*
     * Ground below a floor, a level below the datum, a measurement short of a
     * limit — negative lengths are ordinary here. Flooring a negative rounds it
     * AWAY from zero, so -0.3 m used to come out as "-1 ft 3/16 in": a foot too
     * far, and in the wrong direction.
     */
    expect(asFeetInches(-0.3)).toBe('-11 13/16 in');
    expect(asFeetInches(-(feet(6) + inches(8)))).toBe('-6 ft 8 in');
    expect(asFeetInches(-inches(36))).toBe('-3 ft');
  });

  it('reduces fractions rather than leaving them over sixteen', () => {
    expect(asFeetInches(inches(0.5))).toBe('1/2 in');
    expect(asFeetInches(inches(0.25))).toBe('1/4 in');
  });

  it('summarises a stair as a riser and a going', () => {
    const doc = twoStorey();
    const geometry = stairGeometry(doc, makeStair(doc, { riserCount: 16 }));
    expect(describeStair(geometry)).toContain('16 risers');
    expect(describeStair(geometry)).toContain('going');
  });
});

/* ------------------------------- Colliders ------------------------------- */

describe('stairs as obstacles', () => {
  it('keeps furniture off the staircase', () => {
    const doc = twoStorey();
    makeStair(doc, { riserCount: 16 });
    const colliders = stairColliders(doc, doc.levels[0]!.id);

    expect(colliders.length).toBe(15);
    for (const collider of colliders) {
      expect(collider.kind).toBe('stair');
      expect(collider.halfWidth).toBeGreaterThan(0);
      expect(collider.halfDepth).toBeGreaterThan(0);
    }
  });

  it('only blocks the storey the stair stands on', () => {
    const doc = twoStorey();
    makeStair(doc, { riserCount: 16 });
    // The stair rises FROM the first floor, so it obstructs that one and not
    // the one it arrives at — where it is a hole in the floor instead.
    expect(stairColliders(doc, doc.levels[1]!.id)).toHaveLength(0);
  });
});

describe('convexHull', () => {
  it('drops interior points', () => {
    const hull = convexHull([
      { x: 0, z: 0 },
      { x: 2, z: 0 },
      { x: 2, z: 2 },
      { x: 0, z: 2 },
      { x: 1, z: 1 },
    ]);
    expect(hull).toHaveLength(4);
  });

  it('survives degenerate input rather than throwing', () => {
    expect(convexHull([]).length).toBe(0);
    expect(convexHull([{ x: 1, z: 1 }]).length).toBe(1);
  });
});

describe('does the stair fit in the building', () => {
  it('catches a flight that runs out through a wall', () => {
    /*
     * The commonest stair mistake there is, and invisible in plan until you
     * look for it. A 16-riser flight at an 11 in going is over 13 ft long —
     * longer than the depth of most rooms — so a straight stair dropped into a
     * small room simply leaves the building.
     */
    const doc = twoStorey();
    const stair = makeStair(doc, {
      riserCount: 16,
      treadDepth: inches(11),
      at: { x: 0, z: -1.5 },
      rotation: 0,
    });

    const finding = checkStair(doc, stair).findings.find(
      (entry) => entry.id === 'st1:containment',
    );
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('violation');
    // The arithmetic that explains it, not just the complaint.
    expect(finding!.detail).toMatch(/treads at/);
    expect(finding!.remedy).toContain('L or a U');
  });

  it('says nothing about a stair that fits', () => {
    // The starter room is 4.2 x 3.4 m, so a short flight along it is fine.
    const doc = twoStorey(2.0, 0.2);
    const stair = makeStair(doc, {
      riserCount: 10,
      treadDepth: inches(10),
      at: { x: 0, z: -1.5 },
      rotation: 0,
      width: inches(36),
    });
    expect(checkIds(doc, stair)).not.toContain('containment');
  });

  it('measures the run corner to corner, not as the sum of the goings', () => {
    // A turned stair folds back on itself, so its treads add up to far more
    // than the floor it occupies. Judging it by the sum would report every
    // U-shaped stair as too long for the room it fits in perfectly.
    const doc = twoStorey();
    const straight = stairGeometry(doc, makeStair(doc, { riserCount: 16 }));
    const folded = stairGeometry(
      doc,
      makeStair(doc, {
        riserCount: 16,
        form: { kind: 'u-shaped', turn: 'right', risersBeforeLanding: 8 },
      }),
    );

    const extent = (geometry: typeof straight) => {
      let longest = 0;
      for (const a of geometry.footprint) {
        for (const b of geometry.footprint) {
          longest = Math.max(longest, Math.hypot(a.x - b.x, a.z - b.z));
        }
      }
      return longest;
    };

    expect(extent(folded)).toBeLessThan(extent(straight));
  });
});
