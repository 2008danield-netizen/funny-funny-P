/**
 * Tests for the construction build-ups.
 *
 * These are data, so most of what can go wrong is inconsistency: a build-up
 * whose layers do not add up to a thickness anybody builds, or whose insulation
 * does not match the R-value the rest of the app has for the same assembly id.
 * Both are invisible until somebody prints a section and measures it.
 */

import { describe, expect, it } from 'vitest';

import {
  FLOOR_BUILD_UPS,
  INTERMEDIATE_FLOOR_BUILD_UP,
  PARTITION_BUILD_UP,
  ROOF_BUILD_UPS,
  WALL_BUILD_UPS,
  buildUpThickness,
  nominalRFor,
  thicknessMismatch,
} from './buildUp';
import { FLOOR_ASSEMBLIES, ROOF_ASSEMBLIES, WALL_ASSEMBLIES } from '@/code/iecc';

describe('the build-ups', () => {
  it('covers every assembly the envelope can name', () => {
    // A missing build-up means a section falls back to a generic wall and
    // silently draws the wrong construction.
    for (const assembly of WALL_ASSEMBLIES) {
      expect(WALL_BUILD_UPS[assembly.id], assembly.id).toBeDefined();
    }
    for (const assembly of ROOF_ASSEMBLIES) {
      expect(ROOF_BUILD_UPS[assembly.id], assembly.id).toBeDefined();
    }
    for (const assembly of FLOOR_ASSEMBLIES) {
      expect(FLOOR_BUILD_UPS[assembly.id], assembly.id).toBeDefined();
    }
  });

  it('adds up to a thickness somebody could build', () => {
    for (const [id, buildUp] of Object.entries(WALL_BUILD_UPS)) {
      const thickness = buildUpThickness(buildUp);
      // Nothing thinner than a stud wall with two skins, nothing thicker than
      // a double-stud wall with continuous insulation on top.
      expect(thickness, id).toBeGreaterThan(0.1);
      expect(thickness, id).toBeLessThan(0.45);
    }
  });

  it('never has a layer of nothing', () => {
    const all = [
      ...Object.values(WALL_BUILD_UPS),
      ...Object.values(ROOF_BUILD_UPS),
      ...Object.values(FLOOR_BUILD_UPS),
      PARTITION_BUILD_UP,
      INTERMEDIATE_FLOOR_BUILD_UP,
    ];

    for (const buildUp of all) {
      expect(buildUp.layers.length, buildUp.label).toBeGreaterThan(0);
      for (const layer of buildUp.layers) {
        expect(layer.thickness, `${buildUp.label} / ${layer.name}`).toBeGreaterThan(0);
        expect(layer.name.length).toBeGreaterThan(0);
      }
    }
  });

  it('carries at least the insulation the assembly claims', () => {
    /*
     * The two figures are allowed to differ — the build-up adds its layers up
     * as if the studs were not there, while the IECC table carries the nominal
     * batt rating — but the build-up must never claim LESS than the assembly it
     * is the build-up for, or the drawing and the load calculation are
     * describing different walls.
     */
    for (const assembly of WALL_ASSEMBLIES) {
      const buildUp = WALL_BUILD_UPS[assembly.id]!;
      expect(nominalRFor(buildUp), assembly.id).toBeGreaterThanOrEqual(assembly.nominalR);
    }
    for (const assembly of ROOF_ASSEMBLIES) {
      const buildUp = ROOF_BUILD_UPS[assembly.id]!;
      expect(nominalRFor(buildUp), assembly.id).toBeGreaterThanOrEqual(assembly.nominalR);
    }
  });

  it('performs better as the assembly gets better', () => {
    // A monotonicity check: the whole ladder has to go up.
    const order = ['wall-2x4-r13', 'wall-2x6-r21', 'wall-2x6-r21-ci5', 'wall-2x6-r21-ci10'];
    for (let i = 1; i < order.length; i += 1) {
      expect(nominalRFor(WALL_BUILD_UPS[order[i]!]!)).toBeGreaterThan(
        nominalRFor(WALL_BUILD_UPS[order[i - 1]!]!),
      );
    }
  });

  it('puts the loft void above the insulation, not below it', () => {
    /*
     * Where the insulation sits is the difference between two completely
     * different buildings with completely different ventilation requirements.
     * In a ventilated loft it lies on the ceiling and the void above it is
     * outdoor air; drawing it following the rafters would be a different roof.
     */
    const loft = ROOF_BUILD_UPS['roof-r49']!;
    const voidIndex = loft.layers.findIndex((layer) => layer.hatch === 'void');
    const battIndex = loft.layers.findIndex((layer) => layer.hatch === 'batt');

    expect(voidIndex).toBeGreaterThanOrEqual(0);
    // Layers run outside face first, so the void comes before the insulation.
    expect(voidIndex).toBeLessThan(battIndex);
  });

  it('gives a partition no insulation, because it is not the envelope', () => {
    expect(nominalRFor(PARTITION_BUILD_UP)).toBeLessThan(2);
    expect(PARTITION_BUILD_UP.layers.some((layer) => layer.hatch === 'batt')).toBe(false);
  });
});

describe('the thickness check', () => {
  it('stays quiet when the drawn wall matches the assembly', () => {
    const buildUp = WALL_BUILD_UPS['wall-2x6-r21']!;
    expect(thicknessMismatch(buildUpThickness(buildUp), buildUp)).toBeNull();
  });

  it('forgives a couple of centimetres', () => {
    // One plasterboard choice versus another is not worth reporting.
    const buildUp = WALL_BUILD_UPS['wall-2x6-r21']!;
    expect(thicknessMismatch(buildUpThickness(buildUp) + 0.015, buildUp)).toBeNull();
  });

  it('catches a 2x6 assembly specified on a wall drawn far too thin', () => {
    /*
     * The conflict the section is the first drawing able to see. A 100 mm wall
     * cannot contain a 140 mm stud, and until there was a section nothing in
     * the app compared the two facts.
     */
    const buildUp = WALL_BUILD_UPS['wall-2x6-r21']!;
    const mismatch = thicknessMismatch(0.1, buildUp)!;

    expect(mismatch).not.toBeNull();
    expect(mismatch.real).toBeGreaterThan(0.17);
    expect(mismatch.difference).toBeGreaterThan(0);
  });

  it('catches a wall drawn far too thick as well', () => {
    const buildUp = WALL_BUILD_UPS['wall-2x4-r13']!;
    const mismatch = thicknessMismatch(0.4, buildUp)!;
    expect(mismatch.difference).toBeLessThan(0);
  });
});
