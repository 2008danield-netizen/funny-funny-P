/**
 * The furniture in the scene.
 *
 * Kept separate from `Building` because the two change on completely different
 * schedules: reshaping a wall rebuilds the building but not a single sofa, and
 * dragging a sofa across the room rebuilds nothing at all — it moves a matrix.
 * Folding them together would mean every furniture nudge re-extruded the walls.
 *
 * PERFORMANCE
 *   • GEOMETRY IS CACHED BY SHAPE, not by item. Twenty INGOLF chairs share one
 *     set of buffers; only their transforms differ. That is what keeps a fully
 *     furnished flat cheap.
 *   • Each piece is merged down to one mesh PER MATERIAL ROLE. A sofa is around
 *     twenty boxes and costs two draw calls.
 *   • Moving a piece writes a matrix. Nothing is rebuilt, nothing is allocated.
 */

import * as THREE from 'three';

import { buildFurniture, type FurniturePart, type MaterialRole } from '@/furniture/builders';
import {
  getCatalogEntry,
  resolveColorway,
  type CatalogEntry,
  type Colorway,
} from '@/furniture/catalog';
import { itemDimensions } from '@/physics/colliders';
import type { FurnitureItem } from '@/state/types';

/** Geometry for one shape, merged per material role. */
interface ShapeGeometry {
  byRole: Map<MaterialRole, THREE.BufferGeometry>;
}

/** Everything on screen for one placed item. */
interface ItemEntry {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  materials: THREE.Material[];
  /** The cache key the geometry was built from, so a resize can rebuild it. */
  shapeKey: string;
  /** Invisible box used for picking, sized to the piece's full bounds. */
  pick: THREE.Mesh;
}

export interface FurnitureSelection {
  selectedId: string | null;
  hoveredId: string | null;
  /** Items currently overlapping something, drawn with a warning tint. */
  collidingIds: ReadonlySet<string>;
}

export class Furnishings {
  readonly group = new THREE.Group();

  /**
   * Geometry cache, keyed by catalogue ID plus dimensions.
   *
   * Dimensions are part of the key because a resizable table genuinely changes
   * shape; everything else has one entry for the lifetime of the page.
   */
  private shapes = new Map<string, ShapeGeometry>();

  private items = new Map<string, ItemEntry>();

  /** Shared pick material — invisible, but still raycastable. */
  private pickMaterial = new THREE.MeshBasicMaterial({ visible: false });

  private selection: FurnitureSelection = {
    selectedId: null,
    hoveredId: null,
    collidingIds: new Set(),
  };

  constructor() {
    this.group.name = 'Furnishings';
  }

  /** Meshes a pointer ray should be tested against. */
  pickTargets(): THREE.Object3D[] {
    return [...this.items.values()].map((entry) => entry.pick);
  }

  /** Brings the scene in line with the document's furniture list. */
  update(furniture: readonly FurnitureItem[]): void {
    const live = new Set(furniture.map((item) => item.id));

    for (const [id, entry] of this.items) {
      if (live.has(id)) continue;
      this.disposeItem(entry);
      this.items.delete(id);
    }

    for (const item of furniture) {
      const entry = getCatalogEntry(item.catalogId);
      const dimensions = itemDimensions(item);
      const shapeKey = `${item.catalogId}|${dimensions.width.toFixed(3)}|${dimensions.depth.toFixed(3)}|${dimensions.height.toFixed(3)}`;

      let existing = this.items.get(item.id);

      // A changed shape key means the geometry no longer matches (a resize, or
      // the catalogue entry swapped), so the meshes are rebuilt from scratch.
      if (existing && existing.shapeKey !== shapeKey) {
        this.disposeItem(existing);
        this.items.delete(item.id);
        existing = undefined;
      }

      const target = existing ?? this.createItem(item, entry, shapeKey);

      // The whole of moving a piece: write a transform.
      target.group.position.set(item.x, item.y, item.z);
      target.group.rotation.y = item.rotation;

      // The pick box is centred on the piece's mid-height, whereas the group's
      // origin sits on the floor, so its Y is offset rather than copied.
      target.pick.position.set(item.x, item.y + dimensions.height / 2, item.z);
      target.pick.rotation.y = item.rotation;

      this.applyColorway(target, resolveColorway(entry, item.colorwayId));
    }

    this.applyHighlights();
  }

  private createItem(
    item: FurnitureItem,
    entry: CatalogEntry,
    shapeKey: string,
  ): ItemEntry {
    const dimensions = itemDimensions(item);
    const shape = this.getShape(shapeKey, entry, dimensions);

    const group = new THREE.Group();
    group.name = `Furniture_${item.id}`;

    const meshes: THREE.Mesh[] = [];
    const materials: THREE.Material[] = [];

    for (const [role, geometry] of shape.byRole) {
      const material = createRoleMaterial(role);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = role !== 'glass';
      mesh.receiveShadow = true;
      mesh.name = `${item.id}_${role}`;
      // Geometry is shared between items, so this mesh must never mutate it.
      group.add(mesh);
      meshes.push(mesh);
      materials.push(material);
    }

    this.group.add(group);

    /*
     * A single invisible box for picking.
     *
     * Raycasting the real geometry would mean a chair's back and legs both
     * count as hits while the empty space between them does not, so clicking
     * "on" a chair would miss about half the time. A bounding box is what the
     * user is actually pointing at.
     */
    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(dimensions.width, dimensions.height, dimensions.depth),
      this.pickMaterial,
    );
    pick.position.set(item.x, item.y + dimensions.height / 2, item.z);
    pick.userData = { pickKind: 'furniture', pickId: item.id };
    pick.name = `FurniturePick_${item.id}`;
    this.group.add(pick);

    const created: ItemEntry = { group, meshes, materials, shapeKey, pick };
    this.items.set(item.id, created);
    return created;
  }

  /** Builds (or returns cached) merged geometry for one shape. */
  private getShape(
    key: string,
    entry: CatalogEntry,
    dimensions: { width: number; depth: number; height: number },
  ): ShapeGeometry {
    const cached = this.shapes.get(key);
    if (cached) return cached;

    const parts = buildFurniture(entry.build, dimensions);
    const byRole = mergeByRole(parts);
    const shape: ShapeGeometry = { byRole };
    this.shapes.set(key, shape);
    return shape;
  }

  /** Applies a colourway's colours to an item's materials. */
  private applyColorway(entry: ItemEntry, colorway: Colorway): void {
    for (const mesh of entry.meshes) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      const role = mesh.name.split('_').pop() as MaterialRole;
      material.color.set(colorForRole(role, colorway));
    }
  }

  setSelection(selection: FurnitureSelection): void {
    this.selection = selection;
    this.applyHighlights();
  }

  /**
   * Tints selected, hovered and colliding pieces.
   *
   * Collision uses a red emissive rather than a wireframe or an outline because
   * it has to read at a glance while the piece is being dragged, and because it
   * must not change the silhouette — the user is judging whether the piece fits.
   */
  private applyHighlights(): void {
    for (const [id, entry] of this.items) {
      const colliding = this.selection.collidingIds.has(id);
      const selected = this.selection.selectedId === id;
      const hovered = this.selection.hoveredId === id;

      const colour = colliding ? 0xd8483f : 0xd8a34a;
      const intensity = colliding ? 0.4 : selected ? 0.28 : hovered ? 0.12 : 0;

      for (const material of entry.materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if (!standard.emissive) continue;
        standard.emissive.setHex(colour);
        standard.emissiveIntensity = intensity;
      }
    }
  }

  private disposeItem(entry: ItemEntry): void {
    // Geometry is shared via the cache and deliberately NOT disposed here —
    // freeing it would corrupt every other item using the same shape. The cache
    // owns it and releases it in `dispose()`.
    this.group.remove(entry.group);
    for (const material of entry.materials) material.dispose();

    entry.pick.geometry.dispose();
    this.group.remove(entry.pick);
  }

  dispose(): void {
    for (const entry of this.items.values()) this.disposeItem(entry);
    this.items.clear();

    for (const shape of this.shapes.values()) {
      for (const geometry of shape.byRole.values()) geometry.dispose();
    }
    this.shapes.clear();

    this.pickMaterial.dispose();
    this.group.clear();
  }
}

/* -------------------------------- Materials ---------------------------- */

function createRoleMaterial(role: MaterialRole): THREE.Material {
  switch (role) {
    case 'glass':
      return new THREE.MeshPhysicalMaterial({
        color: 0xd6e6f0,
        roughness: 0.05,
        metalness: 0,
        transmission: 0.9,
        thickness: 0.01,
        transparent: true,
        opacity: 0.45,
      });
    case 'accent':
      // Metal fittings: legs, handles, castors, steel underframes.
      return new THREE.MeshStandardMaterial({ color: 0x8d8d8d, roughness: 0.42, metalness: 0.75 });
    case 'soft':
      // Fabric has no specular lobe worth speaking of; any gloss reads plastic.
      return new THREE.MeshStandardMaterial({ color: 0xd7cdba, roughness: 0.96, metalness: 0 });
    case 'shade':
      // Lampshades are lit from within, so a little emission keeps them from
      // going dead grey in a dim room.
      return new THREE.MeshStandardMaterial({
        color: 0xf2ede2,
        roughness: 0.85,
        metalness: 0,
        side: THREE.DoubleSide,
        emissive: 0xffe9c4,
        emissiveIntensity: 0.25,
      });
    case 'frame':
    default:
      return new THREE.MeshStandardMaterial({ color: 0xc49a63, roughness: 0.55, metalness: 0 });
  }
}

function colorForRole(role: MaterialRole, colorway: Colorway): string {
  switch (role) {
    case 'soft':
      return colorway.soft;
    case 'accent':
      return colorway.accent;
    case 'glass':
      return '#d6e6f0';
    case 'shade':
      return '#f2ede2';
    case 'frame':
    default:
      return colorway.frame;
  }
}

/* --------------------------------- Merging ------------------------------ */

/**
 * Merges parts into one geometry per material role.
 *
 * All the builders' output is BoxGeometry, CylinderGeometry or ExtrudeGeometry,
 * which are indexed except for the extrusions — so everything is de-indexed
 * first. Copying an indexed geometry's raw attributes and dropping the index
 * scrambles every face, which is a bug that looks like corrupted furniture.
 */
function mergeByRole(parts: FurniturePart[]): Map<MaterialRole, THREE.BufferGeometry> {
  const grouped = new Map<MaterialRole, THREE.BufferGeometry[]>();

  for (const part of parts) {
    const flat = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    if (flat !== part.geometry) part.geometry.dispose();

    // Normals must exist and be correct before the merge, since the merged
    // buffer has no way to recompute them per source geometry afterwards.
    if (!flat.getAttribute('normal')) flat.computeVertexNormals();

    const list = grouped.get(part.role) ?? [];
    list.push(flat);
    grouped.set(part.role, list);
  }

  const merged = new Map<MaterialRole, THREE.BufferGeometry>();
  for (const [role, geometries] of grouped) {
    const result = concatenate(geometries);
    if (result) merged.set(role, result);
  }
  return merged;
}

/** Concatenates non-indexed geometries sharing an attribute layout. */
function concatenate(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0]!;

  const merged = new THREE.BufferGeometry();

  for (const name of ['position', 'normal', 'uv'] as const) {
    const first = geometries[0]!.getAttribute(name);
    if (!first) continue;

    let total = 0;
    for (const geometry of geometries) total += geometry.getAttribute(name)?.count ?? 0;

    const array = new Float32Array(total * first.itemSize);
    let offset = 0;
    for (const geometry of geometries) {
      const attribute = geometry.getAttribute(name);
      if (!attribute) continue;
      array.set(attribute.array as Float32Array, offset);
      offset += attribute.count * first.itemSize;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, first.itemSize));
  }

  for (const geometry of geometries) geometry.dispose();
  return merged;
}
