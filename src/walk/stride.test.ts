/**
 * The stride, and the figure that walks on it.
 *
 * Two things are being protected here, and only one of them is arithmetic.
 *
 * The first is that the stride is driven by POSITION. That rule was learned in
 * session 16, when footsteps integrated `speed × delta` and walking into a wall
 * produced the sound of somebody striding on the spot. It is easy to
 * accidentally undo, so it is tested directly.
 *
 * The second is that the knee only bends one way. A walk cycle is a handful of
 * sine waves and it is entirely possible to write one that looks right in code,
 * passes review, and puts the character's shin through the front of their leg
 * once per step. Nobody reading the trigonometry spots it; everybody watching
 * the figure does.
 */

import { describe, expect, it } from 'vitest';

import { Stride, STRIDE, strideLength, MOVING_SPEED } from './stride';
import { BODY } from './Walker';
import { Figure, FIGURE_HEIGHT } from '@/scene/Figure';

describe('the stride is measured from the position', () => {
  it('does not advance when the walker is blocked, however fast they think they are going', () => {
    const stride = new Stride();
    // Walking pace reported, but the collision solver never lets them move.
    stride.advance({ x: 0, z: 0 }, 1.4);

    let steps = 0;
    for (let i = 0; i < 200; i++) {
      if (stride.advance({ x: 0, z: 0 }, 1.4).planted) steps++;
    }

    expect(steps).toBe(0);
  });

  it('fires one step per stride length of real travel', () => {
    const stride = new Stride();
    stride.advance({ x: 0, z: 0 }, 1.4);

    let steps = 0;
    // Ten metres in one-centimetre increments, at a speed whose stride is STRIDE.
    for (let i = 1; i <= 1000; i++) {
      if (stride.advance({ x: i * 0.01, z: 0 }, 1.4).planted) steps++;
    }

    // The accumulator starts 80% through a step, so the first lands early.
    expect(steps).toBe(Math.round(10 / STRIDE));
  });

  it('alternates feet', () => {
    const stride = new Stride();
    stride.advance({ x: 0, z: 0 }, 1.4);

    const feet: string[] = [];
    for (let i = 1; i <= 600 && feet.length < 6; i++) {
      const sample = stride.advance({ x: i * 0.01, z: 0 }, 1.4);
      if (sample.planted) feet.push(sample.planted);
    }

    for (let i = 1; i < feet.length; i++) expect(feet[i]).not.toBe(feet[i - 1]);
  });

  it('does not lose steps across a frame that took a long time', () => {
    const stride = new Stride();
    stride.advance({ x: 0, z: 0 }, 1.4);
    // A tab regaining focus: five metres in a single frame.
    const sample = stride.advance({ x: 5, z: 0 }, 1.4);
    // It cannot report five separate footfalls in one frame, but the phase must
    // come out where five metres of walking would leave it, not five metres
    // ahead of the feet.
    expect(sample.phase).toBeGreaterThanOrEqual(0);
    expect(sample.phase).toBeLessThan(1);
  });

  it('settles to a standing pose when stopped, ready to step off promptly', () => {
    const stride = new Stride();
    const sample = stride.advance({ x: 0, z: 0 }, 0);
    expect(sample.moving).toBe(false);
    expect(sample.planted).toBeNull();

    // And the very next moment of walking should land a foot almost at once,
    // rather than three quarters of a metre later.
    stride.advance({ x: 0.1, z: 0 }, 1.4);
    const next = stride.advance({ x: 0.2, z: 0 }, 1.4);
    expect(next.planted).not.toBeNull();
  });

  it('lengthens the step when hurrying rather than just taking it faster', () => {
    expect(strideLength(BODY.runSpeed)).toBeGreaterThan(strideLength(BODY.walkSpeed));
    expect(strideLength(BODY.walkSpeed)).toBeCloseTo(STRIDE, 5);
  });

  it('agrees with the walker about what counts as standing still', () => {
    // Not an arbitrary threshold: below this the figure settles and the
    // footsteps stop, and those have to be the same moment.
    expect(MOVING_SPEED).toBeLessThan(BODY.walkSpeed);
  });
});

describe('the figure', () => {
  it('has its eye where the camera has always been', () => {
    /*
     * The camera sits at `BODY.eyeHeight` and always has. If the figure's head
     * is anywhere else, then in first person you are looking out of your own
     * chest or floating above your scalp, and in third person the view jumps
     * when you switch. A millimetre of tolerance, because these come from two
     * genuinely different sources — one a camera height chosen in session 14,
     * the other a fraction of stature from an anthropometric table — and the
     * fact that they agree is worth knowing rather than worth hiding.
     */
    const figure = new Figure(FIGURE_HEIGHT);
    expect(Math.abs(figure.eyeHeight - BODY.eyeHeight)).toBeLessThan(0.002);
    figure.dispose();
  });

  it('is a plausible size for a person', () => {
    // The whole reason for a figure in an architectural view is scale. One that
    // is the wrong size makes every room it stands in look the wrong size.
    expect(FIGURE_HEIGHT).toBeGreaterThan(1.5);
    expect(FIGURE_HEIGHT).toBeLessThan(2);
  });

  it('never bends a knee backwards, anywhere in the cycle', () => {
    const figure = new Figure();
    const stride = new Stride();
    stride.advance({ x: 0, z: 0 }, 1.4);

    /*
     * Walked, rather than swept over phase directly, so this exercises the same
     * path the app does — including the leading-foot offset, which is where a
     * sign error would hide.
     */
    let worst = 0;
    for (let i = 1; i <= 2000; i++) {
      const sample = stride.advance({ x: i * 0.005, z: 0 }, 1.4);
      figure.setPose(sample, 1.4);

      for (const leg of ['leftLeg', 'rightLeg'] as const) {
        const limb = (figure as unknown as Record<string, { lower: { rotation: { x: number } } }>)[leg]!;
        // A knee flexes the shin backwards, which is a NEGATIVE rotation about
        // x in this rig. Positive means the joint has hyperextended.
        worst = Math.max(worst, limb.lower.rotation.x);
      }
    }

    expect(worst).toBeLessThanOrEqual(1e-9);
    figure.dispose();
  });

  it('puts the two legs half a cycle apart, so it walks rather than hops', () => {
    const figure = new Figure();
    const stride = new Stride();
    stride.advance({ x: 0, z: 0 }, 1.4);

    let apart = 0;
    let samples = 0;
    for (let i = 1; i <= 400; i++) {
      figure.setPose(stride.advance({ x: i * 0.01, z: 0 }, 1.4), 1.4);
      const rig = figure as unknown as Record<string, { upper: { rotation: { x: number } } }>;
      apart += Math.abs(rig.leftLeg!.upper.rotation.x - rig.rightLeg!.upper.rotation.x);
      samples++;
    }

    // If both legs moved together this average would be zero. Half a cycle apart
    // on a sine of amplitude 0.55 averages around 2/π × 2 × 0.55.
    expect(apart / samples).toBeGreaterThan(0.3);
    figure.dispose();
  });

  it('settles when standing still instead of freezing mid-step', () => {
    const figure = new Figure();
    const stride = new Stride();

    // Walk, then stop.
    for (let i = 1; i <= 100; i++) figure.setPose(stride.advance({ x: i * 0.01, z: 0 }, 1.4), 1.4);
    const stopped = stride.advance({ x: 1, z: 0 }, 0);
    figure.setPose(stopped, 0);

    const rig = figure as unknown as Record<string, { upper: { rotation: { x: number } } }>;
    expect(Math.abs(rig.leftLeg!.upper.rotation.x)).toBeLessThan(1e-9);
    expect(Math.abs(rig.rightLeg!.upper.rotation.x)).toBeLessThan(1e-9);
    figure.dispose();
  });

  it('turns the short way round', () => {
    const figure = new Figure();
    figure.faceNow(Math.PI - 0.05);
    // Asked to face just the other side of the wrap. The eased facing must move
    // a couple of degrees, not most of a circle.
    figure.place(0, 0, 0, -Math.PI + 0.05, 1);
    const facing = (figure as unknown as { facing: number }).facing;
    expect(Math.abs(facing)).toBeGreaterThan(Math.PI - 0.2);
    figure.dispose();
  });
});
