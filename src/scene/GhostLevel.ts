/**
 * The storey below, drawn as an outline you can align to.
 *
 * When you draw the first floor of a house you are almost never inventing it
 * from nothing — you are tracing over the ground floor, because the external
 * walls run all the way up and the internal ones want to land on something. So
 * the level below is drawn as a faint outline on the floor you are working on.
 *
 * Two decisions worth knowing:
 *
 *   • It is drawn at the ACTIVE level's height, not at its own. Showing it
 *     where it really is would put it under your feet and out of sight; a plan
 *     underlay is only useful in the plane you are drawing in. This is the same
 *     convention every architectural tool uses and the same trick the clearance
 *     overlay uses to lie on the floor without z-fighting.
 *
 *   • It is never pickable. Clicking a wall you can see and selecting nothing
 *     is confusing; clicking it and selecting a wall on a different storey
 *     would be worse.
 */

import * as THREE from 'three';

import { resolveWalls } from './planGraph';
import type { PlanModel } from '@/state/types';

/** How far above the floor the outline sits. Enough to clear it, not to see. */
const GHOST_HEIGHT = 0.004;

export class GhostLevel {
  readonly group = new THREE.Group();

  private material: THREE.MeshBasicMaterial;
  private mesh: THREE.Mesh | null = null;
  private builtSignature = '';
  private visible = false;

  constructor() {
    this.group.name = 'GhostLevel';
    this.group.visible = false;

    this.material = new THREE.MeshBasicMaterial({
      color: 0x8ea2b8,
      transparent: true,
      // Faint enough to draw on top of without fighting it for attention, and
      // strong enough to line a wall up against.
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  /**
   * Draws the walls of a plan as flat ribbons.
   *
   * Ribbons rather than lines: a line has no thickness in world space, so it
   * would stay the same number of pixels wide however far you zoomed out, and
   * the whole point is to see how thick the wall below actually is.
   */
  update(plan: PlanModel | null): void {
    if (!this.visible || !plan) {
      this.clear();
      return;
    }

    const segments = resolveWalls(plan);
    const signature = segments
      .map(
        (segment) =>
          `${segment.wall.id}:${segment.start.x.toFixed(3)},${segment.start.z.toFixed(3)},` +
          `${segment.end.x.toFixed(3)},${segment.end.z.toFixed(3)},${segment.wall.thickness.toFixed(3)}`,
      )
      .join('|');

    if (signature === this.builtSignature) return;
    this.builtSignature = signature;
    this.clear();
    if (segments.length === 0) return;

    const positions: number[] = [];

    for (const segment of segments) {
      const half = segment.wall.thickness / 2;
      const nx = segment.normal.x * half;
      const nz = segment.normal.z * half;

      // Four corners of the wall's plan rectangle.
      const a = { x: segment.start.x + nx, z: segment.start.z + nz };
      const b = { x: segment.end.x + nx, z: segment.end.z + nz };
      const c = { x: segment.end.x - nx, z: segment.end.z - nz };
      const d = { x: segment.start.x - nx, z: segment.start.z - nz };

      // Two triangles, wound so the face points up.
      positions.push(a.x, GHOST_HEIGHT, a.z, d.x, GHOST_HEIGHT, d.z, c.x, GHOST_HEIGHT, c.z);
      positions.push(a.x, GHOST_HEIGHT, a.z, c.x, GHOST_HEIGHT, c.z, b.x, GHOST_HEIGHT, b.z);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'GhostWalls';
    // Above the floor, below the clearance overlay and the furniture.
    this.mesh.renderOrder = 1;
    this.mesh.raycast = () => {};
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.group.add(this.mesh);
  }

  private clear(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.group.remove(this.mesh);
    this.mesh = null;
    this.builtSignature = '';
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
    this.group.clear();
  }
}
