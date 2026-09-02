/**
 * The furniture catalogue.
 *
 * -----------------------------------------------------------------------------
 * ABOUT THIS DATA — read before shipping commercially.
 *
 * Entries name real IKEA products. IKEA and the product names below are
 * trademarks of Inter IKEA Systems B.V.; havavamama is not affiliated with,
 * endorsed by, or sponsored by IKEA. The names are used descriptively so a user
 * can recognise the piece they own or intend to buy.
 *
 * The dimensions are NOT scraped — IKEA's terms prohibit that and they publish
 * no open API. They are written from general knowledge of the published nominal
 * sizes, and IKEA revises and discontinues products continually. Every entry
 * therefore carries `verifiedAt: null`, meaning nobody has checked it against a
 * current listing. Before this catalogue backs a paid product:
 *
 *   1. Verify each entry against the current IKEA listing and set `verifiedAt`.
 *   2. Settle the trademark position — IKEA runs affiliate and partner
 *      programmes, which is the ordinary route to using product data properly.
 *
 * The `retailer`, `sku` and `url` fields exist so that a licensed data feed can
 * populate them later without touching any other code, and so a design document
 * that references catalogue IDs keeps working when it does.
 * -----------------------------------------------------------------------------
 */

export type CatalogCategory =
  | 'Seating'
  | 'Tables'
  | 'Storage'
  | 'Beds'
  | 'Workspace'
  | 'Rugs'
  | 'Lighting';

/**
 * How a piece is drawn.
 *
 * A discriminated union rather than a mesh file: each variant names a builder in
 * `furniture/builders.ts` and carries only the parameters that builder needs, so
 * a sofa and a bookcase share no accidental fields.
 */
export type BuildSpec =
  | { kind: 'sofa'; seats: number; arms: 'low' | 'high' | 'none'; chaise?: boolean }
  | { kind: 'armchair'; style: 'lounge' | 'wing' | 'office' }
  | { kind: 'chair'; back: 'slat' | 'solid' | 'round' }
  | { kind: 'table'; shape: 'rect' | 'round'; legs: 'corner' | 'trestle'; apron: boolean; glass?: boolean }
  | { kind: 'shelving'; columns: number; rows: number; back: boolean }
  | { kind: 'cabinet'; doors: number; drawers: number; plinth: boolean }
  | { kind: 'bed'; headboard: number; storage: boolean }
  | { kind: 'rug'; shape: 'rect' | 'round' }
  | { kind: 'lamp'; style: 'floor' | 'table' }
  | { kind: 'desk'; drawers: number }
  | { kind: 'trolley'; tiers: number };

/** A colour option. Roles map onto the material slots used by the builders. */
export interface Colorway {
  id: string;
  label: string;
  /** Carcass, frame, legs — the structural material. */
  frame: string;
  /** Upholstery, mattress, rug pile. */
  soft: string;
  /** Handles, metal legs, fittings. */
  accent: string;
}

export interface CatalogEntry {
  id: string;
  /** The IKEA product name. */
  name: string;
  /** Series or collection the product belongs to. */
  series: string;
  category: CatalogCategory;
  description: string;

  /** Nominal dimensions, in metres. Width x Depth x Height. */
  width: number;
  depth: number;
  height: number;

  build: BuildSpec;
  colorways: Colorway[];

  /**
   * Whether the user may resize it, and within what bounds in metres.
   *
   * Absent for almost everything: a BILLY bookcase is 80 cm wide and letting
   * someone stretch it to 120 cm would make the dimensions on screen a lie,
   * which defeats the point of a catalogue with real sizes. Present only where
   * the real product genuinely varies, such as an extendable dining table.
   */
  resizable?: { width?: [number, number]; depth?: [number, number] };

  /**
   * Collision layer. Rugs lie flat on the floor and everything else stands on
   * top of them, so they take part in room containment but block nothing.
   */
  layer: 'floor' | 'furniture';

  /** Whether the piece is normally pushed against a wall. Drives auto-snapping. */
  placement: 'wall' | 'free';

  /* ---- Retailer linkage: empty until a licensed data feed fills it in. ---- */
  retailer: string | null;
  sku: string | null;
  url: string | null;
  /** ISO date the dimensions were last checked against a live listing. */
  verifiedAt: string | null;
}

/* ------------------------------- Colourways ---------------------------- */

const OAK: Colorway = { id: 'oak', label: 'Oak', frame: '#c49a63', soft: '#d9cdb8', accent: '#8d8d8d' };
const WHITE: Colorway = { id: 'white', label: 'White', frame: '#eeece8', soft: '#e3e0da', accent: '#b9b9b9' };
const BLACK_BROWN: Colorway = { id: 'black-brown', label: 'Black-brown', frame: '#3b2f28', soft: '#4a3d34', accent: '#8d8d8d' };
const BIRCH: Colorway = { id: 'birch', label: 'Birch', frame: '#dcc9a6', soft: '#cfc4ae', accent: '#9a9a9a' };
const PINE: Colorway = { id: 'pine', label: 'Pine', frame: '#d3ae76', soft: '#c9bda6', accent: '#9a9a9a' };

const LINEN: Colorway = { id: 'linen', label: 'Light beige', frame: '#8c7f6d', soft: '#d7cdba', accent: '#6f6f6f' };
const CHARCOAL: Colorway = { id: 'charcoal', label: 'Dark grey', frame: '#3f4247', soft: '#4e5257', accent: '#6f6f6f' };
const SAGE: Colorway = { id: 'sage', label: 'Sage', frame: '#6d7566', soft: '#93a089', accent: '#6f6f6f' };
const NAVY: Colorway = { id: 'navy', label: 'Dark blue', frame: '#2f3a4c', soft: '#3d4c63', accent: '#6f6f6f' };
const RUST: Colorway = { id: 'rust', label: 'Rust', frame: '#7d4a35', soft: '#a4614a', accent: '#6f6f6f' };

const UPHOLSTERY = [LINEN, CHARCOAL, SAGE, NAVY, RUST];

/*
 * Two orderings of the same wood finishes, because the FIRST entry is what a
 * piece gets when it is dropped into a room.
 *
 * Leading everything with oak made a furnished room read as a single wall of
 * tan: storage is the bulkiest thing in most rooms, and in real interiors it is
 * usually the white or painted piece that the wooden furniture sits against.
 * Storage and wardrobes therefore default to white, while tables and seating
 * frames — where the timber is the point — still default to oak.
 */
const WOODS = [OAK, WHITE, BLACK_BROWN, BIRCH];
const WOODS_WHITE_FIRST = [WHITE, OAK, BLACK_BROWN, BIRCH];

/* -------------------------------- Entries ------------------------------ */

/** Shared defaults for the retailer-linkage fields. */
const UNLINKED = { retailer: null, sku: null, url: null, verifiedAt: null } as const;

export const CATALOG: readonly CatalogEntry[] = [
  /* ------------------------------ Seating ----------------------------- */
  {
    ...UNLINKED,
    id: 'kivik-3',
    name: 'KIVIK',
    series: 'KIVIK',
    category: 'Seating',
    description: 'Deep three-seat sofa with generous loose cushions.',
    width: 2.28,
    depth: 0.95,
    height: 0.83,
    build: { kind: 'sofa', seats: 3, arms: 'low' },
    colorways: UPHOLSTERY,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'ektorp-3',
    name: 'EKTORP',
    series: 'EKTORP',
    category: 'Seating',
    description: 'Classic three-seat sofa with a high back and removable covers.',
    width: 2.18,
    depth: 0.88,
    height: 0.88,
    build: { kind: 'sofa', seats: 3, arms: 'high' },
    colorways: UPHOLSTERY,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'soderhamn-3',
    name: 'SÖDERHAMN',
    series: 'SÖDERHAMN',
    category: 'Seating',
    description: 'Low, wide three-seat sofa with a relaxed profile.',
    width: 1.98,
    depth: 0.99,
    height: 0.83,
    build: { kind: 'sofa', seats: 3, arms: 'low' },
    colorways: UPHOLSTERY,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'klippan-2',
    name: 'KLIPPAN',
    series: 'KLIPPAN',
    category: 'Seating',
    description: 'Compact two-seat sofa for a small room.',
    width: 1.8,
    depth: 0.88,
    height: 0.66,
    build: { kind: 'sofa', seats: 2, arms: 'low' },
    colorways: UPHOLSTERY,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'friheten-corner',
    name: 'FRIHETEN',
    series: 'FRIHETEN',
    category: 'Seating',
    description: 'Corner sofa-bed with storage under the chaise.',
    width: 2.3,
    depth: 1.51,
    height: 0.66,
    build: { kind: 'sofa', seats: 3, arms: 'low', chaise: true },
    colorways: UPHOLSTERY,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'poang',
    name: 'POÄNG',
    series: 'POÄNG',
    category: 'Seating',
    description: 'Bentwood armchair with a springy layer-glued frame.',
    width: 0.68,
    depth: 0.82,
    height: 1.0,
    build: { kind: 'armchair', style: 'lounge' },
    colorways: [BIRCH, BLACK_BROWN, OAK, WHITE],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'strandmon',
    name: 'STRANDMON',
    series: 'STRANDMON',
    category: 'Seating',
    description: 'High wing-back armchair with a shielded head rest.',
    width: 0.82,
    depth: 0.96,
    height: 1.01,
    build: { kind: 'armchair', style: 'wing' },
    colorways: UPHOLSTERY,
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'ingolf-chair',
    name: 'INGOLF',
    series: 'INGOLF',
    category: 'Seating',
    description: 'Solid wood dining chair with a tall slatted back.',
    width: 0.43,
    depth: 0.52,
    height: 1.0,
    build: { kind: 'chair', back: 'slat' },
    colorways: [WHITE, BLACK_BROWN, PINE],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'stefan-chair',
    name: 'STEFAN',
    series: 'STEFAN',
    category: 'Seating',
    description: 'Sturdy solid pine dining chair.',
    width: 0.39,
    depth: 0.49,
    height: 0.9,
    build: { kind: 'chair', back: 'slat' },
    colorways: [BLACK_BROWN, PINE],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'odger-chair',
    name: 'ODGER',
    series: 'ODGER',
    category: 'Seating',
    description: 'Moulded shell chair on splayed wooden legs.',
    width: 0.55,
    depth: 0.5,
    height: 0.82,
    build: { kind: 'chair', back: 'round' },
    colorways: [WHITE, CHARCOAL, LINEN],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'markus-chair',
    name: 'MARKUS',
    series: 'MARKUS',
    category: 'Seating',
    description: 'High-backed swivel office chair with a mesh upper.',
    width: 0.62,
    depth: 0.6,
    height: 1.35,
    build: { kind: 'armchair', style: 'office' },
    colorways: [CHARCOAL, NAVY],
    layer: 'furniture',
    placement: 'free',
  },

  /* ------------------------------- Tables ----------------------------- */
  {
    ...UNLINKED,
    id: 'lack-coffee',
    name: 'LACK',
    series: 'LACK',
    category: 'Tables',
    description: 'Lightweight coffee table with a hollow board top.',
    width: 0.9,
    depth: 0.55,
    height: 0.45,
    build: { kind: 'table', shape: 'rect', legs: 'corner', apron: false },
    colorways: WOODS,
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'lack-side',
    name: 'LACK side table',
    series: 'LACK',
    category: 'Tables',
    description: 'Square side table, the small one everyone owns.',
    width: 0.55,
    depth: 0.55,
    height: 0.45,
    build: { kind: 'table', shape: 'rect', legs: 'corner', apron: false },
    colorways: WOODS,
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'lisabo-coffee',
    name: 'LISABO',
    series: 'LISABO',
    category: 'Tables',
    description: 'Ash veneer coffee table with tapered legs.',
    width: 1.18,
    depth: 0.5,
    height: 0.45,
    build: { kind: 'table', shape: 'rect', legs: 'corner', apron: true },
    colorways: [BIRCH, OAK, BLACK_BROWN],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'vittsjo-coffee',
    name: 'VITTSJÖ',
    series: 'VITTSJÖ',
    category: 'Tables',
    description: 'Glass-topped coffee table on a slim steel frame.',
    width: 0.9,
    depth: 0.5,
    height: 0.45,
    build: { kind: 'table', shape: 'rect', legs: 'corner', apron: false, glass: true },
    colorways: [CHARCOAL, WHITE],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'ekedalen-table',
    name: 'EKEDALEN',
    series: 'EKEDALEN',
    category: 'Tables',
    description: 'Extendable dining table — 120 cm to 180 cm.',
    width: 1.2,
    depth: 0.8,
    height: 0.75,
    build: { kind: 'table', shape: 'rect', legs: 'corner', apron: true },
    colorways: [OAK, BLACK_BROWN, WHITE],
    // The real product genuinely extends, so this one is resizable.
    resizable: { width: [1.2, 1.8] },
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'lerhamn-table',
    name: 'LERHAMN',
    series: 'LERHAMN',
    category: 'Tables',
    description: 'Small square dining table for two to four.',
    width: 0.74,
    depth: 0.74,
    height: 0.75,
    build: { kind: 'table', shape: 'rect', legs: 'corner', apron: true },
    colorways: [PINE, WHITE, BLACK_BROWN],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'skogsta-table',
    name: 'SKOGSTA',
    series: 'SKOGSTA',
    category: 'Tables',
    description: 'Long solid acacia dining table seating eight.',
    width: 2.35,
    depth: 1.0,
    height: 0.74,
    build: { kind: 'table', shape: 'rect', legs: 'trestle', apron: true },
    colorways: [OAK, BLACK_BROWN],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'docksta-table',
    name: 'DOCKSTA',
    series: 'DOCKSTA',
    category: 'Tables',
    description: 'Round tulip-style dining table on a pedestal base.',
    width: 1.05,
    depth: 1.05,
    height: 0.75,
    build: { kind: 'table', shape: 'round', legs: 'trestle', apron: false },
    colorways: [WHITE, BLACK_BROWN],
    layer: 'furniture',
    placement: 'free',
  },

  /* ------------------------------- Storage ---------------------------- */
  {
    ...UNLINKED,
    id: 'billy-80',
    name: 'BILLY',
    series: 'BILLY',
    category: 'Storage',
    description: 'The bookcase. 80 cm wide, adjustable shelves.',
    width: 0.8,
    depth: 0.28,
    height: 2.02,
    build: { kind: 'shelving', columns: 1, rows: 6, back: true },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'billy-40',
    name: 'BILLY narrow',
    series: 'BILLY',
    category: 'Storage',
    description: 'Narrow 40 cm BILLY for filling an awkward gap.',
    width: 0.4,
    depth: 0.28,
    height: 2.02,
    build: { kind: 'shelving', columns: 1, rows: 6, back: true },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'kallax-4x4',
    name: 'KALLAX 4x4',
    series: 'KALLAX',
    category: 'Storage',
    description: 'Sixteen-cube shelving unit; works as a room divider.',
    width: 1.47,
    depth: 0.39,
    height: 1.47,
    build: { kind: 'shelving', columns: 4, rows: 4, back: false },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'kallax-2x4',
    name: 'KALLAX 2x4',
    series: 'KALLAX',
    category: 'Storage',
    description: 'Tall eight-cube shelving unit.',
    width: 0.77,
    depth: 0.39,
    height: 1.47,
    build: { kind: 'shelving', columns: 2, rows: 4, back: false },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'kallax-2x2',
    name: 'KALLAX 2x2',
    series: 'KALLAX',
    category: 'Storage',
    description: 'Low four-cube unit that doubles as a bench.',
    width: 0.77,
    depth: 0.39,
    height: 0.77,
    build: { kind: 'shelving', columns: 2, rows: 2, back: false },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'hemnes-bookcase',
    name: 'HEMNES bookcase',
    series: 'HEMNES',
    category: 'Storage',
    description: 'Solid pine bookcase with a traditional profile.',
    width: 0.9,
    depth: 0.37,
    height: 1.97,
    build: { kind: 'shelving', columns: 1, rows: 5, back: true },
    colorways: [WHITE, BLACK_BROWN, PINE],
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'malm-chest-6',
    name: 'MALM 6-drawer',
    series: 'MALM',
    category: 'Storage',
    description: 'Tall chest of six drawers with a clean handleless front.',
    width: 0.8,
    depth: 0.48,
    height: 1.23,
    build: { kind: 'cabinet', doors: 0, drawers: 6, plinth: false },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'hemnes-chest-8',
    name: 'HEMNES 8-drawer',
    series: 'HEMNES',
    category: 'Storage',
    description: 'Wide eight-drawer chest in solid pine.',
    width: 1.6,
    depth: 0.5,
    height: 0.96,
    build: { kind: 'cabinet', doors: 0, drawers: 8, plinth: true },
    colorways: [WHITE, BLACK_BROWN, PINE],
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'besta-tv',
    name: 'BESTÅ TV unit',
    series: 'BESTÅ',
    category: 'Storage',
    description: 'Low media unit with push-open doors.',
    width: 1.8,
    depth: 0.42,
    height: 0.74,
    build: { kind: 'cabinet', doors: 4, drawers: 0, plinth: true },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'pax-150',
    name: 'PAX 150',
    series: 'PAX',
    category: 'Storage',
    description: 'Full-height double wardrobe, 150 cm wide.',
    width: 1.5,
    depth: 0.58,
    height: 2.36,
    build: { kind: 'cabinet', doors: 2, drawers: 0, plinth: false },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'pax-100',
    name: 'PAX 100',
    series: 'PAX',
    category: 'Storage',
    description: 'Single-bay wardrobe, 100 cm wide.',
    width: 1.0,
    depth: 0.58,
    height: 2.01,
    build: { kind: 'cabinet', doors: 2, drawers: 0, plinth: false },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'ivar-shelf',
    name: 'IVAR',
    series: 'IVAR',
    category: 'Storage',
    description: 'Untreated pine shelving unit.',
    width: 0.89,
    depth: 0.3,
    height: 1.79,
    build: { kind: 'shelving', columns: 1, rows: 5, back: false },
    colorways: [PINE, WHITE],
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'raskog-trolley',
    name: 'RÅSKOG',
    series: 'RÅSKOG',
    category: 'Storage',
    description: 'Three-tier steel trolley on castors.',
    width: 0.35,
    depth: 0.45,
    height: 0.78,
    build: { kind: 'trolley', tiers: 3 },
    colorways: [CHARCOAL, WHITE, SAGE],
    layer: 'furniture',
    placement: 'free',
  },

  /* -------------------------------- Beds ------------------------------ */
  {
    ...UNLINKED,
    id: 'malm-bed-160',
    name: 'MALM 160',
    series: 'MALM',
    category: 'Beds',
    description: 'King bed frame with a tall flat headboard.',
    width: 1.76,
    depth: 2.09,
    height: 1.0,
    build: { kind: 'bed', headboard: 1.0, storage: false },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'malm-bed-140',
    name: 'MALM 140',
    series: 'MALM',
    category: 'Beds',
    description: 'Double bed frame with a tall flat headboard.',
    width: 1.56,
    depth: 2.09,
    height: 1.0,
    build: { kind: 'bed', headboard: 1.0, storage: false },
    colorways: WOODS_WHITE_FIRST,
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'brimnes-bed-140',
    name: 'BRIMNES 140',
    series: 'BRIMNES',
    category: 'Beds',
    description: 'Double bed with four storage drawers in the base.',
    width: 1.66,
    depth: 2.06,
    height: 0.47,
    build: { kind: 'bed', headboard: 0.47, storage: true },
    colorways: [WHITE, BLACK_BROWN],
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'slattum-140',
    name: 'SLATTUM 140',
    series: 'SLATTUM',
    category: 'Beds',
    description: 'Upholstered double bed with a padded headboard.',
    width: 1.56,
    depth: 2.06,
    height: 0.9,
    build: { kind: 'bed', headboard: 0.9, storage: false },
    colorways: UPHOLSTERY,
    layer: 'furniture',
    placement: 'wall',
  },

  /* ------------------------------ Workspace --------------------------- */
  {
    ...UNLINKED,
    id: 'bekant-desk',
    name: 'BEKANT',
    series: 'BEKANT',
    category: 'Workspace',
    description: 'Wide office desk on a steel underframe.',
    width: 1.6,
    depth: 0.8,
    height: 0.73,
    build: { kind: 'desk', drawers: 0 },
    colorways: [OAK, WHITE, CHARCOAL],
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'micke-desk',
    name: 'MICKE',
    series: 'MICKE',
    category: 'Workspace',
    description: 'Compact desk with an integrated drawer unit.',
    width: 1.05,
    depth: 0.5,
    height: 0.75,
    build: { kind: 'desk', drawers: 2 },
    colorways: [WHITE, BLACK_BROWN, OAK],
    layer: 'furniture',
    placement: 'wall',
  },
  {
    ...UNLINKED,
    id: 'alex-drawers',
    name: 'ALEX',
    series: 'ALEX',
    category: 'Workspace',
    description: 'Under-desk drawer unit on castors.',
    width: 0.36,
    depth: 0.58,
    height: 0.7,
    build: { kind: 'cabinet', doors: 0, drawers: 5, plinth: false },
    colorways: [WHITE, BLACK_BROWN, OAK],
    layer: 'furniture',
    placement: 'free',
  },

  /* -------------------------------- Rugs ------------------------------ */
  {
    ...UNLINKED,
    id: 'stoense-rug',
    name: 'STOENSE',
    series: 'STOENSE',
    category: 'Rugs',
    description: 'Dense short-pile rug, 200 x 300 cm.',
    width: 2.0,
    depth: 3.0,
    height: 0.018,
    build: { kind: 'rug', shape: 'rect' },
    colorways: [LINEN, CHARCOAL, SAGE],
    layer: 'floor',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'morum-rug',
    name: 'MORUM',
    series: 'MORUM',
    category: 'Rugs',
    description: 'Flatwoven indoor-outdoor rug, 160 x 230 cm.',
    width: 1.6,
    depth: 2.3,
    height: 0.008,
    build: { kind: 'rug', shape: 'rect' },
    colorways: [LINEN, CHARCOAL],
    layer: 'floor',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'stockholm-rug',
    name: 'STOCKHOLM',
    series: 'STOCKHOLM',
    category: 'Rugs',
    description: 'Large hand-woven wool rug, 250 x 350 cm.',
    width: 2.5,
    depth: 3.5,
    height: 0.014,
    build: { kind: 'rug', shape: 'rect' },
    colorways: [LINEN, NAVY, RUST],
    layer: 'floor',
    placement: 'free',
  },

  /* ------------------------------ Lighting ---------------------------- */
  {
    ...UNLINKED,
    id: 'hektar-floor',
    name: 'HEKTAR',
    series: 'HEKTAR',
    category: 'Lighting',
    description: 'Oversized dome floor lamp.',
    width: 0.47,
    depth: 0.47,
    height: 1.81,
    build: { kind: 'lamp', style: 'floor' },
    colorways: [CHARCOAL, WHITE],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'not-floor',
    name: 'NOT',
    series: 'NOT',
    category: 'Lighting',
    description: 'Slim uplighter for a corner.',
    width: 0.24,
    depth: 0.24,
    height: 1.75,
    build: { kind: 'lamp', style: 'floor' },
    colorways: [CHARCOAL, WHITE],
    layer: 'furniture',
    placement: 'free',
  },
  {
    ...UNLINKED,
    id: 'ranarp-table',
    name: 'RANARP',
    series: 'RANARP',
    category: 'Lighting',
    description: 'Work lamp with a jointed arm.',
    width: 0.19,
    depth: 0.34,
    height: 0.42,
    build: { kind: 'lamp', style: 'table' },
    colorways: [CHARCOAL, WHITE],
    layer: 'furniture',
    placement: 'free',
  },
];

/** Catalogue order for the panel's category tabs. */
export const CATALOG_CATEGORIES: readonly CatalogCategory[] = [
  'Seating',
  'Tables',
  'Storage',
  'Beds',
  'Workspace',
  'Rugs',
  'Lighting',
];

const BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

/** Looks an entry up, falling back to the first so a stale ID cannot crash. */
export function getCatalogEntry(id: string): CatalogEntry {
  return BY_ID.get(id) ?? CATALOG[0]!;
}

/** True when the ID names a real catalogue entry. */
export function isKnownCatalogId(id: string): boolean {
  return BY_ID.has(id);
}

export function catalogByCategory(category: CatalogCategory): CatalogEntry[] {
  return CATALOG.filter((entry) => entry.category === category);
}

/** The colourway for an item, falling back to the entry's first. */
export function resolveColorway(entry: CatalogEntry, colorwayId?: string): Colorway {
  if (!colorwayId) return entry.colorways[0]!;
  return entry.colorways.find((option) => option.id === colorwayId) ?? entry.colorways[0]!;
}

/**
 * The attribution line shown in the UI.
 *
 * Displaying this is the ordinary courtesy — and the ordinary legal precaution —
 * when referring to another company's products by name.
 */
export const CATALOG_ATTRIBUTION =
  'Product names are trademarks of Inter IKEA Systems B.V. havavamama is not ' +
  'affiliated with or endorsed by IKEA. Dimensions are nominal and should be ' +
  'checked against the current listing before you buy.';
