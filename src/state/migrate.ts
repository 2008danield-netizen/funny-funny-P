/**
 * Schema migrations.
 *
 * A saved design outlives the code that wrote it. Every user who opened
 * havavamama during session 1 has a v1 document sitting in their browser, and
 * losing their room because the data model grew up would be inexcusable — so
 * old documents are upgraded, never discarded.
 *
 * Migrations run BEFORE validation (`sanitizeDocument`), take an untrusted plain
 * object and return a plain object shaped like the current schema. They must
 * never throw: anything they cannot understand is left for the validator to
 * replace with a default.
 */

import type { Point2 } from './types';

/* ------------------------------- v1 -> v2 ------------------------------ */

/**
 * v1 stored one rectangular room as width/depth/height plus four compass-named
 * walls. v2 stores an arbitrary wall graph.
 *
 * The upgrade traces the v1 rectangle as four vertices and four walls, then
 * carries the paint across. Because v1 walls were single-sided (only the
 * interior was ever visible), each colour is applied to whichever face of the
 * new wall looks into the room — computed rather than hardcoded, so it stays
 * correct if the corner ordering below is ever changed.
 */
function migrateV1ToV2(doc: Record<string, unknown>): Record<string, unknown> {
  const room = (doc.room ?? {}) as Record<string, unknown>;
  const oldWalls = (room.walls ?? {}) as Record<string, unknown>;
  const ceiling = (room.ceiling ?? {}) as Record<string, unknown>;

  const asNumber = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  const width = asNumber(room.width, 4.2);
  const depth = asNumber(room.depth, 3.4);
  const height = asNumber(room.height, 2.6);
  const thickness = asNumber(room.wallThickness, 0.12);

  const halfW = width / 2;
  const halfD = depth / 2;

  // v1 rooms were centred on the origin, with north at -Z.
  const corners: Point2[] = [
    { x: -halfW, z: -halfD }, // north-west
    { x: halfW, z: -halfD }, // north-east
    { x: halfW, z: halfD }, // south-east
    { x: -halfW, z: halfD }, // south-west
  ];

  const vertices = corners.map((corner, index) => ({
    id: `v${index + 1}`,
    x: corner.x,
    z: corner.z,
  }));

  // Each edge of the loop, paired with the v1 wall whose colour it inherits.
  const edgeNames = ['north', 'east', 'south', 'west'] as const;

  const paintOf = (name: (typeof edgeNames)[number]) => {
    const legacy = (oldWalls[name] ?? {}) as Record<string, unknown>;
    return {
      color: typeof legacy.color === 'string' ? legacy.color : '#ece7df',
      roughness: asNumber(legacy.roughness, 0.88),
    };
  };

  /*
   * Work out the room's base colour before touching the walls.
   *
   * v2 paints a room once and treats a differing wall as an accent override.
   * Taking the base colour from one nominated wall would be wrong whenever that
   * wall happened to be the accent: a v1 room with three cream walls and one
   * terracotta would come back as four terracotta walls, silently destroying the
   * accent the user chose. The base is therefore the MOST COMMON colour, and
   * only the walls that differ from it get an override.
   */
  const tally = new Map<string, number>();
  for (const name of edgeNames) {
    const { color } = paintOf(name);
    tally.set(color, (tally.get(color) ?? 0) + 1);
  }
  let baseColor = paintOf('north').color;
  let bestCount = 0;
  for (const [color, count] of tally) {
    if (count > bestCount) {
      bestCount = count;
      baseColor = color;
    }
  }
  const basePaint = {
    color: baseColor,
    roughness: paintOf(
      edgeNames.find((name) => paintOf(name).color === baseColor) ?? 'north',
    ).roughness,
  };

  const walls = edgeNames.map((name, index) => {
    const start = corners[index]!;
    const end = corners[(index + 1) % corners.length]!;

    // Face "a" is the side the wall's left normal points towards. Work out
    // whether that side faces the room's interior (the origin, here).
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const len = Math.hypot(dx, dz) || 1;
    const normal = { x: -dz / len, z: dx / len };
    const midpoint = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
    // Vector from the wall towards the room centre (the origin).
    const towardsInterior = { x: -midpoint.x, z: -midpoint.z };
    const interiorIsFaceA =
      towardsInterior.x * normal.x + towardsInterior.z * normal.z >= 0;

    const face = paintOf(name);
    // Only an accent wall needs an override; the rest inherit the room colour.
    const isAccent = face.color !== basePaint.color;

    return {
      id: `w${index + 1}`,
      start: vertices[index]!.id,
      end: vertices[(index + 1) % vertices.length]!.id,
      thickness,
      height,
      faces: isAccent ? (interiorIsFaceA ? { a: face } : { b: face }) : {},
      openings: [],
    };
  });

  // v1 had one room, so its appearance becomes both the room entry and the
  // default applied to any room the user creates next.
  const roomSpec = {
    name: 'Living Room',
    floor: room.floor ?? { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
    wall: basePaint,
    ceilingColor: typeof ceiling.color === 'string' ? ceiling.color : '#f7f5f2',
  };

  // The region key is the sorted list of the walls enclosing the room, which
  // for this rectangle is all four. Matching `regionKey` exactly here is what
  // lets the migrated room keep its floor rather than falling back to default.
  const key = walls.map((wall) => wall.id).sort().join('|');

  return {
    ...doc,
    schemaVersion: 2,
    // v1's ceiling visibility was per-room; v2 makes it a document-wide toggle.
    showCeilings: ceiling.visible === true,
    plan: {
      vertices,
      walls,
      rooms: { [key]: roomSpec },
      defaultRoom: roomSpec,
      defaultWallHeight: height,
      defaultWallThickness: thickness,
    },
    // Leave `room` behind; the validator ignores unknown keys, and keeping it
    // would double the size of every export from here on.
    room: undefined,
  };
}

/* ------------------------------- v2 -> v3 ------------------------------ */

/**
 * v3 adds furniture.
 *
 * Purely additive, so the upgrade is just an empty list — but it still goes
 * through a named step rather than being left to the validator's default. When
 * v4 arrives, the chain below has to run v2 -> v3 -> v4 in order, and a version
 * that quietly has no migration is the one that gets skipped by accident.
 */
function migrateV2ToV3(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    ...doc,
    schemaVersion: 3,
    furniture: Array.isArray(doc.furniture) ? doc.furniture : [],
  };
}

/**
 * Brings a document up to the current schema.
 *
 * Migrations are applied in sequence, so a v1 document passes through every
 * step on its way to the present. Documents already at (or somehow beyond) the
 * current version are returned untouched.
 */
export function migrateDocument(input: Record<string, unknown>): Record<string, unknown> {
  let doc = input;

  // A document with no version at all predates versioning; treat it as v1.
  const declared =
    typeof doc.schemaVersion === 'number' && Number.isFinite(doc.schemaVersion)
      ? doc.schemaVersion
      : 1;

  if (declared < 2) {
    doc = migrateV1ToV2(doc);
  }
  if (declared < 3) {
    doc = migrateV2ToV3(doc);
  }

  return doc;
}
