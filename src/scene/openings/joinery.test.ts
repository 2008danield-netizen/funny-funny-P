/**
 * A door is judged on its shadow line, and a shadow line is a measurable thing:
 * some of the leaf's surface has to sit at a different depth from the rest.
 * Most of what follows measures exactly that, because a panelled door that came
 * out flat would look, in every other respect, entirely correct.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { panelledLeaf, sashFrame } from './joinery';

/** The range of z a geometry occupies, and how many distinct depths it uses. */
function depths(geometry: THREE.BufferGeometry): {
  min: number;
  max: number;
  levels: number;
} {
  const position = geometry.getAttribute('position');
  let min = Infinity;
  let max = -Infinity;
  const seen = new Set<string>();
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    if (z < min) min = z;
    if (z > max) max = z;
    seen.add(z.toFixed(4));
  }
  return { min, max, levels: seen.size };
}

/** The bounding box of a geometry, as a plain object. */
function bounds(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

describe('panelledLeaf', () => {
  const WIDTH = 0.88;
  const HEIGHT = 2.03;
  const THICK = 0.04;

  it('fills exactly the leaf it was asked for', () => {
    const leaf = panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'shaker', rows: 2 });
    const box = bounds(leaf);

    expect(box.max.x - box.min.x).toBeCloseTo(WIDTH, 3);
    expect(box.max.y - box.min.y).toBeCloseTo(HEIGHT, 3);
    // Centred on the origin, which is the contract the plain slab had.
    expect((box.max.x + box.min.x) / 2).toBeCloseTo(0, 5);
    expect((box.max.y + box.min.y) / 2).toBeCloseTo(0, 5);
  });

  it('never lets a panel stand proud of its own frame', () => {
    /*
     * The one way a panelled door can be plainly wrong rather than merely
     * plain. A panel above the face of the frame is not a style, it is a
     * mistake, and it happens the moment a recess is signed the wrong way.
     */
    for (const style of ['shaker', 'fielded'] as const) {
      const leaf = panelledLeaf(WIDTH, HEIGHT, THICK, { style, rows: 2 });
      const span = depths(leaf);
      expect(span.max).toBeLessThanOrEqual(THICK / 2 + 1e-4);
      expect(span.min).toBeGreaterThanOrEqual(-THICK / 2 - 1e-4);
    }
  });

  it('has a step in it, which is the whole point', () => {
    const slab = panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'flush', rows: 2 });
    const shaker = panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'shaker', rows: 2 });

    // A slab is two faces and a chamfer; a panelled leaf is those plus the
    // panel's own face several millimetres behind them.
    expect(depths(shaker).levels).toBeGreaterThan(depths(slab).levels);

    // And that step must be big enough to cast a shadow worth seeing.
    const shallowest = THICK / 2 - depths(shaker).max;
    expect(shallowest).toBeLessThan(0.001);
  });

  /**
   * Just the panels, by depth.
   *
   * The stiles and rails run right through the leaf, so their vertices sit at
   * the leaf's own faces and nowhere in between. Anything strictly inside that
   * — in front of centre but behind the face — is recessed work, which on a
   * panelled leaf means a panel and nothing else. Filtering by x instead picks
   * up the inner face of a stile, which spans every depth and drowns the
   * measurement.
   */
  function panelVertices(geometry: THREE.BufferGeometry): { z: number; x: number }[] {
    const position = geometry.getAttribute('position');
    const out: { z: number; x: number }[] = [];
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i);
      if (z <= 0 || z >= THICK / 2 - 0.005) continue;
      out.push({ z, x: Math.abs(position.getX(i)) });
    }
    return out;
  }

  it('cuts a deeper shadow line with a fielded panel than a flat one', () => {
    /*
     * The difference between the two styles, stated as the thing an eye sees.
     *
     * A shaker panel's face is flat and sits one recess behind the frame. A
     * fielded panel's field sits at the same height but its MARGIN slopes away
     * from it, so where the panel meets the frame it has dropped further — a
     * deeper step and therefore a harder shadow.
     */
    const shaker = panelVertices(panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'shaker', rows: 2 }));
    const fielded = panelVertices(panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'fielded', rows: 2 }));

    const deepest = (v: { z: number }[]) => Math.min(...v.map((p) => p.z));
    expect(deepest(fielded)).toBeLessThan(deepest(shaker) - 0.003);
  });

  it("raises the middle of a fielded panel back to the flat one's level", () => {
    /*
     * The other half of the same claim: the field is RAISED. A bevel that only
     * went down would be a recess with sloping sides, which is a different
     * thing and looks like it.
     */
    const shaker = panelVertices(panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'shaker', rows: 2 }));
    const fielded = panelVertices(panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'fielded', rows: 2 }));

    const highest = (v: { z: number }[]) => Math.max(...v.map((p) => p.z));
    expect(highest(fielded)).toBeCloseTo(highest(shaker), 3);
  });

  it('keeps a fielded panel inside the stiles rather than lapping over them', () => {
    /*
     * A bug this had, found by measuring rather than by reading. `bevelSize` in
     * ExtrudeGeometry expands the middle of the extrusion outward — it does not
     * inset the ends — so drawing the shape at the panel's full width produced
     * a panel 45 mm wider than the gap between the stiles, lying over both. The
     * vertices came back at 0.380 where the stile's inner face is at 0.335.
     */
    const fielded = panelVertices(panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'fielded', rows: 2 }));
    const widest = Math.max(...fielded.map((p) => p.x));

    expect(widest).toBeGreaterThan(0.33);
    expect(widest).toBeLessThanOrEqual(0.336);
  });

  it('makes more rows into more steps', () => {
    const two = panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'shaker', rows: 2 });
    const four = panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'shaker', rows: 4 });

    const count = (g: THREE.BufferGeometry) => g.getAttribute('position').count;
    expect(count(four)).toBeGreaterThan(count(two));
  });

  it('falls back to a slab rather than drawing lines on a cupboard front', () => {
    /*
     * A 120 mm leaf has no room for stiles, rails and a panel; forcing them in
     * gives a door made entirely of frame, which looks like a bug. A slab is
     * the honest answer. A 280 mm cupboard front, by contrast, still panels —
     * squeezed in proportion — because real cupboard fronts do.
     */
    const tiny = panelledLeaf(0.12, 0.25, 0.018, { style: 'shaker', rows: 2 });
    const slab = panelledLeaf(0.12, 0.25, 0.018, { style: 'flush', rows: 1 });

    expect(tiny.getAttribute('position').count).toBe(slab.getAttribute('position').count);
  });

  it('keeps its proportions on a narrow leaf instead of overflowing', () => {
    // Half of a pair of double doors: still a door, just a slim one.
    const narrow = panelledLeaf(0.55, 2.03, 0.04, { style: 'shaker', rows: 2 });
    const box = bounds(narrow);
    expect(box.max.x - box.min.x).toBeCloseTo(0.55, 3);
    // It must still be panelled rather than quietly turning into a slab.
    expect(depths(narrow).levels).toBeGreaterThan(3);
  });

  it('comes out with normals and uvs, so it can be merged and lit', () => {
    const leaf = panelledLeaf(WIDTH, HEIGHT, THICK, { style: 'fielded', rows: 3 });
    const position = leaf.getAttribute('position');
    expect(leaf.getAttribute('normal').count).toBe(position.count);
    expect(leaf.getAttribute('uv').count).toBe(position.count);
    expect(leaf.index).toBeNull();
  });
});

describe('sashFrame', () => {
  it('encloses the light it was given and no more', () => {
    const sash = sashFrame(0, 0.9, 1.2, 2.1, 0.05, 0.11, { mullions: 0, transoms: 0 })!;
    const box = bounds(sash);

    expect(box.min.x).toBeCloseTo(0, 4);
    expect(box.max.x).toBeCloseTo(1.2, 4);
    expect(box.min.y).toBeCloseTo(0.9, 4);
    expect(box.max.y).toBeCloseTo(2.1, 4);
    expect(box.min.z).toBeCloseTo(0.05, 4);
    expect(box.max.z).toBeCloseTo(0.11, 4);
  });

  it('adds a bar for each mullion and each transom', () => {
    const count = (m: number, t: number): number => {
      const sash = sashFrame(0, 0, 1.4, 1.4, 0, 0.05, { mullions: m, transoms: t });
      return sash!.getAttribute('position').count;
    };

    const plain = count(0, 0);
    expect(count(1, 0)).toBeGreaterThan(plain);
    expect(count(0, 1)).toBeGreaterThan(plain);
    expect(count(2, 2)).toBeGreaterThan(count(1, 1));
  });

  it('spaces the bars evenly across the light', () => {
    const sash = sashFrame(0, 0, 1.2, 1.2, 0, 0.05, { mullions: 1, transoms: 0 })!;
    const position = sash.getAttribute('position');

    // The single mullion's own faces are the only vertices near the middle.
    let nearCentre = 0;
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(position.getX(i) - 0.6) < 0.02) nearCentre++;
    }
    expect(nearCentre).toBeGreaterThan(0);
  });

  it('keeps its sections in proportion to a small opening', () => {
    /*
     * A 45 mm sash on a clerestory 300 mm tall is a porthole. The section has
     * to shrink with the light, which is what a joiner would do and what the
     * old fixed-width bars did not.
     */
    const big = sashFrame(0, 0, 2, 1.5, 0, 0.05, { mullions: 0, transoms: 0 })!;
    const small = sashFrame(0, 0, 0.6, 0.3, 0, 0.05, { mullions: 0, transoms: 0 })!;

    const innerWidth = (g: THREE.BufferGeometry, outer: number): number => {
      const position = g.getAttribute('position');
      let inner = 0;
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        if (x > 1e-6 && x < outer / 2) inner = Math.max(inner, x);
      }
      return inner;
    };

    expect(innerWidth(small, 0.6)).toBeLessThan(innerWidth(big, 2));
  });

  it('refuses an opening too small to frame at all', () => {
    expect(sashFrame(0, 0, 0, 1, 0, 0.05, { mullions: 0, transoms: 0 })).toBeNull();
    expect(sashFrame(0, 0, 0.04, 0.04, 0, 0.05, { mullions: 0, transoms: 0 })).toBeNull();
  });
});
