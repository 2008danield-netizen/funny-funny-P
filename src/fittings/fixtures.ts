/**
 * Fixtures: the sanitaryware and the appliances.
 *
 * -----------------------------------------------------------------------------
 * WHY THESE ARE NOT FURNITURE.
 *
 * A sofa is a thing standing in a room. A WC is a thing CONNECTED to the
 * building — it needs a soil pipe, a supply, a clear space in front of it that
 * the code specifies to the inch, and a position that every other discipline
 * then has to work around. Sessions 11 onward size pipes and ducts from these,
 * and the electrical already wants to know where the cooker and the dishwasher
 * are so it can give them their own circuits.
 *
 * So they are their own thing, with their own catalogue, and everything about
 * them that another discipline needs is on the entry rather than inferred from
 * a name later.
 *
 * -----------------------------------------------------------------------------
 * THE CLEARANCES ARE PART OF THE FIXTURE.
 *
 * IRC R307 does not say "a bathroom must be usable" — it says 21 in in front of
 * a WC, 15 in from its centreline to any wall, 24 in in front of a shower door.
 * Those are properties of the fixture, so they live on the fixture, cited, and
 * the checker reads them off rather than carrying its own copy of the table.
 */

import type { PriceEstimate } from '@/furniture/catalog';
import type { ApplianceKind } from './modules';

export type FixtureFamily = 'sanitary' | 'appliance' | 'kitchen';

/**
 * What a fixture is.
 *
 * Sanitaryware and free-standing appliances share this list because they share
 * everything that matters here: a footprint, a position against a wall, a
 * clearance in front, and a connection to a service.
 */
export type FixtureKind =
  /* Sanitary */
  | 'wc'
  | 'basin'
  | 'vanity-basin'
  | 'bath'
  | 'shower'
  | 'bidet'
  | 'towel-rail'
  /* Kitchen and utility, built in or free-standing */
  | ApplianceKind;

/** Which services a fixture needs. Read by the electrical, and later the IPC. */
export interface Connections {
  /** Cold water. Everything with a tap. */
  cold: boolean;
  hot: boolean;
  /** Waste, and how big the trap is in millimetres. */
  waste: number | null;
  /** Soil, as distinct from waste — only a WC. */
  soil: boolean;
  /**
   * The electrical load in volt-amperes, or null for nothing electrical.
   *
   * These go straight into the Article 220 calculation as fixed appliances, so
   * they are nameplate figures rather than what a thing typically draws.
   */
  va: number | null;
  /** Whether the code wants a circuit of its own. NEC 210.23, 422.12. */
  dedicatedCircuit: boolean;
}

export interface FixtureClearance {
  /** Which way it is measured from. */
  side: 'front' | 'left' | 'right' | 'above';
  metres: number;
  /** The section it comes from, or empty when it is ergonomics not code. */
  section: string;
  asWritten: string;
  severity: 'required' | 'advisory';
  label: string;
}

export interface FixtureEntry {
  id: string;
  kind: FixtureKind;
  family: FixtureFamily;
  name: string;
  description: string;
  /** Metres. Width is across the face, depth is away from the wall. */
  width: number;
  depth: number;
  height: number;
  /** Where the working surface is, for a sink or a hob. Null if not one. */
  surfaceHeight: number | null;
  /** Whether it is normally built into a cabinet, or stands on its own. */
  builtIn: boolean;
  /** The module it goes in, when built in. */
  housingId: string | null;
  placement: 'wall' | 'free' | 'corner';
  connections: Connections;
  clearances: readonly FixtureClearance[];
  price?: PriceEstimate;

  /* Retailer linkage, empty until a licensed feed fills it in. */
  retailer: string | null;
  sku: string | null;
  url: string | null;
  verifiedAt: string | null;
}

const UNLINKED = { retailer: null, sku: null, url: null, verifiedAt: null } as const;
const estimate = (amount: number): PriceEstimate => ({ amount, basis: 'estimate' });

const inches = (value: number) => value * 0.0254;

const NO_SERVICES: Connections = {
  cold: false,
  hot: false,
  waste: null,
  soil: false,
  va: null,
  dedicatedCircuit: false,
};

/* ------------------------------- Clearances ------------------------------- */

/**
 * IRC R307.1 — the clear floor space every sanitary fixture needs.
 *
 * 21 in in front is the number that decides whether a small bathroom works at
 * all, and it is measured from the FRONT EDGE of the fixture, not from the
 * wall behind it — which is why a deep WC in a shallow room fails where a
 * shallow one passes.
 */
const inFront = (metres: number, asWritten: string, label: string): FixtureClearance => ({
  side: 'front',
  metres,
  section: 'R307.1',
  asWritten,
  severity: 'required',
  label,
});

const R307_FRONT = inFront(inches(21), '21 inches', 'Clear floor in front of the fixture');

/** R307.1 again: 15 in from the centreline of a WC or bidet to any wall. */
const centrelineToWall = (side: 'left' | 'right'): FixtureClearance => ({
  side,
  metres: inches(15),
  section: 'R307.1',
  asWritten: '15 inches from the centre line to any wall or obstruction',
  severity: 'required',
  label: 'Elbow room beside the pan',
});

/* -------------------------------- Entries --------------------------------- */

export const FIXTURES: readonly FixtureEntry[] = [
  /* ------------------------------ Sanitary ------------------------------- */
  {
    ...UNLINKED,
    id: 'wc-close-coupled',
    kind: 'wc',
    family: 'sanitary',
    name: 'Close-coupled WC',
    description: 'Pan with the cistern sitting on it. The ordinary one.',
    width: 0.38,
    depth: 0.7,
    height: 0.78,
    surfaceHeight: null,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: true, hot: false, waste: null, soil: true, va: null, dedicatedCircuit: false },
    clearances: [R307_FRONT, centrelineToWall('left'), centrelineToWall('right')],
    price: estimate(285),
  },
  {
    ...UNLINKED,
    id: 'wc-wall-hung',
    kind: 'wc',
    family: 'sanitary',
    name: 'Wall-hung WC',
    description: 'Pan on a concealed frame, cistern inside the wall. Needs a 200 mm duct behind it.',
    width: 0.36,
    depth: 0.54,
    height: 0.4,
    surfaceHeight: null,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: true, hot: false, waste: null, soil: true, va: null, dedicatedCircuit: false },
    clearances: [R307_FRONT, centrelineToWall('left'), centrelineToWall('right')],
    price: estimate(520),
  },
  {
    ...UNLINKED,
    id: 'basin-pedestal',
    kind: 'basin',
    family: 'sanitary',
    name: 'Pedestal basin',
    description: 'Basin on a pedestal hiding the trap.',
    width: 0.55,
    depth: 0.44,
    height: 0.85,
    surfaceHeight: 0.85,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: true, hot: true, waste: 32, soil: false, va: null, dedicatedCircuit: false },
    clearances: [R307_FRONT],
    price: estimate(165),
  },
  {
    ...UNLINKED,
    id: 'basin-vanity-600',
    kind: 'vanity-basin',
    family: 'sanitary',
    name: '600 vanity unit',
    description: 'Basin set into a cupboard, which is where the bathroom’s storage usually has to go.',
    width: 0.6,
    depth: 0.46,
    height: 0.85,
    surfaceHeight: 0.85,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: true, hot: true, waste: 32, soil: false, va: null, dedicatedCircuit: false },
    clearances: [R307_FRONT],
    price: estimate(340),
  },
  {
    ...UNLINKED,
    id: 'bath-1700',
    kind: 'bath',
    family: 'sanitary',
    name: '1700 bath',
    description: 'Straight single-ended bath, the size almost every bathroom is planned round.',
    width: 1.7,
    depth: 0.7,
    height: 0.55,
    surfaceHeight: null,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: true, hot: true, waste: 40, soil: false, va: null, dedicatedCircuit: false },
    clearances: [R307_FRONT],
    price: estimate(295),
  },
  {
    ...UNLINKED,
    id: 'bath-1500',
    kind: 'bath',
    family: 'sanitary',
    name: '1500 bath',
    description: 'Short bath, for a room that will not take 1700.',
    width: 1.5,
    depth: 0.7,
    height: 0.55,
    surfaceHeight: null,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: true, hot: true, waste: 40, soil: false, va: null, dedicatedCircuit: false },
    clearances: [R307_FRONT],
    price: estimate(265),
  },
  {
    ...UNLINKED,
    id: 'shower-900',
    kind: 'shower',
    family: 'sanitary',
    name: '900 square shower',
    description: 'Square tray and enclosure. 900 is the smallest that is genuinely comfortable.',
    width: 0.9,
    depth: 0.9,
    height: 2.0,
    surfaceHeight: null,
    builtIn: false,
    housingId: null,
    placement: 'corner',
    connections: { cold: true, hot: true, waste: 40, soil: false, va: null, dedicatedCircuit: false },
    clearances: [
      {
        side: 'front',
        metres: inches(24),
        section: 'R307.1',
        asWritten: '24 inches in front of the shower opening',
        severity: 'required',
        label: 'Room to get in and out',
      },
    ],
    price: estimate(430),
  },
  {
    ...UNLINKED,
    id: 'shower-1200',
    kind: 'shower',
    family: 'sanitary',
    name: '1200 × 800 shower',
    description: 'Rectangular tray, for a wall that has the length but not the depth.',
    width: 1.2,
    depth: 0.8,
    height: 2.0,
    surfaceHeight: null,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: true, hot: true, waste: 40, soil: false, va: null, dedicatedCircuit: false },
    clearances: [
      {
        side: 'front',
        metres: inches(24),
        section: 'R307.1',
        asWritten: '24 inches in front of the shower opening',
        severity: 'required',
        label: 'Room to get in and out',
      },
    ],
    price: estimate(560),
  },
  {
    ...UNLINKED,
    id: 'bidet',
    kind: 'bidet',
    family: 'sanitary',
    name: 'Bidet',
    description: 'Floor-standing bidet.',
    width: 0.36,
    depth: 0.56,
    height: 0.4,
    surfaceHeight: null,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: true, hot: true, waste: 32, soil: false, va: null, dedicatedCircuit: false },
    clearances: [R307_FRONT, centrelineToWall('left'), centrelineToWall('right')],
    price: estimate(240),
  },
  {
    ...UNLINKED,
    id: 'towel-rail',
    kind: 'towel-rail',
    family: 'sanitary',
    name: 'Heated towel rail',
    description: 'Wall-mounted, and usually the only heat in the room.',
    width: 0.5,
    depth: 0.1,
    height: 1.2,
    surfaceHeight: null,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: false, hot: true, waste: null, soil: false, va: 600, dedicatedCircuit: false },
    clearances: [],
    price: estimate(180),
  },

  /* ------------------------------- Kitchen ------------------------------- */
  {
    ...UNLINKED,
    id: 'sink-1.5-bowl',
    kind: 'sink',
    family: 'kitchen',
    name: 'Inset sink, one and a half bowl',
    description: 'Dropped into the worktop, over an 800 sink base.',
    width: 0.86,
    depth: 0.5,
    height: 0.2,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'base-800-sink',
    placement: 'wall',
    connections: { cold: true, hot: true, waste: 40, soil: false, va: null, dedicatedCircuit: false },
    clearances: [],
    price: estimate(215),
  },
  {
    ...UNLINKED,
    id: 'sink-single',
    kind: 'sink',
    family: 'kitchen',
    name: 'Inset sink, single bowl',
    description: 'Over a 600 sink base.',
    width: 0.5,
    depth: 0.44,
    height: 0.2,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'base-600-sink',
    placement: 'wall',
    connections: { cold: true, hot: true, waste: 40, soil: false, va: null, dedicatedCircuit: false },
    clearances: [],
    price: estimate(145),
  },
  {
    ...UNLINKED,
    id: 'hob-induction-600',
    kind: 'hob',
    family: 'kitchen',
    name: '600 induction hob',
    description: 'Four zones, dropped into the worktop.',
    width: 0.59,
    depth: 0.52,
    height: 0.06,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'base-600-hob',
    placement: 'wall',
    /*
     * 7,400 VA and its own circuit. An induction hob is the single biggest
     * fixed load in an ordinary house after the heating, and it is the reason
     * a kitchen refit so often needs the service looked at.
     */
    connections: { cold: false, hot: false, waste: null, soil: false, va: 7400, dedicatedCircuit: true },
    clearances: [
      {
        side: 'above',
        metres: 0.65,
        section: '',
        asWritten: '650 mm to an extractor above an electric hob',
        severity: 'advisory',
        label: 'Headroom over the hob',
      },
    ],
    price: estimate(420),
  },
  {
    ...UNLINKED,
    id: 'hob-gas-600',
    kind: 'hob',
    family: 'kitchen',
    name: '600 gas hob',
    description: 'Four burners. Needs a gas supply, which this app does not model.',
    width: 0.58,
    depth: 0.51,
    height: 0.05,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'base-600-hob',
    placement: 'wall',
    connections: { cold: false, hot: false, waste: null, soil: false, va: 120, dedicatedCircuit: false },
    clearances: [
      {
        side: 'above',
        metres: 0.75,
        section: '',
        asWritten: '750 mm to an extractor above a gas hob',
        severity: 'advisory',
        label: 'Headroom over the hob',
      },
    ],
    price: estimate(260),
  },
  {
    ...UNLINKED,
    id: 'oven-single',
    kind: 'oven',
    family: 'kitchen',
    name: 'Single oven',
    description: 'Built in, under a worktop or at eye level in a housing.',
    width: 0.595,
    depth: 0.56,
    height: 0.595,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'tall-600-oven',
    placement: 'wall',
    connections: { cold: false, hot: false, waste: null, soil: false, va: 3000, dedicatedCircuit: true },
    clearances: [],
    price: estimate(480),
  },
  {
    ...UNLINKED,
    id: 'cooker-freestanding',
    kind: 'oven',
    family: 'appliance',
    name: '600 freestanding cooker',
    description: 'Oven and hob in one, standing in a 600 gap in the run.',
    width: 0.6,
    depth: 0.6,
    height: 0.9,
    surfaceHeight: 0.9,
    builtIn: false,
    housingId: null,
    placement: 'wall',
    connections: { cold: false, hot: false, waste: null, soil: false, va: 9600, dedicatedCircuit: true },
    clearances: [
      {
        side: 'above',
        metres: 0.65,
        section: '',
        asWritten: '650 mm to an extractor above an electric cooker',
        severity: 'advisory',
        label: 'Headroom over the cooker',
      },
    ],
    price: estimate(560),
  },
  {
    ...UNLINKED,
    id: 'dishwasher-600',
    kind: 'dishwasher',
    family: 'appliance',
    name: '600 dishwasher',
    description: 'Integrated behind a door, or free-standing in a gap.',
    width: 0.598,
    depth: 0.57,
    height: 0.82,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'base-600-appliance',
    placement: 'wall',
    connections: { cold: true, hot: false, waste: 40, soil: false, va: 1800, dedicatedCircuit: true },
    clearances: [],
    price: estimate(430),
  },
  {
    ...UNLINKED,
    id: 'washing-machine-600',
    kind: 'washing-machine',
    family: 'appliance',
    name: '600 washing machine',
    description: 'Front loader. NEC 210.11(C)(2) wants the laundry receptacle on its own circuit.',
    width: 0.6,
    depth: 0.6,
    height: 0.85,
    surfaceHeight: null,
    builtIn: false,
    housingId: 'base-600-appliance',
    placement: 'wall',
    connections: { cold: true, hot: false, waste: 40, soil: false, va: 2400, dedicatedCircuit: true },
    clearances: [],
    price: estimate(480),
  },
  {
    ...UNLINKED,
    id: 'tumble-dryer-600',
    kind: 'tumble-dryer',
    family: 'appliance',
    name: '600 tumble dryer',
    description: 'Condenser or heat pump; a vented one also needs a duct through the wall.',
    width: 0.6,
    depth: 0.6,
    height: 0.85,
    surfaceHeight: null,
    builtIn: false,
    housingId: 'base-600-appliance',
    placement: 'wall',
    connections: { cold: false, hot: false, waste: null, soil: false, va: 3000, dedicatedCircuit: true },
    clearances: [],
    price: estimate(520),
  },
  {
    ...UNLINKED,
    id: 'fridge-freezer-600',
    kind: 'fridge-freezer',
    family: 'appliance',
    name: '600 fridge freezer',
    description: 'Free-standing, full height.',
    width: 0.6,
    depth: 0.65,
    height: 2.0,
    surfaceHeight: null,
    builtIn: false,
    housingId: 'tall-600-fridge',
    placement: 'wall',
    connections: { cold: false, hot: false, waste: null, soil: false, va: 700, dedicatedCircuit: false },
    clearances: [],
    price: estimate(640),
  },
  {
    ...UNLINKED,
    id: 'fridge-integrated',
    kind: 'fridge',
    family: 'appliance',
    name: 'Integrated fridge',
    description: 'Behind a door, in a tall housing.',
    width: 0.54,
    depth: 0.55,
    height: 1.77,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'tall-600-fridge',
    placement: 'wall',
    connections: { cold: false, hot: false, waste: null, soil: false, va: 600, dedicatedCircuit: false },
    clearances: [],
    price: estimate(720),
  },
  {
    ...UNLINKED,
    id: 'extractor-600',
    kind: 'extractor',
    family: 'appliance',
    name: '600 extractor hood',
    description: 'Over the hob. IRC M1503 wants 100 cfm ducted to the outside.',
    width: 0.6,
    depth: 0.5,
    height: 0.4,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'wall-600-extractor',
    placement: 'wall',
    connections: { cold: false, hot: false, waste: null, soil: false, va: 250, dedicatedCircuit: false },
    clearances: [],
    price: estimate(230),
  },
  {
    ...UNLINKED,
    id: 'microwave-built-in',
    kind: 'microwave',
    family: 'appliance',
    name: 'Built-in microwave',
    description: 'In a wall or tall housing.',
    width: 0.595,
    depth: 0.35,
    height: 0.388,
    surfaceHeight: null,
    builtIn: true,
    housingId: 'wall-600-microwave',
    placement: 'wall',
    connections: { cold: false, hot: false, waste: null, soil: false, va: 1500, dedicatedCircuit: false },
    clearances: [],
    price: estimate(310),
  },
];

const BY_ID = new Map(FIXTURES.map((entry) => [entry.id, entry]));

export function getFixture(id: string): FixtureEntry | null {
  return BY_ID.get(id) ?? null;
}

export function isKnownFixture(id: string): boolean {
  return BY_ID.has(id);
}

export function fixturesOfKind(kind: FixtureKind): FixtureEntry[] {
  return FIXTURES.filter((entry) => entry.kind === kind);
}

export function fixturesOfFamily(family: FixtureFamily): FixtureEntry[] {
  return FIXTURES.filter((entry) => entry.family === family);
}

/** The first fixture of a kind, for the layouts to reach for a sensible default. */
export function defaultFixture(kind: FixtureKind): FixtureEntry | null {
  return FIXTURES.find((entry) => entry.kind === kind) ?? null;
}

/** Whether this kind is sanitaryware, which decides which checks apply. */
export function isSanitary(kind: FixtureKind): boolean {
  return (
    kind === 'wc' ||
    kind === 'basin' ||
    kind === 'vanity-basin' ||
    kind === 'bath' ||
    kind === 'shower' ||
    kind === 'bidet'
  );
}

/** Whether it washes something, which decides whether a room needs ventilating. */
export function isWet(kind: FixtureKind): boolean {
  return isSanitary(kind) || kind === 'sink' || kind === 'dishwasher' || kind === 'washing-machine';
}

export const FIXTURE_ATTRIBUTION =
  'Fixture dimensions are typical sizes written from general knowledge, not measured from any particular ' +
  'product, and the prices are estimates rather than quotations. Check the dimensions of what you actually ' +
  'buy before anything is built to them.';

export { NO_SERVICES };
