/**
 * Dormers and skylights: the two ways of getting light through a roof.
 *
 * Both start the same way — find the plane of roof the thing sits on, and work
 * out which way is up the slope — and then diverge completely. A skylight lies
 * IN the plane and is little more than a rectangle and a hole. A dormer stands
 * OUT of it, and its shape is not a free choice: the roof of a dormer runs back
 * up the slope until it dies into the roof it is cut into, and where that
 * happens follows from the front wall's height and the two pitches. So the
 * depth is derived here, not stored. A dormer whose roof stops short of the one
 * it sits in is not a dormer, it is a hole.
 *
 * Everything produced here also produces a HOLE: the outline, in plan, that has
 * to come out of the main roof underneath. The renderer cuts it with a shape
 * and a hole rather than by subtracting solids, which is the same approach the
 * walls use for doors and windows, and for the same reason — it is exact,
 * where a boolean on two nearly-coincident surfaces is a coin toss.
 */

import { planeAt, roofHeightAt, type RoofGeometry, type RoofPlane, type Vec3 } from './roof';
import type { Dormer, Point2, Roof, Skylight } from '@/state/types';

/** A flat panel of something: a wall, a cheek, a pane. */
export interface Panel {
  points: Vec3[];
}

export interface DormerGeometry {
  dormerId: string;
  /** Which roof plane it is cut into. */
  edgeIndex: number;
  /** The outline to remove from that plane, in plan, anticlockwise. */
  hole: Point2[];
  /** How far it reaches back up the slope, in plan. Derived, not chosen. */
  depth: number;
  /** The vertical front, including the gable triangle where there is one. */
  front: Panel;
  /** The two side walls. */
  cheeks: Panel[];
  /** The dormer's own roof surfaces. */
  planes: Panel[];
  /** The window opening in the front, in world space. */
  window: Panel | null;
  ridge: { from: Vec3; to: Vec3 } | null;
  problems: string[];
}

export interface SkylightGeometry {
  skylightId: string;
  edgeIndex: number;
  hole: Point2[];
  /** The glass itself, lying parallel to the roof at the top of the curb. */
  pane: Panel;
  /** The four sides of the upstand it sits on. Empty when deck-mounted. */
  curb: Panel[];
  problems: string[];
}

/* --------------------------- Reading the plane --------------------------- */

interface Slope {
  plane: RoofPlane;
  /** Unit vector, in plan, pointing up the slope. */
  uphill: Point2;
  /** Unit vector, in plan, across the slope. */
  across: Point2;
  /** Rise over run of the plane the thing sits on. */
  pitch: number;
}

/**
 * Which way is up, on the plane under a point.
 *
 * Taken from the plane's own normal rather than from the eave it grew out of,
 * so it stays right for a plane that has been through anything unusual.
 */
function slopeAt(geometry: RoofGeometry, at: Point2): Slope | null {
  const plane = planeAt(geometry, at);
  if (!plane) return null;

  const horizontal = Math.hypot(plane.normal.x, plane.normal.z);
  if (horizontal < 1e-9 || plane.normal.y < 1e-9) {
    // Dead flat: no slope to face down, so no dormer can be oriented.
    return null;
  }

  // The normal leans downhill, so up the slope is the other way.
  const uphill = { x: -plane.normal.x / horizontal, z: -plane.normal.z / horizontal };
  return {
    plane,
    uphill,
    across: { x: uphill.z, z: -uphill.x },
    pitch: horizontal / plane.normal.y,
  };
}

const step = (from: Point2, direction: Point2, distance: number): Point2 => ({
  x: from.x + direction.x * distance,
  z: from.z + direction.z * distance,
});

const raise = (point: Point2, y: number): Vec3 => ({ x: point.x, y, z: point.z });

/* -------------------------------- Dormers -------------------------------- */

/**
 * Works out one dormer.
 *
 * Every failure is reported rather than approximated, because a dormer that is
 * geometrically impossible does not look impossible once it is drawn — it looks
 * like a decision.
 */
export function dormerGeometry(geometry: RoofGeometry, dormer: Dormer): DormerGeometry {
  const problems: string[] = [];
  const blank: DormerGeometry = {
    dormerId: dormer.id,
    edgeIndex: -1,
    hole: [],
    depth: 0,
    front: { points: [] },
    cheeks: [],
    planes: [],
    window: null,
    ridge: null,
    problems,
  };

  const slope = slopeAt(geometry, dormer.at);
  if (!slope) {
    problems.push('This dormer is not on a sloping part of the roof. Move it onto a slope.');
    return blank;
  }

  const base = roofHeightAt(geometry, dormer.at);
  if (base === null) {
    problems.push('This dormer sits outside the roof.');
    return blank;
  }

  const half = dormer.width / 2;
  const { uphill, across, pitch: mainPitch } = slope;
  const dormerPitch = dormer.kind === 'shed' ? Math.min(dormer.pitch, mainPitch * 0.9) : dormer.pitch;

  if (dormer.kind === 'shed' && dormer.pitch >= mainPitch) {
    problems.push(
      'A shed dormer has to be shallower than the roof it sits in, or its roof never meets it. Its pitch has been eased to suit.',
    );
  }

  const eaveTop = base + dormer.faceHeight;
  const left = step(dormer.at, across, -half);
  const right = step(dormer.at, across, half);

  /*
   * Where the dormer dies into the main roof.
   *
   * `sideDepth` is where the dormer's own eaves — level, at the top of the
   * front wall — meet the main roof, which is simply how far up the slope the
   * main roof has climbed by that height. `ridgeDepth` is the same question
   * asked of the ridge, which is higher and so lands further back.
   */
  const sideDepth = dormer.faceHeight / mainPitch;
  const apexHeight = eaveTop + (dormer.kind === 'shed' ? 0 : half * dormerPitch);
  const ridgeDepth =
    dormer.kind === 'shed'
      ? dormer.faceHeight / (mainPitch - dormerPitch)
      : (apexHeight - base) / mainPitch;

  const front: Vec3[] = [
    raise(left, base),
    raise(right, base),
    raise(right, eaveTop),
    ...(dormer.kind === 'gable' ? [raise(dormer.at, apexHeight)] : []),
    raise(left, eaveTop),
  ];

  let hole: Point2[];
  const cheeks: Panel[] = [];
  const planes: Panel[] = [];
  let ridge: { from: Vec3; to: Vec3 } | null = null;

  if (dormer.kind === 'shed') {
    const backLeft = step(left, uphill, ridgeDepth);
    const backRight = step(right, uphill, ridgeDepth);
    const backHeight = base + ridgeDepth * mainPitch;

    hole = [left, right, backRight, backLeft];
    // Each cheek is a triangle: the main roof climbing underneath it, the
    // dormer's own roof climbing more slowly above it, and the front between.
    cheeks.push({ points: [raise(left, base), raise(left, eaveTop), raise(backLeft, backHeight)] });
    cheeks.push({
      points: [raise(right, base), raise(backRight, backHeight), raise(right, eaveTop)],
    });
    planes.push({
      points: [
        raise(left, eaveTop),
        raise(right, eaveTop),
        raise(backRight, backHeight),
        raise(backLeft, backHeight),
      ],
    });
  } else {
    const sideLeft = step(left, uphill, sideDepth);
    const sideRight = step(right, uphill, sideDepth);
    const ridgeBack = step(dormer.at, uphill, ridgeDepth);
    // A hipped dormer's front slopes too, so its ridge starts half a width in
    // rather than at the face.
    const ridgeFront = dormer.kind === 'hipped' ? step(dormer.at, uphill, half) : dormer.at;

    hole = [left, right, sideRight, ridgeBack, sideLeft];

    cheeks.push({ points: [raise(left, base), raise(left, eaveTop), raise(sideLeft, eaveTop)] });
    cheeks.push({ points: [raise(right, base), raise(sideRight, eaveTop), raise(right, eaveTop)] });

    if (dormer.kind === 'hipped') {
      planes.push({
        points: [raise(left, eaveTop), raise(right, eaveTop), raise(ridgeFront, apexHeight)],
      });
    }

    planes.push({
      points: [
        raise(left, eaveTop),
        raise(ridgeFront, apexHeight),
        raise(ridgeBack, apexHeight),
        raise(sideLeft, eaveTop),
      ],
    });
    planes.push({
      points: [
        raise(right, eaveTop),
        raise(sideRight, eaveTop),
        raise(ridgeBack, apexHeight),
        raise(ridgeFront, apexHeight),
      ],
    });

    if (ridgeDepth > (dormer.kind === 'hipped' ? half : 0) + 1e-6) {
      ridge = { from: raise(ridgeFront, apexHeight), to: raise(ridgeBack, apexHeight) };
    }
  }

  // Wound to match the roof plane it is cut from, so the renderer can treat it
  // as a hole without having to guess which way round it goes.
  if (signedArea(hole) < 0) hole = [...hole].reverse();

  const escaped = hole.filter((point) => planeAt(geometry, point)?.edgeIndex !== slope.plane.edgeIndex);
  if (escaped.length > 0) {
    problems.push(
      'This dormer runs off the edge of the roof plane it sits in. Move it, or make it smaller or shorter.',
    );
  }

  return {
    dormerId: dormer.id,
    edgeIndex: slope.plane.edgeIndex,
    hole,
    depth: ridgeDepth,
    front: { points: front },
    cheeks,
    planes,
    window: windowPanel(dormer, left, right, across, base),
    ridge,
    problems,
  };
}

/** The window in a dormer's face, as a panel standing in the front wall. */
function windowPanel(
  dormer: Dormer,
  left: Point2,
  right: Point2,
  across: Point2,
  base: number,
): Panel | null {
  const pane = dormer.window;
  if (!pane) return null;

  const centre = { x: (left.x + right.x) / 2, z: (left.z + right.z) / 2 };
  const a = step(centre, across, -pane.width / 2);
  const b = step(centre, across, pane.width / 2);
  const sill = base + pane.sillHeight;
  const head = sill + pane.height;

  return { points: [raise(a, sill), raise(b, sill), raise(b, head), raise(a, head)] };
}

/* ------------------------------- Skylights ------------------------------- */

/**
 * Works out one skylight.
 *
 * `length` is a PLAN dimension, so the pane comes out longer than it by the
 * slope factor — which is the right way round: a skylight keeps the hole it
 * makes in the ceiling when the pitch changes, and the glass is cut to suit.
 */
export function skylightGeometry(
  geometry: RoofGeometry,
  skylight: Skylight,
): SkylightGeometry {
  const problems: string[] = [];
  const blank: SkylightGeometry = {
    skylightId: skylight.id,
    edgeIndex: -1,
    hole: [],
    pane: { points: [] },
    curb: [],
    problems,
  };

  const slope = slopeAt(geometry, skylight.at);
  if (!slope) {
    problems.push('This skylight is not on a sloping part of the roof.');
    return blank;
  }

  const { uphill, across, pitch } = slope;
  const halfWidth = skylight.width / 2;
  const halfLength = skylight.length / 2;

  const corners: Point2[] = [
    step(step(skylight.at, across, -halfWidth), uphill, -halfLength),
    step(step(skylight.at, across, halfWidth), uphill, -halfLength),
    step(step(skylight.at, across, halfWidth), uphill, halfLength),
    step(step(skylight.at, across, -halfWidth), uphill, halfLength),
  ];

  const heights = corners.map((corner) => roofHeightAt(geometry, corner));
  if (heights.some((height) => height === null)) {
    problems.push('This skylight hangs over the edge of the roof. Move it in from the eave.');
    return blank;
  }

  const escaped = corners.some(
    (corner) => planeAt(geometry, corner)?.edgeIndex !== slope.plane.edgeIndex,
  );
  if (escaped) {
    problems.push(
      'This skylight crosses a ridge or a valley. A skylight has to sit within one plane of roof.',
    );
  }

  // The curb lifts the glass along the roof's own normal, so it stays parallel
  // to the roof rather than being pushed vertically out of plane.
  const lift = skylight.curb * Math.hypot(1, pitch);
  const deck = corners.map((corner, index) => raise(corner, heights[index]!));
  const glass = deck.map((point) => ({ ...point, y: point.y + lift }));

  const curb: Panel[] = [];
  if (skylight.curb > 1e-6) {
    for (let i = 0; i < deck.length; i++) {
      const j = (i + 1) % deck.length;
      curb.push({ points: [deck[i]!, deck[j]!, glass[j]!, glass[i]!] });
    }
  }

  let hole = corners;
  if (signedArea(hole) < 0) hole = [...hole].reverse();

  return {
    skylightId: skylight.id,
    edgeIndex: slope.plane.edgeIndex,
    hole,
    pane: { points: glass },
    curb,
    problems,
  };
}

function signedArea(polygon: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const here = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    sum += here.x * next.z - next.x * here.z;
  }
  return sum / 2;
}


/* -------------------------------- Together ------------------------------- */

/**
 * Everything cut into or standing out of one roof.
 *
 * Kept here rather than folded into `roofGeometry` so that the roof does not
 * have to know about the things that sit on it — which also keeps the two
 * modules from importing each other in a circle.
 */
export function roofOpenings(
  geometry: RoofGeometry,
  roof: Roof,
): { dormers: DormerGeometry[]; skylights: SkylightGeometry[]; problems: string[] } {
  const dormers = roof.dormers.map((dormer) => dormerGeometry(geometry, dormer));
  const skylights = roof.skylights.map((skylight) => skylightGeometry(geometry, skylight));

  return {
    dormers,
    skylights,
    problems: [...dormers, ...skylights].flatMap((entry) => entry.problems),
  };
}

/** The outlines to cut out of one plane of roof, in plan. */
export function holesInPlane(
  plane: RoofPlane,
  openings: { dormers: DormerGeometry[]; skylights: SkylightGeometry[] },
): Point2[][] {
  return [...openings.dormers, ...openings.skylights]
    .filter((entry) => entry.edgeIndex === plane.edgeIndex && entry.hole.length >= 3)
    .map((entry) => entry.hole);
}
