/**
 * The electrical plan, its legend, and the panel schedule.
 *
 * -----------------------------------------------------------------------------
 * WHY THE SYMBOLS LOOK LIKE THAT.
 *
 * They are the standard ones, near enough: a receptacle is a circle with two
 * spokes, a switch is an S, a ceiling outlet is a crossed circle, a smoke alarm
 * is a circle marked SD, the panel is a filled rectangle. An electrician
 * glances at a plan and reads it without a legend — but the legend is drawn
 * anyway, because the person paying for the work usually cannot, and a drawing
 * that only its author can read is not a drawing.
 *
 * The devices are drawn OVER a ghosted floor plan rather than a full one. The
 * plan is context here, not the subject: heavy walls and dimension strings
 * would compete with the symbols, and the dimensioned plan is its own sheet.
 */

import { PdfPage, textWidth, type Colour } from './pdf';
import { GREY, WEIGHTS, drawTable, type Column } from './sheet';
import type { Frame, Projector } from './scale';
import { resolveWalls } from '@/scene/planGraph';
import { asAmps, asVoltAmperes } from '@/code/nec';
import type { ScheduleRow } from '@/services/circuits';
import type { LoadResult } from '@/services/circuits';
import type { DeviceKind, ElectricalDevice, Level, Panel } from '@/state/types';

const GHOST: Colour = [0.62, 0.62, 0.62];

/* --------------------------------- Symbols -------------------------------- */

/** What a kind of device is called on the legend. */
const LEGEND: ReadonlyArray<{ kind: DeviceKind; label: string }> = [
  { kind: 'receptacle', label: 'Duplex receptacle, 15 in AFF' },
  { kind: 'receptacle-gfci', label: 'Receptacle, ground-fault protected' },
  { kind: 'receptacle-counter', label: 'Counter receptacle, 44 in AFF' },
  { kind: 'receptacle-appliance', label: 'Appliance receptacle, dedicated' },
  { kind: 'switch', label: 'Switch, 46 in AFF' },
  { kind: 'switch-3way', label: 'Three-way switch' },
  { kind: 'switch-dimmer', label: 'Dimmer' },
  { kind: 'light-ceiling', label: 'Ceiling lighting outlet' },
  { kind: 'light-recessed', label: 'Recessed lighting outlet' },
  { kind: 'light-wall', label: 'Wall lighting outlet' },
  { kind: 'fan', label: 'Ceiling fan with light' },
  { kind: 'smoke-alarm', label: 'Smoke alarm, interconnected' },
  { kind: 'thermostat', label: 'Thermostat' },
  { kind: 'panel', label: 'Distribution panel' },
];

/**
 * One device symbol, centred on a point, at a fixed size on the page.
 *
 * Fixed size rather than scaled with the drawing, because a symbol is
 * annotation: it says "there is a socket here", not "the socket is 6 mm wide".
 * At 1/8 in scale a true-size receptacle would be a speck.
 */
export function drawDeviceSymbol(
  page: PdfPage,
  kind: DeviceKind,
  at: { x: number; y: number },
  size = 4.2,
): void {
  page.save().lineWidth(WEIGHTS.object).strokeColour([0, 0, 0]).fillColour([1, 1, 1]).dash(null);

  /*
   * Text takes the FILL colour, and the fill here is white so that a symbol
   * sits on the plan rather than letting the walls show through it. So every
   * piece of lettering states its own colour: without that the S of a switch
   * and the SD of a smoke alarm are drawn in white on white, which is to say
   * not drawn at all — and the legend shows an empty row beside its label.
   */
  const letter = (text: string, fontSize = size * 1.25) =>
    page.text(text, at.x, at.y - fontSize * 0.36, {
      size: fontSize,
      align: 'center',
      font: 'helvetica-bold',
      colour: [0, 0, 0],
    });

  switch (kind) {
    case 'receptacle':
    case 'receptacle-gfci':
    case 'receptacle-counter':
    case 'receptacle-appliance': {
      page.circle(at.x, at.y, size).fillAndStroke();
      // The two spokes that make it a duplex outlet rather than a plain circle.
      page.path([{ x: at.x - size, y: at.y }, { x: at.x + size, y: at.y }]).stroke();
      page.path([{ x: at.x, y: at.y }, { x: at.x, y: at.y - size }]).stroke();
      if (kind === 'receptacle-gfci') {
        page.text('GFI', at.x + size + 1.5, at.y - 2, {
          size: 4.2,
          font: 'helvetica-bold',
          colour: [0, 0, 0],
        });
      } else if (kind === 'receptacle-counter') {
        page.text('+44', at.x + size + 1.5, at.y - 2, { size: 4.2, colour: GREY });
      } else if (kind === 'receptacle-appliance') {
        page.text('APPL', at.x + size + 1.5, at.y - 2, { size: 4.2, colour: GREY });
      }
      break;
    }

    case 'switch':
    case 'switch-3way':
    case 'switch-dimmer': {
      letter('S');
      if (kind === 'switch-3way') page.text('3', at.x + size, at.y + 1, { size: 4 });
      if (kind === 'switch-dimmer') page.text('D', at.x + size, at.y + 1, { size: 4 });
      break;
    }

    case 'light-ceiling':
    case 'light-recessed':
    case 'light-wall': {
      page.circle(at.x, at.y, size).fillAndStroke();
      // The cross that marks a lighting outlet.
      const arm = size * 0.72;
      page.path([{ x: at.x - arm, y: at.y - arm }, { x: at.x + arm, y: at.y + arm }]).stroke();
      page.path([{ x: at.x - arm, y: at.y + arm }, { x: at.x + arm, y: at.y - arm }]).stroke();
      if (kind === 'light-recessed') page.circle(at.x, at.y, size * 0.45).stroke();
      break;
    }

    case 'fan': {
      page.circle(at.x, at.y, size).fillAndStroke();
      for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) / 2 + Math.PI / 4;
        page
          .path([
            { x: at.x, y: at.y },
            { x: at.x + Math.cos(angle) * size * 1.55, y: at.y + Math.sin(angle) * size * 1.55 },
          ])
          .stroke();
      }
      break;
    }

    case 'smoke-alarm': {
      page.circle(at.x, at.y, size).fillAndStroke();
      page.text('SD', at.x, at.y - 1.6, {
        size: 3.6,
        align: 'center',
        font: 'helvetica-bold',
        colour: [0, 0, 0],
      });
      break;
    }

    case 'thermostat': {
      page.circle(at.x, at.y, size).fillAndStroke();
      page.text('T', at.x, at.y - 2, {
        size: 4.6,
        align: 'center',
        font: 'helvetica-bold',
        colour: [0, 0, 0],
      });
      break;
    }

    case 'panel': {
      // The colour is set BEFORE the path is started: a colour operator
      // between `re` and `B` is a graphics-state operator inside a path
      // object, which the specification forbids and which makes a strict
      // reader abandon the rest of the content stream — taking every symbol
      // drawn after it with it.
      page.fillColour([0.2, 0.2, 0.2]);
      page.rect(at.x - size * 1.5, at.y - size, size * 3, size * 2).fillAndStroke();
      page.text('P', at.x, at.y - 2, {
        size: 5,
        align: 'center',
        font: 'helvetica-bold',
        colour: [1, 1, 1],
      });
      break;
    }
  }

  page.restore();
}

/* ----------------------------- The plan itself ---------------------------- */

/** The floor plan, ghosted, as background for the devices. */
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

/** Every device on this storey, with the circuit it is on beside it. */
export function drawDevices(
  page: PdfPage,
  devices: readonly ElectricalDevice[],
  panel: Panel | null,
  levelId: string,
  projector: Projector,
  circuitReference: (circuitId: string | null) => string,
): void {
  for (const device of devices) {
    if (device.levelId !== levelId) continue;
    const at = projector.at(device.at);
    drawDeviceSymbol(page, device.kind, at);

    const reference = circuitReference(device.circuitId);
    if (reference) {
      page.text(reference, at.x - 5.5, at.y + 3.5, { size: 4.2, align: 'right', colour: GREY });
    }
  }

  if (panel && panel.levelId === levelId) {
    drawDeviceSymbol(page, 'panel', projector.at(panel.at), 5);
  }
}

/* --------------------------------- Legend --------------------------------- */

/**
 * The legend, listing only the symbols this drawing actually uses.
 *
 * A legend that lists everything the app can draw teaches the reader to ignore
 * it. One that lists what is on the sheet is read.
 */
export function drawLegend(
  page: PdfPage,
  used: ReadonlySet<DeviceKind>,
  x: number,
  y: number,
): number {
  const entries = LEGEND.filter((entry) => used.has(entry.kind));
  if (entries.length === 0) return y;

  page.text('LEGEND', x, y, { size: 8, font: 'helvetica-bold' });
  let cursor = y - 14;

  for (const entry of entries) {
    drawDeviceSymbol(page, entry.kind, { x: x + 7, y: cursor + 2.5 }, 4);
    page.text(entry.label, x + 20, cursor, { size: 6.8 });
    cursor -= 14;
  }

  return cursor;
}

/* ----------------------------- Panel schedule ----------------------------- */

/** The panel schedule as a table, ready to sit beside the plan. */
export function drawPanelSchedule(
  page: PdfPage,
  rows: readonly ScheduleRow[],
  panel: Panel | null,
  x: number,
  y: number,
  frame: Frame,
  makePage: () => PdfPage,
): { page: PdfPage; y: number } {
  page.text('PANEL SCHEDULE', x, y, { size: 8, font: 'helvetica-bold' });
  if (panel) {
    page.text(
      `${asAmps(panel.mainAmps)} · ${panel.volts} V · ${panel.spaces} spaces`,
      x,
      y - 10,
      { size: 6.8, colour: GREY },
    );
  }

  const columns: Column[] = [
    { header: '#', width: 18 },
    { header: 'Circuit', width: 132 },
    { header: 'Breaker', width: 38, align: 'right' },
    { header: 'Wire', width: 42, align: 'right' },
    { header: 'Protection', width: 46 },
    { header: 'Load', width: 46, align: 'right' },
  ];

  const body = rows.map((row) => [
    row.circuit.reference,
    row.circuit.name,
    asAmps(row.circuit.amps),
    row.circuit.conductor,
    [row.circuit.gfci ? 'GFCI' : '', row.circuit.afci ? 'AFCI' : ''].filter(Boolean).join(' + ') || '—',
    asVoltAmperes(row.va),
  ]);

  return drawTable(page, columns, body, x, y - 20, {
    bottom: frame.y + 10,
    onOverflow: () => {
      const next = makePage();
      return { page: next, y: frame.y + frame.height - 20 };
    },
  });
}

/** The Article 220 calculation, printed with its working, beside the schedule. */
export function drawLoadCalculation(
  page: PdfPage,
  load: LoadResult,
  x: number,
  y: number,
  width: number,
): number {
  page.text('SERVICE LOAD · NEC 220.82', x, y, { size: 8, font: 'helvetica-bold' });
  let cursor = y - 14;

  const line = (label: string, working: string, section: string, value: string, bold = false) => {
    page.text(label, x, cursor, { size: 7, font: bold ? 'helvetica-bold' : 'helvetica' });
    page.text(value, x + width, cursor, {
      size: 7,
      align: 'right',
      font: bold ? 'helvetica-bold' : 'helvetica',
    });
    cursor -= 8;
    if (working) {
      const note = section ? `${working} · NEC ${section}` : working;
      page.text(note, x + 8, cursor, { size: 6, colour: GREY });
      cursor -= 8;
    }
  };

  for (const entry of load.lines) line(entry.label, entry.working, entry.section, asVoltAmperes(entry.va));

  cursor -= 3;
  page.save().lineWidth(WEIGHTS.thin).strokeColour(GREY);
  page.path([{ x, y: cursor + 6 }, { x: x + width, y: cursor + 6 }]).stroke();
  page.restore();

  line('Connected', '', '', asVoltAmperes(load.connectedVa));
  line(
    'After the demand factor',
    'first 10,000 VA in full, the rest at 40 percent, plus the larger of heating and cooling',
    '220.82',
    asVoltAmperes(load.demandVa),
  );
  line('Service required', '', '', `${load.amps.toFixed(0)} A > ${asAmps(load.serviceAmps)}`, true);

  for (const gap of load.gaps) {
    cursor -= 4;
    for (const part of wrapLine(gap, width)) {
      page.text(part, x, cursor, { size: 6, colour: GREY });
      cursor -= 7.5;
    }
  }

  return cursor;
}

/** A crude wrap for the gap notes, which are the only long text on the sheet. */
function wrapLine(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, 'helvetica', 6) <= width || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
