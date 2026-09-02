/**
 * Reading a room: what is in it, and therefore what it is for.
 *
 * The rules need to talk about "the sofa" and "the bed", not about
 * `build.kind === 'cabinet' && doors > 0 && height > 1.8`. This module does
 * that translation once, so a rule can ask for the sofas in a room and get
 * them, and so adding a new wardrobe to the catalogue teaches every rule about
 * it without any of them being edited.
 *
 * Roles are derived from the catalogue entry's own build spec and dimensions
 * rather than from a hand-maintained lookup table of IDs. A 2.36 m tall cabinet
 * with doors is a wardrobe whatever it is called; a 74 cm cabinet nearly two
 * metres wide is a television unit. Deriving it means the catalogue stays the
 * single description of each product and the advisor cannot fall out of step
 * with it.
 */

import { getCatalogEntry, type CatalogEntry } from '@/furniture/catalog';
import { itemFootprint } from '@/physics/colliders';
import { openingCenter, resolveWall, indexVertices, type Region } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { pointInPolygon, type Obb } from '@/physics/collision';
import type { CirculationReport } from '@/clearance/circulation';
import type { DesignDocument, FurnitureItem, Opening, Point2, RoomSpec } from '@/state/types';
import { roomFrame, roomWalls, type RoomFrame, type RoomWall } from './geometry';
import type { RoomProgram } from './types';

/** What a piece of furniture is FOR, as the rules think about it. */
export type FurnitureRole =
  | 'sofa'
  | 'armchair'
  | 'diningChair'
  | 'taskChair'
  | 'coffeeTable'
  | 'sideTable'
  | 'diningTable'
  | 'desk'
  | 'bed'
  | 'wardrobe'
  | 'chest'
  | 'drawerUnit'
  | 'bookcase'
  | 'tvUnit'
  | 'rug'
  | 'floorLamp'
  | 'tableLamp'
  | 'trolley';

/** Roles people sit on and talk to each other from. */
export const SEATING_ROLES: readonly FurnitureRole[] = ['sofa', 'armchair'];

/** Anything that emits light other than the ceiling fitting. */
export const LAMP_ROLES: readonly FurnitureRole[] = ['floorLamp', 'tableLamp'];

/**
 * Classifies a catalogue entry.
 *
 * The discriminators are the physical facts that make the difference in a room,
 * which is why they are dimensions rather than names: a wardrobe is tall enough
 * to hang a coat in, a coffee table is low enough to reach over from a sofa,
 * and a dining chair is a chair with no arms at table height.
 */
export function roleOf(entry: CatalogEntry): FurnitureRole {
  const build = entry.build;

  switch (build.kind) {
    case 'sofa':
      return 'sofa';
    case 'armchair':
      return build.style === 'office' ? 'taskChair' : 'armchair';
    case 'chair':
      return 'diningChair';
    case 'bed':
      return 'bed';
    case 'rug':
      return 'rug';
    case 'desk':
      return 'desk';
    case 'trolley':
      return 'trolley';
    case 'lamp':
      return build.style === 'floor' ? 'floorLamp' : 'tableLamp';
    case 'shelving':
      return 'bookcase';
    case 'table':
      // Dining height is around 74 cm the world over; coffee and side tables
      // sit at 40-50 cm so you can reach over one from a seat.
      if (entry.height >= 0.6) return 'diningTable';
      return entry.width < 0.7 ? 'sideTable' : 'coffeeTable';
    case 'cabinet':
      // Tall enough to hang clothes in.
      if (entry.height >= 1.8) return 'wardrobe';
      // Low, wide and in the living room: a media unit.
      if (entry.height < 0.9 && entry.width >= 1.4) return 'tvUnit';
      // A narrow drawer stack that lives under a desk rather than against a
      // bedroom wall.
      if (entry.category === 'Workspace') return 'drawerUnit';
      return 'chest';
  }
}

/** One placed piece, with everything the rules routinely need to hand. */
export interface PlacedItem {
  item: FurnitureItem;
  entry: CatalogEntry;
  role: FurnitureRole;
  /** Its footprint on the floor. */
  box: Obb;
  /** Footprint area in square metres. */
  area: number;
}

export function describeItem(item: FurnitureItem): PlacedItem {
  const entry = getCatalogEntry(item.catalogId);
  const box = itemFootprint(item);
  return {
    item,
    entry,
    role: roleOf(entry),
    box,
    area: box.halfWidth * box.halfDepth * 4,
  };
}

/** An opening, resolved into the room it opens onto. */
export interface RoomOpening {
  opening: Opening;
  wall: RoomWall;
  /** World position of the opening's centre, on the wall centreline. */
  at: Point2;
}

/** Everything one room is and contains. Built once per report, per room. */
export interface RoomContext {
  doc: DesignDocument;
  region: Region;
  spec: RoomSpec;
  walls: RoomWall[];
  frame: RoomFrame;
  program: RoomProgram;
  items: PlacedItem[];
  /** Floor area in square metres. */
  area: number;
  /** Furniture footprint over floor area, 0-1. Rugs excluded — they are floor. */
  density: number;
  windows: RoomOpening[];
  doors: RoomOpening[];
  circulation: CirculationReport | undefined;
}

/** All items of one role, largest first. */
export function ofRole(context: RoomContext, ...roles: FurnitureRole[]): PlacedItem[] {
  const wanted = new Set(roles);
  return context.items
    .filter((placed) => wanted.has(placed.role))
    .sort((a, b) => b.area - a.area);
}

/** The single biggest item of a role, or null. */
export function largestOfRole(context: RoomContext, ...roles: FurnitureRole[]): PlacedItem | null {
  return ofRole(context, ...roles)[0] ?? null;
}

/**
 * What a room is for, from what stands in it.
 *
 * The precedence order matters in open-plan and studio flats, where a room
 * legitimately has a bed AND a sofa AND a dining table. A bed wins because it
 * is the constraint everything else works around: you can put a sofa anywhere,
 * but there is exactly one good wall for a bed and the rest of the layout
 * follows from it.
 */
export function inferProgram(items: readonly PlacedItem[]): RoomProgram {
  const roles = new Set(items.map((placed) => placed.role));

  if (roles.has('bed')) return 'bedroom';
  if (roles.has('sofa')) return 'living';

  const chairs = items.filter((placed) => placed.role === 'diningChair').length;
  if (roles.has('diningTable') && chairs >= 2) return 'dining';

  if (roles.has('desk')) return 'office';
  // A room with only a table and no chairs is more likely a dining room in
  // progress than anything else.
  if (roles.has('diningTable')) return 'dining';
  if (roles.has('armchair') || roles.has('coffeeTable') || roles.has('tvUnit')) return 'living';

  return 'unknown';
}

/** A readable name for a program, for use in a sentence. */
export function programLabel(program: RoomProgram): string {
  switch (program) {
    case 'living':
      return 'living room';
    case 'bedroom':
      return 'bedroom';
    case 'dining':
      return 'dining room';
    case 'office':
      return 'workspace';
    case 'unknown':
      return 'room';
  }
}

/**
 * Assembles the context for every room in a design.
 *
 * `circulationByRoom` is passed in rather than computed here: the clearance
 * report has already paid for that grid walk, and running it twice on every
 * drag frame would be the most expensive mistake in the app.
 */
export function readRooms(
  doc: DesignDocument,
  regions: readonly Region[],
  circulationByRoom: ReadonlyMap<string, CirculationReport>,
): RoomContext[] {
  const vertices = indexVertices(doc.plan);
  const described = doc.furniture.map(describeItem);

  return regions.map((region) => {
    const items = described.filter((placed) =>
      pointInPolygon({ x: placed.item.x, z: placed.item.z }, region.polygon),
    );

    const walls = roomWalls(doc.plan, region);
    const windows: RoomOpening[] = [];
    const doors: RoomOpening[] = [];

    for (const wall of walls) {
      const segment = resolveWall(wall.segment.wall, vertices);
      if (!segment) continue;
      for (const opening of wall.segment.wall.openings) {
        const entry = { opening, wall, at: openingCenter(segment, opening) };
        if (opening.kind === 'window') windows.push(entry);
        else doors.push(entry);
      }
    }

    // Rugs lie on the floor rather than occupying it, so counting them towards
    // density would make a well-dressed room look overstuffed.
    const occupied = items
      .filter((placed) => placed.role !== 'rug')
      .reduce((total, placed) => total + placed.area, 0);

    return {
      doc,
      region,
      spec: resolveRoomSpec(doc.plan, region.key),
      walls,
      frame: roomFrame(doc.plan, region),
      program: inferProgram(items),
      items,
      area: region.area,
      density: region.area > 0 ? occupied / region.area : 0,
      windows,
      doors,
      circulation: circulationByRoom.get(region.key),
    };
  });
}
