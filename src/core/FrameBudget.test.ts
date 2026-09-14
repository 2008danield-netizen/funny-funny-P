/**
 * Tests for the frame budget.
 *
 * Small, and worth having because the whole quality plan for the headset rests
 * on these numbers being right. A percentile that is quietly wrong would make
 * the app cut the wrong thing.
 */

import { describe, expect, it } from 'vitest';

import { BUDGET, FrameBudget } from './FrameBudget';

describe('the frame budget', () => {
  it('reports nothing before it has measured anything', () => {
    const budget = new FrameBudget();
    expect(budget.stats.samples).toBe(0);
    expect(budget.summary).toMatch(/no frames/i);
  });

  it('turns the median frame time into frames per second', () => {
    const budget = new FrameBudget();
    for (let i = 0; i < 60; i += 1) budget.record(10);

    expect(budget.stats.medianMs).toBeCloseTo(10, 6);
    expect(budget.stats.fps).toBeCloseTo(100, 6);
  });

  it('shows the slow tail that an average would hide', () => {
    /*
     * The reason this reports percentiles at all. Ninety frames at 8 ms and ten
     * at 40 ms averages to 11.2 ms and looks perfectly healthy; in a headset
     * those ten frames are a visible stutter and a queasy one.
     */
    const budget = new FrameBudget();
    for (let i = 0; i < 90; i += 1) budget.record(8);
    for (let i = 0; i < 10; i += 1) budget.record(40);

    const stats = budget.stats;
    expect(stats.medianMs).toBeCloseTo(8, 6);
    expect(stats.p95Ms).toBeGreaterThan(30);
    expect(stats.worstMs).toBeCloseTo(40, 6);
  });

  it('counts the frames that missed the budget', () => {
    const budget = new FrameBudget(120, 10);
    for (let i = 0; i < 8; i += 1) budget.record(9);
    for (let i = 0; i < 2; i += 1) budget.record(20);

    expect(budget.stats.missed).toBe(2);
    expect(budget.summary).toContain('20% over 10 ms');
  });

  it('holds a fixed window rather than growing forever', () => {
    const budget = new FrameBudget(10);
    for (let i = 0; i < 50; i += 1) budget.record(12);
    expect(budget.stats.samples).toBe(10);
  });

  it('throws away the giant frame a backgrounded tab returns', () => {
    // Real, and not information about this scene. Left in, it dominates the
    // worst-frame figure for the next two seconds and hides everything else.
    const budget = new FrameBudget();
    for (let i = 0; i < 30; i += 1) budget.record(9);
    budget.record(4000);

    expect(budget.stats.worstMs).toBeCloseTo(9, 6);
    expect(budget.stats.samples).toBe(30);
  });

  it('starts again when the budget changes', () => {
    /*
     * Entering a headset moves the bar from 16.6 ms to 9.6 ms. The frames
     * already measured were judged against the old one, so their "missed"
     * count means nothing now — mixing them would report a headset as
     * comfortable on the strength of desktop frames.
     */
    const budget = new FrameBudget(120, BUDGET.desktop);
    for (let i = 0; i < 40; i += 1) budget.record(12);
    expect(budget.stats.missed).toBe(0);

    budget.setBudget(BUDGET.headset);
    expect(budget.stats.samples).toBe(0);
  });

  it('holds the headset to a tighter bar than the desktop', () => {
    expect(BUDGET.headset).toBeLessThan(BUDGET.desktop);
    // 90 Hz is 11.1 ms; the runtime's own compositing comes out of the same
    // frame, so the app's share is smaller again.
    expect(BUDGET.headset).toBeLessThan(11.1);
  });
});
