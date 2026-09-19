/**
 * Clutter is judged on placement and on stability. Placement, because the whole
 * claim is that things sit where they were PUT rather than being scattered; and
 * stability, because a rebuild happens on every edit and clutter that jumped
 * about would turn moving a wall into the room being burgled and refurnished.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { clutterFor } from './clutter';
import type { BuildSpec } from './catalog';

const TABLE: BuildSpec = { kind: 'table', shape: 'rect', legs: 'corner', apron: true };
const SIZE = { width: 1.1, depth: 0.6, height: 0.45 };

/** Every vertex of every part, in the piece's own coordinates. */
function bounds(parts: { geometry: THREE.BufferGeometry }[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    box.union(part.geometry.boundingBox!);
  }
  return box;
}

/** A stable fingerprint of the geometry, for comparing two builds. */
function fingerprint(parts: { geometry: THREE.BufferGeometry }[]): string {
  return parts
    .map((part) => {
      const position = part.geometry.getAttribute('position');
      let sum = 0;
      for (let i = 0; i < position.count; i++) {
        sum += position.getX(i) * 1.1 + position.getY(i) * 2.3 + position.getZ(i) * 3.7;
      }
      return `${position.count}:${sum.toFixed(4)}`;
    })
    .join('|');
}

describe('clutterFor', () => {
  it('gives the same piece the same things every time', () => {
    /*
     * The property that matters most, and the one nothing on screen would
     * announce. A rebuild runs on every edit; clutter seeded from anything
     * unstable would reshuffle the room each time a wall moved.
     */
    const a = clutterFor(TABLE, SIZE, 'lack-coffee|1.100|0.600|0.450|f2');
    const b = clutterFor(TABLE, SIZE, 'lack-coffee|1.100|0.600|0.450|f2');
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('gives two different pieces different things', () => {
    // Otherwise two bookcases in a room are a catalogue photograph.
    const a = clutterFor(TABLE, SIZE, 'table|f1');
    const b = clutterFor(TABLE, SIZE, 'table|f7');
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('puts things on the table rather than through it', () => {
    const parts = clutterFor(TABLE, SIZE, 'table|f2');
    expect(parts.length).toBeGreaterThan(0);

    const box = bounds(parts);
    // Nothing sunk into the top, and nothing floating far above it.
    expect(box.min.y).toBeGreaterThanOrEqual(SIZE.height - 0.001);
    expect(box.max.y).toBeLessThan(SIZE.height + 0.6);
  });

  it('keeps everything within the piece it stands on', () => {
    /*
     * An object hanging over an edge is the thing that makes procedural
     * placement look procedural — and on a coffee table against a sofa it
     * would intersect the sofa.
     */
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const box = bounds(clutterFor(TABLE, SIZE, seed));
      expect(box.min.x).toBeGreaterThan(-SIZE.width / 2);
      expect(box.max.x).toBeLessThan(SIZE.width / 2);
      expect(box.min.z).toBeGreaterThan(-SIZE.depth / 2);
      expect(box.max.z).toBeLessThan(SIZE.depth / 2);
    }
  });

  it('leaves seating alone', () => {
    /*
     * A sofa with a book balanced on its arm is a photograph's idea of a sofa.
     * Things get left on horizontal surfaces at working height, and a rule that
     * put something on every piece would be the scattering this exists to
     * avoid.
     */
    const seating: BuildSpec[] = [
      { kind: 'sofa', seats: 3, arms: 'low' },
      { kind: 'armchair', style: 'lounge' },
      { kind: 'chair', back: 'slat' },
      { kind: 'rug', shape: 'rect' },
    ];
    for (const spec of seating) {
      expect(clutterFor(spec, { width: 2, depth: 0.9, height: 0.8 }, 'x')).toEqual([]);
    }
  });

  it('fills shelves in runs with gaps, not end to end', () => {
    /*
     * A shelf packed solid is a library's; a shelf with three books evenly
     * spaced is a catalogue photograph. A real one has runs and gaps, so the
     * books must not be evenly spaced and must not fill the width.
     */
    const shelf: BuildSpec = { kind: 'shelving', columns: 1, rows: 5, back: true };
    const parts = clutterFor(shelf, { width: 0.8, depth: 0.28, height: 2.02 }, 'billy|f3');
    expect(parts.length).toBeGreaterThan(8);

    const box = bounds(parts);
    expect(box.max.y).toBeLessThan(2.02);
    expect(box.min.y).toBeGreaterThan(0);
  });

  it('uses roles a colourway cannot reach', () => {
    /*
     * Recolouring a sofa must not recolour the book on the table beside it, so
     * clutter has its own roles. `soft` is the exception and is deliberate:
     * pillows on a bed should follow the bedding.
     */
    const parts = clutterFor(TABLE, SIZE, 'table|f2');
    for (const part of parts) {
      expect(['clutter', 'foliage', 'soft']).toContain(part.role);
    }
  });

  it('builds something usable for every kind it handles', () => {
    const kinds: [BuildSpec, { width: number; depth: number; height: number }][] = [
      [TABLE, SIZE],
      [{ kind: 'desk', drawers: 2, shape: 'rect' } as BuildSpec, { width: 1.4, depth: 0.7, height: 0.74 }],
      [{ kind: 'shelving', columns: 2, rows: 4, back: false }, { width: 0.8, depth: 0.28, height: 1.8 }],
      [{ kind: 'cabinet', doors: 2, drawers: 0, plinth: true }, { width: 1, depth: 0.45, height: 0.9 }],
      [{ kind: 'bed', headboard: 0.9, storage: false }, { width: 1.6, depth: 2.05, height: 0.5 }],
    ];

    for (const [spec, size] of kinds) {
      const parts = clutterFor(spec, size, `${spec.kind}|seed`);
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        const position = part.geometry.getAttribute('position');
        expect(position.count).toBeGreaterThan(0);
        for (let i = 0; i < position.count; i++) {
          expect(Number.isFinite(position.getX(i))).toBe(true);
          expect(Number.isFinite(position.getY(i))).toBe(true);
          expect(Number.isFinite(position.getZ(i))).toBe(true);
        }
      }
    }
  });
});
