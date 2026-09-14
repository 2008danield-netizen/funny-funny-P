/**
 * How long frames are actually taking.
 *
 * -----------------------------------------------------------------------------
 * MEASURE BEFORE CUTTING ANYTHING.
 *
 * The temptation with a headset is to strip the renderer down in advance,
 * because everybody knows a standalone headset is slow. The trouble is that
 * "everybody knows" is usually wrong in both directions at once: the thing you
 * cut turns out to have been nearly free, and the thing that is actually
 * costing you eight milliseconds was never suspected.
 *
 * So this exists first, and the quality decisions come after it, from a number.
 *
 * -----------------------------------------------------------------------------
 * PERCENTILES, NOT AVERAGES.
 *
 * An average frame time hides exactly what matters. Ninety frames at 8 ms and
 * ten at 40 ms averages to 11 ms and looks fine; in a headset those ten frames
 * are a visible stutter and a queasy one. The 95th percentile is where that
 * shows up, so that is what is reported alongside the median.
 *
 * -----------------------------------------------------------------------------
 * AND THE BUDGET IS NOT NEGOTIABLE IN A HEADSET.
 *
 * On a desktop a slow frame is a slow frame. At 90 Hz a missed frame is
 * reprojected by the runtime, and a run of them is felt in the inner ear. The
 * budget below is the real one — 11.1 ms at 90 Hz, less the runtime's own share
 * — rather than a target somebody would like to hit.
 */

export interface FrameStats {
  /** Frames per second, from the median frame time. */
  fps: number;
  /** The typical frame, milliseconds. */
  medianMs: number;
  /** The slow tail — one frame in twenty is at least this long. */
  p95Ms: number;
  /** The worst frame in the window. */
  worstMs: number;
  /** How many frames in this window missed the budget. */
  missed: number;
  /** What the budget was, so a reader knows what it was measured against. */
  budgetMs: number;
  /** Frames measured. Below a full window the figures are provisional. */
  samples: number;
}

/**
 * Frame budgets, in milliseconds.
 *
 * The headset figure leaves about 1.5 ms for the runtime's own compositing and
 * reprojection, which the app never sees but which comes out of the same frame.
 */
export const BUDGET = {
  desktop: 16.6,
  headset: 9.6,
} as const;

export class FrameBudget {
  private times: number[] = [];
  private capacity: number;
  private budgetMs: number;

  constructor(capacity = 120, budgetMs: number = BUDGET.desktop) {
    this.capacity = capacity;
    this.budgetMs = budgetMs;
  }

  /** Switches the budget when entering or leaving a headset. */
  setBudget(budgetMs: number): void {
    if (budgetMs === this.budgetMs) return;
    this.budgetMs = budgetMs;
    // The old window was measured against a different bar, so its "missed"
    // count no longer means anything. Start again rather than mix them.
    this.times = [];
  }

  record(frameMs: number): void {
    // A tab that was backgrounded returns one enormous frame. It is real and it
    // is not information about this scene, so it is dropped rather than left to
    // dominate the worst-frame figure for the next two seconds.
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 500) return;

    this.times.push(frameMs);
    if (this.times.length > this.capacity) this.times.shift();
  }

  reset(): void {
    this.times = [];
  }

  get stats(): FrameStats {
    if (this.times.length === 0) {
      return {
        fps: 0,
        medianMs: 0,
        p95Ms: 0,
        worstMs: 0,
        missed: 0,
        budgetMs: this.budgetMs,
        samples: 0,
      };
    }

    const sorted = [...this.times].sort((a, b) => a - b);
    const at = (fraction: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;

    const medianMs = at(0.5);

    return {
      fps: medianMs > 0 ? 1000 / medianMs : 0,
      medianMs,
      p95Ms: at(0.95),
      worstMs: sorted[sorted.length - 1]!,
      missed: sorted.filter((time) => time > this.budgetMs).length,
      budgetMs: this.budgetMs,
      samples: sorted.length,
    };
  }

  /**
   * A one-line summary, for the panel and for the console.
   *
   * Written to be pasteable: somebody reporting that a headset feels bad should
   * be able to send this line and have it mean something.
   */
  get summary(): string {
    const stats = this.stats;
    if (stats.samples === 0) return 'no frames measured yet';

    const share = Math.round((stats.missed / stats.samples) * 100);
    return (
      `${stats.fps.toFixed(0)} fps · median ${stats.medianMs.toFixed(1)} ms · ` +
      `95th ${stats.p95Ms.toFixed(1)} ms · worst ${stats.worstMs.toFixed(1)} ms · ` +
      `${share}% over ${stats.budgetMs} ms`
    );
  }
}
