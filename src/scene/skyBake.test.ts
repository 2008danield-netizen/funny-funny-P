/**
 * Does the ambient light know the building is there?
 *
 * This is the correction to three sessions of chasing the wrong thing. Shadow
 * mapping blocks the sun from a closed room and always did; the hemisphere light
 * and the environment probe never blocked anything, so every interior surface
 * was lit as though standing in an open field. The 3.2-to-1 sun-to-ambient ratio
 * tuned in session 17 is the ratio OUTDOORS — indoors the sun collapses to
 * nothing and the ambient does not, so it silently inverts.
 *
 * These tests are built from boxes rather than from the app's own rooms on
 * purpose. A closed box has an answer anybody can check by hand — the inside
 * sees no sky and the outside sees half of it — and that is what makes them
 * useful as a check on a piece of machinery whose output is otherwise only
 * judgeable by eye.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  bakeSkyVisibility,
  fillUnbaked,
  smoothAlongEdges,
  type BakeLight,
} from './skyBake';

/** The mean of the baked attribute on a mesh. */
function meanOf(mesh: THREE.Mesh): number {
  const attribute = mesh.geometry.getAttribute('bakedAmbient');
  let total = 0;
  for (let i = 0; i < attribute.count; i++) total += attribute.getX(i);
  return total / attribute.count;
}

/** A plane of the given size, facing up, subdivided so it has interior points. */
function floor(size: number, segments = 6): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** A lid hanging over that floor at the given height. */
function lid(size: number, height: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, height, 0);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe('sky visibility', () => {
  it('sees the whole sky from open ground', () => {
    const ground = floor(6);
    bakeSkyVisibility([ground], [ground]);
    // Nothing above it, so every ray escapes. Allowing a little slack for the
    // rays that graze the plane's own edge.
    expect(meanOf(ground)).toBeGreaterThan(0.95);
  });

  it('sees almost none of it under a close lid', () => {
    const ground = floor(6);
    const roof = lid(6, 0.5);
    bakeSkyVisibility([ground], [ground, roof]);
    // A lid 0.5 m above a 6 m floor covers nearly the whole hemisphere from
    // anywhere but the very edge.
    expect(meanOf(ground)).toBeLessThan(0.45);
  });

  it('darkens in proportion to how enclosed a point is', () => {
    /*
     * The property that actually matters. It is not enough for enclosed places
     * to be dark and open ones bright — the gradient BETWEEN them is what a
     * person reads as depth, and a bake that produced two flat values would
     * look no better than what it replaced.
     */
    const high = floor(6);
    const low = floor(6);
    bakeSkyVisibility([high], [high, lid(6, 2.4)]);
    bakeSkyVisibility([low], [low, lid(6, 0.8)]);
    expect(meanOf(low)).toBeLessThan(meanOf(high));
  });

  it('is brighter near an opening than away from it', () => {
    /*
     * The falloff from a window, which is the single most recognisable thing
     * this buys. A lid with a gap along one edge stands in for a room with a
     * window in one wall.
     */
    const ground = floor(8, 16);
    // Covers everything except a 2 m strip at one end.
    const roof = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 6, 1, 1).rotateX(Math.PI / 2).translate(0, 2.4, 1),
      new THREE.MeshStandardMaterial(),
    );
    roof.updateMatrixWorld(true);
    bakeSkyVisibility([ground], [ground, roof]);

    const position = ground.geometry.getAttribute('position');
    const baked = ground.geometry.getAttribute('bakedAmbient');

    // Average the near-the-gap end against the far end.
    let openTotal = 0;
    let openCount = 0;
    let shutTotal = 0;
    let shutCount = 0;
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i);
      if (z < -3) { openTotal += baked.getX(i); openCount++; }
      if (z > 3) { shutTotal += baked.getX(i); shutCount++; }
    }

    expect(openCount).toBeGreaterThan(0);
    expect(shutCount).toBeGreaterThan(0);
    expect(openTotal / openCount).toBeGreaterThan(shutTotal / shutCount + 0.1);
  });

  it('never goes fully black, because the third bounce is still not simulated', () => {
    /*
     * A point sealed inside a box genuinely sees no sky and its honest answer
     * is zero, and pure black is still the wrong thing to render.
     *
     * The floor that prevents it used to be 0.12 and is now a tenth of that,
     * which is the change S3 earned: the light reaching such a place arrives
     * bounced, and the bounce is now computed rather than guessed at. What is
     * left over is the SECOND and third bounce, which are not — so the floor
     * still exists, and is small.
     */
    const ground = floor(4);
    const roof = lid(4, 0.1);
    const result = bakeSkyVisibility([ground], [ground, roof]);
    expect(result.darkest).toBeGreaterThan(0.005);
    expect(result.darkest).toBeLessThan(0.05);
  });

  it('does not speckle from rays hitting the surface they left', () => {
    /*
     * The classic bake failure. A ray leaving exactly from its own surface hits
     * it immediately at grazing angles, reporting a point as sealed when it is
     * in the open — and the symptom is a mesh covered in black dots rather than
     * anything that looks like a bug in a ray caster.
     *
     * Open ground has a known answer of ~1 everywhere, so any vertex much below
     * that is a self-hit.
     */
    const ground = floor(10, 20);
    bakeSkyVisibility([ground], [ground]);
    const baked = ground.geometry.getAttribute('bakedAmbient');

    let speckled = 0;
    for (let i = 0; i < baked.count; i++) if (baked.getX(i) < 0.8) speckled++;
    expect(speckled).toBe(0);
  });

  it('reports what it did, so a check can tell a bake from a no-op', () => {
    const ground = floor(4, 4);
    const result = bakeSkyVisibility([ground], [ground]);
    expect(result.vertices).toBe(25);
    // Forty-eight rays for the sky visibility and twelve for the bounce.
    expect(result.rays).toBe(25 * 60);
    expect(result.mean).toBeGreaterThan(0);
  });

  it('fills unbaked geometry with ones rather than leaving it black', () => {
    /*
     * The shader reads the attribute unconditionally and a missing attribute
     * reads as ZERO, which would render every unbaked surface — the terrain,
     * anything added after a bake — pure black.
     */
    const geometry = new THREE.PlaneGeometry(1, 1);
    fillUnbaked(geometry);
    const baked = geometry.getAttribute('bakedAmbient');
    expect(baked).toBeTruthy();
    for (let i = 0; i < baked.count; i++) expect(baked.getX(i)).toBe(1);
  });
});

describe('smoothAlongEdges', () => {
  /** A strip of triangles, so neighbours are known by hand. */
  function strip(points: number): { geometry: THREE.BufferGeometry; groupOf: Int32Array } {
    const positions: number[] = [];
    const groups: number[] = [];

    // Two rows of vertices, one metre apart, zig-zagged into triangles.
    for (let i = 0; i + 1 < points; i++) {
      positions.push(i, 0, 0, i + 1, 0, 0, i, 0, 1);
      groups.push(i, i + 1, i);
      positions.push(i + 1, 0, 0, i + 1, 0, 1, i, 0, 1);
      groups.push(i + 1, i + 1, i);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return { geometry, groupOf: Int32Array.from(groups) };
  }

  it('leaves a field that is already flat exactly where it was', () => {
    const { geometry, groupOf } = strip(6);
    const values = new Float32Array(6).fill(0.4);
    smoothAlongEdges(geometry, groupOf, values, 2);
    for (const value of values) expect(value).toBeCloseTo(0.4, 6);
  });

  it('removes a single-vertex spike, which is what it is for', () => {
    const { geometry, groupOf } = strip(6);
    const values = new Float32Array(6).fill(0.4);
    values[3] = 1;

    smoothAlongEdges(geometry, groupOf, values, 2);

    // The spike has to come down a long way, and must not vanish entirely —
    // that would mean the pass is erasing the field rather than smoothing it.
    expect(values[3]!).toBeLessThan(0.75);
    expect(values[3]!).toBeGreaterThan(0.4);
    // And its neighbours have to have taken some of it up.
    expect(values[2]!).toBeGreaterThan(0.4);
  });

  it('keeps a broad gradient, which is the thing the bake is measuring', () => {
    const { geometry, groupOf } = strip(9);
    const values = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);

    smoothAlongEdges(geometry, groupOf, values, 2);

    // A linear ramp is its own local average, so the interior must not move.
    for (let g = 2; g < 7; g++) expect(values[g]!).toBeCloseTo(0.1 + g * 0.1, 3);
    // The span is allowed to pull in at the ends and must stay a gradient.
    expect(values[8]! - values[0]!).toBeGreaterThan(0.5);
  });

  it('never moves the field outside the range it started in', () => {
    const { geometry, groupOf } = strip(8);
    const values = Float32Array.from([0.2, 0.9, 0.3, 0.8, 0.2, 0.7, 0.4, 0.6]);

    smoothAlongEdges(geometry, groupOf, values, 4);

    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0.2 - 1e-6);
      expect(value).toBeLessThanOrEqual(0.9 + 1e-6);
    }
  });

  it('does nothing when asked for no passes', () => {
    const { geometry, groupOf } = strip(5);
    const values = Float32Array.from([0.1, 0.9, 0.1, 0.9, 0.1]);
    smoothAlongEdges(geometry, groupOf, values, 0);
    const wanted = [0.1, 0.9, 0.1, 0.9, 0.1];
    for (let g = 0; g < wanted.length; g++) expect(values[g]!).toBeCloseTo(wanted[g]!, 6);
  });

  it('leaves a point with no neighbours alone rather than zeroing it', () => {
    const geometry = new THREE.BufferGeometry();
    // One degenerate triangle, all three corners in the same group.
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3),
    );
    const groupOf = Int32Array.from([0, 0, 0]);
    const values = Float32Array.from([0.33, 0.77]);

    smoothAlongEdges(geometry, groupOf, values, 3);

    expect(values[0]!).toBeCloseTo(0.33, 6);
    // Group 1 appears in no triangle at all and must survive untouched.
    expect(values[1]!).toBeCloseTo(0.77, 6);
  });

  it('reads an indexed mesh as well as a loose one', () => {
    const loose = strip(5);
    const indexed = {
      geometry: loose.geometry.clone(),
      groupOf: loose.groupOf.slice(),
    };
    // Same triangles, addressed through an index buffer instead.
    indexed.geometry.setIndex([...Array(loose.groupOf.length).keys()]);

    const a = Float32Array.from([0.2, 0.9, 0.2, 0.9, 0.2]);
    const b = Float32Array.from([0.2, 0.9, 0.2, 0.9, 0.2]);

    smoothAlongEdges(loose.geometry, loose.groupOf, a, 2);
    smoothAlongEdges(indexed.geometry, indexed.groupOf, b, 2);

    for (let g = 0; g < a.length; g++) expect(b[g]!).toBeCloseTo(a[g]!, 6);
  });
});

describe('the bounce', () => {
  /** A plain white sky with no sun, so only the bounce can colour anything. */
  function sunless(): BakeLight {
    return {
      sky: new THREE.Color(1, 1, 1),
      ground: new THREE.Color(0.3, 0.3, 0.3),
      sun: new THREE.Vector3(0, 1, 0),
      sunColour: new THREE.Color(0, 0, 0),
    };
  }

  /** A wall standing beside the floor, of a given colour, facing it. */
  function wall(colour: number, at: number): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(6, 3, 4, 4);
    geometry.rotateY(at > 0 ? -Math.PI / 2 : Math.PI / 2);
    geometry.translate(at, 1.5, 0);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: colour }),
    );
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  /** The mean bounce on a mesh, per channel. */
  function bounceOf(mesh: THREE.Mesh): [number, number, number] {
    const attribute = mesh.geometry.getAttribute('bakedBounce');
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < attribute.count; i++) {
      r += attribute.getX(i);
      g += attribute.getY(i);
      b += attribute.getZ(i);
    }
    return [r / attribute.count, g / attribute.count, b / attribute.count];
  }

  it('is zero in the open, where there is nothing to bounce off', () => {
    const ground = floor(6);
    const result = bakeSkyVisibility([ground], [ground], sunless());
    // Every ray escapes, so nothing was hit and nothing can have bounced.
    expect(result.bounce).toBeLessThan(0.02);
  });

  it('takes its colour from the surface it came off', () => {
    /*
     * The claim S3 is making, and the one thing no brightness figure can
     * check: put a red wall next to a floor and the floor must go red, not
     * merely darker or brighter.
     */
    const ground = floor(6, 8);
    const red = wall(0xff0000, 2.5);
    const result = bakeSkyVisibility([ground], [ground, red], sunless());

    const [r, g, b] = bounceOf(ground);
    expect(r).toBeGreaterThan(0.01);
    expect(r).toBeGreaterThan(g * 3);
    expect(r).toBeGreaterThan(b * 3);
    // And the bake must say so, so a check elsewhere can tell colour from grey.
    expect(result.chroma).toBeGreaterThan(0.5);
  });

  it('stays grey off a white surface, so chroma means something', () => {
    const ground = floor(6, 8);
    const white = wall(0xffffff, 2.5);
    const result = bakeSkyVisibility([ground], [ground, white], sunless());

    expect(result.bounce).toBeGreaterThan(0.01);
    expect(result.chroma).toBeLessThan(0.1);
  });

  it('is stronger near the wall than far from it', () => {
    /*
     * Bounced light falls off with distance, and a bake that applied one flat
     * value per room would pass every other test here.
     */
    const ground = floor(8, 10);
    const red = wall(0xff0000, 3.5);
    bakeSkyVisibility([ground], [ground, red], sunless());

    const position = ground.geometry.getAttribute('position');
    const bounce = ground.geometry.getAttribute('bakedBounce');

    let near = 0;
    let nearCount = 0;
    let far = 0;
    let farCount = 0;

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      if (x > 2.5) {
        near += bounce.getX(i);
        nearCount++;
      } else if (x < -2.5) {
        far += bounce.getX(i);
        farCount++;
      }
    }

    expect(nearCount).toBeGreaterThan(0);
    expect(farCount).toBeGreaterThan(0);
    expect(near / nearCount).toBeGreaterThan((far / farCount) * 1.5);
  });

  it('reads the side of a surface the light actually came off', () => {
    /*
     * The mistake that would be hardest to spot. A wall has a sunlit outside
     * and a shaded inside; take the wrong one and every room in the house glows
     * as though the walls were paper.
     *
     * Two opposed lids over a floor: the upper one is in daylight, the lower
     * one sees only the upper. The floor must bounce off the LOWER one's
     * underside, which is dark, and not off the upper one's top, which is not.
     */
    const ground = floor(4, 6);
    const under = lid(4, 1.2);
    const over = lid(4, 1.4);

    const result = bakeSkyVisibility([ground], [ground, under, over], sunless());

    // The floor sees almost no sky and the ceiling above it is itself unlit,
    // so what arrives has to be very little.
    expect(result.bounce).toBeLessThan(0.15);
  });

  it('lets a sunlit surface throw its own light around', () => {
    const ground = floor(6, 8);
    const red = wall(0xff0000, 2.5);

    const dim = bakeSkyVisibility([ground], [ground, red], sunless());
    const dimBounce = bounceOf(ground)[0];

    const sunlit: BakeLight = {
      ...sunless(),
      // Low in the west, straight onto the wall's inward face.
      sun: new THREE.Vector3(1, 0.3, 0).normalize(),
      sunColour: new THREE.Color(3, 3, 3),
    };
    bakeSkyVisibility([ground], [ground, red], sunlit);
    const sunBounce = bounceOf(ground)[0];

    expect(dim.bounce).toBeGreaterThan(0);
    expect(sunBounce).toBeGreaterThan(dimBounce * 1.5);
  });

  it('gives unbaked geometry no bounce rather than a free doubling of light', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    fillUnbaked(geometry);

    const bounce = geometry.getAttribute('bakedBounce');
    expect(bounce.itemSize).toBe(3);
    for (let i = 0; i < bounce.count; i++) {
      expect(bounce.getX(i)).toBe(0);
      expect(bounce.getY(i)).toBe(0);
      expect(bounce.getZ(i)).toBe(0);
    }
  });
});
