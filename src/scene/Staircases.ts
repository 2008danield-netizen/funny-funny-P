/**
 * Drawing staircases.
 *
 * A stair is built from the geometry `building/stairs.ts` already derives, so
 * this module makes no decisions about shape at all — it extrudes what it is
 * given. That separation is what lets the code checks, the tests and the
 * renderer all be looking at the same staircase.
 *
 * Each tread is drawn as a solid box from the walking surface down to the one
 * below, which is both how an open-riser stair looks and a reasonable stand-in
 * for a closed-riser one at the scale anybody views a plan from. The nosing
 * projects over the step below, because that overhang is what the code measures
 * and what a person's heel actually clears.
 */

import * as THREE from 'three';

import { stairGeometry, type StairGeometry } from '@/building/stairs';
import type { DesignDocument, Point2, Stair } from '@/state/types';

/** Materials shared by every stair in the scene. */
interface StairMaterials {
  tread: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
}

export class Staircases {
  readonly group = new THREE.Group();

  private materials: StairMaterials;
  private meshes = new Map<string, THREE.Mesh[]>();
  private builtSignature = '';

  constructor() {
    this.group.name = 'Staircases';
    this.materials = {
      tread: new THREE.MeshStandardMaterial({
        color: 0xc9ab84,
        roughness: 0.62,
        metalness: 0,
      }),
      rail: new THREE.MeshStandardMaterial({
        color: 0x4a4a4e,
        roughness: 0.45,
        metalness: 0.35,
      }),
    };
  }

  /**
   * Rebuilds the stairs standing on one storey.
   *
   * Signature-gated like every other rebuild in the scene: a staircase is a few
   * dozen boxes and regenerating them on every frame of an unrelated furniture
   * drag would be pure waste.
   */
  update(doc: DesignDocument, levelId: string): void {
    const stairs = doc.stairs.filter((stair) => stair.fromLevelId === levelId);

    const signature = stairs
      .map(
        (stair) =>
          `${stair.id}:${stair.at.x.toFixed(3)},${stair.at.z.toFixed(3)},` +
          `${stair.rotation.toFixed(4)},${stair.width.toFixed(3)},${stair.treadDepth.toFixed(3)},` +
          `${stair.riserCount},${stair.nosing.toFixed(3)},${stair.handrail},` +
          `${JSON.stringify(stair.form)}`,
      )
      .join('|');

    if (signature === this.builtSignature) return;
    this.builtSignature = signature;
    this.clear();

    for (const stair of stairs) {
      this.build(stair, stairGeometry(doc, stair));
    }
  }

  private build(stair: Stair, geometry: StairGeometry): void {
    const meshes: THREE.Mesh[] = [];

    for (const tread of geometry.treads) {
      // A tread is a slab whose top is the walking surface. Its thickness is
      // the riser below it, so the flight reads as solid from the side.
      const thickness = Math.max(0.04, geometry.riserHeight);
      const shape = polygonShape(tread.polygon);
      if (!shape) continue;

      const solid = new THREE.ExtrudeGeometry(shape, {
        depth: thickness,
        bevelEnabled: false,
      });
      // ExtrudeGeometry builds in XY and extrudes along +Z; lay it flat so the
      // extrusion runs upwards, then lift it to the tread's own height.
      solid.rotateX(-Math.PI / 2);
      // The extrusion runs from y = 0 upwards, so drop it by its own thickness
      // to put the TOP of the slab at the walking surface. Translating by the
      // tread height alone floats every step one riser too high, which reads as
      // a staircase starting halfway up the wall.
      solid.translate(0, tread.height - thickness, 0);

      const mesh = new THREE.Mesh(solid, this.materials.tread);
      mesh.name = `Stair_${stair.id}_${tread.index}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.pick = { kind: 'stair', id: stair.id };
      this.group.add(mesh);
      meshes.push(mesh);
    }

    if (stair.handrail !== 'none') {
      for (const mesh of this.buildHandrails(stair, geometry)) {
        this.group.add(mesh);
        meshes.push(mesh);
      }
    }

    this.meshes.set(stair.id, meshes);
  }

  /**
   * A handrail as a run of short posts following the nosing line.
   *
   * Not a swept tube: the rail follows a polyline that turns corners on an L or
   * a U and spirals on a spiral, and a swept profile round those turns is a
   * disproportionate amount of geometry for something seen at this scale. The
   * posts read correctly and cost almost nothing.
   */
  private buildHandrails(stair: Stair, geometry: StairGeometry): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    // IRC R311.7.8.1 puts a graspable rail 34-38 in above the nosings; 36 in
    // is the middle of that band and what most stairs are built to.
    const railHeight = 0.9144;
    const postGeometry = new THREE.CylinderGeometry(0.02, 0.02, railHeight, 6);

    for (const point of geometry.handrailLine) {
      const post = new THREE.Mesh(postGeometry.clone(), this.materials.rail);
      post.position.set(point.at.x, point.height + railHeight / 2, point.at.z);
      post.castShadow = true;
      post.name = `StairRail_${stair.id}`;
      post.raycast = () => {};
      meshes.push(post);
    }

    postGeometry.dispose();
    return meshes;
  }

  private clear(): void {
    for (const meshes of this.meshes.values()) {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        this.group.remove(mesh);
      }
    }
    this.meshes.clear();
  }

  dispose(): void {
    this.clear();
    this.materials.tread.dispose();
    this.materials.rail.dispose();
    this.group.clear();
  }
}

/**
 * A Three.js shape from a plan polygon.
 *
 * Mirrors Z for the same reason the floor builder does: the extruder works in
 * XY with +Y up the screen, and a plan's +Z runs down it. Getting this wrong
 * builds every staircase as its own mirror image, which is subtle enough in a
 * screenshot to survive review and obvious the moment somebody walks up it.
 */
function polygonShape(polygon: readonly Point2[]): THREE.Shape | null {
  if (polygon.length < 3) return null;
  const shape = new THREE.Shape();
  polygon.forEach((point, index) => {
    if (index === 0) shape.moveTo(point.x, -point.z);
    else shape.lineTo(point.x, -point.z);
  });
  shape.closePath();
  return shape;
}
