/**
 * When to draw, and how hard to work.
 *
 * -----------------------------------------------------------------------------
 * AN IDLE EDITOR SHOULD COST NOTHING.
 *
 * The old loop rendered sixty times a second forever. Nothing on screen was
 * changing for most of that — somebody reading the advisor panel is not moving
 * the camera — and every one of those frames also re-walked every wall in the
 * building to decide which to hide, and re-decided whether to draw the roof.
 * On a laptop that is a fan spinning up for no reason, and it is a large part
 * of why the app felt choppy: the GPU was already busy when the user finally
 * did move, so the first frames of a drag arrived late.
 *
 * So rendering is now DEMAND-DRIVEN. Anything that changes what should be on
 * screen calls `invalidate()`. Between those calls the loop does nothing at
 * all — until the camera stops, at which point it starts spending its idle
 * frames making the image better instead.
 *
 * -----------------------------------------------------------------------------
 * THE THREE STATES.
 *
 *   MOVING      — the camera or the document changed this frame. Render one
 *                 cheap sample at reduced resolution. Responsiveness is the
 *                 only thing that matters; nobody can see detail mid-drag.
 *   CONVERGING  — nothing has changed for a moment. Keep rendering the same
 *                 view with jittered camera and sun, averaging into the
 *                 accumulation buffer. The image visibly improves.
 *   CONVERGED   — enough samples. Stop entirely. Zero GPU until something
 *                 changes.
 *
 * The transition out of MOVING is deliberately delayed by a few frames. Without
 * that, releasing the mouse mid-flick starts a convergence that the camera's
 * own inertia immediately invalidates, and the accumulation restarts several
 * times in a row — which looks like flickering rather than refining.
 */

/** How hard this machine can be pushed. */
export type QualityTier = 'low' | 'medium' | 'high';

export interface QualitySettings {
  /** Device pixel ratio ceiling while the camera is still. */
  pixelRatio: number;
  /** Ratio while moving. Lower means blurrier but smoother dragging. */
  movingPixelRatio: number;
  /** Shadow map resolution. */
  shadowMapSize: number;
  /** How many jittered samples to accumulate before stopping. */
  maxSamples: number;
  /** Whether ambient occlusion runs at all. */
  ambientOcclusion: boolean;
}

/**
 * The three tiers.
 *
 * `low` is not a punishment — it is the tier that makes a modest laptop feel
 * GOOD. It renders at a lower resolution while moving and accumulates fewer
 * samples, but it still converges to a soft-shadowed, occluded image, because
 * that convergence costs time rather than per-frame power. A slow machine
 * simply takes two seconds to get there instead of one.
 */
export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    pixelRatio: 1,
    movingPixelRatio: 0.6,
    shadowMapSize: 1024,
    maxSamples: 32,
    ambientOcclusion: true,
  },
  medium: {
    pixelRatio: 1.5,
    movingPixelRatio: 0.85,
    shadowMapSize: 2048,
    maxSamples: 64,
    ambientOcclusion: true,
  },
  high: {
    pixelRatio: 2,
    movingPixelRatio: 1,
    shadowMapSize: 4096,
    maxSamples: 128,
    ambientOcclusion: true,
  },
};

/**
 * Watches the frame time and decides which tier this machine belongs in.
 *
 * Measured rather than guessed from the GPU string, because the string is
 * unreliable (masked behind "ANGLE (Intel, ...)" on most Windows machines) and
 * because what matters is the frame time this scene actually achieves on this
 * window size, not what the hardware could do in principle.
 *
 * It only ever moves DOWN a tier automatically. Moving up on a couple of fast
 * frames would oscillate — a scene gets cheap when you zoom out, and promoting
 * on that would demote again the moment you zoom back in.
 */
export class QualityGovernor {
  private tier: QualityTier;
  private manual = false;
  private frameTimes: number[] = [];
  private lastDemotion = 0;

  constructor(initial: QualityTier = 'medium') {
    this.tier = initial;
  }

  get current(): QualityTier {
    return this.tier;
  }

  get settings(): QualitySettings {
    return QUALITY[this.tier];
  }

  /** The user picked a tier by hand; stop second-guessing them. */
  setManual(tier: QualityTier): void {
    this.tier = tier;
    this.manual = true;
    this.frameTimes = [];
  }

  setAutomatic(): void {
    this.manual = false;
    this.frameTimes = [];
  }

  get isManual(): boolean {
    return this.manual;
  }

  /**
   * Records a frame and demotes if the machine is visibly struggling.
   *
   * Uses the MEDIAN of the last 30 frames rather than the mean, so one long
   * frame — a garbage collection, a document rebuild, the browser deciding to
   * lay out a panel — does not drop the whole app a tier. Those spikes are
   * routine and they are not what "this machine is too slow" looks like.
   */
  record(frameMs: number, now: number): void {
    if (this.manual) return;

    this.frameTimes.push(frameMs);
    if (this.frameTimes.length < 30) return;
    if (this.frameTimes.length > 30) this.frameTimes.shift();

    // Not more than once every three seconds, so a demotion has time to help.
    if (now - this.lastDemotion < 3000) return;

    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    // Below 30 fps while moving is where dragging starts to feel wrong.
    if (median > 33 && this.tier !== 'low') {
      this.tier = this.tier === 'high' ? 'medium' : 'low';
      this.lastDemotion = now;
      this.frameTimes = [];
    }
  }
}

/**
 * A demand-driven animation loop.
 *
 * `invalidate()` marks the frame dirty and, if the loop is asleep, wakes it.
 * The callback is handed how long it has been since the previous frame and
 * whether anything actually changed, and returns whether it wants another
 * frame — which is how convergence keeps itself going without the loop needing
 * to know what convergence is.
 */
export class FrameLoop {
  private handle: number | null = null;
  private dirty = true;
  private last = 0;
  private render: (delta: number, dirty: boolean) => boolean;

  constructor(render: (delta: number, dirty: boolean) => boolean) {
    this.render = render;
  }

  /** Something changed; draw again. */
  invalidate(): void {
    this.dirty = true;
    this.wake();
  }

  private wake(): void {
    if (this.handle !== null) return;
    this.last = performance.now();
    this.handle = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.handle = null;

    const delta = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    const wasDirty = this.dirty;
    this.dirty = false;

    const wantsMore = this.render(delta, wasDirty);

    // Re-arm only if the frame asked for it or something dirtied us mid-render.
    if (wantsMore || this.dirty) {
      this.handle = requestAnimationFrame(this.tick);
    }
  };

  stop(): void {
    if (this.handle !== null) cancelAnimationFrame(this.handle);
    this.handle = null;
  }
}
