/**
 * Turns a wall segment into geometry, with real holes for doors and windows.
 *
 * WHY EXTRUSION RATHER THAN BOXES
 * Session 1 built walls as boxes, which is fine until something needs cutting
 * through one. Boolean CSG on boxes is slow, fragile and pulls in a dependency.
 * Extruding a 2D outline is exact, fast and needs nothing: the wall's elevation
 * is drawn as a rectangle, each opening is punched into it as a hole, and the
 * whole outline is swept through the wall's thickness. Three.js triangulates the
 * outline and generates the hole's inner surfaces (the "reveals") for free.
 *
 * LOCAL SPACE
 * A wall is built lying in its own frame and then placed:
 *
 *     local +X  ->  along the wall, from its start vertex   (0 .. length)
 *     local +Y  ->  up                                       (0 .. height)
 *     local +Z  ->  towards face "a"                         (0 .. thickness)
 *
 * so a hole at "1.2 m along, 0.9 m up" is written exactly that way. The frame
 * matches the `normal` from `planGraph.resolveWall`, which is what makes face
 * "a" mean the same thing in the geometry as it does in the data model.
 */

import * as THREE from 'three';

import type { WallSegment } from './planGraph';
import { getOpeningPreset } from './openings/presets';
import type { Opening } from '@/state/types';

/** Material slots in the geometry the builder returns. */
export const WALL_MATERIAL_SLOT = {
  /** The face the wall's normal points towards. */
  faceA: 0,
  /** The opposite face. */
  faceB: 1,
  /** Top, ends, and the reveals inside every opening. */
  edges: 2,
} as const;

/**
 * Builds the wall's elevation outline with a hole punched for each opening.
 *
 * Openings are skipped rather than clipped when they would not leave solid wall
 * on both sides: a hole touching the outline's edge produces a self-intersecting
 * polygon, which triangulates into garbage rather than failing loudly.
 */
function buildElevation(segment: WallSegment, openings: readonly Opening[]): THREE.Shape {
  const { length } = segment;
  const height = segment.wall.height;

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(length, 0);
  shape.lineTo(length, height);
  shape.lineTo(0, height);
  shape.closePath();

  const margin = 0.02;

  for (const opening of openings) {
    const halfWidth = opening.width / 2;
    const left = opening.offset - halfWidth;
    const right = opening.offset + halfWidth;
    const bottom = opening.sillHeight;
    const top = opening.sillHeight + opening.height;

    const fitsHorizontally = left > margin && right < length - margin;
    const fitsVertically = bottom >= -1e-6 && top < height - margin;
    if (!fitsHorizontally || !fitsVertically) continue;

    const hole = new THREE.Path();
    if (bottom <= 1e-6) {
      // A doorway reaches the floor, so its hole opens through the bottom edge
      // of the outline. Dropping it a little below zero keeps the hole strictly
      // inside the outline, which the triangulator requires; the surplus is
      // buried under the floor and never visible.
      hole.moveTo(left, -0.02);
      hole.lineTo(right, -0.02);
    } else {
      hole.moveTo(left, bottom);
      hole.lineTo(right, bottom);
    }
    hole.lineTo(right, top);
    hole.lineTo(left, top);
    hole.closePath();

    shape.holes.push(hole);
  }

  return shape;
}

/**
 * Splits the extrusion's triangles into three material groups.
 *
 * `ExtrudeGeometry` puts both flat faces in one group and every side in
 * another, so out of the box the two sides of a wall cannot be painted
 * differently — which is exactly what a wall between two rooms needs. The two
 * faces are separated here by testing each triangle's depth in local space:
 * everything at z = 0 is one face, everything at z = thickness is the other,
 * and anything in between is an edge or an opening reveal.
 */
function assignMaterialGroups(geometry: THREE.BufferGeometry, thickness: number): void {
  const position = geometry.getAttribute('position');
  const triangleCount = position.count / 3;
  const epsilon = 1e-4;

  // Slot per triangle, then coalesced into as few groups as possible: one group
  // per contiguous run keeps the draw-call count down.
  const slots = new Uint8Array(triangleCount);

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const base = triangle * 3;
    const z0 = position.getZ(base);
    const z1 = position.getZ(base + 1);
    const z2 = position.getZ(base + 2);

    const allAtBack = z0 < epsilon && z1 < epsilon && z2 < epsilon;
    const allAtFront =
      z0 > thickness - epsilon && z1 > thickness - epsilon && z2 > thickness - epsilon;

    slots[triangle] = allAtFront
      ? WALL_MATERIAL_SLOT.faceA
      : allAtBack
        ? WALL_MATERIAL_SLOT.faceB
        : WALL_MATERIAL_SLOT.edges;
  }

  geometry.clearGroups();
  let runStart = 0;
  for (let triangle = 1; triangle <= triangleCount; triangle++) {
    const ended = triangle === triangleCount || slots[triangle] !== slots[runStart];
    if (!ended) continue;
    geometry.addGroup(runStart * 3, (triangle - runStart) * 3, slots[runStart]!);
    runStart = triangle;
  }
}

/**
 * The transform that places a locally-built wall into the world.
 *
 * The wall is centred on its centreline, so half its thickness sits either
 * side. Two walls meeting at a corner therefore overlap by half a thickness
 * each, which is what closes the corner without a mitre joint.
 */
export function wallMatrix(segment: WallSegment): THREE.Matrix4 {
  const thickness = segment.wall.thickness;

  const xAxis = new THREE.Vector3(segment.direction.x, 0, segment.direction.z);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(segment.normal.x, 0, segment.normal.z);

  const origin = new THREE.Vector3(
    segment.start.x - segment.normal.x * (thickness / 2),
    0,
    segment.start.z - segment.normal.z * (thickness / 2),
  );

  return new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(origin);
}

/**
 * Builds a wall's geometry in its own local frame.
 *
 * The caller applies `wallMatrix` to the mesh rather than baking the transform
 * into the vertices, so that moving a wall costs a matrix update instead of a
 * geometry rebuild.
 */
export function buildWallGeometry(segment: WallSegment): THREE.BufferGeometry {
  const thickness = segment.wall.thickness;
  const shape = buildElevation(segment, segment.wall.openings);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    // The outline is made of straight lines only, so no curve subdivision is
    // needed and the default (12) would trisect every wall for nothing.
    curveSegments: 1,
    steps: 1,
  });

  assignMaterialGroups(geometry, thickness);
  geometry.computeVertexNormals();

  // UVs come out of ExtrudeGeometry in metres (the outline's own coordinates),
  // so a wall's texture scale is set by the material's repeat rather than by the
  // wall's size. That keeps plaster grain identical on a 1 m and a 9 m wall.
  return geometry;
}

/* ------------------------- Doors and window sashes -------------------- */

/**
 * Geometry for what sits INSIDE an opening: frame, glazing and door leaves.
 *
 * Returned in the wall's local frame so the caller can place it with the same
 * matrix as the wall itself.
 */
export interface OpeningFurniture {
  frame: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
  leaf: THREE.BufferGeometry | null;
}

/** Frame section depth, as a fraction of wall thickness. */
const FRAME_DEPTH_RATIO = 0.75;
/** Width of the visible frame lining, in metres. */
const FRAME_WIDTH = 0.05;

/** Builds a box in local wall space from min/max corners. */
function boxBetween(
  min: [number, number, number],
  max: [number, number, number],
): THREE.BufferGeometry {
  const size: [number, number, number] = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geometry.translate(
    min[0] + size[0] / 2,
    min[1] + size[1] / 2,
    min[2] + size[2] / 2,
  );
  return geometry;
}

/**
 * Builds the frame, glazing and leaves for one opening.
 *
 * Everything is assembled from boxes and merged per material, so a wall with
 * four windows still costs three draw calls rather than forty.
 */
export function buildOpeningFurniture(
  segment: WallSegment,
  opening: Opening,
): OpeningFurniture {
  const preset = getOpeningPreset(opening.presetId);
  const thickness = segment.wall.thickness;

  const halfWidth = opening.width / 2;
  const left = opening.offset - halfWidth;
  const right = opening.offset + halfWidth;
  const bottom = opening.sillHeight;
  const top = opening.sillHeight + opening.height;

  const frameDepth = thickness * FRAME_DEPTH_RATIO;
  const frameZMin = (thickness - frameDepth) / 2;
  const frameZMax = frameZMin + frameDepth;

  /* ---- Frame lining: a band around the inside of the hole ---- */
  const framePieces: THREE.BufferGeometry[] = [
    // Head.
    boxBetween([left, top - FRAME_WIDTH, frameZMin], [right, top, frameZMax]),
    // Jambs.
    boxBetween([left, bottom, frameZMin], [left + FRAME_WIDTH, top, frameZMax]),
    boxBetween([right - FRAME_WIDTH, bottom, frameZMin], [right, top, frameZMax]),
  ];

  // A window gets a sill; a door gets a threshold only if it has a raised sill.
  if (bottom > 0.01) {
    framePieces.push(
      boxBetween([left, bottom, frameZMin], [right, bottom + FRAME_WIDTH, frameZMax]),
    );
  }

  // Vertical glazing bars, evenly spaced across the opening.
  if (preset.glazed && preset.mullions > 0) {
    const inner = right - left - FRAME_WIDTH * 2;
    const spacing = inner / (preset.mullions + 1);
    for (let i = 1; i <= preset.mullions; i++) {
      const centre = left + FRAME_WIDTH + spacing * i;
      framePieces.push(
        boxBetween(
          [centre - 0.018, bottom + FRAME_WIDTH, frameZMin],
          [centre + 0.018, top - FRAME_WIDTH, frameZMax],
        ),
      );
    }
  }

  const frame = mergeGeometries(framePieces);

  /* ---- Glazing: one thin pane filling the frame ---- */
  let glass: THREE.BufferGeometry | null = null;
  if (preset.glazed) {
    const paneZ = thickness / 2;
    glass = boxBetween(
      [left + FRAME_WIDTH, bottom + FRAME_WIDTH, paneZ - 0.004],
      [right - FRAME_WIDTH, top - FRAME_WIDTH, paneZ + 0.004],
    );
  }

  /* ---- Door leaves ---- */
  const leaf = buildLeaf(preset.leaf, opening, {
    left,
    right,
    bottom,
    top,
    thickness,
  });

  return { frame, glass, leaf };
}

interface LeafBounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
  thickness: number;
}

/**
 * Builds the door panel(s).
 *
 * A hinged door is drawn standing ajar rather than flat in its frame: a closed
 * door is indistinguishable from a wall at a glance, whereas an open one reads
 * immediately as a door and — more usefully for a design tool — shows the floor
 * area its swing consumes. Session 4's clearance rules will want that arc.
 */
function buildLeaf(
  style: 'single' | 'double' | 'sliding' | 'none',
  opening: Opening,
  bounds: LeafBounds,
): THREE.BufferGeometry | null {
  if (style === 'none') return null;

  const { left, right, bottom, top, thickness } = bounds;
  const leafThickness = 0.04;
  const height = top - bottom - 0.01;
  const zCentre = thickness / 2;

  if (style === 'sliding') {
    // Slid open across half the aperture, sitting just inside the wall face.
    const width = (right - left) / 2 - 0.02;
    const panel = boxBetween(
      [left + 0.01, bottom, zCentre - leafThickness],
      [left + 0.01 + width, bottom + height, zCentre],
    );
    return panel;
  }

  /** Builds one hinged leaf, rotated about its hinge stile. */
  const hingedLeaf = (
    hingeX: number,
    leafWidth: number,
    /** +1 swings towards face a, -1 towards face b. */
    swingSign: number,
    /** +1 when the leaf extends in +X from its hinge. */
    directionSign: number,
  ): THREE.BufferGeometry => {
    // Built at the origin so it can be rotated about the hinge, then moved.
    const geometry = new THREE.BoxGeometry(leafWidth, height, leafThickness);
    geometry.translate((directionSign * leafWidth) / 2, 0, 0);

    // 65 degrees reads as "open" without the leaf lying flat against the wall.
    const angle = swingSign * directionSign * THREE.MathUtils.degToRad(65);
    geometry.rotateY(angle);
    geometry.translate(hingeX, bottom + height / 2, zCentre);
    return geometry;
  };

  const swingSign = opening.swing === 'a' ? 1 : -1;

  if (style === 'double') {
    const half = (right - left) / 2 - 0.01;
    return mergeGeometries([
      hingedLeaf(left + 0.01, half, swingSign, 1),
      hingedLeaf(right - 0.01, half, swingSign, -1),
    ]);
  }

  const width = right - left - 0.02;
  return opening.hinge === 'start'
    ? hingedLeaf(left + 0.01, width, swingSign, 1)
    : hingedLeaf(right - 0.01, width, swingSign, -1);
}

/* ------------------------------- Merging ------------------------------ */

/**
 * Concatenates geometries that share an attribute layout.
 *
 * Three ships `BufferGeometryUtils.mergeGeometries`, but importing it pulls in
 * the whole utils module for one function. All the inputs here are BoxGeometry
 * with identical attributes, so a direct concatenation is both smaller and
 * easier to reason about. Inputs are disposed, since they are throwaway.
 */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0]!;

  // De-index FIRST. BoxGeometry is indexed, so its position attribute holds 24
  // unique corners while the index defines the 36 triangle vertices. Copying the
  // raw attributes of an indexed geometry and dropping the index would scramble
  // every face. Rebasing indices per source would work too, but boxes are small
  // enough that going non-indexed costs little and removes the whole class of bug.
  const flattened = geometries.map((geometry) => {
    const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
    // `toNonIndexed` returns a new geometry, leaving the original to be freed.
    if (nonIndexed !== geometry) geometry.dispose();
    return nonIndexed;
  });

  const attributeNames = ['position', 'normal', 'uv'] as const;
  const merged = new THREE.BufferGeometry();

  for (const name of attributeNames) {
    const first = flattened[0]!.getAttribute(name);
    if (!first) continue;

    const itemSize = first.itemSize;
    let total = 0;
    for (const geometry of flattened) total += geometry.getAttribute(name)?.count ?? 0;

    const array = new Float32Array(total * itemSize);
    let offset = 0;
    for (const geometry of flattened) {
      const attribute = geometry.getAttribute(name);
      if (!attribute) continue;
      array.set(attribute.array as Float32Array, offset);
      offset += attribute.count * itemSize;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }

  for (const geometry of flattened) geometry.dispose();
  return merged;
}
