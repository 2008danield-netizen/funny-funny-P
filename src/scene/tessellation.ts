/**
 * How many segments a curve needs, asked in one place.
 *
 * -----------------------------------------------------------------------------
 * THE NUMBERS WERE SCATTERED, AND THEY WERE GUESSES.
 *
 * Before this, every curved thing in the building carried its own hard-coded
 * segment count, written by whoever built it and never revisited: a stair
 * baluster on six, a drain pipe on ten, a door handle on sixteen, a figure's
 * forearm on twelve. None of them were wrong on purpose. They were each a
 * reasonable-looking number typed while looking at that one object, and the
 * result was a building where a 20 mm handrail is visibly a hexagon and a 40 mm
 * pipe you never go near is smoother than it needs to be.
 *
 * The failure is worse than it sounds, because a polygonal silhouette is one of
 * the few things that reads as "computer graphics" from any distance at all.
 * Shading can be fixed later; an outline that is made of straight lines cannot.
 *
 * -----------------------------------------------------------------------------
 * THE RIGHT QUESTION IS NOT "HOW MANY SIDES" BUT "HOW FAR OFF".
 *
 * A flat chord across a circular arc departs from the true circle by its
 * SAGITTA — the gap at the middle of the chord. For a segment spanning angle t
 * on a circle of radius r that gap is
 *
 *     sagitta = r * (1 - cos(t / 2))
 *
 * and it is the thing an eye actually sees: the wobble in the silhouette, in
 * millimetres, at the object's own size. Fixing the sagitta instead of the
 * segment count makes a handle and a column both as round as each other, and
 * makes both of them exactly as round as they need to be and no rounder.
 *
 * Rearranged for the segment count:
 *
 *     t = 2 * acos(1 - error / r)
 *     segments = ceil(arc / t)
 *
 * -----------------------------------------------------------------------------
 * WHAT IT COSTS.
 *
 * More than the old guesses, on small things especially — a 20 mm baluster goes
 * from six sides to sixteen. That is a lot in percentage terms and nothing in
 * absolute terms: twenty extra triangles on an object the size of a finger.
 * Where it would actually cost something is on large radii, and that is what
 * `MAX_SEGMENTS` is for.
 */

/**
 * How far a flat chord may depart from the true curve, in metres.
 *
 * 0.4 mm, which is roughly the width of a pencil line at arm's length. Below
 * this the difference stops being visible and starts being triangles nobody
 * asked for; above it, small round things begin to show their corners.
 */
export const CHORD_ERROR = 0.0004;

/**
 * The fewest sides anything gets.
 *
 * A very small radius would otherwise come out as a triangle, which is
 * arithmetically correct — the sagitta really is under half a millimetre — and
 * reads as a modelling mistake rather than as a small round object.
 */
export const MIN_SEGMENTS = 8;

/**
 * The most sides anything gets.
 *
 * At a metre radius the formula asks for a hundred and eleven, and the last
 * sixty of those are arguing about a tenth of a millimetre on something the
 * size of a table. This is where the curve stops being about the eye and starts
 * being about the budget.
 *
 * It bites at a radius of about 187 mm, above which the chord error is allowed
 * to grow — to roughly a millimetre on a half-metre column, which is nothing on
 * an object that size. A test pins both halves of that statement.
 */
export const MAX_SEGMENTS = 48;

/**
 * Segments around a curve of the given radius.
 *
 * `arc` is how much of the circle is actually drawn, in radians — a full
 * cylinder is the default, a quarter round needs a quarter of the segments for
 * the same smoothness, and asking for the whole circle's worth on a quarter
 * would quadruple the cost for no visible gain.
 *
 * `detail` scales the demand for a quality tier: a half means twice the
 * permitted error, which is roughly half the segments.
 */
export function radialSegments(radius: number, arc: number = Math.PI * 2, detail = 1): number {
  /*
   * The floor and ceiling scale with the arc, and forgetting that is a real
   * mistake rather than a rounding one.
   *
   * `MIN_SEGMENTS` is eight sides on a FULL circle. Applying the same eight to
   * a quarter round makes it four times smoother than a whole cylinder of the
   * same radius, which is four times the triangles on exactly the small eased
   * edges there are thousands of. The first version of this did that, and it
   * turned a 2 mm chamfer into eight-segment geometry on every box in the
   * building.
   */
  const share = Math.max(0, arc) / (Math.PI * 2);
  const floor = Math.max(2, Math.round(MIN_SEGMENTS * share));
  const ceiling = Math.max(floor, Math.round(MAX_SEGMENTS * share));

  if (!(radius > 0) || !(arc > 0)) return floor;

  const error = CHORD_ERROR / Math.max(0.05, detail);

  /*
   * A radius smaller than the permitted error has no shape worth resolving —
   * the whole object is finer than the tolerance. `acos` of a negative number
   * is still defined, but the segment count it implies is meaningless, so this
   * takes the minimum rather than letting the arithmetic produce nonsense.
   */
  if (error >= radius) return floor;

  const step = 2 * Math.acos(1 - error / radius);
  const wanted = Math.ceil(arc / step);

  return Math.max(floor, Math.min(ceiling, wanted));
}

/**
 * Segments around and up a sphere of the given radius.
 *
 * Height segments are half the width, which is the standard ratio and is not
 * arbitrary: a sphere's rings run from pole to pole, half a turn, while its
 * segments run all the way round. Equal counts would make the triangles twice
 * as tall as they are wide near the equator, which shows on a silhouette.
 *
 * The height count is also forced even, so there is a ring exactly on the
 * equator. Without it the widest part of the sphere — the only part of it whose
 * outline is ever seen — falls between two rings and is measurably narrow.
 */
export function sphereSegments(radius: number, detail = 1): { width: number; height: number } {
  const width = radialSegments(radius, Math.PI * 2, detail);
  const height = Math.max(6, Math.round(width / 2 / 2) * 2);
  return { width, height };
}

/**
 * Segments along a rounded corner of the given radius, for a chamfer or fillet.
 *
 * A quarter turn, so a quarter of the segments — and floored at two, because
 * one segment across a corner is a flat cut rather than a round one, which is a
 * chamfer and not a fillet.
 */
export function cornerSegments(radius: number, detail = 1): number {
  return Math.max(2, Math.min(8, radialSegments(radius, Math.PI / 2, detail)));
}
