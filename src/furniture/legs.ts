/**
 * Legs, feet and the small turned hardware that says a thing was manufactured.
 *
 * -----------------------------------------------------------------------------
 * WHY LEGS GOT THEIR OWN FILE.
 *
 * Because the census said so. Every leg in the catalogue was a `chamferedBox`
 * 35 mm square running floor to apron, which is 300 triangles spent on a shape
 * whose silhouette is identical at the top and the bottom. Real furniture legs
 * are almost never prisms: they taper, they turn, they splay, they are bent
 * tube, or they are not legs at all but a plinth. The difference is most of what
 * distinguishes a LISABO from a LACK from a HEMNES, and the app was drawing all
 * three the same.
 *
 * Legs are also the part of a room closest to the floor, which is where the
 * baked ambient gradient is strongest and where contact shadows land. A shape
 * that changes down its length picks that gradient up; a prism cannot.
 *
 * -----------------------------------------------------------------------------
 * WHAT A STYLE IS.
 *
 * A style is a claim about how the leg was made, and the geometry follows from
 * it rather than the other way round:
 *
 *   square-taper   sawn from solid and planed — four faces, narrowing downward
 *   round-taper    turned on a lathe, with a slight entasis
 *   turned         turned with beads and coves, the traditional profile
 *   splayed        square-taper, raked outward in both axes (mid-century)
 *   tube           bent or cut steel tube with a plastic glide
 *   hairpin        a single rod bent into a loop and brazed to a plate
 *   plinth         no leg: a recessed base the carcass sits on
 *
 * Nothing here takes a triangle budget as an argument. Detail comes from
 * `radialSegments`, which is already driven by the app's global detail dial, so
 * a leg on the low tier is the same shape with fewer sides rather than a
 * different and worse shape.
 */

import * as THREE from 'three';

import { chamferedBox } from '@/scene/millwork';
import {
  circleSection,
  lathe,
  roundedRectSection,
  sweep,
  taperedProfile,
  type TurnedPoint,
} from '@/scene/profiles';
import { radialSegments } from '@/scene/tessellation';

export type LegStyle =
  | 'square-taper'
  | 'round-taper'
  | 'turned'
  | 'splayed'
  | 'tube'
  | 'hairpin'
  | 'post'
  | 'plinth';

/** How a leg meets the floor. */
export type FootStyle = 'none' | 'glide' | 'disc' | 'castor';

export interface LegOptions {
  /** Where the leg stands, in the piece's local XZ. */
  at: [number, number];
  /** Floor level for this leg. Normally zero. */
  bottom?: number;
  /** Where the leg meets whatever it carries. */
  top: number;
  /** Thickness at the top, in metres. */
  thickness: number;
  style: LegStyle;
  foot?: FootStyle;
  /**
   * Which way the leg leans, for the styles that lean.
   *
   * A splayed leg has to rake AWAY from the piece's centre, so the caller passes
   * the sign of its own position rather than having this file guess from the
   * coordinates — a leg at x = 0 on a two-legged bench has no sign to infer.
   */
  rake?: [number, number];
}

/**
 * The turned profile behind `style: 'turned'`.
 *
 * Read bottom to top as fractions of the leg's length and of its thickness: a
 * square pad at the floor, a cove, a bead, the long tapered shaft, and a square
 * block at the top where the apron is screwed to it. The block matters — a
 * turned leg that stays round all the way up has nowhere for a rail to land and
 * reads as a spindle.
 */
const TURNED_PROFILE: readonly { t: number; r: number }[] = [
  { t: 0.0, r: 0.0 },
  { t: 0.0, r: 0.46 },
  { t: 0.02, r: 0.5 },
  { t: 0.05, r: 0.5 },
  { t: 0.07, r: 0.38 },
  { t: 0.1, r: 0.34 },
  { t: 0.13, r: 0.46 },
  { t: 0.16, r: 0.48 },
  { t: 0.19, r: 0.4 },
  { t: 0.55, r: 0.33 },
  { t: 0.78, r: 0.36 },
  { t: 0.82, r: 0.46 },
  { t: 0.85, r: 0.5 },
  { t: 1.0, r: 0.5 },
];

/** A plain lathe-turned taper with a soft entasis, for `round-taper`. */
const ROUND_PROFILE: readonly { t: number; r: number }[] = [
  { t: 0.0, r: 0.0 },
  { t: 0.0, r: 0.3 },
  { t: 0.01, r: 0.33 },
  { t: 0.3, r: 0.39 },
  { t: 0.7, r: 0.46 },
  { t: 0.97, r: 0.5 },
  { t: 1.0, r: 0.5 },
];

function turn(
  profile: readonly { t: number; r: number }[],
  bottom: number,
  top: number,
  thickness: number,
): THREE.BufferGeometry {
  const height = top - bottom;
  const points: TurnedPoint[] = profile.map((point) => ({
    r: point.r * thickness,
    y: bottom + point.t * height,
  }));
  return lathe(points, radialSegments(thickness / 2), 55);
}

/**
 * Builds one leg as a geometry in the piece's local frame.
 *
 * Returns null for `plinth`, which is not a leg at all — the caller draws a
 * recessed base instead, and getting null back rather than an empty geometry
 * makes that branch impossible to forget.
 */
export function buildLeg(options: LegOptions): THREE.BufferGeometry | null {
  const { at, top, thickness, style, foot = 'none', rake = [0, 0] } = options;
  const bottom = options.bottom ?? 0;
  const footHeight = foot === 'none' ? 0 : foot === 'castor' ? 0.045 : foot === 'disc' ? 0.012 : 0.006;
  const legBottom = bottom + footHeight;

  if (style === 'plinth') return null;

  let geometry: THREE.BufferGeometry;

  switch (style) {
    case 'round-taper':
      geometry = turn(ROUND_PROFILE, legBottom, top, thickness);
      break;

    case 'turned':
      geometry = turn(TURNED_PROFILE, legBottom, top, thickness);
      break;

    case 'tube': {
      // A steel tube is the one leg that genuinely is a prism, so the honesty
      // here is in the section rather than the taper: it is round, and round at
      // 9 mm radius still costs fewer triangles than the box it replaces.
      geometry = taperedProfile(circleSection(thickness / 2), legBottom, top, {
        topScale: 1,
        crease: 60,
      });
      break;
    }

    case 'hairpin': {
      /*
       * A hairpin is a single rod: up the back, round a tight radius at the
       * top, and back down in front, raked out as it descends. Swept in the YZ
       * plane and then rotated into place by the caller's rake.
       *
       * The path is written in the leg's own frame with the apex at the top,
       * because that is where the two ends have to agree — a hairpin whose legs
       * do not land the same distance apart at the floor is immediately wrong.
       */
      const rod = 0.006;
      const spread = thickness * 1.6;
      const height = top - legBottom;
      const path: THREE.Vector3[] = [];
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Two straight runs joined by a half-turn: parameterise by angle so the
        // bend radius is constant rather than a polyline corner.
        const angle = t * Math.PI;
        const z = Math.cos(angle) * spread;
        // Flattened sine: near the ends the rod runs almost straight down.
        const y = legBottom + height * Math.min(1, Math.sin(angle) * 1.35);
        path.push(new THREE.Vector3(0, y, z));
      }
      geometry = sweep(circleSection(rod, 10), path, {
        axis: new THREE.Vector3(1, 0, 0),
        crease: 60,
      });
      break;
    }

    case 'post': {
      /*
       * A straight square post, and the one leg in the catalogue that honestly
       * IS a prism.
       *
       * LACK is a hollow board construction with parallel square legs, and
       * tapering it would be prettier and wrong. What it gets instead of a
       * taper is a proper arris: a 3 mm radius on each corner rather than the
       * 2 mm blanket chamfer, which is what puts a highlight down the length of
       * each edge instead of a hairline.
       */
      geometry = taperedProfile(roundedRectSection(thickness, thickness, 0.003), legBottom, top, {
        topScale: 1,
        crease: 25,
      });
      break;
    }

    case 'splayed':
    case 'square-taper':
    default: {
      /*
       * Sawn from solid, so the section is a rounded rectangle rather than a
       * circle, and the corner radius is a real arris rather than the 2 mm
       * chamfer every box in the app wore.
       */
      const section = roundedRectSection(thickness, thickness, thickness * 0.14);
      geometry = taperedProfile(section, legBottom, top, {
        // Furniture legs taper toward the FLOOR, and this lofts upward, so the
        // scale at the top is the larger of the two.
        topScale: 1 / 0.62,
        steps: 2,
        crease: 25,
      });
      // Written large at the top; bring it back to the thickness asked for.
      geometry.scale(0.62, 1, 0.62);
      break;
    }
  }

  /*
   * The rake.
   *
   * A splayed leg is raked in both axes at once, and doing that as two Euler
   * rotations about X and Z introduces a twist — the leg ends up rotated about
   * its own length, which shows on a square section as a lozenge. Rotating once
   * about the single axis perpendicular to the lean keeps the faces square to
   * the piece.
   */
  const lean = Math.hypot(rake[0], rake[1]);
  if (lean > 1e-4 && (style === 'splayed' || style === 'hairpin' || style === 'tube')) {
    const angle = Math.atan(lean);
    const axis = new THREE.Vector3(rake[1], 0, -rake[0]).normalize();
    const pivot = new THREE.Matrix4()
      .makeTranslation(0, top, 0)
      .multiply(new THREE.Matrix4().makeRotationAxis(axis, angle))
      .multiply(new THREE.Matrix4().makeTranslation(0, -top, 0));
    geometry.applyMatrix4(pivot);
  }

  geometry.translate(at[0], 0, at[1]);
  return geometry;
}

/**
 * The foot under a leg, if it has one.
 *
 * Small, and worth it. A 6 mm plastic glide under a chair leg is the difference
 * between a leg that stands on the floor and one that intersects it, and at the
 * bottom of a baked ambient gradient it is the brightest part of the whole leg.
 */
export function buildFoot(
  at: [number, number],
  style: FootStyle,
  thickness: number,
  bottom = 0,
): THREE.BufferGeometry | null {
  if (style === 'none') return null;

  if (style === 'castor') {
    /*
     * A castor is a wheel in a yoke, and the wheel is the part that reads.
     * Drawn as a torus-ish turned disc lying on its side, with a short stem up
     * into the leg. Eight sides would be visibly faceted at 28 mm, so the
     * radius drives it like everything else.
     */
    const radius = 0.024;
    const wheel = lathe(
      [
        { r: 0, y: -0.008 },
        { r: radius * 0.55, y: -0.009 },
        { r: radius, y: -0.004 },
        { r: radius, y: 0.004 },
        { r: radius * 0.55, y: 0.009 },
        { r: 0, y: 0.008 },
      ],
      radialSegments(radius),
      50,
    );
    // Stand it on edge: a lathe turns about Y, and a wheel rolls about X.
    wheel.rotateZ(Math.PI / 2);
    wheel.translate(at[0], bottom + radius, at[1]);

    const stem = chamferedBox(0.016, 0.02, 0.016);
    stem.translate(at[0], bottom + radius * 2 + 0.01, at[1]);

    return mergeGeometries([wheel, stem]);
  }

  const radius = style === 'disc' ? thickness * 0.62 : thickness * 0.44;
  const height = style === 'disc' ? 0.012 : 0.006;
  const foot = lathe(
    [
      { r: 0, y: bottom },
      { r: radius * 0.9, y: bottom },
      { r: radius, y: bottom + height * 0.35 },
      { r: radius * 0.94, y: bottom + height },
      { r: 0, y: bottom + height },
    ],
    radialSegments(radius),
    50,
  );
  foot.translate(at[0], 0, at[1]);
  return foot;
}

/* ------------------------------- Hardware -------------------------------- */

export type HandleStyle = 'knob' | 'bar' | 'bow' | 'finger' | 'none';

/**
 * A door or drawer pull.
 *
 * `along` is the run the handle spans in the piece's local frame; for a knob
 * only its midpoint is used. Handles face +Z, matching the furniture contract.
 */
export function buildHandle(
  style: HandleStyle,
  centre: [number, number, number],
  length: number,
): THREE.BufferGeometry | null {
  const [cx, cy, cz] = centre;

  if (style === 'none' || style === 'finger') return null;

  if (style === 'knob') {
    /*
     * A turned knob: a base flange, a waisted neck, and a domed head. Twenty-odd
     * triangles more than the cylinder it replaces, and it is the single most
     * looked-at object on a chest of drawers because it is the part a hand goes
     * to.
     */
    const knob = lathe(
      [
        { r: 0, y: 0 },
        { r: 0.014, y: 0 },
        { r: 0.014, y: 0.004 },
        { r: 0.007, y: 0.009 },
        { r: 0.008, y: 0.016 },
        { r: 0.013, y: 0.023 },
        { r: 0.012, y: 0.029 },
        { r: 0, y: 0.032 },
      ],
      radialSegments(0.014),
      55,
    );
    // Turned about Y, fitted about Z: it stands out of the drawer front.
    knob.rotateX(Math.PI / 2);
    knob.translate(cx, cy, cz);
    return knob;
  }

  /*
   * A bar or bow pull: a rod spanning the run on two standoffs.
   *
   * The bow bellies away from the front, which is the only difference between
   * the two and is why they share a path. A straight bar with no standoffs
   * would sit flat against the drawer, and a handle you cannot get a finger
   * behind is a strip of trim.
   */
  const standoff = style === 'bow' ? 0.026 : 0.032;
  const half = Math.max(0.03, length / 2);
  const rod = 0.006;

  const path: THREE.Vector3[] = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = cx - half + t * half * 2;
    // Ends turn back to the front; the middle stands proud.
    const ease = style === 'bow' ? Math.sin(t * Math.PI) : Math.min(1, Math.sin(t * Math.PI) * 6);
    path.push(new THREE.Vector3(x, cy, cz + ease * standoff));
  }

  // The rod runs along X, so the section's reference axis must not be X.
  return sweep(circleSection(rod, 10), path, { axis: new THREE.Vector3(0, 1, 0), crease: 60 });
}

/* -------------------------------- Merging -------------------------------- */

/**
 * Concatenates geometries that share an attribute set.
 *
 * Written here rather than imported from three's `BufferGeometryUtils` because
 * that helper refuses a set whose attributes differ at all, and these are built
 * by several different paths in this file — a lathe carries normals, a
 * `chamferedBox` carries normals and UVs — so it would reject the castor. This
 * keeps only position and normal, which is all the furniture materials read;
 * UVs are generated per piece by the caller from the merged bounds.
 */
export function mergeGeometries(
  parts: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry {
  const usable = parts.filter((part) => part.getAttribute('position')?.count);
  if (usable.length === 0) return new THREE.BufferGeometry();
  if (usable.length === 1) return usable[0]!;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (const part of usable) {
    const geometry = part.index ? part : part.toNonIndexed();
    const position = geometry.getAttribute('position');
    let normal = geometry.getAttribute('normal');
    if (!normal) {
      geometry.computeVertexNormals();
      normal = geometry.getAttribute('normal')!;
    }

    const offset = positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }

    const index = geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(offset + index.getX(i));
    } else {
      for (let i = 0; i < position.count; i++) indices.push(offset + i);
    }
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setIndex(indices);
  return merged;
}
