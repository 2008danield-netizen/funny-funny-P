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

import { chamferedBox } from './millwork';

import { buildFurniture, type FurniturePart, type MaterialRole } from '@/furniture/builders';
import { clutterFor } from '@/furniture/clutter';
import { generateWeave } from '@/scene/materials/generators';
import { createCanvas, heightToNormalMap } from '@/scene/materials/textureUtils';
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
      /*
       * The item's own id is part of the key, and it costs the shape cache.
       *
       * The cache exists so that ten identical dining chairs share one merged
       * geometry, and clutter seeded per item breaks that — two bookcases with
       * the same books on the same shelves would be a catalogue photograph, so
       * the variety is worth having. It costs less than it looks: clutter goes
       * only on tables, desks, shelving, cabinets and beds, and nobody has ten
       * identical chests of drawers. The pieces there are genuinely ten of —
       * chairs — carry nothing and still share.
       */
      const shapeKey =
        `${item.catalogId}|${dimensions.width.toFixed(3)}|` +
        `${dimensions.depth.toFixed(3)}|${dimensions.height.toFixed(3)}|${item.id}`;

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

      /*
       * FURNITURE RECEIVES THE LIGHTING BAKE, AND USED NOT TO.
       *
       * The bake picked its surfaces by name — walls, floors, ceilings, trim,
       * joinery — and furniture matched none of them. So a sofa blocked light
       * for everything around it and received none itself: no sky visibility,
       * no bounced colour, nothing. Everything shading it came from the
       * screen-space occlusion pass alone, which is a blunt instrument at that
       * scale, and the result was upholstery that looked inflated and plastic
       * while the wall behind it looked right.
       *
       * Marked rather than matched on a name, because this is the file that
       * knows these meshes are solid furniture. Glass is left out: a
       * transparent pane has no sensible per-vertex ambient and would be given
       * the shading of whatever is behind it.
       *
       * Safe only because each item now has its own geometry — the shape cache
       * is keyed by item id since the clutter work — so a bake written into it
       * belongs to one piece standing in one place. It would be wrong the
       * moment two sofas shared a buffer.
       */
      if (role !== 'glass') mesh.userData.bakeReceiver = true;
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
      chamferedBox(dimensions.width, dimensions.height, dimensions.depth),
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

    /*
     * The clutter is merged in with the piece rather than added beside it.
     *
     * Everything downstream — the role materials, the colourway, the sky bake,
     * the single pick box — already works on a list of parts, so a mug that
     * arrives as one more part needs no new plumbing at all. Adding it as a
     * separate object would have meant teaching four other things it exists.
     */
    const parts = [
      ...buildFurniture(entry.build, dimensions),
      ...clutterFor(entry.build, dimensions, key),
    ];
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

/**
 * The woven surface every upholstered thing shares.
 *
 * Built once, lazily, and handed to every `soft` material in the building. One
 * set of maps for all of it, because a weave is a weave — the colour differs
 * per colourway and that comes from `material.color`, which multiplies these.
 *
 * Lazy because generating it is a second of pixel arithmetic and a plan with no
 * sofas in it should not pay for one.
 */
let weaveMaps: { normal: THREE.Texture; roughness: THREE.Texture } | null = null;

/** How much of a sofa one tile of weave covers, in metres. */
const WEAVE_TILE = 0.35;

function weave(): { normal: THREE.Texture; roughness: THREE.Texture } {
  if (weaveMaps) return weaveMaps;

  const maps = generateWeave(512, {
    baseColor: '#ffffff',
    coarseness: 0.8,
    seed: 4471,
    tileMetres: WEAVE_TILE,
  });

  const paint = (image: ImageData, colorSpace: THREE.ColorSpace): THREE.Texture => {
    const { canvas, ctx } = createCanvas(image.width);
    ctx.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    /*
     * Repeat in tiles, not in metres.
     *
     * Furniture UVs are the ones `ExtrudeGeometry` and `BoxGeometry` produce —
     * normalised across each face, not measured in world space the way the
     * floors are. So the repeat has to be a count rather than the inverse of a
     * tile size, and it is approximate: a cushion face is roughly half a metre,
     * so one and a half tiles across it puts the threads at about the right
     * size on the parts anybody looks at closely.
     */
    texture.repeat.set(1.5, 1.5);
    // The weave is fine enough that a sharp minification filter aliases into
    // moiré the moment the camera moves. Mipmaps and anisotropy are what stop
    // that, and they are the default here only because the canvas is a power of
    // two — worth knowing if the size above ever changes.
    texture.anisotropy = 4;
    return texture;
  };

  weaveMaps = {
    normal: paint(heightToNormalMap(maps.height, maps.normalStrength), THREE.NoColorSpace),
    roughness: paint(maps.roughness, THREE.NoColorSpace),
  };
  return weaveMaps;
}

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
    case 'soft': {
      /*
       * Fabric, and the reason it needs maps rather than a number.
       *
       * A single roughness value is a perfectly smooth surface, and a perfectly
       * smooth surface returns light the way moulded plastic does — one broad
       * even sheen. That is exactly what a sofa here looked like. A weave is
       * thousands of little cylinders crossing each other, and what that does
       * to light is the whole reason a cushion reads as cloth: the sheen breaks
       * into a fine grain and changes as the cloth turns.
       *
       * Far too fine to be geometry — a thread is under a millimetre — so it
       * lives where fine surface detail belongs, in a normal and a roughness
       * map. See `generateWeave`.
       */
      const maps = weave();
      return new THREE.MeshStandardMaterial({
        color: 0xd7cdba,
        roughness: 0.96,
        metalness: 0,
        normalMap: maps.normal,
        // Gentle: the bumps are a fraction of a millimetre and a strong normal
        // map at this frequency reads as crocodile skin.
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: maps.roughness,
      });
    }
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
    case 'clutter':
      /*
       * Paper, ceramic and glazed pottery. A single warm off-white for all of
       * it, which is the honest limitation here: every book in the building is
       * the same colour, because the merge carries no per-part colour. Vertex
       * colours through `concatenate` are the obvious next step and would give
       * a shelf the variety a real one has.
       */
      return new THREE.MeshStandardMaterial({ color: 0xcfc4b4, roughness: 0.72, metalness: 0 });
    case 'foliage':
      // Leaves, and a little translucency so a leaf with light behind it is not
      // a black shape — which is most of what separates a plant from a prop.
      return new THREE.MeshStandardMaterial({
        color: 0x5d7c4c,
        roughness: 0.78,
        metalness: 0,
        side: THREE.DoubleSide,
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
    case 'clutter':
      // Deliberately NOT from the colourway: recolouring a sofa must not
      // recolour the book somebody left on the table beside it.
      return '#cfc4b4';
    case 'foliage':
      return '#5d7c4c';
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
