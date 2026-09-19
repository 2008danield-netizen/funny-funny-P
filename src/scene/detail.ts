/**
 * One dial for how much geometry this machine gets.
 *
 * -----------------------------------------------------------------------------
 * EVERY ITEM IN THIS PASS SPENT SOMETHING, AND NOTHING WAS KEEPING COUNT.
 *
 * Subdivision put a vertex every quarter-metre on every wall. The sagitta rule
 * took a stair baluster from six sides to sixteen. Chamfers turned each box
 * from twelve triangles into a hundred and eight. Panelled doors, window
 * sashes, swept mouldings — each was the right call on its own and each was
 * argued on its own, against no budget at all.
 *
 * Measured, on a room with four openings: 35 draw calls, 41,884 triangles. That
 * is nothing, and saying so is the honest finding — there was no crisis to
 * solve and inventing an optimisation for it would have been make-work. What
 * there is instead is a machine at the other end of the range: the tier the
 * quality governor drops to when frames start arriving late, which until now
 * changed the RESOLUTION and the shadow map and nothing about the geometry at
 * all.
 *
 * -----------------------------------------------------------------------------
 * WHY A MODULE-LEVEL DIAL, WHICH IS USUALLY A BAD IDEA.
 *
 * Because the things it governs are built in a dozen places by code that has no
 * business knowing about quality tiers — a furniture builder deciding how round
 * a table leg is, a wall builder deciding how finely to subdivide. Threading a
 * settings object through all of them would put a parameter on thirty
 * functions to be passed unchanged by twenty-nine of them.
 *
 * The cost of that choice is stated plainly: changing the dial does NOT change
 * anything already built. It is read at construction, so the caller has to
 * rebuild — which is exactly what a tier change does anyway.
 */

/**
 * How much geometry to spend, as a multiplier. 1 is full.
 *
 * It is a multiplier on DEMAND rather than on the result, so halving it roughly
 * doubles every tolerance: twice the chord error on a curve, twice the edge
 * length on a subdivided surface. That gives a predictable, proportionate
 * coarsening instead of three unrelated scales.
 */
let detail = 1;

/** The current dial, for anything that has to build geometry. */
export function detailLevel(): number {
  return detail;
}

/**
 * Sets the dial. Clamped, because a zero or a negative would divide by nothing
 * and a very large one would ask for geometry no machine wants.
 */
export function setDetailLevel(next: number): void {
  detail = Math.max(0.25, Math.min(2, next));
}

/**
 * The dial each quality tier runs at.
 *
 * `low` at 0.5 means a curve is allowed twice the chord error and a wall gets
 * vertices every half-metre rather than every quarter. It is a real halving of
 * the geometry and it is not a downgrade anybody will notice on a machine that
 * was already dropping frames — a 0.8 mm wobble on a handrail, against a frame
 * that arrives on time.
 *
 * `high` stays at 1 rather than going above it. The tolerances are already set
 * where the eye stops seeing the difference, so spending more would buy
 * nothing; a tier above full detail would be a number that sounds better.
 */
export const TIER_DETAIL: Record<'low' | 'medium' | 'high', number> = {
  low: 0.5,
  medium: 0.8,
  high: 1,
};
