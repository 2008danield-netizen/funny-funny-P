/**
 * What each assembly is actually made of, layer by layer.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM THE R-VALUES.
 *
 * `code/iecc.ts` knows that a 2x6 wall with R-21 batts performs at about
 * R-16.5. That is everything the load calculation and the code check need, and
 * nothing a section drawing needs — a section has to show the gypsum, the
 * studs, the sheathing and the cladding at their real thicknesses, in the right
 * order, hatched so a builder can tell them apart.
 *
 * So this file is the physical build-up behind each assembly id, and the
 * thermal figures stay where they were. One id, two descriptions, neither
 * duplicating the other.
 *
 * -----------------------------------------------------------------------------
 * THESE ARE REPRESENTATIVE, NOT PRESCRIPTIVE.
 *
 * There are a dozen legitimate ways to build an R-21 wall. This is the common
 * one in the climate the app is written for, and the drawing says so on the
 * sheet rather than implying the detail has been designed. Nobody should order
 * timber off it.
 *
 * -----------------------------------------------------------------------------
 * THE THICKNESSES ARE REAL, AND THAT CAUSES AN ARGUMENT WORTH HAVING.
 *
 * A 2x6 wall with finishes both sides is about 183 mm. If somebody has drawn
 * their walls 100 mm thick and then specified a 2x6 assembly, those two facts
 * contradict each other — and until there was a section nothing in the app
 * could notice. Rather than quietly scaling the layers to fit the wall that was
 * drawn, which would draw a lie at the right size, the layers are drawn at
 * their true thickness and the mismatch is reported.
 */

import type { Assembly } from '@/code/iecc';

/** How a layer is hatched, which is how a builder tells them apart. */
export type Hatch =
  /** Nothing — plasterboard, finishes. */
  | 'plain'
  /** Diagonal lines — timber and framing. */
  | 'timber'
  /** Batt squiggle — mineral wool and blown insulation. */
  | 'batt'
  /** Cross-hatch — rigid foam boards. */
  | 'rigid'
  /** Stipple — concrete and screed. */
  | 'concrete'
  /** Coarse stipple — hardcore, gravel. */
  | 'fill'
  /** Solid — membranes, which are too thin to hatch at any drawing scale. */
  | 'membrane'
  /** Open — ventilated cavities and the loft void. */
  | 'void';

export interface Layer {
  name: string;
  /** Metres. Real, not scaled to whatever the wall was drawn at. */
  thickness: number;
  hatch: Hatch;
  /**
   * This layer's own thermal resistance, in the R units the rest of the app
   * uses. Zero for layers that do nothing thermally, which is most of them —
   * and seeing that written down next to a 140 mm stud bay is itself the
   * argument for continuous insulation.
   */
  rValue: number;
}

/** A build-up, outside face first. */
export interface BuildUp {
  layers: Layer[];
  /** What this is, for the callout heading. */
  label: string;
}

const membrane = (name: string): Layer => ({ name, thickness: 0.001, hatch: 'membrane', rValue: 0 });

const GYPSUM: Layer = { name: '12.5 mm plasterboard', thickness: 0.0125, hatch: 'plain', rValue: 0.45 };
const SHEATHING: Layer = { name: '11 mm OSB sheathing', thickness: 0.011, hatch: 'timber', rValue: 1.3 };
const CLADDING: Layer = { name: 'Cladding on battens', thickness: 0.019, hatch: 'timber', rValue: 0.8 };
const DECK: Layer = { name: '18 mm roof deck', thickness: 0.018, hatch: 'timber', rValue: 2.2 };
const SHINGLES: Layer = { name: 'Asphalt shingles', thickness: 0.006, hatch: 'plain', rValue: 0.44 };

/* --------------------------------- Walls ---------------------------------- */

export const WALL_BUILD_UPS: Record<string, BuildUp> = {
  'wall-2x4-r13': {
    label: '2x4 stud wall, R-13',
    layers: [
      CLADDING,
      membrane('Breather membrane'),
      SHEATHING,
      { name: '2x4 studs at 400 mm, R-13 batts', thickness: 0.089, hatch: 'batt', rValue: 13 },
      GYPSUM,
    ],
  },
  'wall-2x4-r15': {
    label: '2x4 stud wall, R-15',
    layers: [
      CLADDING,
      membrane('Breather membrane'),
      SHEATHING,
      { name: '2x4 studs at 400 mm, R-15 batts', thickness: 0.089, hatch: 'batt', rValue: 15 },
      GYPSUM,
    ],
  },
  'wall-2x6-r21': {
    label: '2x6 stud wall, R-21',
    layers: [
      CLADDING,
      membrane('Breather membrane'),
      SHEATHING,
      { name: '2x6 studs at 400 mm, R-21 batts', thickness: 0.14, hatch: 'batt', rValue: 21 },
      GYPSUM,
    ],
  },
  'wall-2x6-r21-ci5': {
    label: '2x6 stud wall, R-21 plus R-5 continuous',
    layers: [
      CLADDING,
      membrane('Breather membrane'),
      { name: '25 mm rigid insulation, R-5', thickness: 0.025, hatch: 'rigid', rValue: 5 },
      SHEATHING,
      { name: '2x6 studs at 400 mm, R-21 batts', thickness: 0.14, hatch: 'batt', rValue: 21 },
      GYPSUM,
    ],
  },
  'wall-2x6-r21-ci10': {
    label: '2x6 stud wall, R-21 plus R-10 continuous',
    layers: [
      CLADDING,
      membrane('Breather membrane'),
      { name: '50 mm rigid insulation, R-10', thickness: 0.05, hatch: 'rigid', rValue: 10 },
      SHEATHING,
      { name: '2x6 studs at 400 mm, R-21 batts', thickness: 0.14, hatch: 'batt', rValue: 21 },
      GYPSUM,
    ],
  },
  'wall-double-r38': {
    label: 'Double stud wall, R-38',
    layers: [
      CLADDING,
      membrane('Breather membrane'),
      SHEATHING,
      { name: 'Twin 2x4 walls with a gap, R-38 blown', thickness: 0.29, hatch: 'batt', rValue: 38 },
      GYPSUM,
    ],
  },
  'wall-sip': {
    label: 'Structural insulated panel, R-24',
    layers: [
      CLADDING,
      membrane('Breather membrane'),
      { name: '11 mm OSB facing', thickness: 0.011, hatch: 'timber', rValue: 1.3 },
      { name: 'Foam core, R-24', thickness: 0.14, hatch: 'rigid', rValue: 24 },
      { name: '11 mm OSB facing', thickness: 0.011, hatch: 'timber', rValue: 1.3 },
      GYPSUM,
    ],
  },
};

/* --------------------------------- Roofs ---------------------------------- */

/**
 * Roof build-ups, outside face first.
 *
 * The loft ones have a void in them, and that void is the point: the insulation
 * sits on the ceiling, not on the slope, and what is above it is ventilated
 * outdoor air. A section that drew the insulation following the rafters would
 * be showing a completely different building with completely different
 * ventilation requirements.
 */
export const ROOF_BUILD_UPS: Record<string, BuildUp> = {
  'roof-r30': {
    label: 'Ventilated loft, R-30',
    layers: [
      SHINGLES,
      membrane('Underlay'),
      DECK,
      { name: 'Ventilated loft void', thickness: 0.4, hatch: 'void', rValue: 0 },
      { name: 'R-30 blown insulation on the ceiling', thickness: 0.235, hatch: 'batt', rValue: 30 },
      GYPSUM,
    ],
  },
  'roof-r38': {
    label: 'Ventilated loft, R-38',
    layers: [
      SHINGLES,
      membrane('Underlay'),
      DECK,
      { name: 'Ventilated loft void', thickness: 0.4, hatch: 'void', rValue: 0 },
      { name: 'R-38 blown insulation on the ceiling', thickness: 0.3, hatch: 'batt', rValue: 38 },
      GYPSUM,
    ],
  },
  'roof-r49': {
    label: 'Ventilated loft, R-49',
    layers: [
      SHINGLES,
      membrane('Underlay'),
      DECK,
      { name: 'Ventilated loft void', thickness: 0.4, hatch: 'void', rValue: 0 },
      { name: 'R-49 blown insulation on the ceiling', thickness: 0.39, hatch: 'batt', rValue: 49 },
      GYPSUM,
    ],
  },
  'roof-r60': {
    label: 'Ventilated loft, R-60',
    layers: [
      SHINGLES,
      membrane('Underlay'),
      DECK,
      { name: 'Ventilated loft void', thickness: 0.4, hatch: 'void', rValue: 0 },
      { name: 'R-60 blown insulation on the ceiling', thickness: 0.475, hatch: 'batt', rValue: 60 },
      GYPSUM,
    ],
  },
  'roof-cathedral-r38': {
    label: 'Cathedral ceiling, R-38',
    layers: [
      SHINGLES,
      membrane('Underlay'),
      DECK,
      { name: '38 mm ventilation gap', thickness: 0.038, hatch: 'void', rValue: 0 },
      { name: 'Rafters at 400 mm, R-38 batts', thickness: 0.235, hatch: 'batt', rValue: 38 },
      GYPSUM,
    ],
  },
};

/* --------------------------------- Floors --------------------------------- */

export const FLOOR_BUILD_UPS: Record<string, BuildUp> = {
  'floor-slab': {
    label: 'Slab on grade, uninsulated edge',
    layers: [
      { name: '100 mm concrete slab', thickness: 0.1, hatch: 'concrete', rValue: 0.5 },
      membrane('Damp-proof membrane'),
      { name: '150 mm compacted hardcore', thickness: 0.15, hatch: 'fill', rValue: 0 },
    ],
  },
  'floor-slab-r10': {
    label: 'Slab on grade, R-10 edge',
    layers: [
      { name: '100 mm concrete slab', thickness: 0.1, hatch: 'concrete', rValue: 0.5 },
      membrane('Damp-proof membrane'),
      { name: '50 mm rigid insulation, R-10 at the edge', thickness: 0.05, hatch: 'rigid', rValue: 10 },
      { name: '150 mm compacted hardcore', thickness: 0.15, hatch: 'fill', rValue: 0 },
    ],
  },
  'floor-r19': {
    label: 'Suspended floor, R-19',
    layers: [
      { name: '19 mm floor deck', thickness: 0.019, hatch: 'timber', rValue: 2.2 },
      { name: 'Joists at 400 mm, R-19 batts', thickness: 0.235, hatch: 'batt', rValue: 19 },
    ],
  },
  'floor-r30': {
    label: 'Suspended floor, R-30',
    layers: [
      { name: '19 mm floor deck', thickness: 0.019, hatch: 'timber', rValue: 2.2 },
      { name: 'Joists at 400 mm, R-30 batts', thickness: 0.3, hatch: 'batt', rValue: 30 },
    ],
  },
  'floor-r38': {
    label: 'Suspended floor, R-38',
    layers: [
      { name: '19 mm floor deck', thickness: 0.019, hatch: 'timber', rValue: 2.2 },
      { name: 'Joists at 400 mm, R-38 batts', thickness: 0.35, hatch: 'batt', rValue: 38 },
    ],
  },
};

/**
 * An internal partition, which has no assembly id because the envelope spec
 * only describes the envelope.
 *
 * A partition is not part of the thermal envelope and the IECC has nothing to
 * say about it, so there is nothing in `hvac.envelope` that names one. It still
 * has to be drawn when the section cuts through it, and drawing it as an
 * exterior wall would be a lie about both its thickness and its insulation.
 */
export const PARTITION_BUILD_UP: BuildUp = {
  label: 'Internal partition',
  layers: [
    GYPSUM,
    { name: '2x4 studs at 400 mm', thickness: 0.089, hatch: 'timber', rValue: 0 },
    GYPSUM,
  ],
};

/** An intermediate floor between two heated storeys. */
export const INTERMEDIATE_FLOOR_BUILD_UP: BuildUp = {
  label: 'Floor between storeys',
  layers: [
    { name: '19 mm floor deck', thickness: 0.019, hatch: 'timber', rValue: 2.2 },
    { name: 'Joists at 400 mm', thickness: 0.235, hatch: 'timber', rValue: 0 },
    GYPSUM,
  ],
};

/* -------------------------------- Lookups --------------------------------- */

export function buildUpFor(
  table: Record<string, BuildUp>,
  assemblyId: string,
  fallback: BuildUp,
): BuildUp {
  return table[assemblyId] ?? fallback;
}

/** The real thickness of a build-up, in metres. */
export function buildUpThickness(buildUp: BuildUp): number {
  return buildUp.layers.reduce((total, layer) => total + layer.thickness, 0);
}

/**
 * Whether a drawn wall thickness and a specified assembly agree.
 *
 * Tolerance is 20 mm, which is about the difference between one plasterboard
 * choice and another and is not worth reporting. Beyond that the two facts are
 * genuinely in conflict, and the section is the first drawing in the app that
 * can see it.
 */
export function thicknessMismatch(
  drawnThickness: number,
  buildUp: BuildUp,
): { real: number; drawn: number; difference: number } | null {
  const real = buildUpThickness(buildUp);
  const difference = real - drawnThickness;
  return Math.abs(difference) > 0.02 ? { real, drawn: drawnThickness, difference } : null;
}

/**
 * A build-up's total R-value by simple addition.
 *
 * Deliberately NOT the figure the load calculation uses, and it is worth being
 * clear why the app carries two. This one adds the layers up as if the studs
 * were not there; `iecc.ts` carries the effective R, which accounts for the
 * quarter of the wall that is timber conducting around the insulation. This
 * figure is the one printed beside each layer on the drawing because it is what
 * the layer itself does. The effective figure is the one that heats the house.
 */
export function nominalRFor(buildUp: BuildUp): number {
  return buildUp.layers.reduce((total, layer) => total + layer.rValue, 0);
}

/** Resolves an IECC assembly to its build-up, keeping the label in step. */
export function buildUpOfAssembly(
  table: Record<string, BuildUp>,
  assembly: Assembly | null,
  fallback: BuildUp,
): BuildUp {
  if (!assembly) return fallback;
  return table[assembly.id] ?? fallback;
}
