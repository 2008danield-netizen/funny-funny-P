/**
 * Kitchen cabinetry: the module widths a kitchen is actually sold in.
 *
 * -----------------------------------------------------------------------------
 * WHY MODULES AND NOT ARBITRARY WIDTHS.
 *
 * A kitchen is not built to fit the room. It is assembled from a small set of
 * standard carcass widths, and the room takes up the slack in FILLERS — narrow
 * blank panels at the ends and at the corners. A planner that lets you type any
 * width produces a kitchen nobody can order and a price that means nothing.
 *
 * So the widths here are the real ones (IKEA's METOD metric series, which is
 * also close enough to every other European system to be useful), the bodies
 * are drawn parametrically from those widths, and anything that is not a module
 * width is explicitly a filler and is labelled as one.
 *
 * The bodies being parametric is the other half of the bargain: a "600 mm three
 * drawer base" is a carcass, three fronts and three handles worked out from one
 * width and one height, not a bespoke mesh. That is what makes it possible to
 * add a width, or later a real product with real dimensions, without modelling
 * anything.
 *
 * -----------------------------------------------------------------------------
 * HEIGHTS ARE DERIVED, NOT WRITTEN DOWN.
 *
 * The worktop height that matters — the number somebody stands at — is the
 * plinth plus the carcass plus the worktop thickness. Writing "0.90 m" as well
 * would be the same fact stated twice, and the two part company the first time
 * somebody specifies a thicker worktop. `worktopHeight()` is the only place it
 * exists.
 */

import type { PriceEstimate } from '@/furniture/catalog';

/** The three families a kitchen is built from. */
export type CabinetKind = 'base' | 'wall' | 'tall';

/** What fills the front of a carcass. */
export type ModuleFront =
  | 'door'
  | 'double-door'
  | 'drawers-2'
  | 'drawers-3'
  | 'drawers-4'
  | 'open'
  /** An L-shaped carcass that turns an internal corner. */
  | 'corner'
  /** A blank panel taking up the slack. Never a module width. */
  | 'filler'
  /** A gap for a free-standing appliance to stand in. */
  | 'appliance'
  /** A door under a sink, with the plumbing knocked out. */
  | 'sink';

/** Things that live inside or on top of a cabinet. */
export type ApplianceKind =
  | 'sink'
  | 'hob'
  | 'oven'
  | 'dishwasher'
  | 'washing-machine'
  | 'tumble-dryer'
  | 'fridge'
  | 'freezer'
  | 'fridge-freezer'
  | 'microwave'
  | 'extractor';

/**
 * The carcass dimensions of each family, in metres.
 *
 * `lift` is how far the bottom of the carcass sits above the floor: a base unit
 * stands on its plinth, a wall unit hangs. The wall lift is what puts 500 mm of
 * clear splashback between the worktop and the cupboard above it, which is the
 * distance an ordinary kettle needs and the one every kitchen is built to.
 */
export const CARCASS = {
  base: { depth: 0.6, height: 0.8, lift: 0.08 },
  wall: { depth: 0.37, height: 0.8, lift: 1.4 },
  tall: { depth: 0.6, height: 2.0, lift: 0.08 },
} as const satisfies Record<CabinetKind, { depth: number; height: number; lift: number }>;

/** The worktop: deeper than the carcass, so it overhangs the doors. */
export const WORKTOP = {
  depth: 0.635,
  thickness: 0.038,
  /** How far it stands proud of the wall-side edge of the carcass. */
  get overhang(): number {
    return this.depth - CARCASS.base.depth;
  },
} as const;

/**
 * How high the worktop is.
 *
 * 918 mm with the standard build, which is between the 900 mm most of Europe
 * quotes and the 36 in (914 mm) the US builds to — because it is neither, it is
 * what the parts add up to.
 */
export function worktopHeight(): number {
  return CARCASS.base.lift + CARCASS.base.height + WORKTOP.thickness;
}

/** The top of a wall unit, which is what a wall elevation is dimensioned to. */
export function wallUnitTop(): number {
  return CARCASS.wall.lift + CARCASS.wall.height;
}

/* -------------------------------- Modules --------------------------------- */

export interface CabinetModule {
  id: string;
  kind: CabinetKind;
  /** Carcass width in metres. A filler has no fixed width. */
  width: number;
  front: ModuleFront;
  label: string;
  /** Appliances this module is built to take, if any. */
  hosts: readonly ApplianceKind[];
  price?: PriceEstimate;
}

/** Every figure here is an estimate written from general knowledge. */
const estimate = (amount: number): PriceEstimate => ({ amount, basis: 'estimate' });

/**
 * The catalogue of modules.
 *
 * Ordered widest first within each family, because filling a run works
 * greedily from the widest that fits — which is both how a kitchen is actually
 * specified (fewer, bigger units) and what leaves the least filler.
 */
export const MODULES: readonly CabinetModule[] = [
  /* ------------------------------ Base units ----------------------------- */
  { id: 'base-1000-double', kind: 'base', width: 1.0, front: 'double-door', label: '1000 double door base', hosts: [], price: estimate(215) },
  { id: 'base-800-double', kind: 'base', width: 0.8, front: 'double-door', label: '800 double door base', hosts: [], price: estimate(185) },
  { id: 'base-800-drawers', kind: 'base', width: 0.8, front: 'drawers-3', label: '800 three drawer base', hosts: [], price: estimate(265) },
  { id: 'base-800-sink', kind: 'base', width: 0.8, front: 'sink', label: '800 sink base', hosts: ['sink'], price: estimate(175) },
  { id: 'base-600-door', kind: 'base', width: 0.6, front: 'door', label: '600 door base', hosts: [], price: estimate(125) },
  { id: 'base-600-drawers', kind: 'base', width: 0.6, front: 'drawers-3', label: '600 three drawer base', hosts: [], price: estimate(215) },
  { id: 'base-600-drawers4', kind: 'base', width: 0.6, front: 'drawers-4', label: '600 four drawer base', hosts: [], price: estimate(235) },
  { id: 'base-600-sink', kind: 'base', width: 0.6, front: 'sink', label: '600 sink base', hosts: ['sink'], price: estimate(135) },
  { id: 'base-600-hob', kind: 'base', width: 0.6, front: 'drawers-2', label: '600 hob base', hosts: ['hob'], price: estimate(195) },
  { id: 'base-600-oven', kind: 'base', width: 0.6, front: 'appliance', label: '600 built-under oven housing', hosts: ['oven'], price: estimate(115) },
  { id: 'base-600-appliance', kind: 'base', width: 0.6, front: 'appliance', label: '600 appliance space', hosts: ['dishwasher', 'washing-machine', 'tumble-dryer', 'fridge'], price: estimate(75) },
  { id: 'base-450-door', kind: 'base', width: 0.45, front: 'door', label: '450 door base', hosts: [], price: estimate(105) },
  { id: 'base-400-drawers', kind: 'base', width: 0.4, front: 'drawers-3', label: '400 three drawer base', hosts: [], price: estimate(165) },
  { id: 'base-300-door', kind: 'base', width: 0.3, front: 'door', label: '300 door base', hosts: [], price: estimate(85) },
  { id: 'base-200-open', kind: 'base', width: 0.2, front: 'open', label: '200 open base', hosts: [], price: estimate(55) },
  {
    /*
     * The corner. 880 mm on each leg is IKEA's METOD corner, and the number is
     * not arbitrary: it is the carcass depth plus a 280 mm door, which is the
     * narrowest opening a person can actually reach through.
     */
    id: 'base-corner',
    kind: 'base',
    width: 0.88,
    front: 'corner',
    label: 'Corner base, 880 each way',
    hosts: [],
    price: estimate(245),
  },
  { id: 'base-filler', kind: 'base', width: 0, front: 'filler', label: 'Base filler panel', hosts: [], price: estimate(25) },

  /* ------------------------------ Wall units ----------------------------- */
  { id: 'wall-800-double', kind: 'wall', width: 0.8, front: 'double-door', label: '800 double door wall', hosts: [], price: estimate(145) },
  { id: 'wall-600-door', kind: 'wall', width: 0.6, front: 'door', label: '600 door wall', hosts: [], price: estimate(105) },
  { id: 'wall-600-extractor', kind: 'wall', width: 0.6, front: 'appliance', label: '600 extractor housing', hosts: ['extractor'], price: estimate(95) },
  { id: 'wall-600-microwave', kind: 'wall', width: 0.6, front: 'appliance', label: '600 microwave housing', hosts: ['microwave'], price: estimate(115) },
  { id: 'wall-400-door', kind: 'wall', width: 0.4, front: 'door', label: '400 door wall', hosts: [], price: estimate(85) },
  { id: 'wall-300-door', kind: 'wall', width: 0.3, front: 'door', label: '300 door wall', hosts: [], price: estimate(75) },
  { id: 'wall-600-open', kind: 'wall', width: 0.6, front: 'open', label: '600 open shelf', hosts: [], price: estimate(65) },
  { id: 'wall-corner', kind: 'wall', width: 0.67, front: 'corner', label: 'Corner wall, 670 each way', hosts: [], price: estimate(155) },
  { id: 'wall-filler', kind: 'wall', width: 0, front: 'filler', label: 'Wall filler panel', hosts: [], price: estimate(20) },

  /* ------------------------------ Tall units ----------------------------- */
  { id: 'tall-600-larder', kind: 'tall', width: 0.6, front: 'double-door', label: '600 larder', hosts: [], price: estimate(325) },
  { id: 'tall-600-oven', kind: 'tall', width: 0.6, front: 'appliance', label: '600 oven housing', hosts: ['oven', 'microwave'], price: estimate(285) },
  { id: 'tall-600-fridge', kind: 'tall', width: 0.6, front: 'appliance', label: '600 fridge housing', hosts: ['fridge', 'freezer', 'fridge-freezer'], price: estimate(265) },
  { id: 'tall-400-broom', kind: 'tall', width: 0.4, front: 'door', label: '400 broom cupboard', hosts: [], price: estimate(245) },
  { id: 'tall-filler', kind: 'tall', width: 0, front: 'filler', label: 'Tall filler panel', hosts: [], price: estimate(35) },
];

const BY_ID = new Map(MODULES.map((entry) => [entry.id, entry]));

export function getModule(id: string): CabinetModule | null {
  return BY_ID.get(id) ?? null;
}

export function isKnownModule(id: string): boolean {
  return BY_ID.has(id);
}

/** The modules of one family, widest first. */
export function modulesOfKind(kind: CabinetKind): CabinetModule[] {
  return MODULES.filter((entry) => entry.kind === kind && entry.front !== 'filler' && entry.front !== 'corner');
}

/** The filler for a family — the module a leftover gap becomes. */
export function fillerFor(kind: CabinetKind): CabinetModule {
  return MODULES.find((entry) => entry.kind === kind && entry.front === 'filler')!;
}

/** The corner unit for a family, if it has one. */
export function cornerFor(kind: CabinetKind): CabinetModule | null {
  return MODULES.find((entry) => entry.kind === kind && entry.front === 'corner') ?? null;
}

/** The module an appliance is normally built into. */
export function housingFor(appliance: ApplianceKind): CabinetModule | null {
  return MODULES.find((entry) => entry.hosts.includes(appliance)) ?? null;
}

/**
 * The distinct widths a family comes in, widest first.
 *
 * Fillers are excluded: a filler has no width of its own, it is whatever is
 * left. Corners are excluded too, because a corner is placed by the geometry
 * rather than chosen to fill a length.
 */
export function widthsOfKind(kind: CabinetKind): number[] {
  const widths = new Set(modulesOfKind(kind).map((entry) => entry.width));
  return [...widths].sort((a, b) => b - a);
}

/* ------------------------------- Worktops --------------------------------- */

export type WorktopMaterial = 'laminate' | 'solid-wood' | 'quartz' | 'granite' | 'stainless';

export interface WorktopSpec {
  material: WorktopMaterial;
  colour: string;
  /** Whether a splashback runs up the wall behind it. */
  splashback: boolean;
}

export const WORKTOP_MATERIALS: ReadonlyArray<{
  id: WorktopMaterial;
  label: string;
  colour: string;
  /** Estimate per square metre, in euros. */
  perSquareMetre: number;
}> = [
  { id: 'laminate', label: 'Laminate', colour: '#d9d2c6', perSquareMetre: 85 },
  { id: 'solid-wood', label: 'Solid wood', colour: '#c9a06a', perSquareMetre: 190 },
  { id: 'quartz', label: 'Quartz', colour: '#e8e6e1', perSquareMetre: 420 },
  { id: 'granite', label: 'Granite', colour: '#4a4a4e', perSquareMetre: 480 },
  { id: 'stainless', label: 'Stainless steel', colour: '#b9bcc0', perSquareMetre: 350 },
];

export function worktopMaterial(id: WorktopMaterial) {
  return WORKTOP_MATERIALS.find((entry) => entry.id === id) ?? WORKTOP_MATERIALS[0]!;
}

/* ------------------------------- Colourways -------------------------------- */

/** A door finish. Carcasses are always white, as they are in real kitchens. */
export interface DoorFinish {
  id: string;
  label: string;
  /** The door and drawer fronts. */
  front: string;
  /** Handles and rails. */
  handle: string;
}

export const DOOR_FINISHES: readonly DoorFinish[] = [
  { id: 'white', label: 'White', front: '#f2f0ec', handle: '#9aa0a6' },
  { id: 'off-white', label: 'Off-white', front: '#e8e2d6', handle: '#9aa0a6' },
  { id: 'grey', label: 'Grey', front: '#9ea3a7', handle: '#3f4247' },
  { id: 'anthracite', label: 'Anthracite', front: '#3f4247', handle: '#b9bcc0' },
  { id: 'sage', label: 'Sage', front: '#8d9a86', handle: '#3f4247' },
  { id: 'navy', label: 'Deep blue', front: '#3a4759', handle: '#c9a86a' },
  { id: 'oak', label: 'Oak effect', front: '#c9a878', handle: '#3f4247' },
  { id: 'walnut', label: 'Walnut effect', front: '#7a5638', handle: '#c9b48a' },
];

export function doorFinish(id: string): DoorFinish {
  return DOOR_FINISHES.find((entry) => entry.id === id) ?? DOOR_FINISHES[0]!;
}

/** Trademark notice, shown wherever the module names appear. */
export const MODULE_ATTRIBUTION =
  'Module widths follow IKEA’s METOD series, which is the size standard most European kitchens are built to. ' +
  'The dimensions and prices here are written from general knowledge — nothing is scraped, no listing has been ' +
  'checked, and there is no affiliation with or endorsement by IKEA. Prices are estimates, never quotations.';
