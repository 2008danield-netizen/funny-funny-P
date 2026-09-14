/**
 * A person moving through the building.
 *
 * -----------------------------------------------------------------------------
 * ONE WALKER, TWO SETS OF HANDS.
 *
 * This class knows nothing about keyboards, mice, thumbsticks or headsets. It
 * takes an INTENT — how much forward, how much sideways, how much turn — and
 * resolves it against the building. The desktop walkthrough and the headset
 * both produce that intent from completely different hardware, and both get
 * identical behaviour out.
 *
 * That split is not tidiness for its own sake. It is the only reason any of
 * this can be tested: a headset cannot be automated, and a walker that is a
 * pure function of intent and document can be exercised exhaustively without
 * one. Every rule below — sliding along walls, stepping up treads, refusing to
 * walk off the building — is covered by tests that never open a browser.
 *
 * -----------------------------------------------------------------------------
 * THE BODY IS A BOX, AND THAT IS ON PURPOSE.
 *
 * A capsule would be more correct and would need its own collision routine.
 * The app already has a solver that slides an oriented box along walls, honours
 * doorways and pushes out of furniture — it is what stops a sofa being dropped
 * into a wall — so the walker is a small box and reuses it. Sharing the solver
 * also means a doorway wide enough for the furniture tool is wide enough to
 * walk through, which is exactly the consistency somebody assessing a design
 * needs.
 */

import { solvePosition, type Collider } from '@/physics/collision';
import { collidersFor } from '@/physics/colliders';
import { standingAt, type Standing } from './ground';
import { activeLevel } from '@/state/levels';
import { findRegions } from '@/scene/planGraph';
import type { DesignDocument, Point2 } from '@/state/types';

/* -------------------------------- The body -------------------------------- */

export const BODY = {
  /**
   * Half-width of the walker's box, in metres.
   *
   * 220 mm gives a 440 mm body. Narrower than a real pair of shoulders on
   * purpose: a box does not rotate to slip through a doorway the way a person
   * turning sideways does, and a full-width box catches on door frames that a
   * real person walks straight through. The complaint "it won't fit and it
   * obviously would" is far worse than a walker that is slightly slim.
   */
  halfWidth: 0.22,
  /** Eye height above the floor. The average standing eye, not stature. */
  eyeHeight: 1.62,
  /** Metres per second at a walk. */
  walkSpeed: 1.4,
  /** And at a hurry, which is what the run modifier gives. */
  runSpeed: 2.6,
  /** Radians per second turning with a stick or the arrow keys. */
  turnSpeed: 2.2,
  /** How far one snap turn goes. 30 degrees is the usual comfortable step. */
  snapTurn: Math.PI / 6,
  /**
   * How fast the eye catches up with a change of floor height, in metres per
   * second.
   *
   * Instant is correct and feels wrong: climbing a flight becomes a rapid
   * series of jolts. Easing the eye over each riser is what makes stairs read
   * as stairs, and in a headset it is the difference between climbing and
   * being teleported repeatedly.
   */
  stepEase: 3.2,
} as const;

/* ------------------------------- The intent ------------------------------- */

/** What the person is asking for this frame, in their own frame of reference. */
export interface WalkIntent {
  /** -1 back to +1 forward. */
  forward: number;
  /** -1 left to +1 right. */
  strafe: number;
  /** Continuous turn, radians per second, for a stick or held key. */
  turn: number;
  /** A single snap turn this frame: -1, 0 or +1. */
  snap: number;
  /** Whether the run modifier is held. */
  running: boolean;
  /** Somewhere to jump to instead of walking, if a teleport was confirmed. */
  teleportTo: Point2 | null;
}

export const NO_INTENT: WalkIntent = {
  forward: 0,
  strafe: 0,
  turn: 0,
  snap: 0,
  running: false,
  teleportTo: null,
};

/* -------------------------------- The state ------------------------------- */

export interface WalkState {
  /** Where the feet are, in plan. */
  at: Point2;
  /** The surface underfoot. */
  standing: Standing;
  /**
   * Where the eye actually is, which lags the floor while stepping.
   *
   * Kept apart from `standing.y` because they are genuinely different facts:
   * one is where the building says the floor is, the other is where the camera
   * should be drawn this instant.
   */
  eyeY: number;
  /** Which way the body faces, radians, 0 looking towards +z. */
  heading: number;
  /** Speed this frame, for the comfort vignette to read. */
  speed: number;
  /** True while the walker is somewhere they could not have walked to. */
  stuck: boolean;
}

export class Walker {
  private state: WalkState;
  private colliders: Collider[] = [];
  private collidersFor: DesignDocument | null = null;
  private collidersLevel = '';

  constructor(at: Point2, standing: Standing, heading = 0) {
    this.state = {
      at,
      standing,
      eyeY: standing.y + BODY.eyeHeight,
      heading,
      speed: 0,
      stuck: false,
    };
  }

  get current(): WalkState {
    return this.state;
  }

  /** Puts the walker somewhere, without any easing — for entering a mode. */
  placeAt(at: Point2, standing: Standing, heading = this.state.heading): void {
    this.state = {
      at,
      standing,
      eyeY: standing.y + BODY.eyeHeight,
      heading,
      speed: 0,
      stuck: false,
    };
  }

  /**
   * The colliders for the storey the walker is on.
   *
   * Rebuilt when the document changes or the walker changes storey, not per
   * frame: walking up a flight is the only thing that changes the answer, and
   * rebuilding every frame would walk every wall of the building ninety times
   * a second for nothing.
   *
   * Only the walker's OWN storey. Colliding with the walls of the floor above
   * would stop somebody halfway up a staircase for no visible reason.
   */
  private collidersOn(doc: DesignDocument, levelId: string): Collider[] {
    if (this.collidersFor === doc && this.collidersLevel === levelId) return this.colliders;

    const level = doc.levels.find((entry) => entry.id === levelId) ?? activeLevel(doc);

    /*
     * Walls and furniture, and deliberately not the stairs.
     *
     * A staircase is a collider to the furniture tool — you cannot drop a sofa
     * on it — and is the exact opposite to a walker, who is meant to be
     * standing on it. `collidersFor` takes those as an explicit extra list, so
     * leaving it off is all this needs.
     *
     * Cabinetry is not in here yet, so a kitchen island can be walked through.
     * Worth fixing, and not worth blocking a walkthrough over.
     */
    this.colliders = collidersFor(level.plan, level.furniture, null);
    this.collidersFor = doc;
    this.collidersLevel = levelId;
    return this.colliders;
  }

  /**
   * Advances one frame.
   *
   * Order matters and is the order a body works in: turn first, so movement is
   * in the direction now being faced; then move in plan and resolve against
   * what is in the way; then find the floor under wherever that ended up; then
   * ease the eye towards it.
   */
  update(doc: DesignDocument, intent: WalkIntent, delta: number): WalkState {
    const step = Math.min(delta, 0.1);

    /* ---- Turning ---- */

    let heading = this.state.heading + intent.turn * BODY.turnSpeed * step;
    if (intent.snap !== 0) heading += Math.sign(intent.snap) * BODY.snapTurn;

    /* ---- Where they are asking to be ---- */

    let desired = this.state.at;
    let speed = 0;

    if (intent.teleportTo) {
      desired = intent.teleportTo;
    } else if (intent.forward !== 0 || intent.strafe !== 0) {
      const magnitude = Math.min(1, Math.hypot(intent.forward, intent.strafe));
      speed = (intent.running ? BODY.runSpeed : BODY.walkSpeed) * magnitude;

      // Heading 0 looks towards +z, which is the convention the rest of the
      // app uses for a piece of furniture facing into a room.
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      const forwardVector = { x: sin, z: cos };
      const rightVector = { x: cos, z: -sin };

      const move = {
        x: (forwardVector.x * intent.forward + rightVector.x * intent.strafe) / magnitude,
        z: (forwardVector.z * intent.forward + rightVector.z * intent.strafe) / magnitude,
      };

      desired = {
        x: this.state.at.x + move.x * speed * step,
        z: this.state.at.z + move.z * speed * step,
      };
    }

    /* ---- What is in the way ---- */

    let at = desired;
    let stuck = false;

    if (desired !== this.state.at) {
      const colliders = this.collidersOn(doc, this.state.standing.levelId);
      const solved = solvePosition(
        {
          center: desired,
          halfWidth: BODY.halfWidth,
          halfDepth: BODY.halfWidth,
          // A box that never turns: a walker's collision should not change
          // shape as they look around, which would let somebody squeeze
          // through a gap by facing it diagonally.
          rotation: 0,
        },
        { colliders, padding: 0.01, iterations: 4 },
      );

      at = solved.resolved ? solved.center : this.state.at;
      stuck = !solved.resolved;
    }

    /* ---- The floor under wherever that ended up ---- */

    const standing = standingAt(doc, at, this.state.standing.y);

    if (!standing) {
      /*
       * Nowhere to stand. Refuse the move rather than falling.
       *
       * This is a walkthrough of a design, not a game: dropping out of the
       * model is never the useful answer, and somebody who walks out of a
       * doorway that leads nowhere wants to be stopped at the threshold.
       */
      this.state = { ...this.state, heading, speed: 0, stuck: true };
      return this.state;
    }

    /* ---- The eye catching up ---- */

    const targetEye = standing.y + BODY.eyeHeight;
    const gap = targetEye - this.state.eyeY;
    const ease = BODY.stepEase * step;
    const eyeY =
      Math.abs(gap) <= ease ? targetEye : this.state.eyeY + Math.sign(gap) * ease;

    this.state = { at, standing, eyeY, heading, speed, stuck };
    return this.state;
  }
}

/**
 * Where to start a walkthrough.
 *
 * The middle of the biggest room on the active storey, facing the middle of the
 * building. Not the camera's current position: an orbit camera is usually
 * outside the building looking in, and starting a walkthrough in the garden
 * facing a wall is a poor first second.
 */
export function startingPoint(
  doc: DesignDocument,
): { at: Point2; standing: Standing; heading: number } | null {
  const level = activeLevel(doc);
  // Once, at entry — not per frame. The ground cache has already walked this
  // plan for its surfaces, but it keeps only polygons and drops the area and
  // interior point that choosing a starting room needs.
  const regions = [...findRegions(level.plan)].sort((a, b) => b.area - a.area);
  const biggest = regions[0];
  if (!biggest) return null;

  const standing = standingAt(doc, biggest.interiorPoint, 0);
  if (!standing) return null;

  // Face the centre of the storey, so the first thing seen is the building
  // rather than the inside of the nearest wall.
  const centre = regions.reduce(
    (sum, region) => ({
      x: sum.x + region.interiorPoint.x / regions.length,
      z: sum.z + region.interiorPoint.z / regions.length,
    }),
    { x: 0, z: 0 },
  );

  const dx = centre.x - biggest.interiorPoint.x;
  const dz = centre.z - biggest.interiorPoint.z;
  const heading = Math.hypot(dx, dz) < 0.2 ? 0 : Math.atan2(dx, dz);

  return { at: biggest.interiorPoint, standing, heading };
}
