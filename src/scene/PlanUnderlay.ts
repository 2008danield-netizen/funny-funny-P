/**
 * The scanned plan, lying on the floor of the storey being traced.
 *
 * Two objects: the image itself, and the walls the detector has proposed but
 * nobody has accepted yet.
 *
 * The image sits just above the floor and just below the ghost of the storey
 * below, so the stacking order reads the way the work does — the scan is the
 * bottom-most thing, then what has already been drawn, then what is being drawn
 * now. It is faded, because an underlay competing with the walls drawn over it
 * is an underlay that gets turned off.
 *
 * Proposed walls are drawn as translucent slabs at their real thickness rather
 * than as lines. A line would be honest about the uncertainty but useless for
 * the actual judgement, which is "is that where my wall is" — and that question
 * is answered by seeing the proposal sitting exactly on top of the ink.
 */

import * as THREE from 'three';

import { underlayCorners } from '@/plan/underlay';
import type { TraceCandidate } from '@/state/traceOps';
import type { Underlay } from '@/state/types';

/** Just above the floor, just below the ghost outline of the storey below. */
const IMAGE_HEIGHT = 0.002;
/** Proposals stand a little higher, so they read as being on top of the scan. */
const PROPOSAL_HEIGHT = 0.006;

export class PlanUnderlay {
  readonly group = new THREE.Group();

  private plane: THREE.Mesh | null = null;
  private material: THREE.MeshBasicMaterial | null = null;
  private texture: THREE.Texture | null = null;
  private textureId = '';

  private proposals: THREE.Mesh[] = [];
  private proposalMaterial: THREE.MeshBasicMaterial;
  private acceptedMaterial: THREE.MeshBasicMaterial;
  private proposalSignature = '';

  constructor() {
    this.group.name = 'PlanUnderlay';

    this.proposalMaterial = new THREE.MeshBasicMaterial({
      color: 0xe0a83c,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.acceptedMaterial = new THREE.MeshBasicMaterial({
      color: 0x5fb0e8,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Shows a plan image, or nothing.
   *
   * `dataUrl` is looked up by the caller, because reading it is asynchronous
   * and the scene is not — the caller holds the loaded image and hands it in.
   */
  update(underlay: Underlay | null, dataUrl: string | null): void {
    if (!underlay || !dataUrl) {
      this.clearImage();
      return;
    }

    if (this.textureId !== underlay.imageId || !this.plane) {
      this.clearImage();
      this.buildImage(dataUrl, underlay.imageId);
    }

    if (!this.plane || !this.material) return;

    this.material.opacity = underlay.opacity;

    /*
     * The plane is built as a unit square and then placed by its four world
     * corners, so rotation, scale and position all come from one source — the
     * placement maths in `plan/underlay.ts` — rather than being re-derived here
     * where they could disagree with what the calibration says.
     */
    const corners = underlayCorners(underlay);
    const positions = this.plane.geometry.attributes.position!;
    const order = [0, 1, 3, 2] as const; // triangle-strip order for a PlaneGeometry
    for (let i = 0; i < 4; i++) {
      const corner = corners[order[i]!]!;
      positions.setXYZ(i, corner.x, IMAGE_HEIGHT, corner.z);
    }
    positions.needsUpdate = true;
    this.plane.geometry.computeBoundingSphere();
  }

  /** Draws what the detector proposed, and which of them are accepted. */
  setProposals(candidates: readonly TraceCandidate[], accepted: ReadonlySet<string>): void {
    const signature = candidates
      .map((one) => `${one.id}:${one.from.x.toFixed(2)},${one.from.z.toFixed(2)}:${accepted.has(one.id)}`)
      .join('|');
    if (signature === this.proposalSignature) return;
    this.proposalSignature = signature;

    this.clearProposals();

    for (const candidate of candidates) {
      const dx = candidate.to.x - candidate.from.x;
      const dz = candidate.to.z - candidate.from.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;

      const thickness = candidate.thickness ?? 0.1;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(length, thickness),
        accepted.has(candidate.id) ? this.acceptedMaterial : this.proposalMaterial,
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -Math.atan2(dz, dx);
      mesh.position.set(
        (candidate.from.x + candidate.to.x) / 2,
        PROPOSAL_HEIGHT,
        (candidate.from.z + candidate.to.z) / 2,
      );
      mesh.renderOrder = 3;
      this.proposals.push(mesh);
      this.group.add(mesh);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /* ------------------------------- Internals ------------------------------ */

  private buildImage(dataUrl: string, imageId: string): void {
    const texture = new THREE.TextureLoader().load(dataUrl);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;

    this.texture = texture;
    this.textureId = imageId;

    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Behind everything drawn on the floor: this is the thing being traced,
      // not part of the design.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    const geometry = new THREE.PlaneGeometry(1, 1);
    this.plane = new THREE.Mesh(geometry, this.material);
    this.plane.renderOrder = 1;
    this.plane.name = 'TracedPlan';
    this.group.add(this.plane);
  }

  private clearImage(): void {
    if (this.plane) {
      this.plane.geometry.dispose();
      this.group.remove(this.plane);
      this.plane = null;
    }
    this.material?.dispose();
    this.material = null;
    this.texture?.dispose();
    this.texture = null;
    this.textureId = '';
  }

  private clearProposals(): void {
    for (const mesh of this.proposals) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.proposals = [];
  }

  dispose(): void {
    this.clearImage();
    this.clearProposals();
    this.proposalMaterial.dispose();
    this.acceptedMaterial.dispose();
    this.group.clear();
  }
}
