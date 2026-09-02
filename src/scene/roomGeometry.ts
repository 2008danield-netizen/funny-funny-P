/**
 * Turns the abstract `RoomModel` into concrete geometry parameters.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS MODULE IS THE SEAM.
 *
 * Session 1 rooms are rectangles, but the roadmap calls for walls the user can
 * add, move and resize. Everything downstream of this file — the meshes, the
 * materials, the camera framing, and eventually furniture collision — consumes
 * `WallSegment[]` and never looks at `width`/`depth` directly. When arbitrary
 * floor-plan polygons arrive, only `computeWallSegments()` changes; the rest of
 * the scene code keeps working unmodified.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Coordinate conventions (see also `state/types.ts`):
 *   • Y is up; the floor is the plane y = 0.
 *   • The room is centred on the origin: x ∈ [-w/2, w/2], z ∈ [-d/2, d/2].
 *   • "North" is -Z, "south" is +Z, "east" is +X, "west" is -X.
 */

import type { RoomModel, WallId } from '@/state/types';

/** A point on the floor plane. */
export interface Point2 {
  x: number;
  z: number;
}

/**
 * One wall, described both abstractly (for layout and future collision maths)
 * and concretely (for building the box mesh that represents it).
 */
export interface WallSegment {
  id: WallId;

  /* ---- Abstract description: what future features will read ---- */

  /** Endpoints of the wall's interior face, on the floor plane. */
  start: Point2;
  end: Point2;
  /** Length of the interior face, in metres. */
  length: number;
  /** Unit vector pointing from the wall into the room. */
  interiorNormal: Point2;
  /** A point on the interior face, used for side-of-plane tests. */
  interiorPoint: Point2;

  /* ---- Concrete description: what the mesh builder reads ---- */

  /** Box dimensions in metres. */
  size: { x: number; y: number; z: number };
  /** Box centre in world space. */
  center: { x: number; y: number; z: number };
  /**
   * Which of the box's six materials is the interior face.
   * BoxGeometry group order is [+X, -X, +Y, -Y, +Z, -Z].
   */
  interiorFaceIndex: number;
  /** Width of the interior face, in metres — drives the texture repeat. */
  faceWidth: number;
}

/**
 * Builds the four wall segments for a rectangular room.
 *
 * North and south walls are extended by one wall thickness at each end so they
 * overlap the east and west walls at the corners. Without that overlap the
 * corners show a hairline gap from outside the room.
 */
export function computeWallSegments(room: RoomModel): WallSegment[] {
  const { width: w, depth: d, height: h, wallThickness: t } = room;
  const halfW = w / 2;
  const halfD = d / 2;
  const halfT = t / 2;
  const midY = h / 2;

  return [
    {
      id: 'north',
      start: { x: -halfW, z: -halfD },
      end: { x: halfW, z: -halfD },
      length: w,
      interiorNormal: { x: 0, z: 1 },
      interiorPoint: { x: 0, z: -halfD },
      size: { x: w + t * 2, y: h, z: t },
      center: { x: 0, y: midY, z: -halfD - halfT },
      interiorFaceIndex: 4, // +Z face looks into the room
      faceWidth: w + t * 2,
    },
    {
      id: 'south',
      start: { x: halfW, z: halfD },
      end: { x: -halfW, z: halfD },
      length: w,
      interiorNormal: { x: 0, z: -1 },
      interiorPoint: { x: 0, z: halfD },
      size: { x: w + t * 2, y: h, z: t },
      center: { x: 0, y: midY, z: halfD + halfT },
      interiorFaceIndex: 5, // -Z face
      faceWidth: w + t * 2,
    },
    {
      id: 'east',
      start: { x: halfW, z: -halfD },
      end: { x: halfW, z: halfD },
      length: d,
      interiorNormal: { x: -1, z: 0 },
      interiorPoint: { x: halfW, z: 0 },
      size: { x: t, y: h, z: d },
      center: { x: halfW + halfT, y: midY, z: 0 },
      interiorFaceIndex: 1, // -X face
      faceWidth: d,
    },
    {
      id: 'west',
      start: { x: -halfW, z: halfD },
      end: { x: -halfW, z: -halfD },
      length: d,
      interiorNormal: { x: 1, z: 0 },
      interiorPoint: { x: -halfW, z: 0 },
      size: { x: t, y: h, z: d },
      center: { x: -halfW - halfT, y: midY, z: 0 },
      interiorFaceIndex: 0, // +X face
      faceWidth: d,
    },
  ];
}

/** Interior floor area in square metres. */
export function floorArea(room: RoomModel): number {
  return room.width * room.depth;
}

/** Interior wall perimeter in metres. */
export function perimeter(room: RoomModel): number {
  return 2 * (room.width + room.depth);
}

/** Interior volume in cubic metres. */
export function volume(room: RoomModel): number {
  return floorArea(room) * room.height;
}

/**
 * True when a world-space point lies on the exterior side of a wall.
 *
 * Used to hide walls that stand between an outside camera and the room, and
 * later to keep furniture inside the room.
 */
export function isOutsideWall(segment: WallSegment, x: number, z: number): boolean {
  const dx = x - segment.interiorPoint.x;
  const dz = z - segment.interiorPoint.z;
  return dx * segment.interiorNormal.x + dz * segment.interiorNormal.z < 0;
}

/** The radius of a sphere enclosing the whole room, for camera framing. */
export function boundingRadius(room: RoomModel): number {
  return Math.hypot(room.width, room.depth, room.height) / 2;
}
