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
import { getModule } from '@/fittings/modules';
import { getFixture } from '@/fittings/fixtures';
import { runGeometry } from '@/building/cabinetRun';
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

/* ------------------------------- Cabinetry -------------------------------- */

/**
 * The cabinet schedule: what a joiner or a kitchen supplier would order from.
 *
 * Grouped by module, not by unit, because six identical 600 door bases are one
 * line on an order. Fillers are listed too, and separately — they are cut on
 * site from a length of board rather than ordered as units, and a schedule that
 * lists nine fillers as nine products is a schedule that gets nine panels
 * delivered.
 */
export function cabinetSchedule(
  doc: DesignDocument,
  formats: ScheduleFormats,
): { headers: string[]; rows: string[][]; note: string } {
  const grouped = new Map<string, { module: ReturnType<typeof getModule>; count: number; storeys: Set<string> }>();
  let fillerCount = 0;
  let fillerLength = 0;

  const levelNames = new Map(doc.levels.map((level) => [level.id, level.name]));

  for (const run of doc.runs) {
    const storey = levelNames.get(run.levelId) ?? 'Unknown';
    for (const unit of run.units) {
      const module = getModule(unit.moduleId);
      if (!module) continue;

      if (module.front === 'filler') {
        fillerCount += 1;
        fillerLength += unit.width;
        continue;
      }

      const existing = grouped.get(module.id);
      if (existing) {
        existing.count += 1;
        existing.storeys.add(storey);
      } else {
        grouped.set(module.id, { module, count: 1, storeys: new Set([storey]) });
      }
    }
  }

  const rows = [...grouped.values()]
    .sort((a, b) => (b.module?.width ?? 0) - (a.module?.width ?? 0))
    .map((entry) => {
      const module = entry.module!;
      const each = module.price?.amount ?? null;
      return [
        module.label,
        module.kind,
        formats.length(module.width),
        String(entry.count),
        [...entry.storeys].join(', '),
        each === null ? '—' : formats.money(each * entry.count),
      ];
    });

  if (fillerCount > 0) {
    rows.push([
      'Filler panel, cut on site',
      '—',
      formats.length(fillerLength),
      String(fillerCount),
      'total length',
      '—',
    ]);
  }

  const worktopArea = doc.runs.reduce((total, run) => total + runGeometry(run).worktopArea, 0);

  return {
    headers: ['Unit', 'Family', 'Width', 'Qty', 'Storey', 'Total'],
    rows,
    note:
      `Worktop ${worktopArea.toFixed(1)} m², before cut-outs for the sink and the hob. ` +
      'Module widths follow the IKEA METOD series; dimensions and prices here are written from ' +
      'general knowledge, nothing has been checked against a listing, and there is no affiliation ' +
      'with or endorsement by IKEA. Prices are estimates, never quotations.',
  };
}

/* ---------------------- Sanitaryware and appliances ----------------------- */

/**
 * Every fixture, with what it needs connecting to.
 *
 * The services column is the point of this schedule: it is what a plumber and
 * an electrician read, and it is the thing a fixture schedule that only lists
 * sizes fails to tell anybody. Session 11 will size the pipes from the same
 * figures.
 */
export function fixtureSchedule(
  doc: DesignDocument,
  formats: ScheduleFormats,
): { headers: string[]; rows: string[][]; note: string } {
  const levelNames = new Map(doc.levels.map((level) => [level.id, level.name]));
  const rooms = roomIndex(doc);

  const rows = doc.fixtures
    .map((fixture) => {
      const entry = getFixture(fixture.fixtureId);
      if (!entry) return null;

      const services = [
        entry.connections.cold && 'cold',
        entry.connections.hot && 'hot',
        entry.connections.waste ? `${entry.connections.waste} mm waste` : null,
        entry.connections.soil && 'soil',
        entry.connections.va ? `${entry.connections.va.toLocaleString('en-US')} VA` : null,
        entry.connections.dedicatedCircuit && 'own circuit',
      ]
        .filter(Boolean)
        .join(', ');

      return [
        entry.name,
        levelNames.get(fixture.levelId) ?? '—',
        rooms.get(fixture.id) ?? '—',
        `${formats.length(entry.width)} × ${formats.length(entry.depth)}`,
        services || 'none',
        entry.price ? formats.money(fixture.price ?? entry.price.amount) : '—',
        fixture.price === undefined ? 'Estimate' : 'Confirmed',
      ];
    })
    .filter((row): row is string[] => row !== null);

  return {
    headers: ['Fixture', 'Storey', 'Room', 'W × D', 'Services', 'Price', 'Price basis'],
    rows,
    note:
      'Sizes are typical figures written from general knowledge, not measured from any particular ' +
      'product. Check them against what you actually buy — a bathroom is planned to the ' +
      'centimetre, and a bath 50 mm longer than the one scheduled here may not go in.',
  };
}

/** Which room each fixture stands in, by name. */
function roomIndex(doc: DesignDocument): Map<string, string> {
  const index = new Map<string, string>();

  for (const level of doc.levels) {
    const regions = findRegions(level.plan);
    for (const fixture of doc.fixtures) {
      if (fixture.levelId !== level.id) continue;
      const region = regions.find((entry) => pointInPolygon(fixture.at, entry.polygon));
      if (region) index.set(fixture.id, resolveRoomSpec(level.plan, region.key).name);
    }
  }

  return index;
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
