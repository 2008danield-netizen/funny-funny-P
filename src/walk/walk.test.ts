/**
 * Tests for walking through the building.
 *
 * These carry more weight than usual. A headset cannot be automated and I
 * cannot put one on, so everything below the input layer — what is underfoot,
 * sliding along walls, climbing stairs, refusing to walk off the building — has
 * to be established here or it is not established at all.
 *
 * That is also why the walker takes an intent rather than reading a keyboard:
 * a pure function of intent and document can be driven exhaustively from a
 * test, and the only thing left unverified is the hardware plumbing.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, normalizePlan, splitWall, drawWall } from '@/state/planOps';
import { addLevel, addStair } from '@/state/buildingOps';
import { stairGeometry } from '@/building/stairs';
import { findRegions } from '@/scene/planGraph';
import { elevationOf } from '@/state/levels';
import { MAX_STEP_UP, resetGroundCache, standingAt, canStandAt, headroomAt } from './ground';
import { BODY, NO_INTENT, Walker, startingPoint, type WalkIntent } from './Walker';
import { ARC, aimTeleport } from './teleport';
import type { DesignDocument, Point2 } from '@/state/types';

/** A 12 × 8 house spanning x 0–12 and z 0–8. */
function house(): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  // Centre, not corner — see the note in the section tests.
  addRectangle(level.plan, { x: 6, z: 4 }, 12, 8);
  normalizePlan(level.plan);

  for (const region of findRegions(level.plan)) {
    level.plan.rooms[region.key] = {
      name: 'Living Room',
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  }
  return doc;
}

/** The same house split in two by a real partition, with a door through it. */
function twoRooms(doorWidth = 0.9): DesignDocument {
  const doc = house();
  const plan = doc.levels[0]!.plan;

  // A partition only closes a room if the walls it meets are split first —
  // `drawWall` lands on a new vertex rather than cutting the wall it touches.
  const north = plan.walls.find((wall) => {
    const a = plan.vertices.find((v) => v.id === wall.start)!;
    const b = plan.vertices.find((v) => v.id === wall.end)!;
    return Math.abs(a.z) < 0.01 && Math.abs(b.z) < 0.01;
  })!;
  const south = plan.walls.find((wall) => {
    const a = plan.vertices.find((v) => v.id === wall.start)!;
    const b = plan.vertices.find((v) => v.id === wall.end)!;
    return Math.abs(a.z - 8) < 0.01 && Math.abs(b.z - 8) < 0.01;
  })!;

  const top = splitWall(plan, north.id, 0.5)!;
  const bottom = splitWall(plan, south.id, 0.5)!;
  const va = plan.vertices.find((vertex) => vertex.id === top)!;
  const vb = plan.vertices.find((vertex) => vertex.id === bottom)!;

  const partition = drawWall(plan, { x: va.x, z: va.z }, { x: vb.x, z: vb.z })!;
  addOpening(plan, partition, 'door', 'door-single', { width: doorWidth, height: 2.04, sillHeight: 0 }, 4);
  normalizePlan(plan);

  for (const region of findRegions(plan)) {
    plan.rooms[region.key] = {
      name: 'Room',
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  }
  return doc;
}

function intent(overrides: Partial<WalkIntent> = {}): WalkIntent {
  return { ...NO_INTENT, ...overrides };
}

/** Runs the walker for a while, so a test can say "walk forward for 3 seconds". */
function walkFor(walker: Walker, doc: DesignDocument, seconds: number, what: WalkIntent): void {
  const step = 1 / 60;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    walker.update(doc, what, step);
  }
}

beforeEach(() => resetGroundCache());

/* --------------------------------- Ground --------------------------------- */

describe('what is underfoot', () => {
  it('finds the floor inside a room', () => {
    const doc = house();
    const standing = standingAt(doc, { x: 6, z: 4 }, 0)!;

    expect(standing).not.toBeNull();
    expect(standing.kind).toBe('floor');
    expect(standing.y).toBeCloseTo(0, 6);
    expect(standing.levelId).toBe(doc.levels[0]!.id);
  });

  it('finds nothing outside the building', () => {
    // Not a fall: the caller refuses the move. A walkthrough of a design is not
    // a game, and dropping out of the model is never the useful answer.
    expect(standingAt(house(), { x: 40, z: 40 }, 0)).toBeNull();
    expect(canStandAt(house(), { x: 40, z: 40 }, 0)).toBe(false);
  });

  it('reports the headroom of the storey it is in', () => {
    const doc = house();
    const standing = standingAt(doc, { x: 6, z: 4 }, 0)!;
    expect(headroomAt(doc, { x: 6, z: 4 }, standing)).toBeCloseTo(
      doc.levels[0]!.wallHeight,
      6,
    );
  });

  it('never claims a surface further up than one step', () => {
    /*
     * The rule the whole file turns on. Add a storey; standing on the ground
     * floor, the floor above is directly overhead and must not be selected,
     * or walking under a stairwell would teleport somebody up a level.
     */
    const doc = house();
    addLevel(doc);
    resetGroundCache();

    const standing = standingAt(doc, { x: 6, z: 4 }, 0)!;
    expect(standing.y).toBeCloseTo(0, 6);
    expect(standing.y).toBeLessThan(MAX_STEP_UP);
  });

  it('puts somebody on the floor above when they are already up there', () => {
    const doc = house();
    addLevel(doc);
    resetGroundCache();

    const upstairs = elevationOf(doc, doc.levels[1]!.id);
    const standing = standingAt(doc, { x: 6, z: 4 }, upstairs)!;

    expect(standing.y).toBeCloseTo(upstairs, 6);
    expect(standing.levelId).toBe(doc.levels[1]!.id);
  });
});

/* -------------------------------- The walker ------------------------------ */

describe('walking', () => {
  it('moves in the direction it is facing', () => {
    const doc = house();
    const start = standingAt(doc, { x: 6, z: 2 }, 0)!;
    // Heading 0 looks towards +z, the same convention furniture uses.
    const walker = new Walker({ x: 6, z: 2 }, start, 0);

    walkFor(walker, doc, 1, intent({ forward: 1 }));
    const after = walker.current;

    expect(after.at.z).toBeGreaterThan(2.5);
    expect(after.at.x).toBeCloseTo(6, 1);
  });

  it('walks further when running', () => {
    const doc = house();
    const from = { x: 6, z: 1 };
    const start = standingAt(doc, from, 0)!;

    const walk = new Walker({ ...from }, start, 0);
    walkFor(walk, doc, 1, intent({ forward: 1 }));

    const run = new Walker({ ...from }, start, 0);
    walkFor(run, doc, 1, intent({ forward: 1, running: true }));

    expect(run.current.at.z).toBeGreaterThan(walk.current.at.z + 0.5);
  });

  it('stops at a wall instead of going through it', () => {
    const doc = house();
    const start = standingAt(doc, { x: 6, z: 4 }, 0)!;
    const walker = new Walker({ x: 6, z: 4 }, start, 0);

    // Ten seconds forward at walking pace is far past the far wall.
    walkFor(walker, doc, 10, intent({ forward: 1 }));

    expect(walker.current.at.z).toBeLessThan(8);
    // And still inside the building, not resting in the wall's thickness.
    expect(canStandAt(doc, walker.current.at, walker.current.standing.y)).toBe(true);
  });

  it('slides along a wall approached at an angle', () => {
    // The thing that makes a corridor bearable. Walking into a wall at 45
    // degrees should carry you along it, not stop you dead.
    const doc = house();
    const start = standingAt(doc, { x: 6, z: 6 }, 0)!;
    const walker = new Walker({ x: 6, z: 6 }, start, Math.PI / 4);

    walkFor(walker, doc, 6, intent({ forward: 1 }));

    // Pressed against the south wall, but carried a long way east along it.
    expect(walker.current.at.x).toBeGreaterThan(8);
  });

  it('goes through a doorway', () => {
    /*
     * The doorway gaps come from the same `wallColliders` the furniture tool
     * uses, so a door wide enough to place a sofa through is wide enough to
     * walk through. That consistency is the point of sharing the solver.
     */
    const doc = twoRooms();
    const start = standingAt(doc, { x: 3, z: 4 }, 0)!;
    const walker = new Walker({ x: 3, z: 4 }, start, Math.PI / 2);

    walkFor(walker, doc, 8, intent({ forward: 1 }));

    // Started west of the partition at x = 6; should now be east of it.
    expect(walker.current.at.x).toBeGreaterThan(6.5);
  });

  it('does not squeeze through a door narrower than the body', () => {
    const doc = twoRooms(0.3);
    const start = standingAt(doc, { x: 3, z: 4 }, 0)!;
    const walker = new Walker({ x: 3, z: 4 }, start, Math.PI / 2);

    walkFor(walker, doc, 8, intent({ forward: 1 }));
    expect(walker.current.at.x).toBeLessThan(6);
  });

  it('turns without moving', () => {
    const doc = house();
    const start = standingAt(doc, { x: 6, z: 4 }, 0)!;
    const walker = new Walker({ x: 6, z: 4 }, start, 0);

    walkFor(walker, doc, 1, intent({ turn: 1 }));

    expect(walker.current.heading).toBeGreaterThan(1);
    expect(walker.current.at.x).toBeCloseTo(6, 6);
    expect(walker.current.at.z).toBeCloseTo(4, 6);
  });

  it('snap-turns by exactly one step', () => {
    const doc = house();
    const start = standingAt(doc, { x: 6, z: 4 }, 0)!;
    const walker = new Walker({ x: 6, z: 4 }, start, 0);

    walker.update(doc, intent({ snap: 1 }), 1 / 60);
    expect(walker.current.heading).toBeCloseTo(BODY.snapTurn, 6);

    walker.update(doc, intent({ snap: -1 }), 1 / 60);
    expect(walker.current.heading).toBeCloseTo(0, 6);
  });

  it('refuses a teleport to somewhere it could not have walked', () => {
    // The same question the walker asks every frame, deliberately — a teleport
    // that lands where you could not walk is a teleport into a wall.
    const doc = house();
    const start = standingAt(doc, { x: 6, z: 4 }, 0)!;
    const walker = new Walker({ x: 6, z: 4 }, start, 0);

    walker.update(doc, intent({ teleportTo: { x: 40, z: 40 } }), 1 / 60);

    expect(walker.current.at.x).toBeCloseTo(6, 6);
    expect(walker.current.stuck).toBe(true);
  });

  it('teleports somewhere it could have walked', () => {
    const doc = house();
    const start = standingAt(doc, { x: 2, z: 2 }, 0)!;
    const walker = new Walker({ x: 2, z: 2 }, start, 0);

    walker.update(doc, intent({ teleportTo: { x: 10, z: 6 } }), 1 / 60);

    expect(walker.current.at.x).toBeCloseTo(10, 1);
    expect(walker.current.at.z).toBeCloseTo(6, 1);
  });

  it('eases the eye rather than snapping it', () => {
    /*
     * Instant is correct and feels wrong: a flight of stairs becomes a rapid
     * series of jolts, and in a headset that is the difference between climbing
     * and being teleported thirteen times.
     */
    const doc = house();
    const start = standingAt(doc, { x: 6, z: 4 }, 0)!;
    const walker = new Walker({ x: 6, z: 4 }, start, 0);

    // Drop the walker's eye and let one frame pass; it must move part of the
    // way, not all of it.
    walker.placeAt({ x: 6, z: 4 }, { ...start, y: -1 });
    const before = walker.current.eyeY;

    walker.update(doc, intent(), 1 / 60);
    const after = walker.current.eyeY;

    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(BODY.eyeHeight);
  });

  it('keeps the eye a constant height above the floor when still', () => {
    const doc = house();
    const start = standingAt(doc, { x: 6, z: 4 }, 0)!;
    const walker = new Walker({ x: 6, z: 4 }, start, 0);

    walkFor(walker, doc, 1, intent());
    expect(walker.current.eyeY).toBeCloseTo(start.y + BODY.eyeHeight, 4);
  });
});

/* --------------------------------- Stairs --------------------------------- */

describe('stairs', () => {
  /** The house, a storey above it, and a straight flight between them. */
  function twoStoreys(): { doc: DesignDocument; bottom: Point2 } {
    const doc = house();
    addLevel(doc);
    const ground = doc.levels[0]!;

    // `addStair` works on the ACTIVE level, and `addLevel` makes the new
    // storey active — so without this the stair is added to the top floor,
    // which has nothing above it to climb to.
    doc.activeLevelId = ground.id;

    const added = addStair(doc, { x: 2, z: 2 });
    expect(added.id, added.reason ?? '').not.toBeNull();
    resetGroundCache();

    return { doc, bottom: { x: 2, z: 2 } };
  }

  it('puts a stair tread underfoot when standing on one', () => {
    const { doc } = twoStoreys();
    const stair = doc.stairs[0]!;

    // Somewhere on the flight: take the fourth tread's own nosing.
    const treads = stairGeometry(doc, stair).treads;
    expect(treads.length).toBeGreaterThan(3);

    /*
     * The tread's own middle, not its nosing. A nosing overhangs the tread
     * below it, so a query at one can legitimately land on the tread ABOVE —
     * which is correct behaviour and a poor thing to assert against.
     */
    const third = treads[3]!;
    const middle = third.polygon.reduce(
      (sum, corner) => ({
        x: sum.x + corner.x / third.polygon.length,
        z: sum.z + corner.z / third.polygon.length,
      }),
      { x: 0, z: 0 },
    );

    const standing = standingAt(doc, middle, third.height)!;

    expect(standing).not.toBeNull();
    expect(standing.kind).toBe('stair');
    // Within one riser: standing mid-tread, the next one up is a legal step.
    expect(Math.abs(standing.y - third.height)).toBeLessThanOrEqual(0.2);
  });

  it('climbs a flight by walking at it', () => {
    /*
     * The thing that makes a building walkable rather than a floor plan. No
     * code anywhere knows what "climbing" is — it falls out of taking the
     * highest surface within one step every frame.
     */
    const { doc, bottom } = twoStoreys();
    const start = standingAt(doc, bottom, 0)!;

    const treads = stairGeometry(doc, doc.stairs[0]!).treads;
    const top = treads[treads.length - 1]!;

    // Face along the flight and walk.
    const heading = Math.atan2(top.nosing.x - bottom.x, top.nosing.z - bottom.z);
    const walker = new Walker({ ...bottom }, start, heading);

    walkFor(walker, doc, 12, intent({ forward: 1 }));

    // All the way up, and onto the floor above rather than falling back down.
    expect(walker.current.standing.y).toBeCloseTo(elevationOf(doc, doc.levels[1]!.id), 1);
    expect(walker.current.standing.levelId).toBe(doc.levels[1]!.id);
  });

  it('arrives on the floor above instead of falling back down at the top', () => {
    /*
     * Found by walking a flight and watching the walker reach the top and then
     * drop to the ground floor. The stairwell opening is cut from HEADROOM, so
     * it necessarily extends past the top of the flight — which means the floor
     * of the storey above is missing at exactly the point somebody steps off
     * the last tread. The flight's arrival surface fills it.
     */
    const { doc, bottom } = twoStoreys();
    const treads = stairGeometry(doc, doc.stairs[0]!).treads;
    const top = treads[treads.length - 1]!;
    const upstairs = elevationOf(doc, doc.levels[1]!.id);

    // One going beyond the last tread, stepping off it.
    const heading = Math.atan2(top.nosing.x - bottom.x, top.nosing.z - bottom.z);
    const beyond = {
      x: top.nosing.x + Math.sin(heading) * 0.4,
      z: top.nosing.z + Math.cos(heading) * 0.4,
    };

    const standing = standingAt(doc, beyond, top.height)!;
    expect(standing).not.toBeNull();
    expect(standing.y).toBeCloseTo(upstairs, 2);
  });
});

/* ------------------------------- Where to start --------------------------- */

describe('the starting point', () => {
  it('starts in the biggest room, standing on its floor', () => {
    // Not at the camera: an orbit camera is usually outside the building
    // looking in, and starting a walkthrough in the garden facing a wall is a
    // poor first second.
    const doc = house();
    const start = startingPoint(doc)!;

    expect(start).not.toBeNull();
    expect(canStandAt(doc, start.at, start.standing.y)).toBe(true);
    expect(start.standing.y).toBeCloseTo(0, 6);
  });

  it('gives nothing when there is no room to start in', () => {
    const doc = createDefaultDocument();
    doc.levels[0]!.plan.walls = [];
    doc.levels[0]!.plan.vertices = [];
    resetGroundCache();

    expect(startingPoint(doc)).toBeNull();
  });
});

/* -------------------------------- Teleport -------------------------------- */

describe('the teleport arc', () => {
  it('lands on the floor in front of you', () => {
    const doc = house();
    const standing = standingAt(doc, { x: 6, z: 2 }, 0)!;
    const aim = aimTeleport(
      doc,
      { x: 6, y: 1.4, z: 2 },
      // Forward and slightly down, the way a hand points at the floor ahead.
      { x: 0, y: -0.35, z: 1 },
      standing,
    );

    expect(aim.landing).not.toBeNull();
    expect(aim.refusal).toBe('none');
    expect(aim.landing!.z).toBeGreaterThan(2);
    expect(aim.points.length).toBeGreaterThan(2);
  });

  it('lands somewhere the walker would also accept', () => {
    // The same question, asked in one place. A teleport that puts you
    // somewhere you could not have walked is a teleport into a wall.
    const doc = house();
    const standing = standingAt(doc, { x: 6, z: 2 }, 0)!;
    const aim = aimTeleport(doc, { x: 6, y: 1.4, z: 2 }, { x: 0, y: -0.35, z: 1 }, standing);

    expect(canStandAt(doc, aim.landing!, standing.y)).toBe(true);
  });

  it('refuses to land outside the building', () => {
    const doc = house();
    const standing = standingAt(doc, { x: 6, z: 7 }, 0)!;
    // Aimed over the south wall, out into the garden.
    const aim = aimTeleport(doc, { x: 6, y: 1.4, z: 7 }, { x: 0, y: 0.1, z: 1 }, standing);

    expect(aim.landing).toBeNull();
  });

  it('refuses a hop further than the range limit', () => {
    /*
     * Not a game mechanic. Crossing a whole house in one hop makes it
     * impossible to judge how big the house is, which is the main thing a
     * walkthrough is for.
     */
    const doc = house();
    const standing = standingAt(doc, { x: 1, z: 1 }, 0)!;
    const aim = aimTeleport(doc, { x: 1, y: 1.4, z: 1 }, { x: 0.2, y: 0.55, z: 1 }, standing);

    if (aim.landing) {
      expect(Math.hypot(aim.landing.x - 1, aim.landing.z - 1)).toBeLessThanOrEqual(ARC.maxRange);
    } else {
      expect(aim.refusal).not.toBe('none');
    }
  });

  it('always returns a curve to draw, landing or not', () => {
    // The arc is drawn whether or not it can land — an aim with no feedback is
    // an aim somebody cannot correct.
    const doc = house();
    const standing = standingAt(doc, { x: 6, z: 7 }, 0)!;

    // Over the wall, so there is nothing to land on.
    const missed = aimTeleport(doc, { x: 6, y: 1.4, z: 7 }, { x: 0, y: 0.1, z: 1 }, standing);
    expect(missed.landing).toBeNull();
    expect(missed.points.length).toBeGreaterThan(2);
  });

  it('thrown straight up, lands back at your feet', () => {
    // Not a special case in the code, and worth pinning precisely because of
    // that: the arc comes back down where it went up, and the floor there is
    // as landable as any other.
    const doc = house();
    const standing = standingAt(doc, { x: 6, z: 4 }, 0)!;
    const aim = aimTeleport(doc, { x: 6, y: 1.4, z: 4 }, { x: 0, y: 1, z: 0 }, standing);

    expect(aim.landing).not.toBeNull();
    expect(aim.landing!.x).toBeCloseTo(6, 3);
    expect(aim.landing!.z).toBeCloseTo(4, 3);
  });

  it('curves downward rather than running straight', () => {
    // A straight ray gets flatter the further you aim, until a few degrees of
    // wrist swings the landing across the house. An arc moves predictably.
    const doc = house();
    const standing = standingAt(doc, { x: 6, z: 1 }, 0)!;
    const aim = aimTeleport(doc, { x: 6, y: 1.4, z: 1 }, { x: 0, y: 0.2, z: 1 }, standing);

    const heights = aim.points.map((point) => point.y);
    const highest = Math.max(...heights);

    expect(highest).toBeGreaterThan(1.4);
    expect(heights[heights.length - 1]).toBeLessThan(highest);
  });
});
