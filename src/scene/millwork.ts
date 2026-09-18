/**
 * Mouldings, and edges that are not mathematically sharp.
 *
 * -----------------------------------------------------------------------------
 * WHY A ROOM BUILT OUT OF BOXES LOOKS LIKE A ROOM BUILT OUT OF BOXES.
 *
 * Session 18, and the complaint that started it was exactly right: "flat pieces
 * of 2D shapes crudely put together". A survey of the scene found 11 boxes and 5
 * planes holding up the entire building. A wall was a box. A door was a slab. The
 * skirting — 90 mm tall and standing 16 mm proud — was ONE QUAD. A single
 * rectangle, with no top surface, no return into the wall and no section at all.
 *
 * Two things follow from that, and both are why it reads as computer graphics
 * rather than as a room:
 *
 *   NOTHING HAS A PROFILE. Real joinery is not rectangular. A skirting board has
 *   a moulded section — a bullnose or an ogee — and that section catches light in
 *   a band that runs the length of every wall, at ankle height, in every room
 *   anybody has ever been in. Take it away and the eye has nothing to read the
 *   junction with.
 *
 *   NOTHING HAS A CHAMFER. Every edge in the model meets at a mathematically
 *   perfect corner. No physical edge does: timber is eased, plaster is rounded by
 *   the trowel, steel is broken. Those tiny chamfers are typically under two
 *   millimetres and they are the single most reliable tell that a picture is
 *   synthetic, because a perfect edge produces a perfectly abrupt change of
 *   shading and a real one produces a thin highlight.
 *
 * -----------------------------------------------------------------------------
 * PROFILES ARE REAL SECTIONS, MEASURED IN MILLIMETRES.
 *
 * Same rule as everything else here: a sofa is 2.28 m wide because the real one
 * is, and a torus skirting is 19 mm thick with a 12 mm bullnose because the real
 * one is. That keeps the model honest when somebody prices the joinery, and it
 * means the light behaves the way light behaves on that section rather than on a
 * shape chosen because it looked about right.
 */

import * as THREE from 'three';
// A Three example rather than core, which is why it is worth naming explicitly:
// it rounds all twelve edges including the corner vertices, which a flat chamfer
// does not, and the corners are the ones nearest the eye.
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import type { Point2 } from '@/state/types';

/**
 * One point on a moulding's cross-section.
 *
 * `out` is how far it stands proud of the wall and `up` is its height above the
 * floor, both in metres. The section is read in order and swept along the wall,
 * so the points run from where the moulding meets the wall at the bottom, out
 * across the face, and back to the wall at the top.
 */
export interface SectionPoint {
  out: number;
  up: number;
}

/**
 * A profiled skirting board: 100 mm tall, 19 mm thick, with a bullnose top.
 *
 * The section reads from the floor upwards. The important part is the last
 * third: the face rises plumb to 72 mm and then rolls back to the wall over the
 * remaining 28, which is what puts a soft horizontal highlight along the top
 * edge of every skirting in the world. The old flat quad had no such edge, so a
 * room's floor-to-wall junction was a single hard line.
 */
export const SKIRTING: readonly SectionPoint[] = [
  { out: 0, up: 0 },
  { out: 0.019, up: 0.004 },
  { out: 0.019, up: 0.072 },
  { out: 0.018, up: 0.082 },
  { out: 0.014, up: 0.091 },
  { out: 0.008, up: 0.097 },
  { out: 0, up: 0.1 },
];

/**
 * A coved cornice where the wall meets the ceiling, 65 mm on each face.
 *
 * Measured DOWN from the ceiling, so `up` is negative, and swept from the WALL
 * to the CEILING — out and up, in that order. The direction matters and the
 * first attempt got it backwards.
 *
 * A cove bridges the corner, so its face looks into the room and downwards. The
 * normal is the perpendicular of the direction the section is travelled in, and
 * a section running out-and-DOWN has no perpendicular that points into the room
 * at all: both of them point either into the wall or up at the ceiling. Written
 * that way round it rendered as a hairline, lit as though it faced away, which
 * looked exactly like a cornice too small to see rather than one inside out.
 *
 * Travelled out and UP, the perpendicular comes out at (out, -up) — into the
 * room and downwards — which is where a cove actually faces.
 */
export const CORNICE: readonly SectionPoint[] = [
  { out: 0, up: -0.065 },
  { out: 0.003, up: -0.05 },
  { out: 0.011, up: -0.036 },
  { out: 0.023, up: -0.021 },
  { out: 0.04, up: -0.009 },
  { out: 0.065, up: 0 },
];

/**
 * Architrave round a door or window opening: 68 mm wide, 18 mm thick, chamfered.
 *
 * Swept along the opening's perimeter rather than round a room, so `out` is
 * depth into the room and `up` is distance across the face from the opening.
 */
export const ARCHITRAVE: readonly SectionPoint[] = [
  { out: 0, up: 0 },
  { out: 0.018, up: 0.006 },
  { out: 0.018, up: 0.052 },
  { out: 0.014, up: 0.062 },
  { out: 0, up: 0.068 },
];

/* ------------------------------ Sweeping ---------------------------------- */

/** Where a section sits vertically: on the floor, or hung from the ceiling. */
export interface SweepOptions {
  /** Height the section's `up = 0` sits at. */
  baseY: number;
  /** Closed loop in plan, anticlockwise, as `findRegions` produces. */
  polygon: readonly Point2[];
}

/**
 * Sweeps a cross-section around a closed loop, mitred at every corner.
 *
 * -----------------------------------------------------------------------------
 * THE MITRE IS THE WHOLE JOB, AND IT IS NOT THE OBVIOUS THING.
 *
 * The obvious implementation offsets each profile point along the EDGE's inward
 * normal. That is right in the middle of a wall and wrong at every corner: two
 * walls meeting at a right angle each push their moulding 19 mm off their own
 * face, and the two runs cross in the corner and stick through one another.
 *
 * A real carpenter cuts a mitre, and the geometric equivalent is to offset along
 * the BISECTOR of the two edges meeting at that vertex, by a distance scaled by
 * 1/sin(half the interior angle). At 90° that is a factor of 1.414 — exactly the
 * diagonal — and the two runs meet on the corner instead of through it.
 *
 * Without the scale the mitre still crosses, just less obviously, which is worse:
 * it produces a hairline gap that flickers as the camera moves and is very hard
 * to diagnose from a screenshot.
 */
export function sweepSection(
  section: readonly SectionPoint[],
  options: SweepOptions,
): THREE.BufferGeometry | null {
  const { polygon, baseY } = options;
  if (polygon.length < 3 || section.length < 2) return null;

  const count = polygon.length;

  /** Unit direction of the edge leaving vertex `i`. */
  const edgeDirection = (i: number): Point2 => {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % count]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: dx / length, z: dz / length };
  };

  /** Inward normal of that edge. Regions are anticlockwise, so left-hand. */
  const edgeNormal = (i: number): Point2 => {
    const d = edgeDirection(i);
    return { x: -d.z, z: d.x };
  };

  /**
   * The mitre offset at vertex `i`: a direction, and how far along it one metre
   * of profile depth reaches.
   */
  const mitreAt = (i: number): { x: number; z: number } => {
    const incoming = edgeNormal((i - 1 + count) % count);
    const outgoing = edgeNormal(i);

    let x = incoming.x + outgoing.x;
    let z = incoming.z + outgoing.z;
    const length = Math.hypot(x, z);

    // A straight-through vertex, or a perfect reversal. Fall back to the edge
    // normal rather than dividing by nothing.
    if (length < 1e-6) return outgoing;

    x /= length;
    z /= length;

    /*
     * `cos` here is the cosine of half the turn, and dividing by it is the
     * 1/sin(half-interior-angle) scale described above written the other way up.
     * Clamped, because a needle-thin spike in a traced plan would otherwise send
     * the moulding off to infinity.
     */
    const cos = Math.max(0.35, x * outgoing.x + z * outgoing.z);
    return { x: x / cos, z: z / cos };
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  /** Distance travelled round the loop, so the texture runs continuously. */
  const along: number[] = [0];
  for (let i = 1; i <= count; i++) {
    const a = polygon[i - 1]!;
    const b = polygon[i % count]!;
    along.push(along[i - 1]! + Math.hypot(b.x - a.x, b.z - a.z));
  }

  const mitres = polygon.map((_, i) => mitreAt(i));

  for (let i = 0; i < count; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % count]!;
    const ma = mitres[i]!;
    const mb = mitres[(i + 1) % count]!;

    for (let s = 0; s < section.length - 1; s++) {
      const low = section[s]!;
      const high = section[s + 1]!;

      // Four corners of one strip of the section, along one wall.
      const p00 = [a.x + ma.x * low.out, baseY + low.up, a.z + ma.z * low.out];
      const p10 = [b.x + mb.x * low.out, baseY + low.up, b.z + mb.z * low.out];
      const p11 = [b.x + mb.x * high.out, baseY + high.up, b.z + mb.z * high.out];
      const p01 = [a.x + ma.x * high.out, baseY + high.up, a.z + ma.z * high.out];

      /*
       * The normal comes from the SECTION, not from the face.
       *
       * A moulding's shading is the story of its cross-section turning through
       * the light, so each strip's normal is the profile's own slope rotated
       * into the wall's direction. Using a face normal instead gives a correct
       * but faceted result, and on a 65 mm cove that facets into visible bands.
       */
      const dOut = high.out - low.out;
      const dUp = high.up - low.up;
      const sectionLength = Math.hypot(dOut, dUp) || 1;
      const nOut = dUp / sectionLength;
      const nUp = -dOut / sectionLength;

      const wallNormal = edgeNormal(i);
      const nx = wallNormal.x * nOut;
      const nz = wallNormal.z * nOut;

      const u0 = along[i]!;
      const u1 = along[i + 1]!;

      const strip: Array<[number[], number, number]> = [
        [p00, u0, low.up],
        [p10, u1, low.up],
        [p11, u1, high.up],
        [p00, u0, low.up],
        [p11, u1, high.up],
        [p01, u0, high.up],
      ];

      for (const [p, u, v] of strip) {
        positions.push(p[0]!, p[1]!, p[2]!);
        normals.push(nx, nUp, nz);
        uvs.push(u, v);
      }
    }
  }

  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

/* ------------------------------- Chamfers --------------------------------- */

/**
 * The size of the chamfer put on an ordinary edge, in metres.
 *
 * Two millimetres. Small enough to be honest — a machined timber arris is about
 * this, and a plastered corner rather more — and large enough to survive being
 * rendered: at a metre away, two millimetres is a couple of pixels, which is
 * exactly the width of the highlight a real edge shows.
 *
 * Going bigger is tempting and wrong. Five millimetres starts reading as moulded
 * plastic, and on a cabinet door it makes the gap between doors look like a
 * chamfer rather than a gap.
 */
export const CHAMFER = 0.002;

/**
 * A box with its edges taken off.
 *
 * A drop-in replacement for `BoxGeometry` wherever the object is a real physical
 * thing rather than a diagram. `RoundedBoxGeometry` is used rather than a
 * hand-built chamfer because it rounds all twelve edges including the corners,
 * which is what a real eased edge does; a true flat chamfer leaves the corner
 * vertices sharp and they are the ones closest to the eye.
 *
 * The radius is clamped to a fraction of the smallest dimension, so that asking
 * for a 2 mm chamfer on a 3 mm-thick panel does not turn it into a lozenge.
 */
export function chamferedBox(
  width: number,
  height: number,
  depth: number,
  radius = CHAMFER,
): THREE.BufferGeometry {
  const smallest = Math.min(width, height, depth);
  const safe = Math.min(radius, smallest * 0.2);

  // Below a tenth of a millimetre there is nothing to see and the extra
  // triangles are waste.
  if (safe < 0.0001) return new THREE.BoxGeometry(width, height, depth);

  return new RoundedBoxGeometry(width, height, depth, 1, safe);
}

