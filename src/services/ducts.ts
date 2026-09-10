/**
 * Laying out the ductwork: where the air handler stands, where the registers
 * go, and how the trunk and branches get from one to the other.
 *
 * -----------------------------------------------------------------------------
 * THE SHAPE OF A REAL DUCT SYSTEM.
 *
 * One machine, one trunk, many branches. The trunk is a large duct running the
 * length of the house in the floor void; each room takes a branch off it. That
 * is the "trunk and branch" system, and it is what the great majority of
 * American houses have, because a single large duct carrying all the air is far
 * cheaper in both material and pressure loss than a separate run to every room
 * from a central plenum.
 *
 * Everything here follows from that shape:
 *   - the trunk is placed along the axis the house is longest in, because that
 *     is the axis the rooms are spread along;
 *   - branches leave it at right angles, because a duct follows the joists;
 *   - the trunk gets smaller as it goes, since each branch takes air out of it
 *     — which is why the size is derived per run rather than once for "the
 *     trunk" (see `ductSize.ts`).
 *
 * -----------------------------------------------------------------------------
 * WHY THE SUPPLY REGISTERS GO UNDER THE WINDOWS.
 *
 * This looks like decoration and is not. The coldest surface in a room is the
 * glass; air touching it cools, gets heavier and pours down onto the floor, and
 * that draught across the ankles is what people actually feel and call "cold",
 * long before the room's air temperature has moved at all. A supply register
 * under the window throws warm air straight up the glass and cancels it.
 *
 * Put the same register on the inner wall and the room reaches temperature just
 * as fast and feels worse. So window walls are preferred, then exterior walls,
 * and the middle of the room is the last resort.
 *
 * -----------------------------------------------------------------------------
 * AND WHY THE RETURNS GO HIGH, AND CENTRAL.
 *
 * Warm air collects at the ceiling, so that is where it is worth taking back in
 * summer. And a return has to be central — and there have to be enough of them
 * — because air that goes into a room must come out of it. A bedroom with a
 * supply, no return and a closed door pressurises, and the extra air leaves
 * through whatever gaps the construction has, carrying the money with it. This
 * is one of the most common real defects in built houses and it is invisible
 * until somebody measures it.
 */

import { findRegions, pointInPolygon, type Region } from '@/scene/planGraph';
import { roomWalls } from '@/advisor/geometry';
import { resolveRoomSpec } from '@/state/planOps';
import { roomPurpose } from './rooms';
import { isExteriorWall, type BuildingLoad } from './manualJ';
import { roomAirflows } from './ductSize';
import type { SystemSelection } from './manualS';
import {
  HVAC_LIMITS,
  type DesignDocument,
  type DuctRun,
  type Level,
  type PipePoint,
  type Point2,
  type Register,
} from '@/state/types';

/* ------------------------------- The result ------------------------------- */

export interface DuctLayout {
  ducts: DuctRun[];
  registers: Register[];
  airHandler: { levelId: string; at: Point2 } | null;
  /** What had to be assumed or could not be done. */
  assumptions: string[];
}

export const emptyLayout = (): DuctLayout => ({
  ducts: [],
  registers: [],
  airHandler: null,
  assumptions: [],
});

/** Most air one register will pass without whistling. Beyond this, split. */
const CFM_PER_REGISTER = 130;

/**
 * How far a register sits out from the wall face, into the room.
 *
 * Just enough to be inside the room for the point-in-polygon test that keeps
 * it out of the wall, and no more. At 250 mm — where this started — a register
 * reads in the model as a brick floating in mid-air rather than as a grille in
 * the wall, which is both wrong and distracting.
 */
const REGISTER_OFFSET = 0.07;

/** How finely walls and rooms are sampled looking for a position. */
const SAMPLE_STEP = 0.3;

/** Rooms smaller than this get no register of their own. */
const MIN_SERVED_AREA = 1.2;

/* --------------------------------- Ids ------------------------------------ */

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}${counter}`;
};

/** Restarts duct ids, so a test gets the same ids twice. */
export function resetDuctIds(): void {
  counter = 0;
}

/* -------------------------------- Geometry -------------------------------- */

function regionsOf(level: Level): Region[] {
  return findRegions(level.plan);
}

function insideLevel(regions: readonly Region[], point: Point2): boolean {
  return regions.some((region) => pointInPolygon(point, region.polygon));
}

/** Height a supply duct runs at on a given level: in the void below the floor. */
const supplyHeight = (): number => -HVAC_LIMITS.ductVoidDepth;

/** Height a return duct runs at: tucked up under the ceiling. */
const returnHeight = (level: Level): number => level.wallHeight - HVAC_LIMITS.returnHeight;

/* ---------------------------- Register placement --------------------------- */

/**
 * Candidate positions for a supply register in one room, best first.
 *
 * Ordered by the physics above: under a window, then along an exterior wall,
 * then anywhere. Every candidate is a point just inside the room, because a
 * register sitting exactly on the wall face is inside the wall.
 */
function supplySpots(level: Level, region: Region): Point2[] {
  const underWindows: Point2[] = [];
  const exteriorWalls: Point2[] = [];
  const anywhere: Point2[] = [];

  for (const wall of roomWalls(level.plan, region)) {
    const exterior = isExteriorWall(level, wall.wallId);

    const at = (t: number): Point2 => ({
      x: wall.faceStart.x + (wall.faceEnd.x - wall.faceStart.x) * t + wall.inward.x * REGISTER_OFFSET,
      z: wall.faceStart.z + (wall.faceEnd.z - wall.faceStart.z) * t + wall.inward.z * REGISTER_OFFSET,
    });

    // A window's own midpoint, which is exactly where the draught falls.
    const planWall = level.plan.walls.find((candidate) => candidate.id === wall.wallId);
    if (planWall && exterior) {
      for (const opening of planWall.openings) {
        if (opening.kind !== 'window') continue;
        const t = wall.length > 0 ? opening.offset / wall.length : 0.5;
        if (t < 0 || t > 1) continue;
        const spot = at(t);
        if (pointInPolygon(spot, region.polygon)) underWindows.push(spot);
      }
    }

    // Otherwise, points along the wall that are not in a doorway.
    const steps = Math.max(1, Math.floor(wall.length / SAMPLE_STEP));
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      const along = t * wall.length;
      const blocked = wall.openingSpans.some(
        (span) => span.to - span.from > 0 && along > span.from - 0.2 && along < span.to + 0.2,
      );
      if (blocked) continue;

      const spot = at(t);
      if (!pointInPolygon(spot, region.polygon)) continue;
      (exterior ? exteriorWalls : anywhere).push(spot);
    }
  }

  const ordered = [...underWindows, ...exteriorWalls, ...anywhere];
  return ordered.length > 0 ? ordered : [region.interiorPoint];
}

/** Spreads n picks across a list of candidates so they do not bunch together. */
function spread(candidates: readonly Point2[], count: number): Point2[] {
  if (candidates.length === 0) return [];
  if (count <= 1) return [candidates[0]!];

  const picked: Point2[] = [candidates[0]!];
  while (picked.length < count) {
    let best: Point2 | null = null;
    let bestDistance = -1;

    for (const candidate of candidates) {
      const nearest = Math.min(
        ...picked.map((point) => Math.hypot(point.x - candidate.x, point.z - candidate.z)),
      );
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = candidate;
      }
    }

    // Everything left is on top of something already chosen.
    if (!best || bestDistance < 0.5) break;
    picked.push(best);
  }
  return picked;
}

/**
 * Where the return goes on a storey.
 *
 * One central, high return per storey, in the largest circulation space if
 * there is one and otherwise in the largest room. Not one per room: that is a
 * better system and a much more expensive one, and it is not what a house of
 * this kind is built with. The check reports the door-undercut assumption that
 * a single central return depends on, rather than leaving it silent.
 */
function returnSpot(level: Level, regions: readonly Region[]): { at: Point2; roomKey: string } | null {
  let best: { at: Point2; roomKey: string; score: number } | null = null;

  for (const region of regions) {
    const spec = resolveRoomSpec(level.plan, region.key);
    const purpose = roomPurpose(spec.name);
    // A hall is the right place for it; a bedroom is the wrong one.
    const bonus = purpose === 'hall' ? 40 : purpose === 'living' ? 10 : 0;
    const score = region.area + bonus;
    if (!best || score > best.score) {
      best = { at: region.interiorPoint, roomKey: region.key, score };
    }
  }

  return best ? { at: best.at, roomKey: best.roomKey } : null;
}

/* --------------------------- Air handler placement ------------------------- */

/**
 * Where the air handler stands.
 *
 * On the lowest storey, because that is where the plant goes and because the
 * ducts then run in the floor void of every storey above rather than the
 * ceiling of the one below. Scored by total weighted distance to the rooms it
 * has to serve, so it lands near the middle of the load rather than the middle
 * of the plan — a big glassy living room pulls it towards itself, which is
 * correct, because that is where the air has to go.
 *
 * A utility room or garage wins outright when there is one, because that is
 * where it will actually be put, and because a furnace in a bedroom is a
 * combustion-air and noise problem this app does not want to invent.
 */
export function airHandlerSpot(
  doc: DesignDocument,
  load: BuildingLoad,
): { levelId: string; at: Point2 } | null {
  const ground = doc.levels[0];
  if (!ground) return null;

  const regions = regionsOf(ground);
  if (regions.length === 0) return null;

  const weightByRoom = new Map(load.rooms.map((room) => [room.roomKey, room.heatingTotal]));

  let best: { at: Point2; score: number; preferred: boolean } | null = null;

  for (const region of regions) {
    const spec = resolveRoomSpec(ground.plan, region.key);
    const purpose = roomPurpose(spec.name);
    /*
     * A laundry (which is what "utility" resolves to), a plant cupboard or a
     * garage. Those are the rooms a furnace actually stands in; it does not
     * stand in a bedroom, and putting one there in the model would quietly
     * hide a combustion-air and noise problem this app does not design for.
     */
    const preferred = purpose === 'laundry' || purpose === 'garage' || purpose === 'store';

    // Sample the room rather than only its interior point, so a long utility
    // room can offer the end of itself that is nearest everything else.
    const candidates: Point2[] = [region.interiorPoint];
    const bounds = boundsOf(region.polygon);
    for (let x = bounds.minX; x <= bounds.maxX; x += SAMPLE_STEP * 2) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z += SAMPLE_STEP * 2) {
        const point = { x, z };
        if (pointInPolygon(point, region.polygon)) candidates.push(point);
      }
    }

    for (const candidate of candidates) {
      let score = 0;
      for (const other of regions) {
        const weight = weightByRoom.get(other.key) ?? 0;
        score +=
          weight *
          Math.hypot(other.interiorPoint.x - candidate.x, other.interiorPoint.z - candidate.z);
      }

      // A preferred room beats a better-scoring ordinary one outright.
      if (!best || (preferred && !best.preferred) || (preferred === best.preferred && score < best.score)) {
        best = { at: candidate, score, preferred };
      }
    }
  }

  return best ? { levelId: ground.id, at: best.at } : null;
}

function boundsOf(polygon: readonly Point2[]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ };
}

/* --------------------------------- Routing -------------------------------- */

/**
 * The nearest point on a polyline to a given point, and how far along it is.
 *
 * This is how a branch finds its tap into the trunk. Real branches leave the
 * trunk at the nearest convenient place, not at the end of it, and a system
 * modelled the other way round has every branch running the whole length of
 * the house back to the plant.
 */
function nearestOnPolyline(points: readonly Point2[], to: Point2): Point2 {
  let best = points[0] ?? to;
  let bestDistance = Infinity;

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;

    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((to.x - a.x) * dx + (to.z - a.z) * dz) / lengthSquared));

    const point = { x: a.x + dx * t, z: a.z + dz * t };
    const distance = Math.hypot(point.x - to.x, point.z - to.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }

  return best;
}

/**
 * An L-shaped plan route, kept inside the building where it can be.
 *
 * The same reasoning as the pipe router: ductwork runs along a joist bay and
 * then turns; it does not cut diagonally across a floor, because there is a
 * joist every 400 mm in the way.
 */
function elbowRoute(from: Point2, to: Point2, regions: readonly Region[]): Point2[] {
  const corners: Point2[] = [
    { x: to.x, z: from.z },
    { x: from.x, z: to.z },
  ];
  const corner = corners.find((candidate) => insideLevel(regions, candidate)) ?? corners[0]!;

  const points: Point2[] = [from];
  if (
    Math.hypot(corner.x - from.x, corner.z - from.z) > 0.05 &&
    Math.hypot(corner.x - to.x, corner.z - to.z) > 0.05
  ) {
    points.push(corner);
  }
  points.push(to);
  return points;
}

const flat = (levelId: string, plan: readonly Point2[], height: number): PipePoint[] =>
  plan.map((at) => ({ levelId, at, height }));

/* ------------------------------ The whole pass ----------------------------- */

/**
 * Lay out the whole duct system.
 *
 * Returns a layout rather than writing to the document, so that the caller can
 * make it one undo step and so that this can be tested without a store.
 */
export function routeDucts(
  doc: DesignDocument,
  load: BuildingLoad,
  selection: SystemSelection,
): DuctLayout {
  const layout = emptyLayout();

  if (selection.supplyCfm <= 0) {
    layout.assumptions.push(
      selection.system === 'hydronic'
        ? 'A hydronic system has no ducts; radiators are laid out instead.'
        : 'No equipment has been selected, so there is no air to distribute.',
    );
    return layout;
  }
  if (selection.system === 'mini-split') {
    layout.assumptions.push(
      'Mini-split heads sit in the rooms they serve and have no ductwork, so nothing is routed.',
    );
    return layout;
  }

  const handler = airHandlerSpot(doc, load);
  if (!handler) {
    layout.assumptions.push('No enclosed room on the lowest storey to stand the air handler in.');
    return layout;
  }
  layout.airHandler = handler;

  const airflows = roomAirflows(load, selection);
  const flowByRoom = new Map(airflows.map((flow) => [flow.roomKey, flow]));

  /* ---- Registers, storey by storey ---- */

  const registersByLevel = new Map<string, Register[]>();

  for (const level of doc.levels) {
    const regions = regionsOf(level);
    const here: Register[] = [];

    for (const region of regions) {
      if (region.area < MIN_SERVED_AREA) continue;

      const flow = flowByRoom.get(region.key);
      if (!flow || flow.designCfm <= 1) continue;

      const spec = resolveRoomSpec(level.plan, region.key);
      const purpose = roomPurpose(spec.name);
      // Outside the thermal envelope, so not conditioned: a garage, a porch,
      // a balcony. Heating a deck is not a design decision worth automating.
      if (purpose === 'garage' || purpose === 'outdoor') continue;

      const wanted = Math.max(1, Math.min(4, Math.ceil(flow.designCfm / CFM_PER_REGISTER)));
      const spots = spread(supplySpots(level, region), wanted);

      for (const at of spots) {
        here.push({
          id: nextId('reg'),
          levelId: level.id,
          at,
          height: HVAC_LIMITS.supplyRegisterHeight,
          system: 'supply',
          roomKey: region.key,
        });
      }
    }

    if (here.length > 0) {
      const back = returnSpot(level, regions);
      if (back) {
        here.push({
          id: nextId('ret'),
          levelId: level.id,
          at: back.at,
          height: HVAC_LIMITS.returnRegisterHeight,
          system: 'return',
          roomKey: back.roomKey,
        });
      }
    }

    registersByLevel.set(level.id, here);
    layout.registers.push(...here);
  }

  if (layout.registers.length === 0) {
    layout.assumptions.push('No room came out with enough load to need a register.');
    return layout;
  }

  /* ---- A trunk on each storey, and a riser between them ---- */

  const servedLevels = doc.levels.filter(
    (level) => (registersByLevel.get(level.id) ?? []).some((r) => r.system === 'supply'),
  );

  let previousSupplyTrunkId: string | null = null;

  for (const level of servedLevels) {
    const regions = regionsOf(level);
    const here = registersByLevel.get(level.id) ?? [];
    const supplies = here.filter((register) => register.system === 'supply');
    if (supplies.length === 0) continue;

    const onGround = level.id === handler.levelId;

    /*
     * Which way the trunk runs.
     *
     * Along whichever axis the registers are more spread out in — which is
     * almost always the long axis of the house, and is the axis that lets the
     * trunk get near every room with the shortest branches.
     */
    const xs = supplies.map((register) => register.at.x);
    const zs = supplies.map((register) => register.at.z);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadZ = Math.max(...zs) - Math.min(...zs);
    const alongX = spreadX >= spreadZ;

    // The cross-axis position: the median of the registers, so half fall each
    // side and the branches are as short as they can be.
    const cross = median(alongX ? zs : xs);

    const start = alongX
      ? { x: Math.min(...xs), z: cross }
      : { x: cross, z: Math.min(...zs) };
    const end = alongX ? { x: Math.max(...xs), z: cross } : { x: cross, z: Math.max(...zs) };

    // The trunk begins at the plant on the storey the plant is on, and at the
    // riser's head on every storey above.
    const root = onGround ? handler.at : nearestOnPolyline([start, end], handler.at);
    const trunkPlan = dedupe([...elbowRoute(root, start, regions), end]);

    const trunkId = nextId('duct');
    layout.ducts.push({
      id: trunkId,
      system: 'supply',
      points: flat(level.id, trunkPlan, supplyHeight()),
      serves: [],
      upstreamId: onGround ? null : previousSupplyTrunkId,
      manual: false,
    });

    // The riser that got here, expressed as its own run so it can be drawn and
    // measured. It climbs from the storey below's void to this one's.
    if (!onGround && previousSupplyTrunkId) {
      const below = doc.levels[doc.levels.indexOf(level) - 1];
      if (below) {
        layout.ducts.push({
          id: nextId('duct'),
          system: 'supply',
          points: [
            { levelId: below.id, at: root, height: supplyHeight() },
            { levelId: below.id, at: root, height: below.wallHeight - HVAC_LIMITS.returnHeight },
            { levelId: level.id, at: root, height: supplyHeight() },
          ],
          serves: [],
          upstreamId: previousSupplyTrunkId,
          manual: false,
        });
      }
    }

    for (const register of supplies) {
      const tap = nearestOnPolyline(trunkPlan, register.at);
      const plan = dedupe(elbowRoute(tap, register.at, regions));

      /*
       * The branch ends with a rise, not at floor-void height.
       *
       * A register is a hole in the wall or the floor above the duct, and the
       * last piece is the boot that climbs to it. Leaving the branch flat is
       * not only wrong to look at — a register that sits directly over the
       * trunk gives a branch whose two ends are the same point, which draws as
       * nothing and quietly breaks the sizing that walks the run.
       */
      layout.ducts.push({
        id: nextId('duct'),
        system: 'supply',
        points: [
          ...flat(level.id, plan, supplyHeight()),
          { levelId: level.id, at: register.at, height: register.height },
        ],
        serves: [register.id],
        upstreamId: trunkId,
        manual: false,
      });
    }

    previousSupplyTrunkId = trunkId;

    /* ---- The return, which runs high and comes straight back ---- */

    const back = here.find((register) => register.system === 'return');
    if (back) {
      const plan = dedupe(elbowRoute(back.at, onGround ? handler.at : root, regions));

      // Starts at the grille and drops into the duct above the ceiling, the
      // mirror of the supply boot.
      const points: PipePoint[] = [
        { levelId: level.id, at: back.at, height: back.height },
        ...flat(level.id, plan, returnHeight(level)),
      ];
      if (!onGround) {
        points.push({ levelId: handler.levelId, at: handler.at, height: returnHeight(level) });
      }

      layout.ducts.push({
        id: nextId('duct'),
        system: 'return',
        points,
        serves: [back.id],
        upstreamId: null,
        manual: false,
      });
    }
  }

  /* ---- What the reader should know about all this ---- */

  layout.assumptions.push(
    'Ducts are routed automatically along the shortest sensible path in the floor void. Nothing has been checked against the joists, the beams or anything else that is actually in that void.',
  );
  layout.assumptions.push(
    'One return per storey. That only works if the doors are undercut or transfer grilles are fitted — otherwise a closed bedroom door pressurises the room and pushes conditioned air out through the structure.',
  );

  const upper = servedLevels.length > 1;
  if (upper) {
    layout.assumptions.push(
      'The riser between storeys is drawn where the plant is. A real one needs a chase, and finding a place to put that chase usually moves at least one wall.',
    );
  }

  return layout;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Drops points that repeat the one before.
 *
 * Deliberately allowed to return a single point: a branch whose tap lands on
 * its own register really is one point in plan, and the honest answer is a
 * vertical boot rather than a two-point run that goes nowhere. Padding it back
 * out to two identical points — which an earlier version did — produces a duct
 * that draws as nothing and sizes as nothing.
 */
function dedupe(points: readonly Point2[]): Point2[] {
  const result: Point2[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && Math.hypot(last.x - point.x, last.z - point.z) < 0.02) continue;
    result.push(point);
  }
  return result;
}
