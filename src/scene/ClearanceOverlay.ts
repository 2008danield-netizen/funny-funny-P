/**
 * Draws clearance zones on the floor.
 *
 * The point of the overlay is to answer "why" — a list entry saying a chest
 * blocks a door swing is only actionable once you can see the arc it means and
 * how much of it is intruded upon. Zones are drawn flat on the floor, just above
 * it, so they read as markings on the ground rather than as objects in the room.
 *
 * Rendering notes that matter:
 *   • `depthWrite: false` and a small polygon offset, or the zones z-fight with
 *     the floor they lie on.
 *   • `renderOrder` above the room but below the furniture, so a sofa standing
 *     in a zone still draws over it — the furniture is the subject, the zone is
 *     annotation.
 *   • Geometry is rebuilt only when the zone set changes shape, not on every
 *     analysis pass, since analysis runs on every drag frame.
 */

import * as THREE from 'three';

import type { ClearanceZone } from '@/clearance/zones';

/** Height above the floor, in metres. Enough to clear the floor, not enough to see. */
const OVERLAY_HEIGHT = 0.006;

export class ClearanceOverlay {
  readonly group = new THREE.Group();

  /** One mesh per zone, keyed by zone ID. */
  private meshes = new Map<string, THREE.Mesh>();

  /** Shared materials: clear, and violated. */
  private okMaterial: THREE.MeshBasicMaterial;
  private violatedMaterial: THREE.MeshBasicMaterial;

  /** Signature of the geometry currently built. */
  private builtSignature = '';
  private visible = false;

  constructor() {
    this.group.name = 'ClearanceOverlay';
    this.group.visible = false;

    const base: THREE.MeshBasicMaterialParameters = {
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Nudges the zone towards the camera in depth so it wins against the
      // floor without being physically lifted off it.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    };

    // A clear zone is quiet; a violated one has to catch the eye from across
    // the room, so it is both stronger and warmer.
    this.okMaterial = new THREE.MeshBasicMaterial({ ...base, color: 0x5fa8d3, opacity: 0.22 });
    this.violatedMaterial = new THREE.MeshBasicMaterial({ ...base, color: 0xd8483f, opacity: 0.42 });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  /**
   * Brings the overlay in line with a set of zones.
   *
   * Cheap to call on every frame of a drag: the signature check skips the
   * geometry rebuild unless zones actually moved, and re-flagging which are
   * violated is a material swap.
   */
  update(zones: readonly ClearanceZone[], violatedIds: ReadonlySet<string>): void {
    // Skip all work while hidden — a user who has turned the overlay off should
    // not be paying for it on every drag frame.
    if (!this.visible) return;

    const signature = zones
      .map(
        (zone) =>
          `${zone.id}:${zone.center.x.toFixed(3)},${zone.center.z.toFixed(3)},` +
          `${zone.halfWidth.toFixed(3)},${zone.halfDepth.toFixed(3)},${zone.rotation.toFixed(3)}`,
      )
      .join('|');

    if (signature !== this.builtSignature) {
      this.rebuild(zones);
      this.builtSignature = signature;
    }

    for (const [id, mesh] of this.meshes) {
      mesh.material = violatedIds.has(id) ? this.violatedMaterial : this.okMaterial;
    }
  }

  private rebuild(zones: readonly ClearanceZone[]): void {
    const live = new Set(zones.map((zone) => zone.id));

    for (const [id, mesh] of this.meshes) {
      if (live.has(id)) continue;
      mesh.geometry.dispose();
      this.group.remove(mesh);
      this.meshes.delete(id);
    }

    for (const zone of zones) {
      let mesh = this.meshes.get(zone.id);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.okMaterial);
        // Lie flat, facing up.
        mesh.rotation.x = -Math.PI / 2;
        // Above the room's floor and skirtings, below the furniture.
        mesh.renderOrder = 2;
        mesh.name = `Zone_${zone.id}`;
        // Never pickable: the user clicks the furniture, not the annotation.
        mesh.raycast = () => {};
        this.group.add(mesh);
        this.meshes.set(zone.id, mesh);
      }

      // A unit plane scaled to the zone, rather than a rebuilt geometry: this
      // runs while dragging, and allocating a buffer per zone per frame would
      // churn memory for no reason.
      mesh.scale.set(zone.halfWidth * 2, zone.halfDepth * 2, 1);
      mesh.position.set(zone.center.x, OVERLAY_HEIGHT, zone.center.z);
      // The mesh is already rotated flat about X, so the zone's own rotation
      // about the world Y axis becomes a rotation about the mesh's local Z.
      mesh.rotation.z = -zone.rotation;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.geometry.dispose();
    this.meshes.clear();
    this.okMaterial.dispose();
    this.violatedMaterial.dispose();
    this.group.clear();
  }
}
