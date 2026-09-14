/**
 * The teleport arc.
 *
 * -----------------------------------------------------------------------------
 * WHY A CURVE RATHER THAN A STRAIGHT LINE.
 *
 * Point a straight ray at the floor and the further away you aim, the flatter
 * the angle gets — until a few degrees of wrist movement swings the landing
 * point across the whole house. It is exhausting to aim and impossible to be
 * precise with.
 *
 * A thrown arc behaves the opposite way. Aiming further means raising the hand,
 * which is a movement people already understand from throwing things, and the
 * landing point moves predictably with it. Every VR application converged on
 * this within about a year of headsets existing, and it is worth copying rather
 * than rediscovering.
 *
 * -----------------------------------------------------------------------------
 * IT LANDS WHERE YOU COULD HAVE WALKED, AND NOWHERE ELSE.
 *
 * The arc is tested against exactly the same `standingAt` the walker consults
 * every frame. Not a simplified version of it, not a separate "teleport mesh" —
 * the same function. A teleport that puts somebody somewhere they could not
 * have walked to is a teleport into a wall, and the only way to be sure that
 * cannot happen is to ask one question in one place.
 */

import { canStandAt, standingAt, type Standing } from './ground';
import type { DesignDocument, Point2 } from '@/state/types';

export const ARC = {
  /** How fast the arc is "thrown", metres per second. */
  speed: 7,
  /** Gravity pulling it down. Stronger than real, for a tighter arc. */
  gravity: 14,
  /** Seconds of flight to simulate before giving up. */
  maxTime: 1.6,
  /** Steps along the arc. More is smoother and costs more per frame. */
  steps: 36,
  /**
   * How far a landing may be from the walker.
   *
   * Not a game mechanic — a limit on how much of the building somebody can skip
   * in one hop. Crossing a whole house instantly makes it impossible to judge
   * how big the house is, which is the main thing a walkthrough is for.
   */
  maxRange: 8,
} as const;

export interface ArcPoint {
  x: number;
  y: number;
  z: number;
}

export interface TeleportAim {
  /** The curve, for drawing. Always at least two points. */
  points: ArcPoint[];
  /** Where it landed, or null if it found nowhere to stand. */
  landing: Point2 | null;
  /** The surface at the landing, when there is one. */
  standing: Standing | null;
  /** Why a landing was refused, for the marker's colour and the panel. */
  refusal: 'none' | 'nowhere-to-stand' | 'too-far' | null;
}

/**
 * Throws an arc from a hand and finds where it may land.
 *
 * `from` is the hand position in world space and `direction` the way it points,
 * both of which the desktop and the headset produce differently — a mouse ray
 * from the eye, a controller pose from the runtime — and neither of which this
 * function needs to know about.
 */
export function aimTeleport(
  doc: DesignDocument,
  from: ArcPoint,
  direction: ArcPoint,
  standingOn: Standing,
): TeleportAim {
  const points: ArcPoint[] = [];

  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const velocity = {
    x: (direction.x / length) * ARC.speed,
    y: (direction.y / length) * ARC.speed,
    z: (direction.z / length) * ARC.speed,
  };

  let landing: Point2 | null = null;
  let landingStanding: Standing | null = null;
  let refusal: TeleportAim['refusal'] = 'nowhere-to-stand';

  let previous: ArcPoint = { ...from };
  points.push(previous);

  for (let step = 1; step <= ARC.steps; step += 1) {
    const t = (step / ARC.steps) * ARC.maxTime;
    const point: ArcPoint = {
      x: from.x + velocity.x * t,
      y: from.y + velocity.y * t - 0.5 * ARC.gravity * t * t,
      z: from.z + velocity.z * t,
    };
    points.push(point);

    /*
     * A landing is where the arc passes DOWN through a walkable surface.
     *
     * Testing "is the arc below the floor" alone would land on the ceiling of
     * the storey below the moment the arc dipped past it. Requiring the arc to
     * be descending, and to cross the surface between one step and the next, is
     * what makes it land on the first floor it meets.
     */
    const surface = standingAt(doc, { x: point.x, z: point.z }, standingOn.y);
    if (!surface) {
      previous = point;
      continue;
    }

    const wasAbove = previous.y >= surface.y;
    const nowBelow = point.y <= surface.y;

    if (wasAbove && nowBelow) {
      const spot = { x: point.x, z: point.z };
      const reach = Math.hypot(spot.x - from.x, spot.z - from.z);

      if (reach > ARC.maxRange) {
        refusal = 'too-far';
      } else if (canStandAt(doc, spot, standingOn.y)) {
        landing = spot;
        landingStanding = surface;
        refusal = 'none';
      }

      // Stop at the first surface either way: an arc that carried on through
      // a floor it was refused at would find the garden beyond the wall.
      points[points.length - 1] = { x: point.x, y: surface.y, z: point.z };
      break;
    }

    previous = point;
  }

  return { points, landing, standing: landingStanding, refusal };
}
