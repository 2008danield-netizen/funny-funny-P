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

import { bakeSkyVisibility, fillUnbaked, smoothAlongEdges } from './skyBake';

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

  it('never goes fully black, because bounced light is not simulated', () => {
    /*
     * A point sealed inside a box genuinely sees no sky and its honest answer is
     * zero. Rendering it as pure black would be wrong for a different reason:
     * in reality such a place is lit by light that has bounced two or three
     * times, and none of that is computed here yet.
     */
    const ground = floor(4);
    const roof = lid(4, 0.1);
    const result = bakeSkyVisibility([ground], [ground, roof]);
    expect(result.darkest).toBeGreaterThan(0.05);
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
    expect(result.rays).toBe(25 * 48);
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
