/**
 * The catalogue of surface finishes offered in the UI.
 *
 * Adding a finish is a one-entry change here — the UI panel, the swatch
 * previews and the material library all read from this registry, so nothing
 * else needs editing.
 */

import {
  generateCarpet,
  generateConcrete,
  generateMarble,
  generateTile,
  generateWood,
  type SurfaceMaps,
} from './generators';

export type FloorCategory = 'Wood' | 'Tile & Stone' | 'Soft' | 'Concrete';

export interface FloorPreset {
  id: string;
  label: string;
  category: FloorCategory;
  /** Shown under the swatch grid when the preset is selected. */
  description: string;
  /**
   * Colour used for the CSS swatch fallback and as the UI accent for this
   * preset, so the panel can render instantly before textures are generated.
   */
  swatchColor: string;
  /** Builds the full texture set at the requested resolution. */
  build: (size: number) => SurfaceMaps;
}

/**
 * One texture repeat covers this many metres of floor for most presets.
 *
 * Two metres is the sweet spot: large enough that the repeat is not obvious in
 * a small room, small enough that a 1024px map still resolves plank grain.
 */
const DEFAULT_TILE_METRES = 2;

export const FLOOR_PRESETS: readonly FloorPreset[] = [
  {
    id: 'oak-plank',
    label: 'Natural Oak',
    category: 'Wood',
    description: 'Wide European oak boards with a satin lacquer finish.',
    swatchColor: '#b98b57',
    build: (size) =>
      generateWood(size, {
        darkColor: '#8a5f33',
        lightColor: '#d8ab74',
        plankWidth: 0.19,
        plankLength: 1.2,
        grainContrast: 0.55,
        baseRoughness: 0.52,
        seed: 1207,
        tileMetres: DEFAULT_TILE_METRES,
      }),
  },
  {
    id: 'walnut-plank',
    label: 'Dark Walnut',
    category: 'Wood',
    description: 'Deep chocolate walnut with pronounced figuring.',
    swatchColor: '#5d3a24',
    build: (size) =>
      generateWood(size, {
        darkColor: '#3a2114',
        lightColor: '#7d4f2f',
        plankWidth: 0.16,
        plankLength: 1.0,
        grainContrast: 0.75,
        baseRoughness: 0.46,
        seed: 8821,
        tileMetres: DEFAULT_TILE_METRES,
      }),
  },
  {
    id: 'ash-plank',
    label: 'Nordic Ash',
    category: 'Wood',
    description: 'Pale white-washed ash — the Scandinavian default.',
    swatchColor: '#d9c6ac',
    build: (size) =>
      generateWood(size, {
        darkColor: '#bda887',
        lightColor: '#efe2ce',
        plankWidth: 0.18,
        plankLength: 1.4,
        grainContrast: 0.35,
        baseRoughness: 0.62,
        seed: 4410,
        tileMetres: DEFAULT_TILE_METRES,
      }),
  },
  {
    id: 'porcelain-tile',
    label: 'Porcelain Tile',
    category: 'Tile & Stone',
    description: 'Large-format 60 cm porcelain with fine grey grout.',
    swatchColor: '#cdc9c2',
    build: (size) =>
      generateTile(size, {
        tileSize: 0.6,
        groutWidth: 0.006,
        primaryColor: '#d6d2cb',
        secondaryColor: '#d6d2cb',
        groutColor: '#a9a49c',
        variation: 0.9,
        baseRoughness: 0.35,
        seed: 2201,
        tileMetres: 2.4,
      }),
  },
  {
    id: 'checker-tile',
    label: 'Checkerboard',
    category: 'Tile & Stone',
    description: 'Classic monochrome checker in a 30 cm format.',
    swatchColor: '#8f8f92',
    build: (size) =>
      generateTile(size, {
        tileSize: 0.3,
        groutWidth: 0.005,
        primaryColor: '#e9e7e2',
        secondaryColor: '#33333a',
        groutColor: '#b0aca4',
        variation: 0.5,
        baseRoughness: 0.3,
        seed: 9017,
        tileMetres: 2.4,
      }),
  },
  {
    id: 'carrara-marble',
    label: 'Carrara Marble',
    category: 'Tile & Stone',
    description: 'Polished white marble with soft grey veining.',
    swatchColor: '#e6e6e3',
    build: (size) =>
      generateMarble(size, {
        baseColor: '#eeeeea',
        veinColor: '#9ba0a4',
        turbulence: 1.6,
        seed: 3355,
        tileMetres: 3,
      }),
  },
  {
    id: 'polished-concrete',
    label: 'Polished Concrete',
    category: 'Concrete',
    description: 'Ground and sealed screed with visible aggregate.',
    swatchColor: '#9d9d9c',
    build: (size) =>
      generateConcrete(size, {
        baseColor: '#a8a8a6',
        mottleColor: '#7c7c7b',
        polish: 0.8,
        seed: 6172,
        tileMetres: 3,
      }),
  },
  {
    id: 'wool-carpet',
    label: 'Wool Carpet',
    category: 'Soft',
    description: 'Dense cut-pile wool in a warm neutral.',
    swatchColor: '#b3a897',
    build: (size) =>
      generateCarpet(size, {
        baseColor: '#b8ad9c',
        fibreVariation: 1,
        seed: 5309,
        tileMetres: 1.2,
      }),
  },
  {
    id: 'charcoal-carpet',
    label: 'Charcoal Carpet',
    category: 'Soft',
    description: 'Low-pile contract carpet in deep charcoal.',
    swatchColor: '#4a4a4e',
    build: (size) =>
      generateCarpet(size, {
        baseColor: '#4e4e53',
        fibreVariation: 0.7,
        seed: 7742,
        tileMetres: 1.2,
      }),
  },
];

/** Looks a preset up by ID, falling back to the first entry if it is unknown. */
export function getFloorPreset(id: string): FloorPreset {
  const found = FLOOR_PRESETS.find((preset) => preset.id === id);
  // The non-null assertion is safe: the array above is a non-empty literal.
  return found ?? FLOOR_PRESETS[0]!;
}

/** Preset IDs grouped by category, for the UI's swatch sections. */
export function floorPresetsByCategory(): Array<{ category: FloorCategory; presets: FloorPreset[] }> {
  const order: FloorCategory[] = ['Wood', 'Tile & Stone', 'Concrete', 'Soft'];
  return order
    .map((category) => ({
      category,
      presets: FLOOR_PRESETS.filter((preset) => preset.category === category),
    }))
    .filter((group) => group.presets.length > 0);
}

/* ─────────────────────────── Wall paint ─────────────────────────── */

/**
 * Curated wall colours.
 *
 * Interior paint is not arbitrary RGB — these are desaturated, slightly warm
 * tones that behave well under the lighting presets. A free colour picker sits
 * alongside them in the UI for anything else.
 */
export interface PaintSwatch {
  name: string;
  hex: string;
}

export const WALL_PAINTS: readonly PaintSwatch[] = [
  { name: 'Gallery White', hex: '#f4f2ee' },
  { name: 'Warm Linen', hex: '#ece7df' },
  { name: 'Bone', hex: '#e2dbcd' },
  { name: 'Soft Clay', hex: '#d8c4b4' },
  { name: 'Terracotta', hex: '#b9755c' },
  { name: 'Dusty Rose', hex: '#c99e97' },
  { name: 'Sage', hex: '#a8b3a0' },
  { name: 'Eucalyptus', hex: '#7f9184' },
  { name: 'Deep Forest', hex: '#3f4f45' },
  { name: 'Sky Wash', hex: '#c3d2da' },
  { name: 'Denim', hex: '#6a7f96' },
  { name: 'Navy Ink', hex: '#2f3b4d' },
  { name: 'Pebble', hex: '#bfbcb6' },
  { name: 'Slate', hex: '#767a7d' },
  { name: 'Graphite', hex: '#3d3f42' },
  { name: 'Butter', hex: '#ecdcae' },
];

/** Paint sheen levels, expressed as the roughness they map to. */
export const WALL_FINISHES = [
  { id: 'matte', label: 'Matte', roughness: 0.94 },
  { id: 'eggshell', label: 'Eggshell', roughness: 0.82 },
  { id: 'satin', label: 'Satin', roughness: 0.66 },
  { id: 'gloss', label: 'Gloss', roughness: 0.42 },
] as const;

/** One entry in the finish table. */
export type WallFinish = (typeof WALL_FINISHES)[number];

/** Finds the finish whose roughness is closest to a stored value. */
export function nearestFinishId(roughness: number): string {
  let best: WallFinish = WALL_FINISHES[0];
  for (const finish of WALL_FINISHES) {
    if (Math.abs(finish.roughness - roughness) < Math.abs(best.roughness - roughness)) {
      best = finish;
    }
  }
  return best.id;
}
