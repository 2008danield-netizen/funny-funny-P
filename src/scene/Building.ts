/**
 * Builds and maintains the whole structure: walls, openings, floors, ceilings,
 * skirtings, and the handles used to edit them.
 *
 * PERFORMANCE CONTRACT — inherited from session 1 and still the rule:
 *
 *   Changing a COLOUR or a MATERIAL does not touch geometry. It updates material
 *   properties in place, which is essentially free.
 *
 *   Changing GEOMETRY (moving a vertex, adding a wall, resizing an opening)
 *   rebuilds only what changed, keyed off a structural signature. Meshes and
 *   materials are reused where their owner still exists; anything orphaned is
 *   explicitly disposed. WebGL resources are not garbage-collected, and a plan
 *   can be rebuilt on every frame of a drag, so a leak here exhausts GPU memory
 *   within a minute of editing.
 */

import * as THREE from 'three';

import { MaterialLibrary } from './materials/MaterialLibrary';
import {
  buildCeilingGeometry,
  buildFloorGeometry,
  buildSkirtingGeometry,
} from './floorBuilder';
import {
  findRegions,
  pointInPolygon,
  resolveWalls,
  type Region,
  type WallSegment,
} from './planGraph';
import { WALL_MATERIAL_SLOT, buildOpeningFurniture, buildWallGeometry, wallMatrix } from './wallBuilder';
import { resolveRoomSpec } from '@/state/planOps';
import type { Selection } from '@/state/selection';
import type { FloorVoid, PlanModel, Point2, WallFaceSpec } from '@/state/types';

/** Height of the skirting board, in metres. */
const SKIRTING_HEIGHT = 0.09;
/** How far the skirting stands proud of the wall, in metres. */
const SKIRTING_DEPTH = 0.016;

/** Radius of the draggable corner handles, in metres. */
const HANDLE_RADIUS = 0.11;

/**
 * What a raycast hit.
 *
 * Includes 'furniture' even though this class never produces one: `interpret`
 * is the single place that decodes a mesh's pick metadata, and `Furnishings`
 * tags its pick volumes the same way rather than duplicating the decoder.
 */
export type PickKind = 'wall' | 'vertex' | 'opening' | 'floor' | 'furniture';

export interface PickResult {
  kind: PickKind;
  /** Wall ID, vertex ID, opening ID, or region key depending on `kind`. */
  id: string;
  point: THREE.Vector3;
  /** Set for wall hits: which face of the wall was struck. */
  face?: 'a' | 'b';
}

/**
 * What the user currently has selected.
 *
 * Uses the editor store's own `Selection` type rather than a local copy: the
 * selection can name things this class knows nothing about (furniture, since
 * session 3), and a narrower local type would force every caller to filter.
 */
export type SelectionState = Selection;

interface WallEntry {
  mesh: THREE.Mesh;
  faceA: THREE.MeshStandardMaterial;
  faceB: THREE.MeshStandardMaterial;
  /** Trim material for the top, ends and opening reveals. */
  edges: THREE.MeshStandardMaterial;
  frames: THREE.Mesh | null;
  glass: THREE.Mesh | null;
  leaves: THREE.Mesh | null;
  /** Invisible slabs used to pick individual openings for editing. */
  openingPicks: THREE.Mesh[];
  segment: WallSegment;
}

interface RoomEntry {
  floor: THREE.Mesh;
  floorMaterial: THREE.MeshStandardMaterial;
  ceiling: THREE.Mesh;
  ceilingMaterial: THREE.MeshStandardMaterial;
  skirting: THREE.Mesh | null;
  region: Region;
}

export class Building {
  readonly group = new THREE.Group();

  private materials: MaterialLibrary;

  private walls = new Map<string, WallEntry>();
  private rooms = new Map<string, RoomEntry>();
  private handles = new Map<string, THREE.Mesh>();

  private site: THREE.Mesh;
  private grid: THREE.GridHelper;

  /** Shared materials for parts the user does not paint. */
  private trimMaterial: THREE.MeshStandardMaterial;
  private exteriorMaterial: THREE.MeshStandardMaterial;
  private frameMaterial: THREE.MeshStandardMaterial;
  private glassMaterial: THREE.MeshPhysicalMaterial;
  private handleMaterial: THREE.MeshStandardMaterial;
  private handleActiveMaterial: THREE.MeshStandardMaterial;

  private segments: WallSegment[] = [];
  private regions: Region[] = [];

  /** Structural signature of the geometry currently built. */
  private builtSignature = '';

  /** Openings cut through this level's floor: stairwells and light wells. */
  private holes: readonly FloorVoid[] = [];

  private editMode = false;
  private autoHideWalls = true;
  private selection: SelectionState = { kind: null, id: null };
  private hovered: SelectionState = { kind: null, id: null };

  constructor(materials: MaterialLibrary) {
    this.materials = materials;
    this.group.name = 'Building';

    this.trimMaterial = materials.createPlainMaterial('#f8f7f5', 0.7);
    // Exteriors are a flat neutral: the user is designing the inside, and a
    // painted outside would read as a coloured box from the orbit view.
    this.exteriorMaterial = materials.createPlainMaterial('#8d9199', 0.95);
    this.frameMaterial = materials.createPlainMaterial('#f2f0ec', 0.55);

    // Physical glass rather than a translucent standard material: without
    // transmission, glazing either looks like a solid pane or vanishes entirely.
    // The slight blue tint and low roughness give it a specular sheen, so the
    // pane still catches the light and reads as glass even when what lies
    // beyond it is darker than the room.
    this.glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xd6e6f0,
      roughness: 0.04,
      metalness: 0,
      transmission: 0.88,
      thickness: 0.01,
      ior: 1.52,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
    });

    this.handleMaterial = new THREE.MeshStandardMaterial({
      color: 0xf2f4f8,
      roughness: 0.4,
      metalness: 0,
      // Handles must stay visible through walls, or a corner behind the room
      // cannot be grabbed without orbiting first.
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    this.handleActiveMaterial = this.handleMaterial.clone();
    this.handleActiveMaterial.color.set(0xd8a34a);

    /* ---- Site ground ----
     * A neutral plane just below the floor, catching the sun's shadow outside
     * the building's footprint. Kept very dark deliberately: a mid-grey plane
     * this large picks up enough light to become the brightest thing on screen
     * and reads as a backdrop rather than as ground. */
    this.site = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      materials.createPlainMaterial('#15181d', 1),
    );
    this.site.rotation.x = -Math.PI / 2;
    this.site.position.y = -0.02;
    this.site.receiveShadow = true;
    this.site.name = 'Site';
    this.group.add(this.site);

    /* ---- Editing grid ----
     * Only shown while editing. A metre grid is what makes dragging a wall feel
     * measured rather than approximate, and it is the visual counterpart to the
     * snapping in `EditController`. */
    this.grid = new THREE.GridHelper(80, 80, 0x3a414c, 0x262b33);
    this.grid.position.y = 0.004;
    this.grid.visible = false;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.group.add(this.grid);
  }

  /* ------------------------------ Queries ---------------------------- */

  getRegions(): readonly Region[] {
    return this.regions;
  }

  getSegments(): readonly WallSegment[] {
    return this.segments;
  }

  /** Meshes a pointer ray should be tested against, in priority order. */
  pickTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    // Handles first so a corner always wins over the wall behind it.
    if (this.editMode) targets.push(...this.handles.values());
    for (const entry of this.walls.values()) {
      targets.push(...entry.openingPicks);
      targets.push(entry.mesh);
    }
    for (const entry of this.rooms.values()) targets.push(entry.floor);
    return targets;
  }

  /** Interprets a raycast intersection as a pick. */
  static interpret(intersection: THREE.Intersection): PickResult | null {
    const data = intersection.object.userData as {
      pickKind?: PickKind;
      pickId?: string;
    };
    if (!data.pickKind || !data.pickId) return null;

    const result: PickResult = {
      kind: data.pickKind,
      id: data.pickId,
      point: intersection.point.clone(),
    };

    // For a wall, work out which side was hit from the triangle's own normal.
    if (data.pickKind === 'wall' && intersection.face) {
      const materialIndex = intersection.face.materialIndex;
      if (materialIndex === WALL_MATERIAL_SLOT.faceA) result.face = 'a';
      else if (materialIndex === WALL_MATERIAL_SLOT.faceB) result.face = 'b';
    }
    return result;
  }

  /* ------------------------------ Updating --------------------------- */

  setEditMode(enabled: boolean): void {
    this.editMode = enabled;
    this.grid.visible = enabled;
    for (const handle of this.handles.values()) handle.visible = enabled;
  }

  setAutoHideWalls(enabled: boolean): void {
    this.autoHideWalls = enabled;
  }

  setSelection(selection: SelectionState): void {
    this.selection = selection;
    this.applyHighlights();
  }

  setHover(hover: SelectionState): void {
    this.hovered = hover;
    this.applyHighlights();
  }

  /**
   * Brings the scene in line with a plan.
   *
   * Safe to call on every store change: geometry is only rebuilt when the
   * structural signature changes, so painting a wall skips straight to the
   * material pass.
   */
  /**
   * Brings the meshes in line with a storey.
   *
   * `holes` are openings cut through this level's floor — stairwells and light
   * wells. They join the structural signature because a moved stairwell changes
   * the floor geometry exactly as a moved wall does, and a signature that
   * ignored them would leave a staircase rising into a solid slab.
   */
  update(plan: PlanModel, showCeilings: boolean, holes: readonly FloorVoid[] = []): void {
    const signature = `${structuralSignature(plan)}|${voidSignature(holes)}`;
    if (signature !== this.builtSignature) {
      this.holes = holes;
      this.rebuild(plan);
      this.builtSignature = signature;
    }

    this.applyAppearance(plan, showCeilings);
    this.applyHighlights();
  }

  /** Rebuilds every mesh whose geometry depends on the plan. */
  private rebuild(plan: PlanModel): void {
    this.segments = resolveWalls(plan);
    this.regions = findRegions(plan);

    this.rebuildWalls();
    this.rebuildRooms(plan);
    this.rebuildHandles(plan);
  }

  private rebuildWalls(): void {
    const live = new Set(this.segments.map((segment) => segment.wall.id));

    // Retire walls that no longer exist before building, so their GPU memory is
    // released before the new allocations rather than after.
    for (const [id, entry] of this.walls) {
      if (live.has(id)) continue;
      this.disposeWall(entry);
      this.walls.delete(id);
    }

    for (const segment of this.segments) {
      const existing = this.walls.get(segment.wall.id);
      const entry = existing ?? this.createWall(segment.wall.id);
      entry.segment = segment;

      // Geometry.
      entry.mesh.geometry.dispose();
      entry.mesh.geometry = buildWallGeometry(segment);
      entry.mesh.matrixAutoUpdate = false;
      entry.mesh.matrix.copy(wallMatrix(segment));

      this.rebuildOpenings(entry, segment);
    }
  }

  private createWall(wallId: string): WallEntry {
    const faceA = this.materials.createWallMaterial();
    const faceB = this.materials.createWallMaterial();
    const edges = this.materials.createPlainMaterial('#efece7', 0.85);

    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [faceA, faceB, edges]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `Wall_${wallId}`;
    mesh.userData = { pickKind: 'wall', pickId: wallId };
    this.group.add(mesh);

    const entry: WallEntry = {
      mesh,
      faceA,
      faceB,
      edges,
      frames: null,
      glass: null,
      leaves: null,
      openingPicks: [],
      segment: null as never,
    };
    this.walls.set(wallId, entry);
    return entry;
  }

  /** Rebuilds the frames, glazing, leaves and pick volumes for one wall. */
  private rebuildOpenings(entry: WallEntry, segment: WallSegment): void {
    for (const mesh of [entry.frames, entry.glass, entry.leaves]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    entry.frames = null;
    entry.glass = null;
    entry.leaves = null;

    for (const pick of entry.openingPicks) {
      pick.geometry.dispose();
      this.group.remove(pick);
    }
    entry.openingPicks = [];

    if (segment.wall.openings.length === 0) return;

    const matrix = wallMatrix(segment);
    const frames: THREE.BufferGeometry[] = [];
    const glass: THREE.BufferGeometry[] = [];
    const leaves: THREE.BufferGeometry[] = [];

    for (const opening of segment.wall.openings) {
      const furniture = buildOpeningFurniture(segment, opening);
      if (furniture.frame) frames.push(furniture.frame);
      if (furniture.glass) glass.push(furniture.glass);
      if (furniture.leaf) leaves.push(furniture.leaf);

      // An invisible slab filling the aperture, so clicking a doorway selects
      // the door rather than falling through to whatever is behind it.
      const pick = new THREE.Mesh(
        new THREE.BoxGeometry(opening.width, opening.height, segment.wall.thickness * 1.2),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      pick.position.set(
        opening.offset,
        opening.sillHeight + opening.height / 2,
        segment.wall.thickness / 2,
      );
      pick.applyMatrix4(matrix);
      pick.userData = { pickKind: 'opening', pickId: opening.id };
      pick.name = `OpeningPick_${opening.id}`;
      this.group.add(pick);
      entry.openingPicks.push(pick);
    }

    entry.frames = this.addMergedMesh(frames, this.frameMaterial, matrix, `Frames_${segment.wall.id}`, true);
    entry.glass = this.addMergedMesh(glass, this.glassMaterial, matrix, `Glass_${segment.wall.id}`, false);
    entry.leaves = this.addMergedMesh(leaves, this.frameMaterial, matrix, `Leaves_${segment.wall.id}`, true);
  }

  /** Merges geometries into one mesh and adds it to the scene. */
  private addMergedMesh(
    geometries: THREE.BufferGeometry[],
    material: THREE.Material,
    matrix: THREE.Matrix4,
    name: string,
    castShadow: boolean,
  ): THREE.Mesh | null {
    if (geometries.length === 0) return null;

    // Bake each piece into one buffer by applying the shared matrix on the mesh
    // rather than per geometry, so the pieces stay in wall-local space.
    const merged = concatenate(geometries);
    if (!merged) return null;

    const mesh = new THREE.Mesh(merged, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }


  /**
   * The openings that belong to one room's floor.
   *
   * Matched by containment of the hole's own centre, because a hole is cut into
   * the room it sits in. See `buildFloorGeometry` for why a hole straddling two
   * rooms is not split between them.
   */
  private holesIn(region: Region): Point2[][] {
    const mine: Point2[][] = [];
    for (const hole of this.holes) {
      if (hole.polygon.length < 3) continue;
      let cx = 0;
      let cz = 0;
      for (const point of hole.polygon) {
        cx += point.x;
        cz += point.z;
      }
      const centre = { x: cx / hole.polygon.length, z: cz / hole.polygon.length };
      if (pointInPolygon(centre, region.polygon)) mine.push(hole.polygon);
    }
    return mine;
  }

  private rebuildRooms(plan: PlanModel): void {
    const live = new Set(this.regions.map((region) => region.key));

    for (const [key, entry] of this.rooms) {
      if (live.has(key)) continue;
      this.disposeRoom(entry);
      this.rooms.delete(key);
    }

    for (const region of this.regions) {
      const existing = this.rooms.get(region.key);
      const entry = existing ?? this.createRoom(region.key);
      entry.region = region;

      entry.floor.geometry.dispose();
      entry.floor.geometry = buildFloorGeometry(region.polygon, this.holesIn(region));

      // A room's ceiling sits at the height of its own walls, so a plan mixing a
      // 2.4 m bedroom with a 3.2 m living room reads correctly.
      const height = regionHeight(plan, region);
      entry.ceiling.geometry.dispose();
      entry.ceiling.geometry = buildCeilingGeometry(region.polygon, height, this.holesIn(region));

      if (entry.skirting) {
        entry.skirting.geometry.dispose();
        this.group.remove(entry.skirting);
        entry.skirting = null;
      }
      const skirtingGeometry = buildSkirtingGeometry(
        region.polygon,
        SKIRTING_HEIGHT,
        SKIRTING_DEPTH,
      );
      if (skirtingGeometry) {
        const mesh = new THREE.Mesh(skirtingGeometry, this.trimMaterial);
        mesh.receiveShadow = true;
        mesh.name = `Skirting_${region.key}`;
        this.group.add(mesh);
        entry.skirting = mesh;
      }
    }
  }

  private createRoom(key: string): RoomEntry {
    const floorMaterial = this.materials.createFloorMaterial();
    const floor = new THREE.Mesh(new THREE.BufferGeometry(), floorMaterial);
    floor.receiveShadow = true;
    floor.name = `Floor_${key}`;
    floor.userData = { pickKind: 'floor', pickId: key };
    this.group.add(floor);

    const ceilingMaterial = this.materials.createPlainMaterial('#f7f5f2', 0.97);
    const ceiling = new THREE.Mesh(new THREE.BufferGeometry(), ceilingMaterial);
    ceiling.receiveShadow = true;
    ceiling.name = `Ceiling_${key}`;
    this.group.add(ceiling);

    const entry: RoomEntry = {
      floor,
      floorMaterial,
      ceiling,
      ceilingMaterial,
      skirting: null,
      region: null as never,
    };
    this.rooms.set(key, entry);
    return entry;
  }

  private rebuildHandles(plan: PlanModel): void {
    const live = new Set(plan.vertices.map((vertex) => vertex.id));

    for (const [id, handle] of this.handles) {
      if (live.has(id)) continue;
      handle.geometry.dispose();
      this.group.remove(handle);
      this.handles.delete(id);
    }

    for (const vertex of plan.vertices) {
      let handle = this.handles.get(vertex.id);
      if (!handle) {
        handle = new THREE.Mesh(
          new THREE.SphereGeometry(HANDLE_RADIUS, 16, 12),
          this.handleMaterial,
        );
        handle.name = `Handle_${vertex.id}`;
        handle.userData = { pickKind: 'vertex', pickId: vertex.id };
        // Drawn last and without depth testing so handles never disappear
        // inside the geometry they control.
        handle.renderOrder = 10;
        handle.visible = this.editMode;
        this.group.add(handle);
        this.handles.set(vertex.id, handle);
      }
      // Lifted to roughly knee height: at floor level a handle is hidden by the
      // floor itself from any low camera angle.
      handle.position.set(vertex.x, 0.5, vertex.z);
    }
  }

  /* ----------------------------- Appearance -------------------------- */

  /** Applies colours and materials. Never touches geometry. */
  private applyAppearance(plan: PlanModel, showCeilings: boolean): void {
    // Which region, if any, looks at each side of each wall.
    const facing = new Map<string, { a?: Region; b?: Region }>();
    for (const region of this.regions) {
      for (const [wallId, side] of Object.entries(region.facing)) {
        const entry = facing.get(wallId) ?? {};
        entry[side] = region;
        facing.set(wallId, entry);
      }
    }

    for (const [wallId, entry] of this.walls) {
      const sides = facing.get(wallId) ?? {};
      const wall = entry.segment.wall;

      this.paintWallFace(entry.faceA, wall.faces.a, sides.a, plan);
      this.paintWallFace(entry.faceB, wall.faces.b, sides.b, plan);

      // The top of a wall and the reveals inside its openings take the trim
      // colour rather than either room's paint, matching how a real reveal is
      // finished and avoiding an arbitrary choice between two rooms.
      entry.edges.color.set('#efece7');
    }

    for (const entry of this.rooms.values()) {
      const spec = resolveRoomSpec(plan, entry.region.key);
      this.materials.applyFloorSpec(entry.floorMaterial, spec.floor);
      entry.ceilingMaterial.color.set(spec.ceilingColor);
      entry.ceiling.visible = showCeilings;
    }
  }

  /**
   * Paints one face of a wall.
   *
   * Precedence: an explicit per-face override wins (that is what makes an accent
   * wall), otherwise the face inherits the paint of the room it looks into,
   * otherwise — for an outside face with no room behind it — the neutral
   * exterior colour.
   */
  private paintWallFace(
    material: THREE.MeshStandardMaterial,
    override: WallFaceSpec | undefined,
    region: Region | undefined,
    plan: PlanModel,
  ): void {
    if (override) {
      this.materials.applyWallSpec(material, override);
      return;
    }
    if (region) {
      this.materials.applyWallSpec(material, resolveRoomSpec(plan, region.key).wall);
      return;
    }
    this.materials.applyWallSpec(material, {
      color: `#${this.exteriorMaterial.color.getHexString()}`,
      roughness: 0.95,
    });
  }

  /** Applies selection and hover tinting via material emissive. */
  private applyHighlights(): void {
    const selected = this.selection;
    const hovered = this.hovered;

    const emissiveFor = (kind: PickKind, id: string): number => {
      if (selected.kind === kind && selected.id === id) return 0.32;
      if (hovered.kind === kind && hovered.id === id) return 0.13;
      return 0;
    };

    for (const [wallId, entry] of this.walls) {
      const strength = emissiveFor('wall', wallId);
      for (const material of [entry.faceA, entry.faceB, entry.edges]) {
        material.emissive.setHex(0xd8a34a);
        material.emissiveIntensity = strength;
      }
    }

    for (const [key, entry] of this.rooms) {
      const strength = emissiveFor('floor', key);
      entry.floorMaterial.emissive.setHex(0xd8a34a);
      entry.floorMaterial.emissiveIntensity = strength;
    }

    for (const [vertexId, handle] of this.handles) {
      const active =
        (selected.kind === 'vertex' && selected.id === vertexId) ||
        (hovered.kind === 'vertex' && hovered.id === vertexId);
      handle.material = active ? this.handleActiveMaterial : this.handleMaterial;
      handle.scale.setScalar(active ? 1.35 : 1);
    }

    for (const entry of this.walls.values()) {
      const openingIds = entry.segment.wall.openings.map((opening) => opening.id);
      const active = openingIds.some(
        (id) =>
          (selected.kind === 'opening' && selected.id === id) ||
          (hovered.kind === 'opening' && hovered.id === id),
      );
      if (entry.frames) {
        const material = entry.frames.material as THREE.MeshStandardMaterial;
        material.emissive.setHex(0xd8a34a);
        material.emissiveIntensity = active ? 0.25 : 0;
      }
    }
  }

  /**
   * Per-frame update: hides walls that stand between the camera and the interior.
   *
   * Rule, in two parts:
   *   • If the camera is inside any room (tested in plan, ignoring height), show
   *     everything — you are indoors and want the walls around you. This also
   *     covers the top-down Plan viewpoint, whose camera sits above the middle
   *     of the building.
   *   • Otherwise hide only EXTERIOR walls whose blank outside face is towards
   *     the camera. Interior partitions stay visible, because they are what makes
   *     a multi-room plan legible from outside.
   */
  updateForCamera(camera: THREE.Camera): void {
    const position = { x: camera.position.x, z: camera.position.z };

    const inside =
      !this.autoHideWalls ||
      this.regions.some((region) => pointInPolygon(position, region.polygon));

    for (const entry of this.walls.values()) {
      let visible = true;

      if (!inside) {
        const segment = entry.segment;
        const toCamera = {
          x: position.x - segment.center.x,
          z: position.z - segment.center.z,
        };
        const onSideA = toCamera.x * segment.normal.x + toCamera.z * segment.normal.z >= 0;

        const sides = this.sidesWithRooms(segment.wall.id);
        const cameraSideHasRoom = onSideA ? sides.a : sides.b;
        const otherSideHasRoom = onSideA ? sides.b : sides.a;

        // Hide only when looking at a blank outside face with a room behind it.
        visible = cameraSideHasRoom || !otherSideHasRoom;
      }

      entry.mesh.visible = visible;
      if (entry.frames) entry.frames.visible = visible;
      if (entry.glass) entry.glass.visible = visible;
      if (entry.leaves) entry.leaves.visible = visible;
    }
  }

  private sidesWithRooms(wallId: string): { a: boolean; b: boolean } {
    let a = false;
    let b = false;
    for (const region of this.regions) {
      const side = region.facing[wallId];
      if (side === 'a') a = true;
      if (side === 'b') b = true;
    }
    return { a, b };
  }

  /* ------------------------------ Teardown --------------------------- */

  private disposeWall(entry: WallEntry): void {
    entry.mesh.geometry.dispose();
    this.group.remove(entry.mesh);
    entry.faceA.dispose();
    entry.faceB.dispose();
    entry.edges.dispose();

    for (const mesh of [entry.frames, entry.glass, entry.leaves]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    for (const pick of entry.openingPicks) {
      pick.geometry.dispose();
      (pick.material as THREE.Material).dispose();
      this.group.remove(pick);
    }
  }

  private disposeRoom(entry: RoomEntry): void {
    entry.floor.geometry.dispose();
    entry.floorMaterial.dispose();
    this.group.remove(entry.floor);

    entry.ceiling.geometry.dispose();
    entry.ceilingMaterial.dispose();
    this.group.remove(entry.ceiling);

    if (entry.skirting) {
      entry.skirting.geometry.dispose();
      this.group.remove(entry.skirting);
    }
  }

  dispose(): void {
    for (const entry of this.walls.values()) this.disposeWall(entry);
    this.walls.clear();

    for (const entry of this.rooms.values()) this.disposeRoom(entry);
    this.rooms.clear();

    for (const handle of this.handles.values()) handle.geometry.dispose();
    this.handles.clear();

    this.site.geometry.dispose();
    (this.site.material as THREE.Material).dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();

    this.trimMaterial.dispose();
    this.exteriorMaterial.dispose();
    this.frameMaterial.dispose();
    this.glassMaterial.dispose();
    this.handleMaterial.dispose();
    this.handleActiveMaterial.dispose();

    this.group.clear();
  }
}

/* -------------------------------- Helpers ------------------------------ */

/**
 * A signature of everything geometry depends on.
 *
 * Colours are deliberately excluded, which is what keeps painting free. Vertex
 * positions are rounded to a tenth of a millimetre so that floating-point noise
 * cannot trigger a rebuild on a frame where nothing visibly moved.
 */
function structuralSignature(plan: PlanModel): string {
  const parts: string[] = [];

  for (const vertex of plan.vertices) {
    parts.push(`${vertex.id}:${vertex.x.toFixed(4)},${vertex.z.toFixed(4)}`);
  }
  for (const wall of plan.walls) {
    parts.push(
      `${wall.id}:${wall.start}>${wall.end}:${wall.thickness.toFixed(3)}:${wall.height.toFixed(3)}`,
    );
    for (const opening of wall.openings) {
      parts.push(
        `${opening.id}:${opening.presetId}:${opening.offset.toFixed(3)}:` +
          `${opening.width.toFixed(3)}:${opening.height.toFixed(3)}:` +
          `${opening.sillHeight.toFixed(3)}:${opening.hinge}:${opening.swing}`,
      );
    }
  }
  return parts.join('|');
}

/** The ceiling height for a region: the tallest wall enclosing it. */
function regionHeight(plan: PlanModel, region: Region): number {
  const byId = new Map(plan.walls.map((wall) => [wall.id, wall]));
  let height = 0;
  for (const wallId of region.wallIds) {
    const wall = byId.get(wallId);
    if (wall) height = Math.max(height, wall.height);
  }
  return height > 0 ? height : plan.defaultWallHeight;
}

/**
 * Concatenates non-indexed geometries sharing an attribute layout.
 *
 * The inputs come from `wallBuilder`, which already returns non-indexed buffers,
 * so this is a straight copy. Inputs are disposed since they are throwaway.
 */
function concatenate(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0]!;

  const flattened = geometries.map((geometry) => {
    if (!geometry.index) return geometry;
    const nonIndexed = geometry.toNonIndexed();
    geometry.dispose();
    return nonIndexed;
  });

  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const first = flattened[0]!.getAttribute(name);
    if (!first) continue;

    let total = 0;
    for (const geometry of flattened) total += geometry.getAttribute(name)?.count ?? 0;

    const array = new Float32Array(total * first.itemSize);
    let offset = 0;
    for (const geometry of flattened) {
      const attribute = geometry.getAttribute(name);
      if (!attribute) continue;
      array.set(attribute.array as Float32Array, offset);
      offset += attribute.count * first.itemSize;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, first.itemSize));
  }

  for (const geometry of flattened) geometry.dispose();
  return merged;
}

/**
 * Signature of the floor openings, so a moved stairwell rebuilds the floor.
 *
 * Rounded to the millimetre for the same reason the plan's signature is:
 * floating-point noise from a drag would otherwise rebuild every floor mesh on
 * every frame.
 */
function voidSignature(holes: readonly FloorVoid[]): string {
  return holes
    .map(
      (hole) =>
        `${hole.id}:` +
        hole.polygon.map((point) => `${point.x.toFixed(3)},${point.z.toFixed(3)}`).join(';'),
    )
    .join('|');
}
