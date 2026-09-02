/**
 * The catalogue of doors and windows.
 *
 * Dimensions are real ones. A single interior door leaf in Europe is 826 mm
 * wide by 2040 mm tall in a 900 mm structural opening; getting these right
 * matters more than it might seem, because a room only reads as the right size
 * once there is a correctly-sized door in it for the eye to measure against.
 */

import type { OpeningKind } from '@/state/types';

export interface OpeningPreset {
  id: string;
  kind: OpeningKind;
  label: string;
  description: string;
  /** Structural opening width, in metres. */
  width: number;
  /** Structural opening height, in metres. */
  height: number;
  /** Height of the opening's bottom edge above the floor, in metres. */
  sillHeight: number;
  /** Whether to draw a swinging door leaf inside the opening. */
  leaf: 'single' | 'double' | 'sliding' | 'none';
  /** Whether to draw glazing inside the opening. */
  glazed: boolean;
  /** Number of vertical glazing bars. Zero for a single pane. */
  mullions: number;
}

export const OPENING_PRESETS: readonly OpeningPreset[] = [
  {
    id: 'door-single',
    kind: 'door',
    label: 'Single Door',
    description: 'Standard 826 mm interior door.',
    width: 0.9,
    height: 2.04,
    sillHeight: 0,
    leaf: 'single',
    glazed: false,
    mullions: 0,
  },
  {
    id: 'door-double',
    kind: 'door',
    label: 'Double Door',
    description: 'Pair of doors for a main room entrance.',
    width: 1.5,
    height: 2.1,
    sillHeight: 0,
    leaf: 'double',
    glazed: false,
    mullions: 0,
  },
  {
    id: 'door-sliding',
    kind: 'door',
    label: 'Sliding Door',
    description: 'Glazed slider onto a terrace or balcony.',
    width: 1.8,
    height: 2.1,
    sillHeight: 0,
    leaf: 'sliding',
    glazed: true,
    mullions: 1,
  },
  {
    id: 'door-opening',
    kind: 'door',
    label: 'Open Doorway',
    description: 'A cased opening with no door in it.',
    width: 1.1,
    height: 2.1,
    sillHeight: 0,
    leaf: 'none',
    glazed: false,
    mullions: 0,
  },
  {
    id: 'window-casement',
    kind: 'window',
    label: 'Casement',
    description: 'Everyday window at desk height.',
    width: 1.2,
    height: 1.2,
    sillHeight: 0.9,
    leaf: 'none',
    glazed: true,
    mullions: 1,
  },
  {
    id: 'window-picture',
    kind: 'window',
    label: 'Picture Window',
    description: 'Wide single pane for a view.',
    width: 2.0,
    height: 1.4,
    sillHeight: 0.75,
    leaf: 'none',
    glazed: true,
    mullions: 0,
  },
  {
    id: 'window-tall',
    kind: 'window',
    label: 'Floor to Ceiling',
    description: 'Full-height glazing down to the floor.',
    width: 1.4,
    height: 2.2,
    sillHeight: 0.06,
    leaf: 'none',
    glazed: true,
    mullions: 1,
  },
  {
    id: 'window-clerestory',
    kind: 'window',
    label: 'Clerestory',
    description: 'High strip window for light without overlooking.',
    width: 1.6,
    height: 0.5,
    sillHeight: 1.85,
    leaf: 'none',
    glazed: true,
    mullions: 2,
  },
];

export function getOpeningPreset(id: string): OpeningPreset {
  return OPENING_PRESETS.find((preset) => preset.id === id) ?? OPENING_PRESETS[0]!;
}

export function openingPresetsOfKind(kind: OpeningKind): OpeningPreset[] {
  return OPENING_PRESETS.filter((preset) => preset.kind === kind);
}
