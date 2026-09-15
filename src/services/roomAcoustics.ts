/**
 * What a room will sound like, worked out from the room.
 *
 * -----------------------------------------------------------------------------
 * NOTHING HERE IS NEW INFORMATION.
 *
 * The floor finish, the paint, the ceiling height, the glazing, the doors and
 * every piece of furniture standing in the room have all been in the document
 * for sessions, chosen for reasons that had nothing to do with sound. It turns
 * out that is the whole input to a reverberation calculation — so the app can
 * tell you what a room will sound like without asking you a single new
 * question, and it can tell you the moment you change the floor.
 *
 * That is the same shape as everything else here: derived, never stored. A
 * cached reverberation time is a reverberation time that is wrong the moment
 * somebody drags a rug into the room.
 *
 * -----------------------------------------------------------------------------
 * THE FURNITURE IS NOT A ROUNDING ERROR.
 *
 * It is tempting to compute a room from its six surfaces and stop. Do that and
 * a furnished living room and an empty one come out identical, which is wrong
 * by a factor of two in the worst case: a three-seat sofa is around two square
 * metres of deep porous absorber, and at 1 kHz it absorbs nearly as much as the
 * entire painted ceiling above it.
 *
 * It is also the actionable half. Nobody is going to re-tile a bathroom because
 * of a reverberation figure. Adding a rug and curtains to a room that rings is
 * a Saturday.
 *
 * -----------------------------------------------------------------------------
 * AND AN OPEN DOOR IS A HOLE.
 *
 * One square metre of open doorway is one metric sabin — total absorption, by
 * definition, because everything that reaches it leaves and none comes back. So
 * a room's reverberation genuinely depends on whether the door is open, and the
 * report says which it assumed. Shut, here, because that is the condition a
 * room is designed for.
 */

import { BANDS, SPEECH_BANDS, SABINE_CONSTANT, EYRING_THRESHOLD, AIR_ABSORPTION, surfaceAbsorption, type BandValues } from '@/code/acoustics';
import { findRegions, type Region } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { roomPurpose, type RoomPurpose } from './rooms';
import { getCatalogEntry } from '@/furniture/catalog';
import { runGeometry } from '@/building/cabinetRun';
import { getFixture } from '@/fittings/fixtures';
import { pointInPolygon } from '@/physics/collision';
import { getOpeningPreset } from '@/scene/openings/presets';
import type { DesignDocument, Level, Opening } from '@/state/types';

/* ------------------------------ Band arithmetic ---------------------------- */

const ZERO: BandValues = [0, 0, 0, 0, 0, 0];

/** Adds one absorbing surface's contribution, band by band. */
function accumulate(into: number[], area: number, alpha: BandValues): void {
  for (let band = 0; band < BANDS.length; band += 1) {
    into[band] = (into[band] ?? 0) + area * (alpha[band] ?? 0);
  }
}

const asBands = (values: readonly number[]): BandValues => [
  values[0] ?? 0,
  values[1] ?? 0,
  values[2] ?? 0,
  values[3] ?? 0,
  values[4] ?? 0,
  values[5] ?? 0,
];

/**
 * The single number people quote, from the bands that carry speech.
 *
 * The mean of 500 Hz, 1 kHz and 2 kHz. Not the mean of all six: including the
 * 125 Hz band is how a boomy room gets reported as a lively one, because the
 * bass figure is routinely twice the mid one and drags the average up.
 */
export function speechAverage(bands: BandValues): number {
  let total = 0;
  for (const index of SPEECH_BANDS) total += bands[index] ?? 0;
  return total / SPEECH_BANDS.length;
}

/* ------------------------------ Mapping finishes --------------------------- */

/**
 * Which absorption class a floor preset belongs to.
 *
 * By id rather than by the preset's `category`, because the categories were
 * chosen for the swatch grid and one of them ("Concrete") is acoustically the
 * same as "Tile & Stone" while "Wood" genuinely is not. Matching on id keeps
 * the acoustic claim honest and costs one line per finish.
 */
export function floorAbsorptionId(presetId: string): string {
  if (/carpet|rug/i.test(presetId)) return 'floor-carpet';
  if (/plank|wood|oak|walnut|ash|timber|board/i.test(presetId)) return 'floor-wood';
  // Tile, stone, marble, concrete — anything hard and bonded to the slab.
  return 'floor-hard';
}

/**
 * Which absorption class a piece of furniture behaves as.
 *
 * Read off the catalogue category, which is exactly the distinction that
 * matters: a sofa and an armchair absorb alike and neither is a bookcase.
 */
export function furnitureAbsorptionId(category: string): string | null {
  switch (category) {
    case 'Seating':
      return 'upholstered';
    case 'Beds':
      return 'bed';
    case 'Rugs':
      return 'soft-furnishing';
    case 'Tables':
    case 'Storage':
    case 'Workspace':
      return 'furniture-hard';
    default:
      // A pendant light absorbs nothing worth counting.
      return null;
  }
}

/* --------------------------------- Surfaces -------------------------------- */

/** One absorbing thing in a room, and how much of it there is. */
export interface AcousticSurface {
  /** An id from `code/acoustics.ts`. */
  absorptionId: string;
  label: string;
  /** Square metres. For furniture this is the plan footprint — see the note. */
  area: number;
  /** Its contribution to total absorption, in metric sabins, per band. */
  sabins: BandValues;
}

export interface RoomSurfaces {
  roomKey: string;
  name: string;
  purpose: RoomPurpose;
  /** Cubic metres. */
  volume: number;
  /** Square metres of floor. */
  floorArea: number;
  /** Floor to ceiling, metres. */
  height: number;
  surfaces: AcousticSurface[];
  /** Total boundary area, for the mean absorption coefficient. */
  boundaryArea: number;
}

/**
 * Everything in one room that absorbs sound.
 *
 * Walls are counted net of their openings and the openings counted separately,
 * because a window is a quite different absorber from the wall it is cut into —
 * glass takes a surprising amount of bass by flexing and almost nothing above
 * that, which is the opposite shape to plasterboard.
 */
export function roomSurfaces(doc: DesignDocument, level: Level, region: Region): RoomSurfaces {
  const spec = resolveRoomSpec(level.plan, region.key);
  const purpose = roomPurpose(spec.name);
  const height = level.wallHeight;
  const floorArea = region.area;
  const volume = floorArea * height;

  const surfaces: AcousticSurface[] = [];
  const push = (absorptionId: string, label: string, area: number) => {
    if (area <= 0) return;
    const alpha = surfaceAbsorption(absorptionId).alpha;
    const sabins: number[] = [0, 0, 0, 0, 0, 0];
    accumulate(sabins, area, alpha);
    surfaces.push({ absorptionId, label, area, sabins: asBands(sabins) });
  };

  /* -------------------------------- Floor -------------------------------- */

  push(floorAbsorptionId(spec.floor.presetId), 'Floor', floorArea);

  /* ------------------------------- Ceiling ------------------------------- */

  push('ceiling-gypsum', 'Ceiling', floorArea);

  /* -------------------------------- Walls -------------------------------- */

  /*
   * The perimeter of the region's own polygon rather than the length of its
   * walls. They are nearly the same and the polygon is the right one: it
   * follows the room's inside face, which is the surface sound actually meets,
   * where a wall's length is measured centreline to centreline.
   */
  let perimeter = 0;
  for (let i = 0; i < region.polygon.length; i += 1) {
    const a = region.polygon[i]!;
    const b = region.polygon[(i + 1) % region.polygon.length]!;
    perimeter += Math.hypot(b.x - a.x, b.z - a.z);
  }

  const grossWall = perimeter * height;

  /*
   * Openings on the walls that bound this room.
   *
   * A wall between two rooms has its openings counted in both, which is right:
   * the same window is a window in whichever room it is in, and an interior
   * door is a door on both sides of itself.
   */
  const bounding = new Set(region.wallIds);
  const openings: Opening[] = [];
  for (const wall of level.plan.walls) {
    if (!bounding.has(wall.id)) continue;
    openings.push(...wall.openings);
  }

  let glassArea = 0;
  let doorArea = 0;
  let holeArea = 0;

  for (const opening of openings) {
    const area = opening.width * opening.height;
    if (opening.kind === 'window') {
      glassArea += area;
      continue;
    }

    const preset = getOpeningPreset(opening.presetId);
    // A cased opening has no leaf in it, so it really is a hole in the wall.
    if (preset && preset.leaf === 'none') holeArea += area;
    else doorArea += area;
  }

  push('wall-gypsum', 'Walls', Math.max(0, grossWall - glassArea - doorArea - holeArea));
  push('glass-window', 'Glazing', glassArea);
  push('door-wood', 'Doors', doorArea);
  push('opening', 'Open doorways', holeArea);

  /* ------------------------------ Furniture ------------------------------ */

  /*
   * Grouped by class before being pushed, so the report says "Soft furnishing,
   * 4.2 m²" once rather than listing eleven cushions. The per-item figures are
   * still exact — only the presentation is grouped.
   */
  const byClass = new Map<string, number>();

  for (const item of level.furniture) {
    if (!pointInPolygon({ x: item.x, z: item.z }, region.polygon)) continue;

    const entry = getCatalogEntry(item.catalogId);
    const absorptionId = furnitureAbsorptionId(entry.category);
    if (!absorptionId) continue;

    // Plan footprint, which is what the published figures for furnished areas
    // are quoted against — they already account for the piece being absorbing
    // on more than one face.
    const area = entry.width * entry.depth;
    byClass.set(absorptionId, (byClass.get(absorptionId) ?? 0) + area);
  }

  /*
   * Fitted cabinetry and sanitaryware count too.
   *
   * They were left out of the first version, and a fitted kitchen is four
   * metres of carcass with doors and a worktop — hard, but not the same as the
   * bare plasterboard it replaces, and a genuinely large fraction of the room's
   * boundary. Leaving out something the app has modelled with real dimensions
   * would be the same mistake as leaving out the furniture.
   */
  let fittedArea = 0;

  for (const run of doc.runs) {
    if (run.levelId !== level.id) continue;
    for (const placed of runGeometry(run).units) {
      if (!pointInPolygon(placed.at, region.polygon)) continue;
      // The face it presents to the room, which is what sound meets.
      fittedArea += placed.width * placed.height;
    }
  }

  for (const fixture of doc.fixtures) {
    if (fixture.levelId !== level.id) continue;
    if (!pointInPolygon(fixture.at, region.polygon)) continue;
    const spec = getFixture(fixture.fixtureId);
    if (spec) fittedArea += spec.width * spec.height;
  }

  if (fittedArea > 0) byClass.set('furniture-hard', (byClass.get('furniture-hard') ?? 0) + fittedArea);

  for (const [absorptionId, area] of byClass) {
    push(absorptionId, surfaceAbsorption(absorptionId).label, area);
  }

  return {
    roomKey: region.key,
    name: spec.name,
    purpose,
    volume,
    floorArea,
    height,
    surfaces,
    // Boundary only — the six faces of the box. Furniture standing inside the
    // room adds absorption without adding boundary, which is exactly why a
    // furnished room has a lower mean coefficient than its finishes suggest.
    boundaryArea: floorArea * 2 + grossWall,
  };
}

/* ------------------------------- Reverberation ----------------------------- */

export interface ReverbResult extends RoomSurfaces {
  /** Total absorption, metric sabins, per band. */
  sabins: BandValues;
  /** Mean absorption coefficient over the boundary, per band. */
  meanAlpha: BandValues;
  /** Reverberation time per band, seconds. */
  rt60: BandValues;
  /** Which equation was used, and why. */
  method: 'sabine' | 'eyring';
  methodWhy: string;
  /** The single figure to quote: the mean of 500 Hz, 1 kHz and 2 kHz. */
  midRt60: number;
  /**
   * How much longer the bass rings than the mid, as a ratio.
   *
   * The number that finds a muddy room. A carpet and a hard ceiling gives a
   * short mid and a long bass, and the room is described as boomy by everybody
   * who uses it and as "well treated" by anybody quoting one figure.
   */
  bassRatio: number;
  /** The surface doing the most absorbing at speech frequencies. */
  dominant: AcousticSurface | null;
}

/**
 * Reverberation time, by Sabine or by Eyring as the room demands.
 *
 * Sabine's equation is RT60 = 0.161 V / A and it assumes each reflection loses
 * only a small fraction of the energy. When the room is genuinely absorbent
 * that assumption fails, and it fails in a specific and visible way: as the
 * absorption approaches total, Sabine predicts a short reverberation rather
 * than none at all. An anechoic chamber does not have a reverberation time of
 * 0.05 seconds; it has no reverberation.
 *
 * Eyring's form replaces A with -S·ln(1-ᾱ), which reduces to Sabine's when ᾱ is
 * small and correctly goes to zero when ᾱ goes to one. The app switches above
 * a mean coefficient of 0.2 and says which it used, because quietly changing
 * equations is how a number stops being explainable.
 */
export function reverbTime(room: RoomSurfaces): ReverbResult {
  const totals: number[] = [0, 0, 0, 0, 0, 0];
  for (const surface of room.surfaces) {
    for (let band = 0; band < BANDS.length; band += 1) {
      totals[band] = (totals[band] ?? 0) + (surface.sabins[band] ?? 0);
    }
  }

  const sabins = asBands(totals);
  const meanAlpha = asBands(
    totals.map((value) => (room.boundaryArea > 0 ? value / room.boundaryArea : 0)),
  );

  // The decision is made once, at speech frequencies, so one room is not
  // reported by two different equations in two different bands.
  const decidingAlpha = speechAverage(meanAlpha);
  const useEyring = decidingAlpha > EYRING_THRESHOLD;

  const rt60 = asBands(
    BANDS.map((_, band) => {
      const absorption = totals[band] ?? 0;

      /*
       * Air absorption, which only bites in a large room and only at the top.
       * 4·m·V, where m is the attenuation per metre — the conventional form,
       * and the reason a cathedral is duller than its surfaces predict.
       */
      const air = 4 * (AIR_ABSORPTION[band] ?? 0) * room.volume;

      const effective = useEyring
        ? (() => {
            const alpha = room.boundaryArea > 0 ? absorption / room.boundaryArea : 0;
            // Guarded: ln(0) is -Infinity, and a room with nothing but open
            // windows is a legitimate thing to draw.
            const clamped = Math.min(0.999, Math.max(0, alpha));
            return -room.boundaryArea * Math.log(1 - clamped);
          })()
        : absorption;

      const denominator = effective + air;
      if (denominator <= 1e-9 || room.volume <= 0) return 0;
      return (SABINE_CONSTANT * room.volume) / denominator;
    }),
  );

  /* ---- Which surface is responsible, which is the actionable half ---- */

  let dominant: AcousticSurface | null = null;
  let best = 0;
  for (const surface of room.surfaces) {
    const contribution = speechAverage(surface.sabins);
    if (contribution > best) {
      best = contribution;
      dominant = surface;
    }
  }

  const midRt60 = speechAverage(rt60);
  const bass = ((rt60[0] ?? 0) + (rt60[1] ?? 0)) / 2;

  return {
    ...room,
    sabins,
    meanAlpha,
    rt60,
    method: useEyring ? 'eyring' : 'sabine',
    methodWhy: useEyring
      ? `Eyring: the mean absorption coefficient is ${decidingAlpha.toFixed(2)}, too high for Sabine's small-loss assumption.`
      : `Sabine: the mean absorption coefficient is ${decidingAlpha.toFixed(2)}, well within the small-loss assumption.`,
    midRt60,
    bassRatio: midRt60 > 0.01 ? bass / midRt60 : 1,
    dominant,
  };
}

/* -------------------------------- The building ----------------------------- */

/** Every room on one storey, with what it will sound like. */
export function acousticsFor(doc: DesignDocument, levelId: string): ReverbResult[] {
  const level = doc.levels.find((entry) => entry.id === levelId);
  if (!level) return [];

  return findRegions(level.plan)
    .map((region) => reverbTime(roomSurfaces(doc, level, region)))
    // Smallest rooms last: a report is read from the top, and a cupboard's
    // reverberation time is never the thing somebody needed to know.
    .sort((a, b) => b.floorArea - a.floorArea);
}

/** Every room in the whole building. */
export function acousticsForBuilding(doc: DesignDocument): ReverbResult[] {
  return doc.levels.flatMap((level) => acousticsFor(doc, level.id));
}

/* --------------------------- How loud it is in here ------------------------ */

/**
 * Decibel arithmetic, which is not ordinary arithmetic.
 *
 * Two sources of 50 dB are not 100 dB, they are 53 — energy adds, and the
 * decibel is logarithmic. Getting this wrong is the classic error and it is
 * wrong by a factor of a thousand, so it lives in one named function rather
 * than being written out at each call site.
 */
export function addDecibels(levels: readonly number[]): number {
  const energy = levels.reduce((sum, level) => sum + Math.pow(10, level / 10), 0);
  return energy > 0 ? 10 * Math.log10(energy) : 0;
}

/**
 * How much a room's own absorption reduces a steady noise inside it.
 *
 * A noisy register in a dead room is quieter than the same register in a bare
 * one, and by a real amount: the room-effect term is 10·log10(4/A), which is
 * about 5 dB between a tiled bathroom and a carpeted bedroom of the same size.
 *
 * Referenced to a nominal source power level, so what comes out is the level in
 * the room rather than an absolute claim about a particular diffuser.
 */
export function roomEffectDb(sabinsAtSpeech: number): number {
  if (sabinsAtSpeech <= 0.1) return 0;
  return 10 * Math.log10(4 / sabinsAtSpeech);
}

export const ZERO_BANDS = ZERO;
