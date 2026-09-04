/**
 * The catalogue of exterior finishes.
 *
 * Same shape as the floor presets: one entry per finish, and the UI, the
 * swatches and the material library all read from here so that adding a finish
 * is a one-entry change.
 *
 * Every one of these is drawn in near-white and tinted by the colour the user
 * picks, rather than baked in its own colour. That is deliberate. Siding comes
 * in whatever the paint chart offers, brick comes in a dozen shades of red and
 * buff, and generating a separate texture for each would be a great deal of
 * work to produce the same wall. What has to be right is the PATTERN — the
 * shadow line at every lap, the running bond of a brick wall — because that is
 * what survives at the distance a house is looked at from.
 *
 * The exposure figures are real. A lap siding board shows about 6 inches to the
 * weather; a US modular brick is 7 5/8 by 2 1/4 with a 3/8 joint, which comes
 * out at 8 inches by 2 2/3 laid. Getting these right is what makes a rendered
 * elevation the same size as the building.
 */

import { generateConcrete, generateMasonry, generateSiding, type SurfaceMaps } from './generators';
import type { Cladding } from '@/state/types';

export interface CladdingPreset {
  id: Cladding;
  label: string;
  /** Shown under the swatch when the finish is selected. */
  description: string;
  /** A default colour for the finish, offered when it is first chosen. */
  suggestedColour: string;
  /** Estimated installed cost, US dollars per square metre. */
  costPerSquareMetre: number;
  build: (size: number) => SurfaceMaps;
}

/** One texture repeat covers this much wall. */
const TILE_METRES = 2.4;

export const CLADDING_PRESETS: readonly CladdingPreset[] = [
  {
    id: 'lap-siding',
    label: 'Lap siding',
    description: 'Painted boards laid horizontally, each lapping the one below. 6 in exposure.',
    suggestedColour: '#e4ded2',
    costPerSquareMetre: 90,
    build: (size) =>
      generateSiding(size, {
        orientation: 'horizontal',
        boardWidth: 0.1524,
        battenWidth: 0,
        reveal: 0.9,
        grain: 0.35,
        baseRoughness: 0.72,
        seed: 4101,
        tileMetres: TILE_METRES,
      }),
  },
  {
    id: 'board-and-batten',
    label: 'Board and batten',
    description: 'Wide vertical boards with a narrow batten over every joint.',
    suggestedColour: '#d9d3c6',
    costPerSquareMetre: 105,
    build: (size) =>
      generateSiding(size, {
        orientation: 'vertical',
        boardWidth: 0.3048,
        battenWidth: 0.0635,
        reveal: 0.75,
        grain: 0.4,
        baseRoughness: 0.76,
        seed: 4102,
        tileMetres: TILE_METRES,
      }),
  },
  {
    id: 'shingle',
    label: 'Wood shingle',
    description: 'Cedar shingles in staggered courses, 5 in to the weather.',
    suggestedColour: '#cbb59a',
    costPerSquareMetre: 140,
    build: (size) =>
      generateMasonry(size, {
        unitWidth: 0.13,
        unitHeight: 0.127,
        jointWidth: 0.004,
        stagger: 0.5,
        variation: 0.7,
        irregularity: 0.35,
        baseRoughness: 0.85,
        seed: 4103,
        tileMetres: TILE_METRES,
      }),
  },
  {
    id: 'brick',
    label: 'Brick',
    description: 'Modular brick in a running bond, 8 in by 2 2/3 in laid.',
    suggestedColour: '#a4614b',
    costPerSquareMetre: 210,
    build: (size) =>
      generateMasonry(size, {
        unitWidth: 0.2032,
        unitHeight: 0.0678,
        jointWidth: 0.0095,
        stagger: 0.5,
        variation: 0.45,
        irregularity: 0.05,
        baseRoughness: 0.88,
        seed: 4104,
        tileMetres: TILE_METRES,
      }),
  },
  {
    id: 'stone',
    label: 'Stone',
    description: 'Coursed rubble stone with wide, irregular joints.',
    suggestedColour: '#a9a29a',
    costPerSquareMetre: 320,
    build: (size) =>
      generateMasonry(size, {
        unitWidth: 0.34,
        unitHeight: 0.18,
        jointWidth: 0.022,
        stagger: 0.38,
        variation: 0.85,
        irregularity: 0.85,
        baseRoughness: 0.9,
        seed: 4105,
        tileMetres: TILE_METRES * 1.5,
      }),
  },
  {
    id: 'stucco',
    label: 'Stucco',
    description: 'Cement render with a fine float finish.',
    suggestedColour: '#e8e2d6',
    costPerSquareMetre: 85,
    build: (size) =>
      generateConcrete(size, {
        baseColor: '#ffffff',
        mottleColor: '#efefef',
        polish: 0.15,
        seed: 4106,
        tileMetres: 1.8,
      }),
  },
  {
    id: 'fibre-cement',
    label: 'Fibre cement',
    description: 'Factory-finished cement board, laid like lap siding. Very flat.',
    suggestedColour: '#dfe1de',
    costPerSquareMetre: 110,
    build: (size) =>
      generateSiding(size, {
        orientation: 'horizontal',
        boardWidth: 0.1778,
        battenWidth: 0,
        reveal: 0.8,
        // Almost none: the point of the material is that it does not read as
        // timber close up.
        grain: 0.05,
        baseRoughness: 0.6,
        seed: 4107,
        tileMetres: TILE_METRES,
      }),
  },
];

export function getCladdingPreset(id: Cladding): CladdingPreset {
  return CLADDING_PRESETS.find((preset) => preset.id === id) ?? CLADDING_PRESETS[0]!;
}

/**
 * What a roof covering costs, per square metre of ROOF — not of plan.
 *
 * Estimates, in US dollars, for material and labour on a straightforward
 * two-storey house, and they carry the same warning as every other price in
 * this app: they are written from general knowledge, they are not quotes, and
 * they move with the market and with where you are building.
 */
export const ROOF_COVERING_COSTS: Record<string, { label: string; costPerSquareMetre: number }> = {
  'asphalt-shingle': { label: 'Asphalt shingles', costPerSquareMetre: 55 },
  'wood-shake': { label: 'Wood shakes', costPerSquareMetre: 160 },
  'clay-tile': { label: 'Clay tile', costPerSquareMetre: 200 },
  'concrete-tile': { label: 'Concrete tile', costPerSquareMetre: 130 },
  slate: { label: 'Slate', costPerSquareMetre: 330 },
  'standing-seam-metal': { label: 'Standing-seam metal', costPerSquareMetre: 175 },
  'metal-shingle': { label: 'Metal shingles', costPerSquareMetre: 145 },
  membrane: { label: 'Membrane', costPerSquareMetre: 90 },
};
