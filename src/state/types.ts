/**
 * The havavamama design document.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONVENTIONS THAT THE WHOLE APP DEPENDS ON — do not break these casually:
 *
 *  1. ALL lengths stored here are in METRES. Always. Feet/inches and centimetres
 *     exist only as a display format in the UI layer (see `state/units.ts`).
 *     IKEA and every other furniture catalogue publishes metric data, so metres
 *     is the format that needs no conversion at the point it matters most.
 *
 *  2. The world is Y-UP. The floor sits at y = 0. Walls are described purely in
 *     plan: a wall is a line between two vertices on the y = 0 plane, extruded
 *     upwards. Nothing is "centred on the origin" any more — since session 2 the
 *     plan can be any shape, so the origin is simply a point the plan sits near.
 *
 *  3. This object must stay JSON-serialisable — no class instances, no Three.js
 *     objects, no functions. It is the thing we autosave, export, hand to the AI
 *     advisor and will eventually sync to a server. Anything that cannot survive
 *     `JSON.parse(JSON.stringify(doc))` does not belong in here.
 *
 *  4. IDs ARE STABLE AND OPAQUE. Never address a wall or vertex by array index.
 *     Inserting a corner must not shuffle the colours the user already chose, and
 *     index-based addressing is exactly how that regression happens.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Bumped whenever the shape below changes incompatibly.
 *
 * v1 — a single rectangular room described by width/depth/height.
 * v2 — an arbitrary wall graph supporting multi-room plans and openings.
 *      `state/migrate.ts` upgrades v1 documents by tracing a rectangle.
 * v3 — furniture placed in the plan.
 */
export const SCHEMA_VERSION = 3;

/** Which measurement system the UI displays. Storage is always metric. */
export type UnitSystem = 'metric' | 'imperial';

/** A point on the floor plane. */
export interface Point2 {
  x: number;
  z: number;
}

/* ──────────────────────────── The wall graph ─────────────────────────── */

/**
 * A corner in the plan.
 *
 * Vertices are shared between walls: dragging one corner moves every wall that
 * meets there, which is what makes a floor plan behave like a floor plan rather
 * than like four independent sticks.
 */
export interface Vertex extends Point2 {
  id: string;
}

/** How one side of a wall is painted. */
export interface WallFaceSpec {
  /** Hex colour string, e.g. "#e8e4dc". */
  color: string;
  /**
   * Surface finish, 0 = mirror-smooth, 1 = completely matte.
   * Real interior paint sits around 0.85 (matte) to 0.55 (eggshell/satin).
   */
  roughness: number;
}

export type OpeningKind = 'door' | 'window';

/** Which side of a wall a door opens towards. See `Wall.faces` for a/b. */
export type WallSide = 'a' | 'b';

/**
 * A door or window cut through a wall.
 *
 * Positioned along the wall rather than in world space, so an opening stays put
 * (relative to its wall) when the wall is moved or its vertices are dragged.
 */
export interface Opening {
  id: string;
  kind: OpeningKind;
  /** ID of an entry in `scene/openings/presets.ts`. */
  presetId: string;
  /** Distance from the wall's start vertex to the opening's centre, in metres. */
  offset: number;
  width: number;
  height: number;
  /** Height of the opening's bottom edge above the floor. Zero for doors. */
  sillHeight: number;
  /** Which end of the wall the door is hinged on. Ignored for windows. */
  hinge: 'start' | 'end';
  /** Which side of the wall the door swings towards. Ignored for windows. */
  swing: WallSide;
}

/**
 * A wall: a line between two vertices, extruded to `height`.
 *
 * A wall has two faces. Face "a" is the side the wall's left-hand normal points
 * towards (see `wallBasis` in `scene/planGraph.ts`); face "b" is the other. In a
 * multi-room plan those two faces can belong to two different rooms, which is
 * why each is painted independently.
 */
export interface Wall {
  id: string;
  /** Vertex ID this wall runs from. */
  start: string;
  /** Vertex ID this wall runs to. */
  end: string;
  thickness: number;
  height: number;
  /**
   * Per-face paint overrides.
   *
   * Usually absent: a face with no override inherits the wall colour of the room
   * it looks into, which is how people actually think ("paint the bedroom sage")
   * and avoids having to click every wall of a room individually. An override is
   * what creates an accent wall.
   */
  faces: { a?: WallFaceSpec; b?: WallFaceSpec };
  openings: Opening[];
}

/* ──────────────────────────── Room appearance ────────────────────────── */

/** The floor's surface: a procedural material preset tinted by a colour. */
export interface FloorSpec {
  /** ID of an entry in `scene/materials/presets.ts` — e.g. "oak-plank". */
  presetId: string;
  /** Tint multiplied over the preset's generated texture. White = untinted. */
  color: string;
  /** How large the pattern is, in metres, before it repeats. */
  textureScale: number;
}

/**
 * Everything about one enclosed room.
 *
 * Rooms are DERIVED from the wall graph, not stored as geometry — the set of
 * enclosed regions is recomputed whenever walls change (see `findRegions`).
 * This record only holds the appearance the user chose, keyed by a region key
 * that stays stable as long as the same walls enclose the space.
 */
export interface RoomSpec {
  /** User-facing name, e.g. "Living Room". */
  name: string;
  floor: FloorSpec;
  /** Default paint for every wall face looking into this room. */
  wall: WallFaceSpec;
  /** Ceiling colour for this room. */
  ceilingColor: string;
}

/** The complete plan: its graph, and the appearance of the rooms it encloses. */
export interface PlanModel {
  vertices: Vertex[];
  walls: Wall[];
  /**
   * Room appearance keyed by region key (see `regionKey` in `scene/planGraph.ts`).
   * Regions with no entry fall back to `defaultRoom`.
   */
  rooms: Record<string, RoomSpec>;
  /** Appearance applied to any newly enclosed region. */
  defaultRoom: RoomSpec;
  /** Height and thickness given to walls the user draws next. */
  defaultWallHeight: number;
  defaultWallThickness: number;
}

/* ───────────────────────────────── Lighting ──────────────────────────── */

export type LightingPresetId = 'daylight' | 'overcast' | 'evening' | 'studio';

export interface LightingSpec {
  presetId: LightingPresetId;
  /** Global multiplier on top of the preset, 0.2–2.0. */
  intensity: number;
  /** Soft shadows look far better but cost frames on weak GPUs. */
  shadowsEnabled: boolean;
}

/* ───────────────────────────── The document ──────────────────────────── */

/* ─────────────────────────────── Furniture ──────────────────────────── */

/**
 * One piece of furniture placed in the plan.
 *
 * Deliberately thin: everything about what the piece IS lives in the catalogue
 * (`furniture/catalog.ts`), and this record only says which catalogue entry it
 * is and where it stands. That keeps documents small, lets the catalogue grow
 * or have its geometry improved without touching saved designs, and means a
 * design file names products rather than embedding copies of them.
 */
export interface FurnitureItem {
  id: string;
  /** ID of an entry in the furniture catalogue. */
  catalogId: string;
  /** Centre of the piece's footprint on the floor plane, in metres. */
  x: number;
  z: number;
  /** Height of the piece's base above the floor. Zero for anything free-standing. */
  y: number;
  /** Rotation about the Y axis, in radians. Zero faces +Z. */
  rotation: number;
  /** Overrides the catalogue colourway. */
  colorwayId?: string;
  /**
   * Overrides the catalogue dimensions, in metres.
   *
   * Only meaningful for entries the catalogue marks resizable — an extendable
   * dining table genuinely comes in several lengths, whereas a specific
   * bookcase does not, and letting the user stretch one would make the
   * dimensions on screen a lie.
   */
  size?: { width: number; depth: number; height: number };
}

/** The complete, serialisable state of one design. */
export interface DesignDocument {
  schemaVersion: number;
  /** Free-text name shown in the header and used for the export filename. */
  name: string;
  /** ISO timestamp of the last modification. */
  updatedAt: string;

  plan: PlanModel;
  furniture: FurnitureItem[];
  lighting: LightingSpec;

  /** Ceilings hidden by default so the orbit camera can look into the plan. */
  showCeilings: boolean;

  /** Display preference. Does not affect stored values. */
  units: UnitSystem;

  /*
   * FUTURE SESSIONS ADD THEIR STATE HERE, for example:
   *   advisorNotes: AdvisorNote[];      // session 5
   * Adding an optional field is backward-compatible and needs no schema bump.
   */
}

/* ────────────────────────────── Constraints ──────────────────────────── */

/** Limits enforced by the UI and by the sanitiser. All metres. */
export const PLAN_LIMITS = {
  wallHeight: { min: 2.0, max: 6, step: 0.05 },
  wallThickness: { min: 0.05, max: 0.6, step: 0.01 },
  /** Walls shorter than this are treated as degenerate and removed. */
  minWallLength: 0.15,
  /** How far apart two vertices must be before they are considered distinct. */
  vertexMergeDistance: 0.02,
  /** Extent of the editable plan area from the origin, in metres. */
  planExtent: 40,
} as const;

/** Limits and tolerances for furniture placement. All metres. */
export const FURNITURE_LIMITS = {
  /**
   * Gap left between a piece and whatever it collides with.
   *
   * Not zero: with an exact touch, floating-point noise makes a piece resting
   * against a wall flicker between colliding and not, and two surfaces at
   * precisely the same depth z-fight. Two millimetres is invisible and stable.
   */
  contactGap: 0.002,
  /** How close a piece must be to a wall before it snaps flush against it. */
  wallSnapDistance: 0.35,
  /** Rotation increment applied by the keyboard shortcut, in degrees. */
  rotationStep: 15,
  /** Maximum passes the collision solver makes before giving up on a move. */
  solverIterations: 6,
} as const;

export const OPENING_LIMITS = {
  width: { min: 0.4, max: 4, step: 0.01 },
  height: { min: 0.3, max: 3.5, step: 0.01 },
  sillHeight: { min: 0, max: 2.5, step: 0.01 },
  /** Minimum wall left standing at either side of an opening. */
  edgeMargin: 0.06,
} as const;
