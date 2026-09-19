/**
 * The things that make moving feel like moving.
 *
 * -----------------------------------------------------------------------------
 * NONE OF THIS CHANGES WHERE YOU ARE.
 *
 * Every function here is a pure function of the walk state, and all any of them
 * do is nudge the camera. That separation is the point: the walker stays a
 * testable resolution of intent against geometry, and the question of whether
 * the result FEELS right is answered somewhere it cannot corrupt.
 *
 * It matters because these are the settings people turn off. Head bob is loved
 * by most and makes a minority ill within a minute, and a field-of-view kick is
 * worse again in that respect. So each has to be removable without touching
 * anything that decides where a body ends up.
 *
 * -----------------------------------------------------------------------------
 * THE BOB IS DRIVEN BY THE STRIDE, WHICH IS WHY IT IS HERE AND NOT IN A TIMER.
 *
 * A head bob keyed to a clock drifts against the footsteps, and the eye and the
 * ear both notice — it is the same failure as the figure's legs landing off
 * their own footfall. The stride is already the one place that knows how far
 * through a step somebody is, so the bob reads it, and the head reaches the
 * bottom of its travel at exactly the moment the foot lands and the sound plays.
 */

import type { StrideSample } from './stride';

/**
 * How far the head drops at each footfall, in metres.
 *
 * A real walking head moves about 25 mm at a comfortable pace. That is the right
 * figure for the FIGURE, which is watched from outside. Seen from inside, the
 * same amplitude is far too much — the camera is the head, so the whole world
 * moves instead of a small object in it, and anything near the real number reads
 * as a limp. Film and games both land around a third of life.
 */
const BOB_RISE = 0.009;

/** And how far it swings side to side, which is half as much again per stride. */
const BOB_SWAY = 0.006;

/** Speed at which the bob is at full strength, in metres per second. */
const BOB_FULL_SPEED = 1.4;

export interface HeadBob {
  /** Vertical offset to add to the eye, in metres. */
  rise: number;
  /** Sideways offset, across the direction of travel, in metres. */
  sway: number;
}

/**
 * Where the head is within its step.
 *
 * The vertical component runs at twice the rate of the sideways one, and that
 * ratio is the whole shape of a walk: the body drops once per STEP, on each
 * footfall, but leans once per STRIDE, because the two legs lean it opposite
 * ways. Getting that backwards produces a strange skipping gait that people
 * cannot name but can see.
 */
export function headBob(stride: StrideSample, speed: number): HeadBob {
  if (!stride.moving) return { rise: 0, sway: 0 };

  const strength = Math.min(1, speed / BOB_FULL_SPEED);

  // Lowest at the footfall, highest at mid-stance, back down at the next.
  const rise = -Math.cos(stride.phase * Math.PI * 2);

  /*
   * Half the rate, and which way it leans depends on which foot is down — so
   * the leading foot decides the phase, exactly as it does for the figure's
   * legs. Without that, both steps lean the same way and it reads as a limp.
   */
  const half = stride.leading === 'right' ? 0 : Math.PI;
  const sway = Math.sin(stride.phase * Math.PI + half);

  return {
    rise: rise * BOB_RISE * strength,
    sway: sway * BOB_SWAY * strength,
  };
}

/* ------------------------------ Field of view ----------------------------- */

/** The resting field of view, in degrees. Matches the orbit camera's. */
export const BASE_FOV = 50;

/**
 * How much wider the view gets at a run.
 *
 * Six degrees, which is small enough that nobody consciously notices it and
 * large enough that everybody feels it. Widening the field of view increases
 * the apparent rate at which the edges of the frame sweep past, and that sweep
 * is most of how speed is perceived at all — which is why every game that has
 * a sprint has this, and why a sprint without it feels like walking with the
 * numbers turned up.
 *
 * Deliberately modest for a second reason: field-of-view change is one of the
 * strongest triggers for simulator sickness there is, and this is a tool people
 * may be inside for an hour.
 */
const FOV_KICK = 6;

/** How quickly the view opens and closes again, in degrees per second. */
const FOV_RATE = 26;

/**
 * Eases the field of view towards where this speed wants it.
 *
 * Rate-limited rather than snapped, because an instant field-of-view change
 * is a visual discontinuity — it reads as the world briefly changing size,
 * which is both ugly and, for the susceptible, the most nauseating thing here.
 */
export function easeFov(current: number, speed: number, running: boolean, delta: number): number {
  // Only a genuine run opens it. Walking fast downhill is not a sprint.
  const wanted = running && speed > 1.6 ? BASE_FOV + FOV_KICK : BASE_FOV;
  const step = FOV_RATE * delta;
  const gap = wanted - current;
  if (Math.abs(gap) <= step) return wanted;
  return current + Math.sign(gap) * step;
}
