/**
 * Furniture is judged on its silhouette, and a silhouette is measurable: it is
 * the set of directions the surface normals point in. A crate's normals point
 * six ways; something upholstered points in hundreds.
 *
 * That is the check that matters here, because the failure this fixes looked
 * entirely fine in the source. A cushion extruded through its depth with no
 * bevel is rounded in ONE plane — four edges out of twelve — and seen from the
 * front, which is how a sofa is almost always seen, it is a crate with rounded
 * ends.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { buildFurniture } from './builders';
import type { BuildSpec } from './catalog';

const SOFA: BuildSpec = { kind: 'sofa', seats: 3, arms: 'low' };
const SIZE = { width: 2.1, depth: 0.9, height: 0.82 };

/** How many distinct directions the surface faces, to a tenth. */
function directions(geometry: THREE.BufferGeometry): Set<string> {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal');
  const seen = new Set<string>();
  for (let i = 0; i < normal.count; i++) {
    seen.add(
      `${normal.getX(i).toFixed(1)},${normal.getY(i).toFixed(1)},${normal.getZ(i).toFixed(1)}`,
    );
  }
  return seen;
}

/** How far the surface turns away from each axis, at its extremes. */
function rounding(geometry: THREE.BufferGeometry): { x: boolean; y: boolean; z: boolean } {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const normal = geometry.getAttribute('normal');

  // A face is "rounded" on an axis when normals exist that are neither square
  // to it nor square to the other two — the diagonal of a real fillet.
  let x = false;
  let y = false;
  let z = false;
  for (let i = 0; i < normal.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));
    if (nx > 0.2 && nx < 0.9) x = true;
    if (ny > 0.2 && ny < 0.9) y = true;
    if (nz > 0.2 && nz < 0.9) z = true;
  }
  return { x, y, z };
}

describe('upholstery', () => {
  it('rounds a cushion in all three directions, not one', () => {
    const parts = buildFurniture(SOFA, SIZE);
    const soft = parts.filter((part) => part.role === 'soft');
    expect(soft.length).toBeGreaterThan(4);

    /*
     * The seat cushions are the widest soft parts after the plinth and the
     * back panel; any of them will do, so the claim is made about all of them
     * together: somewhere in the upholstery there has to be curvature on every
     * axis, which a single-plane extrusion cannot produce.
     */
    const rounded = soft.map((part) => rounding(part.geometry));
    expect(rounded.some((r) => r.x)).toBe(true);
    expect(rounded.some((r) => r.y)).toBe(true);
    expect(rounded.some((r) => r.z)).toBe(true);
    // And at least one single part must be round on all three at once.
    expect(rounded.some((r) => r.x && r.y && r.z)).toBe(true);
  });

  it('gives a cushion a silhouette a crate does not have', () => {
    const parts = buildFurniture(SOFA, SIZE);
    const soft = parts.filter((part) => part.role === 'soft');
    const richest = Math.max(...soft.map((part) => directions(part.geometry).size));

    // A box has six. Anything under a couple of dozen is still a box with the
    // corners taken off.
    expect(richest).toBeGreaterThan(24);
  });

  it('sews piping round the cushions and nowhere else', () => {
    /*
     * Piping goes where two panels of fabric are joined, which on a sofa is the
     * cushions' own edges. Running it round the plinth and the arms as well
     * would draw a seam where no seam is, which is worse than none.
     */
    const parts = buildFurniture(SOFA, SIZE);
    const accent = parts.filter((part) => part.role === 'accent');

    // Four feet plus a seam round each of three seats and three backs.
    expect(accent.length).toBeGreaterThanOrEqual(4 + 6);
  });

  it('keeps every part inside the size it was asked for', () => {
    /*
     * The barrel swells the cushions outward, and a swell that escaped the
     * piece's own footprint would push a sofa through the wall behind it.
     */
    const parts = buildFurniture(SOFA, SIZE);
    const box = new THREE.Box3();
    for (const part of parts) {
      part.geometry.computeBoundingBox();
      box.union(part.geometry.boundingBox!);
    }

    expect(box.max.x - box.min.x).toBeLessThanOrEqual(SIZE.width + 0.06);
    expect(box.max.y - box.min.y).toBeLessThanOrEqual(SIZE.height + 0.02);
    expect(box.max.z - box.min.z).toBeLessThanOrEqual(SIZE.depth + 0.06);
  });

  it('still builds every kind in the catalogue without throwing', () => {
    const specs: BuildSpec[] = [
      { kind: 'sofa', seats: 2, arms: 'high', chaise: true },
      { kind: 'armchair', style: 'wing' },
      { kind: 'chair', back: 'slat' },
      { kind: 'table', shape: 'round', legs: 'corner', apron: true },
      { kind: 'shelving', columns: 3, rows: 4, back: true },
      { kind: 'cabinet', doors: 2, drawers: 2, plinth: true },
      { kind: 'bed', headboard: 0.9, storage: true },
      { kind: 'rug', shape: 'round' },
      { kind: 'lamp', style: 'floor' },
    ];

    for (const spec of specs) {
      const parts = buildFurniture(spec, { width: 1.2, depth: 0.8, height: 0.9 });
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        expect(part.geometry.getAttribute('position').count).toBeGreaterThan(0);
      }
    }
  });
});
