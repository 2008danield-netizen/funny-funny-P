/**
 * The furnisher: laying out a room from an empty floor.
 *
 * -----------------------------------------------------------------------------
 * HOW IT WORKS, AND WHY IT IS NOT RANDOM.
 *
 * Real rooms are laid out from ANCHORS. You do not scatter furniture and check
 * for collisions; you decide where the bed goes, and everything else in the
 * room is defined relative to it — bedsides flanking it, wardrobe on the wall it
 * does not use, lamp beside the chair that faces it. Get the anchor right and
 * the rest follows; get it wrong and no amount of shuffling saves the room.
 *
 * So each program below is written the way a person lays a room out:
 *
 *   1. Place the anchor on the best wall for it (longest blank stretch, no
 *      window behind the headboard, and so on).
 *   2. Place everything that is defined RELATIVE to the anchor, at the
 *      distances the guidelines in `types.ts` actually specify.
 *   3. Fill the leftovers — storage on remaining walls, a lamp in a corner.
 *
 * Every placement goes through `placeFurniture`, the same operation a mouse
 * drag uses, and every position is checked for legality BEFORE it is attempted
 * so nothing is silently nudged out of the arrangement it was chosen for. A
 * piece that will not fit is skipped and reported, never forced.
 *
 * The output is explicitly a FIRST DRAFT. It is a starting point that obeys the
 * guidelines, which is a much better place to begin pushing furniture around
 * than an empty floor — not a finished room, and the panel says so.
 * -----------------------------------------------------------------------------
 */

import { getCatalogEntry, type CatalogEntry } from '@/furniture/catalog';
import { placeFurniture, removeFurniture } from '@/state/furnitureOps';
import { findRegions, type Region } from '@/scene/planGraph';
import { pointInPolygon, type Collider, type Obb } from '@/physics/collision';
import { itemFootprint } from '@/physics/colliders';
import { analyseCirculation } from '@/clearance/circulation';
import {
  CLEARANCE_DEFAULTS,
  type DesignDocument,
  type FurnitureItem,
  type Level,
  type Point2,
} from '@/state/types';
import {
  add,
  blankSpans,
  distanceToWalls,
  dot,
  forwardOf,
  Placer,
  rightOf,
  roomFrame,
  roomWalls,
  rotationFacing,
  scale,
  seatAgainst,
  spanLength,
  tablePerimeterSlots,
  type RoomFrame,
  type RoomWall,
} from './geometry';
import { GUIDELINES, type RoomProgram } from './types';

/**
 * The look the generator reaches for when choosing colourways.
 *
 * Only colours are affected — the same pieces are chosen either way. Style in
 * this app is a palette, not a different catalogue, because the catalogue is
 * one retailer's range and pretending otherwise would be inventing products.
 */
export type FurnishStyle = 'warm' | 'calm' | 'monochrome' | 'bold';

/** Colourway IDs each style prefers, best first. */
const STYLE_COLOURWAYS: Record<FurnishStyle, readonly string[]> = {
  warm: ['rust', 'linen', 'oak', 'pine', 'birch'],
  calm: ['sage', 'linen', 'white', 'birch', 'oak'],
  monochrome: ['charcoal', 'white', 'black-brown', 'oak'],
  bold: ['navy', 'rust', 'black-brown', 'charcoal'],
};

export interface FurnishOptions {
  /** What the room is for. 'unknown' lets the generator decide from its size. */
  program?: RoomProgram;
  /** A ceiling on the estimated total, in the document's nominal currency. */
  budget?: number | null;
  style?: FurnishStyle;
  /** Clear whatever is already in the room first. */
  clearExisting?: boolean;
}

export interface FurnishResult {
  /** IDs of the pieces placed. */
  placed: string[];
  /** How many existing pieces were cleared out. */
  removed: number;
  /** What could not be placed, and why. Shown to the user verbatim. */
  skipped: Array<{ what: string; reason: string }>;
  /** Estimated spend, from the catalogue's own rough figures. */
  spend: number;
  program: RoomProgram;
}

/* --------------------------- The build context ------------------------- */

/** Everything a program function needs, and the tools to place with. */
interface Build {
  doc: DesignDocument;
  level: Level;
  region: Region;
  walls: RoomWall[];
  frame: RoomFrame;
  placer: Placer;
  style: FurnishStyle;
  /** Remaining budget, or null for no ceiling. */
  remaining: number | null;
  spend: number;
  placed: string[];
  skipped: Array<{ what: string; reason: string }>;
  /** Walls already carrying a large piece, so storage does not stack up. */
  usedWalls: Set<string>;
  /**
   * What can be taken back out if the room turns out too full to walk through,
   * least important first. The anchor piece is never in here.
   */
  removable: Array<{ id: string; what: string; priority: number }>;
}

/**
 * Whether a piece is simply too big for the room, whatever the floor plan says
 * about where it would fit.
 *
 * "It fits" and "it belongs" are different questions, and only the second one
 * makes a room worth looking at. A 2.18 m sofa slides neatly along the wall of
 * a 3.4 m room and leaves a corridor rather than a living room — which is
 * exactly what the advisor's own scale rule then says about it. Without this
 * check the generator produces layouts its own critic marks down, and the user
 * watches the two halves of the app disagree.
 *
 * Rugs are exempt: a rug is meant to be large, and the whole point of one is to
 * reach under the furniture standing on it.
 */
function tooBigForRoom(build: Build, entry: CatalogEntry): boolean {
  if (entry.layer === 'floor') return false;
  const widest = Math.max(entry.width, entry.depth);
  return widest > GUIDELINES.dominantWidth * build.frame.shortSpan;
}

/**
 * Attempts one piece at an exact position and angle.
 *
 * Candidates are tried in order and the first that fits wins, so a program can
 * express "a three-seat sofa if there is room, a two-seat if not, and nothing
 * rather than something absurd" as a list.
 */
function place(
  build: Build,
  what: string,
  candidates: readonly string[],
  at: Point2,
  rotation: number,
  options: { required?: boolean; priority?: number } = {},
): FurnitureItem | null {
  let budgetBlocked = false;

  for (const catalogId of candidates) {
    const entry = getCatalogEntry(catalogId);
    const cost = entry.price?.amount ?? 0;

    if (build.remaining !== null && cost > build.remaining) {
      budgetBlocked = true;
      continue;
    }

    if (tooBigForRoom(build, entry)) continue;

    const box: Obb = {
      center: at,
      halfWidth: entry.width / 2,
      halfDepth: entry.depth / 2,
      rotation,
    };

    // Rugs lie on the floor: they must stay inside the room and off the walls,
    // but everything else stands on top of them.
    const isRug = entry.layer === 'floor';
    if (!build.placer.fits(box, build.region, { isRug })) continue;

    const result = placeFurniture(build.doc, build.level, catalogId, at, { rotation, snapWalls: false });
    if (!result.id) continue;

    const item = build.level.furniture.find((candidate) => candidate.id === result.id);
    if (item) applyStyle(item, entry, build.style);

    build.placer.setFurniture(build.level.furniture);
    build.placed.push(result.id);
    // A required piece is the reason the room exists; everything else can be
    // taken back out if the layout turns out too tight to walk through.
    if (!options.required) {
      build.removable.push({
        id: result.id,
        what,
        priority: options.priority ?? 5,
      });
    }
    build.spend += cost;
    if (build.remaining !== null) build.remaining -= cost;
    return item ?? null;
  }

  build.skipped.push({
    what,
    reason: budgetBlocked ? 'over the remaining budget' : 'nowhere it fits',
  });
  // `required` is reported the same way but named, so the panel can say the
  // room could not be laid out at all rather than listing a missing lamp.
  if (options.required) build.skipped[build.skipped.length - 1]!.what = `${what} (the room's main piece)`;
  return null;
}

/** Gives a placed piece the colourway its style prefers, if the entry has one. */
function applyStyle(item: FurnitureItem, entry: CatalogEntry, style: FurnishStyle): void {
  for (const wanted of STYLE_COLOURWAYS[style]) {
    if (entry.colorways.some((colourway) => colourway.id === wanted)) {
      item.colorwayId = wanted;
      return;
    }
  }
}

/**
 * Sweeps a wall for somewhere a piece of this size will sit.
 *
 * Positions are tried from the centre of each blank span outwards, because the
 * middle of a wall is where a large piece belongs — a sofa jammed into the
 * corner of a wall it could have been centred on is the layout looking like it
 * was done by a machine.
 */
function seatOnWall(
  build: Build,
  wall: RoomWall,
  width: number,
  depth: number,
  options: { catalogId?: string } = {},
): { at: Point2; rotation: number } | null {
  const isRug = options.catalogId
    ? getCatalogEntry(options.catalogId).layer === 'floor'
    : false;

  for (const span of blankSpans(wall, 0.06, width)) {
    if (spanLength(span) < width) continue;

    const middle = (span.from + span.to) / 2;
    const reach = (spanLength(span) - width) / 2;

    // Centre first, then outwards in 8 cm steps to either side.
    const offsets: number[] = [0];
    for (let step = 0.08; step <= reach; step += 0.08) {
      offsets.push(step, -step);
    }

    for (const offset of offsets) {
      const at = seatAgainst(wall, middle + offset, depth / 2, 0.015);
      const box: Obb = {
        center: at,
        halfWidth: width / 2,
        halfDepth: depth / 2,
        rotation: wall.seatRotation,
      };
      if (build.placer.fits(box, build.region, { isRug })) {
        return { at, rotation: wall.seatRotation };
      }
    }
  }

  return null;
}

/**
 * Ranks walls for a piece that wants one.
 *
 * The score is the longest blank stretch on the wall, penalised for windows and
 * doors and for already carrying something large. It is deliberately simple:
 * "the longest clear wall that is not already busy" is how anybody would pick,
 * and a cleverer heuristic here would be harder to predict without being better.
 */
function rankWalls(
  build: Build,
  options: { avoidWindow?: boolean; avoidDoor?: boolean } = {},
): RoomWall[] {
  return [...build.walls]
    .map((wall) => {
      const longest = Math.max(
        0,
        ...blankSpans(wall, 0.06, 0).map(spanLength),
      );
      let score = longest;
      if (options.avoidWindow && wall.hasWindow) score -= 100;
      if (options.avoidDoor && wall.hasDoor) score -= 40;
      if (build.usedWalls.has(wall.wallId)) score -= 25;
      return { wall, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.wall);
}

/**
 * Places a piece on the best wall that will take it.
 *
 * The two reasons a piece does not get placed are reported separately, and the
 * distinction matters to the user: "no wall long enough" means change the room,
 * "over the remaining budget" means change the number. Reporting the first when
 * the second is true sends somebody off redrawing walls that were fine.
 */
function placeOnWall(
  build: Build,
  what: string,
  candidates: readonly string[],
  options: {
    avoidWindow?: boolean;
    avoidDoor?: boolean;
    required?: boolean;
    priority?: number;
  } = {},
): FurnitureItem | null {
  let budgetBlocked = false;
  let anyAffordable = false;

  for (const catalogId of candidates) {
    const entry = getCatalogEntry(catalogId);
    if (build.remaining !== null && (entry.price?.amount ?? 0) > build.remaining) {
      budgetBlocked = true;
      continue;
    }
    if (tooBigForRoom(build, entry)) continue;
    anyAffordable = true;

    for (const wall of rankWalls(build, options)) {
      const seat = seatOnWall(build, wall, entry.width, entry.depth, { catalogId });
      if (!seat) continue;

      const item = place(build, what, [catalogId], seat.at, seat.rotation, {
        required: options.required,
        priority: options.priority,
      });
      if (item) {
        build.usedWalls.add(wall.wallId);
        return item;
      }
      // `place` records its own skip on failure; this loop reports the whole
      // slot once at the end instead.
      build.skipped.pop();
    }
  }

  build.skipped.push({
    what: options.required ? `${what} (the room's main piece)` : what,
    reason:
      budgetBlocked && !anyAffordable
        ? 'over the remaining budget'
        : 'no wall long enough',
  });
  return null;
}

/**
 * Somewhere for a floor lamp: a corner first, then beside a seat.
 *
 * The order is the whole of it. Asking "where is there space next to the
 * armchair" and taking the first answer puts the lamp in the middle of the
 * floor, right between the sofa and the chair — legal, lit, and standing in the
 * one part of the room people walk through. A floor lamp belongs at the EDGE of
 * a seating group: in the corner behind the chair, or beside the arm of the
 * sofa against the wall. So corners are tried first, and seat-side positions
 * are ranked by how close to a wall they are.
 */
function placeLamp(build: Build, beside: FurnitureItem | null): void {
  const entry = getCatalogEntry('hektar-floor');
  const half = Math.max(entry.width, entry.depth) / 2;
  const candidates: Point2[] = [];

  // The room's corners, pulled inside by the lamp's own radius.
  const polygon = build.region.polygon;
  for (let i = 0; i < polygon.length; i++) {
    const corner = polygon[i]!;
    const prev = polygon[(i - 1 + polygon.length) % polygon.length]!;
    const next = polygon[(i + 1) % polygon.length]!;
    const bisector = unit(
      add(
        unit({ x: prev.x - corner.x, z: prev.z - corner.z }),
        unit({ x: next.x - corner.x, z: next.z - corner.z }),
      ),
    );
    if (bisector.x === 0 && bisector.z === 0) continue;
    candidates.push(add(corner, scale(bisector, half * 2.2)));
  }

  // Then either side of the anchor piece, nearest the wall first.
  if (beside) {
    const side = rightOf(beside.rotation);
    const reach = getCatalogEntry(beside.catalogId).width / 2 + half + 0.1;
    const sides = [1, -1]
      .map((sign) => add({ x: beside.x, z: beside.z }, scale(side, sign * reach)))
      .sort(
        (a, b) => distanceToWalls(a, build.region) - distanceToWalls(b, build.region),
      );
    candidates.push(...sides);
  }

  for (const candidate of candidates) {
    if (distanceToWalls(candidate, build.region) < half + 0.05) continue;
    const facing = unit({
      x: build.region.interiorPoint.x - candidate.x,
      z: build.region.interiorPoint.z - candidate.z,
    });
    const rotation = facing.x === 0 && facing.z === 0 ? 0 : rotationFacing(facing);
    // A floor lamp, never a table lamp: a table lamp with no table to stand on
    // is not a lamp, it is a trip hazard.
    if (place(build, 'a floor lamp', ['hektar-floor', 'not-floor'], candidate, rotation, {
      priority: 8,
    })) {
      return;
    }
    // `place` records a skip on failure; drop it and keep looking.
    build.skipped.pop();
  }

  build.skipped.push({ what: 'a floor lamp', reason: 'no clear corner for it' });
}

function unit(v: Point2): Point2 {
  const span = Math.hypot(v.x, v.z);
  if (span < 1e-9) return { x: 0, z: 0 };
  return { x: v.x / span, z: v.z / span };
}

/* ------------------------------- Programs ------------------------------ */

/**
 * A living room, built outwards from the sofa.
 *
 * The sofa is the anchor because it is the only piece whose position the rest
 * of the room genuinely depends on: the coffee table is defined by a reach from
 * it, the rug by the group it draws round, the television by the wall the sofa
 * faces, and the armchair by the conversation distance across to it.
 */
function furnishLiving(build: Build): void {
  const area = build.region.area;

  const sofa = placeOnWall(
    build,
    'a sofa',
    // In anything under about 13 m² a three-seat sofa is the wrong piece even
    // if it fits, and in a really small room the last resort is an armchair —
    // seating you can sit in beats a sofa you have to edge round.
    area >= 20
      ? ['kivik-3', 'ektorp-3', 'soderhamn-3', 'klippan-2']
      : area >= 13
        ? ['ektorp-3', 'soderhamn-3', 'klippan-2']
        : ['klippan-2', 'poang'],
    { avoidWindow: true, avoidDoor: true, required: true },
  );

  if (!sofa) return;

  const sofaEntry = getCatalogEntry(sofa.catalogId);
  const forward = forwardOf(sofa.rotation);
  const sofaCenter = { x: sofa.x, z: sofa.z };

  // The coffee table, at the middle of the published 30-45 cm reach.
  const table = tryCoffeeTable(build, sofa, sofaEntry.depth / 2, forward, sofaCenter);

  // The television, on the wall the sofa looks at.
  const facingWall = build.walls
    .map((wall) => ({ wall, alignment: dot(wall.inward, scale(forward, -1)) }))
    .sort((a, b) => b.alignment - a.alignment)[0];

  if (facingWall && facingWall.alignment > 0.6) {
    const tv = getCatalogEntry('besta-tv');
    if (!tooBigForRoom(build, tv)) {
      const seat = seatOnWall(build, facingWall.wall, tv.width, tv.depth, {
        catalogId: 'besta-tv',
      });
      if (seat) {
        place(build, 'a television unit', ['besta-tv'], seat.at, seat.rotation, { priority: 3 });
        build.usedWalls.add(facingWall.wall.wallId);
      }
    }
  }

  // An armchair at an angle to the sofa, inside talking distance.
  const anchor = table ? { x: table.x, z: table.z } : sofaCenter;
  let armchair: FurnitureItem | null = null;
  for (const sign of [1, -1]) {
    const side = rightOf(sofa.rotation);
    const spot = add(add(anchor, scale(side, sign * 1.5)), scale(forward, 0.35));
    const toGroup = unit({ x: anchor.x - spot.x, z: anchor.z - spot.z });
    if (toGroup.x === 0 && toGroup.z === 0) continue;
    armchair = place(build, 'an armchair', ['strandmon', 'poang'], spot, rotationFacing(toGroup), {
      priority: 2,
    });
    if (armchair) break;
    build.skipped.pop();
  }
  if (!armchair) build.skipped.push({ what: 'an armchair', reason: 'no room beside the sofa' });

  /*
   * The rug goes down LAST of the seating group, not first.
   *
   * Its job is to draw a boundary round the whole group, so it can only be
   * sized and centred once the group exists — laying it under the sofa and then
   * adding an armchair beside it produces exactly the "rug off to one side"
   * finding the advisor raises, with the generator as the culprit. Rugs pass
   * under everything, so placing one late costs nothing.
   */
  layRug(build, [sofa, table, armchair], sofa.rotation);

  // A side table within reach of one end of the sofa.
  for (const sign of [1, -1]) {
    const side = rightOf(sofa.rotation);
    const spot = add(sofaCenter, scale(side, sign * (sofaEntry.width / 2 + 0.32)));
    if (place(build, 'a side table', ['lack-side'], spot, sofa.rotation, { priority: 9 })) break;
    build.skipped.pop();
  }

  placeLamp(build, armchair ?? sofa);

  if (area >= 16) {
    placeOnWall(build, 'a bookcase', ['billy-80', 'billy-40'], {
      avoidWindow: true,
      avoidDoor: true,
      priority: 7,
    });
  }
}


/**
 * A rug under a seating group, sized to reach the whole of it.
 *
 * Candidates are tried largest first and the first that fits wins: a rug too
 * small for the group it sits under is the "postage stamp" mistake, and a
 * bigger rug is almost always the better answer where the floor allows one.
 */
function layRug(
  build: Build,
  group: ReadonlyArray<FurnitureItem | null>,
  rotation: number,
): void {
  const members = group.filter((item): item is FurnitureItem => item !== null);
  if (members.length === 0) return;

  let cx = 0;
  let cz = 0;
  for (const member of members) {
    cx += member.x;
    cz += member.z;
  }
  const center = { x: cx / members.length, z: cz / members.length };

  for (const rugId of ['stockholm-rug', 'stoense-rug', 'morum-rug']) {
    // A rug obstructs nothing, so it is never worth trimming for circulation.
    if (place(build, 'a rug', [rugId], center, rotation, { priority: 0 })) return;
    build.skipped.pop();
  }
  build.skipped.push({ what: 'a rug', reason: 'no clear floor for one' });
}

/** The coffee table, at a reach the guidelines actually name. */
function tryCoffeeTable(
  build: Build,
  sofa: FurnitureItem,
  sofaHalfDepth: number,
  forward: Point2,
  sofaCenter: Point2,
): FurnitureItem | null {
  for (const tableId of ['lisabo-coffee', 'lack-coffee', 'vittsjo-coffee']) {
    const entry = getCatalogEntry(tableId);
    // 37.5 cm: the middle of the 30-45 cm range in GUIDELINES.coffeeTableGap.
    const center = add(sofaCenter, scale(forward, sofaHalfDepth + 0.375 + entry.depth / 2));
    const table = place(build, 'a coffee table', [tableId], center, sofa.rotation);
    if (table) return table;
    build.skipped.pop();
  }
  build.skipped.push({ what: 'a coffee table', reason: 'not enough floor in front of the sofa' });
  return null;
}

/**
 * A bedroom, built outwards from the bed.
 *
 * The bed goes on the longest blank wall with no window in it, which is the
 * single decision the whole room turns on. Bedsides flank it; storage takes the
 * walls the bed did not.
 */
function furnishBedroom(build: Build): void {
  const area = build.region.area;

  const bed = placeOnWall(
    build,
    'a bed',
    area >= 14 ? ['malm-bed-160', 'malm-bed-140', 'slattum-140'] : ['malm-bed-140', 'slattum-140'],
    { avoidWindow: true, avoidDoor: true, required: true },
  );

  if (!bed) return;

  const bedEntry = getCatalogEntry(bed.catalogId);
  const side = rightOf(bed.rotation);
  const forward = forwardOf(bed.rotation);
  const bedCenter = { x: bed.x, z: bed.z };

  // Bedsides, flanking the headboard rather than the middle of the bed — a
  // bedside table beside your knees is not a bedside table.
  const bedside = getCatalogEntry('lack-side');
  const headOffset = -(bedEntry.depth / 2) + bedside.depth / 2;
  let bedsides = 0;
  for (const sign of [1, -1]) {
    const spot = add(
      add(bedCenter, scale(side, sign * (bedEntry.width / 2 + bedside.width / 2 + 0.04))),
      scale(forward, headOffset),
    );
    if (place(build, 'a bedside table', ['lack-side'], spot, bed.rotation, { priority: 3 })) {
      bedsides += 1;
    }
    else build.skipped.pop();
  }
  if (bedsides === 0) {
    build.skipped.push({ what: 'bedside tables', reason: 'no room either side of the bed' });
  }

  placeOnWall(build, 'a wardrobe', area >= 12 ? ['pax-150', 'pax-100'] : ['pax-100'], {
    avoidWindow: true,
    avoidDoor: true,
    priority: 2,
  });

  if (area >= 11) {
    placeOnWall(build, 'a chest of drawers', ['malm-chest-6'], {
      avoidDoor: true,
      priority: 7,
    });
  }

  placeLamp(build, bed);
}

/**
 * A dining room, built outwards from the table.
 *
 * The table is the one piece that belongs in the middle of the floor rather
 * than against a wall, and it is laid out along the room's grain so a long
 * table runs down a long room rather than across it.
 */
function furnishDining(build: Build): void {
  const area = build.region.area;

  // The table's own X axis is its width, so setting its rotation to the room's
  // grain angle runs its length down the room.
  const rotation = build.frame.angle;
  const center = build.region.interiorPoint;

  const table = place(
    build,
    'a dining table',
    area >= 18
      ? ['skogsta-table', 'ekedalen-table', 'docksta-table', 'lerhamn-table']
      : area >= 11
        ? ['ekedalen-table', 'docksta-table', 'lerhamn-table']
        : ['lerhamn-table', 'docksta-table'],
    center,
    rotation,
    { required: true },
  );

  if (!table) return;

  const tableEntry = getCatalogEntry(table.catalogId);
  const chairEntry = getCatalogEntry('ingolf-chair');
  const slots = tablePerimeterSlots(
    {
      center: { x: table.x, z: table.z },
      halfWidth: tableEntry.width / 2,
      halfDepth: tableEntry.depth / 2,
      rotation: table.rotation,
    },
    chairEntry.depth / 2,
  );

  let seated = 0;
  for (const slot of slots) {
    if (
      place(build, 'a dining chair', ['ingolf-chair', 'stefan-chair'], slot.at, slot.rotation, {
        priority: 1,
      })
    ) {
      seated += 1;
    } else {
      build.skipped.pop();
    }
  }
  if (seated < slots.length) {
    build.skipped.push({
      what: `${slots.length - seated} dining chair${slots.length - seated === 1 ? '' : 's'}`,
      reason: 'not enough room round the table',
    });
  }

  placeOnWall(build, 'a sideboard', ['hemnes-chest-8', 'malm-chest-6', 'kallax-2x4'], {
    avoidWindow: true,
    avoidDoor: true,
    priority: 7,
  });

  placeLamp(build, null);
}

/**
 * A workspace, built outwards from the desk.
 *
 * The desk wall is chosen to put any window to the SIDE of the screen rather
 * than in front of or behind it, which is the one arrangement every ergonomics
 * guide agrees on and the one nobody gets by accident.
 */
function furnishOffice(build: Build): void {
  const area = build.region.area;
  const deskIds = area >= 9 ? ['bekant-desk', 'micke-desk'] : ['micke-desk'];

  const desk = placeDeskAwayFromGlare(build, deskIds);
  if (!desk) {
    build.skipped.push({ what: 'a desk (the room’s main piece)', reason: 'no wall long enough' });
    return;
  }

  const deskEntry = getCatalogEntry(desk.catalogId);
  const forward = forwardOf(desk.rotation);
  const deskCenter = { x: desk.x, z: desk.z };
  const chair = getCatalogEntry('markus-chair');

  // The chair sits in front of the desk, turned to face it.
  const spot = add(deskCenter, scale(forward, deskEntry.depth / 2 + chair.depth / 2 + 0.1));
  if (
    !place(build, 'a desk chair', ['markus-chair', 'odger-chair'], spot, desk.rotation + Math.PI, {
      priority: 1,
    })
  ) {
    build.skipped.pop();
    build.skipped.push({ what: 'a desk chair', reason: 'not enough room in front of the desk' });
  }

  // A drawer unit tucked beside the desk, not under it: the app models
  // footprints, not the space under a desktop.
  const side = rightOf(desk.rotation);
  const drawers = getCatalogEntry('alex-drawers');
  for (const sign of [1, -1]) {
    const at = add(deskCenter, scale(side, sign * (deskEntry.width / 2 + drawers.width / 2 + 0.03)));
    if (place(build, 'a drawer unit', ['alex-drawers'], at, desk.rotation, { priority: 6 })) break;
    build.skipped.pop();
  }

  if (area >= 8) {
    placeOnWall(build, 'a bookcase', ['billy-80', 'billy-40', 'kallax-2x4'], {
      avoidWindow: true,
      priority: 7,
    });
  }

  placeLamp(build, desk);
}

/**
 * Picks the desk wall by how a window would fall relative to the screen.
 *
 * Straight ahead of the desk is behind the user (reflections); straight behind
 * it is in front of the user (a backlit screen). A window at 90 degrees to the
 * screen is the target, so walls are scored by how close to side-on the
 * brightest window lands, and a room with no windows falls back to the longest
 * blank wall like everything else.
 */
function placeDeskAwayFromGlare(
  build: Build,
  deskIds: readonly string[],
): FurnitureItem | null {
  const windows: Point2[] = [];
  for (const wall of build.walls) {
    for (const opening of wall.segment.wall.openings) {
      if (opening.kind !== 'window') continue;
      const t = opening.offset / Math.max(1e-6, wall.length);
      windows.push({
        x: wall.faceStart.x + (wall.faceEnd.x - wall.faceStart.x) * t,
        z: wall.faceStart.z + (wall.faceEnd.z - wall.faceStart.z) * t,
      });
    }
  }

  for (const deskId of deskIds) {
    const entry = getCatalogEntry(deskId);

    const scored = rankWalls(build, { avoidDoor: true })
      .map((wall) => {
        const seat = seatOnWall(build, wall, entry.width, entry.depth, { catalogId: deskId });
        if (!seat) return null;
        // A desk against a wall faces into the room, so the screen looks along
        // the wall's inward normal.
        const screen = forwardOf(seat.rotation);
        let glare = 0;
        for (const window of windows) {
          const toWindow = unit({ x: window.x - seat.at.x, z: window.z - seat.at.z });
          // 1 when the window is dead ahead or dead behind, 0 when side-on.
          glare = Math.max(glare, Math.abs(dot(toWindow, screen)));
        }
        return { seat, glare };
      })
      .filter((entry): entry is { seat: { at: Point2; rotation: number }; glare: number } => entry !== null)
      .sort((a, b) => a.glare - b.glare);

    for (const option of scored) {
      const desk = place(build, 'a desk', [deskId], option.seat.at, option.seat.rotation);
      if (desk) return desk;
      build.skipped.pop();
    }
  }

  return null;
}


/* ---------------------------- Room to walk in --------------------------- */

/**
 * Takes pieces back out until you can walk through the room.
 *
 * "It fits" is a collision test and it is not the standard a room is judged by.
 * A generator that fills every legal square of a 14 m² living room produces a
 * layout its own advisor immediately reports as a squeeze — and it is right to,
 * because you cannot get to the sofa. Restraint is part of laying a room out,
 * and it is the part a naive generator has no notion of.
 *
 * So the last step is subtraction. Optional pieces come out one at a time, least
 * important first, until the widest available route through the room clears the
 * tight-squeeze threshold. The anchor never goes: a living room without a sofa
 * is not a tidier living room.
 *
 * What comes out is reported, not hidden. "No room for a side table" is useful
 * information about the room — often more useful than the side table.
 */
function relieveCirculation(build: Build): void {
  // Each removal changes the answer, so this is a loop. It is bounded by the
  // number of removable pieces, which is single digits.
  for (let guard = 0; guard < 12; guard++) {
    const inside = roomOccupants(build);
    if (inside.length === 0) return;

    const before = routeWidth(build, inside);
    if (!isBlocked(before)) return;

    /*
     * Which piece to take out is NOT simply the least important one.
     *
     * An earlier version removed in importance order and emptied half the room
     * to fix a pinch a single bookcase was causing — the side table and the
     * lamp went first because they mattered least, neither made any difference,
     * and the bookcase responsible was the third thing to go. Removing
     * something that does not help is pure loss: the room gets emptier and the
     * route stays exactly as narrow.
     *
     * So each candidate is tried, least important first, and the search stops
     * at the first one whose removal actually clears the route. Failing that it
     * takes whichever helps most, and if nothing helps at all it stops rather
     * than stripping the room for no gain.
     */
    const candidates = build.removable
      .filter(
        (candidate) =>
          // Priority 0 obstructs nothing (a rug); removing it cannot help.
          candidate.priority > 0 &&
          build.level.furniture.some((item) => item.id === candidate.id),
      )
      // Least important first.
      .sort((a, b) => b.priority - a.priority);

    let choice: { index: number; route: { narrowest: number; maroonedArea: number } } | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const without = inside.filter((item) => item.id !== candidates[i]!.id);
      const route = routeWidth(build, without);

      if (!isBlocked(route)) {
        choice = { index: i, route };
        break;
      }
      if (!choice || route.narrowest > choice.route.narrowest) choice = { index: i, route };
    }

    // Nothing on offer improves matters — stop rather than empty the room.
    if (!choice || choice.route.narrowest <= before.narrowest + 1e-6) return;

    const victim = candidates[choice.index]!;
    const item = build.level.furniture.find((candidate) => candidate.id === victim.id);
    const refund = item ? (getCatalogEntry(item.catalogId).price?.amount ?? 0) : 0;

    removeFurniture(build.level, victim.id);
    build.removable = build.removable.filter((entry) => entry.id !== victim.id);
    build.placed = build.placed.filter((id) => id !== victim.id);
    // Give the money back, or the reported spend counts a piece that is no
    // longer in the room and the shopping list disagrees with the panel.
    build.spend -= refund;
    if (build.remaining !== null) build.remaining += refund;
    build.skipped.push({
      what: victim.what,
      reason: 'it left too little room to walk through',
    });
  }
}

/** The standing furniture inside the room being furnished. */
function roomOccupants(build: Build): FurnitureItem[] {
  return build.level.furniture.filter(
    (item) =>
      getCatalogEntry(item.catalogId).layer !== 'floor' &&
      pointInPolygon({ x: item.x, z: item.z }, build.region.polygon),
  );
}

/** How narrow the room's main route gets, and how much floor is cut off. */
function routeWidth(
  build: Build,
  occupants: readonly FurnitureItem[],
): { narrowest: number; maroonedArea: number } {
  const obstacles: Collider[] = occupants.map((item) => ({
    kind: 'furniture',
    id: item.id,
    ...itemFootprint(item),
  }));

  const report = analyseCirculation(
    build.region,
    obstacles,
    doorwaysOf(build.level, build.region),
    build.doc.clearance.walkwayWidth,
  );

  return {
    narrowest: report.narrowestRoute,
    maroonedArea: report.marooned.length * CLEARANCE_DEFAULTS.gridCell ** 2,
  };
}

/** Whether a room in that state is one you cannot reasonably walk through. */
function isBlocked({ narrowest, maroonedArea }: { narrowest: number; maroonedArea: number }): boolean {
  // A couple of stray cells behind a bookcase is noise; a fifth of a square
  // metre is a pocket somebody genuinely cannot reach.
  if (maroonedArea >= 0.2) return true;
  return narrowest > 0 && narrowest < CLEARANCE_DEFAULTS.walkwayTight;
}

/**
 * Where a room is entered from, for the circulation walk.
 *
 * Duplicated in spirit from `clearance/analyze.ts`, which keeps this private;
 * exporting it from there would widen that module's surface for one caller, and
 * the logic is four lines.
 */
function doorwaysOf(level: Level, region: Region): Point2[] {
  const points: Point2[] = [];
  for (const wall of roomWalls(level.plan, region)) {
    for (const opening of wall.segment.wall.openings) {
      if (opening.kind !== 'door') continue;
      const t = opening.offset / Math.max(1e-6, wall.length);
      points.push({
        x: wall.faceStart.x + (wall.faceEnd.x - wall.faceStart.x) * t,
        z: wall.faceStart.z + (wall.faceEnd.z - wall.faceStart.z) * t,
      });
    }
  }
  return points;
}

/* -------------------------------- Entry -------------------------------- */

/**
 * Chooses a program for a room nobody has told us the purpose of.
 *
 * Size is the only signal available, and it is a weak one, so the UI always
 * shows the choice and lets it be changed. A living room is the default
 * because it is both the most common room and the most forgiving one to get
 * wrong — the pieces are movable and nothing about the layout is structural.
 */
export function suggestProgram(area: number): Exclude<RoomProgram, 'unknown'> {
  if (area < 7) return 'office';
  if (area < 11) return 'bedroom';
  return 'living';
}

/**
 * Furnishes one room.
 *
 * Mutates the draft, so call it inside `designStore.edit` — the whole layout
 * then lands as a single undo step, which matters when a generated room a user
 * does not like would otherwise take fourteen presses of Ctrl+Z to remove.
 */
export function furnishRoom(
  doc: DesignDocument,
  level: Level,
  roomKey: string,
  options: FurnishOptions = {},
): FurnishResult {
  const region = findRegions(level.plan).find((candidate) => candidate.key === roomKey);
  if (!region) {
    return {
      placed: [],
      removed: 0,
      skipped: [{ what: 'the layout', reason: 'that room is no longer in the plan' }],
      spend: 0,
      program: 'unknown',
    };
  }

  let removed = 0;
  if (options.clearExisting) {
    const inside = level.furniture.filter((item) =>
      pointInPolygon({ x: item.x, z: item.z }, region.polygon),
    );
    for (const item of inside) removeFurniture(level, item.id);
    removed = inside.length;
  }

  const requested = options.program ?? 'unknown';
  const program = requested === 'unknown' ? suggestProgram(region.area) : requested;

  const build: Build = {
    doc,
    level,
    region,
    walls: roomWalls(level.plan, region),
    frame: roomFrame(level.plan, region),
    // Required clearances are respected, so the generator will not park a
    // wardrobe where a door opens — the one thing a person laying a room out
    // never does and a naive generator always does.
    placer: new Placer(level.plan, level.furniture, { respectClearance: true }),
    style: options.style ?? 'calm',
    remaining: options.budget ?? null,
    spend: 0,
    placed: [],
    skipped: [],
    usedWalls: new Set(),
    removable: [],
  };

  switch (program) {
    case 'living':
      furnishLiving(build);
      break;
    case 'bedroom':
      furnishBedroom(build);
      break;
    case 'dining':
      furnishDining(build);
      break;
    case 'office':
      furnishOffice(build);
      break;
  }

  // Restraint, last: a room you cannot walk through is not furnished.
  relieveCirculation(build);

  return {
    placed: build.placed,
    removed,
    skipped: build.skipped,
    spend: build.spend,
    program,
  };
}
