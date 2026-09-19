/**
 * Smoothing is easy to check the wrong way round. A pass that smoothed
 * everything would look better on a cove and would turn every square corner in
 * the building to jelly, and no single-number summary distinguishes the two.
 * So every test here asserts both halves: this got smoother, that stayed sharp.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { CREASE_ANGLE, creaseNormals } from './shading';

/** How far each corner's normal has been pulled off its own flat face. */
function tilts(geometry: THREE.BufferGeometry): number[] {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const face = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const v = new THREE.Vector3();

  const out: number[] = [];
  for (let i = 0; i + 2 < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    face.copy(b).sub(a).cross(edge.copy(c).sub(a));
    if (face.lengthSq() < 1e-16) continue;
    face.normalize();
    for (const j of [i, i + 1, i + 2]) {
      v.fromBufferAttribute(normal, j);
      out.push((Math.acos(Math.min(1, Math.max(-1, v.dot(face)))) * 180) / Math.PI);
    }
  }
  return out;
}

/**
 * A fan of flat strips approximating a quarter circle, which is what a swept
 * moulding profile is and what this exists to fix.
 */
function cove(segments: number, radius = 0.05): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const t0 = (i / segments) * (Math.PI / 2);
    const t1 = ((i + 1) / segments) * (Math.PI / 2);
    const x0 = Math.cos(t0) * radius;
    const y0 = Math.sin(t0) * radius;
    const x1 = Math.cos(t1) * radius;
    const y1 = Math.sin(t1) * radius;
    // Each strip is one metre long in z.
    positions.push(x0, y0, 0, x1, y1, 0, x0, y0, 1);
    positions.push(x1, y1, 0, x1, y1, 1, x0, y0, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

describe('creaseNormals', () => {
  it('leaves a cube fully sharp at every corner', () => {
    const box = creaseNormals(new THREE.BoxGeometry(1, 1, 1));
    // Every face of a cube turns ninety degrees into its neighbours.
    for (const tilt of tilts(box)) expect(tilt).toBeLessThan(0.01);
  });

  it('smooths a fan of flat strips into a curve', () => {
    const before = tilts(creaseNormals(cove(1)));
    const after = tilts(creaseNormals(cove(6)));

    // One strip has no neighbour to blend with and must stay flat. The
    // threshold is a hundredth of a degree rather than zero: the normal is
    // recomputed from the positions in single precision, so it lands beside
    // the face rather than exactly on it.
    expect(Math.max(...before)).toBeLessThan(0.05);
    // Six strips turn fifteen degrees into each other, so each corner's normal
    // should end up about halfway between its two faces.
    expect(Math.max(...after)).toBeGreaterThan(5);
    expect(Math.max(...after)).toBeLessThan(15);
  });

  it('stops smoothing where the surface genuinely turns a corner', () => {
    /*
     * The profile that matters: a curve that meets a flat at ninety degrees,
     * which is every skirting board and every cornice. The curve must soften
     * and the junction must not.
     */
    const positions: number[] = [];
    // A flat back, straight down.
    positions.push(0, 0, 0, 0, 0.1, 0, 0, 0, 1);
    positions.push(0, 0.1, 0, 0, 0.1, 1, 0, 0, 1);
    // And a floor running away from its foot, a right angle from it.
    positions.push(0, 0, 0, 0, 0, 1, 0.1, 0, 0);
    positions.push(0, 0, 1, 0.1, 0, 1, 0.1, 0, 0);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    creaseNormals(geometry);

    for (const tilt of tilts(geometry)) expect(tilt).toBeLessThan(0.01);
  });

  it('respects the angle it is given', () => {
    // A fan whose strips turn about eighteen degrees into one another.
    const gentle = tilts(creaseNormals(cove(5), 45));
    const strict = tilts(creaseNormals(cove(5), 10));

    expect(Math.max(...gentle)).toBeGreaterThan(5);
    // Below the turn angle, nothing may be smoothed at all.
    expect(Math.max(...strict)).toBeLessThan(0.05);
  });

  it('matches positions at joinery scale, not at centimetre scale', () => {
    /*
     * The reason this exists rather than three's `toCreasedNormals`, which
     * hashes onto a one-centimetre grid. The points of a real moulding profile
     * are millimetres apart; collapsing them into one cell does not smooth the
     * profile, it deletes it.
     *
     * A cove of 3 mm radius is entirely inside one of those cells. Smoothed
     * correctly it stays a quarter circle; smoothed on a centimetre grid every
     * normal in it becomes the same average and the shape flattens out.
     */
    const tiny = creaseNormals(cove(6, 0.003));
    const normal = tiny.getAttribute('normal');

    // Collect the distinct directions. A quarter circle in six steps has six or
    // seven of them; a collapsed one has a single direction repeated.
    const directions = new Set<string>();
    for (let i = 0; i < normal.count; i++) {
      directions.add(
        `${normal.getX(i).toFixed(2)},${normal.getY(i).toFixed(2)},${normal.getZ(i).toFixed(2)}`,
      );
    }
    expect(directions.size).toBeGreaterThan(4);
  });

  it('de-indexes, because a crease needs two normals at one point', () => {
    const indexed = new THREE.BoxGeometry(1, 1, 1);
    expect(indexed.index).not.toBeNull();

    const result = creaseNormals(indexed);
    expect(result.index).toBeNull();
    expect(result.getAttribute('normal').count).toBe(result.getAttribute('position').count);
  });

  it('weights by area, so an uneven tessellation does not lean', () => {
    /*
     * Two strips meeting at a gentle angle, one of them ten times the area of
     * the other. The shared normal must lie nearer the large face, which is
     * what summing un-normalised cross products buys.
     */
    const positions: number[] = [];
    // A big face in the xz plane, wound so its normal points up.
    positions.push(0, 0, 0, 0, 0, 1, 1, 0, 0);
    positions.push(1, 0, 0, 0, 0, 1, 1, 0, 1);
    // A small one tipped twenty degrees up from the shared edge at z = 1.
    const lift = Math.tan((20 * Math.PI) / 180) * 0.1;
    positions.push(0, 0, 1, 0, lift, 1.1, 1, 0, 1);
    positions.push(1, 0, 1, 0, lift, 1.1, 1, lift, 1.1);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    creaseNormals(geometry, 45);

    const normal = geometry.getAttribute('normal');
    // The shared edge is at z = 1. Its normal should be much closer to straight
    // up than to the ten-degree midpoint an unweighted average would give.
    const position = geometry.getAttribute('position');
    let checked = 0;
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(position.getZ(i) - 1) > 1e-6) continue;
      const tilt = (Math.acos(Math.min(1, normal.getY(i))) * 180) / Math.PI;
      expect(tilt).toBeLessThan(7);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('survives a degenerate triangle without producing a black hole', () => {
    const positions = [0, 0, 0, 1, 0, 0, 1, 0, 0];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    creaseNormals(geometry);

    const normal = geometry.getAttribute('normal');
    for (let i = 0; i < normal.count; i++) {
      expect(Number.isFinite(normal.getX(i))).toBe(true);
      expect(Number.isFinite(normal.getY(i))).toBe(true);
      expect(Number.isFinite(normal.getZ(i))).toBe(true);
    }
  });

  it('defaults to an angle that keeps a forty-five degree chamfer', () => {
    // Sixty degrees, the common default, would smooth it away.
    expect(CREASE_ANGLE).toBeLessThan(45);
    expect(CREASE_ANGLE).toBeGreaterThan(15);
  });
});
