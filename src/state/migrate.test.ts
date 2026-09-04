/**
 * Tests for schema migration and document validation.
 *
 * Anyone who opened havavamama during session 1 has a v1 document in their
 * browser. Losing their room to a schema change would be inexcusable, and it is
 * the kind of failure that never shows up in development — where localStorage
 * is always empty — so it is covered here instead.
 */

import { describe, expect, it } from 'vitest';

import { activeLevel } from '@/state/levels';
import type { DesignDocument, Level } from '@/state/types';

import { sanitizeDocument } from './defaults';
import { findRegions } from '@/scene/planGraph';
import { resolveRoomSpec } from './planOps';

/**
 * The storey a test is working on.
 *
 * Every fixture here is a one-level building, so this is always its ground
 * floor — but going through the accessor rather than reaching for `levels[0]`
 * means these tests exercise the same path the app does.
 */
function level(doc: DesignDocument): Level {
  return activeLevel(doc);
}

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
    expect(doc.schemaVersion).toBe(5);
    expect(level(doc).furniture).toEqual([]);
    // v4 additions arrive with safe defaults. Strict clearance in particular
    // must default OFF: an old design was laid out under no clearance rules,
    // and switching them on as hard constraints would greet the user with a
    // layout their own app now refuses to let them recreate.
    expect(doc.clearance.strict).toBe(false);
    expect(doc.currency).toBe('EUR');
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
    expect(level(doc).plan.vertices).toHaveLength(4);
    expect(level(doc).plan.walls).toHaveLength(4);

    const regions = findRegions(level(doc).plan);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(20, 4);

    for (const wall of level(doc).plan.walls) {
      expect(wall.height).toBeCloseTo(2.8, 6);
      expect(wall.thickness).toBeCloseTo(0.15, 6);
    }
  });

  it('keeps the floor material the user chose', () => {
    const doc = sanitizeDocument(v1Document());
    const region = findRegions(level(doc).plan)[0]!;
    const spec = resolveRoomSpec(level(doc).plan, region.key);

    expect(spec.floor.presetId).toBe('walnut-plank');
    expect(spec.floor.textureScale).toBeCloseTo(1.2, 6);
  });

  it('puts the accent wall colour on the side facing into the room', () => {
    const doc = sanitizeDocument(v1Document());
    const region = findRegions(level(doc).plan)[0]!;

    // v1 walls were single-sided: only the interior was ever visible. The
    // terracotta must therefore land on whichever face now looks inwards, not
    // on the blank outside of the building.
    const accentWall = level(doc).plan.walls.find(
      (wall) => wall.faces.a?.color === '#b9755c' || wall.faces.b?.color === '#b9755c',
    );
    expect(accentWall).toBeDefined();

    const paintedSide = accentWall!.faces.a?.color === '#b9755c' ? 'a' : 'b';
    expect(region.facing[accentWall!.id]).toBe(paintedSide);

    // Exactly ONE wall is an accent. The other three shared a colour, so that
    // colour becomes the room's paint and they carry no override — otherwise a
    // three-cream-one-terracotta room comes back as four terracotta walls.
    const overridden = level(doc).plan.walls.filter(
      (wall) => wall.faces.a !== undefined || wall.faces.b !== undefined,
    );
    expect(overridden).toHaveLength(1);
    expect(resolveRoomSpec(level(doc).plan, region.key).wall.color).toBe('#ece7df');
  });

  it('treats a document with no version at all as v1', () => {
    const legacy = { ...v1Document() } as Record<string, unknown>;
    delete legacy.schemaVersion;

    const doc = sanitizeDocument(legacy);
    expect(doc.schemaVersion).toBe(5);
    expect(findRegions(level(doc).plan)).toHaveLength(1);
  });

  it('leaves a v2 document alone', () => {
    const once = sanitizeDocument(v1Document());
    const twice = sanitizeDocument(once);

    expect(level(twice).plan.walls).toHaveLength(4);
    expect(findRegions(level(twice).plan)[0]!.area).toBeCloseTo(20, 4);
  });
});

describe('sanitizeDocument', () => {
  it('falls back to the starter room for junk input', () => {
    for (const input of [null, undefined, 42, 'nonsense', {}, { plan: 'no' }]) {
      const doc = sanitizeDocument(input);
      expect(level(doc).plan.walls.length).toBeGreaterThan(0);
      expect(findRegions(level(doc).plan).length).toBeGreaterThan(0);
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
    expect(level(doc).plan.walls).toHaveLength(1);
    expect(level(doc).plan.walls[0]!.id).toBe('w1');
    expect(findRegions(level(doc).plan)).toHaveLength(0);
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

    const wall = level(doc).plan.walls.find((candidate) => candidate.id === 'w1')!;
    expect(wall.thickness).toBeLessThanOrEqual(0.6);
    expect(wall.height).toBeGreaterThanOrEqual(2);
    expect(doc.lighting.presetId).toBe('daylight');
    expect(doc.lighting.intensity).toBeLessThanOrEqual(2);
  });

  it('survives a round trip through JSON', () => {
    const doc = sanitizeDocument(v1Document());
    const restored = sanitizeDocument(JSON.parse(JSON.stringify(doc)));

    expect(restored.name).toBe(doc.name);
    expect(level(restored).plan.walls).toHaveLength(level(doc).plan.walls.length);
    expect(findRegions(level(restored).plan)[0]!.area).toBeCloseTo(
      findRegions(level(doc).plan)[0]!.area,
      6,
    );
  });
});

describe('v4 to v5 migration', () => {
  /** A v4 document: one plan, furniture on it, no notion of storeys. */
  function v4Document() {
    const doc = sanitizeDocument(v1Document()) as unknown as Record<string, unknown>;
    const upgraded = structuredClone(doc);
    const ground = (upgraded.levels as Array<Record<string, unknown>>)[0]!;
    // Rewind it to what v4 actually looked like.
    return {
      ...upgraded,
      schemaVersion: 4,
      plan: ground.plan,
      furniture: [{ id: 'f1', catalogId: 'kivik-3', x: 0, z: 0, y: 0, rotation: 0 }],
      levels: undefined,
      activeLevelId: undefined,
    };
  }

  it('turns one plan into the ground floor of a one-storey building', () => {
    const doc = sanitizeDocument(v4Document());

    expect(doc.schemaVersion).toBe(5);
    expect(doc.levels).toHaveLength(1);
    expect(doc.activeLevelId).toBe(doc.levels[0]!.id);
    // US convention: the storey at ground level is the First Floor.
    expect(doc.levels[0]!.name).toBe('First Floor');
  });

  it('carries the plan and the furniture down onto that storey', () => {
    const doc = sanitizeDocument(v4Document());
    const ground = level(doc);

    // The room the user drew is still there, at the size they drew it.
    expect(findRegions(ground.plan)).toHaveLength(1);
    expect(findRegions(ground.plan)[0]!.area).toBeCloseTo(20, 4);
    // And so is what they put in it.
    expect(ground.furniture).toHaveLength(1);
    expect(ground.furniture[0]!.catalogId).toBe('kivik-3');
  });

  it('takes the storey height from the walls the user was drawing', () => {
    const doc = sanitizeDocument(v4Document());
    // The v1 room had a 2.8 m ceiling, so that is the storey height — not the
    // app's default. Resetting it would shorten somebody's room silently.
    expect(level(doc).wallHeight).toBeCloseTo(2.8, 6);
  });

  it('leaves no trace of the old shape behind', () => {
    // Two places to look for the same plan is how one of them goes stale.
    const doc = sanitizeDocument(v4Document()) as unknown as Record<string, unknown>;
    expect(doc.plan).toBeUndefined();
    expect(doc.furniture).toBeUndefined();
  });

  it('gives the building somewhere to put roofs, services and a site', () => {
    const doc = sanitizeDocument(v4Document());
    expect(doc.stairs).toEqual([]);
    expect(doc.roofs).toEqual([]);
    expect(doc.services).toEqual([]);
    expect(doc.site.northAngle).toBe(0);
  });

  it('is idempotent', () => {
    const once = sanitizeDocument(v4Document());
    const twice = sanitizeDocument(structuredClone(once));
    expect(twice.levels).toHaveLength(1);
    expect(findRegions(level(twice).plan)[0]!.area).toBeCloseTo(20, 4);
  });
});

describe('level validation', () => {
  it('always leaves at least one storey to draw on', () => {
    const doc = sanitizeDocument({ schemaVersion: 5, levels: [] });
    expect(doc.levels.length).toBeGreaterThan(0);
    expect(findRegions(level(doc).plan).length).toBeGreaterThan(0);
  });

  it('forces level IDs to be unique', () => {
    // Two storeys sharing an ID makes "which level is active" ambiguous, and
    // the editor would write to one while drawing the other.
    const doc = sanitizeDocument({
      schemaVersion: 5,
      levels: [
        { id: 'same', name: 'One' },
        { id: 'same', name: 'Two' },
      ],
      activeLevelId: 'same',
    });
    expect(new Set(doc.levels.map((entry) => entry.id)).size).toBe(doc.levels.length);
  });

  it('falls back to the lowest storey when the active one is missing', () => {
    const doc = sanitizeDocument({
      schemaVersion: 5,
      levels: [{ id: 'lv1', name: 'First Floor' }],
      activeLevelId: 'nonexistent',
    });
    expect(doc.activeLevelId).toBe('lv1');
  });

  it('drops a staircase whose storey no longer exists', () => {
    // It has no rise to climb and no floor to stand on. Reassigning it to some
    // other level would move somebody's staircase without telling them.
    const doc = sanitizeDocument({
      schemaVersion: 5,
      levels: [{ id: 'lv1', name: 'First Floor' }],
      activeLevelId: 'lv1',
      stairs: [
        { id: 's1', fromLevelId: 'gone', at: { x: 0, z: 0 } },
        { id: 's2', fromLevelId: 'lv1', at: { x: 0, z: 0 } },
      ],
    });
    expect(doc.stairs.map((stair) => stair.id)).toEqual(['s2']);
  });
});
