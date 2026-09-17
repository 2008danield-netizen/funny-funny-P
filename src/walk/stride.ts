/**
 * Where you are in a step.
 *
 * -----------------------------------------------------------------------------
 * ONE STRIDE, TWO CONSUMERS, AND THAT IS THE WHOLE POINT.
 *
 * Session 16 gave the walkthrough footsteps, timed by accumulating the distance
 * actually travelled and firing a sound every 0.75 m. Session 18 gives it a
 * visible body whose legs have to swing. Those are obviously the same question —
 * *how far through a step is this person?* — and answering it twice would
 * guarantee that the foot plants at a different moment from the sound.
 *
 * That mismatch is exactly the kind of thing nobody notices in code review and
 * everybody notices on screen. A figure whose heel lands a tenth of a second
 * after the footfall does not read as "slightly out of sync", it reads as
 * broken, in the same way badly dubbed speech does.
 *
 * So the stride lives here, the soundscape asks it when to make a noise, and the
 * figure asks it where the legs are. One accumulator, one answer.
 *
 * -----------------------------------------------------------------------------
 * MEASURED FROM THE POSITION, NOT FROM THE SPEED.
 *
 * Inherited from the soundscape, where it was learned the hard way. The walker
 * reports the speed it INTENDED; the collision solver decides where it actually
 * ended up. Walk into a wall and the two diverge completely — speed stays at
 * walking pace while the position does not move — and a stride driven by speed
 * has you striding on the spot, audibly and now visibly.
 */

/**
 * One step, in metres.
 *
 * An adult's step is somewhere around 0.75 m and a full stride (both feet) twice
 * that. This is the STEP: the distance between one heel strike and the next,
 * which is what both the sound and the animation are counting.
 */
export const STRIDE = 0.75;

/**
 * Below this, a person is standing rather than walking.
 *
 * Shared with the soundscape so that the moment the footsteps stop is the same
 * moment the legs settle.
 */
export const MOVING_SPEED = 0.15;

/**
 * Step length at a given speed.
 *
 * A longer stride when hurrying, rather than the same stride taken faster. That
 * is what people actually do — cadence rises far less than speed does — and the
 * difference is audible in the footsteps and visible in the legs.
 */
export function strideLength(speed: number): number {
  return STRIDE * (1 + Math.max(0, speed - 1.4) * 0.25);
}

/** Which foot is coming down. */
export type Foot = 'left' | 'right';

export interface StrideSample {
  /**
   * Position within the current step, 0 at one heel strike and approaching 1 at
   * the next.
   *
   * The figure reads this continuously; the soundscape only cares about the
   * moment it wraps.
   */
  phase: number;
  /** The foot that just landed, on the frame it lands, and null otherwise. */
  planted: Foot | null;
  /** Which foot is currently forward — the one that landed most recently. */
  leading: Foot;
  /** True while the walker is moving at all, so the pose can settle when not. */
  moving: boolean;
}

/**
 * The stride accumulator.
 *
 * Deliberately not a pure function: a step is a thing that happens over time and
 * something has to remember how far through it we are. Everything else about it
 * is derived.
 */
export class Stride {
  private travelled = 0;
  private foot: Foot = 'right';
  private previous: { x: number; z: number } | null = null;

  /**
   * Advances the stride to a new position.
   *
   * Takes the position rather than a distance so that no caller can accidentally
   * pass a speed-derived number, which is the bug this module exists to prevent.
   */
  advance(at: { x: number; z: number }, speed: number): StrideSample {
    const previous = this.previous;
    this.previous = { x: at.x, z: at.z };

    const moved = previous ? Math.hypot(at.x - previous.x, at.z - previous.z) : 0;

    if (speed < MOVING_SPEED && moved < 1e-4) {
      /*
       * Reset to most of a step when standing, not to zero.
       *
       * Starting from zero means the first footfall of every walk comes three
       * quarters of a metre after setting off, which feels like a lag in the
       * sound and looks like a glide in the legs. Starting most of the way
       * through means the first step lands almost immediately, which is what
       * happens when a person starts walking.
       */
      this.travelled = STRIDE * 0.8;
      return { phase: 0, planted: null, leading: this.foot, moving: false };
    }

    this.travelled += moved;

    const length = strideLength(speed);
    let planted: Foot | null = null;

    /*
     * `while`, not `if`.
     *
     * A frame that took a long time — a tab regaining focus, a garbage
     * collection, a slow first frame after the textures upload — can cover more
     * than one step. Firing only one would silently lose the others and leave
     * the phase permanently ahead of the feet.
     */
    while (this.travelled >= length) {
      this.travelled -= length;
      this.foot = this.foot === 'left' ? 'right' : 'left';
      planted = this.foot;
    }

    return {
      phase: this.travelled / length,
      planted,
      leading: this.foot,
      moving: true,
    };
  }

  /** Forgets where the walker was, for when they are put somewhere new. */
  reset(): void {
    this.previous = null;
    this.travelled = STRIDE * 0.8;
  }
}
