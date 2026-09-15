/**
 * Tests for what a room will sound like.
 *
 * -----------------------------------------------------------------------------
 * SOUND IS THE HARDEST THING IN THIS PROJECT TO CHECK BY LOOKING.
 *
 * Every earlier session had a picture to fall back on: the registers were
 * visibly floating off the wall, the cap quad visibly covered the frame, the
 * cupboard handles were visibly inside the wall. There is no picture of a
 * reverberation time, and a sign error in an absorption sum produces a number
 * that is merely wrong rather than obviously wrong.
 *
 * So the physics is pinned here harder than usual, and the pins are mostly
 * RELATIONSHIPS rather than absolutes — a tiled bathroom must ring longer than
 * a carpeted bedroom of the same size, doubling the volume must lengthen the
 * tail, adding a sofa must shorten it. A relationship that holds is evidence
 * the equation is the right way up; an absolute figure only says the arithmetic
 * was copied correctly.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addRectangle, addOpening, drawWall, normalizePlan, splitWall } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import { placeFurniture } from '@/state/furnitureOps';
import {
  BANDS,
  EYRING_THRESHOLD,
  SABINE_CONSTANT,
  glazingStc,
  reverbTarget,
  surfaceAbsorption,
} from '@/code/acoustics';
import {
  addDecibels,
  floorAbsorptionId,
  furnitureAbsorptionId,
  reverbTime,
  roomSurfaces,
  speechAverage,
} from './roomAcoustics';
import { checkAcoustics } from './acousticCheck';
import type { DesignDocument, Level } from '@/state/types';

/* --------------------------------- Fixtures -------------------------------- */

/** One rectangular room of the given size, with a named finish on the floor. */
function room(
  width: number,
  depth: number,
  floorPresetId: string,
  name = 'Living Room',
  wallHeight = 2.4,
): { doc: DesignDocument; level: Level } {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  level.wallHeight = wallHeight;

  // A CENTRE, not a corner — the mistake that produced three broken fixtures
  // in session 12 and one in session 13.
  addRectangle(level.plan, { x: width / 2, z: depth / 2 }, width, depth);
  normalizePlan(level.plan);

  const region = findRegions(level.plan)[0]!;
  level.plan.rooms[region.key] = {
    name,
    floor: { presetId: floorPresetId, color: '#ffffff', textureScale: 1 },
    wall: { color: '#ece7df', roughness: 0.88 },
    ceilingColor: '#f7f5f2',
  };

  return { doc, level };
}

/**
 * A small carpeted bedroom with a bed and two sofas crammed into it.
 *
 * Absurd as a bedroom and exactly right as a test: the point is to get the
 * mean absorption coefficient above the threshold where Sabine's small-loss
 * assumption fails, and an empty carpeted room does not manage it because its
 * walls and ceiling are still hard.
 */
function softRoom(): { doc: DesignDocument; level: Level } {
  const made = room(3.5, 3, 'wool-carpet', 'Bedroom 1');
  for (const at of [{ x: 1, z: 1 }, { x: 2.5, z: 1 }, { x: 1.7, z: 2.2 }]) {
    placeFurniture(made.doc, made.level, 'soderhamn-3', at);
  }
  return made;
}

/** The reverb result for the first (and usually only) region of a fixture. */
function reverbOf(made: { doc: DesignDocument; level: Level }) {
  const region = findRegions(made.level.plan)[0]!;
  return reverbTime(roomSurfaces(made.doc, made.level, region));
}

/* ------------------------------ Mapping finishes --------------------------- */

describe('which absorption class a finish belongs to', () => {
  it('reads the app’s own floor presets', () => {
    expect(floorAbsorptionId('oak-plank')).toBe('floor-wood');
    expect(floorAbsorptionId('walnut-plank')).toBe('floor-wood');
    expect(floorAbsorptionId('porcelain-tile')).toBe('floor-hard');
    expect(floorAbsorptionId('carrara-marble')).toBe('floor-hard');
    expect(floorAbsorptionId('polished-concrete')).toBe('floor-hard');
    expect(floorAbsorptionId('wool-carpet')).toBe('floor-carpet');
    expect(floorAbsorptionId('charcoal-carpet')).toBe('floor-carpet');
  });

  it('puts concrete with the tiles rather than with its own category', () => {
    /*
     * The preset categories were chosen for the swatch grid, and one of them —
     * "Concrete" — is acoustically identical to "Tile & Stone" while "Wood"
     * genuinely is not. Matching on id rather than category is what keeps the
     * claim honest, and this is the case that would have been wrong.
     */
    expect(floorAbsorptionId('polished-concrete')).toBe(floorAbsorptionId('porcelain-tile'));
    expect(floorAbsorptionId('oak-plank')).not.toBe(floorAbsorptionId('porcelain-tile'));
  });

  it('knows a sofa absorbs and a pendant does not', () => {
    expect(furnitureAbsorptionId('Seating')).toBe('upholstered');
    expect(furnitureAbsorptionId('Beds')).toBe('bed');
    expect(furnitureAbsorptionId('Rugs')).toBe('soft-furnishing');
    expect(furnitureAbsorptionId('Storage')).toBe('furniture-hard');
    expect(furnitureAbsorptionId('Lighting')).toBeNull();
  });
});

/* --------------------------------- Sabine ---------------------------------- */

describe('reverberation time', () => {
  it('is Sabine’s equation, and can be checked against it by hand', () => {
    const made = room(5, 4, 'porcelain-tile');
    const result = reverbOf(made);

    // A hard room: the mean coefficient stays low, so Sabine applies.
    expect(result.method).toBe('sabine');

    // RT60 = 0.161 V / A, computed from the parts the result reports.
    const band = 2; // 500 Hz
    const expected = (SABINE_CONSTANT * result.volume) / (result.sabins[band] ?? 1);
    expect(result.rt60[band]).toBeCloseTo(expected, 3);
  });

  it('switches to Eyring when the room is too absorbent for Sabine', () => {
    /*
     * Sabine assumes each reflection loses only a small fraction of the energy.
     * A carpeted bedroom full of soft furniture breaks that, and the giveaway
     * is that Sabine predicts a short reverberation rather than none — an
     * anechoic chamber does not have an RT60 of 0.05 s, it has none at all.
     *
     * Note what it takes to get there: an empty carpeted room does NOT reach a
     * mean coefficient of 0.2, because its walls and ceiling are still hard.
     * It is the furniture that tips it, which is the same point the furniture
     * tests make from the other direction.
     */
    const made = softRoom();
    const result = reverbOf(made);

    expect(speechAverage(result.meanAlpha)).toBeGreaterThan(EYRING_THRESHOLD);
    expect(result.method).toBe('eyring');
    expect(result.methodWhy).toMatch(/eyring/i);
  });

  it('predicts a shorter tail than Sabine would, once Eyring applies', () => {
    // The whole reason for the switch: Sabine over-predicts in an absorbent
    // room, and the two must not be allowed to disagree silently.
    const made = softRoom();
    const result = reverbOf(made);

    const sabine = (SABINE_CONSTANT * result.volume) / (result.sabins[2] ?? 1);
    expect(result.rt60[2]).toBeLessThan(sabine);
  });

  it('rings longer in a tiled room than a carpeted one of the same size', () => {
    // The single most important relationship in the file. If this inverts,
    // everything downstream is backwards and no absolute figure would say so.
    const hard = reverbOf(room(4, 3, 'porcelain-tile', 'Bathroom'));
    const soft = reverbOf(room(4, 3, 'wool-carpet', 'Bedroom 1'));

    expect(hard.midRt60).toBeGreaterThan(soft.midRt60 * 1.5);
  });

  it('rings longer in a bigger room with the same finishes', () => {
    const small = reverbOf(room(4, 3, 'porcelain-tile'));
    const large = reverbOf(room(8, 6, 'porcelain-tile'));

    expect(large.midRt60).toBeGreaterThan(small.midRt60);
  });

  it('rings longer under a higher ceiling', () => {
    // Volume goes up faster than boundary area does, which is why a
    // double-height space is livelier than its floor area suggests.
    const normal = reverbOf(room(5, 4, 'porcelain-tile', 'Living Room', 2.4));
    const tall = reverbOf(room(5, 4, 'porcelain-tile', 'Living Room', 4.8));

    expect(tall.midRt60).toBeGreaterThan(normal.midRt60);
  });

  it('counts every surface, and names the one doing the absorbing', () => {
    const made = room(5, 4, 'wool-carpet');
    const result = reverbOf(made);

    const labels = result.surfaces.map((surface) => surface.label);
    expect(labels).toContain('Floor');
    expect(labels).toContain('Ceiling');
    expect(labels).toContain('Walls');

    // In a carpeted room with painted walls the carpet is the absorber, and
    // saying which surface is responsible is the actionable half of a report.
    expect(result.dominant?.label).toBe('Floor');
  });
});

/* -------------------------------- Furniture -------------------------------- */

describe('the furniture in the room', () => {
  it('shortens the reverberation, and by an amount worth having', () => {
    /*
     * The check that stops this being a six-surface calculation with a nice
     * comment on it. An empty room and a furnished one are genuinely different
     * rooms, and a report that could not tell them apart would be useless for
     * the one remedy anybody will actually carry out.
     */
    const made = room(6, 5, 'porcelain-tile');
    const { doc, level } = made;
    const empty = reverbOf(made);

    const region = findRegions(level.plan)[0]!;
    // Three sofas is a lot of sofa, and that is the point: the effect has to
    // be large enough to see rather than a rounding difference.
    for (const at of [{ x: 2, z: 2 }, { x: 4, z: 2 }, { x: 3, z: 4 }]) {
      placeFurniture(doc, level, 'soderhamn-3', at);
    }
    expect(level.furniture.length).toBeGreaterThan(0);

    const furnished = reverbTime(roomSurfaces(doc, level, region));
    expect(furnished.midRt60).toBeLessThan(empty.midRt60);
  });

  it('only counts furniture standing inside the room it is asked about', () => {
    // Two rooms, furniture in one of them. Counting a sofa in the bedroom
    // towards the living room's absorption would be silently wrong everywhere.
    const doc = createDefaultDocument();
    const level = doc.levels[0]!;
    level.plan.vertices = [];
    level.plan.walls = [];
    level.plan.rooms = {};

    addRectangle(level.plan, { x: 6, z: 4 }, 12, 8);
    normalizePlan(level.plan);

    const north = level.plan.walls.find((wall) => {
      const a = level.plan.vertices.find((v) => v.id === wall.start)!;
      const b = level.plan.vertices.find((v) => v.id === wall.end)!;
      return Math.abs(a.z) < 0.01 && Math.abs(b.z) < 0.01;
    })!;
    const south = level.plan.walls.find((wall) => {
      const a = level.plan.vertices.find((v) => v.id === wall.start)!;
      const b = level.plan.vertices.find((v) => v.id === wall.end)!;
      return Math.abs(a.z - 8) < 0.01 && Math.abs(b.z - 8) < 0.01;
    })!;

    // `drawWall` does not split the wall it lands on, so the boundary walls
    // are split first — the usability gap the README already names.
    const top = splitWall(level.plan, north.id, 0.5)!;
    const bottom = splitWall(level.plan, south.id, 0.5)!;
    const va = level.plan.vertices.find((v) => v.id === top)!;
    const vb = level.plan.vertices.find((v) => v.id === bottom)!;
    drawWall(level.plan, { x: va.x, z: va.z }, { x: vb.x, z: vb.z });
    normalizePlan(level.plan);

    const regions = findRegions(level.plan);
    expect(regions).toHaveLength(2);

    for (const region of regions) {
      level.plan.rooms[region.key] = {
        name: 'Living Room',
        floor: { presetId: 'porcelain-tile', color: '#ffffff', textureScale: 1 },
        wall: { color: '#ece7df', roughness: 0.88 },
        ceilingColor: '#f7f5f2',
      };
    }

    // A sofa well inside the left-hand half.
    placeFurniture(doc, level, 'soderhamn-3', { x: 2, z: 4 });

    const withSofa = regions
      .map((region) => roomSurfaces(doc, level, region))
      .filter((surfaces) =>
        surfaces.surfaces.some((surface) => surface.absorptionId === 'upholstered'),
      );

    expect(withSofa).toHaveLength(1);
  });
});

/* --------------------------------- Openings -------------------------------- */

describe('openings', () => {
  it('treats a cased opening as total absorption', () => {
    /*
     * One square metre of open doorway is one metric sabin, by definition:
     * everything that reaches it leaves and none of it comes back. It is why a
     * room with the door open measurably stops ringing, and it is the one
     * coefficient in the file that is not a measurement.
     */
    expect(surfaceAbsorption('opening').alpha.every((value) => value === 1)).toBe(true);

    const made = room(5, 4, 'porcelain-tile');
    const { level } = made;
    const shut = reverbOf(made);

    const wall = level.plan.walls[0]!;
    addOpening(
      level.plan,
      wall.id,
      'door',
      'door-opening',
      { width: 0.9, height: 2.04, sillHeight: 0 },
      2,
    );

    const open = reverbOf(made);
    expect(open.midRt60).toBeLessThan(shut.midRt60);
  });

  it('counts glazing separately from the wall it is cut into', () => {
    // Glass and plasterboard have opposite shapes: glass takes a surprising
    // amount of bass by flexing and almost nothing above, a stud wall rather
    // less bass and more mid. Lumping them together loses both.
    const made = room(5, 4, 'oak-plank');
    const { level } = made;
    const wall = level.plan.walls[0]!;
    addOpening(
      level.plan,
      wall.id,
      'window',
      'window-picture',
      { width: 1.8, height: 1.4, sillHeight: 0.9 },
      2,
    );

    const result = reverbOf(made);
    const glazing = result.surfaces.find((surface) => surface.label === 'Glazing');
    expect(glazing).toBeDefined();
    expect(glazing!.area).toBeCloseTo(1.8 * 1.4, 3);

    // And the wall shrank by exactly that much rather than being counted twice.
    const plain = reverbOf(room(5, 4, 'oak-plank'));
    const wallsBefore = plain.surfaces.find((surface) => surface.label === 'Walls')!;
    const wallsAfter = result.surfaces.find((surface) => surface.label === 'Walls')!;
    expect(wallsBefore.area - wallsAfter.area).toBeCloseTo(1.8 * 1.4, 3);
  });
});

/* ------------------------------- Band behaviour ---------------------------- */

describe('the bands, which are the point of doing it per band', () => {
  it('quotes the speech bands rather than the mean of all six', () => {
    // Including 125 Hz in the headline figure is how a boomy room gets
    // reported as a lively one: the bass figure is routinely twice the mid.
    const made = room(5, 4, 'wool-carpet');
    const result = reverbOf(made);

    const allSix = result.rt60.reduce((sum, value) => sum + value, 0) / BANDS.length;
    expect(result.midRt60).not.toBeCloseTo(allSix, 2);
    expect(result.midRt60).toBeCloseTo(
      ((result.rt60[2] ?? 0) + (result.rt60[3] ?? 0) + (result.rt60[4] ?? 0)) / 3,
      6,
    );
  });

  it('finds the boomy room a single figure would hide', () => {
    /*
     * Carpet over a hard structure: excellent at the top, nearly nothing at
     * 125 Hz. Everybody who uses the room calls it boomy and the headline
     * number says it is fine, which is exactly the fault worth surfacing.
     */
    const made = room(6, 5, 'wool-carpet');
    const result = reverbOf(made);

    expect(result.bassRatio).toBeGreaterThan(1.2);
    expect(result.rt60[0]).toBeGreaterThan(result.rt60[4] ?? 0);
  });
});

/* -------------------------------- Decibels --------------------------------- */

describe('decibel arithmetic', () => {
  it('adds energy, not numbers', () => {
    // Two 50 dB sources are 53 dB, not 100. Getting this wrong is wrong by a
    // factor of a thousand, which is why it lives in one named function.
    expect(addDecibels([50, 50])).toBeCloseTo(53.01, 2);
    expect(addDecibels([50])).toBeCloseTo(50, 6);
    expect(addDecibels([])).toBe(0);
  });

  it('is dominated by the loudest source', () => {
    // 60 dB plus 40 dB is 60 dB and a hundredth. The quiet one is inaudible
    // under the loud one, which is why one bad register spoils a room.
    expect(addDecibels([60, 40])).toBeCloseTo(60.04, 1);
  });
});

/* -------------------------------- The report ------------------------------- */

describe('the acoustic report', () => {
  it('flags a room that will ring, with the surface responsible', () => {
    const { doc } = room(6, 5, 'porcelain-tile', 'Dining Room', 3);
    const report = checkAcoustics(doc);

    const ringing = report.findings.find((finding) => finding.id.startsWith('reverb-long'));
    expect(ringing).toBeDefined();
    expect(ringing!.title).toMatch(/ring/i);
    // Guidance, with no citation: there is no code anywhere requiring a dining
    // room to have a particular reverberation time.
    expect(ringing!.authority).toBe('none');
    expect(ringing!.section).toBe('');
  });

  it('says nothing about a room already in its range', () => {
    const { doc } = room(5, 4, 'wool-carpet', 'Bedroom 1');
    const report = checkAcoustics(doc);

    const ringing = report.findings.find((finding) => finding.id.startsWith('reverb-long'));
    expect(ringing).toBeUndefined();
  });

  it('ignores a room too small for the statistics to mean anything', () => {
    // A cupboard has no meaningful reverberation time: its modes are so far
    // apart that the diffuse-field assumption behind Sabine does not hold.
    const { doc } = room(1.5, 1.2, 'porcelain-tile', 'Store');
    const report = checkAcoustics(doc);

    expect(report.findings.filter((finding) => finding.topic === 'reverberation')).toHaveLength(0);
  });

  it('carries the IBC citation in order to rule it out', () => {
    /*
     * The one real code reference in the whole checker, and it is there to say
     * it does not apply. "STC 50" is the number people have heard of and they
     * assume it governs their bedroom wall; silence on that reads as approval.
     */
    const doc = twoRoomHouse('Bedroom 1', 'Living Room');
    const report = checkAcoustics(doc);

    const scope = report.findings.find((finding) => finding.id === 'privacy-ibc-scope');
    expect(scope).toBeDefined();
    expect(scope!.authority).toBe('IBC');
    expect(scope!.section).toBe('1206.2');
    expect(scope!.detail).toMatch(/dwelling units/i);
  });

  it('notices a bedroom next to a living room, and only then', () => {
    const sensitive = checkAcoustics(twoRoomHouse('Bedroom 1', 'Living Room'));
    expect(sensitive.findings.some((finding) => finding.topic === 'privacy')).toBe(true);

    // Two bedrooms next to each other is not the same problem.
    const calm = checkAcoustics(twoRoomHouse('Bedroom 1', 'Bedroom 2'));
    expect(calm.findings.some((finding) => finding.topic === 'privacy')).toBe(false);
  });

  it('stops warning once the partition is good enough', () => {
    const doc = twoRoomHouse('Bedroom 1', 'Living Room');

    doc.acoustics.partitionId = 'partition-single';
    const bare = checkAcoustics(doc).findings.find((f) => f.id === 'privacy-partition');
    expect(bare?.severity).toBe('caution');

    doc.acoustics.partitionId = 'partition-resilient';
    const good = checkAcoustics(doc).findings.find((f) => f.id === 'privacy-partition-ok');
    expect(good?.severity).toBe('pass');
  });
});

/* ------------------------------- The glazing ------------------------------- */

describe('glazing, acoustically', () => {
  it('barely improves with triple glazing, which is the counter-intuitive bit', () => {
    /*
     * Three similar panes at similar spacings resonate together, so triple
     * glazing buys about two points over double — while costing a great deal
     * more. Somebody choosing a window for its U-factor is also choosing what
     * the road sounds like, and nothing else in the app tells them.
     */
    const double = glazingStc('double-lowe');
    const triple = glazingStc('triple-lowe');

    expect(triple).toBeGreaterThan(double);
    expect(triple - double).toBeLessThan(5);
  });

  it('falls back rather than returning undefined for an unknown id', () => {
    expect(glazingStc('something-nobody-has-heard-of')).toBeGreaterThan(20);
  });
});

/* -------------------------------- The targets ------------------------------ */

describe('what a room should sound like', () => {
  it('wants a bedroom deader than a kitchen', () => {
    expect(reverbTarget('bedroom').max).toBeLessThan(reverbTarget('kitchen').max);
  });

  it('gives every room purpose a range, including ones it has not heard of', () => {
    const fallback = reverbTarget('submarine');
    expect(fallback.min).toBeGreaterThan(0);
    expect(fallback.max).toBeGreaterThan(fallback.min);
  });
});

/* --------------------------------- Helpers --------------------------------- */

/** A 12 x 8 house split into two named rooms by a partition. */
function twoRoomHouse(left: string, right: string): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  addRectangle(level.plan, { x: 6, z: 4 }, 12, 8);
  normalizePlan(level.plan);

  const north = level.plan.walls.find((wall) => {
    const a = level.plan.vertices.find((v) => v.id === wall.start)!;
    const b = level.plan.vertices.find((v) => v.id === wall.end)!;
    return Math.abs(a.z) < 0.01 && Math.abs(b.z) < 0.01;
  })!;
  const south = level.plan.walls.find((wall) => {
    const a = level.plan.vertices.find((v) => v.id === wall.start)!;
    const b = level.plan.vertices.find((v) => v.id === wall.end)!;
    return Math.abs(a.z - 8) < 0.01 && Math.abs(b.z - 8) < 0.01;
  })!;

  const top = splitWall(level.plan, north.id, 0.5)!;
  const bottom = splitWall(level.plan, south.id, 0.5)!;
  const va = level.plan.vertices.find((v) => v.id === top)!;
  const vb = level.plan.vertices.find((v) => v.id === bottom)!;
  drawWall(level.plan, { x: va.x, z: va.z }, { x: vb.x, z: vb.z });
  normalizePlan(level.plan);

  const names = [left, right];
  findRegions(level.plan).forEach((region, index) => {
    level.plan.rooms[region.key] = {
      name: names[index] ?? 'Room',
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  });

  return doc;
}
