/**
 * Drawing the heating and cooling.
 *
 * -----------------------------------------------------------------------------
 * THE MECHANICAL PLAN AND THE LOAD SCHEDULE ANSWER DIFFERENT QUESTIONS.
 *
 * The plan says where the ductwork goes and how big each piece is, which is
 * what the installer needs. The room-by-room load schedule says where every
 * one of those numbers came from, which is what an inspector or a second
 * opinion needs — and it is the sheet that makes the design arguable rather
 * than merely asserted. A duct size with no load behind it is a claim; a duct
 * size next to the 4,200 BTU/h it serves is a calculation.
 *
 * So both are drawn, and neither is optional.
 *
 * -----------------------------------------------------------------------------
 * LINE STYLE DOES THE WORK, NOT COLOUR.
 *
 * Same reasoning as the plumbing sheet: drawing sets are still routinely
 * printed in black and white, and a plan whose only distinction is colour
 * photocopies into identical greys. Supply is a solid line, return is dashed,
 * and the colour is a second cue on top rather than the only one.
 */

import { PdfPage, type Colour } from './pdf';
import { GREY, WEIGHTS, drawTable, type Column } from './sheet';
import type { Frame, Projector } from './scale';
import { wattsToBtu, TON_BTU } from '@/code/acca';
import type { BuildingLoad } from '@/services/manualJ';
import type { SystemSelection } from '@/services/manualS';
import type { SizedDuct, RoomAirflow } from '@/services/ductSize';
import type { DesignDocument, DuctSystem } from '@/state/types';

const STYLE: Record<DuctSystem, { colour: Colour; dash: number[] | null; label: string }> = {
  supply: { colour: [0.16, 0.4, 0.55], dash: null, label: 'Supply' },
  return: { colour: [0.42, 0.38, 0.32], dash: [5, 3], label: 'Return' },
};

/* --------------------------------- The plan ------------------------------- */

/**
 * The ductwork, with each run labelled by its size and the air it carries.
 *
 * Both numbers, not just the size. "10 in" tells an installer what to buy;
 * "10 in / 300 cfm" tells them whether the run they are looking at is the one
 * the drawing means, and lets anybody check the arithmetic on the spot.
 */
export function drawDucts(
  page: PdfPage,
  ducts: readonly SizedDuct[],
  levelId: string,
  projector: Projector,
): void {
  for (const duct of ducts) {
    const points = duct.run.points.filter((point) => point.levelId === levelId);
    if (points.length < 2) continue;

    const style = STYLE[duct.run.system];
    page.save().lineWidth(WEIGHTS.object).strokeColour(style.colour).dash(style.dash);
    page.path(points.map((point) => projector.at(point.at))).stroke();
    page.restore();

    const middle = points[Math.floor(points.length / 2)];
    const before = points[Math.max(0, Math.floor(points.length / 2) - 1)];
    if (!middle || !before) continue;

    const at = projector.at({
      x: (middle.at.x + before.at.x) / 2,
      z: (middle.at.z + before.at.z) / 2,
    });
    page.text(
      `${duct.size.asWritten} / ${Math.round(duct.cfm)} cfm`,
      at.x + 3,
      at.y + 2,
      { size: 4.6, colour: GREY },
    );
  }
}

/**
 * The registers, the plant and the emitters.
 *
 * A supply register is a small open rectangle, a return is a larger one with a
 * cross through it, and the air handler is a heavy square — the same shorthand
 * a mechanical drawing has always used, so somebody who has seen one before can
 * read this without the key.
 */
export function drawHvacFittings(
  page: PdfPage,
  doc: DesignDocument,
  levelId: string,
  projector: Projector,
  airflow: ReadonlyMap<string, number>,
): void {
  page.save().lineWidth(WEIGHTS.object).strokeColour([0.2, 0.2, 0.2]);

  for (const register of doc.hvac.registers) {
    if (register.levelId !== levelId) continue;

    const at = projector.at(register.at);
    const half = register.system === 'supply' ? 4 : 6;

    page
      .path([
        { x: at.x - half, y: at.y - half },
        { x: at.x + half, y: at.y - half },
        { x: at.x + half, y: at.y + half },
        { x: at.x - half, y: at.y + half },
        { x: at.x - half, y: at.y - half },
      ])
      .stroke();

    if (register.system === 'return') {
      page.path([{ x: at.x - half, y: at.y - half }, { x: at.x + half, y: at.y + half }]).stroke();
      page.path([{ x: at.x - half, y: at.y + half }, { x: at.x + half, y: at.y - half }]).stroke();
    }

    const cfm = airflow.get(register.id);
    if (cfm !== undefined && cfm > 0) {
      page.text(`${Math.round(cfm)}`, at.x, at.y - half - 7, {
        size: 4.6,
        align: 'center',
        colour: GREY,
      });
    }
  }

  const handler = doc.hvac.airHandler;
  if (handler && handler.levelId === levelId) {
    const at = projector.at(handler.at);
    page.save().lineWidth(WEIGHTS.cut);
    page
      .path([
        { x: at.x - 10, y: at.y - 10 },
        { x: at.x + 10, y: at.y - 10 },
        { x: at.x + 10, y: at.y + 10 },
        { x: at.x - 10, y: at.y + 10 },
        { x: at.x - 10, y: at.y - 10 },
      ])
      .stroke();
    page.restore();
    page.text('AHU', at.x, at.y - 3, { size: 5.5, align: 'center' });
  }

  for (const emitter of doc.hvac.emitters) {
    if (emitter.levelId !== levelId) continue;
    const at = projector.at(emitter.at);

    if (emitter.kind === 'radiator') {
      const half = Math.max(6, projector.length(emitter.length) / 2);
      page
        .path([
          { x: at.x - half, y: at.y - 3 },
          { x: at.x + half, y: at.y - 3 },
          { x: at.x + half, y: at.y + 3 },
          { x: at.x - half, y: at.y + 3 },
          { x: at.x - half, y: at.y - 3 },
        ])
        .stroke();
      page.text(`${Math.round(emitter.outputWatts)} W`, at.x, at.y - 10, {
        size: 4.6,
        align: 'center',
        colour: GREY,
      });
    } else {
      page.text('UFH', at.x, at.y, { size: 5.5, align: 'center', colour: GREY });
    }
  }

  page.restore();
}

/** The key, listing only what is actually on this sheet. */
export function drawHvacLegend(
  page: PdfPage,
  used: ReadonlySet<DuctSystem>,
  x: number,
  y: number,
): number {
  let cursor = y;
  page.text('KEY', x, cursor, { size: 7 });
  cursor -= 12;

  for (const system of ['supply', 'return'] as DuctSystem[]) {
    if (!used.has(system)) continue;
    const style = STYLE[system];

    page.save().lineWidth(WEIGHTS.object).strokeColour(style.colour).dash(style.dash);
    page.path([{ x, y: cursor + 2 }, { x: x + 24, y: cursor + 2 }]).stroke();
    page.restore();

    page.text(style.label, x + 30, cursor, { size: 6.2 });
    cursor -= 11;
  }

  return cursor;
}

/* -------------------------------- Schedules ------------------------------- */

/**
 * The room-by-room load and airflow schedule.
 *
 * This is the sheet that makes everything else defensible. Every duct on the
 * plan traces back to a room on this table, and every figure on this table
 * traces back to a wall, a window and a design temperature.
 */
export function drawLoadSchedule(
  page: PdfPage,
  load: BuildingLoad,
  airflows: readonly RoomAirflow[],
  x: number,
  y: number,
  frame: Frame,
  makePage: () => PdfPage,
): { page: PdfPage; y: number } {
  const columns: Column[] = [
    { header: 'Room', width: 108 },
    { header: 'Storey', width: 72 },
    { header: 'Area ft²', width: 46, align: 'right' },
    { header: 'Heat BTU/h', width: 56, align: 'right' },
    { header: 'Cool BTU/h', width: 56, align: 'right' },
    { header: 'Heat cfm', width: 44, align: 'right' },
    { header: 'Cool cfm', width: 44, align: 'right' },
  ];

  const byRoom = new Map(airflows.map((flow) => [flow.roomKey, flow]));

  const body = load.rooms.map((room) => {
    const flow = byRoom.get(room.roomKey);
    return [
      room.roomName,
      room.levelName,
      Math.round(room.area / 0.092903).toLocaleString(),
      Math.round(wattsToBtu(room.heatingTotal)).toLocaleString(),
      Math.round(wattsToBtu(room.coolingTotal)).toLocaleString(),
      flow ? Math.round(flow.heatingCfm).toString() : '—',
      flow ? Math.round(flow.coolingCfm).toString() : '—',
    ];
  });

  body.push([
    'WHOLE BUILDING',
    '',
    Math.round(load.floorArea / 0.092903).toLocaleString(),
    Math.round(wattsToBtu(load.heatingTotal)).toLocaleString(),
    Math.round(wattsToBtu(load.coolingTotal)).toLocaleString(),
    '',
    '',
  ]);

  return drawTable(page, columns, body, x, y, {
    bottom: frame.y + 10,
    onOverflow: () => ({ page: makePage(), y: frame.y + frame.height - 20 }),
  });
}

/** The duct schedule: what each run is, what it carries and how big it is. */
export function drawDuctSchedule(
  page: PdfPage,
  ducts: readonly SizedDuct[],
  x: number,
  y: number,
  frame: Frame,
  makePage: () => PdfPage,
): { page: PdfPage; y: number } {
  const columns: Column[] = [
    { header: 'Ref', width: 30 },
    { header: 'System', width: 56 },
    { header: 'Type', width: 56 },
    { header: 'Size', width: 44, align: 'right' },
    { header: 'cfm', width: 40, align: 'right' },
    { header: 'fpm', width: 40, align: 'right' },
    { header: 'Length', width: 48, align: 'right' },
  ];

  const body = ducts.map((duct, index) => [
    `${duct.run.system === 'supply' ? 'S' : 'R'}${index + 1}`,
    duct.run.system === 'supply' ? 'Supply' : 'Return',
    duct.role === 'trunk' ? 'Trunk' : duct.role === 'riser' ? 'Riser' : 'Branch',
    duct.size.asWritten,
    `${Math.round(duct.cfm)}`,
    // The velocity is flagged rather than silently printed: over the limit is
    // not a failure, it is a permanent noise the occupant will live with.
    `${Math.round(duct.velocity)}${duct.withinVelocity ? '' : ' *'}`,
    `${duct.length.toFixed(1)} m`,
  ]);

  return drawTable(page, columns, body, x, y, {
    bottom: frame.y + 10,
    onOverflow: () => ({ page: makePage(), y: frame.y + frame.height - 20 }),
  });
}

/** The equipment schedule, and what it was measured against. */
export function drawEquipmentSchedule(
  page: PdfPage,
  load: BuildingLoad,
  selection: SystemSelection,
  x: number,
  y: number,
  frame: Frame,
  makePage: () => PdfPage,
): { page: PdfPage; y: number } {
  const columns: Column[] = [
    { header: 'Item', width: 130 },
    { header: 'Selected', width: 180 },
    { header: 'Capacity', width: 70, align: 'right' },
    { header: 'Of load', width: 50, align: 'right' },
  ];

  const body: string[][] = [];

  if (selection.heating) {
    body.push([
      'Heating',
      selection.heating.model.name,
      `${Math.round(selection.heating.providedBtu).toLocaleString()} BTU/h`,
      `${Math.round(selection.heating.fraction * 100)}%`,
    ]);
  }
  if (selection.cooling) {
    body.push([
      'Cooling',
      selection.cooling.model.name,
      `${(selection.cooling.providedBtu / TON_BTU).toFixed(1)} tons`,
      `${Math.round(selection.cooling.fraction * 100)}%`,
    ]);
  }
  if (selection.balancePoint && !selection.balancePoint.coversDesignDay) {
    body.push([
      'Backup heat',
      `Below ${Math.round(selection.balancePoint.outdoorF)} °F, the balance point`,
      `${selection.balancePoint.supplementalKw.toFixed(1)} kW`,
      '',
    ]);
  }
  if (selection.supplyCfm > 0) {
    body.push([
      'Design airflow',
      'At 400 cfm per ton, ACCA Manual S 3-4',
      `${Math.round(selection.supplyCfm)} cfm`,
      '',
    ]);
  }
  body.push([
    'Ventilation',
    `${load.bedrooms} bedroom${load.bedrooms === 1 ? '' : 's'}, IRC M1505.4`,
    `${Math.round(selection.ventilationCfm)} cfm`,
    '',
  ]);

  if (load.conditions) {
    body.push([
      'Design conditions',
      `${load.conditions.city}, ${load.conditions.state} — zone ${load.conditions.climateZone}`,
      `${load.conditions.winterDryBulb} / ${load.conditions.summerDryBulb} °F`,
      '',
    ]);
  }

  return drawTable(page, columns, body, x, y, {
    bottom: frame.y + 10,
    onOverflow: () => ({ page: makePage(), y: frame.y + frame.height - 20 }),
  });
}
