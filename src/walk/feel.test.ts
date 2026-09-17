/**
 * Momentum, and the things that sell it.
 *
 * The walker's own tests cover what it collides with and where it ends up.
 * These cover how it gets there, which until session 18 was "instantly": speed
 * was `walkSpeed × magnitude`, so a body went from nothing to walking pace on
 * the frame a key went down and back to nothing on the frame it came up.
 *
 * That is not a subtle wrongness. It is most of the difference between walking
 * through a building and scrubbing a CAD viewport, and it is the first thing
 * anybody who has played a game notices.
 */

import { describe, expect, it } from 'vitest';

import { BODY, NO_INTENT, Walker, type WalkIntent } from './Walker';
import { headBob, easeFov, BASE_FOV } from './feel';
import { createDefaultDocument } from '@/state/defaults';
import { addRectangle, normalizePlan } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import { resetGroundCache, standingAt } from './ground';
import type { DesignDocument } from '@/state/types';

/**
 * A 12 x 8 room with a walker standing in the middle of it.
 *
 * The same fixture the rest of the walk tests use, and big enough that a body
 * accelerating for a second does not reach a wall before the measurement does.
 */
function walkerInRoom(): { doc: DesignDocument; walker: Walker } {
  resetGroundCache();
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
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

  const at = { x: 6, z: 4 };
  const standing = standingAt(doc, at, 0);
  if (!standing) throw new Error('nowhere to stand in the test room');
  return { doc, walker: new Walker(at, standing) };
}

const forward = (extra: Partial<WalkIntent> = {}): WalkIntent => ({
  ...NO_INTENT,
  forward: 1,
  ...extra,
});

/** Runs the walker for a while at 60 fps and hands back every state. */
function run(walker: Walker, doc: DesignDocument, intent: WalkIntent, seconds: number) {
  const step = 1 / 60;
  const states = [];
  for (let t = 0; t < seconds; t += step) states.push(walker.update(doc, intent, step));
  return states;
}

describe('the walker has weight', () => {
  it('does not reach walking pace on the first frame', () => {
    const { doc, walker } = walkerInRoom();
    const first = walker.update(doc, forward(), 1 / 60);
    expect(first.speed).toBeGreaterThan(0);
    expect(first.speed).toBeLessThan(BODY.walkSpeed * 0.4);
  });

  it('gets there quickly enough not to feel like ice', () => {
    const { doc, walker } = walkerInRoom();
    const states = run(walker, doc, forward(), 0.25);
    const top = states[states.length - 1]!.speed;
    // A tenth of a second to pace is the target; a quarter is generous headroom.
    expect(top).toBeGreaterThan(BODY.walkSpeed * 0.95);
  });

  it('coasts to a stop rather than stopping dead', () => {
    const { doc, walker } = walkerInRoom();
    run(walker, doc, forward(), 0.5);
    const moving = walker.current.speed;
    expect(moving).toBeGreaterThan(1);

    const first = walker.update(doc, { ...NO_INTENT }, 1 / 60);
    expect(first.speed).toBeLessThan(moving);
    expect(first.speed).toBeGreaterThan(0);
  });

  it('stops faster than it starts, so it does not overshoot the spot you wanted', () => {
    /*
     * The reason this matters in THIS app rather than in a game: somebody is
     * trying to stand in one particular place to look at one particular wall.
     * Floaty overshoot is worse than being slightly abrupt.
     */
    expect(BODY.deceleration).toBeGreaterThan(BODY.acceleration);
  });

  it('does not keep a head of steam pointing into a wall', () => {
    /*
     * The classic momentum bug. Walk into a wall, the solver refuses the move,
     * but the velocity keeps accumulating into it — then the moment you turn
     * away you shoot off sideways at whatever had built up.
     */
    const { doc, walker } = walkerInRoom();

    // Long enough to cross a twelve-metre room several times over and pile
    // into the far corner, rather than merely long enough to get going.
    const into: WalkIntent = { ...NO_INTENT, forward: 1, strafe: 1, running: true };
    run(walker, doc, into, 12);

    // Pinned against the corner, whatever the keys still say.
    expect(walker.current.speed).toBeLessThan(0.1);
  });

  it('arrives from a teleport standing still', () => {
    const { doc, walker } = walkerInRoom();
    run(walker, doc, forward({ running: true }), 1);
    expect(walker.current.speed).toBeGreaterThan(1);

    const landed = walker.update(doc, { ...NO_INTENT, teleportTo: { x: 2.5, z: 2.5 } }, 1 / 60);
    expect(landed.speed).toBe(0);
  });

  it('crouches, and creeps when it does', () => {
    const { doc, walker } = walkerInRoom();
    const standingEye = walker.current.eyeY;

    const states = run(walker, doc, forward({ crouching: true }), 1.5);
    const down = states[states.length - 1]!;

    expect(down.crouch).toBeCloseTo(1, 2);
    expect(down.eyeY).toBeLessThan(standingEye - 0.3);
    expect(down.speed).toBeLessThan(BODY.walkSpeed);

    // And stands back up.
    const up = run(walker, doc, forward(), 1.5);
    expect(up[up.length - 1]!.crouch).toBe(0);
  });

  it('does not walk diagonally faster than it walks straight', () => {
    const straight = walkerInRoom();
    const diagonal = walkerInRoom();

    run(straight.walker, straight.doc, forward(), 1);
    run(diagonal.walker, diagonal.doc, forward({ strafe: 1 }), 1);

    expect(diagonal.walker.current.speed).toBeLessThanOrEqual(
      straight.walker.current.speed + 1e-6,
    );
  });
});

describe('the head bob', () => {
  it('is still when standing still', () => {
    const bob = headBob({ phase: 0.3, planted: null, leading: 'right', moving: false }, 0);
    expect(bob.rise).toBe(0);
    expect(bob.sway).toBe(0);
  });

  it('is at the bottom of its travel when the foot lands', () => {
    /*
     * The whole reason the bob reads the stride rather than a clock. The foot
     * plants at phase zero and that is the moment the footstep sound plays, so
     * it had better also be the moment the head is lowest — otherwise the eye
     * and the ear disagree by a fraction of a step, which people notice without
     * being able to say why.
     */
    const at = (phase: number) =>
      headBob({ phase, planted: null, leading: 'right', moving: true }, 1.4).rise;

    expect(at(0)).toBeLessThan(at(0.25));
    expect(at(0)).toBeLessThan(at(0.5));
    // Highest at mid-stance, when the supporting leg is straight underneath.
    expect(at(0.5)).toBeGreaterThan(at(0.25));
  });

  it('leans opposite ways on opposite feet, so it is a walk and not a limp', () => {
    const left = headBob({ phase: 0.25, planted: null, leading: 'left', moving: true }, 1.4);
    const right = headBob({ phase: 0.25, planted: null, leading: 'right', moving: true }, 1.4);
    expect(Math.sign(left.sway)).toBe(-Math.sign(right.sway));
  });

  it('sways at half the rate it rises', () => {
    // The body drops once per STEP but leans once per STRIDE, because the two
    // legs lean it opposite ways. Over one step, rise completes a full cycle and
    // sway completes half of one.
    const sample = (phase: number) =>
      headBob({ phase, planted: null, leading: 'right', moving: true }, 1.4);
    expect(sample(0).rise).toBeCloseTo(sample(1).rise, 6);
    expect(sample(0).sway).toBeCloseTo(-sample(1).sway, 6);
  });

  it('stays small enough to be felt rather than seen', () => {
    // The camera IS the head, so an anatomically correct 25 mm moves the whole
    // world and reads as a limp. Film and games both sit near a third of life.
    let worst = 0;
    for (let i = 0; i <= 100; i++) {
      const bob = headBob(
        { phase: i / 100, planted: null, leading: 'right', moving: true },
        BODY.runSpeed,
      );
      worst = Math.max(worst, Math.abs(bob.rise), Math.abs(bob.sway));
    }
    expect(worst).toBeLessThan(0.012);
  });

  it('fades out at a crawl rather than bobbing at full strength', () => {
    const slow = headBob({ phase: 0.5, planted: null, leading: 'right', moving: true }, 0.2);
    const fast = headBob({ phase: 0.5, planted: null, leading: 'right', moving: true }, 1.4);
    expect(Math.abs(slow.rise)).toBeLessThan(Math.abs(fast.rise));
  });
});

describe('the field of view', () => {
  it('opens when running and closes again when not', () => {
    let fov = BASE_FOV;
    for (let i = 0; i < 60; i++) fov = easeFov(fov, BODY.runSpeed, true, 1 / 60);
    expect(fov).toBeGreaterThan(BASE_FOV);

    for (let i = 0; i < 60; i++) fov = easeFov(fov, 0, false, 1 / 60);
    expect(fov).toBe(BASE_FOV);
  });

  it('does not open just because somebody is walking quickly', () => {
    let fov = BASE_FOV;
    for (let i = 0; i < 60; i++) fov = easeFov(fov, BODY.walkSpeed, false, 1 / 60);
    expect(fov).toBe(BASE_FOV);
  });

  it('never jumps, because an instant change reads as the world resizing', () => {
    let fov = BASE_FOV;
    let biggest = 0;
    for (let i = 0; i < 60; i++) {
      const next = easeFov(fov, BODY.runSpeed, true, 1 / 60);
      biggest = Math.max(biggest, Math.abs(next - fov));
      fov = next;
    }
    expect(biggest).toBeLessThan(1);
  });
});
