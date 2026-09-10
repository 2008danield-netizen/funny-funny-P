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
 * v6 — the outside of the building: roofs that follow the footprint, dormers,
 *      skylights, exterior cladding, and a site with real ground under it.
 * v7 — a traced plan under each storey: the image somebody actually has of
 *      their house, scaled, placed, and drawn over.
 * v8 — the electrical installation: outlets, switches, fittings, the circuits
 *      they sit on and the panel they come back to.
 * v9 — kitchens and bathrooms: cabinet runs, the units filling them, and the
 *      fixtures that carry what they connect to.
 * v10 — water and drainage: the supply trees, the soil stack, the waste
 *      branches, the vents, and where all of it meets the street.
 * v11 — heating and cooling: the envelope the load is computed from, the
 *      design location it is computed for, the equipment and the ductwork.
 */
export const SCHEMA_VERSION = 11;

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
  /** The floor plan image being traced on this storey, if there is one. */
  underlay: Underlay | null;
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

/* ───────────────────────────── Tracing a plan ─────────────────────────── */

/**
 * A floor plan image sitting under a storey, to draw over.
 *
 * Nobody draws their own house from memory. What they have is a PDF from an
 * estate agent, a scan from a council archive, or a photograph of a piece of
 * paper — and the job of this app is to get from that to a model, not to ask
 * them to measure every room with a tape.
 *
 * The IMAGE ITSELF IS NOT IN HERE. A scan is megabytes, the document is
 * autosaved to `localStorage` on every edit, and a document that cannot be
 * saved breaks the one promise this app makes. So the pixels live in the
 * browser's IndexedDB (see `state/imageStore.ts`) and this holds only the key —
 * which also keeps the document small enough to stay comfortable to read, diff
 * and hand to an AI. Exporting bundles the images back in, so a design file is
 * still one thing you can send somebody.
 */
export interface Underlay {
  /** Key into the image store. Empty when the image has gone missing. */
  imageId: string;
  /** Pixel size of the stored image, so placement needs no image load. */
  pixelWidth: number;
  pixelHeight: number;
  /** Where the centre of the image sits in the world, in metres. */
  at: Point2;
  /**
   * Metres per pixel.
   *
   * The single number that makes a picture into a measurement. Until it is
   * set from a known distance the plan is only approximately sized, and the
   * app says so rather than letting somebody trace a house 15 percent out.
   */
  metresPerPixel: number;
  /** Rotation about its centre, in radians. */
  rotation: number;
  /** 0-1. Faded back so the walls drawn over it stay readable. */
  opacity: number;
  /** Locked underlays cannot be dragged, which is what you want once it fits. */
  locked: boolean;
  /**
   * How the scale was set: two points on the image and the real distance
   * between them. Kept so the app can show its working and redo it.
   *
   * Null means nobody has calibrated yet, and the scale is a guess.
   */
  calibration: {
    /** Both in IMAGE PIXELS, so they survive the underlay being moved. */
    from: Point2;
    to: Point2;
    /** The real-world distance between them, in metres. */
    metres: number;
    /** What the user said it was, e.g. "the front wall". */
    label: string;
  } | null;
}

/* ────────────────────────────── The electrical ───────────────────────────── */

/**
 * What a device on the wall actually is.
 *
 * The list is the one an electrical plan uses, because the drawing has to be
 * readable by an electrician and the checks have to know what each thing is
 * for. A receptacle satisfies the six-foot rule; a switch does not. A GFCI
 * receptacle protects everything downstream of it; an ordinary one does not.
 */
export type DeviceKind =
  | 'receptacle'
  | 'receptacle-gfci'
  | 'receptacle-counter'
  | 'receptacle-appliance'
  | 'switch'
  | 'switch-3way'
  | 'switch-dimmer'
  | 'light-ceiling'
  | 'light-wall'
  | 'light-recessed'
  | 'fan'
  | 'smoke-alarm'
  | 'thermostat'
  | 'panel';

/**
 * One outlet, switch or fitting.
 *
 * `at` is where it sits in plan and `height` how far up the wall — both of
 * which the drawing needs and the checks measure against. `wallId` is the wall
 * it is mounted on where there is one, so that moving a wall takes its outlets
 * with it rather than leaving them standing in mid-air.
 */
export interface ElectricalDevice {
  id: string;
  levelId: string;
  kind: DeviceKind;
  at: Point2;
  /** Above this storey's finished floor, in metres. */
  height: number;
  /** Which way it faces — into the room, for a wall device. Radians. */
  rotation: number;
  /** The wall it is fixed to, or null for a ceiling fitting. */
  wallId: string | null;
  /** The circuit it is fed from, or null while it is unassigned. */
  circuitId: string | null;
  /**
   * Connected load in volt-amperes, for the things that have one.
   *
   * Null for a general-purpose receptacle: those are covered by the 3 VA per
   * square foot of NEC 220.12 and counting them individually would double-count
   * the same load. An appliance outlet or a fixed fitting names its own.
   */
  va: number | null;
  /** What it is, on the schedule: "Dishwasher", "Porch light". */
  label: string;
}

/** How a circuit is classified, which decides what may share it. */
export type CircuitKind =
  | 'general'
  | 'lighting'
  | 'small-appliance'
  | 'laundry'
  | 'bathroom'
  | 'individual';

/**
 * A branch circuit: a breaker, a cable, and everything on the end of it.
 *
 * NOTE that a circuit is a SET, not a route. What matters electrically is which
 * devices share a breaker, not the path the cable takes through the joists —
 * and the path is decided on site by whoever is drilling. So this models the
 * membership, and the drawing shows a home run rather than pretending to know
 * where the cable goes. (The routed-network shape reserved in v5 is still there
 * for the disciplines where the route IS the design: a drain has a fall, and a
 * duct has a length that costs you pressure.)
 */
export interface Circuit {
  id: string;
  /** "A1", "B7" — the number on the panel schedule. */
  reference: string;
  name: string;
  kind: CircuitKind;
  /** Breaker rating in amperes. */
  amps: number;
  volts: number;
  /** Conductor size, e.g. "12 AWG". Derived from the rating; stored for export. */
  conductor: string;
  gfci: boolean;
  afci: boolean;
}

/** Where the service lands and what it is rated at. */
export interface Panel {
  levelId: string;
  at: Point2;
  /**
   * Which way the enclosure faces, in radians.
   *
   * A panel is screwed to a wall, not stood in the middle of the room, so it
   * carries a rotation for the same reason every wall-mounted device does.
   */
  rotation: number;
  /** Main breaker rating in amperes. */
  mainAmps: number;
  volts: number;
  /** How many single-pole spaces the enclosure has. */
  spaces: number;
}

/* ------------------------------ Fittings ---------------------------------- */

/**
 * A run of cabinetry along one or more walls.
 *
 * -----------------------------------------------------------------------------
 * THE PATH IS THE RUN; THE UNITS ARE WHAT FILLS IT.
 *
 * A run is drawn as a polyline against the walls, and the units filling it are
 * WORKED OUT from its length and the module widths available — but they are
 * then STORED, which is a deliberate exception to the derived-not-stored rule
 * the rest of the app follows.
 *
 * The reason is that the units are not a consequence of the path alone: the
 * user swaps a door base for a drawer base, puts the sink in a different one,
 * and moves the oven housing along. Those are decisions, and a decision that
 * cannot survive its input changing is not a decision. Redrawing the path
 * re-fills the run and says so; nudging a wall does not.
 */
export interface CabinetRun {
  id: string;
  levelId: string;
  /**
   * The BACK of the run, in order, in world metres.
   *
   * The back rather than the centreline, because a run is set against a wall
   * and its back is the thing that has to be flat against it. Base and wall
   * units of different depths then grow forward from the same line, which is
   * how they are actually fitted.
   */
  path: Point2[];
  kind: CabinetKind;
  /** Left to right along the path, in order. */
  units: CabinetUnit[];
  /** Only base runs have one. */
  worktop: WorktopSpec | null;
  /** Door and drawer fronts. Carcasses are always white, as they are in life. */
  finishId: string;
}

export interface CabinetUnit {
  id: string;
  /** An entry in `fittings/modules.ts`, or a filler. */
  moduleId: string;
  /**
   * How much of the PATH this unit consumes, in metres.
   *
   * Normally the module's own width. Two cases where it is not:
   *   • A filler's width is whatever was left over.
   *   • A CORNER consumes its width on each of the two legs it joins — 1.76 m
   *     of path for an 880 corner — because the path turns inside it. The
   *     module width is still 880, and the geometry reads it from the module.
   *
   * Defining it as path length rather than as carcass width is what makes the
   * units of a run sum to its length, which is the invariant everything else
   * relies on.
   */
  width: number;
  /** Distance from the start of the path to this unit's left edge. */
  offset: number;
}

/** Base, wall or tall. Repeated here so `types.ts` stays self-contained. */
export type CabinetKind = 'base' | 'wall' | 'tall';

export type WorktopMaterial = 'laminate' | 'solid-wood' | 'quartz' | 'granite' | 'stainless';

export interface WorktopSpec {
  material: WorktopMaterial;
  colour: string;
  /** Whether a splashback runs up the wall behind it. */
  splashback: boolean;
}

/**
 * A sanitary fixture or an appliance.
 *
 * Flat on the storey rather than owned by a run, even for the ones that sit in
 * a cabinet — because every other discipline wants to ask "where is the sink"
 * without first knowing which run it is in, and because a fixture outlives the
 * run it happens to be sitting in when somebody redraws the kitchen.
 */
export interface Fixture {
  id: string;
  levelId: string;
  /** An entry in `fittings/fixtures.ts`. */
  fixtureId: string;
  /** Centre of the footprint, in world metres. */
  at: Point2;
  /** About Y, in radians. Zero faces +Z, like everything else here. */
  rotation: number;
  /** Base above the floor. Zero for anything standing on it. */
  y: number;
  /** The cabinet unit it is built into, if any. */
  hostUnitId: string | null;
  /** A price somebody actually looked up, overriding the estimate. */
  price?: number;
}

/** Bounds for the fitting editor. */
export const FITTING_LIMITS = {
  /** A run shorter than this cannot hold even a filler worth having. */
  minRunLength: 0.2,
  maxRunLength: 30,
  /** How far a run may sit off the wall behind it before it stops being a run. */
  maxWallGap: 0.35,
  worktopThickness: { min: 0.02, max: 0.1 },
} as const;

/**
 * The whole electrical installation.
 *
 * Kept as its own typed model rather than inside the generic service networks,
 * because almost every question worth asking about an electrical plan — is
 * every wall within six feet of an outlet, is this circuit overloaded, does
 * this bathroom have GFCI — is about devices and circuits, and none of them is
 * about geometry of a route.
 */
export interface ElectricalPlan {
  devices: ElectricalDevice[];
  circuits: Circuit[];
  panel: Panel | null;
  /**
   * Heating and cooling loads in volt-amperes, for NEC 220.82.
   *
   * The user's own numbers: the app cannot know what equipment is going in
   * until session 11 works the heating out, and the load calculation is wrong
   * without them. Zero means "not entered", and the calculation says so.
   */
  heatingVa: number;
  coolingVa: number;
}


/* ═══════════════════════════ Water and drainage ══════════════════════════ */

/**
 * The whole plumbing installation.
 *
 * Like the electrical, this is its own typed model rather than a generic
 * service network, for the same reason: almost every question worth asking —
 * is this branch big enough, does this trap have a vent within six feet, is
 * there enough pressure left at the top shower — is about loads and sizes, and
 * none of it is answerable from a list of line segments.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS STORED AND WHAT IS DERIVED.
 *
 * The ROUTE is stored: where the stack is, which fixture joins which branch,
 * where the pipe turns. That is a decision about somebody's house and it has to
 * survive a fixture moving 200 mm.
 *
 * The SIZES are derived, every time, from the fixtures on each run. A stored
 * diameter is a diameter that goes stale the moment a bath is added upstream of
 * it, and a stale drain size is exactly the defect this whole session exists to
 * prevent. So `PipeRun.size` is absent by design — ask `sizeDrainage()`.
 */
export interface PlumbingPlan {
  /** Every drain, waste and vent pipe. */
  drainage: PipeRun[];
  /** Every hot and cold supply pipe. */
  supply: PipeRun[];
  /** The soil stacks, usually one. */
  stacks: SoilStack[];
  /** Where each fixture's trap sits, and what it connects to. */
  connections: FixtureConnection[];
  /** The water heater, once there is one. */
  heater: WaterHeater | null;
  /**
   * Pressure at the main, in kPa.
   *
   * The user's own number — it comes off a gauge on their hose bib, or from the
   * water company — because nothing in a drawing can tell you what the street
   * pressure is, and the supply sizing is meaningless without it. The default
   * is a typical suburban 60 psi, and the checker says when the figure is the
   * default rather than something measured.
   */
  mainPressureKpa: number;
  /** Whether the user has actually measured that, or is taking the default. */
  mainPressureMeasured: boolean;
}

/** What a pipe is carrying. Decides its size rules, its colour and its symbol. */
export type PipeSystem = 'cold' | 'hot' | 'hot-return' | 'waste' | 'soil' | 'vent';

/**
 * A length of pipe between two points, possibly turning corners on the way.
 *
 * Deliberately a polyline rather than a pair of endpoints: real pipe goes along
 * a joist, turns, and drops, and drawing it as a straight line between fixture
 * and stack would produce a drawing that reads as buildable and is not.
 *
 * Every vertex carries its own storey and height, so a run can climb from a
 * ground-floor ceiling void into a first-floor wall without being split into
 * two objects that then have to be kept in step.
 */
export interface PipeRun {
  id: string;
  system: PipeSystem;
  /** In order, from the upstream end to the downstream end. */
  points: PipePoint[];
  /**
   * What this run drains or feeds, by fixture id.
   *
   * The sizing reads this rather than working out geometrically which fixtures
   * are upstream, because a fixture 50 mm from a pipe it does not connect to is
   * a normal thing in a real house and no proximity test can tell the two
   * apart.
   */
  serves: string[];
  /** The run it discharges into, or null when it reaches the stack or the main. */
  downstreamId: string | null;
  /** Set when the user has moved this run by hand, so a re-route leaves it be. */
  manual: boolean;
}

/** One vertex of a pipe run. */
export interface PipePoint {
  levelId: string;
  at: Point2;
  /**
   * Height above that level's finished floor, in metres.
   *
   * Negative for anything in the floor void below — which is where most waste
   * pipe actually lives — and that is the normal case rather than an error.
   */
  height: number;
}

/**
 * A soil stack: the vertical pipe everything drains into.
 *
 * One object rather than a run per storey, because a stack is one physical pipe
 * and its size is set by the total load on all of it. Splitting it per storey
 * would let the ground-floor length be sized for the ground floor's fixtures
 * alone, which is exactly the mistake.
 */
export interface SoilStack {
  id: string;
  /** Plan position, shared by every storey it passes through. */
  at: Point2;
  /** Bottom and top of the stack, as level ids. */
  fromLevelId: string;
  toLevelId: string;
  /**
   * How high the vent goes above the roof surface where it breaks through.
   *
   * IPC 904.1 wants 6 in; the default here is more, because a 6 in stub is the
   * legal minimum rather than a good idea and it frosts shut in a cold place.
   */
  ventAboveRoof: number;
  /** The wall the stack is boxed into, if it was routed against one. */
  wallId: string | null;
}

/**
 * Where one fixture meets the plumbing.
 *
 * A fixture in the catalogue says it needs hot, cold and a 40 mm trap. This
 * says where that actually happens in the building and what it joins onto, and
 * it is what turns a room full of sanitaryware into a system.
 */
export interface FixtureConnection {
  fixtureId: string;
  /** Where the trap sits, in plan and above the floor. */
  trapAt: Point2;
  trapHeight: number;
  /** Trap size in metres — from the catalogue, or the code's minimum. */
  trapSize: number;
  /** The waste or soil run this fixture discharges into. */
  drainRunId: string | null;
  /** The vent that protects its seal — a dry vent, or the wet vent it shares. */
  ventRunId: string | null;
  /** Supply runs feeding it. */
  coldRunId: string | null;
  hotRunId: string | null;
}

/** How the hot water is made. */
export type HeaterKind = 'storage' | 'instantaneous';

export interface WaterHeater {
  id: string;
  kind: HeaterKind;
  levelId: string;
  at: Point2;
  /** Storage volume in litres. Zero for an instantaneous heater. */
  litres: number;
  /** Whether a flow-and-return loop keeps the far taps hot. */
  recirculation: boolean;
}

/** Bounds for the plumbing editor, and the defaults a route starts from. */
export const PLUMBING_LIMITS = {
  /** Typical suburban street pressure, in kPa. 60 psi. */
  defaultMainPressureKpa: 414,
  minMainPressureKpa: 100,
  maxMainPressureKpa: 900,
  /** How deep the building drain leaves the building, below the ground floor. */
  defaultInvertDepth: 0.9,
  minInvertDepth: 0.3,
  maxInvertDepth: 4,
  /** How far above the roof a vent terminates, by default. */
  defaultVentAboveRoof: 0.3,
  /** Where waste pipe runs: this far below the finished floor it serves. */
  floorVoidDepth: 0.15,
  /** Where supply pipe runs, above the floor, when it is not in a wall. */
  supplyHeight: 0.35,
} as const;


/* ═══════════════════════════ Heating and cooling ═════════════════════════ */

/**
 * What the building is made of, thermally.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS ONE OBJECT AND NOT A PROPERTY OF EACH WALL.
 *
 * A real house is built one way. The walls are all the same construction, the
 * roof is one specification, the windows were bought together. Modelling the
 * envelope per surface would let somebody build a house with R-13 on the north
 * wall and R-30 on the south, which is not a thing anybody does and would make
 * the load calculation look far more precise than it is.
 *
 * The load is only ever as good as these figures, and they all start as
 * assumptions. Everything downstream says so.
 */
export interface EnvelopeSpec {
  /** An assembly id from `code/iecc.ts`. */
  wallAssemblyId: string;
  roofAssemblyId: string;
  floorAssemblyId: string;
  /** A glazing id, likewise. */
  glazingId: string;
  doorId: string;
  /** How leaky, as an id from the ACCA infiltration table. */
  infiltrationId: string;
  /**
   * Whether the user has actually confirmed any of this.
   *
   * False means every figure above is still the app's default. The checks say
   * so loudly, because a load computed from five assumptions is a different
   * kind of number from one computed from five measurements, and only one of
   * them should be used to buy equipment.
   */
  confirmed: boolean;
}

/** Which system the house is heated and cooled by. */
export type HvacSystemKind =
  /** Furnace and air conditioner sharing ducts. The American default. */
  | 'forced-air'
  /** Heat pump, ducted. Heats and cools with one machine. */
  | 'heat-pump'
  /** Ductless mini-splits, one head per zone. */
  | 'mini-split'
  /** Boiler with radiators or underfloor. No ducts at all. */
  | 'hydronic'
  /** Work out the load and stop there. */
  | 'load-only';

/**
 * The whole heating and cooling installation.
 *
 * Like the electrical and the plumbing, its own typed model rather than a
 * generic service network — the questions worth asking are about loads,
 * capacities and airflow, and none of them is answerable from a list of line
 * segments.
 */
export interface HvacPlan {
  /**
   * The design location, as "City, ST" from the ACCA table.
   *
   * Empty means nothing has been chosen and no load can be computed. There is
   * deliberately no default: a load calculated for the wrong climate is worse
   * than no load at all, because it looks like an answer.
   */
  locationKey: string;
  envelope: EnvelopeSpec;
  system: HvacSystemKind;

  /** The chosen equipment, by id from the ACCA catalogue. */
  heatingEquipmentId: string | null;
  coolingEquipmentId: string | null;

  /** Ductwork, when the system has any. */
  ducts: DuctRun[];
  registers: Register[];
  /** Where the air handler or furnace stands. */
  airHandler: { levelId: string; at: Point2 } | null;

  /** Radiators or underfloor loops, for a hydronic system. */
  emitters: Emitter[];

  /**
   * Whether the user has overridden the automatic equipment selection.
   *
   * Selection is otherwise derived from the load every time it is asked for,
   * so that adding a window re-sizes the furnace. Once somebody picks a
   * specific model that stops.
   */
  equipmentManual: boolean;
}

/** What a length of duct carries. */
export type DuctSystem = 'supply' | 'return';

/**
 * A length of ductwork.
 *
 * The same polyline shape as a pipe run, for the same reason: real ducts go
 * along a joist, turn, and drop. `size` is absent by design — a duct's
 * diameter is derived from the airflow through it, and a stored size goes
 * stale the moment a room is added downstream.
 */
export interface DuctRun {
  id: string;
  system: DuctSystem;
  points: PipePoint[];
  /** Which registers this run feeds, by id. */
  serves: string[];
  /** The run it branches from, or null at the air handler. */
  upstreamId: string | null;
  manual: boolean;
}

/** Where air enters or leaves a room. */
export interface Register {
  id: string;
  levelId: string;
  at: Point2;
  /** Height above the floor. Supply registers go low, returns high. */
  height: number;
  system: DuctSystem;
  /** The room it serves, by region key. */
  roomKey: string;
}

/** A radiator or an underfloor loop. */
export interface Emitter {
  id: string;
  levelId: string;
  at: Point2;
  kind: 'radiator' | 'underfloor';
  roomKey: string;
  /** Output at design conditions, in watts. Derived, stored for the schedule. */
  outputWatts: number;
  /** Length along the wall, for a radiator. Zero for underfloor. */
  length: number;
}

/** Bounds and defaults for the HVAC editor. */
export const HVAC_LIMITS = {
  /** Where supply ducts run: this far below the finished floor they serve. */
  ductVoidDepth: 0.25,
  /** How far below the ceiling a return duct runs. */
  returnHeight: 0.25,
  /** Supply registers go near the floor, under windows where possible. */
  supplyRegisterHeight: 0.15,
  /** Returns go high, where the warm air is. */
  returnRegisterHeight: 1.8,
  /** A radiator's height, for the 3D. */
  radiatorHeight: 0.6,
  radiatorDepth: 0.1,
} as const;

/* ------------------------- Reserved for later sessions -------------------- */

/* ─────────────────────────────── The site ────────────────────────────── */

/**
 * The shape of the ground.
 *
 * Three ways to describe it, in ascending order of effort:
 *
 *  • FLAT — the ground is the datum, which is what a first sketch assumes.
 *  • SLOPE — one constant fall in one direction. Most real plots away from a
 *    hillside are close enough to this that measuring more is wasted work.
 *  • SPOTS — surveyed heights at named points, interpolated between. This is
 *    what a topographic survey gives you, and the only honest way to describe
 *    a plot that falls in two directions at once.
 *
 * Heights are metres relative to the building's finished ground floor, so a
 * negative height is ground BELOW the front door — which is the normal case,
 * since a house sits up on its foundation.
 */
export interface Terrain {
  kind: 'flat' | 'slope' | 'spots';
  /**
   * Fall as a ratio: 0.1 drops a metre every ten. Slope mode only.
   *
   * Kept as a ratio rather than an angle because that is how site plans and
   * grading drawings quote it, and how the 1:12 and 2% figures that matter for
   * paths and drainage are written.
   */
  fall: number;
  /** Downhill direction, radians anticlockwise from world +X. Slope mode only. */
  fallDirection: number;
  /** Surveyed heights. Spots mode only. */
  spots: Array<{ id: string; at: Point2; height: number }>;
  /** Height of the datum point — the ground at the building — in metres. */
  datum: number;
}

/** What the ground is finished in, for rendering and for takeoffs later. */
export type GroundCover = 'grass' | 'gravel' | 'paving' | 'earth' | 'sand' | 'concrete';

/**
 * How far a building must stand back from each plot line.
 *
 * Zoning, not building code — the numbers come from the local ordinance and
 * vary street by street, so they are the user's to enter and the app's only job
 * is to hold them and say when the building crosses one. Which edge of the plot
 * is the FRONT decides which number applies where, and it is remembered by a
 * point on that edge rather than by its position in the outline, so that
 * redrawing the plot does not silently move the front of the house to the back.
 */
export interface Setbacks {
  front: number;
  rear: number;
  side: number;
  /** A point on the front plot line; the nearest edge to it is the front. */
  frontAt: Point2 | null;
}

/**
 * The plot the building stands on.
 *
 * `northAngle` drives every plan drawing and any daylight study. The sewer
 * connection matters to session 10, because a drain's fall is measured from the
 * fixture down to a real invert elevation at the boundary — without one,
 * drainage design has no datum to work to.
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
  /**
   * Where the building's drainage meets the public sewer.
   *
   * `invertDepth` is how far the pipe's invert sits BELOW the finished ground
   * floor at that point, in metres. It is the datum the whole drainage design
   * works back from: every fall in the building has to arrive here, and a
   * sewer that is shallower than the fixtures need is the one drainage problem
   * that cannot be solved by choosing a different pipe.
   */
  sewerConnection: { at: Point2; invertDepth: number } | null;
  /**
   * Where the water service enters the plot.
   *
   * Separate from the sewer because they are separate utilities that arrive at
   * separate points, and the distance from here to the furthest tap is what
   * the supply pressure calculation is measured along. Null means "not placed",
   * and the router assumes the front boundary — saying so in its assumptions.
   */
  waterService: { at: Point2 } | null;
  terrain: Terrain;
  ground: GroundCover;
  /** Null until the user enters their local ordinance's numbers. */
  setbacks: Setbacks | null;
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

/* ─────────────────────────────── The roof ────────────────────────────── */

/**
 * The four roof forms, which between them cover almost every house built.
 *
 *  HIP   — every eave slopes up to a ridge. No gable walls, so nothing to clad
 *          above the eave line, and the best form in a windy place.
 *  GABLE — the plainest and cheapest: two slopes, and a triangle of wall at
 *          each end. Which eaves are gabled is the user's choice, since a house
 *          can be hipped one end and gabled the other (a "Dutch" arrangement).
 *  FLAT  — not actually flat. A flat roof still falls, or it ponds; IRC R905
 *          sets minimum slopes by covering, and the check enforces them.
 *  SHED  — one plane, falling from a high side to a low one. Common on
 *          additions, porches and anything modern.
 */
export type RoofKind = 'hip' | 'gable' | 'flat' | 'shed';

/**
 * What the roof is covered in.
 *
 * Not decoration: the covering decides the minimum slope the roof may be laid
 * at (IRC R905), and getting that wrong is how a roof leaks. See `code/roof.ts`,
 * where each of these carries its own section and figure.
 */
export type RoofCovering =
  | 'asphalt-shingle'
  | 'wood-shake'
  | 'clay-tile'
  | 'concrete-tile'
  | 'slate'
  | 'standing-seam-metal'
  | 'metal-shingle'
  | 'membrane';

/**
 * A dormer: a window standing up out of a roof slope.
 *
 * Anchored by a point in PLAN rather than to a roof face, because roof faces
 * are derived from the footprint and are renumbered the moment a wall moves.
 * The face a dormer belongs to is whichever one its anchor falls in, which
 * means dragging a wall moves the dormer's roof with it instead of orphaning
 * it — and when a plan changes so much that the anchor falls off the roof
 * altogether, that is reported rather than silently dropped.
 */
export interface Dormer {
  id: string;
  /**
   * GABLE — a little pitched roof of its own, ridge running out of the slope.
   * SHED  — a single plane at a shallower pitch. Cheapest, and the one that
   *         gains the most floor area for its size.
   * HIPPED — sloped on three sides, to match a hipped main roof.
   */
  kind: 'gable' | 'shed' | 'hipped';
  /** Centre of the dormer's front (the cheek face), in plan. */
  at: Point2;
  /** Width across the slope, in metres. */
  width: number;
  /**
   * Height of the front wall, from where it meets the roof to its own eave.
   *
   * How far the dormer reaches BACK up the slope is not stored, because it is
   * not a free choice: a dormer's roof runs back until it dies into the roof it
   * sits in, and where that happens follows from this height and the two
   * pitches. Storing it as well would let the two disagree, and a dormer whose
   * roof stops short of the one it is cut into is not a dormer, it is a hole.
   */
  faceHeight: number;
  /** The dormer roof's own pitch, rise over run. Ignored for a hipped cheek. */
  pitch: number;
  /** The window in its face. Null for a blind dormer, which is rare but legal. */
  window: { width: number; height: number; sillHeight: number } | null;
}

/**
 * A skylight: glass lying in the plane of the roof.
 *
 * `length` is measured in PLAN, not up the slope, for the same reason every
 * other length in this file is a plan dimension — so that a skylight keeps its
 * footprint when the pitch changes. The real pane is longer by the slope
 * factor, and the geometry works that out rather than storing it.
 */
export interface Skylight {
  id: string;
  at: Point2;
  /** Across the slope, in metres. */
  width: number;
  /** Up the slope, measured in plan, in metres. */
  length: number;
  kind: 'fixed' | 'venting';
  /**
   * IRC R308.6 permits only these in a sloped glazed opening overhead.
   *
   * Ordinary annealed glass is not on the list: overhead, it breaks into
   * pieces that fall on whoever is underneath.
   */
  glazing: 'laminated' | 'tempered';
  /** Height of the upstand it sits on, in metres. Zero for a deck-mounted unit. */
  curb: number;
}

/**
 * A roof over one structure.
 *
 * The SHAPE is not stored. It is derived from the walls underneath by the
 * straight skeleton, every time, which is the only way a roof can still fit
 * after the plan changes. What is stored is everything the geometry cannot
 * know: how steep, how far it overhangs, what it is covered in, and which of
 * its eaves the user wants gabled.
 */
export interface Roof {
  id: string;
  /** The level this roof sits on top of. */
  overLevelId: string;
  /**
   * A wall belonging to the structure this roof covers.
   *
   * A plan can hold more than one free-standing structure — a house and a
   * detached garage — and each wants its own roof. Naming a wall rather than an
   * index means adding a room to the house does not hand the garage's roof to
   * the house. Null means the largest structure, which is what a single-building
   * plan always wants.
   */
  anchorWallId: string | null;
  kind: RoofKind;
  /** Rise over run, e.g. 0.5 for a 6:12 pitch. */
  pitch: number;
  /** How far the eaves project beyond the wall, in metres. */
  overhang: number;
  /**
   * Which eaves are gabled, named by the wall that carries each.
   *
   * Only meaningful for `kind: 'gable'`. Empty means the app picks the pair of
   * eaves at the ends of the main ridge, which is what "a gable roof" means to
   * most people; naming them explicitly is how you get a half-hipped house.
   */
  gableWallIds: string[];
  /** For a shed roof, the wall along the LOW side. Null means the app picks. */
  lowWallId: string | null;
  /**
   * Whether the roof space is ventilated (IRC R806) or a sealed assembly.
   *
   * A vented attic needs net free ventilating area, and the check works it out
   * from the roof's own plan area. An unvented one is legal but has conditions
   * attached, and the check says so rather than staying quiet.
   */
  ventilation: 'vented' | 'unvented';
  covering: RoofCovering;
  /** Hex colour of the covering, for the render. */
  colour: string;
  dormers: Dormer[];
  skylights: Skylight[];
}

/* ───────────────────────────── The exterior ──────────────────────────── */

/** What the outside walls are finished in. */
export type Cladding =
  | 'lap-siding'
  | 'board-and-batten'
  | 'shingle'
  | 'brick'
  | 'stone'
  | 'stucco'
  | 'fibre-cement';

/**
 * The outside of the building.
 *
 * One finish for the whole house with per-wall exceptions, rather than a finish
 * on every wall — because that is how houses are actually specified, and
 * because a default that has to be set forty times is a default that is wrong
 * thirty-nine times. Overrides are keyed by wall ID, so they survive the wall
 * being moved and vanish with the wall being deleted.
 */
export interface Exterior {
  cladding: Cladding;
  claddingColour: string;
  /** Fascia, barge boards, window surrounds. */
  trimColour: string;
  /** Wall ID to its own finish, where it differs. */
  overrides: Record<string, { cladding?: Cladding; colour?: string }>;
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
  exterior: Exterior;
  /** Empty until session 11. See `ServiceNetwork`. */
  services: ServiceNetwork[];
  /** Outlets, switches, fittings, circuits and the panel. */
  electrical: ElectricalPlan;
  /** Supply, drainage, vents, the stack and the water heater. */
  plumbing: PlumbingPlan;
  /** The envelope, the design location, the equipment and the ductwork. */
  hvac: HvacPlan;

  /**
   * Kitchen and bathroom cabinetry, and the fixtures.
   *
   * On the document rather than on each level because a run and a fixture both
   * name the storey they are on, and keeping them in one place is what lets the
   * electrical, and later the plumbing, ask "where is every sink in the
   * building" in one pass rather than walking the storeys.
   */
  runs: CabinetRun[];
  fixtures: Fixture[];

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
  /**
   * Whether the roofs are drawn.
   *
   * On by default, unlike ceilings — a roof only exists because somebody added
   * one, and hiding what they just asked for would be strange. Turning it off
   * is how you look down into the storey below, which is the one thing a roof
   * makes impossible.
   */
  showRoofs: boolean;

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

export const ROOF_LIMITS = {
  /**
   * Pitch as rise over run.
   *
   * The floor is a quarter in twelve (0.0208), the shallowest fall IRC R905
   * asks of any covering — below that nothing may be laid, so nothing below it
   * can be offered. The ceiling is 24:12, steeper than any house roof and
   * already into spire territory.
   */
  pitch: { min: 0.0208, max: 2, step: 0.0208 },
  /** Eaves projection. A metre is a deep, deliberate overhang; more is a canopy. */
  overhang: { min: 0, max: 1.2, step: 0.05 },
} as const;

export const DORMER_LIMITS = {
  width: { min: 0.6, max: 6, step: 0.05 },
  faceHeight: { min: 0.6, max: 3, step: 0.05 },
  pitch: { min: 0.0208, max: 2, step: 0.0208 },
} as const;

export const SKYLIGHT_LIMITS = {
  width: { min: 0.3, max: 3, step: 0.05 },
  length: { min: 0.3, max: 4, step: 0.05 },
  curb: { min: 0, max: 0.4, step: 0.01 },
} as const;

export const UNDERLAY_LIMITS = {
  /**
   * Metres per pixel.
   *
   * The floor is a tenth of a millimetre per pixel — finer than any scan of a
   * building is — and the ceiling is a metre per pixel, which is a satellite
   * photograph. Anything outside that is a calibration mistake, not a plan.
   */
  metresPerPixel: { min: 0.0001, max: 1 },
  opacity: { min: 0.05, max: 1, step: 0.05 },
  /** Longest side an imported image is kept at, in pixels. */
  maxPixels: 3200,
} as const;

export const ELECTRICAL_LIMITS = {
  /** Mounting height above the finished floor, in metres. */
  height: { min: 0.1, max: 2.6, step: 0.01 },
  /** Breaker rating, in amperes. */
  amps: { min: 15, max: 100 },
  /** Connected load for one device, in volt-amperes. */
  va: { min: 0, max: 20000 },
  /** Service size, in amperes. */
  service: { min: 100, max: 400 },
  maxDevices: 600,
  maxCircuits: 60,
} as const;

export const SITE_LIMITS = {
  /** Fall as a ratio. 1:2 is a bank you terrace rather than build on. */
  fall: { min: 0, max: 0.5, step: 0.005 },
  /** Setback distances, in metres. */
  setback: { min: 0, max: 30, step: 0.1 },
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
