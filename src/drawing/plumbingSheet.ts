/**
 * The plumbing plan, the riser diagram, and the pipe schedules.
 *
 * -----------------------------------------------------------------------------
 * TWO DRAWINGS, BECAUSE A PLAN CANNOT SHOW A FALL.
 *
 * A plumbing PLAN says where the pipes are: which wall the stack is in, where
 * each branch runs, where the drain leaves the building. It is what you set out
 * from on site, and it is drawn to scale.
 *
 * A RISER DIAGRAM says what connects to what and at what size, drawn as a
 * schematic with no scale at all. It exists because the thing an inspector
 * checks — is every trap vented, is the stack big enough for what is on it —
 * is a question about topology, and on a plan of a two-storey house the answer
 * is spread over two sheets with the important part hidden inside a wall.
 *
 * Every real set has both. Drawing only the plan would be drawing the half that
 * is easier.
 *
 * -----------------------------------------------------------------------------
 * WHY THE RISER IS NOT DRAWN TO SCALE.
 *
 * Deliberately, and it is worth saying so on the sheet. A riser drawn to scale
 * puts the whole first floor's pipework in the top eighth of the page and makes
 * the branch lengths — which matter — unreadable. Schematic spacing gives every
 * connection room to be labelled. The sizes and the fixture units on it are
 * real; the geometry is not, and the note says as much.
 */

import { PdfPage, type Colour } from './pdf';
import { GREY, LIGHT, WEIGHTS, drawTable, type Column } from './sheet';
import type { Frame, Projector } from './scale';
import { resolveWalls } from '@/scene/planGraph';
import { getFixture } from '@/fittings/fixtures';
import { DRAINAGE_LOADS, SUPPLY_LOADS } from '@/code/ipc';
import { elevationOf } from '@/state/levels';
import type { SizedRun, SizedSupplyRun } from '@/services/plumbingSize';
import type { DesignDocument, Level, PipeSystem } from '@/state/types';

const GHOST: Colour = [0.62, 0.62, 0.62];

/* The two code tables, keyed the way the catalogue keys its fixtures. */
const DRAINAGE = new Map(Object.entries(DRAINAGE_LOADS));
const SUPPLY = new Map(Object.entries(SUPPLY_LOADS));

/**
 * How each system is drawn in ink.
 *
 * Line style rather than colour does the work, because a set of drawings is
 * still routinely printed in black and white and a colour-coded plan that
 * photocopies into six identical greys is useless. Colour is a second cue on
 * top, not the only one.
 */
const STYLE: Record<PipeSystem, { colour: Colour; dash: number[] | null; label: string }> = {
  soil: { colour: [0.15, 0.13, 0.11], dash: null, label: 'Soil' },
  waste: { colour: [0.3, 0.36, 0.33], dash: null, label: 'Waste' },
  vent: { colour: [0.45, 0.48, 0.5], dash: [4, 3], label: 'Vent' },
  cold: { colour: [0.14, 0.4, 0.6], dash: [1.5, 2.5], label: 'Cold' },
  hot: { colour: [0.65, 0.2, 0.16], dash: [5, 2, 1.5, 2], label: 'Hot' },
  'hot-return': { colour: [0.72, 0.42, 0.32], dash: [2, 2], label: 'Hot return' },
};

/* --------------------------------- The plan ------------------------------- */

/** The walls, ghosted, so the pipework has something to sit on. */
export function drawGhostPlan(page: PdfPage, level: Level, projector: Projector): void {
  page.save().lineWidth(WEIGHTS.object).strokeColour(GHOST).dash(null);

  for (const segment of resolveWalls(level.plan)) {
    const half = segment.wall.thickness / 2;
    const corner = (along: number, side: number) =>
      projector.at({
        x: segment.start.x + segment.direction.x * along + segment.normal.x * half * side,
        z: segment.start.z + segment.direction.z * along + segment.normal.z * half * side,
      });
    page
      .path(
        [corner(0, 1), corner(segment.length, 1), corner(segment.length, -1), corner(0, -1)],
        true,
      )
      .stroke();
  }

  page.restore();
}

/**
 * Every pipe that passes through this storey, with its size written on it.
 *
 * A run is drawn here if any of its points is on this level, which is what
 * makes a stack appear on every floor it passes through rather than only the
 * one it nominally belongs to.
 */
export function drawPipes(
  page: PdfPage,
  runs: ReadonlyArray<{ run: { id: string; system: PipeSystem; points: readonly { levelId: string; at: { x: number; z: number } }[] }; label: string }>,
  levelId: string,
  projector: Projector,
): void {
  for (const entry of runs) {
    const points = entry.run.points.filter((point) => point.levelId === levelId);
    if (points.length < 2) continue;

    const style = STYLE[entry.run.system];
    page.save().lineWidth(WEIGHTS.object).strokeColour(style.colour).dash(style.dash);
    page.path(points.map((point) => projector.at(point.at))).stroke();
    page.restore();

    // The size, written along the run at its midpoint — which is where a
    // plumber looks for it, and where it does not collide with a fitting.
    const middle = points[Math.floor(points.length / 2)];
    const before = points[Math.max(0, Math.floor(points.length / 2) - 1)];
    if (!middle || !before) continue;

    const at = projector.at({
      x: (middle.at.x + before.at.x) / 2,
      z: (middle.at.z + before.at.z) / 2,
    });
    page.text(entry.label, at.x + 3, at.y + 2, { size: 4.6, colour: GREY });
  }
}

/** The stack, the heater and the fixtures' traps, as plan symbols. */
export function drawPlumbingFittings(
  page: PdfPage,
  doc: DesignDocument,
  levelId: string,
  projector: Projector,
): void {
  /* ---- The stack: a circle with a cross, the standard symbol ---- */
  for (const stack of doc.plumbing.stacks) {
    const at = projector.at(stack.at);
    page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
    page.circle(at.x, at.y, 5).stroke();
    page.line(at.x - 3.5, at.y - 3.5, at.x + 3.5, at.y + 3.5);
    page.line(at.x - 3.5, at.y + 3.5, at.x + 3.5, at.y - 3.5);
    page.restore();
    page.text('SVP', at.x + 8, at.y - 2, { size: 5, font: 'helvetica-bold' });
  }

  /* ---- The heater ---- */
  const heater = doc.plumbing.heater;
  if (heater && heater.levelId === levelId) {
    const at = projector.at(heater.at);
    page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);
    page.circle(at.x, at.y, 7).stroke();
    page.restore();
    page.text('WH', at.x, at.y - 2, { size: 5, align: 'center', font: 'helvetica-bold' });
  }

  /* ---- Each trap, as a small open circle ---- */
  page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash(null);
  for (const connection of doc.plumbing.connections) {
    const fixture = doc.fixtures.find((candidate) => candidate.id === connection.fixtureId);
    if (!fixture || fixture.levelId !== levelId) continue;
    const at = projector.at(connection.trapAt);
    page.circle(at.x, at.y, 2.4).stroke();
  }
  page.restore();
}

/**
 * The legend, listing only the systems this sheet actually draws.
 *
 * Same rule as the electrical legend: a legend of everything the app can draw
 * teaches the reader to skip it.
 */
export function drawPlumbingLegend(
  page: PdfPage,
  used: ReadonlySet<PipeSystem>,
  x: number,
  y: number,
): number {
  const entries = (Object.keys(STYLE) as PipeSystem[]).filter((system) => used.has(system));
  if (entries.length === 0) return y;

  page.text('LEGEND', x, y, { size: 8, font: 'helvetica-bold' });
  let cursor = y - 14;

  for (const system of entries) {
    const style = STYLE[system];
    page.save().lineWidth(WEIGHTS.object).strokeColour(style.colour).dash(style.dash);
    page.line(x, cursor + 2.5, x + 16, cursor + 2.5);
    page.restore();
    page.text(style.label, x + 22, cursor, { size: 6.8 });
    cursor -= 12;
  }

  page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
  page.circle(x + 6, cursor + 2.5, 4).stroke();
  page.line(x + 3.2, cursor - 0.3, x + 8.8, cursor + 5.3);
  page.line(x + 3.2, cursor + 5.3, x + 8.8, cursor - 0.3);
  page.restore();
  page.text('Soil and vent stack', x + 22, cursor, { size: 6.8 });
  cursor -= 12;

  return cursor;
}

/* ------------------------------ Riser diagram ----------------------------- */

/**
 * The drainage riser: what joins what, and at what size.
 *
 * Laid out by TOPOLOGY rather than by geometry. The stack is a vertical spine
 * down the middle; each storey gets a horizontal band at its real elevation
 * (that much is to scale, because it is what makes a riser readable); and the
 * branches on each storey are spread evenly along their band, ordered as they
 * come, regardless of where they actually are in plan.
 *
 * Spreading them evenly is the whole trick. It is the difference between a
 * diagram where every connection can be labelled and one where three branches
 * arrive at the same point on the stack and their labels overprint.
 */
export function drawRiserDiagram(
  page: PdfPage,
  doc: DesignDocument,
  sized: readonly SizedRun[],
  frame: Frame,
): void {
  const stack = doc.plumbing.stacks[0];
  if (!stack) {
    page.text('No stack has been routed.', frame.x, frame.y + frame.height - 40, { size: 8 });
    return;
  }

  /* ---- Vertical scale: fit the whole building into the frame ---- */
  const top = doc.levels.reduce(
    (highest, level) => Math.max(highest, elevationOf(doc, level.id) + level.wallHeight),
    0,
  );
  const bottom = -1.5;
  const usable = frame.height - 90;
  const perMetre = usable / Math.max(1, top - bottom + 1.5);

  const spineX = frame.x + frame.width * 0.62;
  const atHeight = (metres: number) => frame.y + 46 + (metres - bottom) * perMetre;

  /* ---- Each storey's datum line ---- */
  page.save().lineWidth(WEIGHTS.thin).strokeColour(LIGHT).dash([3, 3]);
  for (const level of doc.levels) {
    const y = atHeight(elevationOf(doc, level.id));
    page.line(frame.x, y, frame.x + frame.width, y);
    page.text(level.name, frame.x + 2, y + 3, { size: 5.5, colour: GREY });
  }
  page.restore();

  /* ---- The stack, drawn full height with its vent above the roof ---- */
  const stackRuns = sized.filter((entry) => entry.role === 'stack' || entry.role === 'vent');
  const stackSize = sized.find((entry) => entry.role === 'stack');
  const ventTop = Math.max(
    top + 0.5,
    ...stackRuns.flatMap((entry) =>
      entry.run.points.map((point) => elevationOf(doc, point.levelId) + point.height),
    ),
  );

  page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
  page.line(spineX, atHeight(bottom + 0.6), spineX, atHeight(top));
  page.restore();

  // The vent continues above, dashed, because it carries air not water.
  page.save().lineWidth(WEIGHTS.object).strokeColour(STYLE.vent.colour).dash(STYLE.vent.dash);
  page.line(spineX, atHeight(top), spineX, atHeight(ventTop));
  page.restore();

  page.text('VENT THROUGH ROOF', spineX + 6, atHeight(ventTop) - 3, {
    size: 5.5,
    font: 'helvetica-bold',
  });
  if (stackSize) {
    page.text(`${stackSize.size.asWritten} STACK`, spineX + 6, atHeight(top * 0.6), {
      size: 5.5,
      font: 'helvetica-bold',
    });
  }

  /* ---- The branches, spread along each storey's band ---- */
  const byLevel = new Map<string, SizedRun[]>();
  for (const entry of sized) {
    if (entry.role !== 'branch') continue;
    const levelId = entry.run.points[0]?.levelId;
    if (!levelId) continue;
    const list = byLevel.get(levelId) ?? [];
    list.push(entry);
    byLevel.set(levelId, list);
  }

  for (const [levelId, branches] of byLevel) {
    const base = elevationOf(doc, levelId);
    // Spread them up the storey rather than all at floor level, so labels have
    // room. The heights are schematic; the note on the sheet says so.
    const span = Math.min(1.6, (doc.levels.find((l) => l.id === levelId)?.wallHeight ?? 2.4) * 0.7);

    branches.forEach((entry, index) => {
      const y = atHeight(base + 0.25 + (span * index) / Math.max(1, branches.length));
      const x = frame.x + 60;

      const style = STYLE[entry.run.system];
      page.save().lineWidth(WEIGHTS.object).strokeColour(style.colour).dash(style.dash);
      page.line(x, y, spineX, y);
      page.restore();

      // The trap, at the far end.
      page.save().lineWidth(WEIGHTS.thin).strokeColour([0, 0, 0]).dash(null);
      page.circle(x, y, 2.6).stroke();
      page.restore();

      const name = entry.run.serves
        .map((fixtureId) => {
          const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
          return fixture ? getFixture(fixture.fixtureId)?.name : null;
        })
        .filter(Boolean)
        .join(', ');

      page.text(name || 'Branch', x - 6, y - 2, { size: 5, align: 'right' });
      page.text(
        `${entry.size.asWritten}  ${entry.dfu} DFU`,
        (x + spineX) / 2,
        y + 2.5,
        { size: 4.6, align: 'center', colour: GREY },
      );
    });
  }

  /* ---- The building drain, out to the sewer ---- */
  const drain = sized.find((entry) => entry.role === 'building-drain');
  if (drain) {
    const y = atHeight(bottom + 0.6);
    page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]).dash(null);
    page.line(spineX, y, frame.x + frame.width - 40, y);
    page.restore();

    page.text(
      `${drain.size.asWritten} building drain, ${drain.dfu} DFU, fall 1 in ${
        drain.slope ? (1 / drain.slope).toFixed(0) : '—'
      }`,
      spineX + 6,
      y + 4,
      { size: 5.2 },
    );
    page.text('TO SEWER', frame.x + frame.width - 38, y - 2, {
      size: 5.5,
      font: 'helvetica-bold',
    });
  }

  page.text(
    'Schematic. Vertical positions are to scale; horizontal positions are not — branch lengths on this diagram do not represent real runs. See the plan for those.',
    frame.x,
    frame.y + 18,
    { size: 5.5, colour: GREY },
  );
}

/* -------------------------------- Schedules ------------------------------- */

/** The drainage schedule: every run, its load, its size and its fall. */
export function drawDrainageSchedule(
  page: PdfPage,
  doc: DesignDocument,
  sized: readonly SizedRun[],
  x: number,
  y: number,
  frame: Frame,
  makePage: () => PdfPage,
): { page: PdfPage; y: number } {
  const columns: Column[] = [
    { header: 'Ref', width: 30 },
    { header: 'Serves', width: 128 },
    { header: 'Type', width: 62 },
    { header: 'Size', width: 44, align: 'right' },
    { header: 'DFU', width: 32, align: 'right' },
    { header: 'Fall', width: 50, align: 'right' },
  ];

  const body = sized.map((entry, index) => [
    `D${index + 1}`,
    servedBy(doc, entry.run.serves) ||
      (entry.role === 'building-drain'
        ? 'Whole building'
        : entry.role === 'stack'
          ? 'All storeys'
          : '—'),
    entry.role === 'building-drain'
      ? 'Building drain'
      : entry.role === 'stack'
        ? 'Stack'
        : entry.role === 'vent'
          ? 'Vent'
          : 'Branch',
    entry.size.asWritten,
    entry.role === 'vent' ? '—' : `${entry.dfu}`,
    entry.slope !== null && entry.horizontalLength > 0.05
      ? `1 in ${(1 / entry.slope).toFixed(0)}`
      : '—',
  ]);

  return drawTable(page, columns, body, x, y, {
    bottom: frame.y + 10,
    onOverflow: () => ({ page: makePage(), y: frame.y + frame.height - 20 }),
  });
}

/** The supply schedule: every run, its WSFU and its size. */
export function drawSupplySchedule(
  page: PdfPage,
  doc: DesignDocument,
  sized: readonly SizedSupplyRun[],
  x: number,
  y: number,
  frame: Frame,
  makePage: () => PdfPage,
): { page: PdfPage; y: number } {
  const columns: Column[] = [
    { header: 'Ref', width: 30 },
    { header: 'System', width: 54 },
    { header: 'Serves', width: 136 },
    { header: 'Size', width: 44, align: 'right' },
    { header: 'WSFU', width: 40, align: 'right' },
    { header: 'Length', width: 42, align: 'right' },
  ];

  const body = sized.map((entry, index) => [
    `W${index + 1}`,
    STYLE[entry.run.system].label,
    servedBy(doc, entry.run.serves) || 'Trunk',
    entry.size.asWritten,
    entry.wsfu.toFixed(1),
    `${entry.developedLength.toFixed(1)} m`,
  ]);

  return drawTable(page, columns, body, x, y, {
    bottom: frame.y + 10,
    onOverflow: () => ({ page: makePage(), y: frame.y + frame.height - 20 }),
  });
}

/**
 * The fixture-unit schedule: what each fixture contributes, both ways.
 *
 * Drainage and supply side by side on purpose. They are the two currencies of
 * the whole discipline, they are constantly confused, and putting a WC's 3 DFU
 * next to its 2.2 WSFU on the same row is the clearest possible statement that
 * they are different numbers measuring different things.
 */
export function drawFixtureUnitSchedule(
  page: PdfPage,
  doc: DesignDocument,
  x: number,
  y: number,
  frame: Frame,
  makePage: () => PdfPage,
): { page: PdfPage; y: number } {
  const columns: Column[] = [
    { header: 'Fixture', width: 132 },
    { header: 'As the code names it', width: 152 },
    { header: 'DFU', width: 34, align: 'right' },
    { header: 'Trap', width: 44, align: 'right' },
    { header: 'WSFU', width: 40, align: 'right' },
  ];

  /*
   * Grouped by catalogue entry. A schedule listing "Lavatory" six separate
   * times is a schedule nobody totals correctly, and the DFU column is there
   * precisely to be totalled.
   */
  const counts = new Map<string, number>();
  for (const fixture of doc.fixtures) {
    counts.set(fixture.fixtureId, (counts.get(fixture.fixtureId) ?? 0) + 1);
  }

  const body: string[][] = [];
  for (const [fixtureId, count] of counts) {
    const entry = getFixture(fixtureId);
    if (!entry) continue;

    const drainage = DRAINAGE.get(entry.kind);
    const supply = SUPPLY.get(entry.kind);
    if (!drainage && !supply) continue;

    body.push([
      count > 1 ? `${entry.name} × ${count}` : entry.name,
      drainage?.codeName ?? supply?.codeName ?? '—',
      drainage ? `${drainage.dfu * count}` : '—',
      drainage ? drainage.trapAsWritten : '—',
      supply ? (supply.total * count).toFixed(1) : '—',
    ]);
  }

  return drawTable(page, columns, body, x, y, {
    bottom: frame.y + 10,
    onOverflow: () => ({ page: makePage(), y: frame.y + frame.height - 20 }),
  });
}

/** The fixtures a run serves, named, for a schedule row. */
function servedBy(doc: DesignDocument, serves: readonly string[]): string {
  return serves
    .map((fixtureId) => {
      const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
      return fixture ? getFixture(fixture.fixtureId)?.name : null;
    })
    .filter(Boolean)
    .join(', ');
}
