/**
 * Laying out the electrical.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS PRODUCES, AND WHAT IT DOES NOT.
 *
 * A first draft that satisfies the NEC's spacing rules, in the places a person
 * would put things. It is the same bargain as the room generator and the wall
 * detector: the app does the tedious part — walking every wall of every room
 * working out where the twelve-foot mark falls — and the user keeps every
 * judgement, because they are the one who knows where the television goes.
 *
 * It is NOT a design. Two things in particular it cannot know:
 *
 *   • WHERE THE FIXTURES ARE. A basin, a countertop and a cooker each have
 *     their own receptacle rules, and this app has no model of any of them yet.
 *     Where the code's requirement depends on one, an outlet is placed on the
 *     most plausible wall and LABELLED as an assumption, and the checks say so
 *     rather than quietly reporting compliance.
 *   • WHAT THE HOUSE IS FOR. A workshop in a garage needs more than a garage
 *     does. The layout gives the code minimum; anything above it is the user's.
 * -----------------------------------------------------------------------------
 *
 * The one rule that shapes everything here is NEC 210.52(A)(1): no point along
 * the floor line of any wall space may be more than 6 ft from a receptacle. The
 * consequence people remember is "outlets every 12 ft", but the corners are
 * what actually catch you — an outlet 6 ft from each end of a 12 ft wall is one
 * outlet in the middle, and a wall 13 ft long needs two.
 */

import { MOUNTING, NEC_OUTLETS } from '@/code/nec';
import { blankSpans, pointOnFace, roomWalls, type RoomWall } from '@/advisor/geometry';
import { findRegions, representativePoint, type Region } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { isHabitable, needsGfci, roomPurpose, type RoomPurpose } from './rooms';
import type {
  DesignDocument,
  DeviceKind,
  ElectricalDevice,
  Level,
  Point2,
} from '@/state/types';

/** How far a device sits off the wall face, so it is not buried in the plaster. */
const OFF_WALL = 0.02;

/** Keep devices this far from a corner, where a box will not fit. */
const CORNER_MARGIN = 0.15;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

/** Starts the numbering again, so a fresh layout is reproducible. */
export function resetDeviceIds(): void {
  counter = 0;
}

/* ------------------------------ Spacing rule ------------------------------ */

/**
 * Where the receptacles go along one unbroken stretch of wall.
 *
 * The rule is about the FURTHEST point from an outlet, not about the gaps, so
 * the arithmetic runs on the span: a stretch of length L needs enough outlets
 * that neither end nor any point between is more than `maxDistance` from one.
 * That is `ceil(L / (2 * maxDistance))` of them, spread evenly — which puts the
 * first and last exactly `L / 2n` from the ends, comfortably inside the limit,
 * rather than jamming them into the corners where no box will fit.
 *
 * A span shorter than the code's minimum wall space needs nothing at all: a
 * 450 mm return beside a door is not somewhere anybody plugs a lamp in.
 */
export function spacingAlong(
  spanLength: number,
  maxDistance = NEC_OUTLETS.maxDistanceAlongWall.metres,
  minSpace = NEC_OUTLETS.minWallSpace.metres,
): number[] {
  if (spanLength < minSpace) return [];

  const count = Math.max(1, Math.ceil(spanLength / (2 * maxDistance)));
  const step = spanLength / count;
  const positions: number[] = [];
  for (let i = 0; i < count; i++) positions.push(step * (i + 0.5));
  return positions;
}

/* -------------------------------- Placing --------------------------------- */

function deviceOnWall(
  wall: RoomWall,
  along: number,
  levelId: string,
  kind: DeviceKind,
  height: number,
  label: string,
  va: number | null = null,
): ElectricalDevice {
  const face = pointOnFace(wall, along);
  return {
    id: nextId('dev'),
    levelId,
    kind,
    at: { x: face.x + wall.inward.x * OFF_WALL, z: face.z + wall.inward.z * OFF_WALL },
    height,
    rotation: wall.seatRotation,
    wallId: wall.wallId,
    circuitId: null,
    va,
    label,
  };
}

/**
 * The wall a switch goes on: beside the door, inside the room.
 *
 * Every electrician's habit and every occupant's expectation. Where a room has
 * several doors the widest one is taken as the way in, and where it has none —
 * an open-plan space — the switch goes at the end of the longest wall, which is
 * the best guess available and one the user can drag in a second.
 */
function switchPosition(walls: readonly RoomWall[]): { wall: RoomWall; along: number } | null {
  let best: { wall: RoomWall; along: number; width: number } | null = null;

  for (const wall of walls) {
    for (const opening of wall.openingSpans) {
      const width = opening.to - opening.from;
      if (best && width <= best.width) continue;

      // A hand's width to the latch side, and inside the room.
      const beside =
        opening.to + 0.35 < wall.length - CORNER_MARGIN
          ? opening.to + 0.35
          : opening.from - 0.35;
      if (beside < CORNER_MARGIN || beside > wall.length - CORNER_MARGIN) continue;

      best = { wall, along: beside, width };
    }
  }

  if (best) return { wall: best.wall, along: best.along };

  const longest = [...walls].sort((a, b) => b.length - a.length)[0];
  return longest ? { wall: longest, along: Math.min(0.4, longest.length / 2) } : null;
}

/* ------------------------------- One room --------------------------------- */

export interface RoomLayout {
  region: Region;
  purpose: RoomPurpose;
  devices: ElectricalDevice[];
  /** Anything the app had to assume, in words, for the user to check. */
  assumptions: string[];
}

/** Lays out one room. */
export function layoutRoom(level: Level, region: Region): RoomLayout {
  const spec = resolveRoomSpec(level.plan, region.key);
  const purpose = roomPurpose(spec.name);
  const walls = roomWalls(level.plan, region);
  const devices: ElectricalDevice[] = [];
  const assumptions: string[] = [];

  const gfci = needsGfci(purpose);
  const receptacleKind: DeviceKind = gfci ? 'receptacle-gfci' : 'receptacle';

  /* ---- Receptacles along the walls ---- */
  const spaced = purpose !== 'hall' && purpose !== 'stairs' && purpose !== 'store';
  if (spaced) {
    for (const wall of walls) {
      for (const span of blankSpans(wall, CORNER_MARGIN, NEC_OUTLETS.minWallSpace.metres)) {
        const length = span.to - span.from;
        for (const offset of spacingAlong(length)) {
          devices.push(
            deviceOnWall(
              wall,
              span.from + offset,
              level.id,
              receptacleKind,
              MOUNTING.receptacle,
              `${spec.name} receptacle`,
            ),
          );
        }
      }
    }
  }

  /* ---- The special receptacles the code asks for by fixture ---- */
  const longest = [...walls].sort((a, b) => b.length - a.length)[0];

  if (purpose === 'kitchen' && longest) {
    // Counter receptacles: 210.52(C)(1) wants one within 24 in of any point
    // along the counter, which is an outlet every 4 ft.
    for (const offset of spacingAlong(longest.length, NEC_OUTLETS.maxCounterDistance.metres)) {
      devices.push(
        deviceOnWall(
          longest,
          offset,
          level.id,
          'receptacle-counter',
          MOUNTING.counterReceptacle,
          'Counter receptacle',
        ),
      );
    }
    assumptions.push(
      'The counter is assumed to run along the longest wall, because the app has no model of your cabinets yet. Move these to where the counter really is.',
    );
  }

  if (purpose === 'bathroom' && longest) {
    devices.push(
      deviceOnWall(
        longest,
        Math.min(longest.length / 2, longest.length - CORNER_MARGIN),
        level.id,
        'receptacle-gfci',
        MOUNTING.counterReceptacle,
        'Basin receptacle',
      ),
    );
    assumptions.push(
      'The basin is assumed to be on the longest wall. NEC 210.52(D) wants a receptacle within 3 ft of its outside edge, so check this one against where the basin actually goes.',
    );
  }

  if (purpose === 'laundry' && longest) {
    devices.push(
      deviceOnWall(longest, longest.length / 2, level.id, 'receptacle-appliance', MOUNTING.receptacle, 'Laundry receptacle'),
    );
  }

  /* ---- Lighting ---- */
  const centre = representativePoint(region.polygon);
  const wantsLight = purpose !== 'store' || region.area > 3;
  if (wantsLight) {
    devices.push({
      id: nextId('dev'),
      levelId: level.id,
      kind: purpose === 'bedroom' || purpose === 'living' ? 'fan' : 'light-ceiling',
      at: centre,
      // Ceiling fittings are described at the ceiling; the renderer hangs them.
      height: level.wallHeight,
      rotation: 0,
      wallId: null,
      circuitId: null,
      va: purpose === 'bedroom' || purpose === 'living' ? 180 : 100,
      label: `${spec.name} light`,
    });
  }

  /* ---- The switch for it ---- */
  const place = switchPosition(walls);
  if (wantsLight && place) {
    devices.push(
      deviceOnWall(place.wall, place.along, level.id, 'switch', MOUNTING.switch, `${spec.name} switch`),
    );
  }

  /* ---- Smoke alarms, which are IRC R314 rather than NEC ---- */
  if (purpose === 'bedroom' || purpose === 'hall') {
    devices.push({
      id: nextId('dev'),
      levelId: level.id,
      kind: 'smoke-alarm',
      at: centre,
      height: level.wallHeight,
      rotation: 0,
      wallId: null,
      circuitId: null,
      va: 5,
      label: `${spec.name} smoke alarm`,
    });
  }

  return { region, purpose, devices, assumptions };
}

/* ----------------------------- The whole house ---------------------------- */

export interface LayoutResult {
  devices: ElectricalDevice[];
  assumptions: string[];
  /** Where the panel was put, if there was anywhere sensible. */
  panelAt: Point2 | null;
  /** Which way it faces, so it sits flat against its wall. */
  panelRotation: number;
  panelLevelId: string | null;
}

/**
 * Lays out every room on every storey.
 *
 * The panel goes in a utility space if there is one — a garage, a laundry, a
 * store — and otherwise on the lowest storey's largest room, which is where a
 * basement panel would be if the app modelled basements properly.
 */
export function layoutElectrical(doc: DesignDocument): LayoutResult {
  resetDeviceIds();

  const devices: ElectricalDevice[] = [];
  const assumptions: string[] = [];
  let panelAt: Point2 | null = null;
  let panelRotation = 0;
  let panelLevelId: string | null = null;
  let panelScore = -1;

  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const layout = layoutRoom(level, region);
      devices.push(...layout.devices);
      for (const note of layout.assumptions) {
        if (!assumptions.includes(note)) assumptions.push(note);
      }

      // Utility spaces first, then whatever is biggest on the lowest floor.
      const utility = layout.purpose === 'garage' || layout.purpose === 'laundry' || layout.purpose === 'store';
      const score =
        (utility ? 1000 : 0) + (level.id === doc.levels[0]?.id ? 100 : 0) + region.area;
      if (score > panelScore) {
        panelScore = score;
        const spot = panelSpot(level, region);
        panelAt = spot.at;
        panelRotation = spot.rotation;
        panelLevelId = level.id;
      }
    }
  }

  if (devices.length === 0) {
    assumptions.push(
      'No enclosed rooms were found, so there was nothing to lay out. Close the walls into rooms first.',
    );
  }

  return { devices, assumptions, panelAt, panelRotation, panelLevelId };
}

/**
 * Where the panel goes in the room chosen for it: flat against a wall.
 *
 * The longest clear stretch of wall, because 110.26 wants a metre of working
 * space in front of a panel and clear wall is the best proxy this app has for
 * that. Falling back to the middle of the room when there is no usable wall is
 * deliberate — a panel drawn somewhere obviously wrong is better than one
 * silently left out of the drawing.
 */
function panelSpot(level: Level, region: Region): { at: Point2; rotation: number } {
  let best: { wall: RoomWall; span: { from: number; to: number }; length: number } | null = null;

  for (const wall of roomWalls(level.plan, region)) {
    for (const span of blankSpans(wall, CORNER_MARGIN, NEC_OUTLETS.minWallSpace.metres)) {
      const length = span.to - span.from;
      if (!best || length > best.length) best = { wall, span, length };
    }
  }

  if (!best) return { at: representativePoint(region.polygon), rotation: 0 };

  const face = pointOnFace(best.wall, (best.span.from + best.span.to) / 2);
  // Half the enclosure's depth off the face, so it hangs on the wall rather
  // than being buried in it.
  const clearance = 0.06;
  return {
    at: {
      x: face.x + best.wall.inward.x * clearance,
      z: face.z + best.wall.inward.z * clearance,
    },
    rotation: best.wall.seatRotation,
  };
}

/** Whether a device kind counts as a receptacle for the spacing rule. */
export function isReceptacle(kind: DeviceKind): boolean {
  return kind.startsWith('receptacle');
}

/** Whether a device is a lighting outlet. */
export function isLighting(kind: DeviceKind): boolean {
  return kind.startsWith('light') || kind === 'fan';
}

export { isHabitable };
