/**
 * Every piece in the catalogue, measured against what the catalogue says it is.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS.
 *
 * Session 18 replaced the boxes that most of the catalogue was made of with
 * lathed, swept and lofted forms, and the first bug it produced was a rug whose
 * bound edge ran 35 mm BELOW the floorboards all the way round. On screen that
 * did not look like a bug. It looked like a rug with a chunky edge, which is a
 * thing that exists, and it survived a screenshot review. What found it was a
 * probe printing `minY = -0.035`.
 *
 * That is the shape of the whole risk in procedural geometry: a builder that is
 * subtly wrong produces a plausible object, and plausible objects pass visual
 * review. So the checks here are the ones a picture cannot make —
 *
 *   • nothing sinks through the floor;
 *   • nothing is meaningfully bigger than the dimensions the catalogue
 *     publishes, because those dimensions are the product's whole claim to
 *     being that product;
 *   • nothing is EMPTY, which is how a builder fails when a helper returns a
 *     degenerate geometry rather than throwing;
 *   • and nothing costs a budget-breaking number of triangles.
 *
 * `builders.test.ts` covers the other half — whether a form is rounded at all,
 * measured through its normals. This file is about size and position.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { buildFurniture, type FurniturePart } from './builders';
import { CATALOG } from './catalog';

/**
 * How far below the floor anything may reach.
 *
 * Two millimetres, which is float noise on a rotation and nothing else. A rug
 * hem, a castor or a glide that genuinely wants to touch y = 0 lands at zero;
 * anything at -0.005 is a mistake.
 */
const FLOOR_TOLERANCE = 0.002;

/**
 * How far past its declared size a piece may reach, in metres.
 *
 * Not zero, and deliberately. Real products overhang their nominal box: a
 * handle stands proud of a drawer front, a cushion swells past the frame, a
 * splayed leg lands outside the carcass. IKEA's own published dimensions are
 * the carcass, not the extremities. Seven centimetres is enough for a bow
 * handle and far too little to hide a builder that has lost track of its scale.
 */
const OVERHANG = 0.07;

/** The most any single product may cost. See the budget test for the reasoning. */
const TRIANGLE_CEILING = 40000;

function bounds(parts: readonly FurniturePart[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    const partBox = part.geometry.boundingBox;
    if (partBox) box.union(partBox);
  }
  return box;
}

function triangleCount(parts: readonly FurniturePart[]): number {
  let total = 0;
  for (const part of parts) {
    const geometry = part.geometry;
    const position = geometry.getAttribute('position');
    if (!position) continue;
    total += geometry.index ? geometry.index.count / 3 : position.count / 3;
  }
  return Math.round(total);
}

describe('every catalogue entry builds something the right size', () => {
  for (const entry of CATALOG) {
    describe(entry.id, () => {
      const size = { width: entry.width, depth: entry.depth, height: entry.height };
      const parts = buildFurniture(entry.build, size);
      const box = bounds(parts);

      it('builds at least one part', () => {
        expect(parts.length).toBeGreaterThan(0);
      });

      it('gives every part geometry with triangles in it', () => {
        /*
         * The failure mode this catches is quiet: `loft`, `sweep` and `lathe`
         * all return an EMPTY geometry rather than throwing when their input is
         * degenerate — a path with one point, a section with two, a zero
         * height. That is the right behaviour at runtime, because losing one
         * leg beats losing the scene, and it is exactly the behaviour that lets
         * a broken builder ship silently.
         */
        for (const part of parts) {
          const position = part.geometry.getAttribute('position');
          expect(position, `${entry.id}: a part has no position attribute`).toBeDefined();
          expect(position!.count).toBeGreaterThan(2);
        }
      });

      it('stands on the floor rather than through it', () => {
        expect(box.min.y).toBeGreaterThan(-FLOOR_TOLERANCE);
      });

      it('is no taller than it says it is', () => {
        // Beds declare a headboard height in the spec and an overall height in
        // the entry, and pillows sit above the mattress; everything else is
        // measured to its highest point.
        expect(box.max.y).toBeLessThan(entry.height + OVERHANG);
      });

      it('is no wider or deeper than it says it is', () => {
        expect(box.min.x).toBeGreaterThan(-entry.width / 2 - OVERHANG);
        expect(box.max.x).toBeLessThan(entry.width / 2 + OVERHANG);
        expect(box.min.z).toBeGreaterThan(-entry.depth / 2 - OVERHANG);
        expect(box.max.z).toBeLessThan(entry.depth / 2 + OVERHANG);
      });

      it('fills the footprint it claims, rather than rattling around in it', () => {
        /*
         * The other direction, and the one that catches a builder whose scale
         * has collapsed. A piece that comes out at a tenth of its size still
         * passes every bound above.
         */
        expect(box.max.x - box.min.x).toBeGreaterThan(entry.width * 0.6);
        expect(box.max.z - box.min.z).toBeGreaterThan(entry.depth * 0.6);
      });

      it('stays inside the triangle budget', () => {
        expect(triangleCount(parts)).toBeLessThan(TRIANGLE_CEILING);
      });
    });
  }
});

describe('the triangle budget for a whole room', () => {
  /*
   * -----------------------------------------------------------------------------
   * WHY A CEILING AND NOT A TARGET.
   *
   * Going into session 18 the intention was to spend triangles — the estimate
   * offered was half a million for a furnished room, up from seventy thousand.
   * Doing the work showed that estimate was wrong in an interesting way.
   *
   * Replacing a box leg with a tapered one made the leg BETTER and CHEAPER: a
   * `chamferedBox` costs 300 triangles regardless of how simple the shape is,
   * where a lofted square taper costs about fifty and actually changes down its
   * length. Several products came out of the rewrite smaller than they went in
   * — LACK fell from 1,500 triangles to under 700 — while looking considerably
   * more like themselves.
   *
   * The places that genuinely wanted more were the ones with a curve or a
   * surface: rugs, which went from one quad to twelve thousand triangles, and
   * turned forms like pedestals and lamp shades. That is the honest shape of
   * the result, and inflating the rest to hit a round number would buy nothing
   * an eye can see — the app's tessellation is already driven by a 0.4 mm
   * sagitta, so past a point the extra sides are arguing about less than the
   * width of a pencil line.
   *
   * So the number below is a ceiling, not a goal. It exists so a future change
   * cannot quietly put a hundred thousand triangles into a bookcase.
   */
  it('keeps a typical furnished living room under a quarter of a million triangles', () => {
    const room = ['soderhamn-3', 'lisabo-coffee', 'poang', 'morum-rug', 'lack-side', 'not-floor'];

    let total = 0;
    for (const id of room) {
      const entry = CATALOG.find((candidate) => candidate.id === id);
      expect(entry, `${id} is missing from the catalogue`).toBeDefined();
      total += triangleCount(
        buildFurniture(entry!.build, {
          width: entry!.width,
          depth: entry!.depth,
          height: entry!.height,
        }),
      );
    }

    expect(total).toBeLessThan(250000);
    // And is not trivially small either, which would mean a builder silently
    // returning nothing.
    expect(total).toBeGreaterThan(20000);
  });
});
