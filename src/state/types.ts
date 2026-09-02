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
 *  2. The world is Y-UP. The floor sits at y = 0 and the ceiling at y = height.
 *     The room is centred on the world origin, so a 4m × 3m room spans
 *     x ∈ [-2, 2] and z ∈ [-1.5, 1.5]. Centring (rather than one corner at the
 *     origin) keeps orbit controls, resizing and future room-rotation sane.
 *
 *  3. This object must stay JSON-serialisable — no class instances, no Three.js
 *     objects, no functions. It is the thing we autosave, export, hand to the AI
 *     advisor and will eventually sync to a server. Anything that cannot survive
 *     `JSON.parse(JSON.stringify(doc))` does not belong in here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Bumped whenever the shape below changes incompatibly; `migrate()` handles old docs. */
export const SCHEMA_VERSION = 1;

/** Which measurement system the UI displays. Storage is always metric. */
export type UnitSystem = 'metric' | 'imperial';

/**
 * The four walls of a rectangular room, named by compass direction.
 *
 * NOTE FOR FUTURE SESSIONS: when arbitrary room shapes arrive, these IDs become
 * one special case of a general edge list. Everything downstream already
 * addresses walls by opaque ID rather than array index, so the migration is
 * contained to `scene/roomGeometry.ts`.
 */
export type WallId = 'north' | 'east' | 'south' | 'west';

export const WALL_IDS: readonly WallId[] = ['north', 'east', 'south', 'west'] as const;

/** Human-facing labels for each wall, used by the UI. */
export const WALL_LABELS: Record<WallId, string> = {
  north: 'North',
  east: 'East',
  south: 'South',
  west: 'West',
};

/** Per-wall appearance. Geometry is derived from the room box, not stored here. */
export interface WallSpec {
  /** Hex colour string, e.g. "#e8e4dc". */
  color: string;
  /**
   * Surface finish, 0 = mirror-smooth, 1 = completely matte.
   * Real interior paint sits around 0.85 (matte) to 0.55 (eggshell/satin).
   */
  roughness: number;
}

/** The floor's surface: a procedural material preset tinted by a colour. */
export interface FloorSpec {
  /** ID of an entry in `scene/materials/presets.ts` — e.g. "oak-plank". */
  presetId: string;
  /** Tint multiplied over the preset's generated texture. White = untinted. */
  color: string;
  /** How large the pattern is, in metres, before it repeats. */
  textureScale: number;
}

/** The ceiling. Kept simple — it is mostly a light bounce surface. */
export interface CeilingSpec {
  color: string;
  /** Hidden by default so the camera can look into the room from above. */
  visible: boolean;
}

/** Lighting mood. Presets drive colour temperature and intensity together. */
export type LightingPresetId = 'daylight' | 'overcast' | 'evening' | 'studio';

export interface LightingSpec {
  presetId: LightingPresetId;
  /** Global multiplier on top of the preset, 0.2–2.0. */
  intensity: number;
  /** Soft shadows look far better but cost frames on weak GPUs. */
  shadowsEnabled: boolean;
}

/** The room shell: dimensions plus the surfaces that enclose it. */
export interface RoomModel {
  /** Interior width along the X axis, in metres. */
  width: number;
  /** Interior depth along the Z axis, in metres. */
  depth: number;
  /** Floor-to-ceiling height along the Y axis, in metres. */
  height: number;
  /** Thickness of the wall slabs, in metres. Visible at door/window openings later. */
  wallThickness: number;

  walls: Record<WallId, WallSpec>;
  floor: FloorSpec;
  ceiling: CeilingSpec;
}

/** The complete, serialisable state of one design. */
export interface DesignDocument {
  schemaVersion: number;
  /** Free-text name shown in the header and used for the export filename. */
  name: string;
  /** ISO timestamp of the last modification. */
  updatedAt: string;

  room: RoomModel;
  lighting: LightingSpec;

  /** Display preference. Does not affect stored values. */
  units: UnitSystem;

  /*
   * FUTURE SESSIONS ADD THEIR STATE HERE, for example:
   *   furniture: FurnitureInstance[];   // session 3
   *   openings: Opening[];              // doors and windows
   *   advisorNotes: AdvisorNote[];      // session 5
   * Adding an optional field is backward-compatible and needs no schema bump.
   */
}

/** Constraints enforced by the UI and by `sanitizeRoom()`. All metres. */
export const ROOM_LIMITS = {
  width: { min: 1.5, max: 20, step: 0.05 },
  depth: { min: 1.5, max: 20, step: 0.05 },
  height: { min: 2.0, max: 6, step: 0.05 },
  wallThickness: { min: 0.05, max: 0.5, step: 0.01 },
} as const;
