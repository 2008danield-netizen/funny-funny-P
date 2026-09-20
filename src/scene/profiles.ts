/**
 * Lofting, lathing and sweeping: the three ways to make a shape that is not a box.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS.
 *
 * A triangle census of the furniture catalogue, taken at the start of session 18,
 * found that almost every part in the app is the same shape. Forty-five products,
 * and the number that kept coming back was 300 triangles per part — the exact
 * cost of `chamferedBox`. A LISABO coffee table was 2,100 triangles: seven boxes.
 * An INGOLF chair was eight boxes. DOCKSTA — a pedestal table whose entire visual
 * identity is a turned column flaring into a disc — was 320 triangles, which is a
 * box with a cone stuck under it. A rug was ONE QUAD.
 *
 * The upholstery work in session 17 gave sofas real rounded geometry and stopped
 * there, so the app ended up with beautifully modelled cushions resting on a
 * frame made of cuboids. Everything in this file exists to give the other
 * ninety per cent of the catalogue the same treatment.
 *
 * -----------------------------------------------------------------------------
 * ONE PRIMITIVE, THREE USES.
 *
 * `loft` is the whole file. Give it a stack of closed rings already positioned in
 * space and it stitches them into a skin and caps the ends. Everything else here
 * is a way of GENERATING those rings:
 *
 *   lathe    rings are copies of one profile rotated about the Y axis
 *            → turned legs, pedestals, knobs, lamp bases, shades
 *   sweep    rings are copies of one section carried along a path
 *            → bentwood frames, hairpin legs, bar handles, rolled rug edges
 *   taper    two rings of the same shape at different scales
 *            → tapered table legs, plinths, anything that narrows
 *
 * Keeping them one mechanism matters more than it sounds. The winding order is
 * the part that goes wrong — get it backwards and the shape renders inside out,
 * which under an environment map looks like a slightly odd material rather than
 * like a bug — so it is worth having exactly one place that can be wrong, and
 * one test that proves it is not.
 *
 * -----------------------------------------------------------------------------
 * THE WINDING, DERIVED RATHER THAN GUESSED.
 *
 * Sections are anticlockwise in their own XY plane, and a section's local +Z is
 * the direction the stack advances. Take a unit circle, a point at angle θ, the
 * next at θ + dθ, ring `i` at z = 0 and ring `i+1` at z = 1. The obvious
 * triangle — (i,j), (i+1,j), (i+1,j+1) — has normal
 *
 *     (p1 - p0) × (p2 - p0) = (0,0,1) × (cos(θ+dθ) - cosθ, sin(θ+dθ) - sinθ, 1)
 *                           = (-sin dθ, cos dθ - 1, 0)  ≈  (-dθ, 0, 0)
 *
 * at θ = 0, which points at -X while the surface there is at +X. Inward. The
 * quad has to be wound the other way round, which is what `loft` does below.
 */

import * as THREE from 'three';

import { creaseNormals } from './shading';
import { radialSegments, cornerSegments } from './tessellation';

/** A closed ring of points in space, in order. */
export type Ring = readonly THREE.Vector3[];

export interface LoftOptions {
  /** Close the skin between the last ring and the first. Default false. */
  closed?: boolean;
  /** Cap the first ring. Default true. */
  capStart?: boolean;
  /** Cap the last ring. Default true. */
  capEnd?: boolean;
  /**
   * Crease angle for the finished normals, in degrees.
   *
   * A turned leg wants a large angle so the barrel is smooth and the shoulder
   * where a bead meets a cove stays sharp; a tapered square leg wants a small
   * one so its four faces do not blend into a lozenge. Zero skips creasing and
   * leaves the per-face normals alone.
   */
  crease?: number;
}

/**
 * Stitches a stack of rings into a closed solid.
 *
 * Every ring must have the same number of points, in corresponding order —
 * point `j` of one ring joins point `j` of the next. Rings with too few points,
 * or a stack with fewer than two rings, produce an empty geometry rather than
 * throwing, because these are called from builders driven by catalogue numbers
 * and a degenerate product should lose a part rather than the whole scene.
 */
export function loft(rings: readonly Ring[], options: LoftOptions = {}): THREE.BufferGeometry {
  const { closed = false, capStart = true, capEnd = true, crease = 40 } = options;

  const geometry = new THREE.BufferGeometry();
  if (rings.length < 2) return geometry;

  const width = rings[0]!.length;
  if (width < 3) return geometry;
  for (const ring of rings) {
    if (ring.length !== width) return geometry;
  }

  const positions: number[] = [];
  const indices: number[] = [];

  for (const ring of rings) {
    for (const point of ring) positions.push(point.x, point.y, point.z);
  }

  const spans = closed ? rings.length : rings.length - 1;
  for (let i = 0; i < spans; i++) {
    const a = i * width;
    const b = ((i + 1) % rings.length) * width;
    for (let j = 0; j < width; j++) {
      const k = (j + 1) % width;
      // Wound as derived in the header: outward, not inward.
      indices.push(a + j, b + k, b + j);
      indices.push(a + j, a + k, b + k);
    }
  }

  /*
   * Caps are fans from the ring's own centroid rather than an ear-clipped
   * triangulation.
   *
   * Every ring this file generates is convex or near enough — circles, rounded
   * rectangles, lamp shades — and for those a centroid fan is exact and costs
   * one extra vertex. It would fold on a genuinely concave section, which is
   * why `sweep` takes its section from a caller who knows what it drew.
   */
  const cap = (ringIndex: number, outward: boolean) => {
    const ring = rings[ringIndex]!;
    const base = ringIndex * width;

    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const point of ring) {
      cx += point.x;
      cy += point.y;
      cz += point.z;
    }
    const centre = positions.length / 3;
    positions.push(cx / width, cy / width, cz / width);

    for (let j = 0; j < width; j++) {
      const k = (j + 1) % width;
      if (outward) indices.push(centre, base + j, base + k);
      else indices.push(centre, base + k, base + j);
    }
  };

  if (!closed) {
    // The start cap looks back down the stack, so its winding is reversed.
    if (capStart) cap(0, false);
    if (capEnd) cap(rings.length - 1, true);
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return crease > 0 ? creaseNormals(geometry, crease) : geometry;
}

/* ------------------------------- Sections ------------------------------- */

/**
 * A circle, anticlockwise, as a 2D section.
 *
 * Segment count comes from the radius through `radialSegments`, so an 8 mm
 * handle and a 300 mm pedestal are each exactly as round as their own size
 * deserves rather than sharing an arbitrary constant.
 */
export function circleSection(radius: number, sides = radialSegments(radius)): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    points.push(new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius));
  }
  return points;
}

/**
 * A rounded rectangle, anticlockwise, as a 2D section.
 *
 * The corner radius is clamped to half the shorter side, because a leg
 * 24 mm square with a 20 mm radius asked for is a circle, and silently
 * becoming one is better than self-intersecting.
 */
export function roundedRectSection(
  width: number,
  height: number,
  radius: number,
  segments = cornerSegments(radius),
): THREE.Vector2[] {
  const halfW = Math.max(1e-5, width / 2);
  const halfH = Math.max(1e-5, height / 2);
  const r = Math.max(0, Math.min(radius, halfW, halfH));

  if (r < 1e-5) {
    return [
      new THREE.Vector2(halfW, -halfH),
      new THREE.Vector2(halfW, halfH),
      new THREE.Vector2(-halfW, halfH),
      new THREE.Vector2(-halfW, -halfH),
    ];
  }

  const points: THREE.Vector2[] = [];
  const steps = Math.max(1, segments);
  const corners: [number, number, number][] = [
    [halfW - r, -halfH + r, -Math.PI / 2],
    [halfW - r, halfH - r, 0],
    [-halfW + r, halfH - r, Math.PI / 2],
    [-halfW + r, -halfH + r, Math.PI],
  ];

  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= steps; i++) {
      const angle = start + (i / steps) * (Math.PI / 2);
      points.push(new THREE.Vector2(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r));
    }
  }
  return points;
}

/* -------------------------------- Lathe --------------------------------- */

/** One point on a turned profile: how far from the axis, and how high. */
export interface TurnedPoint {
  /** Distance from the axis of rotation, in metres. */
  r: number;
  /** Height above the piece's origin, in metres. */
  y: number;
}

/**
 * Revolves a profile about the Y axis.
 *
 * Built through `loft` rather than `THREE.LatheGeometry` for one reason: a lathe
 * geometry is an open tube, and almost everything turned in this app — a knob, a
 * finial, a lamp base — needs its ends closed. Feeding the profile through the
 * common path means the caps, the winding and the creasing are the same code
 * that every other shape here uses.
 *
 * A profile point with `r = 0` closes to the axis on its own, so a knob is drawn
 * by starting and ending at zero and no cap is needed; the degenerate ring is
 * harmless and `creaseNormals` merges it away.
 */
export function lathe(
  profile: readonly TurnedPoint[],
  sides = radialSegments(Math.max(...profile.map((point) => point.r))),
  crease = 60,
): THREE.BufferGeometry {
  if (profile.length < 2) return new THREE.BufferGeometry();

  /*
   * The rings run along the PROFILE and the stitch runs AROUND, which is the
   * opposite of how a lathe is usually described.
   *
   * Written the intuitive way — one ring per angle, stitched along the profile —
   * the stack is a closed loop and the caps land on the two halves of a profile
   * slice rather than on the ends of the turned form. This way each ring is a
   * horizontal circle at one profile height, the stack runs bottom to top, and
   * `closed: true` joins the last angle back to the first.
   */
  /*
   * The angle runs BACKWARDS, and that is not a typo.
   *
   * `loft` was derived for a right-handed frame: the section lies in local XY
   * and the stack advances along local +Z. A lathe puts its rings in the world
   * XZ plane and advances along world +Y, and (X, Z, Y) is left-handed — the
   * determinant is -1, so every triangle comes out wound inward and the solid
   * renders inside out. Traversing the circle the other way restores the
   * handedness without mirroring anything, because a surface of revolution
   * traversed backwards is the same surface.
   *
   * This is exactly the defect `profiles.test.ts` exists to catch: it is
   * invisible on screen and unambiguous as a signed volume.
   */
  const rings: Ring[] = profile.map((point) => {
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = -(i / sides) * Math.PI * 2;
      ring.push(new THREE.Vector3(Math.cos(angle) * point.r, point.y, Math.sin(angle) * point.r));
    }
    return ring;
  });

  return loft(rings, { crease, capStart: profile[0]!.r > 1e-5, capEnd: profile[profile.length - 1]!.r > 1e-5 });
}

/* -------------------------------- Sweep --------------------------------- */

export interface SweepOptions {
  /**
   * The direction the section's local +X should try to follow.
   *
   * Every curve this is used for in furniture — a bentwood side frame, a hairpin
   * leg, the rolled edge of a rug — lies in a single plane, and for a planar
   * curve the honest answer is simply "keep the section's width along the axis
   * the curve does not use". Defaults to world X, which is the width of a piece
   * whose curve runs in the YZ plane, and that is the common case.
   */
  axis?: THREE.Vector3;
  capStart?: boolean;
  capEnd?: boolean;
  crease?: number;
  /** Scale applied to the section, per path point. Defaults to 1 throughout. */
  scale?: (t: number, index: number) => number;
}

/**
 * Carries a 2D section along a 3D path.
 *
 * -----------------------------------------------------------------------------
 * WHY AN AXIS AND NOT A FRENET FRAME.
 *
 * The textbook answer is a Frenet frame from the curve's own derivatives, and
 * the textbook also warns that it flips at an inflection point and is undefined
 * on a straight run — both of which a piece of furniture is full of. A hairpin
 * leg is straight, then bent, then straight; a Frenet frame would spin the
 * section ninety degrees in the middle of it.
 *
 * Projecting a fixed reference axis onto the plane perpendicular to the tangent
 * has neither problem for a planar curve, and a planar curve is what bent
 * plywood and bent steel tube actually are. The fallback for the case where the
 * tangent runs along the reference axis is arbitrary but never reached in a
 * planar sweep, because there the tangent is perpendicular to it by definition.
 */
export function sweep(
  section: readonly THREE.Vector2[],
  path: readonly THREE.Vector3[],
  options: SweepOptions = {},
): THREE.BufferGeometry {
  const { axis = new THREE.Vector3(1, 0, 0), capStart = true, capEnd = true, crease = 40, scale } = options;
  if (path.length < 2 || section.length < 3) return new THREE.BufferGeometry();

  const rings: Ring[] = [];
  const tangent = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const fallback = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < path.length; i++) {
    const here = path[i]!;
    const before = path[Math.max(0, i - 1)]!;
    const after = path[Math.min(path.length - 1, i + 1)]!;

    // The central difference, so a mitre at an interior point splits the turn
    // between its two edges instead of jumping at one of them.
    tangent.subVectors(after, before);
    if (tangent.lengthSq() < 1e-12) tangent.subVectors(after, here);
    if (tangent.lengthSq() < 1e-12) continue;
    tangent.normalize();

    u.copy(axis).addScaledVector(tangent, -axis.dot(tangent));
    if (u.lengthSq() < 1e-8) {
      u.copy(fallback).addScaledVector(tangent, -fallback.dot(tangent));
    }
    u.normalize();
    v.crossVectors(tangent, u).normalize();

    const factor = scale ? scale(path.length > 1 ? i / (path.length - 1) : 0, i) : 1;
    rings.push(
      section.map((point) =>
        new THREE.Vector3(
          here.x + u.x * point.x * factor + v.x * point.y * factor,
          here.y + u.y * point.x * factor + v.y * point.y * factor,
          here.z + u.z * point.x * factor + v.z * point.y * factor,
        ),
      ),
    );
  }

  return loft(rings, { capStart, capEnd, crease });
}

/* -------------------------------- Taper --------------------------------- */

export interface TaperOptions {
  /** Section scale at the top, relative to the bottom. 1 is a prism. */
  topScale?: number;
  /** Extra rings along the height, for a curved rather than straight taper. */
  steps?: number;
  /**
   * Eases the taper so the shape swells slightly instead of running dead
   * straight — the entasis a joiner puts on a turned leg so it does not read as
   * pinched in the middle. Zero is a straight cone.
   */
  belly?: number;
  crease?: number;
}

/**
 * Lofts one section between two heights, narrowing as it rises.
 *
 * This is the replacement for the square-stick table leg, and the difference it
 * makes is out of all proportion to its cost: a leg 40 mm at the apron and 24 mm
 * at the floor has a silhouette that changes down its length, so the eye reads
 * it as a made object rather than as a rectangle of colour.
 */
export function taperedProfile(
  section: readonly THREE.Vector2[],
  bottom: number,
  top: number,
  options: TaperOptions = {},
): THREE.BufferGeometry {
  const { topScale = 1, steps = 1, belly = 0, crease = 25 } = options;
  const height = top - bottom;
  if (Math.abs(height) < 1e-6 || section.length < 3) return new THREE.BufferGeometry();

  const count = Math.max(1, Math.round(steps));
  const rings: Ring[] = [];

  /*
   * Reversed for the same handedness reason as `lathe`: the section is laid in
   * world XZ and the stack climbs world +Y, which is left-handed against the
   * frame `loft` assumes. Reversing the TRAVERSAL rather than negating a
   * coordinate matters — negating Z would mirror the section, which is
   * invisible on the symmetric sections used today and would silently flip an
   * asymmetric one the first time somebody passed one in.
   */
  const ordered = [...section].reverse();

  for (let i = 0; i <= count; i++) {
    const t = i / count;
    // A sine hump is zero at both ends, so the belly never disturbs the two
    // dimensions the catalogue actually specifies.
    const factor = 1 + (topScale - 1) * t + Math.sin(t * Math.PI) * belly;
    const y = bottom + height * t;
    rings.push(ordered.map((point) => new THREE.Vector3(point.x * factor, y, point.y * factor)));
  }

  return loft(rings, { crease });
}
