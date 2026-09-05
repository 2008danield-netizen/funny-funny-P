/**
 * The document a first-time visitor sees, plus validation for incoming
 * documents (from localStorage or an imported file, neither of which can be
 * trusted to match the current schema).
 */

import {
  CLEARANCE_DEFAULTS,
  DORMER_LIMITS,
  ELECTRICAL_LIMITS,
  LEVEL_LIMITS,
  OPENING_LIMITS,
  PLAN_LIMITS,
  ROOF_LIMITS,
  SCHEMA_VERSION,
  SITE_LIMITS,
  SKYLIGHT_LIMITS,
  STAIR_LIMITS,
  UNDERLAY_LIMITS,
  type Cladding,
  type DesignDocument,
  type Dormer,
  type Circuit,
  type CircuitKind,
  type DeviceKind,
  type ElectricalDevice,
  type ElectricalPlan,
  type Exterior,
  type GroundCover,
  type FloorSpec,
  type FloorVoid,
  type FurnitureItem,
  type Level,
  type Opening,
  type Panel,
  type PlanModel,
  type Point2,
  type Roof,
  type RoofCovering,
  type RoofKind,
  type RoomSpec,
  type Setbacks,
  type Site,
  type Skylight,
  type Stair,
  type StairForm,
  type StairTurn,
  type Terrain,
  type Underlay,
  type Vertex,
  type Wall,
  type WallFaceSpec,
} from './types';
import { defaultLevelName } from './levels';
import { conductorFor } from '@/code/nec';
import { migrateDocument } from './migrate';
import { addRectangle, normalizePlan } from './planOps';
import { getCatalogEntry, isKnownCatalogId } from '@/furniture/catalog';

/** Warm off-white -- reads as "freshly painted" rather than clinical white. */
export const DEFAULT_WALL_COLOR = '#ece7df';

/** Matte emulsion. Most interior walls are far rougher than people expect. */
export const DEFAULT_WALL_ROUGHNESS = 0.88;

export function defaultWallFace(): WallFaceSpec {
  return { color: DEFAULT_WALL_COLOR, roughness: DEFAULT_WALL_ROUGHNESS };
}

export function defaultFloor(): FloorSpec {
  return { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 };
}

export function defaultRoomSpec(name = 'Room'): RoomSpec {
  return {
    name,
    floor: defaultFloor(),
    wall: defaultWallFace(),
    ceilingColor: '#f7f5f2',
  };
}

/** A single 4.2 m x 3.4 m room with a 2.6 m ceiling -- a realistic living room. */
export function createDefaultPlan(): PlanModel {
  const plan: PlanModel = {
    vertices: [],
    walls: [],
    rooms: {},
    defaultRoom: defaultRoomSpec('Living Room'),
    defaultWallHeight: 2.6,
    defaultWallThickness: 0.12,
  };
  addRectangle(plan, { x: 0, z: 0 }, 4.2, 3.4);
  return plan;
}

/** A storey with nothing drawn on it yet. */
export function createLevel(id: string, name: string, plan?: PlanModel): Level {
  return {
    id,
    name,
    wallHeight: 2.6,
    // A joisted timber floor with its ceiling is about 250 mm. It matters more
    // than it looks: it is the difference between the ceiling height people
    // quote and the floor-to-floor rise a staircase actually has to climb.
    slabThickness: 0.25,
    plan: plan ?? createDefaultPlan(),
    underlay: null,
    furniture: [],
    voids: [],
  };
}

/* -------------------------- Roofs, site, exterior ------------------------- */

/** Weathered charcoal, the commonest asphalt shingle colour in America. */
export const DEFAULT_ROOF_COLOUR = '#4c5157';
/** Warm off-white siding, which is what most of the country is clad in. */
export const DEFAULT_CLADDING_COLOUR = '#e4ded2';
/** Trim is painted lighter than the wall on almost every house ever built. */
export const DEFAULT_TRIM_COLOUR = '#f7f5f0';

/**
 * Flat ground, one foot below the finished floor.
 *
 * Not zero. A house sits UP on its foundation — a step or two at the front door
 * is so normal that its absence is what looks wrong — and ground at exactly
 * floor level also puts two surfaces in the same plane, which reads on screen
 * as a torn, flickering edge all the way round the building.
 */
export function defaultTerrain(): Terrain {
  return { kind: 'flat', fall: 0, fallDirection: 0, spots: [], datum: -0.3 };
}

export function defaultSite(): Site {
  return {
    northAngle: 0,
    boundary: [],
    sewerConnection: null,
    terrain: defaultTerrain(),
    ground: 'grass',
    setbacks: null,
  };
}

/**
 * An empty electrical installation.
 *
 * No devices, no circuits and no panel — and no heating or cooling figures,
 * which the load calculation then reports as missing rather than guessing at.
 */
export function defaultElectrical(): ElectricalPlan {
  return { devices: [], circuits: [], panel: null, heatingVa: 0, coolingVa: 0 };
}

export function defaultExterior(): Exterior {
  return {
    cladding: 'lap-siding',
    claddingColour: DEFAULT_CLADDING_COLOUR,
    trimColour: DEFAULT_TRIM_COLOUR,
    overrides: {},
  };
}

/**
 * A sensible roof to start from.
 *
 * A 6:12 hip with a 400 mm overhang is the American default in the most literal
 * sense: it is what the majority of houses built since the war actually have,
 * it sheds snow, it clears the minimum slope for every covering in R905, and it
 * is shallow enough to walk on when something needs fixing.
 */
export function defaultRoofFor(levelId: string, id = 'roof1'): Roof {
  return {
    id,
    overLevelId: levelId,
    anchorWallId: null,
    kind: 'hip',
    pitch: 0.5,
    overhang: 0.4,
    gableWallIds: [],
    lowWallId: null,
    ventilation: 'vented',
    covering: 'asphalt-shingle',
    colour: DEFAULT_ROOF_COLOUR,
    dormers: [],
    skylights: [],
  };
}

export function createDefaultDocument(): DesignDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Untitled Home',
    updatedAt: new Date().toISOString(),
    levels: [createLevel('lv1', 'First Floor')],
    activeLevelId: 'lv1',
    stairs: [],
    roofs: [],
    showRoofs: true,
    site: defaultSite(),
    exterior: defaultExterior(),
    services: [],
    electrical: defaultElectrical(),
    lighting: {
      presetId: 'daylight',
      intensity: 1,
      shadowsEnabled: true,
    },
    clearance: {
      // Advisory by default. Clearance is guidance, not physics, and a designer
      // working a small flat routinely accepts a tight walkway on purpose.
      strict: false,
      walkwayWidth: CLEARANCE_DEFAULTS.walkway,
    },
    currency: 'USD',
    // Hidden by default: opaque ceilings block the orbit camera's view in from
    // above, which is how people naturally inspect a floor plan.
    showCeilings: false,
    // Feet and inches. The app is built to US codes, which are written in
    // inches, and a figure that has to be converted before it can be checked
    // against the limit it failed is a figure nobody checks.
    units: 'imperial',
  };
}

/* ------------------------------ Validation ---------------------------- */

/** Clamps a number into a range, falling back for NaN/undefined. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Accepts a value only if it looks like a `#rrggbb` hex colour. */
function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function safeString(value: unknown, fallback: string, maxLength = 120): string {
  return typeof value === 'string' && value.trim() ? value.slice(0, maxLength) : fallback;
}

function safeFace(value: unknown): WallFaceSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    color: safeColor(raw.color, DEFAULT_WALL_COLOR),
    roughness: clamp(raw.roughness, 0, 1, DEFAULT_WALL_ROUGHNESS),
  };
}

function safeFloor(value: unknown): FloorSpec {
  const base = defaultFloor();
  if (typeof value !== 'object' || value === null) return base;
  const raw = value as Record<string, unknown>;
  return {
    // The preset ID is checked against the real registry by the material
    // library, which falls back safely if it no longer exists.
    presetId: safeString(raw.presetId, base.presetId, 60),
    color: safeColor(raw.color, base.color),
    textureScale: clamp(raw.textureScale, 0.25, 4, base.textureScale),
  };
}

function safeRoomSpec(value: unknown, fallbackName: string): RoomSpec {
  const base = defaultRoomSpec(fallbackName);
  if (typeof value !== 'object' || value === null) return base;
  const raw = value as Record<string, unknown>;
  return {
    name: safeString(raw.name, base.name, 60),
    floor: safeFloor(raw.floor),
    wall: safeFace(raw.wall) ?? base.wall,
    ceilingColor: safeColor(raw.ceilingColor, base.ceilingColor),
  };
}

function safeOpening(value: unknown, index: number): Opening | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  const kind = raw.kind === 'window' ? 'window' : 'door';
  return {
    id: safeString(raw.id, `o${index + 1}`, 40),
    kind,
    presetId: safeString(raw.presetId, kind === 'window' ? 'window-casement' : 'door-single', 60),
    offset: clamp(raw.offset, 0, PLAN_LIMITS.planExtent * 4, 1),
    width: clamp(raw.width, OPENING_LIMITS.width.min, OPENING_LIMITS.width.max, 0.9),
    height: clamp(raw.height, OPENING_LIMITS.height.min, OPENING_LIMITS.height.max, 2.04),
    sillHeight: clamp(raw.sillHeight, OPENING_LIMITS.sillHeight.min, OPENING_LIMITS.sillHeight.max, 0),
    hinge: raw.hinge === 'end' ? 'end' : 'start',
    swing: raw.swing === 'b' ? 'b' : 'a',
  };
}

/**
 * Coerces an arbitrary parsed object into a valid PlanModel.
 *
 * Walls referring to missing vertices are dropped rather than repaired: a wall
 * with no endpoint has no meaningful position to guess at, and leaving it in
 * would crash geometry building.
 */
function safePlan(value: unknown): PlanModel {
  if (typeof value !== 'object' || value === null) return createDefaultPlan();
  const raw = value as Record<string, unknown>;

  const limit = PLAN_LIMITS.planExtent;
  const vertices: Vertex[] = [];
  const seenVertexIds = new Set<string>();

  if (Array.isArray(raw.vertices)) {
    raw.vertices.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) return;
      const item = entry as Record<string, unknown>;
      const id = safeString(item.id, `v${index + 1}`, 40);
      if (seenVertexIds.has(id)) return;
      seenVertexIds.add(id);
      vertices.push({
        id,
        x: clamp(item.x, -limit, limit, 0),
        z: clamp(item.z, -limit, limit, 0),
      });
    });
  }

  const defaultHeight = clamp(
    raw.defaultWallHeight,
    PLAN_LIMITS.wallHeight.min,
    PLAN_LIMITS.wallHeight.max,
    2.6,
  );
  const defaultThickness = clamp(
    raw.defaultWallThickness,
    PLAN_LIMITS.wallThickness.min,
    PLAN_LIMITS.wallThickness.max,
    0.12,
  );

  const walls: Wall[] = [];
  const seenWallIds = new Set<string>();

  if (Array.isArray(raw.walls)) {
    raw.walls.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) return;
      const item = entry as Record<string, unknown>;

      const id = safeString(item.id, `w${index + 1}`, 40);
      const start = typeof item.start === 'string' ? item.start : '';
      const end = typeof item.end === 'string' ? item.end : '';
      if (seenWallIds.has(id)) return;
      if (!seenVertexIds.has(start) || !seenVertexIds.has(end) || start === end) return;
      seenWallIds.add(id);

      const faces = (item.faces ?? {}) as Record<string, unknown>;
      const openings: Opening[] = [];
      if (Array.isArray(item.openings)) {
        item.openings.forEach((opening, openingIndex) => {
          const parsed = safeOpening(opening, openingIndex);
          if (parsed) openings.push(parsed);
        });
      }

      walls.push({
        id,
        start,
        end,
        thickness: clamp(
          item.thickness,
          PLAN_LIMITS.wallThickness.min,
          PLAN_LIMITS.wallThickness.max,
          defaultThickness,
        ),
        height: clamp(
          item.height,
          PLAN_LIMITS.wallHeight.min,
          PLAN_LIMITS.wallHeight.max,
          defaultHeight,
        ),
        faces: {
          ...(safeFace(faces.a) ? { a: safeFace(faces.a) } : {}),
          ...(safeFace(faces.b) ? { b: safeFace(faces.b) } : {}),
        },
        openings,
      });
    });
  }

  const rooms: Record<string, RoomSpec> = {};
  if (typeof raw.rooms === 'object' && raw.rooms !== null) {
    for (const [key, spec] of Object.entries(raw.rooms as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.length > 800) continue;
      rooms[key] = safeRoomSpec(spec, 'Room');
    }
  }

  const plan: PlanModel = {
    vertices,
    walls,
    rooms,
    defaultRoom: safeRoomSpec(raw.defaultRoom, 'Room'),
    defaultWallHeight: defaultHeight,
    defaultWallThickness: defaultThickness,
  };

  normalizePlan(plan);

  // A plan with nothing in it leaves the user staring at an empty grid with no
  // obvious way forward, so fall back to the starter room.
  if (plan.walls.length === 0) return createDefaultPlan();
  return plan;
}

/**
 * Coerces a parsed value into a valid furniture list.
 *
 * Items naming a catalogue entry that no longer exists are DROPPED rather than
 * remapped: silently turning someone's wardrobe into a bookcase because a
 * catalogue ID was renamed would be worse than the gap. Positions are clamped
 * to the plan area but not collision-checked here — validation runs before the
 * plan is known to be sound, and `reseatFurniture` handles that afterwards.
 */
function safeFurniture(value: unknown): FurnitureItem[] {
  if (!Array.isArray(value)) return [];

  const items: FurnitureItem[] = [];
  const seen = new Set<string>();
  const limit = PLAN_LIMITS.planExtent;

  value.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const raw = entry as Record<string, unknown>;

    const catalogId = typeof raw.catalogId === 'string' ? raw.catalogId : '';
    if (!isKnownCatalogId(catalogId)) return;

    const id = safeString(raw.id, `f${index + 1}`, 40);
    if (seen.has(id)) return;
    seen.add(id);

    const catalogEntry = getCatalogEntry(catalogId);
    let size: FurnitureItem['size'];
    if (typeof raw.size === 'object' && raw.size !== null && catalogEntry.resizable) {
      const rawSize = raw.size as Record<string, unknown>;
      size = {
        width: clamp(rawSize.width, 0.1, 6, catalogEntry.width),
        depth: clamp(rawSize.depth, 0.1, 6, catalogEntry.depth),
        height: clamp(rawSize.height, 0.05, 4, catalogEntry.height),
      };
    }

    items.push({
      id,
      catalogId,
      x: clamp(raw.x, -limit, limit, 0),
      z: clamp(raw.z, -limit, limit, 0),
      y: clamp(raw.y, 0, 4, 0),
      // Normalised into -PI..PI so a document cannot carry an accumulated
      // rotation of forty radians from repeated key presses.
      rotation: normalizeAngle(clamp(raw.rotation, -1000, 1000, 0)),
      ...(typeof raw.colorwayId === 'string' ? { colorwayId: raw.colorwayId } : {}),
      // A confirmed price. Clamped rather than trusted, since it arrives from a
      // JSON file that may have been hand-edited.
      ...(typeof raw.price === 'number' && Number.isFinite(raw.price) && raw.price >= 0
        ? { price: Math.min(1_000_000, raw.price) }
        : {}),
      ...(size ? { size } : {}),
    });
  });

  return items;
}

/** Coerces the clearance settings, clamping the walkway to something sane. */
function safeClearance(value: unknown): DesignDocument['clearance'] {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    strict: raw.strict === true,
    // Below half a metre nobody fits through; above two the guidance stops
    // being about walking and starts rejecting normal rooms.
    walkwayWidth: clamp(raw.walkwayWidth, 0.5, 2, CLEARANCE_DEFAULTS.walkway),
  };
}

/**
 * Coerces the currency label.
 *
 * A label only: no conversion happens anywhere, so this is restricted to a
 * short string rather than validated against a currency list. Accepting "kr"
 * or "zl" matters more than rejecting nonsense nobody will type.
 */
function safeCurrency(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 6) : 'EUR';
}

/** Wraps an angle into -PI..PI. */
export function normalizeAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  let angle = radians % twoPi;
  if (angle > Math.PI) angle -= twoPi;
  if (angle < -Math.PI) angle += twoPi;
  return angle;
}


/* ------------------------------ Levels and stairs --------------------------- */

/**
 * Validates the storeys, and guarantees there is at least one.
 *
 * A building with no levels has nowhere to draw, so a document that arrives
 * empty or broken gets the starter room rather than a blank screen with no way
 * back. Level IDs are also forced unique: two storeys sharing an ID makes
 * `activeLevel` ambiguous and would have the editor writing to one and drawing
 * the other.
 */
export function safeLevels(
  value: unknown,
  activeId: unknown,
): { list: Level[]; activeId: string } {
  const input = Array.isArray(value) ? value : [];
  const list: Level[] = [];
  const seen = new Set<string>();

  for (const entry of input.slice(0, LEVEL_LIMITS.maxLevels)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;

    let id = safeString(raw.id, `lv${list.length + 1}`, 40);
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);

    list.push({
      id,
      name: safeString(raw.name, defaultLevelName(list.length), 60),
      wallHeight: clamp(
        raw.wallHeight,
        LEVEL_LIMITS.wallHeight.min,
        LEVEL_LIMITS.wallHeight.max,
        2.6,
      ),
      slabThickness: clamp(
        raw.slabThickness,
        LEVEL_LIMITS.slabThickness.min,
        LEVEL_LIMITS.slabThickness.max,
        0.25,
      ),
      plan: safePlan(raw.plan),
      underlay: safeUnderlay(raw.underlay),
      furniture: safeFurniture(raw.furniture),
      voids: safeVoids(raw.voids),
    });
  }

  if (list.length === 0) list.push(createLevel('lv1', 'First Floor'));

  const wanted = typeof activeId === 'string' ? activeId : '';
  return {
    list,
    activeId: list.some((level) => level.id === wanted) ? wanted : list[0]!.id,
  };
}

const DEVICE_KINDS: readonly DeviceKind[] = [
  'receptacle',
  'receptacle-gfci',
  'receptacle-counter',
  'receptacle-appliance',
  'switch',
  'switch-3way',
  'switch-dimmer',
  'light-ceiling',
  'light-wall',
  'light-recessed',
  'fan',
  'smoke-alarm',
  'thermostat',
  'panel',
];

const CIRCUIT_KINDS: readonly CircuitKind[] = [
  'general',
  'lighting',
  'small-appliance',
  'laundry',
  'bathroom',
  'individual',
];

/**
 * Validates the electrical installation.
 *
 * A device on a storey that no longer exists is dropped, for the same reason a
 * stranded staircase is: it has no wall to be fixed to, and quietly moving it
 * to another floor would put somebody's socket in a different room.
 *
 * A device naming a circuit that is not in the list keeps its position and
 * loses the reference, rather than being deleted. An unassigned outlet is a
 * real state — it is what every outlet is between being placed and being
 * wired — and the checks report it.
 */
function safeElectrical(value: unknown, levels: readonly Level[]): ElectricalPlan {
  const base = defaultElectrical();
  if (typeof value !== 'object' || value === null) return base;
  const raw = value as Record<string, unknown>;

  const levelIds = new Set(levels.map((level) => level.id));

  const circuits: Circuit[] = [];
  const seenCircuits = new Set<string>();
  if (Array.isArray(raw.circuits)) {
    for (const entry of raw.circuits.slice(0, ELECTRICAL_LIMITS.maxCircuits)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const circuit = entry as Record<string, unknown>;

      const id = safeString(circuit.id, `c${circuits.length + 1}`, 60);
      if (seenCircuits.has(id)) continue;
      seenCircuits.add(id);

      const amps = clamp(circuit.amps, ELECTRICAL_LIMITS.amps.min, ELECTRICAL_LIMITS.amps.max, 15);
      circuits.push({
        id,
        reference: safeString(circuit.reference, `${circuits.length + 1}`, 8),
        name: safeString(circuit.name, 'Circuit', 60),
        kind: oneOf(circuit.kind, CIRCUIT_KINDS, 'general'),
        amps,
        volts: circuit.volts === 240 ? 240 : 120,
        conductor: safeString(circuit.conductor, conductorFor(amps).size, 16),
        gfci: circuit.gfci === true,
        afci: circuit.afci === true,
      });
    }
  }

  const devices: ElectricalDevice[] = [];
  const seenDevices = new Set<string>();
  if (Array.isArray(raw.devices)) {
    for (const entry of raw.devices.slice(0, ELECTRICAL_LIMITS.maxDevices)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const device = entry as Record<string, unknown>;

      const levelId = typeof device.levelId === 'string' ? device.levelId : '';
      if (!levelIds.has(levelId)) continue;

      const at = safePoint(device.at);
      if (!at) continue;

      const id = safeString(device.id, `d${devices.length + 1}`, 60);
      if (seenDevices.has(id)) continue;
      seenDevices.add(id);

      const circuitId = typeof device.circuitId === 'string' ? device.circuitId : null;
      devices.push({
        id,
        levelId,
        kind: oneOf(device.kind, DEVICE_KINDS, 'receptacle'),
        at,
        height: clamp(
          device.height,
          ELECTRICAL_LIMITS.height.min,
          ELECTRICAL_LIMITS.height.max,
          0.38,
        ),
        rotation: normalizeAngle(typeof device.rotation === 'number' ? device.rotation : 0),
        wallId: typeof device.wallId === 'string' ? device.wallId : null,
        circuitId: circuitId && seenCircuits.has(circuitId) ? circuitId : null,
        va:
          typeof device.va === 'number' && Number.isFinite(device.va)
            ? clamp(device.va, ELECTRICAL_LIMITS.va.min, ELECTRICAL_LIMITS.va.max, 0)
            : null,
        label: safeString(device.label, 'Outlet', 80),
      });
    }
  }

  let panel: Panel | null = null;
  if (typeof raw.panel === 'object' && raw.panel !== null) {
    const entry = raw.panel as Record<string, unknown>;
    const at = safePoint(entry.at);
    const levelId = typeof entry.levelId === 'string' ? entry.levelId : '';
    if (at && levelIds.has(levelId)) {
      panel = {
        levelId,
        at,
        rotation: normalizeAngle(typeof entry.rotation === 'number' ? entry.rotation : 0),
        mainAmps: clamp(
          entry.mainAmps,
          ELECTRICAL_LIMITS.service.min,
          ELECTRICAL_LIMITS.service.max,
          200,
        ),
        volts: entry.volts === 120 ? 120 : 240,
        spaces: Math.round(clamp(entry.spaces, 8, 84, 40)),
      };
    }
  }

  return {
    devices,
    circuits,
    panel,
    heatingVa: clamp(raw.heatingVa, 0, 60000, 0),
    coolingVa: clamp(raw.coolingVa, 0, 60000, 0),
  };
}

/**
 * Validates a traced plan's placement.
 *
 * An underlay with no image key is dropped rather than kept: it would draw
 * nothing, sit in the panel offering controls for a picture that does not
 * exist, and quietly stop the user from importing a real one.
 */
function safeUnderlay(value: unknown): Underlay | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  const imageId = typeof raw.imageId === 'string' ? raw.imageId.slice(0, 120) : '';
  if (!imageId) return null;

  const pixelWidth = Math.round(clamp(raw.pixelWidth, 1, 20000, 1000));
  const pixelHeight = Math.round(clamp(raw.pixelHeight, 1, 20000, 1000));
  const at = safePoint(raw.at) ?? { x: 0, z: 0 };

  let calibration: Underlay['calibration'] = null;
  if (typeof raw.calibration === 'object' && raw.calibration !== null) {
    const entry = raw.calibration as Record<string, unknown>;
    const from = safePixelPoint(entry.from, pixelWidth, pixelHeight);
    const to = safePixelPoint(entry.to, pixelWidth, pixelHeight);
    const metres = clamp(entry.metres, 0.01, 500, 1);
    if (from && to) {
      calibration = { from, to, metres, label: safeString(entry.label, 'a known length', 80) };
    }
  }

  return {
    imageId,
    pixelWidth,
    pixelHeight,
    at,
    metresPerPixel: clamp(
      raw.metresPerPixel,
      UNDERLAY_LIMITS.metresPerPixel.min,
      UNDERLAY_LIMITS.metresPerPixel.max,
      // An uncalibrated guess: a plan of a house on a sheet about 3000 px wide
      // is roughly a centimetre to the pixel. Wrong, but the right order.
      0.01,
    ),
    rotation: normalizeAngle(typeof raw.rotation === 'number' ? raw.rotation : 0),
    opacity: clamp(raw.opacity, UNDERLAY_LIMITS.opacity.min, UNDERLAY_LIMITS.opacity.max, 0.5),
    locked: raw.locked === true,
    calibration,
  };
}

/** A point in image pixels, kept inside the image. */
function safePixelPoint(value: unknown, width: number, height: number): Point2 | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.x !== 'number' || typeof raw.z !== 'number') return null;
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.z)) return null;
  return { x: clamp(raw.x, 0, width, 0), z: clamp(raw.z, 0, height, 0) };
}

function safeVoids(value: unknown): FloorVoid[] {
  if (!Array.isArray(value)) return [];
  const voids: FloorVoid[] = [];

  for (const entry of value.slice(0, 40)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const polygon = safePolygon(raw.polygon);
    // Fewer than three corners is not a hole, it is a line.
    if (polygon.length < 3) continue;
    voids.push({
      id: safeString(raw.id, `void${voids.length + 1}`, 40),
      name: safeString(raw.name, 'Opening', 60),
      polygon,
    });
  }

  return voids;
}

function safePolygon(value: unknown): Point2[] {
  if (!Array.isArray(value)) return [];
  const points: Point2[] = [];
  for (const entry of value.slice(0, 200)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.x !== 'number' || typeof raw.z !== 'number') continue;
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.z)) continue;
    points.push({
      x: clamp(raw.x, -PLAN_LIMITS.planExtent, PLAN_LIMITS.planExtent, 0),
      z: clamp(raw.z, -PLAN_LIMITS.planExtent, PLAN_LIMITS.planExtent, 0),
    });
  }
  return points;
}

/**
 * Validates the staircases.
 *
 * A stair whose `fromLevelId` names a storey that no longer exists is dropped
 * rather than repaired: it has no rise to climb and no floor to stand on, and
 * silently reassigning it to some other level would move somebody's staircase
 * to a different part of the house without telling them.
 */
export function safeStairs(value: unknown, levels: readonly Level[]): Stair[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(levels.map((level) => level.id));
  const stairs: Stair[] = [];
  const seen = new Set<string>();

  for (const entry of value.slice(0, 20)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;

    const fromLevelId = typeof raw.fromLevelId === 'string' ? raw.fromLevelId : '';
    if (!ids.has(fromLevelId)) continue;

    const at = raw.at as Record<string, unknown> | undefined;
    if (!at || typeof at.x !== 'number' || typeof at.z !== 'number') continue;

    let id = safeString(raw.id, `st${stairs.length + 1}`, 40);
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);

    stairs.push({
      id,
      name: safeString(raw.name, 'Stair', 60),
      fromLevelId,
      form: safeStairForm(raw.form),
      at: {
        x: clamp(at.x, -PLAN_LIMITS.planExtent, PLAN_LIMITS.planExtent, 0),
        z: clamp(at.z, -PLAN_LIMITS.planExtent, PLAN_LIMITS.planExtent, 0),
      },
      rotation: normalizeAngle(typeof raw.rotation === 'number' ? raw.rotation : 0),
      width: clamp(raw.width, STAIR_LIMITS.width.min, STAIR_LIMITS.width.max, 0.9144),
      treadDepth: clamp(
        raw.treadDepth,
        STAIR_LIMITS.treadDepth.min,
        STAIR_LIMITS.treadDepth.max,
        0.2794,
      ),
      riserCount: Math.round(
        clamp(raw.riserCount, STAIR_LIMITS.riserCount.min, STAIR_LIMITS.riserCount.max, 14),
      ),
      nosing: clamp(raw.nosing, STAIR_LIMITS.nosing.min, STAIR_LIMITS.nosing.max, 0.0254),
      handrail:
        raw.handrail === 'none' || raw.handrail === 'left' || raw.handrail === 'right'
          ? raw.handrail
          : 'both',
    });
  }

  return stairs;
}

function safeStairForm(value: unknown): StairForm {
  if (typeof value !== 'object' || value === null) return { kind: 'straight' };
  const raw = value as Record<string, unknown>;
  const turn: StairTurn = raw.turn === 'left' ? 'left' : 'right';

  switch (raw.kind) {
    case 'l-shaped':
      return {
        kind: 'l-shaped',
        turn,
        risersBeforeLanding: Math.round(clamp(raw.risersBeforeLanding, 1, 30, 7)),
      };
    case 'u-shaped':
      return {
        kind: 'u-shaped',
        turn,
        risersBeforeLanding: Math.round(clamp(raw.risersBeforeLanding, 1, 30, 8)),
      };
    case 'winder':
      return {
        kind: 'winder',
        turn,
        risersBeforeWinder: Math.round(clamp(raw.risersBeforeWinder, 1, 30, 6)),
        winderTreads: Math.round(
          clamp(raw.winderTreads, STAIR_LIMITS.winderTreads.min, STAIR_LIMITS.winderTreads.max, 3),
        ),
        innerRadius: clamp(
          raw.innerRadius,
          STAIR_LIMITS.spiralInnerRadius.min,
          STAIR_LIMITS.spiralInnerRadius.max,
          0.1,
        ),
      };
    case 'spiral':
      return {
        kind: 'spiral',
        clockwise: raw.clockwise !== false,
        innerRadius: clamp(
          raw.innerRadius,
          STAIR_LIMITS.spiralInnerRadius.min,
          STAIR_LIMITS.spiralInnerRadius.max,
          0.15,
        ),
      };
    default:
      return { kind: 'straight' };
  }
}

const ROOF_KINDS: readonly RoofKind[] = ['hip', 'gable', 'flat', 'shed'];

const ROOF_COVERINGS: readonly RoofCovering[] = [
  'asphalt-shingle',
  'wood-shake',
  'clay-tile',
  'concrete-tile',
  'slate',
  'standing-seam-metal',
  'metal-shingle',
  'membrane',
];

const CLADDINGS: readonly Cladding[] = [
  'lap-siding',
  'board-and-batten',
  'shingle',
  'brick',
  'stone',
  'stucco',
  'fibre-cement',
];

const GROUND_COVERS: readonly GroundCover[] = [
  'grass',
  'gravel',
  'paving',
  'earth',
  'sand',
  'concrete',
];

/** Accepts a value only if it is one of a known set. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function safePoint(value: unknown): Point2 | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.x !== 'number' || typeof raw.z !== 'number') return null;
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.z)) return null;
  return {
    x: clamp(raw.x, -PLAN_LIMITS.planExtent, PLAN_LIMITS.planExtent, 0),
    z: clamp(raw.z, -PLAN_LIMITS.planExtent, PLAN_LIMITS.planExtent, 0),
  };
}

/** Wall IDs, deduplicated. Unknown IDs are kept: the wall may be on another level. */
function safeIdList(value: unknown, limit = 64): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, limit)) {
    if (typeof entry !== 'string' || !entry) continue;
    if (out.includes(entry)) continue;
    out.push(entry.slice(0, 120));
  }
  return out;
}

function safeTerrain(value: unknown): Terrain {
  const base = defaultTerrain();
  if (typeof value !== 'object' || value === null) return base;
  const raw = value as Record<string, unknown>;

  const spots: Terrain['spots'] = [];
  if (Array.isArray(raw.spots)) {
    for (const entry of raw.spots.slice(0, 400)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const spot = entry as Record<string, unknown>;
      const at = safePoint(spot.at);
      if (!at) continue;
      spots.push({
        id: safeString(spot.id, `spot${spots.length + 1}`, 60),
        at,
        // A 30 m cut or fill is beyond anything a house sits in; past that the
        // number is corrupt rather than steep.
        height: clamp(spot.height, -30, 30, 0),
      });
    }
  }

  return {
    kind: oneOf(raw.kind, ['flat', 'slope', 'spots'] as const, 'flat'),
    fall: clamp(raw.fall, SITE_LIMITS.fall.min, SITE_LIMITS.fall.max, 0),
    fallDirection: normalizeAngle(typeof raw.fallDirection === 'number' ? raw.fallDirection : 0),
    spots,
    datum: clamp(raw.datum, -30, 30, 0),
  };
}

function safeSetbacks(value: unknown): Setbacks | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const { min, max } = SITE_LIMITS.setback;
  return {
    front: clamp(raw.front, min, max, 0),
    rear: clamp(raw.rear, min, max, 0),
    side: clamp(raw.side, min, max, 0),
    frontAt: safePoint(raw.frontAt),
  };
}

function safeSite(value: unknown): Site {
  const base = defaultSite();
  if (typeof value !== 'object' || value === null) return base;
  const raw = value as Record<string, unknown>;
  return {
    northAngle: normalizeAngle(typeof raw.northAngle === 'number' ? raw.northAngle : 0),
    boundary: safePolygon(raw.boundary),
    sewerConnection: null,
    terrain: safeTerrain(raw.terrain),
    ground: oneOf(raw.ground, GROUND_COVERS, 'grass'),
    setbacks: safeSetbacks(raw.setbacks),
  };
}

function safeExterior(value: unknown): Exterior {
  const base = defaultExterior();
  if (typeof value !== 'object' || value === null) return base;
  const raw = value as Record<string, unknown>;

  const overrides: Exterior['overrides'] = {};
  if (typeof raw.overrides === 'object' && raw.overrides !== null) {
    for (const [wallId, entry] of Object.entries(raw.overrides).slice(0, 400)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const override = entry as Record<string, unknown>;
      const cladding =
        typeof override.cladding === 'string' &&
        (CLADDINGS as readonly string[]).includes(override.cladding)
          ? (override.cladding as Cladding)
          : undefined;
      const colour =
        typeof override.colour === 'string' && /^#[0-9a-f]{6}$/i.test(override.colour)
          ? override.colour
          : undefined;
      if (!cladding && !colour) continue;
      overrides[wallId] = { ...(cladding ? { cladding } : {}), ...(colour ? { colour } : {}) };
    }
  }

  return {
    cladding: oneOf(raw.cladding, CLADDINGS, base.cladding),
    claddingColour: safeColor(raw.claddingColour, base.claddingColour),
    trimColour: safeColor(raw.trimColour, base.trimColour),
    overrides,
  };
}

function safeDormers(value: unknown): Dormer[] {
  if (!Array.isArray(value)) return [];
  const dormers: Dormer[] = [];
  const seen = new Set<string>();

  for (const entry of value.slice(0, 40)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const at = safePoint(raw.at);
    if (!at) continue;

    const id = safeString(raw.id, `dormer${dormers.length + 1}`, 60);
    if (seen.has(id)) continue;
    seen.add(id);

    const width = clamp(raw.width, DORMER_LIMITS.width.min, DORMER_LIMITS.width.max, 1.5);
    const faceHeight = clamp(
      raw.faceHeight,
      DORMER_LIMITS.faceHeight.min,
      DORMER_LIMITS.faceHeight.max,
      1.2,
    );

    let window: Dormer['window'] = null;
    if (typeof raw.window === 'object' && raw.window !== null) {
      const pane = raw.window as Record<string, unknown>;
      // A window can never be wider than the wall it is cut into, nor taller
      // than the face it stands in. Clamping to the dormer rather than to a
      // fixed limit is what keeps that true after the dormer is resized.
      const paneWidth = clamp(pane.width, 0.2, Math.max(0.2, width - 0.3), Math.max(0.2, width - 0.4));
      const paneHeight = clamp(
        pane.height,
        0.2,
        Math.max(0.2, faceHeight - 0.15),
        Math.max(0.2, faceHeight - 0.35),
      );
      window = {
        width: paneWidth,
        height: paneHeight,
        sillHeight: clamp(pane.sillHeight, 0, Math.max(0, faceHeight - paneHeight), 0.15),
      };
    }

    dormers.push({
      id,
      kind: oneOf(raw.kind, ['gable', 'shed', 'hipped'] as const, 'gable'),
      at,
      width,
      faceHeight,
      pitch: clamp(raw.pitch, DORMER_LIMITS.pitch.min, DORMER_LIMITS.pitch.max, 0.5),
      window,
    });
  }

  return dormers;
}

function safeSkylights(value: unknown): Skylight[] {
  if (!Array.isArray(value)) return [];
  const skylights: Skylight[] = [];
  const seen = new Set<string>();

  for (const entry of value.slice(0, 40)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const at = safePoint(raw.at);
    if (!at) continue;

    const id = safeString(raw.id, `skylight${skylights.length + 1}`, 60);
    if (seen.has(id)) continue;
    seen.add(id);

    skylights.push({
      id,
      at,
      width: clamp(raw.width, SKYLIGHT_LIMITS.width.min, SKYLIGHT_LIMITS.width.max, 0.8),
      length: clamp(raw.length, SKYLIGHT_LIMITS.length.min, SKYLIGHT_LIMITS.length.max, 1.2),
      kind: oneOf(raw.kind, ['fixed', 'venting'] as const, 'fixed'),
      // Defaults to laminated, which is the safer of the two permitted by
      // R308.6.2 and the one that stays in its frame when it breaks.
      glazing: oneOf(raw.glazing, ['laminated', 'tempered'] as const, 'laminated'),
      curb: clamp(raw.curb, SKYLIGHT_LIMITS.curb.min, SKYLIGHT_LIMITS.curb.max, 0.15),
    });
  }

  return skylights;
}

/**
 * Validates the roofs.
 *
 * A roof over a storey that no longer exists is dropped for the same reason a
 * stranded staircase is: reassigning it would put somebody's roof over a
 * different part of the house without saying so.
 */
export function safeRoofs(value: unknown, levels: readonly Level[]): Roof[] {
  if (!Array.isArray(value)) return [];
  const levelIds = new Set(levels.map((level) => level.id));
  const roofs: Roof[] = [];
  const seen = new Set<string>();

  for (const entry of value.slice(0, 20)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;

    const overLevelId = typeof raw.overLevelId === 'string' ? raw.overLevelId : '';
    if (!levelIds.has(overLevelId)) continue;

    const id = safeString(raw.id, `roof${roofs.length + 1}`, 60);
    if (seen.has(id)) continue;
    seen.add(id);

    const base = defaultRoofFor(overLevelId, id);
    roofs.push({
      ...base,
      anchorWallId: typeof raw.anchorWallId === 'string' ? raw.anchorWallId : null,
      kind: oneOf(raw.kind, ROOF_KINDS, base.kind),
      pitch: clamp(raw.pitch, ROOF_LIMITS.pitch.min, ROOF_LIMITS.pitch.max, base.pitch),
      overhang: clamp(
        raw.overhang,
        ROOF_LIMITS.overhang.min,
        ROOF_LIMITS.overhang.max,
        base.overhang,
      ),
      gableWallIds: safeIdList(raw.gableWallIds),
      lowWallId: typeof raw.lowWallId === 'string' ? raw.lowWallId : null,
      ventilation: oneOf(raw.ventilation, ['vented', 'unvented'] as const, base.ventilation),
      covering: oneOf(raw.covering, ROOF_COVERINGS, base.covering),
      colour: safeColor(raw.colour, base.colour),
      dormers: safeDormers(raw.dormers),
      skylights: safeSkylights(raw.skylights),
    });
  }

  return roofs;
}

/**
 * Coerces an arbitrary parsed object into a valid DesignDocument.
 *
 * Deliberately forgiving rather than strict: a document saved by an older build
 * should keep whatever it can and quietly gain defaults for the rest, instead
 * of throwing the user's work away. Every field is re-validated because the
 * input may be a hand-edited JSON file.
 */
export function sanitizeDocument(input: unknown): DesignDocument {
  const base = createDefaultDocument();
  if (typeof input !== 'object' || input === null) return base;

  // Older schemas are upgraded before validation, so a v1 autosave keeps the
  // room the user built rather than being discarded as unrecognised.
  const raw = migrateDocument(input as Record<string, unknown>);
  const rawLighting = (raw.lighting ?? {}) as Record<string, unknown>;
  const levels = safeLevels(raw.levels, raw.activeLevelId);

  return {
    schemaVersion: SCHEMA_VERSION,
    name: safeString(raw.name, base.name),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    units: raw.units === 'imperial' ? 'imperial' : 'metric',
    showCeilings: raw.showCeilings === true,
    showRoofs: raw.showRoofs !== false,
    levels: levels.list,
    activeLevelId: levels.activeId,
    stairs: safeStairs(raw.stairs, levels.list),
    roofs: safeRoofs(raw.roofs, levels.list),
    site: safeSite(raw.site),
    exterior: safeExterior(raw.exterior),
    services: [],
    electrical: safeElectrical(raw.electrical, levels.list),
    clearance: safeClearance(raw.clearance),
    currency: safeCurrency(raw.currency),
    lighting: {
      presetId:
        rawLighting.presetId === 'overcast' ||
        rawLighting.presetId === 'evening' ||
        rawLighting.presetId === 'studio'
          ? rawLighting.presetId
          : 'daylight',
      intensity: clamp(rawLighting.intensity, 0.2, 2, base.lighting.intensity),
      shadowsEnabled: rawLighting.shadowsEnabled !== false,
    },
  };
}
