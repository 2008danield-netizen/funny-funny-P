/**
 * The drawing set: everything, assembled into one printable PDF.
 *
 * -----------------------------------------------------------------------------
 * WHAT COMES OUT.
 *
 *   A0.1   Cover — what the set is, what is in it, and what it does not claim.
 *   A1.n   Floor plan, one per storey, dimensioned.
 *   A2.n   Elevation, one per side.
 *   E1.n   Electrical plan, one per storey, with its legend.
 *   E2.1   Panel schedule and the Article 220 service calculation.
 *   A3.n   Schedules: doors, windows, rooms, fittings.
 *
 * -----------------------------------------------------------------------------
 * TWO PASSES, AND WHY.
 *
 * Every sheet says "sheet 3 of 11", which cannot be written until the set is
 * known — and the set depends on how many storeys there are, whether there is a
 * roof, and whether the schedules overflow onto extra sheets. So the sheets are
 * PLANNED first as a list of descriptors, counted, and only then drawn. The
 * alternative, patching the numbers afterwards, means the page content is no
 * longer what the drawing code produced, and that is exactly the sort of seam
 * where a "3 of 11" ends up on a set of nine.
 *
 * Schedule overflow is handled by letting a schedule ask for another sheet
 * while it is drawing. That makes the total unknowable until every sheet has
 * been drawn, so NO title block is drawn during the drawing pass at all: each
 * one is queued and they are all filled in together at the end, when the count
 * is final. Anything else puts "of 11" on some sheets of a set of 12.
 */

import { PdfWriter, landscape, type PageSize, type PdfPage } from './pdf';
import {
  drawNorthPoint,
  drawParagraph,
  drawScaleBar,
  drawSheet,
  drawTable,
  frameOf,
  GREY,
  WEIGHTS,
  type Column,
  type TitleBlock,
} from './sheet';
import {
  boundsOf,
  fitScale,
  pointsPerMetre,
  projectorFor,
  type DrawingScale,
  type Projector,
} from './scale';
import { drawFloorPlan, planExtent } from './floorPlan';
import { SIDES, drawElevation, elevationExtent, type Side } from './elevation';
import { drawRunElevation, fittedInto, groupRuns, type RunGroup } from './kitchenElevation';
import {
  drawDevices,
  drawGhostPlan,
  drawLegend,
  drawLoadCalculation,
  drawPanelSchedule,
} from './electricalSheet';
import {
  drawDrainageSchedule,
  drawFixtureUnitSchedule,
  drawGhostPlan as drawPlumbingGhostPlan,
  drawPipes,
  drawPlumbingFittings,
  drawPlumbingLegend,
  drawRiserDiagram,
  drawSupplySchedule,
} from './plumbingSheet';
import {
  drawDucts,
  drawDuctSchedule,
  drawEquipmentSchedule,
  drawHvacFittings,
  drawHvacLegend,
  drawLoadSchedule,
} from './hvacSheet';
import { deriveHvac } from '@/state/hvacOps';
import { buildSection } from '@/building/section';
import { drawSection, drawSectionNotes } from './sectionSheet';
import { registerAirflows, roomAirflows, sizeAllDucts } from '@/services/ductSize';
import { plumbingTotals, sizeAllDrainage, sizeAllSupply } from '@/services/plumbingSize';
import { checkPlumbing } from '@/services/plumbingCheck';
import { IPC_DISCLAIMER } from '@/code/ipc';
import {
  cabinetSchedule,
  doorSchedule,
  fittingSchedule,
  markOpenings,
  fixtureSchedule,
  roomSchedule,
  windowSchedule,
  type ScheduleFormats,
} from './schedules';
import { calculateLoad, panelSchedule } from '@/services/circuits';
import { checkElectrical } from '@/services/necCheck';
import { findRegions, totalFloorArea } from '@/scene/planGraph';
import { buildingHeight } from '@/state/levels';
import { compassPoint } from '@/building/site';
import type { DesignDocument, DeviceKind, Level, SectionCut } from '@/state/types';

export interface DrawingSetOptions {
  /** The sheet the set is printed on. */
  pageSize: PageSize;
  /** Whether the drawing scales are imperial or metric. */
  imperial: boolean;
  formats: ScheduleFormats;
  /** Draw the furniture on the floor plans. */
  showFurniture: boolean;
  /** ISO date the set is issued. */
  date: string;
}

/** What a sheet is, before it is drawn. */
interface SheetPlan {
  number: string;
  title: string;
  /**
   * Draws the sheet's content.
   *
   * `queue` is how a sheet that spills onto another one registers that sheet's
   * title block: it cannot be drawn yet, because the total is not known until
   * every sheet has finished.
   */
  draw: (
    page: PdfPage,
    block: TitleBlock,
    scaleLabel: (label: string) => void,
    queue: (page: PdfPage, block: TitleBlock) => void,
  ) => void;
  /** Some sheets pick a scale while drawing; this is what the block says. */
  scale: string;
}

/**
 * Builds the whole set.
 *
 * Everything here is derived from the document at the moment of export. There
 * is no stored drawing state at all, which is the same rule the rest of the app
 * follows: a plan that could drift from the model it documents is worse than no
 * plan.
 */
export function buildDrawingSet(doc: DesignDocument, options: DrawingSetOptions): PdfWriter {
  const pdf = new PdfWriter({
    title: `${doc.name} — drawing set`,
    subject: 'Produced by havavamama. Not for construction.',
  });

  const size = landscape(options.pageSize);
  const storeys = doc.levels.filter((level) => level.plan.walls.length > 0);
  const plans: SheetPlan[] = [];

  /* ------------------------------- The cover ------------------------------ */
  plans.push({
    number: 'A0.1',
    title: 'Cover and general information',
    scale: 'Not to scale',
    draw: (page) => drawCover(page, doc, options),
  });

  /* ----------------------------- Floor plans ------------------------------ */
  storeys.forEach((level, index) => {
    plans.push({
      number: `A1.${index + 1}`,
      title: `${level.name} plan`,
      scale: '',
      draw: (page, block, setScale) => drawPlanSheet(page, doc, level, block, options, size, setScale),
    });
  });

  /* ------------------------------ Elevations ------------------------------ */
  if (storeys.length > 0) {
    SIDES.forEach((side, index) => {
      plans.push({
        number: `A2.${index + 1}`,
        title: `${capitalise(side)} elevation`,
        scale: '',
        draw: (page, block, setScale) => drawElevationSheet(page, doc, side, block, options, size, setScale),
      });
    });
  }

  /* ------------------------------ Electrical ------------------------------ */
  if (doc.electrical.devices.length > 0) {
    storeys.forEach((level, index) => {
      plans.push({
        number: `E1.${index + 1}`,
        title: `${level.name} electrical plan`,
        scale: '',
        draw: (page, block, setScale) =>
          drawElectricalSheet(page, doc, level, block, options, size, setScale),
      });
    });

    plans.push({
      number: 'E2.1',
      title: 'Panel schedule and load calculation',
      scale: 'Not to scale',
      draw: (page, block, _setScale, queue) => drawPanelSheet(pdf, page, doc, block, size, queue),
    });
  }

  /* ------------------------------- Plumbing ------------------------------- */

  /*
   * A plan per storey and one riser diagram for the building. Both, because
   * they answer different questions: the plan says where the pipe goes, and
   * only the riser says what connects to what and whether every trap has a
   * vent — which is what an inspector actually checks.
   */
  if (doc.plumbing.drainage.length > 0 || doc.plumbing.supply.length > 0) {
    storeys.forEach((level, index) => {
      plans.push({
        number: `P1.${index + 1}`,
        title: `${level.name} plumbing plan`,
        scale: '',
        draw: (page, block, setScale) =>
          drawPlumbingSheet(page, doc, level, block, options, size, setScale),
      });
    });

    plans.push({
      number: 'P2.1',
      title: 'Drainage riser diagram',
      scale: 'Not to scale',
      draw: (page, block) => drawRiserSheet(page, doc, block),
    });

    plans.push({
      number: 'P3.1',
      title: 'Pipe and fixture unit schedules',
      scale: 'Not to scale',
      draw: (page, block, _setScale, queue) => drawPipeScheduleSheet(pdf, page, doc, block, size, queue),
    });
  }

  /*
   * Derived once and shared by the section sheets and the mechanical ones.
   * The load walks every wall of every room, and a set with two sections and
   * two storeys would otherwise do it five times over.
   */
  const hvacForSections = doc.hvac.locationKey === '' ? null : deriveHvac(doc);

  /* --------------------------------- Sections ----------------------------- */

  /*
   * One sheet per cut.
   *
   * Drawn from `doc.sections`, which is empty until somebody asks for a
   * section — so a set exported from a design nobody has cut is exactly as it
   * was before, and a set exported after two clicks has the drawing that
   * answers the height questions the plans and elevations cannot.
   */
  for (const cut of doc.sections) {
    plans.push({
      number: `S1.${doc.sections.indexOf(cut) + 1}`,
      // A cut drawn by hand is named "Section A" already, so appending the
      // mark gives "Section A — section A". Only add it when it is not there.
      title: new RegExp(`\\b${cut.mark}\\b`).test(cut.name)
        ? cut.name
        : `${cut.name} — section ${cut.mark}`,
      scale: '',
      draw: (page, block, setScale) =>
        drawSectionSheet(page, doc, cut, hvacForSections, block, options, size, setScale),
    });
  }

  /* -------------------------------- Mechanical ---------------------------- */

  /*
   * A plan per storey and one schedule sheet.
   *
   * The schedule matters more than it looks. A duct size on a plan is an
   * assertion; the same size next to the room load it serves is a calculation
   * somebody else can check. Without it a mechanical drawing cannot be argued
   * with, only believed.
   *
   * Drawn whenever there is a design location, even with no ductwork at all —
   * a hydronic house and a load-only study both still have a load worth
   * printing, and it is the sheet the next person needs most.
   */
  const hvac = hvacForSections;

  if (hvac && hvac.load.rooms.length > 0) {
    if (doc.hvac.ducts.length > 0 || doc.hvac.emitters.length > 0) {
      storeys.forEach((level, index) => {
        plans.push({
          number: `M1.${index + 1}`,
          title: `${level.name} mechanical plan`,
          scale: '',
          draw: (page, block, setScale) =>
            drawHvacSheet(page, doc, level, hvac, block, options, size, setScale),
        });
      });
    }

    plans.push({
      number: 'M2.1',
      title: 'Load, duct and equipment schedules',
      scale: 'Not to scale',
      draw: (page, block, _setScale, queue) =>
        drawHvacScheduleSheet(pdf, page, doc, hvac, block, size, queue),
    });
  }

  /* --------------------------- Kitchen elevations ------------------------- */

  /*
   * One sheet per run of cabinetry. These are the drawings somebody fitting a
   * kitchen actually works from — the plan says where the cupboards are, and
   * only an elevation says which of them is a drawer and how high the wall
   * units hang.
   */
  const runGroups = groupRuns(doc);
  runGroups.forEach((group, index) => {
    plans.push({
      number: `A4.${index + 1}`,
      title: `${group.levelName} cabinet elevation ${index + 1}`,
      scale: '',
      draw: (page, block, setScale) =>
        drawRunElevationSheet(page, doc, group, block, options, setScale),
    });
  });

  /* ------------------------------ Schedules ------------------------------- */
  const schedules: Array<{ number: string; title: string; build: () => { headers: string[]; rows: string[][]; note?: string } }> = [
    { number: 'A3.1', title: 'Door schedule', build: () => doorSchedule(doc, options.formats) },
    { number: 'A3.2', title: 'Window schedule', build: () => windowSchedule(doc, options.formats) },
    { number: 'A3.3', title: 'Room schedule', build: () => roomSchedule(doc, options.formats) },
    { number: 'A3.4', title: 'Cabinet schedule', build: () => cabinetSchedule(doc, options.formats) },
    {
      number: 'A3.5',
      title: 'Sanitaryware and appliance schedule',
      build: () => fixtureSchedule(doc, options.formats),
    },
    { number: 'A3.6', title: 'Fittings schedule', build: () => fittingSchedule(doc, options.formats) },
  ];

  for (const schedule of schedules) {
    const built = schedule.build();
    if (built.rows.length === 0) continue;
    plans.push({
      number: schedule.number,
      title: schedule.title,
      scale: 'Not to scale',
      draw: (page, block, _setScale, queue) => drawScheduleSheet(pdf, page, built, block, size, queue),
    });
  }

  /* -------------------------- Draw, now they are known -------------------- */

  /*
   * Pages are created up front so a sheet that overflows can append its own
   * without disturbing the numbering of the ones after it — the overflow pages
   * land at the end of the document, and the title block on each says which
   * sheet it continues.
   */
  const pages = plans.map(() => pdf.addPage(size));

  /** Title blocks waiting for the final sheet count. See the note above. */
  const queued: Array<{ page: PdfPage; block: TitleBlock }> = [];
  const queue = (page: PdfPage, block: TitleBlock) => {
    queued.push({ page, block });
  };

  plans.forEach((plan, index) => {
    const page = pages[index]!;
    let scaleLabel = plan.scale;
    const setScale = (label: string) => {
      scaleLabel = label;
    };

    const block: TitleBlock = {
      project: doc.name,
      title: plan.title,
      number: plan.number,
      scale: scaleLabel,
      date: options.date,
      index: index + 1,
      total: 0,
    };

    // The drawing runs first, because it is what decides the scale.
    plan.draw(page, block, setScale, queue);
    block.scale = scaleLabel;
    queue(page, block);
  });

  for (const entry of queued) {
    entry.block.total = pdf.pageCount;
    drawSheet(entry.page, entry.block);
  }

  return pdf;
}

/* --------------------------------- Sheets --------------------------------- */

/** The cover: what this is, what is in it, and the limits of what it claims. */
function drawCover(page: PdfPage, doc: DesignDocument, options: DrawingSetOptions): void {
  const frame = frameOf(page);
  const column = frame.width / 2 - 20;

  let y = frame.y + frame.height - 30;
  page.text(doc.name, frame.x, y, { size: 22, font: 'helvetica-bold' });
  y -= 22;
  page.text('Drawing set', frame.x, y, { size: 11, colour: GREY });
  y -= 26;

  /* ---- What the building is ---- */
  const area = doc.levels.reduce((total, level) => total + totalFloorArea(findRegions(level.plan)), 0);
  const rooms = doc.levels.reduce((total, level) => total + findRegions(level.plan).length, 0);

  const facts: Array<[string, string]> = [
    ['Storeys', String(doc.levels.length)],
    ['Rooms', String(rooms)],
    ['Floor area', options.formats.area(area)],
    ['Height to ridge', options.formats.length(buildingHeight(doc))],
    ['North', `${Math.round((doc.site.northAngle * 180) / Math.PI)}° · up the sheet is ${compassPoint(((doc.site.northAngle * 180) / Math.PI + 360) % 360)}`],
    ['Circuits', String(doc.electrical.circuits.length)],
    [
      'Drainage',
      doc.plumbing.drainage.length > 0
        ? `${plumbingTotals(doc).totalDfu} DFU · ${plumbingTotals(doc).waterClosets} WC`
        : 'Not routed',
    ],
  ];

  for (const [label, value] of facts) {
    page.text(label, frame.x, y, { size: 8, colour: GREY });
    page.text(value, frame.x + 110, y, { size: 8, font: 'helvetica-bold' });
    y -= 14;
  }

  /* ---- What is in the set ---- */
  let right = frame.y + frame.height - 30;
  const rightX = frame.x + frame.width / 2 + 20;
  page.text('SHEETS IN THIS SET', rightX, right, { size: 9, font: 'helvetica-bold' });
  right -= 16;
  page.text(
    'Cover, floor plans, elevations, electrical plans, plumbing plans and schedules. Every sheet carries its own scale bar; measure the bar before scaling anything off a print. The riser diagram is schematic and is not to scale.',
    rightX,
    right,
    { size: 7.5, colour: GREY },
  );

  /* ---- What it does not claim ---- */
  const noticeY = frame.y + 140;
  page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]);
  page.rect(frame.x, frame.y + 10, frame.width, noticeY - frame.y).stroke();
  page.restore();

  let notice = noticeY - 16;
  page.text('WHAT THIS SET IS NOT', frame.x + 12, notice, { size: 9, font: 'helvetica-bold' });
  notice -= 16;

  notice = drawParagraph(
    page,
    'These drawings were produced automatically from a model the user built. They have not been ' +
      'checked or stamped by a licensed architect or engineer, and they are not a permit set. ' +
      'No structural design has been done at all: no beam, header, footing or connection has been ' +
      'sized, and nothing here says the building stands up.',
    frame.x + 12,
    notice,
    frame.width - 24,
    { size: 7.5 },
  );

  notice -= 6;
  notice = drawParagraph(
    page,
    'Code checking in this app covers the 2021 International Residential Code for stairs, guards, ' +
      'roofs and light and ventilation, the 2023 National Electrical Code for branch circuits, ' +
      'protection and the service calculation, and the 2021 International Plumbing Code for ' +
      'drainage, venting and water supply. Checking is not approval, jurisdictions amend the ' +
      'codes they adopt; the electrical work must be done by a licensed electrician and the ' +
      'plumbing by a licensed plumber, and both must be inspected.',
    frame.x + 12,
    notice,
    frame.width - 24,
    { size: 7.5 },
  );

  notice -= 6;
  drawParagraph(
    page,
    'Elevations show each storey as a single plane: a facade that steps in and out is drawn without ' +
      'the hidden lines that would separate near from far. Dimension chains cover walls square to the ' +
      'building; anything at an angle is dimensioned only overall.',
    frame.x + 12,
    notice,
    frame.width - 24,
    { size: 7.5, colour: GREY },
  );

  void column;
}

/** One storey, dimensioned. */
function drawPlanSheet(
  page: PdfPage,
  doc: DesignDocument,
  level: Level,
  block: TitleBlock,
  options: DrawingSetOptions,
  size: PageSize,
  setScale: (label: string) => void,
): void {
  const frame = frameOf(page);
  // Room inside the frame for the dimension strings and the scale bar.
  const drawable = { x: frame.x + 60, y: frame.y + 40, width: frame.width - 120, height: frame.height - 90 };

  const extent = boundsOf(planExtent(level));
  const scale = fitScale(extent.width, extent.depth, drawable.width, drawable.height, options.imperial);
  const projector = projectorFor(scale, extent, drawable);
  setScale(scale.label);

  /*
   * The marks come from the same `markOpenings` the schedules use, so D3 on
   * the plan is D3 in the schedule. Numbering them separately in two files is
   * exactly how a set comes to contradict itself.
   */
  const marks = new Map<string, string>();
  for (const kind of ['door', 'window'] as const) {
    for (const marked of markOpenings(doc, kind)) {
      if (marked.levelId === level.id) marks.set(marked.opening.id, marked.mark);
    }
  }

  drawFloorPlan(page, doc, level, projector, drawable, {
    format: options.formats.length,
    formatArea: options.formats.area,
    showFurniture: options.showFurniture,
    showFittings: true,
    showDimensions: true,
    openingMarks: marks,
    sectionCuts: doc.sections,
  });

  drawScaleBar(page, projector, frame.x + 10, frame.y + 16, options.imperial);
  drawNorthPoint(page, frame.x + frame.width - 26, frame.y + frame.height - 26, doc.site.northAngle);

  void block;
  void size;
}

/** One elevation. */
function drawElevationSheet(
  page: PdfPage,
  doc: DesignDocument,
  side: Side,
  block: TitleBlock,
  options: DrawingSetOptions,
  size: PageSize,
  setScale: (label: string) => void,
): void {
  const frame = frameOf(page);
  const drawable = { x: frame.x + 30, y: frame.y + 40, width: frame.width - 120, height: frame.height - 80 };

  const extent = elevationExtent(doc, side);
  const scale = fitScale(extent.width, extent.height, drawable.width, drawable.height, options.imperial);
  setScale(scale.label);

  drawElevation(page, doc, side, scale, drawable, {
    format: options.formats.length,
    showDimensions: true,
  });

  const projector = projectorFor(scale, { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, drawable);
  drawScaleBar(page, projector, frame.x + 10, frame.y + 16, options.imperial);

  void block;
  void size;
}

/** One run of cabinetry, flat on and dimensioned unit by unit. */
function drawRunElevationSheet(
  page: PdfPage,
  doc: DesignDocument,
  group: RunGroup,
  block: TitleBlock,
  options: DrawingSetOptions,
  setScale: (label: string) => void,
): void {
  const frame = frameOf(page);
  const drawable = {
    x: frame.x + 40,
    y: frame.y + 60,
    width: frame.width - 140,
    height: frame.height - 110,
  };

  const level = doc.levels.find((entry) => entry.id === group.levelId) ?? null;
  const height = level?.wallHeight ?? 2.4;
  const scale = fitScale(group.length, height, drawable.width, drawable.height, options.imperial);
  setScale(scale.label);

  drawRunElevation(page, group, level, scale, drawable, { format: options.formats.length });

  const fitted = fittedInto(doc, group);
  if (fitted.length > 0) {
    page.text(`Fitted into this run: ${fitted.join(', ')}.`, frame.x, frame.y + 14, {
      size: 7,
      colour: GREY,
    });
  }

  const projector = projectorFor(scale, { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, drawable);
  drawScaleBar(page, projector, frame.x + 10, frame.y + 34, options.imperial);

  void block;
}

/** One storey's electrical plan, with its legend. */
function drawElectricalSheet(
  page: PdfPage,
  doc: DesignDocument,
  level: Level,
  block: TitleBlock,
  options: DrawingSetOptions,
  size: PageSize,
  setScale: (label: string) => void,
): void {
  const frame = frameOf(page);
  const legendWidth = 190;
  const drawable = {
    x: frame.x + 20,
    y: frame.y + 40,
    width: frame.width - legendWidth - 50,
    height: frame.height - 70,
  };

  const extent = boundsOf(planExtent(level));
  const scale = fitScale(extent.width, extent.depth, drawable.width, drawable.height, options.imperial);
  const projector = projectorFor(scale, extent, drawable);
  setScale(scale.label);

  drawGhostPlan(page, level, projector);

  const references = new Map(doc.electrical.circuits.map((circuit) => [circuit.id, circuit.reference]));
  drawDevices(page, doc.electrical.devices, doc.electrical.panel, level.id, projector, (id) =>
    id ? (references.get(id) ?? '') : '',
  );

  // Room names, so somebody can tell which room a symbol is in.
  page.save();
  for (const region of findRegions(level.plan)) {
    const at = projector.at(region.interiorPoint);
    page.text(
      resolveRoomName(level, region.key).toUpperCase(),
      at.x,
      at.y - 22,
      { size: 6.5, align: 'center', colour: GREY },
    );
  }
  page.restore();

  const used = new Set<DeviceKind>(
    doc.electrical.devices.filter((device) => device.levelId === level.id).map((device) => device.kind),
  );
  if (doc.electrical.panel?.levelId === level.id) used.add('panel');

  const legendX = frame.x + frame.width - legendWidth;
  let cursor = drawLegend(page, used, legendX, frame.y + frame.height - 14);

  cursor -= 10;
  page.text('CIRCUITS ON THIS STOREY', legendX, cursor, { size: 8, font: 'helvetica-bold' });
  cursor -= 13;

  const onThisLevel = new Set(
    doc.electrical.devices
      .filter((device) => device.levelId === level.id && device.circuitId)
      .map((device) => device.circuitId!),
  );
  for (const circuit of doc.electrical.circuits) {
    if (!onThisLevel.has(circuit.id)) continue;
    page.text(`${circuit.reference}.`, legendX, cursor, { size: 6.8, font: 'helvetica-bold' });
    page.text(circuit.name, legendX + 16, cursor, { size: 6.8 });
    cursor -= 10;
  }

  cursor -= 6;
  drawParagraph(
    page,
    'The number beside each symbol is its circuit. Devices are drawn where the model puts them; ' +
      'cable routes are not shown, because framing has not been designed. Work to be carried out ' +
      'by a licensed electrician and inspected.',
    legendX,
    cursor,
    legendWidth - 10,
    { size: 6.2, colour: GREY },
  );

  drawScaleBar(page, projector, frame.x + 10, frame.y + 16, options.imperial);
  drawNorthPoint(page, drawable.x + drawable.width - 20, frame.y + frame.height - 26, doc.site.northAngle);

  void block;
  void size;
}

/** One storey's plumbing plan, with its legend. */
function drawPlumbingSheet(
  page: PdfPage,
  doc: DesignDocument,
  level: Level,
  block: TitleBlock,
  options: DrawingSetOptions,
  size: PageSize,
  setScale: (label: string) => void,
): void {
  const frame = frameOf(page);
  const legendWidth = 190;
  const drawable = {
    x: frame.x + 20,
    y: frame.y + 40,
    width: frame.width - legendWidth - 50,
    height: frame.height - 70,
  };

  const extent = boundsOf(planExtent(level));
  const scale = fitScale(extent.width, extent.depth, drawable.width, drawable.height, options.imperial);
  const projector = projectorFor(scale, extent, drawable);
  setScale(scale.label);

  drawPlumbingGhostPlan(page, level, projector);

  /*
   * Sizes come from the sizing module, not from anything stored, so the label
   * on the drawing is the same number the checker judged and the panel shows.
   * Three copies of that arithmetic is exactly how a drawing ends up passing
   * its own checks while showing the wrong pipe.
   */
  const drainage = sizeAllDrainage(doc).map((entry) => ({
    run: entry.run,
    label: `${entry.size.asWritten}${
      entry.slope !== null && entry.horizontalLength > 0.05
        ? ` @ 1:${(1 / entry.slope).toFixed(0)}`
        : ''
    }`,
  }));
  const supply = sizeAllSupply(doc).map((entry) => ({
    run: entry.run,
    label: entry.size.asWritten,
  }));

  drawPipes(page, [...drainage, ...supply], level.id, projector);
  drawPlumbingFittings(page, doc, level.id, projector);

  // Room names, so somebody can tell which room a pipe is in.
  page.save();
  for (const region of findRegions(level.plan)) {
    const at = projector.at(region.interiorPoint);
    page.text(resolveRoomName(level, region.key).toUpperCase(), at.x, at.y - 22, {
      size: 6.5,
      align: 'center',
      colour: GREY,
    });
  }
  page.restore();

  const used = new Set(
    [...doc.plumbing.drainage, ...doc.plumbing.supply]
      .filter((run) => run.points.some((point) => point.levelId === level.id))
      .map((run) => run.system),
  );

  const legendX = frame.x + frame.width - legendWidth;
  let cursor = drawPlumbingLegend(page, used, legendX, frame.y + frame.height - 14);

  cursor -= 10;
  drawParagraph(
    page,
    'Pipe sizes and falls are to the 2021 IPC, worked out from the fixtures shown. Horizontal ' +
      'runs are drawn at the minimum fall their size allows; more fall is better than less. ' +
      'Cleanouts are required and are not drawn. Work to be carried out by a licensed plumber ' +
      'and inspected.',
    legendX,
    cursor,
    legendWidth - 10,
    { size: 6.2, colour: GREY },
  );

  drawScaleBar(page, projector, frame.x + 10, frame.y + 16, options.imperial);
  drawNorthPoint(page, drawable.x + drawable.width - 20, frame.y + frame.height - 26, doc.site.northAngle);

  void block;
  void size;
}

/** The drainage riser, and the findings that are about topology. */
function drawRiserSheet(page: PdfPage, doc: DesignDocument, block: TitleBlock): void {
  const frame = frameOf(page);
  const diagram = {
    x: frame.x,
    y: frame.y,
    width: frame.width * 0.62,
    height: frame.height,
  };

  drawRiserDiagram(page, doc, sizeAllDrainage(doc), diagram);

  /* ---- The venting findings beside it, because that is what a riser is for -- */
  const report = checkPlumbing(doc);
  const rightX = frame.x + frame.width * 0.66;
  let cursor = frame.y + frame.height - 14;

  page.text('CODE CHECK', rightX, cursor, { size: 8, font: 'helvetica-bold' });
  cursor -= 14;

  for (const finding of report.findings) {
    if (cursor < frame.y + 40) break;
    const mark = finding.severity === 'violation' ? '!' : finding.severity === 'caution' ? '?' : '·';
    page.text(mark, rightX, cursor, { size: 7, font: 'helvetica-bold' });
    page.text(finding.title, rightX + 10, cursor, { size: 7 });
    cursor -= 9;
    // An empty section is guidance, not code — printing a citation that does
    // not exist is how a reader stops trusting the ones that do.
    page.text(finding.section ? `IPC ${finding.section}` : 'Guidance', rightX + 10, cursor, {
      size: 6,
      colour: GREY,
    });
    cursor -= 12;
  }

  if (report.findings.length === 0) {
    page.text('Nothing to report.', rightX, cursor, { size: 7, colour: GREY });
    cursor -= 14;
  }

  cursor -= 8;
  drawParagraph(page, IPC_DISCLAIMER, rightX, cursor, frame.width * 0.32, {
    size: 6.2,
    colour: GREY,
  });

  void block;
}

/** The pipe schedules and the fixture unit schedule. */
function drawPipeScheduleSheet(
  pdf: PdfWriter,
  page: PdfPage,
  doc: DesignDocument,
  block: TitleBlock,
  size: PageSize,
  queue: (page: PdfPage, block: TitleBlock) => void,
): void {
  const frame = frameOf(page);
  const overflow = () => {
    const extra = pdf.addPage(size);
    queue(extra, { ...block, title: `${block.title} (continued)`, index: pdf.pageCount });
    return extra;
  };

  let current = page;
  let cursor = frame.y + frame.height - 14;

  current.text('DRAINAGE', frame.x, cursor, { size: 8, font: 'helvetica-bold' });
  cursor -= 14;
  let result = drawDrainageSchedule(current, doc, sizeAllDrainage(doc), frame.x, cursor, frame, overflow);
  current = result.page;
  cursor = result.y - 24;

  current.text('WATER SUPPLY', frame.x, cursor, { size: 8, font: 'helvetica-bold' });
  cursor -= 14;
  result = drawSupplySchedule(current, doc, sizeAllSupply(doc), frame.x, cursor, frame, overflow);
  current = result.page;
  cursor = result.y - 24;

  current.text('FIXTURE UNITS', frame.x, cursor, { size: 8, font: 'helvetica-bold' });
  cursor -= 14;
  result = drawFixtureUnitSchedule(current, doc, frame.x, cursor, frame, overflow);
  current = result.page;
  cursor = result.y - 20;

  drawParagraph(
    current,
    'DFU are drainage fixture units (IPC Table 709.1); WSFU are water supply fixture units ' +
      '(Table E103.3(2)). They are different quantities and do not convert into one another — a ' +
      'water closet is 3 DFU out and 2.2 WSFU in.',
    frame.x,
    cursor,
    frame.width * 0.6,
    { size: 6.2, colour: GREY },
  );

  void size;
}

/** The panel schedule, the load calculation, and the NEC findings. */
function drawPanelSheet(
  pdf: PdfWriter,
  page: PdfPage,
  doc: DesignDocument,
  block: TitleBlock,
  size: PageSize,
  queue: (page: PdfPage, block: TitleBlock) => void,
): void {
  const frame = frameOf(page);
  const half = frame.width / 2 - 20;

  const rows = panelSchedule(doc);
  drawPanelSchedule(page, rows, doc.electrical.panel, frame.x, frame.y + frame.height - 14, frame, () => {
    const extra = pdf.addPage(size);
    // Appended at the end, so its own sheet number is the new page count.
    queue(extra, { ...block, title: `${block.title} (continued)`, index: pdf.pageCount });
    return extra;
  });

  const rightX = frame.x + half + 40;
  let cursor = drawLoadCalculation(page, calculateLoad(doc), rightX, frame.y + frame.height - 14, half - 20);

  /* ---- The findings, which are the point of checking at all ---- */
  const report = checkElectrical(doc);
  cursor -= 14;
  page.text('CODE CHECK', rightX, cursor, { size: 8, font: 'helvetica-bold' });
  cursor -= 13;

  for (const finding of report.findings) {
    if (cursor < frame.y + 20) break;
    const mark = finding.severity === 'violation' ? '!' : finding.severity === 'caution' ? '?' : '·';
    page.text(mark, rightX, cursor, { size: 7, font: 'helvetica-bold' });
    page.text(finding.title, rightX + 10, cursor, { size: 7 });
    if (finding.section) {
      page.text(`NEC ${finding.section}`, rightX + half - 20, cursor, {
        size: 6,
        align: 'right',
        colour: GREY,
      });
    }
    cursor -= 10;
  }
}

/** One schedule, filling the sheet and overflowing onto more if it has to. */
function drawScheduleSheet(
  pdf: PdfWriter,
  page: PdfPage,
  schedule: { headers: string[]; rows: string[][]; note?: string },
  block: TitleBlock,
  size: PageSize,
  queue: (page: PdfPage, block: TitleBlock) => void,
): void {
  const frame = frameOf(page);

  // Columns share the width in proportion to how much they have to say: the
  // first and last columns of a schedule are a mark and a note, and giving
  // them equal width wastes half the sheet.
  const weights = schedule.headers.map((header, index) => {
    const longest = schedule.rows.reduce(
      (widest, row) => Math.max(widest, (row[index] ?? '').length),
      header.length,
    );
    return Math.max(4, Math.min(46, longest));
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  const columns: Column[] = schedule.headers.map((header, index) => ({
    header,
    width: (weights[index]! / totalWeight) * frame.width,
  }));

  const result = drawTable(page, columns, schedule.rows, frame.x, frame.y + frame.height - 14, {
    bottom: frame.y + (schedule.note ? 40 : 10),
    onOverflow: () => {
      const extra = pdf.addPage(size);
      queue(extra, { ...block, title: `${block.title} (continued)`, index: pdf.pageCount });
      return { page: extra, y: frameOf(extra).y + frameOf(extra).height - 14 };
    },
  });

  if (schedule.note) {
    drawParagraph(result.page, schedule.note, frame.x, frame.y + 24, frame.width, {
      size: 6.8,
      colour: GREY,
    });
  }
}

/* -------------------------------- Helpers --------------------------------- */

/* --------------------------------- Sections ------------------------------- */

/**
 * One section sheet: the drawing, its notes, and the scale it came out at.
 *
 * The scale is chosen from the cut's own extent rather than the building's, so
 * a short section through a stair is drawn as large as it will go rather than
 * at whatever suits the longest section in the set. They are separate drawings
 * and each carries its own printed scale bar.
 */
function drawSectionSheet(
  page: PdfPage,
  doc: DesignDocument,
  cut: SectionCut,
  hvac: ReturnType<typeof deriveHvac> | null,
  block: TitleBlock,
  options: DrawingSetOptions,
  size: PageSize,
  setScale: (label: string) => void,
): void {
  const frame = frameOf(page);
  const notesWidth = 200;
  const drawable = {
    x: frame.x + 20,
    y: frame.y + 40,
    width: frame.width - notesWidth - 50,
    height: frame.height - 80,
  };

  const model = buildSection(doc, cut);
  const width = Math.max(0.5, model.extent.maxU - model.extent.minU);
  const height = Math.max(0.5, model.extent.maxY - model.extent.minY);

  const scale = fitScale(width, height, drawable.width, drawable.height, options.imperial);
  setScale(scale.label);

  const result = drawSection(page, doc, model, hvac, scale, drawable, {
    imperial: options.imperial,
    showPlumbing: true,
    showDucts: true,
    showElectrical: false,
    showCallouts: true,
  });

  const notesX = frame.x + frame.width - notesWidth;
  drawSectionNotes(page, result.notes, notesX, frame.y + frame.height - 14, notesWidth - 10);

  /*
   * The scale bar wants a Projector, and a section has no plan projector —
   * its coordinates are (u, height), not (x, z). Only `perMetre` and `length`
   * are read, so this supplies exactly those and makes `at` throw rather than
   * silently returning the origin: if the bar ever starts projecting points,
   * that should be a loud failure in a test rather than a scale bar drawn in
   * the corner of the page.
   */
  drawScaleBar(page, sectionScaleProjector(scale), frame.x + 10, frame.y + 16, options.imperial);

  void block;
  void size;
}

function sectionScaleProjector(scale: DrawingScale): Projector {
  const perMetre = pointsPerMetre(scale);
  return {
    scale,
    perMetre,
    length: (metres: number) => metres * perMetre,
    at: () => {
      throw new Error('A section has no plan projector; only its scale is defined.');
    },
  };
}

/* -------------------------------- Mechanical ------------------------------ */

function drawHvacSheet(
  page: PdfPage,
  doc: DesignDocument,
  level: Level,
  hvac: ReturnType<typeof deriveHvac>,
  block: TitleBlock,
  options: DrawingSetOptions,
  size: PageSize,
  setScale: (label: string) => void,
): void {
  const frame = frameOf(page);
  const legendWidth = 190;
  const drawable = {
    x: frame.x + 20,
    y: frame.y + 40,
    width: frame.width - legendWidth - 50,
    height: frame.height - 70,
  };

  const extent = boundsOf(planExtent(level));
  const scale = fitScale(extent.width, extent.depth, drawable.width, drawable.height, options.imperial);
  const projector = projectorFor(scale, extent, drawable);
  setScale(scale.label);

  drawPlumbingGhostPlan(page, level, projector);

  /*
   * Sizes come from the sizing module rather than from anything stored, so the
   * label on the drawing is the same number the checker judged and the panel
   * shows. Three copies of that arithmetic is exactly how a drawing ends up
   * passing its own checks while showing the wrong duct.
   */
  const sized = sizeAllDucts(doc, hvac.load, hvac.selection);
  const airflows = roomAirflows(hvac.load, hvac.selection);
  const perRegister = registerAirflows(doc.hvac.registers, airflows);

  drawDucts(page, sized, level.id, projector);
  drawHvacFittings(page, doc, level.id, projector, perRegister);

  page.save();
  for (const region of findRegions(level.plan)) {
    const at = projector.at(region.interiorPoint);
    page.text(resolveRoomName(level, region.key).toUpperCase(), at.x, at.y - 22, {
      size: 6.5,
      align: 'center',
      colour: GREY,
    });
  }
  page.restore();

  const used = new Set(
    doc.hvac.ducts
      .filter((run) => run.points.some((point) => point.levelId === level.id))
      .map((run) => run.system),
  );

  const legendX = frame.x + frame.width - legendWidth;
  let cursor = drawHvacLegend(page, used, legendX, frame.y + frame.height - 14);

  cursor -= 10;
  drawParagraph(
    page,
    'Duct sizes are to ACCA Manual D at 0.1 in w.c. per 100 ft, from the Manual J load on the ' +
      'schedule sheet. The figure beside each register is its design airflow in cfm. Ducts are ' +
      'shown in the floor void and have NOT been checked against the joists, beams or anything ' +
      'else that is actually in it. Duct leakage is a test on the finished installation and is ' +
      'not predicted here. Work to be carried out by a licensed installer and inspected.',
    legendX,
    cursor,
    legendWidth - 10,
    { size: 6.2, colour: GREY },
  );

  drawScaleBar(page, projector, frame.x + 10, frame.y + 16, options.imperial);
  drawNorthPoint(page, drawable.x + drawable.width - 20, frame.y + frame.height - 26, doc.site.northAngle);

  void block;
  void size;
}

/** The room-by-room load, the ducts and the equipment, on one sheet. */
function drawHvacScheduleSheet(
  pdf: PdfWriter,
  page: PdfPage,
  doc: DesignDocument,
  hvac: ReturnType<typeof deriveHvac>,
  block: TitleBlock,
  size: PageSize,
  queue: (page: PdfPage, block: TitleBlock) => void,
): void {
  const frame = frameOf(page);
  const overflow = () => {
    const extra = pdf.addPage(size);
    queue(extra, { ...block, title: `${block.title} (continued)`, index: pdf.pageCount });
    return extra;
  };

  const sized = sizeAllDucts(doc, hvac.load, hvac.selection);
  const airflows = roomAirflows(hvac.load, hvac.selection);

  let current = page;
  let cursor = frame.y + frame.height - 14;

  current.text('ROOM LOADS — ACCA MANUAL J', frame.x, cursor, { size: 8, font: 'helvetica-bold' });
  cursor -= 14;
  let result = drawLoadSchedule(current, hvac.load, airflows, frame.x, cursor, frame, overflow);
  current = result.page;
  cursor = result.y - 24;

  current.text('EQUIPMENT — ACCA MANUAL S', frame.x, cursor, { size: 8, font: 'helvetica-bold' });
  cursor -= 14;
  result = drawEquipmentSchedule(
    current,
    hvac.load,
    hvac.selection,
    frame.x,
    cursor,
    frame,
    overflow,
  );
  current = result.page;
  cursor = result.y - 24;

  if (sized.length > 0) {
    current.text('DUCTWORK — ACCA MANUAL D', frame.x, cursor, { size: 8, font: 'helvetica-bold' });
    cursor -= 14;
    result = drawDuctSchedule(current, sized, frame.x, cursor, frame, overflow);
    current = result.page;
    cursor = result.y - 20;
  }

  drawParagraph(
    current,
    'Heating and cooling loads are different calculations and do not compare directly: heating ' +
      'is the coldest hour of the year at night with no sun and nobody home, cooling is a summer ' +
      'afternoon with the sun through the glass and the moisture to remove as well as the heat. ' +
      'An asterisk beside an air speed means the duct is over the Manual D noise limit — it will ' +
      'carry the air and you will hear it. The load is only as good as the envelope figures it ' +
      'was given; those are on the cover sheet.',
    frame.x,
    cursor,
    frame.width * 0.62,
    { size: 6.2, colour: GREY },
  );

  void size;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function resolveRoomName(level: Level, key: string): string {
  return level.plan.rooms[key]?.name ?? 'Room';
}
