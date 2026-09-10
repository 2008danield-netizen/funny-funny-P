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

/* ------------------------------- v3 -> v4 ------------------------------ */

/**
 * v4 adds clearance settings and a currency label.
 *
 * Additive, and deliberately defaulting `strict` to false: an existing design
 * was laid out under no clearance rules at all, so switching them on as hard
 * constraints would greet the user with a layout their own app now refuses to
 * let them recreate.
 */
function migrateV3ToV4(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    ...doc,
    schemaVersion: 4,
    clearance:
      typeof doc.clearance === 'object' && doc.clearance !== null
        ? doc.clearance
        : { strict: false, walkwayWidth: 0.9 },
    currency: typeof doc.currency === 'string' ? doc.currency : 'EUR',
  };
}


/**
 * v4 to v5 — one plan becomes a building of one storey.
 *
 * The whole of somebody's design moves down a level, quite literally: the plan
 * they drew, the furniture they placed and the rooms they painted all become
 * the ground floor of a one-storey building. Nothing is dropped, and a document
 * that has been through this reads back exactly as it did before — there is
 * simply now a level strip above it with one entry on it.
 *
 * That has to be true. This is the fifth migration and the first that changes
 * the SHAPE of the document rather than adding to it, and a design somebody has
 * spent an evening on is not something to be casual with.
 */
function migrateV4ToV5(doc: Record<string, unknown>): Record<string, unknown> {
  const plan = doc.plan;
  const furniture = Array.isArray(doc.furniture) ? doc.furniture : [];

  // Wall height for the storey: whatever the plan was drawing walls at, since
  // that is the height the user actually chose.
  const planRecord = typeof plan === 'object' && plan !== null ? (plan as Record<string, unknown>) : {};
  const wallHeight =
    typeof planRecord.defaultWallHeight === 'number' && planRecord.defaultWallHeight > 0
      ? planRecord.defaultWallHeight
      : 2.6;

  const level = {
    id: 'lv1',
    // US convention: the storey at ground level is the First Floor.
    name: 'First Floor',
    wallHeight,
    slabThickness: 0.25,
    plan,
    furniture,
    voids: [],
  };

  const migrated: Record<string, unknown> = {
    ...doc,
    schemaVersion: 5,
    levels: [level],
    activeLevelId: 'lv1',
    stairs: [],
    roofs: [],
    site: { northAngle: 0, boundary: [], sewerConnection: null },
    services: [],
  };

  // The old top-level fields are gone; leaving them would give every reader two
  // places to look for the same plan and one of them would eventually be stale.
  delete migrated.plan;
  delete migrated.furniture;

  return migrated;
}

/**
 * v5 to v6 — the building gets an outside.
 *
 * Purely additive, which is the easy kind: a v5 document has a site with a
 * north point and nothing else, and an empty list of roofs. Both keep exactly
 * what they held; the site gains flat ground under it and the document gains a
 * default exterior finish, neither of which changes anything the user drew.
 *
 * No roof is invented. A house with a flat top is obviously unfinished, and
 * that is the honest state for a document that has never been asked about its
 * roof — better than putting a 6:12 hip on somebody's building and having them
 * discover it later on a drawing.
 */
function migrateV5ToV6(doc: Record<string, unknown>): Record<string, unknown> {
  const site =
    typeof doc.site === 'object' && doc.site !== null
      ? (doc.site as Record<string, unknown>)
      : {};

  return {
    ...doc,
    schemaVersion: 6,
    showRoofs: true,
    site: {
      northAngle: typeof site.northAngle === 'number' ? site.northAngle : 0,
      boundary: Array.isArray(site.boundary) ? site.boundary : [],
      sewerConnection: site.sewerConnection ?? null,
      terrain: { kind: 'flat', fall: 0, fallDirection: 0, spots: [], datum: -0.3 },
      ground: 'grass',
      setbacks: null,
    },
    roofs: Array.isArray(doc.roofs) ? doc.roofs : [],
    exterior: {
      cladding: 'lap-siding',
      claddingColour: '#e4ded2',
      trimColour: '#f7f5f0',
      overrides: {},
    },
  };
}

/**
 * v6 to v7 — each storey gains a plan to trace.
 *
 * Additive and empty: nobody has a traced plan yet, so every storey gets
 * `underlay: null` and nothing changes on screen. The images themselves never
 * lived in the document, so there is nothing to move.
 */
function migrateV6ToV7(doc: Record<string, unknown>): Record<string, unknown> {
  const levels = Array.isArray(doc.levels) ? doc.levels : [];

  return {
    ...doc,
    schemaVersion: 7,
    levels: levels.map((level) =>
      typeof level === 'object' && level !== null ? { ...level, underlay: null } : level,
    ),
  };
}

/**
 * v7 to v8 — the building gets its wiring.
 *
 * Additive and empty. No outlets are invented: an electrical layout is a set of
 * decisions about somebody's house, and producing forty of them unasked would
 * mean every existing design suddenly claiming to have been wired.
 */
function migrateV7ToV8(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    ...doc,
    schemaVersion: 8,
    electrical: { devices: [], circuits: [], panel: null, heatingVa: 0, coolingVa: 0 },
  };
}

/**
 * v8 to v9 — the kitchen and the bathroom.
 *
 * Additive and empty, for the same reason v7 to v8 was: a kitchen is a set of
 * decisions about somebody's house, and inventing one would mean every existing
 * design suddenly claiming to have cabinetry in it — which they would then find
 * on a drawing, and have to price.
 */
function migrateV8ToV9(doc: Record<string, unknown>): Record<string, unknown> {
  return { ...doc, schemaVersion: 9, runs: [], fixtures: [] };
}

/**
 * v9 to v10 — water and drainage.
 *
 * Additive and empty, like v7→v8 and v8→v9 before it. There is a stronger
 * reason here than for either of those: a route the app invented would carry
 * pipe sizes, falls and vent positions that read as designed, and somebody
 * would build from them. An empty plumbing plan says honestly that nothing has
 * been worked out yet.
 *
 * The site gains a water-service point alongside the sewer connection it has
 * had since v6, defaulting to null so the router can say it is assuming a
 * position rather than pretending one was given.
 */
function migrateV9ToV10(doc: Record<string, unknown>): Record<string, unknown> {
  const site =
    doc.site && typeof doc.site === 'object' ? (doc.site as Record<string, unknown>) : {};

  return {
    ...doc,
    schemaVersion: 10,
    site: { ...site, waterService: site.waterService ?? null },
    plumbing: {
      drainage: [],
      supply: [],
      stacks: [],
      connections: [],
      heater: null,
      mainPressureKpa: 414,
      mainPressureMeasured: false,
    },
  };
}

/**
 * v10 to v11 — heating and cooling.
 *
 * Additive, and the location is left EMPTY on purpose. Every other migration
 * here supplies a sensible default; there is no sensible default climate. A
 * load computed for the wrong city is not approximately right, it is
 * confidently wrong, and it looks exactly as authoritative as a correct one —
 * so the app declines to compute one until somebody says where the house is.
 *
 * The envelope does get defaults, marked unconfirmed, so the panel can say out
 * loud that the figures underneath the load are still assumptions.
 */
function migrateV10ToV11(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    ...doc,
    schemaVersion: 11,
    hvac: {
      locationKey: '',
      envelope: {
        wallAssemblyId: 'wall-2x6-r21',
        roofAssemblyId: 'roof-r49',
        floorAssemblyId: 'floor-slab',
        glazingId: 'double-lowe',
        doorId: 'door-insulated-steel',
        infiltrationId: 'average',
        confirmed: false,
      },
      system: 'forced-air',
      heatingEquipmentId: null,
      coolingEquipmentId: null,
      ducts: [],
      registers: [],
      airHandler: null,
      emitters: [],
      equipmentManual: false,
    },
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
  if (declared < 4) {
    doc = migrateV3ToV4(doc);
  }
  if (declared < 5) {
    doc = migrateV4ToV5(doc);
  }
  if (declared < 6) {
    doc = migrateV5ToV6(doc);
  }
  if (declared < 7) {
    doc = migrateV6ToV7(doc);
  }
  if (declared < 8) {
    doc = migrateV7ToV8(doc);
  }
  if (declared < 9) {
    doc = migrateV8ToV9(doc);
  }
  if (declared < 10) {
    doc = migrateV9ToV10(doc);
  }
  if (declared < 11) {
    doc = migrateV10ToV11(doc);
  }

  return doc;
}
