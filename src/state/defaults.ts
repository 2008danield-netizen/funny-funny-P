/**
 * The document a first-time visitor sees, plus validation for incoming
 * documents (from localStorage or an imported file, neither of which can be
 * trusted to match the current schema).
 */

import {
  CLEARANCE_DEFAULTS,
  OPENING_LIMITS,
  PLAN_LIMITS,
  SCHEMA_VERSION,
  type DesignDocument,
  type FloorSpec,
  type FurnitureItem,
  type Opening,
  type PlanModel,
  type RoomSpec,
  type Vertex,
  type Wall,
  type WallFaceSpec,
} from './types';
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

export function createDefaultDocument(): DesignDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Untitled Home',
    updatedAt: new Date().toISOString(),
    plan: createDefaultPlan(),
    furniture: [],
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
    currency: 'EUR',
    // Hidden by default: opaque ceilings block the orbit camera's view in from
    // above, which is how people naturally inspect a floor plan.
    showCeilings: false,
    units: 'metric',
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

  return {
    schemaVersion: SCHEMA_VERSION,
    name: safeString(raw.name, base.name),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    units: raw.units === 'imperial' ? 'imperial' : 'metric',
    showCeilings: raw.showCeilings === true,
    plan: safePlan(raw.plan),
    furniture: safeFurniture(raw.furniture),
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
