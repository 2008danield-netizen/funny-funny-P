/**
 * Tests for turning a trace into a plan.
 *
 * The thing that matters here is that the result is a wall GRAPH rather than a
 * pile of lines: rooms are detected from closed loops, so a corner that misses
 * by two centimetres is the difference between a floor plan and a drawing of
 * one. Most of these tests therefore end by asking whether a room appeared.
 */

import { describe, expect, it } from 'vitest';

import { findRegions } from '@/scene/planGraph';
import { createDefaultDocument } from './defaults';
import { placeNewUnderlay } from '@/plan/underlay';
import type { DetectedWall } from '@/plan/detect';
import type { DesignDocument, Point2 } from './types';

import {
  acceptCandidates,
  candidatesFrom,
  dominantAngle,
  straightenCandidates,
  type TraceCandidate,
} from './traceOps';

/** A document with one empty storey. */
function empty(): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  return doc;
}

const candidate = (
  from: [number, number],
  to: [number, number],
  thickness: number | null = 0.2,
  id = `${from.join()}-${to.join()}`,
): TraceCandidate => ({
  id,
  from: { x: from[0], z: from[1] },
  to: { x: to[0], z: to[1] },
  thickness,
  confidence: 0.9,
});

/** The four walls of a room, with the corners deliberately missing slightly. */
function raggedRoom(slop: number): TraceCandidate[] {
  return [
    candidate([0, 0], [6 - slop, 0]),
    candidate([6, slop], [6, 4]),
    candidate([6 - slop, 4], [slop, 4]),
    candidate([0, 4 - slop], [0, slop]),
  ];
}

const angleOf = (one: TraceCandidate) =>
  Math.atan2(one.to.z - one.from.z, one.to.x - one.from.x);

describe('from the detector to the world', () => {
  it('converts pixels to metres, thickness and all', () => {
    // 10 m across a 1000 px image: a centimetre to the pixel.
    const underlay = { ...placeNewUnderlay('img', 1000, 1000, 10), metresPerPixel: 0.01 };
    const detected: DetectedWall[] = [
      { from: { x: 100, z: 500 }, to: { x: 900, z: 500 }, thicknessPixels: 20, confidence: 0.8 },
    ];

    const [wall] = candidatesFrom(underlay, detected);
    expect(wall).toBeDefined();
    // 800 px at a centimetre each.
    expect(Math.hypot(wall!.to.x - wall!.from.x, wall!.to.z - wall!.from.z)).toBeCloseTo(8, 6);
    expect(wall!.thickness).toBeCloseTo(0.2, 6);
  });

  it('drops the confetti a scan always produces', () => {
    const underlay = { ...placeNewUnderlay('img', 1000, 1000, 10), metresPerPixel: 0.01 };
    const detected: DetectedWall[] = [
      { from: { x: 0, z: 0 }, to: { x: 5, z: 0 }, thicknessPixels: null, confidence: 0.3 },
      { from: { x: 100, z: 100 }, to: { x: 900, z: 100 }, thicknessPixels: null, confidence: 0.9 },
    ];

    // A five-pixel line is five centimetres of wall. Showing it and making
    // somebody reject it is worse than not offering it.
    expect(candidatesFrom(underlay, detected)).toHaveLength(1);
  });

  it('keeps a thickness inside what a wall can actually be', () => {
    const underlay = { ...placeNewUnderlay('img', 1000, 1000, 10), metresPerPixel: 0.01 };
    const detected: DetectedWall[] = [
      { from: { x: 0, z: 0 }, to: { x: 900, z: 0 }, thicknessPixels: 400, confidence: 0.9 },
    ];
    // Four metres thick is a detection mistake, not a wall.
    expect(candidatesFrom(underlay, detected)[0]!.thickness).toBeLessThanOrEqual(0.6);
  });
});

describe('straightening out the skew', () => {
  it('finds the direction a rectangular plan is drawn in', () => {
    // A room turned two degrees, as a scan on a photocopier glass would be.
    const skew = (2 * Math.PI) / 180;
    const turn = (point: Point2): [number, number] => [
      point.x * Math.cos(skew) - point.z * Math.sin(skew),
      point.x * Math.sin(skew) + point.z * Math.cos(skew),
    ];
    const room = raggedRoom(0).map((one) =>
      candidate(turn(one.from), turn(one.to), one.thickness, one.id),
    );

    expect(dominantAngle(room)).toBeCloseTo(skew, 3);
  });

  it('is not fooled by the corners of its own building', () => {
    // Walls at 0 and 90 degrees. Averaging the angles gives 45, which is a
    // direction the building does not have.
    const angle = dominantAngle([candidate([0, 0], [5, 0]), candidate([0, 0], [0, 5])]);
    expect(Math.abs(angle)).toBeLessThan(0.02);
  });

  it('turns a skewed wall onto the grid, about its own middle', () => {
    const skewed = candidate([0, 0], [6, 0.15]);
    const [straight] = straightenCandidates([skewed], 0);

    expect(angleOf(straight!)).toBeCloseTo(0, 6);
    // Same middle, same length: it turned, it did not slide.
    expect((straight!.from.x + straight!.to.x) / 2).toBeCloseTo(3, 6);
    expect((straight!.from.z + straight!.to.z) / 2).toBeCloseTo(0.075, 6);
    expect(Math.hypot(straight!.to.x - straight!.from.x, straight!.to.z - straight!.from.z))
      .toBeCloseTo(Math.hypot(6, 0.15), 6);
  });

  it('leaves a wall that is genuinely at an angle exactly where it is', () => {
    // A 30 degree wall in a square building is a bay or a stair, not skew.
    const angled = candidate([0, 0], [5, 2.9]);
    const [same] = straightenCandidates([angled], 0);
    expect(same).toEqual(angled);
  });
});

describe('accepting a trace', () => {
  it('joins corners that nearly meet, so the room closes', () => {
    const doc = empty();
    const result = acceptCandidates(doc, doc.levels[0]!.id, raggedRoom(0.08));

    expect(result.added).toBe(4);
    expect(doc.levels[0]!.plan.vertices).toHaveLength(4);
    // The point of all of it: four lines that nearly meet are not a room, and
    // four that do are.
    expect(findRegions(doc.levels[0]!.plan)).toHaveLength(1);
    // Averaging ragged endpoints pulls each corner a few centimetres in, so a
    // 6 x 4 room traced with 8 cm of slop comes back a little under 24 m².
    // That is the honest result of the input, not an error in the joining.
    const area = findRegions(doc.levels[0]!.plan)[0]!.area;
    expect(area).toBeGreaterThan(23);
    expect(area).toBeLessThan(24.5);
  });

  it('does not join corners that are genuinely apart', () => {
    const doc = empty();
    // Two walls a metre and a half apart: a doorway, not a corner.
    acceptCandidates(doc, doc.levels[0]!.id, [
      candidate([0, 0], [3, 0]),
      candidate([4.5, 0], [8, 0]),
    ]);

    expect(doc.levels[0]!.plan.vertices).toHaveLength(4);
  });

  it('joins onto walls that are already drawn', () => {
    // Tracing a second wing onto a house must attach to the first, not build a
    // separate structure two centimetres away from it.
    const doc = empty();
    acceptCandidates(doc, doc.levels[0]!.id, raggedRoom(0));
    const before = doc.levels[0]!.plan.vertices.length;

    acceptCandidates(doc, doc.levels[0]!.id, [
      candidate([6.04, 0.03], [10, 0]),
      candidate([10, 0], [10, 4]),
      candidate([10, 4], [6.02, 4.05]),
    ]);

    // Two new corners, not five: the two on the shared wall were already there.
    expect(doc.levels[0]!.plan.vertices).toHaveLength(before + 2);
    expect(findRegions(doc.levels[0]!.plan)).toHaveLength(2);
  });

  it('carries the detected thickness through, and falls back where there was none', () => {
    const doc = empty();
    doc.levels[0]!.plan.defaultWallThickness = 0.12;

    acceptCandidates(doc, doc.levels[0]!.id, [
      candidate([0, 0], [4, 0], 0.3),
      candidate([0, 2], [4, 2], null),
    ]);

    const thicknesses = doc.levels[0]!.plan.walls.map((wall) => wall.thickness).sort();
    expect(thicknesses[0]).toBeCloseTo(0.12, 6);
    expect(thicknesses[1]).toBeCloseTo(0.3, 6);
  });

  it('refuses to add the same wall twice', () => {
    const doc = empty();
    acceptCandidates(doc, doc.levels[0]!.id, [
      candidate([0, 0], [4, 0], 0.2, 'a'),
      candidate([0.01, 0.01], [4.01, 0], 0.2, 'b'),
    ]);
    expect(doc.levels[0]!.plan.walls).toHaveLength(1);
  });

  it('drops a wall whose two ends turn out to be the same corner', () => {
    const doc = empty();
    const result = acceptCandidates(doc, doc.levels[0]!.id, [candidate([0, 0], [0.05, 0.05])]);
    expect(result.added).toBe(0);
    expect(doc.levels[0]!.plan.walls).toHaveLength(0);
  });

  it('does nothing at all for a storey that is not there', () => {
    const doc = empty();
    expect(acceptCandidates(doc, 'nope', raggedRoom(0))).toEqual({ added: 0, joined: 0 });
  });

  it('straightens by default, and leaves it alone when told to', () => {
    /*
     * Straightening needs evidence of what straight IS. One wall on its own is
     * its own grid and cannot be skew — so the fixture is three square walls
     * and one that misses by a couple of degrees, which is what a scan of a
     * rectangular house actually looks like.
     */
    const trace = [
      candidate([0, 4], [0, 0], 0.2, 'left'),
      candidate([0, 4], [6, 4], 0.2, 'bottom'),
      candidate([6, 4], [6, 0], 0.2, 'right'),
      candidate([0, 0], [6, 0.12], 0.2, 'skewed'),
    ];

    const straightened = empty();
    acceptCandidates(straightened, straightened.levels[0]!.id, trace);
    const top = straightened.levels[0]!.plan.vertices.filter((vertex) => Math.abs(vertex.z) < 0.5);
    expect(top).toHaveLength(2);
    expect(Math.abs(top[0]!.z - top[1]!.z)).toBeLessThan(0.02);

    const asDrawn = empty();
    acceptCandidates(asDrawn, asDrawn.levels[0]!.id, trace, { straighten: false });
    // Left as drawn, that wall is still visibly out of level. Not by the whole
    // 12 cm: joining its far end to the corner already there takes half of it,
    // which is the joining step doing its own job rather than straightening.
    const asDrawnTop = asDrawn.levels[0]!.plan.vertices.filter((vertex) => Math.abs(vertex.z) < 0.5);
    expect(Math.abs(asDrawnTop[0]!.z - asDrawnTop[1]!.z)).toBeGreaterThan(0.04);
  });
});
