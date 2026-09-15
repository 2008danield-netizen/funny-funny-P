/**
 * The live cut in the 3D view.
 *
 * -----------------------------------------------------------------------------
 * THE SAME CUT AS THE DRAWING, NOT A SECOND ONE.
 *
 * The plane here is computed from the same `SectionCut` the section sheet is
 * drawn from, through the same `sectionFrame`. That is the whole point: sliding
 * the cut in the viewport and printing the section have to agree, and the only
 * reliable way to make two things agree is for there to be one of them.
 *
 * -----------------------------------------------------------------------------
 * WHY A CLIPPING PLANE RATHER THAN HIDING THINGS.
 *
 * Hiding whole walls is what the app already does to let the camera see inside,
 * and it is the wrong tool here: hiding a wall removes all of it, so you lose
 * the half you wanted to look at along with the half in the way. A clipping
 * plane cuts through the middle of the geometry, which is what a section is.
 *
 * -----------------------------------------------------------------------------
 * THE PLANE IS APPLIED PER MATERIAL, NOT GLOBALLY.
 *
 * Handing the plane to the renderer is one line and cuts everything in the
 * scene — including the ground and the sky, which are not part of the building
 * and have no business being sliced. What that actually looks like is half the
 * site missing and a black void where it was, which is far more alarming than
 * the thing it was meant to reveal.
 *
 * So the plane is walked onto the materials of the building groups only. That
 * does mean a new kind of geometry has to be re-walked when it appears, which
 * is why `apply` is called after every rebuild rather than once at startup.
 *
 * -----------------------------------------------------------------------------
 * THE CUT IS LEFT HOLLOW, AND THAT IS THE LEAST BAD ANSWER.
 *
 * WebGL clipping cuts through geometry that has no interior, so a sliced wall
 * shows you its far inside face rather than a solid end. Capping that properly
 * means a stencil pass per plane — real machinery for a feature whose job is
 * orientation rather than presentation.
 *
 * The obvious cheap alternative is a flat quad sitting on the plane, and this
 * file had one. In the viewport it was a large grey rectangle covering most of
 * the frame, hiding exactly the interior the cut was made to reveal. A cheap
 * cap is worse than no cap: the hollow edge reads as a cut immediately, and a
 * sheet of grey reads as a wall that is not there.
 *
 * So there is no cap. The panel says the 3D cut is for orientation and that
 * the printed section is where the real construction is drawn.
 */

import * as THREE from 'three';

import { sectionFrame } from '@/building/section';
import type { SectionCut } from '@/state/types';

export class SectionClip {
  private plane: THREE.Plane | null = null;
  private enabled = false;

  /** The planes to hand the renderer. Empty when no cut is active. */
  get planes(): THREE.Plane[] {
    return this.enabled && this.plane ? [this.plane] : [];
  }

  get active(): boolean {
    return this.enabled && this.plane !== null;
  }

  /**
   * Pushes the current plane onto every material under a root.
   *
   * Three.js recompiles a shader when the NUMBER of clipping planes changes,
   * so `needsUpdate` is set on that transition and not on every call — doing
   * it unconditionally would rebuild every shader in the building on every
   * pointer move.
   */
  apply(root: THREE.Object3D): void {
    const planes = this.planes;

    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        const current = material.clippingPlanes as THREE.Plane[] | null;
        const had = current ? current.length : 0;

        material.clippingPlanes = planes.length > 0 ? planes : null;
        // Cut surfaces should not cast shadows from geometry that is gone.
        material.clipShadows = planes.length > 0;
        if (had !== planes.length) material.needsUpdate = true;
      }
    });
  }

  /** Sets the cut, or clears it. */
  set(cut: SectionCut | null): void {
    if (!cut) {
      this.enabled = false;
      this.plane = null;
      return;
    }

    const frame = sectionFrame(cut);
    if (frame.length <= 0) {
      this.enabled = false;
      this.plane = null;
      return;
    }

    /*
     * The plane's normal points towards the half being KEPT, and Three.js
     * keeps what is on the positive side. `frame.away` already means "away
     * from the viewer, into the drawing", which is exactly the half a section
     * keeps — so the two conventions line up without a sign flip, and the one
     * place they could disagree is this comment.
     */
    const normal = new THREE.Vector3(frame.away.x, 0, frame.away.z).normalize();
    const origin = new THREE.Vector3(frame.origin.x, 0, frame.origin.z);

    this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    this.enabled = true;
  }
}
