/**
 * What is underfoot.
 *
 * -----------------------------------------------------------------------------
 * THE QUESTION THAT MAKES A BUILDING WALKABLE.
 *
 * Everything else about moving through a house is comparatively easy. Sliding
 * along a wall is one call against colliders that already exist. What is hard,
 * and what this file is, is: standing at this point, what am I standing ON?
 *
 * Getting it wrong is not subtle. Answer too eagerly and somebody walking under
 * a staircase is teleported to the top of it. Answer too conservatively and
 * they walk up to the bottom step and stop dead. Answer with the wrong storey
 * and they fall through the floor into the room below.
 *
 * -----------------------------------------------------------------------------
 * EVERY SURFACE IS A CANDIDATE; THE HIGHEST REACHABLE ONE WINS.
 *
 * So the answer is built the way a foot finds it. Collect every surface at this
 * point — the floor slab of each storey the point is inside, and every stair
 * tread the point is on — then take the highest one within stepping distance of
 * where the walker already is.
 *
 * "Within stepping distance" is doing the real work. A tread 180 mm above the
 * current foot is a step up and is taken. A landing 2.4 m above is a different
 * storey and is not, even though it is directly overhead. That single rule is
 * what makes a staircase climbable without any notion of "being on a staircase"
 * existing anywhere in the code.
 *
 * -----------------------------------------------------------------------------
 * AND A FLOOR WITH A HOLE IN IT IS NOT A FLOOR.
 *
 * A stairwell opening is a hole in the storey above. Standing in the middle of
 * one, the floor of that storey is not underfoot — the flight below it is. The
 * holes are derived from the stairs rather than stored, so this follows
 * automatically when a stair moves.
 */

import { pointInPolygon } from '@/physics/collision';
import { findRegions } from '@/scene/planGraph';
import { stairGeometry } from '@/building/stairs';
import { elevationOf, floorHoles, levelAbove } from '@/state/levels';
import type { DesignDocument, Level, Point2 } from '@/state/types';

/** How far up a walker steps without being asked. A tall stair riser. */
export const MAX_STEP_UP = 0.24;

/**
 * How far below the current foot a surface can be and still be "the floor".
 *
 * Generous, because this is the fall rather than the climb: walking off the top
 * of a flight, every tread on the way down is further below than the last, and
 * refusing them would leave the walker hovering over the stairwell.
 */
export const MAX_STEP_DOWN = 4;

export interface Standing {
  /** World height of the surface underfoot. */
  y: number;
  /** Which storey that surface belongs to. */
  levelId: string;
  /** What it is, which the UI uses to say where somebody is. */
  kind: 'floor' | 'stair';
}

/** One surface found at a point, before the reachable one is chosen. */
interface Candidate {
  y: number;
  levelId: string;
  kind: Standing['kind'];
}

/**
 * The surfaces of a whole building, resolved once.
 *
 * Cached by document identity, because this is asked sixty to ninety times a
 * second — twice a frame in a headset, once per eye. Region finding and stair
 * geometry both walk the entire plan, and doing that per frame is the
 * difference between a walkthrough that holds frame rate and one that does not.
 */
interface Surfaces {
  levels: Array<{
    level: Level;
    base: number;
    regions: Array<{ polygon: Point2[] }>;
    holes: Array<{ polygon: Point2[] }>;
  }>;
  treads: Array<{ polygon: Point2[]; y: number; levelId: string }>;
}

let cachedFor: DesignDocument | null = null;
let cached: Surfaces | null = null;

export function surfacesOf(doc: DesignDocument): Surfaces {
  if (cachedFor === doc && cached) return cached;

  const levels = doc.levels.map((level) => ({
    level,
    base: elevationOf(doc, level.id),
    regions: findRegions(level.plan).map((region) => ({ polygon: region.polygon })),
    holes: floorHoles(doc, level.id, (stair) => stairGeometry(doc, stair).wellOpening).map(
      (hole) => ({ polygon: hole.polygon }),
    ),
  }));

  const treads: Surfaces['treads'] = [];
  for (const stair of doc.stairs) {
    const base = elevationOf(doc, stair.fromLevelId);
    const geometry = stairGeometry(doc, stair);

    for (const tread of geometry.treads) {
      treads.push({
        polygon: tread.polygon,
        y: base + tread.height,
        levelId: stair.fromLevelId,
      });
    }

    /*
     * The arrival: the first piece of the floor above that you step onto.
     *
     * Without this a walker climbs the whole flight and then falls back to the
     * ground floor at the top, which is how this was found. The stairwell
     * opening is cut from HEADROOM — it has to extend past the top of the
     * flight, or the last few treads would have a ceiling in the way — and the
     * floor of the storey above is therefore missing exactly where somebody
     * steps off the top tread.
     *
     * So the flight's own top tread is continued one going further at the
     * height of the floor it arrives at. That is not invented geometry: it is
     * the landing, and it is the surface the stair exists to reach.
     */
    const top = geometry.treads[geometry.treads.length - 1];
    const above = levelAbove(doc, stair.fromLevelId);
    if (top && above) {
      const arrivalY = elevationOf(doc, above.id);
      const forward = { x: Math.sin(stair.rotation), z: Math.cos(stair.rotation) };
      const reach = Math.max(stair.treadDepth, 0.25);

      treads.push({
        polygon: top.polygon.map((corner) => ({
          x: corner.x + forward.x * reach,
          z: corner.z + forward.z * reach,
        })),
        y: arrivalY,
        levelId: above.id,
      });
    }
  }

  cached = { levels, treads };
  cachedFor = doc;
  return cached;
}

/** Throws the surface cache away, for tests that mutate a document in place. */
export function resetGroundCache(): void {
  cachedFor = null;
  cached = null;
}

/**
 * The surface a walker at this point, currently standing at `fromY`, is on.
 *
 * Returns null when there is nothing to stand on at all — off the edge of the
 * building — which the caller treats as "do not go there" rather than as a
 * fall. A walkthrough of a design is not a game, and falling out of the model
 * is never the useful answer.
 */
export function standingAt(doc: DesignDocument, at: Point2, fromY: number): Standing | null {
  const surfaces = surfacesOf(doc);
  const candidates: Candidate[] = [];

  for (const entry of surfaces.levels) {
    if (!entry.regions.some((region) => pointInPolygon(at, region.polygon))) continue;
    // A stairwell opening is a hole in this storey; there is no floor here.
    if (entry.holes.some((hole) => pointInPolygon(at, hole.polygon))) continue;

    candidates.push({ y: entry.base, levelId: entry.level.id, kind: 'floor' });
  }

  for (const tread of surfaces.treads) {
    if (!pointInPolygon(at, tread.polygon)) continue;
    candidates.push({ y: tread.y, levelId: tread.levelId, kind: 'stair' });
  }

  if (candidates.length === 0) return null;

  /*
   * The highest surface that can actually be reached from where the walker is.
   *
   * Sorted high to low and the first reachable one taken, rather than "nearest
   * to fromY". Standing on the top tread with the landing only 150 mm higher,
   * the landing is what is being stepped onto — and "nearest" would sometimes
   * prefer the tread just left behind, which reads as the stair refusing to
   * let go of you.
   */
  const reachable = candidates
    .filter((candidate) => candidate.y <= fromY + MAX_STEP_UP + 1e-6)
    .filter((candidate) => candidate.y >= fromY - MAX_STEP_DOWN)
    .sort((a, b) => b.y - a.y);

  if (reachable[0]) return reachable[0];

  /*
   * Nothing reachable, which happens on the very first step into a building
   * whose ground floor is not at zero. The lowest surface is handed back rather
   * than nothing, and the caller lands on it — refusing here would leave
   * somebody unable to enter their own house.
   */
  return [...candidates].sort((a, b) => a.y - b.y)[0]!;
}

/**
 * Whether a walker could stand at a point.
 *
 * Deliberately the same question the walker asks every frame, because the
 * teleport uses it to decide where its arc may land — and a teleport that puts
 * you somewhere you could not have walked to is a teleport into a wall.
 */
export function canStandAt(doc: DesignDocument, at: Point2, fromY: number): boolean {
  return standingAt(doc, at, fromY) !== null;
}

/**
 * Headroom above a surface: how far up before the ceiling is in the way.
 *
 * Only the ceiling of the storey the surface belongs to, which is the case
 * this exists for — walking up a flight towards the underside of the floor
 * above. Infinity where there is no storey, which is to say outdoors.
 */
export function headroomAt(doc: DesignDocument, at: Point2, standing: Standing): number {
  const surfaces = surfacesOf(doc);
  const entry = surfaces.levels.find((candidate) => candidate.level.id === standing.levelId);
  if (!entry) return Infinity;
  if (!entry.regions.some((region) => pointInPolygon(at, region.polygon))) return Infinity;

  return entry.base + entry.level.wallHeight - standing.y;
}
