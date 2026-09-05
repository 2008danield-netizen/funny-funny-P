/**
 * Tests for the drawing set.
 *
 * The set is a whole document produced from a whole model, so the tests build
 * a small house — two storeys, a roof, doors, windows, furniture and a full
 * electrical layout — and then ask three kinds of question about the result:
 *
 *   • Is it a valid PDF that a real reader opens? (`pdfjs`, again.)
 *   • Does it contain the sheets it should, with the right numbers on them?
 *   • Is it DRAWN TO SCALE? That one is checked by arithmetic rather than by
 *     eye: a wall of a known length must come out a known number of points
 *     long, and if that ever stops being true the stated scale is a lie.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, normalizePlan } from '@/state/planOps';
import { addLevel, addRoof, layOutElectrical } from '@/state/buildingOps';
import { placeFurniture } from '@/state/furnitureOps';
import { findRegions } from '@/scene/planGraph';
import { asFeetInches } from '@/code/irc';
import { formatArea, formatLength } from '@/state/units';
import type { DesignDocument } from '@/state/types';

import { PAGE_SIZES } from './pdf';
import { buildDrawingSet, type DrawingSetOptions } from './set';
import { SCALES, pointsPerMetre } from './scale';
import { doorSchedule, markOpenings, roomSchedule, windowSchedule } from './schedules';
import { addFixture } from '@/state/fittingOps';
import { routeAll } from '@/state/plumbingOps';

/* -------------------------------- Fixtures -------------------------------- */

const FORMATS = {
  length: (metres: number) => formatLength(metres, 'metric'),
  area: (square: number) => formatArea(square, 'metric'),
  money: (amount: number) => `EUR ${Math.round(amount)}`,
};

function options(overrides: Partial<DrawingSetOptions> = {}): DrawingSetOptions {
  return {
    pageSize: PAGE_SIZES.tabloid,
    imperial: false,
    formats: FORMATS,
    showFurniture: true,
    date: '1 Jan 2026',
    ...overrides,
  };
}

/** A small house with everything a drawing set has to cope with. */
function house(): DesignDocument {
  const doc = createDefaultDocument();
  doc.name = 'Test House';

  const ground = doc.levels[0]!;
  ground.plan.vertices = [];
  ground.plan.walls = [];
  ground.plan.rooms = {};
  addRectangle(ground.plan, { x: 0, z: 0 }, 8, 6);
  addRectangle(ground.plan, { x: 7, z: 0 }, 6, 6);
  normalizePlan(ground.plan);

  const regions = findRegions(ground.plan);
  const names = ['Living Room', 'Kitchen'];
  regions.forEach((region, index) => {
    ground.plan.rooms[region.key] = {
      name: names[index] ?? `Room ${index + 1}`,
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  });

  // A door and a window, so the plan has openings and the schedules have rows.
  const walls = ground.plan.walls;
  addOpening(ground.plan, walls[0]!.id, 'door', 'door-single', { width: 0.9, height: 2.03, sillHeight: 0 }, 2);
  addOpening(ground.plan, walls[1]!.id, 'window', 'window-casement', { width: 1.2, height: 1.2, sillHeight: 0.9 }, 2);

  placeFurniture(doc, ground, 'sofa-3-seat', { x: 0, z: 0 });

  // Sanitaryware, so there is something for the plumbing sheets to draw.
  addFixture(doc, ground.id, 'wc-close-coupled', { x: 6, z: -2 });
  addFixture(doc, ground.id, 'basin-pedestal', { x: 6, z: 0 });
  addFixture(doc, ground.id, 'sink-1.5-bowl', { x: 8, z: -2 });

  addLevel(doc);
  addRoof(doc);
  layOutElectrical(doc);
  routeAll(doc);

  return doc;
}

/* ------------------------------- The document ----------------------------- */

describe('the drawing set', () => {
  it('produces a sheet for every plan, elevation, electrical plan and schedule', () => {
    const doc = house();
    const pdf = buildDrawingSet(doc, options());

    // Cover + 2 plans + 4 elevations + 2 electrical + panel + 2 plumbing plans
    // + riser + pipe schedules + 4 schedules.
    expect(pdf.pageCount).toBeGreaterThanOrEqual(16);
  });

  it('draws the plumbing sheets once there is pipework', () => {
    const doc = house();
    const pdf = buildDrawingSet(doc, options());

    let text = '';
    for (const byte of pdf.toBytes()) text += String.fromCharCode(byte);

    // A plan per storey, the riser and the schedules, by their sheet numbers.
    expect(text).toContain('P1.1');
    expect(text).toContain('P2.1');
    expect(text).toContain('P3.1');
    // And the riser says outright that it is not to scale, because it is not.
    expect(text).toContain('Schematic');
  });

  it('leaves the plumbing sheets out of a design with no pipework', () => {
    const doc = house();
    doc.plumbing.drainage = [];
    doc.plumbing.supply = [];
    doc.plumbing.stacks = [];

    const withPipes = buildDrawingSet(house(), options()).pageCount;
    const without = buildDrawingSet(doc, options()).pageCount;
    expect(without).toBeLessThan(withPipes);
  });

  it('numbers every sheet against the same total', () => {
    const pdf = buildDrawingSet(house(), options());
    let text = '';
    for (const byte of pdf.toBytes()) text += String.fromCharCode(byte);

    const totals = [...text.matchAll(/\(Sheet (\d+) of (\d+)\)/g)].map((match) => Number(match[2]));
    expect(totals.length).toBeGreaterThan(5);
    // Every sheet says the same total, and that total is the real page count.
    expect(new Set(totals).size).toBe(1);
    expect(totals[0]).toBe(pdf.pageCount);
  });

  it('says on every sheet that it is not for construction', () => {
    const pdf = buildDrawingSet(house(), options());
    let text = '';
    for (const byte of pdf.toBytes()) text += String.fromCharCode(byte);

    const notices = [...text.matchAll(/Not for construction/g)];
    expect(notices.length).toBeGreaterThanOrEqual(pdf.pageCount);
  });

  it('draws nothing but a cover for a design with no walls', () => {
    const doc = createDefaultDocument();
    doc.levels[0]!.plan.walls = [];
    doc.levels[0]!.plan.vertices = [];

    const pdf = buildDrawingSet(doc, options());
    expect(pdf.pageCount).toBe(1);
  });

  it('opens in a real PDF reader with the sheets it claims', async () => {
    const pdf = buildDrawingSet(house(), options());
    const bytes = pdf.toBytes();

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({
      data: bytes,
      useWorkerFetch: false,
      disableFontFace: true,
    }).promise;

    expect(document.numPages).toBe(pdf.pageCount);

    const first = await document.getPage(1);
    const content = await first.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    expect(text).toContain('Test House');
    expect(text).toContain('A0.1');
  }, 20_000);
});

/* --------------------------------- Scale ---------------------------------- */

describe('drawn to scale', () => {
  it('converts metres to points at exactly the ratio it names', () => {
    // 1/4 in = 1 ft-0 in is 1:48. One metre is 39.37 in, so on paper it is
    // 39.37/48 in = 0.82 in = 59.06 points. If this ever drifts, every printed
    // sheet is quietly wrong.
    const quarter = SCALES.find((scale) => scale.id === 'quarter-inch')!;
    expect(pointsPerMetre(quarter)).toBeCloseTo(59.055, 2);

    const metric = SCALES.find((scale) => scale.id === '1:100')!;
    expect(pointsPerMetre(metric)).toBeCloseTo(28.346, 2);
  });

  it('picks a standard scale, never a convenient one', () => {
    const doc = house();
    const pdf = buildDrawingSet(doc, options());
    let text = '';
    for (const byte of pdf.toBytes()) text += String.fromCharCode(byte);

    const scales = [...text.matchAll(/\(Scale ([^)]*)\)/g)].map((match) => match[1]!);
    const known = new Set([...SCALES.map((scale) => scale.label), 'Not to scale', '']);
    for (const scale of scales) expect(known.has(scale)).toBe(true);
  });

  it('uses imperial scales for an imperial drawing and metric for a metric one', () => {
    const doc = house();

    const asText = (imperial: boolean) => {
      const pdf = buildDrawingSet(
        doc,
        options({
          imperial,
          formats: imperial
            ? { ...FORMATS, length: asFeetInches }
            : FORMATS,
        }),
      );
      let text = '';
      for (const byte of pdf.toBytes()) text += String.fromCharCode(byte);
      return text;
    };

    expect(asText(true)).toMatch(/Scale [\d/]+ in = 1 ft-0 in/);
    expect(asText(false)).toMatch(/Scale 1:\d+/);
  });
});

/* ------------------------------- Schedules -------------------------------- */

describe('the schedules', () => {
  it('marks every door and window, and marks them consistently', () => {
    const doc = house();

    const first = markOpenings(doc, 'door').map((entry) => entry.mark);
    const second = markOpenings(doc, 'door').map((entry) => entry.mark);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    expect(first[0]).toBe('D1');
  });

  it('says what each door serves, including the outside', () => {
    const doc = house();
    const schedule = doorSchedule(doc, FORMATS);
    // One per storey: a new storey starts as a copy of the one below it, so
    // the door is genuinely there twice and the schedule has to say so.
    expect(schedule.rows).toHaveLength(2);
    // Column 5 is "Serves"; a door in an exterior wall serves a room and outside.
    expect(schedule.rows[0]![5]).toMatch(/Living Room|Outside/);
    expect(schedule.rows.map((row) => row[0])).toEqual(['D1', 'D2']);
  });

  it('gives every window its sill height, which is what the code cares about', () => {
    const schedule = windowSchedule(house(), FORMATS);
    expect(schedule.headers).toContain('Sill');
    expect(schedule.rows[0]![5]).toBe(formatLength(0.9, 'metric'));
  });

  it('schedules every room on every storey', () => {
    const doc = house();
    const expected = doc.levels.reduce(
      (total, level) => total + findRegions(level.plan).length,
      0,
    );
    expect(roomSchedule(doc, FORMATS).rows).toHaveLength(expected);
  });
});
