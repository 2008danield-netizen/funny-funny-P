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
  /**
   * How hard a body accelerates, in metres per second squared.
   *
   * Session 18, and the single biggest thing standing between this walkthrough
   * and one that feels like a game. Before this, `speed` was simply
   * `walkSpeed × magnitude`: full pace on the frame the key went down and a dead
   * stop on the frame it came up. That is not how anything with mass moves, and
   * the eye reads it instantly — it is most of the difference between walking
   * through a building and scrubbing a CAD viewport.
   *
   * 14 m/s² reaches walking pace in about a tenth of a second, which is roughly
   * where every game that feels responsive sits. Much slower and the controls
   * feel like ice; much faster and there is no point having the number at all.
   */
  acceleration: 14,
  /**
   * And how hard it stops, which is deliberately harder than it starts.
   *
   * Real bodies do decelerate faster than they accelerate — you can plant a foot
   * — but the real reason is control. Momentum that overshoots where you meant
   * to stop is the thing people describe as "floaty", and in a tool where
   * somebody is trying to stand in a particular spot to look at a particular
   * wall, floaty is worse than abrupt.
   */
  deceleration: 20,
  /**
   * Eye height when crouched.
   *
   * Not a game affectation. A seated eye is around 1.2 m and this is the only
   * way to answer "what do you see from the sofa" — which, in a room-design
   * tool, is a question people genuinely have.
   */
  crouchEyeHeight: 1.15,
  /** Crouched pace. Slower, as it is. */
  crouchSpeed: 0.7,
  /** How fast the eye drops and rises when crouching, metres per second. */
  crouchEase: 3.5,
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
  /** Whether the crouch modifier is held. */
  crouching: boolean;
  /** Somewhere to jump to instead of walking, if a teleport was confirmed. */
  teleportTo: Point2 | null;
}

export const NO_INTENT: WalkIntent = {
  forward: 0,
  strafe: 0,
  turn: 0,
  snap: 0,
  running: false,
  crouching: false,
  teleportTo: null,
};

/**
 * Moves a value towards a target by at most `rate`, without overshooting.
 *
 * Used for the velocity and for the crouch. A plain lerp would be smoother but
 * would never quite arrive, so a body asked to stop would coast forever at a
 * hundredth of a millimetre per second — which sounds harmless and is exactly
 * what makes the footsteps never quite stop.
 */
function easeTowards(current: number, target: number, rate: number): number {
  const gap = target - current;
  if (Math.abs(gap) <= rate) return target;
  return current + Math.sign(gap) * rate;
}

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
  /**
   * Which way the body is actually travelling, metres per second, in world axes.
   *
   * Kept rather than recomputed because it is now the thing that carries
   * momentum from one frame to the next. It is also genuinely different from
   * `heading × speed` the moment somebody releases a key and coasts, or walks
   * into a wall and slides.
   */
  velocity: Point2;
  /** How far through the crouch, 0 standing to 1 fully down. */
  crouch: number;
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
      velocity: { x: 0, z: 0 },
      crouch: 0,
      stuck: false,
    };
  }

  /**
   * Points the body a given way, without moving it.
   *
   * First person has never needed this: there, the mouse turns the body and
   * `intent.turn` is the only way heading ever changes. Third person is a
   * different contract — the mouse orbits the camera and the body turns to face
   * whichever way you walk — so the caller works out the direction of travel and
   * tells the body to face it.
   *
   * Deliberately a separate method rather than a very large `turn` intent. Those
   * are different statements: `turn` means "rotate at this rate", and rotating
   * at whatever rate happens to land on the right heading this frame would
   * silently depend on the frame time.
   */
  face(heading: number): void {
    this.state = { ...this.state, heading };
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
      // Put somewhere new, not carried there: whatever momentum they had
      // belonged to where they were.
      velocity: { x: 0, z: 0 },
      crouch: 0,
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

    /* ---- How fast they are asking to go ---- */

    const crouch = easeTowards(
      this.state.crouch,
      intent.crouching ? 1 : 0,
      BODY.crouchEase * step,
    );

    let target = { x: 0, z: 0 };

    if (intent.forward !== 0 || intent.strafe !== 0) {
      /*
       * TWO DIFFERENT NUMBERS, AND CONFLATING THEM MADE DIAGONALS FASTER.
       *
       * `raw` is how long the input vector is and is what normalises the
       * DIRECTION. `magnitude` is how hard the stick is pushed, clamped to one,
       * and is what scales the SPEED.
       *
       * They are equal for a thumbstick and they are not equal for a keyboard:
       * holding W and D gives (1, 1), whose length is 1.414. Dividing the
       * direction by the clamped 1 rather than by the real 1.414 left a vector
       * 41% too long, so walking diagonally was 41% faster than walking
       * straight — the oldest bug in first-person movement, present here since
       * session 14 and found by a test written for something else entirely.
       */
      const raw = Math.hypot(intent.forward, intent.strafe);
      const magnitude = Math.min(1, raw);

      /*
       * Crouching wins over running, because holding both is a real thing
       * somebody's hands do by accident and creeping is the more specific
       * request of the two.
       */
      const pace = crouch > 0.5
        ? BODY.crouchSpeed
        : intent.running
          ? BODY.runSpeed
          : BODY.walkSpeed;

      // Heading 0 looks towards +z, which is the convention the rest of the
      // app uses for a piece of furniture facing into a room.
      const sin = Math.sin(heading);
      const cos = Math.cos(heading);
      const forwardVector = { x: sin, z: cos };
      const rightVector = { x: cos, z: -sin };

      /*
       * Dividing by the magnitude normalises the DIRECTION, so walking
       * diagonally is not faster than walking straight — the oldest bug in
       * first-person movement, and one this already got right.
       */
      const wanted = pace * magnitude;
      target = {
        x: ((forwardVector.x * intent.forward + rightVector.x * intent.strafe) / raw) * wanted,
        z: ((forwardVector.z * intent.forward + rightVector.z * intent.strafe) / raw) * wanted,
      };
    }

    /* ---- Momentum ---- */

    /*
     * The velocity is moved TOWARDS what was asked for, at a fixed rate, rather
     * than set to it. That one change is what makes this feel like walking.
     *
     * Accelerating and decelerating at different rates is not a flourish: a body
     * that stops as slowly as it starts overshoots wherever you meant to stand,
     * and in a tool where the whole point is standing in one spot to look at one
     * wall, overshooting is worse than being abrupt.
     */
    const wantsToMove = target.x !== 0 || target.z !== 0;
    const rate = (wantsToMove ? BODY.acceleration : BODY.deceleration) * step;

    let velocity = {
      x: easeTowards(this.state.velocity.x, target.x, rate),
      z: easeTowards(this.state.velocity.z, target.z, rate),
    };

    let desired = this.state.at;
    let speed = Math.hypot(velocity.x, velocity.z);

    if (intent.teleportTo) {
      desired = intent.teleportTo;
      // A jump is not a walk. Arriving with the speed you left at would have
      // you sliding across the room you just landed in.
      velocity = { x: 0, z: 0 };
      speed = 0;
    } else if (speed > 1e-4) {
      desired = {
        x: this.state.at.x + velocity.x * step,
        z: this.state.at.z + velocity.z * step,
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
      this.state = {
        ...this.state,
        heading,
        speed: 0,
        velocity: { x: 0, z: 0 },
        crouch,
        stuck: true,
      };
      return this.state;
    }

    /* ---- The eye catching up ---- */

    const eyeAbove = BODY.eyeHeight + (BODY.crouchEyeHeight - BODY.eyeHeight) * crouch;
    const targetEye = standing.y + eyeAbove;
    const gap = targetEye - this.state.eyeY;
    const ease = BODY.stepEase * step;
    const eyeY =
      Math.abs(gap) <= ease ? targetEye : this.state.eyeY + Math.sign(gap) * ease;

    /*
     * What actually happened, not what was asked for.
     *
     * The solver may have slid the body along a wall or refused the move
     * outright, so the velocity is re-derived from the distance really covered.
     * Without this, walking into a wall leaves a full head of steam pointing
     * into it — and the moment you turn away you shoot off sideways, which is
     * the single most common way momentum goes wrong.
     */
    const jumped = intent.teleportTo !== null;
    const actual = step > 0 && !jumped
      ? { x: (at.x - this.state.at.x) / step, z: (at.z - this.state.at.z) / step }
      : velocity;

    /*
     * A teleport is excluded above, and a test caught why.
     *
     * Re-deriving the velocity from the distance covered is exactly right for
     * walking and nonsense for a jump: five metres in a sixtieth of a second is
     * three hundred metres per second, which the vignette, the footsteps and the
     * figure's legs would all have believed.
     */
    this.state = {
      at,
      standing,
      eyeY,
      heading,
      speed: Math.hypot(actual.x, actual.z),
      velocity: actual,
      crouch,
      stuck,
    };
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

  /*
   * Face the longest sight line in the room, not its centroid.
   *
   * Facing the middle of the storey sounds right and is not: in a single-room
   * house the middle IS where you are standing, so the heading falls back to
   * zero and you enter looking at whichever wall happens to be north. That is
   * exactly what the first browser check showed — a flat grey wall, no floor,
   * no ceiling, nothing to tell you how big the room is.
   *
   * The furthest corner of the room is the view with the most depth in it, and
   * depth is the whole reason somebody pressed the button.
   */
  let heading = 0;
  let furthest = 0;

  for (const corner of biggest.polygon) {
    const dx = corner.x - biggest.interiorPoint.x;
    const dz = corner.z - biggest.interiorPoint.z;
    const distance = Math.hypot(dx, dz);
    if (distance > furthest) {
      furthest = distance;
      heading = Math.atan2(dx, dz);
    }
  }

  return { at: biggest.interiorPoint, standing, heading };
}
