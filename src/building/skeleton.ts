/**
 * The straight skeleton — how a roof knows where its ridges and valleys go.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS COMPUTES, AND WHY A ROOF NEEDS IT.
 *
 * Imagine every eave of a house creeping inwards at the same speed, all at once,
 * like a puddle drying from its edges. The wall of advancing edges is the
 * "wavefront"; the paths its corners trace out are the straight skeleton. Those
 * paths are exactly the ridges, hips and valleys of a hip roof, and the time at
 * which the wavefront reaches a point is exactly that point's horizontal
 * distance from the nearest eave — so its HEIGHT is that distance times the
 * pitch. One algorithm gives you the whole roof.
 *
 * That is why the roof follows the footprint properly rather than sitting over a
 * bounding box. An L-shaped house has an inside corner, and the wavefront moving
 * out of that corner is what puts a valley there — the gutter between two roof
 * planes that real L-shaped houses have and box-shaped models do not.
 *
 * Four kinds of thing happen as the wavefront moves. The first two are in every
 * textbook; the other two are what a real plan does and a textbook does not:
 *
 *   EDGE EVENT — an edge shrinks to nothing and its two neighbours meet. This is
 *   the end of a hip: two roof planes running into each other at a point.
 *
 *   SPLIT EVENT — a reflex corner (the inside corner of an L) runs into an edge
 *   on the far side and cuts the wavefront in two. This is what makes a valley,
 *   and it is the part that a naive implementation gets wrong.
 *
 *   PINCH — two corners run into each other with no edge between them for a
 *   split to aim at, which is what a cross-shaped plan does when it closes up
 *   across the middle. Where several corners arrive at once — a cross whose
 *   arms are the same width brings four — they are settled together by angle,
 *   because taking them in pairs gets some of the ridges right and leaves the
 *   rest in a state nothing can resolve.
 *
 *   COLLAPSE — a loop flattens onto its own ridge line instead of closing down
 *   to a pair of corners. A T-shaped house ends this way, with both valleys and
 *   both ridges arriving at one point.
 *
 * -----------------------------------------------------------------------------
 * ON ROBUSTNESS, HONESTLY.
 *
 * A fully general straight skeleton is research-grade code, and the hard part is
 * never the common case — it is simultaneous events, vertices that meet exactly,
 * and near-parallel edges, where floating point decides the topology. All four
 * event kinds above are handled with explicit tolerances, and the result is
 * checked against rectangles, L, T, U, plus, cross, zigzag and stepped plans,
 * symmetrical and deliberately not, plus non-convex spikes and irregular
 * polygons. The tests assert the properties rather than the pictures: one face
 * per eave, faces that tile the footprint exactly, and every point's height
 * equal to its distance from its own eave.
 *
 * Where it cannot make progress it BAILS OUT rather than emitting nonsense: the
 * caller gets whatever faces were resolved plus a flag saying the solve was
 * incomplete, and the roof falls back to a simpler form. A roof with a missing
 * hip is a bug you can see and report. A roof built from garbage geometry is a
 * crash, or worse, a plausible-looking lie.
 * -----------------------------------------------------------------------------
 */

import type { Point2 } from '@/state/types';

/* --------------------------------- Vectors -------------------------------- */

const EPS = 1e-9;
/** Two events closer than this in time are treated as simultaneous. */
const TIME_EPS = 1e-7;

function sub(a: Point2, b: Point2): Point2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

function add(a: Point2, b: Point2): Point2 {
  return { x: a.x + b.x, z: a.z + b.z };
}

function scale(v: Point2, k: number): Point2 {
  return { x: v.x * k, z: v.z * k };
}

function dot(a: Point2, b: Point2): number {
  return a.x * b.x + a.z * b.z;
}

function cross(a: Point2, b: Point2): number {
  return a.x * b.z - a.z * b.x;
}

function length(v: Point2): number {
  return Math.hypot(v.x, v.z);
}

function normalize(v: Point2): Point2 {
  const len = length(v);
  return len < EPS ? { x: 0, z: 0 } : { x: v.x / len, z: v.z / len };
}

/** Signed area. Positive means anticlockwise in the x/z plane. */
export function signedArea(polygon: readonly Point2[]): number {
  let total = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    total += polygon[j]!.x * polygon[i]!.z - polygon[i]!.x * polygon[j]!.z;
  }
  return total / 2;
}

/**
 * Cleans a polygon up before the solve.
 *
 * Duplicate and collinear points both break the wavefront: a zero-length edge
 * has no direction, and a straight-through vertex has no bisector — its two
 * edges are parallel, the 2x2 solve for its velocity is singular, and the whole
 * skeleton comes apart at that one corner. Removing them costs nothing and is
 * the difference between working on real plans and working on tidy test data.
 */
export function prepare(polygon: readonly Point2[], tolerance = 1e-6): Point2[] {
  const points: Point2[] = [];

  for (const point of polygon) {
    const last = points[points.length - 1];
    if (last && length(sub(point, last)) < tolerance) continue;
    points.push({ x: point.x, z: point.z });
  }
  while (points.length > 1 && length(sub(points[0]!, points[points.length - 1]!)) < tolerance) {
    points.pop();
  }
  if (points.length < 3) return [];

  // Drop vertices that lie on the straight line between their neighbours.
  const kept: Point2[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length]!;
    const here = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const a = normalize(sub(here, prev));
    const b = normalize(sub(next, here));
    if (Math.abs(cross(a, b)) < tolerance && dot(a, b) > 0) continue;
    kept.push(here);
  }
  if (kept.length < 3) return [];

  // Everything downstream assumes anticlockwise, so that the left normal of
  // each edge points into the polygon.
  return signedArea(kept) < 0 ? kept.reverse() : kept;
}

/* ------------------------------- The wavefront ---------------------------- */

interface Node {
  id: number;
  /** Position at `time`. */
  point: Point2;
  time: number;
  /** Constant velocity; position at u is point + (u - time) * velocity. */
  velocity: Point2;
  prev: number;
  next: number;
  /** Index of the original edge arriving at this node. */
  leftEdge: number;
  /** Index of the original edge leaving it. */
  rightEdge: number;
  dead: boolean;
  /** True where the interior angle exceeds 180 degrees — an inside corner. */
  reflex: boolean;
}

type SkeletonEvent =
  | { kind: 'edge'; time: number; at: Point2; a: number; b: number }
  /**
   * `opposite` is the NODE at the start of the wavefront edge that was hit, not
   * merely the index of the original edge it descends from.
   *
   * Once one split has happened, a single eave can be carried by two or three
   * separate wavefront edges at the same time. Naming only the original index
   * leaves the stitching to guess which of them was hit, and it guesses wrong
   * the moment a footprint has more than one inside corner — which is every T,
   * U and cross-shaped house there is.
   */
  | { kind: 'split'; time: number; at: Point2; node: number; opposite: number }
  /**
   * Two corners arriving at the same point without being neighbours.
   *
   * A split is a corner running into an EDGE. This is a corner running into
   * another CORNER, which a split will never see coming because there is no
   * edge between them to aim at. It is what a plan does when it pinches shut
   * across the middle: a cross-shaped house whose cross-bar closes at the same
   * instant on both sides of the spine, and the two halves of the wavefront
   * touch at a single point rather than along an edge.
   *
   * The repair is the same either way — unpick the two corners and re-join them
   * crosswise — which either divides one loop in two or joins two into one,
   * depending on whether they were part of the same loop to begin with. That
   * distinction needs no special case: the relinking is identical.
   */
  | { kind: 'pinch'; time: number; at: Point2; node: number; partner: number };

/** One planar roof surface, rising from a single eave. */
export interface SkeletonFace {
  /** Which edge of the input polygon this face rises from. */
  edgeIndex: number;
  /**
   * Outline, anticlockwise, with the eave first.
   *
   * `time` is the horizontal distance inwards from the eave, which the caller
   * turns into a height by multiplying by the pitch.
   */
  points: Array<{ at: Point2; time: number }>;
}

export interface SkeletonResult {
  faces: SkeletonFace[];
  /**
   * Ridge, hip and valley segments, for drawing and for gable ends.
   *
   * `left` and `right` are the two eaves whose roof planes the segment divides.
   * That is what tells a ridge from a valley without measuring anything: two
   * planes facing each other meet at a ridge, two facing away meet at a valley,
   * and the pair is also what a gable needs in order to know which plane to
   * remove and which wall to carry up in its place.
   */
  arcs: Array<{
    from: Point2;
    to: Point2;
    fromTime: number;
    toTime: number;
    left: number;
    right: number;
  }>;
  /**
   * False when the solve ran out of progress and stopped early.
   *
   * The faces returned are still the ones it resolved; the caller decides
   * whether a partial roof is usable or whether to fall back.
   */
  complete: boolean;
}

/**
 * Solves the straight skeleton of a simple polygon.
 *
 * The polygon must be simple (no self-intersections) and is cleaned and
 * reoriented by `prepare` first. Holes are not supported: a roof over a
 * courtyard is a different problem and the app has no way to draw one yet.
 */
export function straightSkeleton(
  input: readonly Point2[],
  weights?: readonly number[],
): SkeletonResult {
  const polygon = prepare(input);
  if (polygon.length < 3) return { faces: [], arcs: [], complete: false };

  const edgeCount = polygon.length;

  /*
   * How fast each eave travels. One, unless the caller says otherwise.
   *
   * A weight of zero is a GABLE: that eave does not move, so no roof plane
   * grows from it and the planes either side run out over it and meet in a
   * ridge above it. The wall below is then carried up into the triangle
   * everyone recognises as a gable end. This is the whole reason weights exist,
   * and it is why a gable is not a special case bolted on afterwards — it is
   * the same solve with one number changed.
   *
   * Weights line up with the PREPARED polygon, so a caller that needs to name
   * particular eaves should call `prepare` itself first; passing the wrong
   * number of them means they are ignored rather than silently misapplied.
   */
  const speeds =
    weights && weights.length === edgeCount
      ? weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0))
      : new Array<number>(edgeCount).fill(1);

  /** Inward unit normal of each original edge. */
  const normals: Point2[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const direction = normalize(sub(polygon[(i + 1) % edgeCount]!, polygon[i]!));
    // Anticlockwise polygon: the left normal points inwards.
    normals.push({ x: -direction.z, z: direction.x });
  }

  const nodes: Node[] = [];
  for (let i = 0; i < edgeCount; i++) {
    // Vertex i sits between edge i-1 (arriving) and edge i (leaving).
    const leftEdge = (i - 1 + edgeCount) % edgeCount;
    const rightEdge = i;
    nodes.push({
      id: i,
      point: polygon[i]!,
      time: 0,
      velocity: bisectorVelocity(
        normals[leftEdge]!,
        normals[rightEdge]!,
        speeds[leftEdge]!,
        speeds[rightEdge]!,
      ),
      prev: (i - 1 + edgeCount) % edgeCount,
      next: (i + 1) % edgeCount,
      leftEdge,
      rightEdge,
      dead: false,
      reflex: isReflex(polygon, i),
    });
  }

  /*
   * Faces are reconstructed from the ARCS, not from per-edge traces.
   *
   * The obvious approach — record, for each eave, the path its left end and its
   * right end trace, then join them — works beautifully until a split happens.
   * After one, a single eave is carried by two separate wavefront edges moving
   * into different parts of the house, and its roof plane is one non-convex
   * region whose boundary crosses back on itself. Two monotone traces cannot
   * describe that, and stitching them anyway produces a face with the right
   * corners in the wrong order: it renders, it has area, and it is nonsense.
   *
   * So instead every skeleton arc records the two roof planes it separates.
   * A face is then all the arcs that name it, chained end to end from one end of
   * its eave back to the other — which is just walking the boundary of a
   * polygon, and is correct however convoluted that boundary gets.
   */
  const arcRecords: Array<{
    from: Point2;
    to: Point2;
    fromTime: number;
    toTime: number;
    left: number;
    right: number;
  }> = [];

  const positionAt = (node: Node, time: number): Point2 =>
    add(node.point, scale(node.velocity, time - node.time));

  const retire = (node: Node, at: Point2, time: number) => {
    node.dead = true;
    arcRecords.push({
      from: node.point,
      to: at,
      fromTime: node.time,
      toTime: time,
      left: node.leftEdge,
      right: node.rightEdge,
    });
  };

  /**
   * Every live corner sitting on a given point at a given moment.
   *
   * Coincidences come in threes and fours on any symmetrical plan, and they
   * have to be settled all together rather than a pair at a time, so the first
   * thing an event of that kind does is find out how many corners it is really
   * dealing with.
   */
  const clusterAt = (at: Point2, time: number): Node[] =>
    nodes.filter((node) => !node.dead && length(sub(positionAt(node, time), at)) < 1e-4);

  const settle = (node: Node, partner: Node, at: Point2, time: number) => {
    const cluster = clusterAt(at, time);
    if (cluster.length > 2 && resolveCluster(nodes, normals, speeds, cluster, at, time, retire)) {
      return;
    }
    crossJoin(nodes, normals, speeds, node, partner, at, time, retire);
  };

  let complete = true;
  // Each event removes at least one node, so the loop is bounded. The generous
  // headroom is for split events, which add nodes before removing them.
  const maxIterations = edgeCount * 8 + 64;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    closeFinishedLoops(nodes, arcRecords, positionAt);

    const alive = nodes.filter((node) => !node.dead);
    if (alive.length === 0) break;

    const event = nextEvent(nodes, polygon, normals, speeds, positionAt);
    if (!event) {
      /*
       * No event left, but corners still alive. Before calling that a failure,
       * check for the one shape that legitimately produces it: a loop that has
       * flattened onto its own ridge line rather than closing down to a pair.
       * A T-shaped house does this — the bar's ridge and the stem's ridge and
       * both valleys all arrive at one point, and what remains is three corners
       * strung out along a single line with nothing left to move them.
       */
      if (closeCollapsedLoops(nodes, arcRecords, positionAt)) continue;

      // Otherwise the wavefront has genuinely reached a state this solver
      // cannot advance.
      complete = alive.length <= 2;
      break;
    }

    if (event.kind === 'edge') {
      const a = nodes[event.a]!;
      const b = nodes[event.b]!;
      if (a.dead || b.dead) continue;

      retire(a, event.at, event.time);
      retire(b, event.at, event.time);

      const prev = nodes[a.prev]!;
      const next = nodes[b.next]!;

      if (prev.dead || next.dead) continue;

      /*
       * When the two survivors are the same node, this loop has come down to a
       * ridge: one node at each end of it, and the segment between them is the
       * last thing the wavefront ever was. It generates no further event —
       * both ends have stopped moving — so it has to be recorded here or every
       * roof comes out with a gap along its spine. That is not a subtle bug,
       * but it is a silent one: the faces either side are still produced, they
       * just fail to close.
       */
      if (prev.id === next.id) {
        // The survivor has been travelling since it was born, and that journey
        // is a skeleton arc in its own right. Marking it dead without recording
        // it loses a whole ridge segment — and the two faces either side of
        // that segment can then never be closed, so they vanish from the roof.
        retire(prev, positionAt(prev, event.time), event.time);
        arcRecords.push({
          from: event.at,
          to: positionAt(prev, event.time),
          fromTime: event.time,
          toTime: event.time,
          left: a.leftEdge,
          right: b.rightEdge,
        });
        continue;
      }

      const merged: Node = {
        id: nodes.length,
        point: event.at,
        time: event.time,
        velocity: bisectorVelocity(
          normals[a.leftEdge]!,
          normals[b.rightEdge]!,
          speeds[a.leftEdge]!,
          speeds[b.rightEdge]!,
        ),
        prev: prev.id,
        next: next.id,
        leftEdge: a.leftEdge,
        rightEdge: b.rightEdge,
        dead: false,
        reflex: false,
      };
      nodes.push(merged);
      prev.next = merged.id;
      next.prev = merged.id;
    } else if (event.kind === 'pinch') {
      const node = nodes[event.node]!;
      const partner = nodes[event.partner]!;
      if (node.dead || partner.dead) continue;
      settle(node, partner, event.at, event.time);
    } else {
      const node = nodes[event.node]!;
      if (node.dead) continue;

      /*
       * A split: the reflex corner reaches the far edge and the wavefront
       * becomes two independent loops. The corner is replaced by two nodes at
       * the same point, one joining each loop — which is precisely the valley
       * you see where two roof slopes meet over an inside corner.
       */
      const x = nodes[event.opposite]!;
      const y = nodes[x.next]!;
      if (x.dead || y.dead || x.id === node.id || y.id === node.id) continue;

      /*
       * A VERTEX EVENT: the corner does not land in the middle of the opposite
       * edge, it lands exactly on one of that edge's ends.
       *
       * This is not an exotic case. It is what a symmetrical T- or cross-shaped
       * house does: the two valleys thrown by the two inside corners, and the
       * ridge of the bar, all arrive at the same point at the same instant.
       * Treating it as an ordinary split cuts an edge that has no length left,
       * which leaves slivers of face overlapping each other — a roof whose
       * planes sum to more area than the house has floor.
       *
       * Handled instead as a merge of the two coincident corners, which splits
       * the loop the same way but leaves nothing degenerate behind.
       */
      const atX = positionAt(x, event.time);
      const atY = positionAt(y, event.time);
      const coincident =
        length(sub(event.at, atY)) < 1e-6 ? y : length(sub(event.at, atX)) < 1e-6 ? x : null;

      if (coincident) {
        settle(node, coincident, event.at, event.time);
        continue;
      }

      const opposite = x.rightEdge;
      retire(node, event.at, event.time);

      const prev = nodes[node.prev]!;
      const next = nodes[node.next]!;

      const first: Node = {
        id: nodes.length,
        point: event.at,
        time: event.time,
        velocity: bisectorVelocity(
          normals[node.leftEdge]!,
          normals[opposite]!,
          speeds[node.leftEdge]!,
          speeds[opposite]!,
        ),
        prev: prev.id,
        next: y.id,
        leftEdge: node.leftEdge,
        rightEdge: opposite,
        dead: false,
        reflex: false,
      };
      nodes.push(first);

      const second: Node = {
        id: nodes.length,
        point: event.at,
        time: event.time,
        velocity: bisectorVelocity(
          normals[opposite]!,
          normals[node.rightEdge]!,
          speeds[opposite]!,
          speeds[node.rightEdge]!,
        ),
        prev: x.id,
        next: next.id,
        leftEdge: opposite,
        rightEdge: node.rightEdge,
        dead: false,
        reflex: false,
      };
      nodes.push(second);

      prev.next = first.id;
      y.prev = first.id;
      x.next = second.id;
      next.prev = second.id;
    }
  }

  closeFinishedLoops(nodes, arcRecords, positionAt);

  /* ------------------------------ Assembly ------------------------------ */

  snapCoincident(arcRecords);

  const faces: SkeletonFace[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const face = chainFace(i, polygon, arcRecords);
    if (face) faces.push(face);
  }

  /*
   * A gabled eave does not move, so it grows no roof plane and owes no face:
   * what it produces is a wall, which the roof builder reads off the arcs. Only
   * the eaves that travel are counted here.
   */
  const expected = speeds.filter((speed) => speed > 0).length;
  const resolved = new Set(faces.map((face) => face.edgeIndex));
  const missing = speeds.some((speed, index) => speed > 0 && !resolved.has(index));

  return {
    faces,
    arcs: arcRecords.map((arc) => ({
      from: arc.from,
      to: arc.to,
      fromTime: arc.fromTime,
      toTime: arc.toTime,
      left: arc.left,
      right: arc.right,
    })),
    complete: complete && !missing && faces.length >= expected,
  };
}


/**
 * Pulls skeleton points that are all but identical onto a single position.
 *
 * Three or four arcs are supposed to meet exactly at a skeleton node, and on an
 * irregular footprint they arrive within a hundredth of a millimetre of each
 * other instead — each computed by a different chain of divisions. That is
 * accurate enough for anything except walking the boundary of a face, which
 * needs endpoints to match EXACTLY or the walk stops dead and the face is lost.
 *
 * A tenth of a millimetre is far below anything that can matter in a building
 * and comfortably above the noise.
 */
function snapCoincident(
  arcs: Array<{ from: Point2; to: Point2; fromTime: number; toTime: number }>,
  tolerance = 1e-4,
): void {
  const anchors: Point2[] = [];

  const anchorFor = (point: Point2): Point2 => {
    for (const anchor of anchors) {
      if (length(sub(anchor, point)) < tolerance) return anchor;
    }
    anchors.push(point);
    return point;
  };

  for (const arc of arcs) {
    arc.from = anchorFor(arc.from);
    arc.to = anchorFor(arc.to);
  }
}

/**
 * Walks the boundary of one roof plane.
 *
 * Starts at the far end of the eave and follows whichever unused arc begins
 * where the last one ended, until it arrives back at the near end. Every arc
 * that names this face is part of its boundary exactly once, so the walk either
 * closes — giving the polygon, however non-convex — or runs out, which means
 * the solve left this face unbounded and it is dropped rather than guessed at.
 */
function chainFace(
  edgeIndex: number,
  polygon: readonly Point2[],
  arcs: ReadonlyArray<{
    from: Point2;
    to: Point2;
    fromTime: number;
    toTime: number;
    left: number;
    right: number;
  }>,
  tolerance = 1e-4,
): SkeletonFace | null {
  const count = polygon.length;
  const eaveStart = polygon[edgeIndex]!;
  const eaveEnd = polygon[(edgeIndex + 1) % count]!;

  const mine = arcs.filter(
    (arc) =>
      (arc.left === edgeIndex || arc.right === edgeIndex) &&
      length(sub(arc.from, arc.to)) > tolerance,
  );

  const used = new Array(mine.length).fill(false);
  const points: Array<{ at: Point2; time: number }> = [
    { at: eaveStart, time: 0 },
    { at: eaveEnd, time: 0 },
  ];

  let current = eaveEnd;
  let currentTime = 0;

  for (let guard = 0; guard <= mine.length; guard += 1) {
    if (guard > 0 && length(sub(current, eaveStart)) < tolerance) break;

    let stepped = false;
    for (let i = 0; i < mine.length; i += 1) {
      if (used[i]) continue;
      const arc = mine[i]!;

      if (length(sub(arc.from, current)) < tolerance) {
        used[i] = true;
        current = arc.to;
        currentTime = arc.toTime;
        stepped = true;
      } else if (length(sub(arc.to, current)) < tolerance) {
        used[i] = true;
        current = arc.from;
        currentTime = arc.fromTime;
        stepped = true;
      }
      if (!stepped) continue;

      if (length(sub(current, eaveStart)) > tolerance) {
        points.push({ at: current, time: currentTime });
      }
      break;
    }

    if (!stepped) return null;
  }

  // A closed walk that never reached the start is an unbounded face.
  if (length(sub(current, eaveStart)) > tolerance) return null;
  return points.length >= 3 ? { edgeIndex, points } : null;
}

/* -------------------------------- Internals ------------------------------- */

/**
 * How fast a wavefront corner travels, and in what direction.
 *
 * The corner must stay exactly `t` from both of its edges at time `t`, which is
 * two linear equations in two unknowns. A sharp corner solves to a fast
 * velocity — the point of a wedge races inwards far quicker than the edges
 * beside it, which is why a hip roof's ridge starts well in from the corner.
 *
 * The 2x2 goes singular when the two edges are parallel, and the two ways that
 * can happen want opposite answers:
 *
 *  - Facing OPPOSITE ways — the two long sides of a corridor closing on each
 *    other — is a corner that never resolves. It has arrived at the ridge and
 *    stops there; zero velocity gives that, and gives it without the NaN a
 *    division by nothing would send downstream into every face on the roof.
 *
 *  - Facing the SAME way is a straight-through vertex. `prepare` strips those
 *    from the footprint, but the solver makes new ones: when a plan pinches
 *    shut across the middle, the two halves of what were separate eaves on one
 *    line — the two ends of a cross's cross-bar, say — end up either side of a
 *    single wavefront corner. It is a corner in name only; the wavefront there
 *    is straight, so it simply travels with the line at unit speed. Leaving it
 *    parked instead pins the point where one roof plane hands over to the next,
 *    and both planes are then left with a boundary that will not close.
 */
function bisectorVelocity(
  leftNormal: Point2,
  rightNormal: Point2,
  leftSpeed = 1,
  rightSpeed = 1,
): Point2 {
  const determinant = leftNormal.x * rightNormal.z - leftNormal.z * rightNormal.x;
  if (Math.abs(determinant) < 1e-9) {
    if (dot(leftNormal, rightNormal) <= 0) return { x: 0, z: 0 };
    // Same-facing pair: travel with the line. Their speeds agree in every case
    // this can arise from, and averaging is the harmless answer if they do not.
    return scale(leftNormal, (leftSpeed + rightSpeed) / 2);
  }
  // Solve dot(v, leftNormal) = leftSpeed and dot(v, rightNormal) = rightSpeed:
  // the corner stays on both moving lines at once.
  return {
    x: (leftSpeed * rightNormal.z - rightSpeed * leftNormal.z) / determinant,
    z: (rightSpeed * leftNormal.x - leftSpeed * rightNormal.x) / determinant,
  };
}

/** True where the interior angle at vertex i exceeds 180 degrees. */
function isReflex(polygon: readonly Point2[], index: number): boolean {
  const count = polygon.length;
  const prev = polygon[(index - 1 + count) % count]!;
  const here = polygon[index]!;
  const next = polygon[(index + 1) % count]!;
  // Anticlockwise polygon: a negative turn is an inside corner.
  return cross(sub(here, prev), sub(next, here)) < -EPS;
}

/** The soonest event among all live nodes, or null when none remains. */
function nextEvent(
  nodes: Node[],
  polygon: readonly Point2[],
  normals: readonly Point2[],
  speeds: readonly number[],
  positionAt: (node: Node, time: number) => Point2,
): SkeletonEvent | null {
  let best: SkeletonEvent | null = null;

  /*
   * Ties are broken in favour of EDGE events, and that is not arbitrary.
   *
   * On a symmetrical footprint — a cross-shaped house, an arm the same width as
   * the one it meets — several events land at exactly the same instant, and the
   * order they are taken in decides whether the result is right. Collapsing an
   * edge is always safe: it removes two corners and joins their neighbours,
   * whatever else is going on. A split rewires the loop around an edge, and it
   * needs that edge's own corners to have settled first — take the split first
   * and it stitches itself to a corner that is about to disappear, which loses
   * the ridge of a whole wing.
   */
  const rank = (event: SkeletonEvent) => (event.kind === 'edge' ? 0 : 1);

  const consider = (event: SkeletonEvent | null) => {
    if (!event) return;
    if (!Number.isFinite(event.time) || !Number.isFinite(event.at.x)) return;
    if (!best) {
      best = event;
      return;
    }
    if (event.time < best.time - TIME_EPS) {
      best = event;
      return;
    }
    if (Math.abs(event.time - best.time) <= TIME_EPS && rank(event) < rank(best)) {
      best = event;
    }
  };

  for (const node of nodes) {
    if (node.dead) continue;
    const next = nodes[node.next]!;
    if (next.dead) continue;

    consider(edgeEvent(node, next, positionAt));

    if (node.reflex) {
      consider(splitEvent(node, nodes, polygon, normals, speeds, positionAt));
    }

    // Corner-into-corner. Only pairs where this node has the lower id, so each
    // pair is examined once rather than twice with the roles reversed.
    for (const other of nodes) {
      if (other.dead || other.id <= node.id) continue;
      if (other.id === node.next || node.id === other.next) continue;
      consider(pinchEvent(node, other, positionAt));
    }
  }

  return best;
}

/**
 * When two corners that are not neighbours arrive at the same place.
 *
 * Both are travelling in straight lines, so this asks whether two rays cross —
 * and in the plane two rays generally do not, which is why the time is found by
 * least squares and then CHECKED. The pair only counts as an event if, at the
 * best moment, they are genuinely on top of each other rather than merely near.
 *
 * The tolerance is a tenth of a millimetre: far below anything that can matter
 * in a building, and comfortably above the arithmetic noise of a corner whose
 * position has come through half a dozen divisions.
 */
function pinchEvent(
  a: Node,
  b: Node,
  positionAt: (node: Node, time: number) => Point2,
): SkeletonEvent | null {
  const relativeVelocity = sub(a.velocity, b.velocity);
  const speed = dot(relativeVelocity, relativeVelocity);
  if (speed < 1e-12) return null;

  // Positions extrapolated back to t = 0, so the two motions share a clock.
  const originA = sub(a.point, scale(a.velocity, a.time));
  const originB = sub(b.point, scale(b.velocity, b.time));
  const gap = sub(originA, originB);

  const time = -dot(gap, relativeVelocity) / speed;
  const earliest = Math.max(a.time, b.time);
  if (!(time > earliest + TIME_EPS)) return null;

  const at = positionAt(a, time);
  if (length(sub(at, positionAt(b, time))) > 1e-4) return null;

  return { kind: 'pinch', time, at, node: a.id, partner: b.id };
}

/** When the wavefront edge between two nodes shrinks to nothing. */
function edgeEvent(
  a: Node,
  b: Node,
  positionAt: (node: Node, time: number) => Point2,
): SkeletonEvent | null {
  const reference = Math.max(a.time, b.time);
  const pa = positionAt(a, reference);
  const pb = positionAt(b, reference);

  const separation = sub(pb, pa);
  const direction = normalize(separation);
  if (direction.x === 0 && direction.z === 0) return null;

  const closingSpeed = dot(sub(a.velocity, b.velocity), direction);
  if (closingSpeed <= EPS) return null;

  const time = reference + length(separation) / closingSpeed;
  if (!(time > reference - TIME_EPS)) return null;

  const at = positionAt(a, time);
  return { kind: 'edge', time, at, a: a.id, b: b.id };
}

/**
 * When a reflex corner runs into an edge across the way.
 *
 * The edge is itself moving inwards at unit speed, so this is not simply "when
 * does the corner reach that line" — the line is coming to meet it. Both sides
 * are accounted for below, and the hit is only real if it lands between the
 * neighbours that edge still has when it happens: a corner that sails past the
 * end of an edge has not split anything.
 */
function splitEvent(
  node: Node,
  nodes: Node[],
  polygon: readonly Point2[],
  normals: readonly Point2[],
  speeds: readonly number[],
  positionAt: (node: Node, time: number) => Point2,
): SkeletonEvent | null {
  let best: SkeletonEvent | null = null;

  for (const other of nodes) {
    if (other.dead) continue;
    const edgeIndex = other.rightEdge;

    // Its own two edges cannot split it.
    if (edgeIndex === node.leftEdge || edgeIndex === node.rightEdge) continue;

    const normal = normals[edgeIndex]!;
    const origin = polygon[edgeIndex]!;

    // The edge is coming to meet the corner at its own speed, so the closing
    // rate is that speed less however much of the corner's own motion is
    // already along the same line.
    const approach = speeds[edgeIndex]! - dot(node.velocity, normal);
    if (Math.abs(approach) < EPS) continue;

    const offset = dot(sub(node.point, origin), normal) - node.time * dot(node.velocity, normal);
    const time = offset / approach;
    if (!(time > node.time + TIME_EPS)) continue;

    const at = positionAt(node, time);

    // The hit must land on the part of that edge which still exists.
    const next = nodes[other.next]!;
    if (next.dead) continue;
    const from = positionAt(other, time);
    const to = positionAt(next, time);
    const span = sub(to, from);
    const spanLength = length(span);
    if (spanLength < EPS) continue;

    const along = dot(sub(at, from), span) / (spanLength * spanLength);
    if (along < -1e-6 || along > 1 + 1e-6) continue;

    if (!best || time < best.time) {
      best = { kind: 'split', time, at, node: node.id, opposite: other.id };
    }
  }

  return best;
}


/**
 * Closes any wavefront loop that has come down to its ridge.
 *
 * A loop of two nodes is a segment with a roof plane on each side and nowhere
 * left to go: the two ends move at equal and opposite velocities, so no event
 * will ever fire and it would sit there alive for ever. That segment is the
 * ridge, and recording it is what closes the two faces beside it.
 *
 * This has to run per loop rather than once at the end, because a footprint
 * with an inside corner splits the wavefront into several loops that finish at
 * different times. Waiting for all of them would leave the whole solve stalled
 * on the first one to collapse.
 */
function closeFinishedLoops(
  nodes: Node[],
  arcs: Array<{
    from: Point2;
    to: Point2;
    fromTime: number;
    toTime: number;
    left: number;
    right: number;
  }>,
  positionAt: (node: Node, time: number) => Point2,
): void {
  for (const node of nodes) {
    if (node.dead) continue;

    const next = nodes[node.next];
    if (!next || next.dead) continue;

    // A loop of one is a point; nothing to record.
    if (next.id === node.id) {
      node.dead = true;
      continue;
    }

    if (nodes[next.next]?.id !== node.id) continue;

    /*
     * The two ends of a finished loop are carried by the same pair of eaves in
     * opposite order, which gives them the SAME velocity — the segment can only
     * translate, never shorten — so no event will ever fire on it. For the two
     * eaves that matter here, which face each other across the loop, that
     * shared velocity is zero: each end has stopped where it was born.
     *
     * So the ridge sits at the later of the two birth times, and the ends are
     * read at that time rather than at whatever moment the solver happens to
     * have reached. Using the solver's clock instead puts the ridge of every
     * wing at the time of the last unrelated event somewhere else in the house
     * — a roof whose ridges sit higher than the hips they are supposed to meet.
     * The shape still looks plausible, which is what makes it worth spelling
     * out; only the elevations are wrong.
     */
    const time = Math.max(node.time, next.time);
    const nodeAt = positionAt(node, time);
    const nextAt = positionAt(next, time);

    /*
     * Three arcs close this loop, and all three are needed.
     *
     * Each end has been travelling since it was born, and that journey is a
     * skeleton arc in its own right — dropping it loses a whole segment of
     * ridge, and the faces on either side of that segment can then never be
     * chained, so they disappear from the roof entirely. Then the segment
     * between the two ends is the ridge itself, dividing the last two planes.
     */
    arcs.push({
      from: node.point,
      to: nodeAt,
      fromTime: node.time,
      toTime: time,
      left: node.leftEdge,
      right: node.rightEdge,
    });
    arcs.push({
      from: next.point,
      to: nextAt,
      fromTime: next.time,
      toTime: time,
      left: next.leftEdge,
      right: next.rightEdge,
    });
    arcs.push({
      from: nodeAt,
      to: nextAt,
      fromTime: time,
      toTime: time,
      // The ridge separates the two eaves still facing each other: the one
      // ahead of this node and the one behind it.
      left: node.rightEdge,
      right: node.leftEdge,
    });

    node.dead = true;
    next.dead = true;
  }
}

/**
 * Re-joins every corner that has arrived at one point, in one go.
 *
 * Two corners meeting is the ordinary case and it has one sensible answer. Four
 * corners meeting is what a cross-shaped house does when its arms are the same
 * width: all four inside corners reach the middle at the same instant, and the
 * answer is no longer obvious — six pairings are available and only one of them
 * is right. Taking the pairs two at a time, in whatever order they happen to be
 * found, gets two of the four ridges right and leaves the remainder in a state
 * no further event can resolve.
 *
 * So the whole cluster is settled together, by angle. Each corner brings two
 * wavefront edges to the point: the one arriving behind it and the one leaving
 * ahead of it. Every arriving edge is then matched with the leaving edge that
 * subtends the SMALLEST wedge of interior with it, which is the pairing that
 * keeps the wavefront from folding through itself. On a cross that pairs each
 * arm with itself across the middle, which is exactly the four ridges wanted;
 * with two corners it reduces to swapping their eaves over, which is the
 * ordinary case again.
 *
 * Directions come from the eaves rather than from where the neighbouring
 * corners happen to be, because a neighbour can be sitting on the cluster point
 * too, and a direction of zero has no angle to sort by.
 *
 * Returns false if the cluster cannot be read — better a solve that reports
 * itself incomplete than one that quietly rewires the roof at random.
 */
function resolveCluster(
  nodes: Node[],
  normals: readonly Point2[],
  speeds: readonly number[],
  cluster: readonly Node[],
  at: Point2,
  time: number,
  retire: (node: Node, at: Point2, time: number) => void,
): boolean {
  if (cluster.length < 2) return false;

  /** Along the eave, in the direction the polygon is wound. */
  const along = (edgeIndex: number): Point2 => {
    const normal = normals[edgeIndex]!;
    return { x: normal.z, z: -normal.x };
  };

  const angleOf = (direction: Point2) => Math.atan2(direction.z, direction.x);

  // The edge behind a corner points back the way it came; the edge ahead points
  // on. Both are read as rays leaving the cluster point.
  const arriving = cluster.map((node) => ({
    node,
    angle: angleOf(scale(along(node.leftEdge), -1)),
  }));
  const leaving = cluster.map((node) => ({ node, angle: angleOf(along(node.rightEdge)) }));

  const TWO_PI = Math.PI * 2;
  const wedge = (inAngle: number, outAngle: number) => {
    // How far clockwise from the arriving ray to the leaving one: the interior
    // that the pair would enclose.
    let turn = (inAngle - outAngle) % TWO_PI;
    if (turn < 0) turn += TWO_PI;
    // A pairing that folds all the way round is really a zero-width one.
    return turn > TWO_PI - 1e-9 ? 0 : turn;
  };

  const candidates: Array<{ into: number; out: number; wedge: number }> = [];
  for (let i = 0; i < arriving.length; i++) {
    for (let j = 0; j < leaving.length; j++) {
      candidates.push({ into: i, out: j, wedge: wedge(arriving[i]!.angle, leaving[j]!.angle) });
    }
  }
  candidates.sort((a, b) => a.wedge - b.wedge);

  const takenIn = new Set<number>();
  const takenOut = new Set<number>();
  const pairs: Array<{ into: Node; out: Node }> = [];
  for (const candidate of candidates) {
    if (takenIn.has(candidate.into) || takenOut.has(candidate.out)) continue;
    takenIn.add(candidate.into);
    takenOut.add(candidate.out);
    pairs.push({ into: arriving[candidate.into]!.node, out: leaving[candidate.out]!.node });
  }
  if (pairs.length !== cluster.length) return false;

  // Neighbours are read before anything is unpicked, since the replacements
  // below overwrite the very pointers being read.
  const prevOf = new Map<number, Node>();
  const nextOf = new Map<number, Node>();
  for (const node of cluster) {
    prevOf.set(node.id, nodes[node.prev]!);
    nextOf.set(node.id, nodes[node.next]!);
  }

  for (const node of cluster) retire(node, at, time);

  const replacements: Node[] = [];
  for (const pair of pairs) {
    const before = prevOf.get(pair.into.id)!;
    const after = nextOf.get(pair.out.id)!;
    const fresh: Node = {
      id: nodes.length,
      point: at,
      time,
      velocity: bisectorVelocity(
        normals[pair.into.leftEdge]!,
        normals[pair.out.rightEdge]!,
        speeds[pair.into.leftEdge]!,
        speeds[pair.out.rightEdge]!,
      ),
      prev: before.id,
      next: after.id,
      leftEdge: pair.into.leftEdge,
      rightEdge: pair.out.rightEdge,
      dead: false,
      reflex: false,
    };
    nodes.push(fresh);
    replacements.push(fresh);
  }

  /*
   * Relinking is a second pass because a neighbour of one replacement may be
   * another replacement: on a cross the four new corners are each other's
   * neighbours, and pointing at a corner that did not exist yet would leave the
   * loop referring to nodes that were never made.
   */
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const fresh = replacements[i]!;
    const before = prevOf.get(pair.into.id)!;
    const after = nextOf.get(pair.out.id)!;
    if (before.dead) {
      // The corner behind was in this same cluster; whichever replacement took
      // over its outgoing eave is the one that now leads into this node.
      const stand = replacements.find((candidate) => candidate.rightEdge === before.rightEdge);
      if (stand) {
        fresh.prev = stand.id;
        stand.next = fresh.id;
      }
    } else {
      before.next = fresh.id;
    }

    if (after.dead) {
      const stand = replacements.find((candidate) => candidate.leftEdge === after.leftEdge);
      if (stand) {
        fresh.next = stand.id;
        stand.prev = fresh.id;
      }
    } else {
      after.prev = fresh.id;
    }
  }

  return true;
}

/**
 * Unpicks two coincident corners and re-joins them crosswise.
 *
 * Both corners are consumed and two new ones take their place at the same
 * point, each inheriting one eave from each of the originals. Everything that
 * used to lead into the pair now leads into one or other of the replacements,
 * so no wavefront edge is orphaned and the loop count changes by exactly one.
 *
 * Which way that count moves is not decided here and does not need to be: if
 * the two corners belonged to one loop this cuts it in two — a house pinching
 * shut across its middle — and if they belonged to different loops it welds
 * them into one. The pointer surgery is the same, and it is the shape that
 * decides which of the two it turns out to have been.
 */
function crossJoin(
  nodes: Node[],
  normals: readonly Point2[],
  speeds: readonly number[],
  node: Node,
  partner: Node,
  at: Point2,
  time: number,
  retire: (node: Node, at: Point2, time: number) => void,
): void {
  const nodePrev = nodes[node.prev]!;
  const nodeNext = nodes[node.next]!;
  const partnerPrev = nodes[partner.prev]!;
  const partnerNext = nodes[partner.next]!;

  retire(node, at, time);
  retire(partner, at, time);

  const one: Node = {
    id: nodes.length,
    point: at,
    time,
    velocity: bisectorVelocity(
      normals[node.leftEdge]!,
      normals[partner.rightEdge]!,
      speeds[node.leftEdge]!,
      speeds[partner.rightEdge]!,
    ),
    prev: nodePrev.id,
    next: partnerNext.id,
    leftEdge: node.leftEdge,
    rightEdge: partner.rightEdge,
    dead: false,
    reflex: false,
  };
  nodes.push(one);

  const two: Node = {
    id: nodes.length,
    point: at,
    time,
    velocity: bisectorVelocity(
      normals[partner.leftEdge]!,
      normals[node.rightEdge]!,
      speeds[partner.leftEdge]!,
      speeds[node.rightEdge]!,
    ),
    prev: partnerPrev.id,
    next: nodeNext.id,
    leftEdge: partner.leftEdge,
    rightEdge: node.rightEdge,
    dead: false,
    reflex: false,
  };
  nodes.push(two);

  nodePrev.next = one.id;
  partnerNext.prev = one.id;
  partnerPrev.next = two.id;
  nodeNext.prev = two.id;
}

/**
 * Closes any loop that has flattened onto a line.
 *
 * The ordinary ending is a loop of two: one corner at each end of a ridge. A
 * loop of three or more can end just as legitimately by collapsing to zero
 * area — every corner strung out along one line, nothing enclosed, and no event
 * able to fire because there is nothing left to close. That is a finished
 * ridge too, and it needs recording or the faces along it never close.
 *
 * Each surviving wavefront edge is a piece of that ridge, and the face on its
 * far side is whichever other edge of the same loop now lies on top of it. That
 * is found by asking which edge covers this one's midpoint — the midpoint
 * rather than an end, because at the ends several edges meet and the answer
 * there is a coin toss. An edge whose own midpoint is covered by nobody is one
 * that spans several others; the pieces record the ridge between them, so it
 * has nothing left to add and is passed over.
 *
 * Runs only when the solver has otherwise run dry, so it cannot pre-empt an
 * event that would have resolved the loop properly.
 */
function closeCollapsedLoops(
  nodes: Node[],
  arcs: Array<{
    from: Point2;
    to: Point2;
    fromTime: number;
    toTime: number;
    left: number;
    right: number;
  }>,
  positionAt: (node: Node, time: number) => Point2,
): boolean {
  const seen = new Set<number>();
  let closed = false;

  for (const start of nodes) {
    if (start.dead || seen.has(start.id)) continue;

    // Walk the loop this corner belongs to.
    const loop: Node[] = [];
    let cursor: Node | undefined = start;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      loop.push(cursor);
      const following: Node | undefined = nodes[cursor.next];
      cursor = following && !following.dead ? following : undefined;
    }
    if (loop.length < 3) continue;
    if (loop[loop.length - 1]!.next !== start.id) continue;

    const time = loop.reduce((latest, node) => Math.max(latest, node.time), 0);
    const points = loop.map((node) => positionAt(node, time));
    if (Math.abs(signedArea(points)) > 1e-7) continue;

    for (let i = 0; i < loop.length; i++) {
      const from = points[i]!;
      const to = points[(i + 1) % loop.length]!;
      const span = sub(to, from);
      const spanLength = length(span);
      if (spanLength < EPS) continue;

      const middle = add(from, scale(span, 0.5));

      // Which other edge of this loop lies across this one's middle.
      let opposite: number | null = null;
      for (let j = 0; j < loop.length; j++) {
        if (j === i) continue;
        const otherFrom = points[j]!;
        const otherTo = points[(j + 1) % loop.length]!;
        const otherSpan = sub(otherTo, otherFrom);
        const otherLength = length(otherSpan);
        if (otherLength < EPS) continue;

        const offset = sub(middle, otherFrom);
        // Off the line altogether, or past one of its ends: not a cover.
        if (Math.abs(cross(otherSpan, offset)) / otherLength > 1e-6) continue;
        const along = dot(offset, otherSpan) / (otherLength * otherLength);
        if (along <= 1e-6 || along >= 1 - 1e-6) continue;

        opposite = loop[j]!.rightEdge;
        break;
      }
      if (opposite === null) continue;

      arcs.push({
        from,
        to,
        fromTime: time,
        toTime: time,
        left: loop[i]!.rightEdge,
        right: opposite,
      });
    }

    for (const node of loop) {
      const at = positionAt(node, time);
      node.dead = true;
      arcs.push({
        from: node.point,
        to: at,
        fromTime: node.time,
        toTime: time,
        left: node.leftEdge,
        right: node.rightEdge,
      });
    }
    closed = true;
  }

  return closed;
}

/* --------------------------------- Offsets -------------------------------- */

/**
 * Pushes a polygon outwards, for the roof overhang.
 *
 * Each edge moves out along its own normal and the corners are re-intersected,
 * which is the correct mitred result rather than the rounded one you get from
 * moving the vertices along their bisectors by a fixed distance. On a sharp
 * corner the mitre can shoot a long way out, so it is capped — an eave that
 * reaches four feet past the corner of a house is not an eave, it is an error.
 */
export function offsetPolygon(polygon: readonly Point2[], distance: number): Point2[] {
  const clean = prepare(polygon);
  if (clean.length < 3) return clean;
  return offsetPolygonEdges(clean, new Array<number>(clean.length).fill(distance));
}

/**
 * The same, but with a distance of its own for every edge.
 *
 * Which is what a real building needs: a house does not have one wall
 * thickness, and the eave line runs parallel to the OUTSIDE of each wall, so a
 * 300 mm masonry wall and a 140 mm frame wall beside it push their eaves out by
 * different amounts. Each edge's line is moved by its own distance and the
 * corners are re-cut where the moved lines cross, which is the mitre a roofer
 * would actually build.
 *
 * `distances` is indexed by edge — edge i runs from vertex i to vertex i+1 —
 * and lines up with the polygon AS PASSED, so prepare it first if the indices
 * have to mean something.
 */
export function offsetPolygonEdges(
  polygon: readonly Point2[],
  distances: readonly number[],
): Point2[] {
  const clean = prepare(polygon);
  if (clean.length < 3 || distances.length !== clean.length) return clean;
  if (distances.every((distance) => Math.abs(distance) < EPS)) return clean;

  const count = clean.length;
  const result: Point2[] = [];
  const cap = Math.max(...distances.map(Math.abs)) * 4;

  for (let i = 0; i < count; i++) {
    const prev = clean[(i - 1 + count) % count]!;
    const here = clean[i]!;
    const next = clean[(i + 1) % count]!;

    const inEdge = (i - 1 + count) % count;
    const inNormal = outwardNormal(prev, here);
    const outNormal = outwardNormal(here, next);
    const inDistance = distances[inEdge]!;
    const outDistance = distances[i]!;

    // Where the two moved lines cross. Solve dot(p - here, n) = d for both.
    const determinant = inNormal.x * outNormal.z - inNormal.z * outNormal.x;
    if (Math.abs(determinant) < 1e-9) {
      // The edges are parallel: no corner to cut, just move the vertex out.
      const straightOn = dot(inNormal, outNormal) > 0;
      result.push(add(here, scale(outNormal, straightOn ? outDistance : 0)));
      continue;
    }

    const shift = {
      x: (inDistance * outNormal.z - outDistance * inNormal.z) / determinant,
      z: (outDistance * inNormal.x - inDistance * outNormal.x) / determinant,
    };

    // A very sharp corner throws its mitre a long way out — an eave that
    // reaches four feet past the corner of a house is not an eave, it is an
    // error — so the reach is capped and the direction kept.
    const reach = length(shift);
    result.push(add(here, reach > cap && reach > EPS ? scale(shift, cap / reach) : shift));
  }

  return result;
}

/** Outward unit normal of the edge a to b, for an anticlockwise polygon. */
function outwardNormal(a: Point2, b: Point2): Point2 {
  const direction = normalize(sub(b, a));
  return { x: direction.z, z: -direction.x };
}

/** Shortest distance from a point to a polygon's boundary. */
export function distanceToBoundary(point: Point2, polygon: readonly Point2[]): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!;
    const b = polygon[i]!;
    const span = sub(b, a);
    const lengthSq = dot(span, span);
    const t =
      lengthSq < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(point, a), span) / lengthSq));
    best = Math.min(best, length(sub(point, add(a, scale(span, t)))));
  }
  return best;
}
