/**
 * Tests for schema migration and document validation.
 *
 * Anyone who opened havavamama during session 1 has a v1 document in their
 * browser. Losing their room to a schema change would be inexcusable, and it is
 * the kind of failure that never shows up in development — where localStorage
 * is always empty — so it is covered here instead.
 */

import { describe, expect, it } from 'vitest';

import { sanitizeDocument } from './defaults';
import { findRegions } from '@/scene/planGraph';
import { resolveRoomSpec } from './planOps';

/** A document exactly as session 1 wrote it. */
function v1Document() {
  return {
    schemaVersion: 1,
    name: 'My Living Room',
    updatedAt: '2026-01-01T00:00:00.000Z',
    units: 'imperial',
    room: {
      width: 5,
      depth: 4,
      height: 2.8,
      wallThickness: 0.15,
      walls: {
        north: { color: '#b9755c', roughness: 0.88 },
        east: { color: '#ece7df', roughness: 0.88 },
        south: { color: '#ece7df', roughness: 0.88 },
        west: { color: '#ece7df', roughness: 0.88 },
      },
      floor: { presetId: 'walnut-plank', color: '#ffffff', textureScale: 1.2 },
      ceiling: { color: '#f7f5f2', visible: true },
    },
    lighting: { presetId: 'evening', intensity: 1.2, shadowsEnabled: false },
  };
}

describe('v1 to v2 migration', () => {
  it('keeps the name, units and lighting', () => {
    const doc = sanitizeDocument(v1Document());
    // A v1 document is carried all the way to the current schema, not just to
    // the next one: the migration chain runs every step in order.
    expect(doc.schemaVersion).toBe(3);
    expect(doc.furniture).toEqual([]);
    expect(doc.name).toBe('My Living Room');
    expect(doc.units).toBe('imperial');
    expect(doc.lighting.presetId).toBe('evening');
    expect(doc.lighting.intensity).toBeCloseTo(1.2, 6);
    expect(doc.lighting.shadowsEnabled).toBe(false);
    // v1 stored ceiling visibility per room; v2 makes it document-wide.
    expect(doc.showCeilings).toBe(true);
  });

  it('rebuilds the room at the right size', () => {
    const doc = sanitizeDocument(v1Document());
    expect(doc.plan.vertices).toHaveLength(4);
    expect(doc.plan.walls).toHaveLength(4);

    const regions = findRegions(doc.plan);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(20, 4);

    for (const wall of doc.plan.walls) {
      expect(wall.height).toBeCloseTo(2.8, 6);
      expect(wall.thickness).toBeCloseTo(0.15, 6);
    }
  });

  it('keeps the floor material the user chose', () => {
    const doc = sanitizeDocument(v1Document());
    const region = findRegions(doc.plan)[0]!;
    const spec = resolveRoomSpec(doc.plan, region.key);

    expect(spec.floor.presetId).toBe('walnut-plank');
    expect(spec.floor.textureScale).toBeCloseTo(1.2, 6);
  });

  it('puts the accent wall colour on the side facing into the room', () => {
    const doc = sanitizeDocument(v1Document());
    const region = findRegions(doc.plan)[0]!;

    // v1 walls were single-sided: only the interior was ever visible. The
    // terracotta must therefore land on whichever face now looks inwards, not
    // on the blank outside of the building.
    const accentWall = doc.plan.walls.find(
      (wall) => wall.faces.a?.color === '#b9755c' || wall.faces.b?.color === '#b9755c',
    );
    expect(accentWall).toBeDefined();

    const paintedSide = accentWall!.faces.a?.color === '#b9755c' ? 'a' : 'b';
    expect(region.facing[accentWall!.id]).toBe(paintedSide);

    // Exactly ONE wall is an accent. The other three shared a colour, so that
    // colour becomes the room's paint and they carry no override — otherwise a
    // three-cream-one-terracotta room comes back as four terracotta walls.
    const overridden = doc.plan.walls.filter(
      (wall) => wall.faces.a !== undefined || wall.faces.b !== undefined,
    );
    expect(overridden).toHaveLength(1);
    expect(resolveRoomSpec(doc.plan, region.key).wall.color).toBe('#ece7df');
  });

  it('treats a document with no version at all as v1', () => {
    const legacy = { ...v1Document() } as Record<string, unknown>;
    delete legacy.schemaVersion;

    const doc = sanitizeDocument(legacy);
    expect(doc.schemaVersion).toBe(3);
    expect(findRegions(doc.plan)).toHaveLength(1);
  });

  it('leaves a v2 document alone', () => {
    const once = sanitizeDocument(v1Document());
    const twice = sanitizeDocument(once);

    expect(twice.plan.walls).toHaveLength(4);
    expect(findRegions(twice.plan)[0]!.area).toBeCloseTo(20, 4);
  });
});

describe('sanitizeDocument', () => {
  it('falls back to the starter room for junk input', () => {
    for (const input of [null, undefined, 42, 'nonsense', {}, { plan: 'no' }]) {
      const doc = sanitizeDocument(input);
      expect(doc.plan.walls.length).toBeGreaterThan(0);
      expect(findRegions(doc.plan).length).toBeGreaterThan(0);
    }
  });

  it('drops walls that point at vertices which do not exist', () => {
    const doc = sanitizeDocument({
      schemaVersion: 2,
      plan: {
        vertices: [
          { id: 'v1', x: 0, z: 0 },
          { id: 'v2', x: 3, z: 0 },
        ],
        walls: [
          { id: 'w1', start: 'v1', end: 'v2', thickness: 0.1, height: 2.5 },
          // Dangling reference: there is no v9.
          { id: 'w2', start: 'v2', end: 'v9', thickness: 0.1, height: 2.5 },
        ],
        rooms: {},
      },
    });

    // The broken wall is gone and the sound one is kept. Note that the plan is
    // NOT replaced with the starter room here: one wall enclosing nothing is a
    // perfectly legitimate work-in-progress, and throwing it away would destroy
    // a half-drawn plan. The starter room is only substituted when validation
    // leaves no walls at all.
    expect(doc.plan.walls).toHaveLength(1);
    expect(doc.plan.walls[0]!.id).toBe('w1');
    expect(findRegions(doc.plan)).toHaveLength(0);
  });

  it('clamps out-of-range numbers instead of trusting them', () => {
    const doc = sanitizeDocument({
      schemaVersion: 2,
      plan: {
        vertices: [
          { id: 'v1', x: 0, z: 0 },
          { id: 'v2', x: 4, z: 0 },
          { id: 'v3', x: 4, z: 3 },
          { id: 'v4', x: 0, z: 3 },
        ],
        walls: [
          { id: 'w1', start: 'v1', end: 'v2', thickness: 99, height: -5 },
          { id: 'w2', start: 'v2', end: 'v3', thickness: 0.1, height: 2.5 },
          { id: 'w3', start: 'v3', end: 'v4', thickness: 0.1, height: 2.5 },
          { id: 'w4', start: 'v4', end: 'v1', thickness: 0.1, height: 2.5 },
        ],
        rooms: {},
        defaultWallHeight: 2.5,
        defaultWallThickness: 0.1,
      },
      lighting: { presetId: 'nope', intensity: 500 },
    });

    const wall = doc.plan.walls.find((candidate) => candidate.id === 'w1')!;
    expect(wall.thickness).toBeLessThanOrEqual(0.6);
    expect(wall.height).toBeGreaterThanOrEqual(2);
    expect(doc.lighting.presetId).toBe('daylight');
    expect(doc.lighting.intensity).toBeLessThanOrEqual(2);
  });

  it('survives a round trip through JSON', () => {
    const doc = sanitizeDocument(v1Document());
    const restored = sanitizeDocument(JSON.parse(JSON.stringify(doc)));

    expect(restored.name).toBe(doc.name);
    expect(restored.plan.walls).toHaveLength(doc.plan.walls.length);
    expect(findRegions(restored.plan)[0]!.area).toBeCloseTo(
      findRegions(doc.plan)[0]!.area,
      6,
    );
  });
});
