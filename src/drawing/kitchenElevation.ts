/**
 * Kitchen elevations: the drawing a joiner works from.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS SHEET EXISTS.
 *
 * A floor plan says where the cupboards are. It does not say which of them is a
 * drawer, how high the wall units hang, or where the extractor sits — and those
 * are the questions somebody fitting a kitchen asks first. A run elevation
 * answers all three at once, by drawing the run flat on, unit by unit, with
 * every width dimensioned.
 *
 * -----------------------------------------------------------------------------
 * ONE ELEVATION PER RUN, NOT PER WALL.
 *
 * A wall may carry a base run and a wall run at the same time — that is the
 * normal case — and they belong on the same elevation, one above the other,
 * because that is what you see standing in front of them. So the runs are
 * GROUPED by the wall line they share, and each group becomes one drawing.
 *
 * A run that turns a corner is drawn unrolled: the two legs laid out end to
 * end, with the corner marked. That is what every kitchen supplier's drawing
 * does, and the alternative — a foreshortened perspective of the return — is
 * unmeasurable.
 */

import { PdfPage, type Colour } from './pdf';
import { GREY, LIGHT, WEIGHTS, drawDimension, drawWitness } from './sheet';
import { pointsPerMetre, type DrawingScale, type Frame } from './scale';
import { CARCASS, WORKTOP, doorFinish, getModule } from '@/fittings/modules';
import { getFixture } from '@/fittings/fixtures';
import { runLength, runSegments } from '@/building/cabinetRun';
import type { CabinetRun, DesignDocument, Level } from '@/state/types';

const CARCASS_FILL: Colour = [0.96, 0.95, 0.94];
const FILLER_FILL: Colour = [0.86, 0.86, 0.85];

/**
 * The runs that belong on one elevation.
 *
 * Grouped by the line their first segment lies on, to within a few centimetres
 * and a few degrees — which is what "the same wall" means when a base run and
 * the wall run above it were drawn separately.
 */
export interface RunGroup {
  levelId: string;
  levelName: string;
  runs: CabinetRun[];
  /** The longest run in the group, which sets the length of the drawing. */
  length: number;
}

export function groupRuns(doc: DesignDocument): RunGroup[] {
  const groups: RunGroup[] = [];
  const levelNames = new Map(doc.levels.map((level) => [level.id, level.name]));

  for (const run of doc.runs) {
    const segments = runSegments(run.path);
    const first = segments[0];
    if (!first) continue;

    const match = groups.find((group) => {
      if (group.levelId !== run.levelId) return false;
      const other = runSegments(group.runs[0]!.path)[0];
      if (!other) return false;

      // Same direction, and the start points close together across it.
      const parallel =
        Math.abs(first.direction.x * other.direction.x + first.direction.z * other.direction.z) > 0.99;
      if (!parallel) return false;

      const across =
        (first.from.x - other.from.x) * other.normal.x + (first.from.z - other.from.z) * other.normal.z;
      return Math.abs(across) < 0.1;
    });

    if (match) {
      match.runs.push(run);
      match.length = Math.max(match.length, runLength(run.path));
    } else {
      groups.push({
        levelId: run.levelId,
        levelName: levelNames.get(run.levelId) ?? '',
        runs: [run],
        length: runLength(run.path),
      });
    }
  }

  // Base runs first within each group, so the drawing order is bottom-up.
  for (const group of groups) {
    group.runs.sort((a, b) => CARCASS[a.kind].lift - CARCASS[b.kind].lift);
  }

  return groups.filter((group) => group.length > 0.3);
}

export interface KitchenElevationOptions {
  format: (metres: number) => string;
}

/**
 * Draws one run group, flat on.
 *
 * The floor is the datum and the drawing is built up from it, because that is
 * what every height on a kitchen drawing is measured from and what the fitter
 * sets out to.
 */
export function drawRunElevation(
  page: PdfPage,
  group: RunGroup,
  level: Level | null,
  scale: DrawingScale,
  frame: Frame,
  options: KitchenElevationOptions,
): void {
  const perMetre = pointsPerMetre(scale);
  const originX = frame.x + (frame.width - group.length * perMetre) / 2;
  const floorY = frame.y + 60;

  const at = (along: number, height: number) => ({
    x: originX + along * perMetre,
    y: floorY + height * perMetre,
  });

  /* ---- The wall behind it, and the floor line ---- */
  const wallHeight = level?.wallHeight ?? 2.4;
  page.save().lineWidth(WEIGHTS.thin).strokeColour(LIGHT).dash(null);
  page
    .path(
      [at(0, 0), at(group.length, 0), at(group.length, wallHeight), at(0, wallHeight)],
      true,
    )
    .stroke();
  page.restore();

  page.save().lineWidth(WEIGHTS.cut).strokeColour([0, 0, 0]);
  page.line(at(-0.2, 0).x, floorY, at(group.length + 0.2, 0).x, floorY);
  page.restore();

  /* ---- Each run, unit by unit ---- */
  for (const run of group.runs) {
    const carcass = CARCASS[run.kind];
    const finish = doorFinish(run.finishId);
    const top = carcass.lift + carcass.height;

    for (const unit of run.units) {
      const module = getModule(unit.moduleId);
      if (!module) continue;

      /*
       * A corner unit is drawn as the width it presents on THIS leg, not as the
       * path length it consumes — the second leg is a different elevation, and
       * drawing 1.76 m of cupboard on one wall would be wrong by a whole unit.
       */
      const width = module.front === 'corner' ? module.width : unit.width;
      if (unit.offset > group.length + 1e-6) continue;
      const drawn = Math.min(width, group.length - unit.offset);
      if (drawn <= 1e-6) continue;

      page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).dash(null);
      page.fillColour(module.front === 'filler' ? FILLER_FILL : CARCASS_FILL);
      page
        .path(
          [
            at(unit.offset, carcass.lift),
            at(unit.offset + drawn, carcass.lift),
            at(unit.offset + drawn, top),
            at(unit.offset, top),
          ],
          true,
        )
        .fillAndStroke();
      page.restore();

      if (module.front === 'filler') continue;

      /* ---- The fronts, so a drawer reads as a drawer ---- */
      page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY).dash(null);
      for (const line of frontLines(module.front, carcass.height)) {
        const height = carcass.lift + line;
        page.line(at(unit.offset, height).x, at(0, height).y, at(unit.offset + drawn, height).x, at(0, height).y);
      }
      if (module.front === 'double-door') {
        const middle = unit.offset + drawn / 2;
        page.line(at(middle, carcass.lift).x, at(0, carcass.lift).y, at(middle, top).x, at(0, top).y);
      }
      page.restore();

      // What is in it, if anything.
      const label = module.front === 'appliance' ? 'APPL' : '';
      if (label) {
        const centre = at(unit.offset + drawn / 2, carcass.lift + carcass.height / 2);
        page.text(label, centre.x, centre.y, { size: 5, align: 'center', colour: GREY });
      }

      void finish;
    }

    /* ---- The worktop, drawn as the slab it is ---- */
    if (run.kind === 'base' && run.worktop) {
      page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]);
      page.fillColour([0.8, 0.78, 0.74]);
      page
        .path(
          [
            at(0, top),
            at(group.length, top),
            at(group.length, top + WORKTOP.thickness),
            at(0, top + WORKTOP.thickness),
          ],
          true,
        )
        .fillAndStroke();
      page.restore();
    }
  }

  /* ---- The dimension string: every unit width along the bottom ---- */
  const base = group.runs.find((run) => run.kind === 'base') ?? group.runs[0];
  if (base) {
    const stringY = floorY - 26;
    for (const unit of base.units) {
      const module = getModule(unit.moduleId);
      const width = module?.front === 'corner' ? module.width : unit.width;
      const from = at(unit.offset, 0);
      const to = at(Math.min(unit.offset + width, group.length), 0);

      drawWitness(page, { x: from.x, y: floorY }, { x: from.x, y: stringY });
      drawWitness(page, { x: to.x, y: floorY }, { x: to.x, y: stringY });
      drawDimension(page, { x: from.x, y: stringY }, { x: to.x, y: stringY }, width, {
        format: options.format,
        size: 5.5,
      });
    }

    // And the overall, below it.
    const overallY = stringY - 22;
    drawWitness(page, { x: at(0, 0).x, y: floorY }, { x: at(0, 0).x, y: overallY });
    drawWitness(page, { x: at(group.length, 0).x, y: floorY }, { x: at(group.length, 0).x, y: overallY });
    drawDimension(
      page,
      { x: at(0, 0).x, y: overallY },
      { x: at(group.length, 0).x, y: overallY },
      group.length,
      { format: options.format },
    );
  }

  /* ---- Heights up the right-hand side ---- */
  const heights: Array<{ metres: number; label: string }> = [];
  for (const run of group.runs) {
    const carcass = CARCASS[run.kind];
    if (run.kind === 'base') {
      heights.push({ metres: carcass.lift + carcass.height + WORKTOP.thickness, label: 'Worktop' });
    } else {
      heights.push({ metres: carcass.lift, label: 'Underside' });
      heights.push({ metres: carcass.lift + carcass.height, label: 'Top' });
    }
  }

  const heightX = at(group.length, 0).x + 34;
  page.save().lineWidth(WEIGHTS.thin).strokeColour(LIGHT).dash([2, 2]);
  for (const height of heights) {
    const y = at(0, height.metres).y;
    page.line(at(group.length, height.metres).x, y, heightX, y);
    page.text(`${height.label} ${options.format(height.metres)}`, heightX + 3, y - 2, {
      size: 5.5,
      colour: GREY,
    });
  }
  page.restore();

}

/**
 * Names what is built into a run group, for a note under its elevation.
 *
 * Separate from the drawing because the caller owns the sheet layout and knows
 * where there is room for a line of text; returning the words rather than
 * printing them keeps this file about geometry.
 */
export function fittedInto(doc: DesignDocument, group: RunGroup): string[] {
  const units = new Set(group.runs.flatMap((run) => run.units.map((unit) => unit.id)));

  const names: string[] = [];
  for (const fixture of doc.fixtures) {
    if (!fixture.hostUnitId || !units.has(fixture.hostUnitId)) continue;
    const entry = getFixture(fixture.fixtureId);
    if (entry && !names.includes(entry.name)) names.push(entry.name);
  }
  return names;
}

/** Where the horizontal lines fall across a front, up from the carcass bottom. */
function frontLines(front: string, height: number): number[] {
  switch (front) {
    case 'drawers-2':
      return cumulative(height, [0.62]);
    case 'drawers-3':
      return cumulative(height, [0.48, 0.3]);
    case 'drawers-4':
      return cumulative(height, [0.38, 0.26, 0.2]);
    default:
      return [];
  }
}

/** Running totals of the drawer shares, bottom up. */
function cumulative(height: number, shares: readonly number[]): number[] {
  const lines: number[] = [];
  let total = 0;
  for (const share of shares) {
    total += share;
    lines.push(height * total);
  }
  return lines;
}
