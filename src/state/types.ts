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
 * v4 — clearance settings and per-item price overrides.
 * v5 — a BUILDING of levels rather than a single plan, plus stairs, floor
 *      voids, and the reserved shape for roofs, the site and the service
 *      networks (electrical, water, drainage, heating).
 */
export const SCHEMA_VERSION = 5;

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
   * A confirmed price for this specific piece, overriding the catalogue's
   * estimate.
   *
   * The catalogue ships rough estimates so totals work out of the box, but they
   * are guesses: IKEA prices differ by country and change constantly. A number
   * here is one somebody actually looked up, and is treated as fact rather than
   * as an estimate everywhere it is displayed or exported.
   */
  price?: number;

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

/* ─────────────────────────────── The building ────────────────────────────── */

/**
 * One storey.
 *
 * A level owns everything that is *on* that floor: its walls, its rooms, its
 * furniture, and any holes cut through its slab. It does NOT own its own
 * height above the ground — see `elevationOf` in `state/levels.ts`, which sums
 * the levels below it. Storing an absolute elevation as well would be a second
 * source of truth for the same fact, and the two would drift the first time
 * somebody changed a ceiling height on the ground floor.
 */
export interface Level {
  id: string;
  /** "First Floor", "Basement". Shown on the level strip. */
  name: string;
  /**
   * Floor-to-ceiling height for walls drawn on this level, in metres.
   *
   * Distinct from `plan.defaultWallHeight`, which is the height a NEW wall gets
   * and which the user may vary wall by wall. This is the storey height the
   * level above sits on top of.
   */
  wallHeight: number;
  /** Thickness of the floor structure at this level's base, in metres. */
  slabThickness: number;
  plan: PlanModel;
  furniture: FurnitureItem[];
  /**
   * Holes cut through this level's floor that the user made deliberately —
   * a double-height space, a light well.
   *
   * Stairwell openings are NOT stored here. They are derived from the stairs
   * that arrive at this level (see `floorHoles`), because a stair and the hole
   * it comes up through are the same fact stated twice, and storing both is how
   * you end up with a staircase that arrives at a solid ceiling.
   */
  voids: FloorVoid[];
}

/** A hole cut through a level's floor. */
export interface FloorVoid {
  id: string;
  /** Outline on the floor plane, in world XZ. */
  polygon: Point2[];
  /** Shown in the inspector, e.g. "Stairwell", "Light well". */
  name: string;
}

/* --------------------------------- Stairs -------------------------------- */

/** Which way a stair turns as it rises, seen from the bottom looking up. */
export type StairTurn = 'left' | 'right';

/**
 * The shape a stair makes in plan.
 *
 * A discriminated union rather than a pile of optional fields, so that a
 * straight flight carries no landing data and a spiral carries no turn
 * direction it does not use. Every variant is measured in RISERS rather than in
 * metres: a flight is a whole number of equal steps, and expressing it any
 * other way lets a design exist that cannot be built.
 */
export type StairForm =
  /** One flight, bottom to top. */
  | { kind: 'straight' }
  /** Two flights at 90°, with a landing between them. */
  | { kind: 'l-shaped'; turn: StairTurn; risersBeforeLanding: number }
  /** Two flights at 180°, with a half-landing between them. */
  | { kind: 'u-shaped'; turn: StairTurn; risersBeforeLanding: number }
  /**
   * A turn made of tapered treads instead of a landing.
   *
   * Cheaper in floor area than a landing and correspondingly fussier under the
   * code, because tread depth has to be measured at the walkline rather than at
   * the middle of the step (IRC R311.7.5.2.1).
   */
  | {
      kind: 'winder';
      turn: StairTurn;
      risersBeforeWinder: number;
      winderTreads: number;
      /**
       * Radius of the newel post the winders turn around.
       *
       * Not decoration — it is what makes a winder legal. Tread depth is
       * measured along an arc 12 in out from the narrow edge, so the arc length
       * per tread is (newel radius + 12 in) x the angle. Converge the treads to
       * a point and three winders across a 90 degree turn give 6 1/4 in at the
       * walkline against the 10 in the code asks for. The post is how the
       * geometry is rescued, and the app has to model it to tell you whether
       * yours is big enough.
       */
      innerRadius: number;
    }
  /** A helix around a central pole. Its own code section entirely. */
  | { kind: 'spiral'; clockwise: boolean; innerRadius: number };

export type StairKind = StairForm['kind'];

/**
 * A staircase, rising from one level to the one above it.
 *
 * Stored on the building rather than on a level because a stair belongs to
 * neither storey and to both: it stands on the lower one's floor and cuts a
 * hole in the upper one's.
 *
 * Note what is NOT stored: the riser height. It is the level rise divided by
 * the riser count, and it must be, because a stair whose steps do not add up to
 * exactly the floor-to-floor height is a stair with a trip hazard at one end.
 * Deriving it means changing a ceiling height re-proportions the stairs
 * automatically instead of silently invalidating them.
 */
export interface Stair {
  id: string;
  name: string;
  /** The level this stair stands on. It arrives at the one above. */
  fromLevelId: string;
  form: StairForm;
  /**
   * Centre of the bottom riser's leading edge, in world XZ.
   *
   * The bottom of the stair rather than its centroid: it is the end you arrive
   * at, the end that has to line up with a doorway, and the end that stays put
   * when you add a step.
   */
  at: Point2;
  /** Direction of travel at the bottom. Same convention as furniture. */
  rotation: number;
  /** Clear width, in metres. */
  width: number;
  /** Going: the horizontal depth of one tread, in metres. */
  treadDepth: number;
  /** How many risers from the lower floor to the upper one. */
  riserCount: number;
  /** Nosing projection beyond the riser below, in metres. */
  nosing: number;
  /** Whether a handrail is modelled. Required by code above 3 risers. */
  handrail: 'none' | 'left' | 'right' | 'both';
}

/* ------------------------- Reserved for later sessions -------------------- */

/**
 * The plot the building stands on.
 *
 * Mostly empty until session 7, but `northAngle` earns its place now: it is
 * needed by every plan drawing, and it is the input to any daylight study. The
 * sewer connection matters to session 10, because a drain's fall is measured
 * from the fixture down to a real invert elevation at the boundary — without
 * one, drainage design has no datum to work to.
 */
export interface Site {
  /**
   * Compass bearing of world +Z, in radians clockwise from north.
   *
   * Zero means "+Z is north", which is the assumption every drawing made
   * before this field existed was implicitly making.
   */
  northAngle: number;
  /** Plot outline, in world XZ. Empty until the user draws one. */
  boundary: Point2[];
  /** Where the building's drainage meets the public sewer. Session 10. */
  sewerConnection: { at: Point2; invertDepth: number } | null;
}

/** Which service a routed network carries. Extended as each session lands. */
export type ServiceSystem =
  | 'cold-water'
  | 'hot-water'
  | 'waste'
  | 'soil'
  | 'vent'
  | 'circuit'
  | 'gas'
  | 'supply-air'
  | 'return-air';

/**
 * A point on a service network: a fixture, a fitting, an outlet, a junction.
 *
 * Deliberately thin. Each discipline adds its own detail in its own session —
 * a receptacle needs a mounting height and a circuit, a drain needs an invert
 * elevation and a fixture-unit loading — and `detail` is where that goes. What
 * is fixed here is the part every discipline shares: where it is, which storey
 * it is on, and what it connects to.
 */
export interface ServiceNode {
  id: string;
  levelId: string;
  at: Point2;
  /** Height above that level's finished floor, in metres. */
  height: number;
  kind: string;
  detail: Record<string, unknown>;
}

/** A length of pipe, duct or cable between two nodes. */
export interface ServiceRun {
  id: string;
  from: string;
  to: string;
  /** Intermediate points, so a run can go round a corner or up a wall. */
  waypoints: Array<{ at: Point2; height: number; levelId: string }>;
  /** Nominal size in metres — pipe bore, conduit diameter, cable CSA. */
  size: number;
  detail: Record<string, unknown>;
}

/**
 * One discipline's worth of routed network.
 *
 * Every service in a building is the same geometric object: nodes joined by
 * runs, threaded through walls and floors. Electrical, water, drainage and
 * ventilation differ in their rules, their sizes and their symbols — not in
 * their shape. Modelling that once means each later session adds a rule set and
 * a renderer rather than a new spatial model.
 */
export interface ServiceNetwork {
  id: string;
  system: ServiceSystem;
  name: string;
  nodes: ServiceNode[];
  runs: ServiceRun[];
}

/**
 * A roof over the building. Session 7.
 *
 * Reserved rather than designed: hips, valleys, dormers and overhangs are a
 * geometry problem in their own right and guessing at their shape now would be
 * inventing a schema nobody has tested against real roofs.
 */
export interface Roof {
  id: string;
  /** The level this roof sits on top of. */
  overLevelId: string;
  kind: 'flat' | 'gable' | 'hip' | 'shed';
  /** Rise over run, e.g. 0.5 for a 6:12 pitch. */
  pitch: number;
  /** How far the eaves project beyond the wall, in metres. */
  overhang: number;
}

/** The complete, serialisable state of one design. */
export interface DesignDocument {
  schemaVersion: number;
  /** Free-text name shown in the header and used for the export filename. */
  name: string;
  /** ISO timestamp of the last modification. */
  updatedAt: string;

  /**
   * The storeys, ordered from the bottom up.
   *
   * Always at least one. Index 0 is the lowest — a basement if there is one,
   * otherwise the ground floor — and its finished floor is the site datum.
   */
  levels: Level[];
  /** Which level the editor is working on. */
  activeLevelId: string;

  stairs: Stair[];
  roofs: Roof[];
  site: Site;
  /** Empty until session 9. See `ServiceNetwork`. */
  services: ServiceNetwork[];

  lighting: LightingSpec;
  clearance: ClearanceSettings;

  /**
   * Currency symbol for the shopping list.
   *
   * A label only — no conversion happens, because there is no exchange-rate
   * source here and silently converting a guessed price would compound one
   * inaccuracy with another. The catalogue's estimates are nominal euro figures;
   * changing this relabels them and the UI says so.
   */
  currency: string;

  /** Ceilings hidden by default so the orbit camera can look into the plan. */
  showCeilings: boolean;

  /** Display preference. Does not affect stored values. */
  units: UnitSystem;
}

/* ────────────────────────────── Clearance ────────────────────────────── */

/**
 * How strictly clearance guidance is applied.
 *
 * Clearance is not collision. A collision is physically impossible; a 70 cm
 * walkway is merely tight, and a designer working a small flat may accept one
 * deliberately. So the default is advisory — problems are shown and counted,
 * and the user decides. Strict mode turns the same rules into hard constraints
 * for anyone who would rather the app refuse.
 */
export interface ClearanceSettings {
  /** When true, placement is refused where it would violate a clearance rule. */
  strict: boolean;
  /** Minimum width of a main circulation route, in metres. */
  walkwayWidth: number;
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

/**
 * Circulation and clearance defaults, in metres.
 *
 * These are widely-published interior design guidelines rather than building
 * code, which varies by jurisdiction. They are exposed as named constants so
 * the numbers a user is being judged against are inspectable rather than
 * buried in a comparison somewhere.
 */
export const CLEARANCE_DEFAULTS = {
  /** Main route through a room. 900 mm is the usual recommendation. */
  walkway: 0.9,
  /** A secondary squeeze-past route; below this a gap is a pinch point. */
  walkwayTight: 0.75,
  /** Grid resolution used by the circulation analysis. */
  gridCell: 0.1,
} as const;

/**
 * Limits for storeys and stairs. All metres unless stated.
 *
 * These are app limits — what the UI will let you type — not code limits.
 * The code limits live in `src/code/irc.ts` and are checked, cited and
 * reported rather than enforced, for the same reason clearance is advisory:
 * the app's job is to tell you what you are doing, not to refuse to draw it.
 */
export const LEVEL_LIMITS = {
  wallHeight: { min: 2.0, max: 6, step: 0.05 },
  /** Floor structure between storeys. 250 mm is a typical joisted floor. */
  slabThickness: { min: 0.1, max: 0.6, step: 0.01 },
  maxLevels: 6,
} as const;

export const STAIR_LIMITS = {
  width: { min: 0.6, max: 2.4, step: 0.01 },
  treadDepth: { min: 0.15, max: 0.45, step: 0.005 },
  riserCount: { min: 2, max: 30 },
  nosing: { min: 0, max: 0.04, step: 0.002 },
  /** Radius of the pole a spiral stair winds around. */
  spiralInnerRadius: { min: 0.05, max: 0.6, step: 0.01 },
  /** IRC R311.7.5.2.1 permits winder treads; more than three is unusual. */
  winderTreads: { min: 2, max: 4 },
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
