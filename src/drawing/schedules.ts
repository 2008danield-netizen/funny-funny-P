/**
 * The schedules: doors, windows, rooms and fittings.
 *
 * -----------------------------------------------------------------------------
 * WHAT A SCHEDULE IS FOR.
 *
 * A plan shows WHERE things are; a schedule says WHAT they are. Nobody orders
 * doors off a floor plan — they order them off a door schedule, one row per
 * door, with a mark that appears on the plan beside it. Separating the two is
 * what lets a drawing stay readable while the information stays complete.
 *
 * The marks — D1, W3 — are generated here and are stable for a given document:
 * numbered by storey and then by position, so the same door gets the same mark
 * every time the set is exported and two exports of the same design can be
 * compared.
 *
 * -----------------------------------------------------------------------------
 * PRICES CARRY THEIR BASIS.
 *
 * The fittings schedule is the only place in the drawing set with money on it,
 * and every figure is marked as confirmed or estimated — the same rule the
 * shopping list follows. An estimate printed without that mark on a document
 * that looks official is the single most misleading thing this app could do.
 */

import { getOpeningPreset } from '@/scene/openings/presets';
import { findRegions, polygonPerimeter, resolveWalls } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { pointInPolygon } from '@/physics/collision';
import { basisLabel, buildShoppingList } from '@/furniture/pricing';
import type { DesignDocument, Opening } from '@/state/types';

export interface ScheduleFormats {
  length: (metres: number) => string;
  area: (squareMetres: number) => string;
  money: (amount: number) => string;
}

/* --------------------------------- Marks ---------------------------------- */

/** One opening, with the mark that appears beside it on the plan. */
export interface MarkedOpening {
  mark: string;
  levelId: string;
  levelName: string;
  wallId: string;
  opening: Opening;
  /** The rooms on either side, by name, for "serves". */
  serves: string[];
}

/**
 * Every opening in the building, marked.
 *
 * Ordered by storey and then by position across the plan — north to south,
 * then west to east — so the marks run in the order somebody walking the
 * drawing would meet them, rather than in whatever order the walls happen to
 * be stored in.
 */
export function markOpenings(doc: DesignDocument, kind: 'door' | 'window'): MarkedOpening[] {
  const prefix = kind === 'door' ? 'D' : 'W';
  const marked: MarkedOpening[] = [];
  let counter = 0;

  for (const level of doc.levels) {
    const regions = findRegions(level.plan);
    const entries: Array<{ z: number; x: number; item: Omit<MarkedOpening, 'mark'> }> = [];

    for (const segment of resolveWalls(level.plan)) {
      for (const opening of segment.wall.openings) {
        if (opening.kind !== kind) continue;

        const centre = {
          x: segment.start.x + segment.direction.x * opening.offset,
          z: segment.start.z + segment.direction.z * opening.offset,
        };

        // The rooms this opening connects: the ones just off each face.
        const serves: string[] = [];
        for (const side of [1, -1]) {
          const probe = {
            x: centre.x + segment.normal.x * side * (segment.wall.thickness / 2 + 0.25),
            z: centre.z + segment.normal.z * side * (segment.wall.thickness / 2 + 0.25),
          };
          const region = regions.find((entry) => pointInPolygon(probe, entry.polygon));
          const name = region ? resolveRoomSpec(level.plan, region.key).name : 'Outside';
          if (!serves.includes(name)) serves.push(name);
        }

        entries.push({
          z: centre.z,
          x: centre.x,
          item: {
            levelId: level.id,
            levelName: level.name,
            wallId: segment.wall.id,
            opening,
            serves,
          },
        });
      }
    }

    entries.sort((a, b) => a.z - b.z || a.x - b.x);
    for (const entry of entries) {
      counter += 1;
      marked.push({ mark: `${prefix}${counter}`, ...entry.item });
    }
  }

  return marked;
}

/* -------------------------------- Doors ----------------------------------- */

export function doorSchedule(
  doc: DesignDocument,
  formats: ScheduleFormats,
): { headers: string[]; rows: string[][] } {
  const rows = markOpenings(doc, 'door').map((entry) => [
    entry.mark,
    entry.levelName,
    presetLabel(entry.opening.presetId),
    formats.length(entry.opening.width),
    formats.length(entry.opening.height),
    entry.serves.join(' / '),
    entry.opening.presetId === 'door-opening'
      ? 'No leaf'
      : `Hinged ${entry.opening.hinge === 'start' ? 'left' : 'right'}, opens ${
          entry.opening.swing === 'a' ? 'to face A' : 'to face B'
        }`,
  ]);

  return {
    headers: ['Mark', 'Storey', 'Type', 'Width', 'Height', 'Serves', 'Notes'],
    rows,
  };
}

/* ------------------------------- Windows ---------------------------------- */

export function windowSchedule(
  doc: DesignDocument,
  formats: ScheduleFormats,
): { headers: string[]; rows: string[][] } {
  const rows = markOpenings(doc, 'window').map((entry) => [
    entry.mark,
    entry.levelName,
    presetLabel(entry.opening.presetId),
    formats.length(entry.opening.width),
    formats.length(entry.opening.height),
    formats.length(entry.opening.sillHeight),
    formats.area(entry.opening.width * entry.opening.height),
    entry.serves.filter((name) => name !== 'Outside').join(' / ') || 'Outside',
  ]);

  return {
    headers: ['Mark', 'Storey', 'Type', 'Width', 'Height', 'Sill', 'Glazed area', 'Room'],
    rows,
  };
}

/* -------------------------------- Rooms ----------------------------------- */

export function roomSchedule(
  doc: DesignDocument,
  formats: ScheduleFormats,
): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];

  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const spec = resolveRoomSpec(level.plan, region.key);
      rows.push([
        spec.name,
        level.name,
        formats.area(region.area),
        formats.length(polygonPerimeter(region.polygon)),
        formats.length(level.wallHeight),
        spec.floor.presetId,
        spec.wall.color.toUpperCase(),
      ]);
    }
  }

  return {
    headers: ['Room', 'Storey', 'Floor area', 'Perimeter', 'Ceiling', 'Floor finish', 'Wall colour'],
    rows,
  };
}

/* ------------------------------- Fittings --------------------------------- */

/**
 * The fittings schedule, from the same shopping list the app already builds.
 *
 * Reusing it rather than re-deriving means the drawing set and the shopping
 * list can never disagree about what is in the house or what it costs — which
 * they would, eventually, if the same grouping were written twice.
 */
export function fittingSchedule(
  doc: DesignDocument,
  formats: ScheduleFormats,
): { headers: string[]; rows: string[][]; note: string } {
  const list = buildShoppingList(doc, (item) => roomNameOf(doc, item.id));

  const rows = list.lines.map((line) => {
    const entry = line.entry;
    return [
      entry.name,
      entry.series,
      String(line.quantity),
      line.rooms.join(', ') || '—',
      `${round(entry.width)} × ${round(entry.depth)} × ${round(entry.height)} m`,
      line.lineTotal === null ? '—' : formats.money(line.lineTotal),
      basisLabel(line.unitBasis),
    ];
  });

  return {
    headers: ['Product', 'Series', 'Qty', 'Room', 'W × D × H', 'Total', 'Price basis'],
    rows,
    note:
      list.total === null
        ? 'Some pieces have no price at all, so no total is given. Prices in this schedule are estimates written from general knowledge, not quotations, and are not connected to any retailer.'
        : `Total ${formats.money(list.total)} — ${basisLabel(list.basis).toLowerCase()}. Prices are estimates written from general knowledge, not quotations, and are not connected to any retailer. havavamama is not affiliated with, endorsed by, or sponsored by IKEA.`,
  };
}

/* -------------------------------- Helpers --------------------------------- */

function presetLabel(presetId: string): string {
  try {
    return getOpeningPreset(presetId).label;
  } catch {
    return presetId;
  }
}

function round(metres: number): string {
  return (Math.round(metres * 100) / 100).toFixed(2);
}

/** The room a placed piece stands in, by name, or null if it is in none. */
function roomNameOf(doc: DesignDocument, itemId: string): string | null {
  for (const level of doc.levels) {
    const item = level.furniture.find((entry) => entry.id === itemId);
    if (!item) continue;
    for (const region of findRegions(level.plan)) {
      if (pointInPolygon({ x: item.x, z: item.z }, region.polygon)) {
        return resolveRoomSpec(level.plan, region.key).name;
      }
    }
    return null;
  }
  return null;
}
