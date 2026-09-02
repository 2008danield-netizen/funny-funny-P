/**
 * The room shell: floor, ceiling, four walls and skirting boards.
 *
 * PERFORMANCE CONTRACT — this is the part of the codebase most likely to be
 * misused later, so it is worth being explicit:
 *
 *   Changing a COLOUR, ROUGHNESS or FLOOR PRESET does not touch geometry. It
 *   updates material properties in place, which is essentially free and is why
 *   dragging a colour picker feels instant.
 *
 *   Changing a DIMENSION rebuilds geometry. That is unavoidable, but the meshes
 *   and materials are reused — only the `BufferGeometry` objects are replaced,
 *   and the old ones are explicitly disposed. Never let this class create a
 *   geometry without disposing the one it replaces: WebGL buffers are not
 *   garbage-collected, and the room can be resized hundreds of times a second
 *   while a slider is dragged.
 */

import * as THREE from 'three';

import { MaterialLibrary } from './materials/MaterialLibrary';
import { computeWallSegments, isOutsideWall, type WallSegment } from './roomGeometry';
import { WALL_IDS, type RoomModel, type WallId } from '@/state/types';

/** Height of the skirting board, in metres. */
const SKIRTING_HEIGHT = 0.09;
/** How far the skirting stands proud of the wall, in metres. */
const SKIRTING_DEPTH = 0.016;

/** Everything needed to keep one wall up to date. */
interface WallParts {
  mesh: THREE.Mesh;
  /** The interior-facing material — the one the user's colour is applied to. */
  interior: THREE.MeshStandardMaterial;
  /** Neutral material shared by the wall's five other faces. */
  exterior: THREE.MeshStandardMaterial;
  skirting: THREE.Mesh;
  segment: WallSegment;
}

export class Room {
  readonly group = new THREE.Group();

  private materials: MaterialLibrary;

  private floor: THREE.Mesh;
  private floorMaterial: THREE.MeshStandardMaterial;
  private ceiling: THREE.Mesh;
  private ceilingMaterial: THREE.MeshStandardMaterial;
  private site: THREE.Mesh;
  private walls = new Map<WallId, WallParts>();
  private skirtingMaterial: THREE.MeshStandardMaterial;

  /**
   * The dimensions the current geometry was built from.
   *
   * Comparing against this is what lets `update()` skip the expensive rebuild
   * when only an appearance property changed.
   */
  private builtDimensions = '';

  /** Whether walls between the camera and the room are hidden automatically. */
  private autoHideWalls = true;

  private segments: WallSegment[] = [];

  constructor(materials: MaterialLibrary) {
    this.materials = materials;
    this.group.name = 'Room';

    /* ---- Floor ---- */
    this.floorMaterial = materials.createFloorMaterial();
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.floorMaterial);
    // PlaneGeometry is created in the XY plane facing +Z; rotate it flat.
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.floor.name = 'Floor';
    this.group.add(this.floor);

    /* ---- Ceiling ---- */
    this.ceilingMaterial = materials.createPlainMaterial('#f7f5f2', 0.97);
    this.ceiling = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.ceilingMaterial);
    this.ceiling.rotation.x = Math.PI / 2; // face downwards, into the room
    this.ceiling.receiveShadow = true;
    this.ceiling.name = 'Ceiling';
    this.group.add(this.ceiling);

    /* ---- Site ground ----
     * A neutral plane just below the floor. It catches the sun's shadow outside
     * the room's footprint, which gives the building visual weight when the
     * camera orbits outside. Slightly recessed to avoid z-fighting.
     *
     * Kept very dark deliberately: a mid-grey plane this large picks up enough
     * light to become the brightest thing on screen and reads as a backdrop
     * rather than as ground, which pulls attention away from the room. */
    this.site = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      materials.createPlainMaterial('#15181d', 1),
    );
    this.site.rotation.x = -Math.PI / 2;
    this.site.position.y = -0.02;
    this.site.receiveShadow = true;
    this.site.name = 'Site';
    this.group.add(this.site);

    /* ---- Walls ---- */
    this.skirtingMaterial = materials.createPlainMaterial('#f8f7f5', 0.7);

    for (const id of WALL_IDS) {
      const interior = materials.createWallMaterial();
      // Exteriors are a flat neutral: the user is designing the inside, and a
      // painted outside would read as a coloured box from the orbit view.
      const exterior = materials.createPlainMaterial('#8d9199', 0.95);

      // BoxGeometry material order is [+X, -X, +Y, -Y, +Z, -Z]. The interior
      // material is slotted into the correct index per wall when built.
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
        exterior, exterior, exterior, exterior, exterior, exterior,
      ]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `Wall_${id}`;

      const skirting = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.skirtingMaterial);
      skirting.castShadow = false;
      skirting.receiveShadow = true;
      skirting.name = `Skirting_${id}`;

      this.group.add(mesh, skirting);
      // `segment` is a placeholder until the first build() call populates it.
      this.walls.set(id, { mesh, interior, exterior, skirting, segment: null as never });
    }
  }

  /** Enables or disables automatic hiding of walls in front of the camera. */
  setAutoHideWalls(enabled: boolean): void {
    this.autoHideWalls = enabled;
  }

  /** The current wall segments, for camera framing and future collision work. */
  getSegments(): readonly WallSegment[] {
    return this.segments;
  }

  /**
   * Brings the meshes in line with a room model.
   *
   * Safe to call on every state change — geometry is only rebuilt when a
   * dimension actually changed.
   */
  update(room: RoomModel): void {
    const dimensionKey = `${room.width}|${room.depth}|${room.height}|${room.wallThickness}`;
    if (dimensionKey !== this.builtDimensions) {
      this.rebuildGeometry(room);
      this.builtDimensions = dimensionKey;
    }
    this.applyAppearance(room);
  }

  /** Replaces every geometry to match new dimensions, disposing the old ones. */
  private rebuildGeometry(room: RoomModel): void {
    this.segments = computeWallSegments(room);

    replaceGeometry(this.floor, new THREE.PlaneGeometry(room.width, room.depth));

    replaceGeometry(this.ceiling, new THREE.PlaneGeometry(room.width, room.depth));
    this.ceiling.position.y = room.height;

    for (const segment of this.segments) {
      const parts = this.walls.get(segment.id);
      if (!parts) continue;
      parts.segment = segment;

      replaceGeometry(
        parts.mesh,
        new THREE.BoxGeometry(segment.size.x, segment.size.y, segment.size.z),
      );
      parts.mesh.position.set(segment.center.x, segment.center.y, segment.center.z);

      // Re-slot the materials so the interior material lands on the face that
      // looks into the room for this particular wall.
      const faces: THREE.Material[] = new Array(6).fill(parts.exterior);
      faces[segment.interiorFaceIndex] = parts.interior;
      parts.mesh.material = faces;

      this.buildSkirting(parts, segment, room);
    }
  }

  /** Positions a wall's skirting board flush against its interior face. */
  private buildSkirting(parts: WallParts, segment: WallSegment, room: RoomModel): void {
    // The board runs the length of the wall and protrudes into the room.
    const runsAlongX = segment.interiorNormal.x === 0;
    const length = runsAlongX ? room.width : room.depth;

    replaceGeometry(
      parts.skirting,
      new THREE.BoxGeometry(
        runsAlongX ? length : SKIRTING_DEPTH,
        SKIRTING_HEIGHT,
        runsAlongX ? SKIRTING_DEPTH : length,
      ),
    );

    // Sit it on the floor, offset inwards by half its depth from the wall face.
    const inset = SKIRTING_DEPTH / 2;
    parts.skirting.position.set(
      segment.interiorPoint.x + segment.interiorNormal.x * inset,
      SKIRTING_HEIGHT / 2,
      segment.interiorPoint.z + segment.interiorNormal.z * inset,
    );
  }

  /** Applies colours, finishes and the floor preset. No geometry work. */
  private applyAppearance(room: RoomModel): void {
    this.materials.applyFloorSpec(this.floorMaterial, room.floor, room.width, room.depth);

    this.ceilingMaterial.color.set(room.ceiling.color);
    this.ceiling.visible = room.ceiling.visible;

    for (const segment of this.segments) {
      const parts = this.walls.get(segment.id);
      if (!parts) continue;

      const spec = room.walls[segment.id];
      this.materials.applyWallSpec(parts.interior, spec, segment.faceWidth, room.height);
    }
  }

  /**
   * Per-frame update: hides walls standing between the camera and the interior.
   *
   * Without this, orbiting around a closed box shows only its outside. The test
   * is per-wall rather than "nearest two", so it behaves correctly at every
   * angle and automatically shows all four walls once the camera moves inside.
   */
  updateForCamera(camera: THREE.Camera): void {
    const { x, z } = camera.position;

    for (const parts of this.walls.values()) {
      if (!parts.segment) continue;

      const hidden = this.autoHideWalls && isOutsideWall(parts.segment, x, z);
      parts.mesh.visible = !hidden;
      parts.skirting.visible = !hidden;
    }
  }

  /** Releases all geometries and materials owned by this room. */
  dispose(): void {
    disposeGeometry(this.floor);
    disposeGeometry(this.ceiling);
    disposeGeometry(this.site);
    this.floorMaterial.dispose();
    this.ceilingMaterial.dispose();
    this.skirtingMaterial.dispose();
    (this.site.material as THREE.Material).dispose();

    for (const parts of this.walls.values()) {
      disposeGeometry(parts.mesh);
      disposeGeometry(parts.skirting);
      parts.interior.dispose();
      parts.exterior.dispose();
    }
    this.walls.clear();
    this.group.clear();
  }
}

/** Swaps a mesh's geometry, disposing the previous one. */
function replaceGeometry(mesh: THREE.Mesh, geometry: THREE.BufferGeometry): void {
  mesh.geometry.dispose();
  mesh.geometry = geometry;
}

function disposeGeometry(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
}
