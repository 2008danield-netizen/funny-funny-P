/**
 * The document a first-time visitor sees, plus validation for incoming
 * documents (from localStorage or an imported file, neither of which can be
 * trusted to match the current schema).
 */

import {
  SCHEMA_VERSION,
  ROOM_LIMITS,
  WALL_IDS,
  type DesignDocument,
  type RoomModel,
  type WallId,
  type WallSpec,
} from './types';

/** Warm off-white — reads as "freshly painted" rather than clinical white. */
const DEFAULT_WALL_COLOR = '#ece7df';

/** Matte emulsion. Most interior walls are far rougher than people expect. */
const DEFAULT_WALL_ROUGHNESS = 0.88;

function defaultWall(): WallSpec {
  return { color: DEFAULT_WALL_COLOR, roughness: DEFAULT_WALL_ROUGHNESS };
}

/** A 4.2 m × 3.4 m room with a 2.6 m ceiling — a realistic living room. */
export function createDefaultRoom(): RoomModel {
  return {
    width: 4.2,
    depth: 3.4,
    height: 2.6,
    wallThickness: 0.12,
    walls: {
      north: defaultWall(),
      east: defaultWall(),
      south: defaultWall(),
      west: defaultWall(),
    },
    floor: {
      presetId: 'oak-plank',
      color: '#ffffff',
      textureScale: 1.0,
    },
    ceiling: {
      color: '#f7f5f2',
      // Hidden by default: an opaque ceiling blocks the orbit camera's view in
      // from above, which is how people naturally inspect a room plan.
      visible: false,
    },
  };
}

export function createDefaultDocument(): DesignDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Untitled Room',
    updatedAt: new Date().toISOString(),
    room: createDefaultRoom(),
    lighting: {
      presetId: 'daylight',
      intensity: 1,
      shadowsEnabled: true,
    },
    units: 'metric',
  };
}

/** Clamps a number into a range, falling back to `fallback` for NaN/undefined. */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Accepts a value only if it looks like a `#rrggbb` hex colour. */
function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

/**
 * Coerces an arbitrary parsed object into a valid DesignDocument.
 *
 * This is deliberately forgiving rather than strict: a document saved by an
 * older build should keep whatever it can and quietly gain defaults for the
 * rest, instead of throwing the user's work away. Every field is re-validated
 * because the input may be a hand-edited JSON file.
 */
export function sanitizeDocument(input: unknown): DesignDocument {
  const base = createDefaultDocument();
  if (typeof input !== 'object' || input === null) return base;

  const raw = input as Record<string, unknown>;
  const rawRoom = (raw.room ?? {}) as Record<string, unknown>;
  const rawWalls = (rawRoom.walls ?? {}) as Record<string, unknown>;
  const rawFloor = (rawRoom.floor ?? {}) as Record<string, unknown>;
  const rawCeiling = (rawRoom.ceiling ?? {}) as Record<string, unknown>;
  const rawLighting = (raw.lighting ?? {}) as Record<string, unknown>;

  const walls = {} as Record<WallId, WallSpec>;
  for (const id of WALL_IDS) {
    const wall = (rawWalls[id] ?? {}) as Record<string, unknown>;
    walls[id] = {
      color: safeColor(wall.color, DEFAULT_WALL_COLOR),
      roughness: clamp(wall.roughness, 0, 1, DEFAULT_WALL_ROUGHNESS),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 120) : base.name,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    units: raw.units === 'imperial' ? 'imperial' : 'metric',
    room: {
      width: clamp(rawRoom.width, ROOM_LIMITS.width.min, ROOM_LIMITS.width.max, base.room.width),
      depth: clamp(rawRoom.depth, ROOM_LIMITS.depth.min, ROOM_LIMITS.depth.max, base.room.depth),
      height: clamp(rawRoom.height, ROOM_LIMITS.height.min, ROOM_LIMITS.height.max, base.room.height),
      wallThickness: clamp(
        rawRoom.wallThickness,
        ROOM_LIMITS.wallThickness.min,
        ROOM_LIMITS.wallThickness.max,
        base.room.wallThickness,
      ),
      walls,
      floor: {
        // The preset ID is checked against the real registry by the material
        // library, which falls back safely if it no longer exists.
        presetId: typeof rawFloor.presetId === 'string' ? rawFloor.presetId : base.room.floor.presetId,
        color: safeColor(rawFloor.color, base.room.floor.color),
        textureScale: clamp(rawFloor.textureScale, 0.25, 4, base.room.floor.textureScale),
      },
      ceiling: {
        color: safeColor(rawCeiling.color, base.room.ceiling.color),
        visible: rawCeiling.visible === true,
      },
    },
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
