/**
 * The rules.
 *
 * -----------------------------------------------------------------------------
 * HOW TO ADD ONE — read this before writing a new rule.
 *
 * A rule is a pure function from one room's context to a list of findings. It
 * must obey four things, and a rule that breaks any of them makes the panel
 * worse than not having it:
 *
 *  1. STATE A MEASUREMENT. Every `detail` contains the number that failed and
 *     the number it was judged against. Without it the user cannot tell whether
 *     to care, and cannot tell whether the advisor is wrong.
 *
 *  2. NEVER FIRE ON AN EMPTY ROOM. A rule that complains about an unfurnished
 *     room is complaining that the user has not started yet. Guard on what has
 *     to be present for the question to make sense.
 *
 *  3. ONLY OFFER A FIX YOU HAVE CHECKED. Every fix in this file is validated
 *     against the same collision and containment tests a human drag goes
 *     through (`positionIsLegal`), BEFORE it is offered. An Apply button that
 *     does nothing is a bug the user experiences as the app being broken.
 *
 *  4. BE QUIET WHEN IN DOUBT. This is a rules engine, so it is confidently
 *     wrong in exactly the cases it has no rule for. A missing finding costs a
 *     little; a wrong one spent on somebody's actual home costs their trust in
 *     everything else the panel says.
 *
 * Rules also emit PRAISE. That is not decoration — a panel that only lists
 * faults gets closed and never reopened, and "the coffee table is a comfortable
 * 38 cm from the sofa" teaches the guideline far better than the complaint form
 * of the same sentence.
 * -----------------------------------------------------------------------------
 */

import { distance } from '@/scene/planGraph';
import { getCatalogEntry, resolveColorway } from '@/furniture/catalog';
import { CLEARANCE_DEFAULTS, type Level, type Point2 } from '@/state/types';
import {
  add,
  angleBetween,
  axisAngleBetween,
  blankSpans,
  distanceToWalls,
  dot,
  edgeGap,
  extentAlong,
  forwardOf,
  frontCenter,
  itemWallGap,
  positionIsLegal,
  rightOf,
  rotationFacing,
  scale,
  seatAgainst,
  spanLength,
  tablePerimeterSlots,
  type RoomWall,
} from './geometry';
import {
  blend,
  contrast,
  describeColour,
  harmoniousWall,
  hexToHsl,
  hueDistance,
  hueFamily,
  temperatureOf,
} from './colour';
import { largestOfRole, ofRole, programLabel, type PlacedItem, type RoomContext } from './rooms';
import { GUIDELINES, type Finding } from './types';

/** A rule: one room in, findings out. */
export type Rule = (context: RoomContext) => Finding[];

/* ------------------------------ Formatting ----------------------------- */

/** A length, phrased the way a person would say it out loud. */
function m(value: number): string {
  return value >= 1 ? `${value.toFixed(2)} m` : `${Math.round(value * 100)} cm`;
}

function deg(radians: number): string {
  return `${Math.round((radians * 180) / Math.PI)}°`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Builds a finding, filling in the boilerplate. */
function finding(
  context: RoomContext,
  partial: Omit<Finding, 'roomKey' | 'id'> & { id: string },
): Finding {
  return {
    ...partial,
    id: `${context.region.key}:${partial.id}`,
    roomKey: context.region.key,
  };
}

/** Where a piece stands, as a plain point. */
function at(placed: PlacedItem): Point2 {
  return { x: placed.item.x, z: placed.item.z };
}

/* ---------------------------- 1. Empty rooms --------------------------- */

/**
 * A room with nothing in it.
 *
 * Not a criticism — it is an offer. The finding carries a `furnish` fix, which
 * the panel turns into a button that opens the generator on this room, so the
 * most common state of a brand-new plan leads straight to the most useful
 * thing the advisor can do.
 */
const emptyRoom: Rule = (context) => {
  if (context.items.length > 0) return [];
  // Too small to furnish is a hallway or a cupboard, not an oversight.
  if (context.area < 4) return [];

  return [
    finding(context, {
      id: 'empty',
      rule: 'empty-room',
      category: 'empty',
      severity: 'improve',
      title: `${context.spec.name} is empty`,
      detail: `${context.area.toFixed(1)} m² of floor with nothing on it.`,
      why: 'Nothing to judge yet. If you would rather not start from a blank floor, the generator can lay out a first draft you then push around.',
      focus: { kind: 'floor', id: context.region.key },
      at: context.region.interiorPoint,
      weight: 6,
      fix: {
        kind: 'furnish',
        label: 'Furnish this room',
        roomKey: context.region.key,
        program: 'unknown',
      },
    }),
  ];
};

/* --------------------------- 2. The focal point ------------------------ */

/**
 * Does the seating face anything?
 *
 * Every room that people sit in has one thing the seats are arranged around —
 * a television, a fireplace, a view. A sofa facing an empty stretch of wall is
 * the single most common failure in an amateur layout, and it is the one that
 * makes a room feel wrong without anybody being able to say why.
 *
 * The focal candidates, in order of how strongly they pull: a television unit,
 * then the widest window. A window is a real focal point — it is why people
 * buy the flat — and a sofa with its back to the only one in the room is
 * usually a mistake rather than a choice.
 */
const seatingFocal: Rule = (context) => {
  if (context.program !== 'living') return [];
  const sofa = largestOfRole(context, 'sofa');
  if (!sofa) return [];

  const tv = largestOfRole(context, 'tvUnit');
  const widestWindow = [...context.windows].sort(
    (a, b) => b.opening.width - a.opening.width,
  )[0];

  const focal = tv
    ? { at: at(tv), name: getCatalogEntry(tv.item.catalogId).name, kind: 'tv' as const }
    : widestWindow
      ? { at: widestWindow.at, name: 'the window', kind: 'window' as const }
      : null;

  if (!focal) return [];

  const toFocal = { x: focal.at.x - sofa.item.x, z: focal.at.z - sofa.item.z };
  const span = Math.hypot(toFocal.x, toFocal.z);
  if (span < 0.4) return [];

  const wanted = rotationFacing({ x: toFocal.x / span, z: toFocal.z / span });
  const off = angleBetween(sofa.item.rotation, wanted);

  const findings: Finding[] = [];

  if (off > GUIDELINES.focalTolerance) {
    // Only offer the turn if the sofa can actually make it — rotating a long
    // sofa in a narrow room sweeps it into the walls.
    const turned = { ...sofa.box, rotation: wanted };
    const legal = positionIsLegal(context.doc, context.level, context.region, sofa.item.id, turned, false);

    findings.push(
      finding(context, {
        id: 'focal-facing',
        rule: 'seating-focal',
        category: 'focal',
        severity: off > Math.PI / 2 ? 'critical' : 'improve',
        title: `The sofa is turned away from ${focal.kind === 'tv' ? 'the television' : 'the window'}`,
        detail: `It is ${deg(off)} off ${focal.kind === 'tv' ? focal.name : 'the widest window'}; anything over ${deg(GUIDELINES.focalTolerance)} reads as facing somewhere else.`,
        why: 'Seating arranged around one focal point is what makes a room feel deliberate. A sofa aimed at a blank wall makes people sit at an angle to it without knowing why.',
        focus: { kind: 'furniture', id: sofa.item.id },
        at: at(sofa),
        weight: off > Math.PI / 2 ? 12 : 7,
        fix: legal
          ? {
              kind: 'rotate',
              label: `Turn the sofa towards ${focal.kind === 'tv' ? 'the television' : 'the window'}`,
              itemId: sofa.item.id,
              rotation: wanted,
            }
          : null,
      }),
    );
  } else if (focal.kind === 'tv') {
    // The sofa faces the television. Is it a sensible distance from it?
    const gap = edgeGap(sofa.box, largestOfRole(context, 'tvUnit')!.box);
    if (gap < GUIDELINES.tvViewing.min) {
      findings.push(
        finding(context, {
          id: 'tv-close',
          rule: 'seating-focal',
          category: 'focal',
          severity: 'polish',
          title: 'The sofa is close to the television',
          detail: `${m(gap)} between them; ${m(GUIDELINES.tvViewing.min)} to ${m(GUIDELINES.tvViewing.max)} suits most screen sizes.`,
          why: 'Too close and the screen fills more of your vision than is comfortable for a whole film; too far and subtitles become work.',
          focus: { kind: 'furniture', id: sofa.item.id },
          at: at(sofa),
          weight: 2,
          fix: null,
        }),
      );
    } else if (gap <= GUIDELINES.tvViewing.max) {
      findings.push(
        finding(context, {
          id: 'focal-good',
          rule: 'seating-focal',
          category: 'focal',
          severity: 'praise',
          title: 'The seating is arranged around the television',
          detail: `Facing it within ${deg(off)}, at ${m(gap)}.`,
          why: 'A clear focal point is the backbone of a living room layout.',
          focus: { kind: 'furniture', id: sofa.item.id },
          at: at(sofa),
          weight: 0,
          fix: null,
        }),
      );
    }
  } else {
    findings.push(
      finding(context, {
        id: 'focal-good',
        rule: 'seating-focal',
        category: 'focal',
        severity: 'praise',
        title: 'The seating looks towards the window',
        detail: `Within ${deg(off)} of facing it.`,
        why: 'With no fireplace or television, the view is the thing worth pointing the seats at.',
        focus: { kind: 'furniture', id: sofa.item.id },
        at: at(sofa),
        weight: 0,
        fix: null,
      }),
    );
  }

  return findings;
};

/* ------------------------- 3. The coffee table ------------------------- */

/**
 * Reach from the seat to the table.
 *
 * 30-45 cm is the published range and it is a genuinely tight window: at 25 cm
 * you cannot get past to sit down, and at 80 cm you have to stand up to put a
 * cup down, which defeats the object of the table.
 */
const coffeeTableReach: Rule = (context) => {
  const sofa = largestOfRole(context, 'sofa');
  const table = largestOfRole(context, 'coffeeTable');
  if (!sofa || !table) return [];

  const gap = edgeGap(sofa.box, table.box);
  const { min, max, tooFar } = GUIDELINES.coffeeTableGap;

  if (gap >= min && gap <= max) {
    return [
      finding(context, {
        id: 'coffee-good',
        rule: 'coffee-table-reach',
        category: 'conversation',
        severity: 'praise',
        title: 'The coffee table is a comfortable reach',
        detail: `${m(gap)} from the sofa; the guideline is ${m(min)} to ${m(max)}.`,
        why: 'Close enough to put a cup down without leaning, far enough to walk past.',
        focus: { kind: 'furniture', id: table.item.id },
        at: at(table),
        weight: 0,
        fix: null,
      }),
    ];
  }

  // Where the table SHOULD be: centred on the sofa, one comfortable reach off
  // its front face.
  const forward = forwardOf(sofa.item.rotation);
  const target = add(
    frontCenter(sofa.box),
    scale(forward, 0.375 + extentAlong(table.box, forward)),
  );
  const candidate = { ...table.box, center: target, rotation: sofa.item.rotation };
  const legal = positionIsLegal(context.doc, context.level, context.region, table.item.id, candidate, false);

  const tooClose = gap < min;

  return [
    finding(context, {
      id: 'coffee-reach',
      rule: 'coffee-table-reach',
      category: 'conversation',
      severity: gap > tooFar || gap < 0.12 ? 'improve' : 'polish',
      title: tooClose
        ? 'The coffee table is crowding the sofa'
        : 'The coffee table is out of reach',
      detail: `${m(Math.max(0, gap))} between them; the guideline is ${m(min)} to ${m(max)}.`,
      why: tooClose
        ? 'Under 30 cm and you have to shuffle sideways to sit down, and shins find the corner.'
        : 'Past about 45 cm you have to stand up to reach it, which is most of the reason the table is there.',
      focus: { kind: 'furniture', id: table.item.id },
      at: at(table),
      weight: gap > tooFar || gap < 0.12 ? 5 : 3,
      fix: legal
        ? {
            kind: 'move',
            label: 'Move it to a comfortable reach',
            itemId: table.item.id,
            to: target,
            rotation: sofa.item.rotation,
          }
        : null,
    }),
  ];
};

/* ------------------------ 4. The conversation group -------------------- */

/**
 * How far apart the seats are.
 *
 * Past about 2.7 m between two seats, people raise their voices slightly to
 * talk, and stop doing it — which is why a room with the sofa on one wall and
 * the armchair on the opposite one is used by two people sitting in silence
 * looking at a screen.
 */
const conversationGroup: Rule = (context) => {
  const seats = ofRole(context, 'sofa', 'armchair');
  if (seats.length < 2) return [];

  let worst: { a: PlacedItem; b: PlacedItem; span: number } | null = null;
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      const a = seats[i]!;
      const b = seats[j]!;
      const span = distance(at(a), at(b));
      if (!worst || span > worst.span) worst = { a, b, span };
    }
  }
  if (!worst) return [];

  if (worst.span <= GUIDELINES.conversationSpan) {
    return [
      finding(context, {
        id: 'conversation-good',
        rule: 'conversation-group',
        category: 'conversation',
        severity: 'praise',
        title: 'The seats are within talking distance',
        detail: `Widest gap in the group is ${m(worst.span)}; ${m(GUIDELINES.conversationSpan)} is the limit before people raise their voices.`,
        why: 'A seating group is a group only if you can hold a conversation across it at a normal volume.',
        focus: { kind: 'furniture', id: worst.b.item.id },
        at: at(worst.b),
        weight: 0,
        fix: null,
      }),
    ];
  }

  // Pull the smaller of the two in towards the larger, angled at it.
  const anchor = worst.a.area >= worst.b.area ? worst.a : worst.b;
  const mover = anchor === worst.a ? worst.b : worst.a;

  const toward = {
    x: anchor.item.x - mover.item.x,
    z: anchor.item.z - mover.item.z,
  };
  const span = Math.hypot(toward.x, toward.z);
  const unit = { x: toward.x / span, z: toward.z / span };
  // 2.4 m centre to centre leaves a comfortable group without knees touching.
  const target = add(at(anchor), scale(unit, -2.4));
  const rotation = rotationFacing(unit);
  const candidate = { ...mover.box, center: target, rotation };
  const legal = positionIsLegal(context.doc, context.level, context.region, mover.item.id, candidate, false);

  return [
    finding(context, {
      id: 'conversation-span',
      rule: 'conversation-group',
      category: 'conversation',
      severity: 'improve',
      title: 'The seats are too far apart to talk across',
      detail: `${m(worst.span)} between the two furthest seats; past ${m(GUIDELINES.conversationSpan)} people start raising their voices.`,
      why: 'Seating pushed to opposite walls makes a room look bigger in a photograph and makes it unusable for company. Pulling the chairs in is what turns furniture into a seating group.',
      focus: { kind: 'furniture', id: mover.item.id },
      at: at(mover),
      weight: 6,
      fix: legal
        ? {
            kind: 'move',
            label: `Pull the ${getCatalogEntry(mover.item.catalogId).name} into the group`,
            itemId: mover.item.id,
            to: target,
            rotation,
          }
        : null,
    }),
  ];
};

/* ------------------------------- 5. Rugs ------------------------------- */

/**
 * Whether the rug is doing its job.
 *
 * A rug's purpose in a seating area is to draw a boundary round the group. The
 * usual rule is that at minimum the front legs of every seat stand on it; a rug
 * floating in the middle of the floor with all the furniture off it is the
 * "postage stamp" mistake, and it makes the room look smaller rather than
 * larger, which is the opposite of what people buy a rug for.
 */
const rugFit: Rule = (context) => {
  const seats = ofRole(context, 'sofa', 'armchair');
  const rugs = ofRole(context, 'rug');
  const sofa = largestOfRole(context, 'sofa');

  if (rugs.length === 0) {
    // Only suggest one where a rug has a job to do.
    if (context.program !== 'living' || !sofa || context.area < 9) return [];
    return [
      finding(context, {
        id: 'rug-missing',
        rule: 'rug-fit',
        category: 'rug',
        severity: 'polish',
        title: 'There is no rug under the seating',
        detail: `${context.area.toFixed(1)} m² of bare ${context.spec.floor.presetId.replace(/-/g, ' ')}.`,
        why: 'A rug is what makes a group of separate pieces read as one seating area, and it is the cheapest way to warm up a hard floor acoustically as well as visually.',
        focus: { kind: 'furniture', id: sofa.item.id },
        at: at(sofa),
        weight: 2,
        fix: null,
      }),
    ];
  }

  const rug = rugs[0]!;
  if (seats.length === 0) return [];

  // How much of the seating actually stands on it.
  const covered = seats.filter((seat) => edgeGap(rug.box, seat.box) < -0.05);

  if (covered.length === seats.length) {
    return [
      finding(context, {
        id: 'rug-good',
        rule: 'rug-fit',
        category: 'rug',
        severity: 'praise',
        title: 'The rug anchors the seating',
        detail: `All ${seats.length} seat${seats.length === 1 ? '' : 's'} stand${seats.length === 1 ? 's' : ''} on it.`,
        why: 'A rug that reaches under the furniture pulls the group together; one that everything sits beside makes the room look smaller.',
        focus: { kind: 'furniture', id: rug.item.id },
        at: at(rug),
        weight: 0,
        fix: null,
      }),
    ];
  }

  // Centre the rug on the seating group, keeping its own orientation aligned
  // with the sofa so it reads as part of the arrangement.
  let cx = 0;
  let cz = 0;
  for (const seat of seats) {
    cx += seat.item.x;
    cz += seat.item.z;
  }
  const target = { x: cx / seats.length, z: cz / seats.length };
  const rotation = sofa ? sofa.item.rotation : rug.item.rotation;
  const candidate = { ...rug.box, center: target, rotation };
  const legal = positionIsLegal(context.doc, context.level, context.region, rug.item.id, candidate, true);

  // A rug too small to reach the whole group is a different problem from one
  // that is simply in the wrong place.
  const groupSpan = Math.max(
    ...seats.map((seat) => distance(at(seat), target)),
  );
  const rugReach = Math.max(rug.box.halfWidth, rug.box.halfDepth);
  const tooSmall = rugReach + 0.2 < groupSpan;

  if (tooSmall) {
    // The largest rug in the catalogue, if it would help and would fit.
    const bigger = 'stockholm-rug';
    const entry = getCatalogEntry(bigger);
    const swapBox = {
      center: target,
      halfWidth: entry.width / 2,
      halfDepth: entry.depth / 2,
      rotation,
    };
    const swapLegal =
      entry.width / 2 > rug.box.halfWidth &&
      positionIsLegal(context.doc, context.level, context.region, rug.item.id, swapBox, true);

    return [
      finding(context, {
        id: 'rug-small',
        rule: 'rug-fit',
        category: 'rug',
        severity: 'polish',
        title: 'The rug is too small for the seating group',
        detail: `It reaches ${m(rugReach)} from its centre; the furthest seat is ${m(groupSpan)} away, so ${covered.length} of ${seats.length} stand on it.`,
        why: 'A rug smaller than the group it sits under floats like a postage stamp and makes the whole arrangement look accidental. At minimum the front legs of every seat should be on it.',
        focus: { kind: 'furniture', id: rug.item.id },
        at: at(rug),
        weight: 3,
        fix: swapLegal
          ? { kind: 'swap', label: `Swap for a ${entry.width} × ${entry.depth} m rug`, itemId: rug.item.id, toCatalogId: bigger }
          : null,
      }),
    ];
  }

  return [
    finding(context, {
      id: 'rug-offset',
      rule: 'rug-fit',
      category: 'rug',
      severity: 'polish',
      title: 'The rug is off to one side of the seating',
      detail: `${covered.length} of ${seats.length} seats stand on it.`,
      why: 'The rug is what draws the boundary round a seating group. Off-centre, it reads as a stray object rather than as the floor of the arrangement.',
      focus: { kind: 'furniture', id: rug.item.id },
      at: at(rug),
      weight: 3,
      fix: legal
        ? { kind: 'move', label: 'Centre it under the seating', itemId: rug.item.id, to: target, rotation }
        : null,
    }),
  ];
};

/* --------------------------- 6. Wall hugging --------------------------- */

/**
 * Everything shoved against the perimeter.
 *
 * In a small room it is the right answer. In a large one it produces the
 * "bowling alley": a dead expanse of carpet in the middle and a conversation
 * group nobody can hold a conversation in. Pulling the sofa even 40 cm off the
 * wall is the standard fix and it changes a room out of all proportion to the
 * distance moved.
 */
const wallHugging: Rule = (context) => {
  if (context.area < GUIDELINES.floatingRoomArea) return [];
  const seats = ofRole(context, 'sofa', 'armchair');
  if (seats.length < 2) return [];

  const standing = context.items.filter((placed) => placed.role !== 'rug');
  if (standing.length < 3) return [];

  const gaps = standing.map((placed) => itemWallGap(placed.item, context.region));
  const floating = gaps.filter((gap) => gap > GUIDELINES.wallHugging).length;
  if (floating > 0) return [];

  const sofa = largestOfRole(context, 'sofa');
  if (!sofa) return [];

  // Pull the sofa off its wall, along the direction it faces.
  const target = add(at(sofa), scale(forwardOf(sofa.item.rotation), 0.45));
  const candidate = { ...sofa.box, center: target };
  const legal = positionIsLegal(context.doc, context.level, context.region, sofa.item.id, candidate, false);

  return [
    finding(context, {
      id: 'wall-hugging',
      rule: 'wall-hugging',
      category: 'balance',
      severity: 'improve',
      title: 'Every piece is pushed against a wall',
      detail: `All ${standing.length} pieces sit within ${m(GUIDELINES.wallHugging)} of a wall, in a ${context.area.toFixed(1)} m² room.`,
      why: 'Lining the perimeter leaves a dead void in the middle and pushes the seats too far apart to use together. In a room this size, floating one piece off the wall does more for it than any amount of rearranging along it.',
      focus: { kind: 'furniture', id: sofa.item.id },
      at: at(sofa),
      weight: 5,
      fix: legal
        ? { kind: 'move', label: 'Float the sofa off the wall', itemId: sofa.item.id, to: target }
        : null,
    }),
  ];
};

/* ---------------------------- 7. Alignment ----------------------------- */

/**
 * Nearly-square is worse than obviously-skew.
 *
 * A bookcase at 3 degrees to the wall does not read as a design choice; it
 * reads as a mistake, and it is the sort of thing that nags at a photograph
 * without anybody identifying it. Deliberately skew furniture — at 20 or 30
 * degrees — is fine and this rule leaves it alone.
 */
const alignment: Rule = (context) => {
  const findings: Finding[] = [];

  for (const placed of context.items) {
    if (placed.role === 'rug') continue;

    // The nearest wall angle, as an undirected line.
    let bestWall: RoomWall | null = null;
    let bestOff = Infinity;
    for (const wall of context.walls) {
      const off = axisAngleBetween(placed.item.rotation, wall.seatRotation);
      if (off < bestOff) {
        bestOff = off;
        bestWall = wall;
      }
    }

    if (!bestWall || bestOff <= 1e-4 || bestOff > GUIDELINES.alignmentAngle) continue;

    // Snap to whichever of the wall's two parallel headings is closer, so a
    // sofa facing into the room is not spun through 180 degrees.
    const options = [bestWall.seatRotation, bestWall.seatRotation + Math.PI];
    const snapped = options.reduce((best, option) =>
      angleBetween(placed.item.rotation, option) < angleBetween(placed.item.rotation, best)
        ? option
        : best,
    );

    const candidate = { ...placed.box, rotation: snapped };
    if (!positionIsLegal(context.doc, context.level, context.region, placed.item.id, candidate, false)) continue;

    findings.push(
      finding(context, {
        id: `align-${placed.item.id}`,
        rule: 'alignment',
        category: 'alignment',
        severity: 'polish',
        title: `${getCatalogEntry(placed.item.catalogId).name} is slightly off square`,
        detail: `${deg(bestOff)} out of parallel with the wall behind it.`,
        why: 'A few degrees off reads as sloppy rather than as a choice — the eye picks up the near-miss against the wall line. Either square it up or turn it far enough that it is obviously deliberate.',
        focus: { kind: 'furniture', id: placed.item.id },
        at: at(placed),
        weight: 1,
        fix: {
          kind: 'rotate',
          label: 'Square it to the wall',
          itemId: placed.item.id,
          rotation: snapped,
        },
      }),
    );
  }

  // One finding is a note; six is the panel shouting. Collapse the tail.
  return findings.slice(0, 3);
};

/* ------------------------------ 8. Scale ------------------------------- */

/**
 * How full the room is, and whether one piece dominates it.
 *
 * Density is footprint over floor area. Under 14% a room reads as unfinished
 * whatever is in it; over 55% you are walking sideways. Both numbers are wide
 * enough that a room has to be genuinely out at one end to trip them.
 */
const scaleRule: Rule = (context) => {
  const findings: Finding[] = [];
  const standing = context.items.filter((placed) => placed.role !== 'rug');
  if (standing.length === 0) return [];

  if (context.density > GUIDELINES.density.crowded) {
    findings.push(
      finding(context, {
        id: 'over-full',
        rule: 'scale',
        category: 'scale',
        severity: 'improve',
        title: `${context.spec.name} is overfull`,
        detail: `Furniture covers ${pct(context.density)} of the floor; over ${pct(GUIDELINES.density.crowded)} is crowded.`,
        why: 'Beyond about half the floor, the space between pieces stops being circulation and starts being gaps. Taking one piece out usually does more than moving all of them.',
        focus: { kind: 'floor', id: context.region.key },
        at: context.region.interiorPoint,
        weight: 6,
        fix: null,
      }),
    );
  } else if (context.density < GUIDELINES.density.sparse && standing.length >= 2) {
    findings.push(
      finding(context, {
        id: 'sparse',
        rule: 'scale',
        category: 'scale',
        severity: 'polish',
        title: `${context.spec.name} is under-furnished`,
        detail: `Furniture covers ${pct(context.density)} of the floor; below ${pct(GUIDELINES.density.sparse)} a room reads as unfinished.`,
        why: 'A few pieces marooned in a large floor look like they are waiting for the rest of the delivery. Grouping what is there, or adding one substantial piece, fixes it faster than buying five small ones.',
        focus: { kind: 'floor', id: context.region.key },
        at: context.region.interiorPoint,
        weight: 3,
        fix: null,
      }),
    );
  }

  // One piece eating the room.
  for (const placed of standing) {
    const widest = Math.max(placed.box.halfWidth, placed.box.halfDepth) * 2;
    const ratio = widest / context.frame.shortSpan;
    if (ratio <= GUIDELINES.dominantWidth) continue;

    findings.push(
      finding(context, {
        id: `oversized-${placed.item.id}`,
        rule: 'scale',
        category: 'scale',
        severity: 'polish',
        title: `The ${getCatalogEntry(placed.item.catalogId).name} is large for this room`,
        detail: `${m(widest)} across, in a room ${m(context.frame.shortSpan)} wide — ${pct(ratio)} of the short dimension.`,
        why: 'A piece taking more than about two-thirds of the narrow dimension leaves no room either side, so the room reads as a corridor around the furniture.',
        focus: { kind: 'furniture', id: placed.item.id },
        at: at(placed),
        weight: 2,
        fix: null,
      }),
    );
    // One is enough to make the point.
    break;
  }

  return findings;
};

/* ----------------------------- 9. Lighting ----------------------------- */

/**
 * Layers of light.
 *
 * A single ceiling fitting lights a room evenly and flatly, which is exactly
 * what you want in a kitchen and exactly what you do not want anywhere people
 * relax. Two or three pools of light at different heights are what make a room
 * look like the photograph rather than like the estate agent's listing.
 *
 * The fix places a floor lamp in the emptiest corner it can find, checked for
 * legality before it is offered.
 */
const lightingLayers: Rule = (context) => {
  if (context.program === 'unknown' || context.area < GUIDELINES.needsLampArea) return [];
  if (context.items.length === 0) return [];

  const lamps = ofRole(context, 'floorLamp', 'tableLamp');
  const wanted = context.area >= GUIDELINES.needsSecondLampArea ? 2 : 1;
  if (lamps.length >= wanted) {
    if (lamps.length >= 2) {
      return [
        finding(context, {
          id: 'lighting-good',
          rule: 'lighting-layers',
          category: 'lighting',
          severity: 'praise',
          title: 'The room has more than one source of light',
          detail: `${lamps.length} lamps besides the ceiling fitting.`,
          why: 'Several pools of light at different heights are what stop a room looking flat after dark.',
          focus: { kind: 'furniture', id: lamps[0]!.item.id },
          at: at(lamps[0]!),
          weight: 0,
          fix: null,
        }),
      ];
    }
    return [];
  }

  const spot = findLampSpot(context);

  return [
    finding(context, {
      id: 'lighting-layers',
      rule: 'lighting-layers',
      category: 'lighting',
      severity: 'polish',
      title:
        lamps.length === 0
          ? 'Nothing lights this room but the ceiling'
          : 'One lamp for a room this size',
      detail: `${context.area.toFixed(1)} m² with ${lamps.length} lamp${lamps.length === 1 ? '' : 's'}; ${wanted} or more suits a room past ${GUIDELINES.needsLampArea} m².`,
      why: 'A single overhead light flattens everything under it and throws shadows straight down faces. Two or three lower sources give a room depth after dark, and it is the cheapest change on this list.',
      focus: { kind: 'floor', id: context.region.key },
      at: context.region.interiorPoint,
      weight: 2,
      fix: spot
        ? {
            kind: 'add',
            label: 'Add a floor lamp',
            catalogId: 'hektar-floor',
            at: spot.at,
            rotation: spot.rotation,
          }
        : null,
    }),
  ];
};

/**
 * Somewhere a floor lamp can stand: a corner, out of the traffic.
 *
 * Corners are tried first because that is where a floor lamp belongs — beside
 * a seat, against the angle of two walls, where it lights the room without
 * anybody walking into it.
 */
function findLampSpot(context: RoomContext): { at: Point2; rotation: number } | null {
  const entry = getCatalogEntry('hektar-floor');
  const half = Math.max(entry.width, entry.depth) / 2;
  const inset = half + 0.12;

  const candidates: Point2[] = [];

  // Room corners, pulled inside by the lamp's own radius.
  const polygon = context.region.polygon;
  for (let i = 0; i < polygon.length; i++) {
    const corner = polygon[i]!;
    const prev = polygon[(i - 1 + polygon.length) % polygon.length]!;
    const next = polygon[(i + 1) % polygon.length]!;
    const inA = normalizeSafe({ x: prev.x - corner.x, z: prev.z - corner.z });
    const inB = normalizeSafe({ x: next.x - corner.x, z: next.z - corner.z });
    const bisector = normalizeSafe(add(inA, inB));
    if (bisector.x === 0 && bisector.z === 0) continue;
    candidates.push(add(corner, scale(bisector, inset * 1.6)));
  }

  // Then beside each seat, which is where a reading lamp actually earns its
  // place.
  for (const seat of ofRole(context, 'sofa', 'armchair')) {
    const side = rightOf(seat.item.rotation);
    for (const sign of [1, -1]) {
      candidates.push(
        add(at(seat), scale(side, sign * (seat.box.halfWidth + half + 0.12))),
      );
    }
  }

  for (const candidate of candidates) {
    const box = { center: candidate, halfWidth: half, halfDepth: half, rotation: 0 };
    if (distanceToWalls(candidate, context.region) < half + 0.05) continue;
    if (!positionIsLegal(context.doc, context.level, context.region, null, box, false)) continue;
    // Face the middle of the room, so a shaded lamp throws light inwards.
    const toCenter = {
      x: context.region.interiorPoint.x - candidate.x,
      z: context.region.interiorPoint.z - candidate.z,
    };
    const unit = normalizeSafe(toCenter);
    return {
      at: candidate,
      rotation: unit.x === 0 && unit.z === 0 ? 0 : rotationFacing(unit),
    };
  }

  return null;
}

function normalizeSafe(v: Point2): Point2 {
  const span = Math.hypot(v.x, v.z);
  if (span < 1e-9) return { x: 0, z: 0 };
  return { x: v.x / span, z: v.z / span };
}

/* ------------------------------ 10. Colour ----------------------------- */

/**
 * The palette.
 *
 * Three mechanical checks only — contrast, temperature, and how many hue
 * families are in play. Anything past that is taste, and a rules engine
 * pronouncing on taste is how you get a tool nobody believes.
 */
const palette: Rule = (context) => {
  const findings: Finding[] = [];
  const wall = context.spec.wall.color;
  const floor = context.spec.floor;
  const floorColour = floorSwatch(floor.presetId, floor.color);

  const separation = contrast(wall, floorColour);
  if (separation < GUIDELINES.contrastFloor) {
    const suggestion = harmoniousWall(FLOOR_SWATCHES[floor.presetId] ?? '#b0a89c', floor.color);
    findings.push(
      finding(context, {
        id: 'colour-contrast',
        rule: 'palette',
        category: 'colour',
        severity: 'improve',
        title: 'The walls and floor are almost the same brightness',
        detail: `Luminance differs by ${separation.toFixed(2)}; below ${GUIDELINES.contrastFloor} two surfaces read as one.`,
        why: `A ${describeColour(wall)} wall over a ${describeColour(floorColour)} floor gives the eye no line to read the room's shape by. Lifting the walls a couple of tones is usually all it takes.`,
        focus: { kind: 'floor', id: context.region.key },
        at: context.region.interiorPoint,
        weight: 4,
        fix: {
          kind: 'paint',
          label: 'Lift the walls a few tones',
          roomKey: context.region.key,
          color: suggestion,
        },
      }),
    );
  }

  // Saturated paint on every wall of a small room.
  const wallHsl = hexToHsl(wall);
  if (wallHsl.s > 0.45 && wallHsl.l < 0.6 && context.area < 14) {
    findings.push(
      finding(context, {
        id: 'colour-strong',
        rule: 'palette',
        category: 'colour',
        severity: 'polish',
        title: 'Strong colour on every wall of a small room',
        detail: `${describeColour(wall)} at ${pct(wallHsl.s)} saturation, in ${context.area.toFixed(1)} m².`,
        why: 'A deep colour on all four walls of a small room closes it in. The usual answer is to keep it on one wall and take the others two or three tones lighter in the same hue — the colour still reads, the room still breathes.',
        focus: { kind: 'floor', id: context.region.key },
        at: context.region.interiorPoint,
        weight: 2,
        fix: null,
      }),
    );
  }

  /*
   * How many hue families the SOFT furnishings introduce.
   *
   * Upholstery, rug pile and cushions only — not frames. A scheme's colours
   * live in its textiles; the timber is a material rather than a colour choice,
   * and counting oak as "orange" would report every furnished room as busy.
   */
  const families = new Set<string>();
  for (const placed of context.items) {
    const colourway = resolveColorway(placed.entry, placed.item.colorwayId);
    const family = hueFamily(colourway.soft);
    if (family === 'neutral' || family === 'white' || family === 'black') continue;
    families.add(family);
  }

  if (families.size > GUIDELINES.paletteHues) {
    findings.push(
      finding(context, {
        id: 'colour-busy',
        rule: 'palette',
        category: 'colour',
        severity: 'polish',
        title: 'The furniture introduces a lot of separate colours',
        detail: `${families.size} hue families in play (${[...families].join(', ')}); past ${GUIDELINES.paletteHues} a room stops having a palette.`,
        why: 'A scheme usually survives on one dominant colour, one supporting it, and one accent. Repeating a colour in two or three places is what makes a room look assembled rather than accumulated.',
        focus: { kind: 'floor', id: context.region.key },
        at: context.region.interiorPoint,
        weight: 2,
        fix: null,
      }),
    );
  }

  // A warm/cool clash where both sides are committed to it.
  const wallTemp = temperatureOf(wall);
  const floorTemp = temperatureOf(floorColour);
  if (
    wallTemp !== 'neutral' &&
    floorTemp !== 'neutral' &&
    wallTemp !== floorTemp &&
    hueDistance(hexToHsl(wall).h, hexToHsl(floorColour).h) > 100
  ) {
    findings.push(
      finding(context, {
        id: 'colour-temperature',
        rule: 'palette',
        category: 'colour',
        severity: 'polish',
        title: `A ${wallTemp} wall over a ${floorTemp} floor`,
        detail: `${describeColour(wall)} against ${describeColour(floorColour)}, ${Math.round(hueDistance(hexToHsl(wall).h, hexToHsl(floorColour).h))}° apart on the wheel.`,
        why: 'Warm against cool is a real scheme, not a fault — but it needs something to bridge it. A textile or a wood tone picking up the wall colour stops the floor and the walls arguing.',
        focus: { kind: 'floor', id: context.region.key },
        at: context.region.interiorPoint,
        weight: 1,
        fix: null,
      }),
    );
  }

  return findings;
};

/**
 * The colour a floor actually reads as: its preset's swatch, times the tint.
 *
 * The stored `floor.color` is a MULTIPLIER over a generated texture, so on its
 * own it says nothing — an untinted floor stores `#ffffff`, which is not a
 * white floor. Judging the walls against that value rather than against the
 * tinted preset would have the advisor comparing them to a colour nobody can
 * see.
 */
function floorSwatch(presetId: string, tint: string): string {
  return blend(FLOOR_SWATCHES[presetId] ?? '#b0a89c', tint);
}

/**
 * The dominant colour of each floor preset.
 *
 * Duplicated from `scene/materials/presets.ts` rather than imported, because
 * that module pulls in the texture generators and, through them, Three.js. The
 * advisor is deliberately renderer-free so it can run under Node in the tests
 * and, later, wherever else it is useful. The values are the presets' own
 * `swatchColor`, and the test in `advisor.test.ts` fails if the two ever drift.
 */
export const FLOOR_SWATCHES: Record<string, string> = {
  'oak-plank': '#b98b57',
  'walnut-plank': '#5d3a24',
  'ash-plank': '#d9c6ac',
  'porcelain-tile': '#cdc9c2',
  'checker-tile': '#8f8f92',
  'carrara-marble': '#e6e6e3',
  'polished-concrete': '#9d9d9c',
  'wool-carpet': '#b3a897',
  'charcoal-carpet': '#4a4a4e',
};

/* ---------------------------- 11. The bedroom -------------------------- */

/**
 * Where the bed goes.
 *
 * Two checks that matter and one that does not need repeating. The headboard
 * wants a wall — a bed floating in the middle of a room has nowhere to put a
 * lamp and nothing to sit up against — and a bed under a window is the classic
 * mistake: it is the coldest, draughtiest wall, it makes the curtains
 * impossible, and it wastes the one wall in the room the bed could have used.
 *
 * Side access is left to the clearance panel, which already measures it
 * properly, rather than saying the same thing twice in two panels.
 */
const bedPlacement: Rule = (context) => {
  const bed = largestOfRole(context, 'bed');
  if (!bed) return [];

  const findings: Finding[] = [];

  // Distance from the bed's BACK face (the headboard) to the nearest wall.
  const back = add(at(bed), scale(forwardOf(bed.item.rotation), -bed.box.halfDepth));
  const headboardGap = distanceToWalls(back, context.region);

  // Which wall the head of the bed is against, if any.
  const headWall = context.walls.find((wall) => {
    const toFace = { x: back.x - wall.faceStart.x, z: back.z - wall.faceStart.z };
    const out = Math.abs(dot(toFace, wall.inward));
    const along = dot(toFace, {
      x: wall.faceEnd.x - wall.faceStart.x,
      z: wall.faceEnd.z - wall.faceStart.z,
    }) / Math.max(1e-6, wall.length);
    return out < 0.3 && along > -0.2 && along < wall.length + 0.2;
  });

  if (headboardGap > GUIDELINES.headboardGap) {
    const spot = bestBedWall(context, bed);
    findings.push(
      finding(context, {
        id: 'bed-floating',
        rule: 'bed-placement',
        category: 'sleep',
        severity: 'improve',
        title: 'The headboard is not against a wall',
        detail: `${m(headboardGap)} of floor behind the head of the bed; anything over ${m(GUIDELINES.headboardGap)} reads as floating.`,
        why: 'A bed takes its position in the room from the wall behind it — that is where the lamps, the sockets and the sitting-up-in-bed all come from. Floating one leaves a strip of floor behind it that never gets used.',
        focus: { kind: 'furniture', id: bed.item.id },
        at: at(bed),
        weight: 7,
        fix: spot
          ? {
              kind: 'move',
              label: 'Put the headboard against the longest wall',
              itemId: bed.item.id,
              to: spot.at,
              rotation: spot.rotation,
            }
          : null,
      }),
    );
  } else if (headWall?.hasWindow) {
    const spot = bestBedWall(context, bed);
    findings.push(
      finding(context, {
        id: 'bed-window',
        rule: 'bed-placement',
        category: 'sleep',
        severity: 'improve',
        title: 'The bed is under a window',
        detail: 'The wall behind the headboard is pierced by a window.',
        why: 'It is the coldest and draughtiest wall in the room, the curtains cannot be drawn behind a headboard, and it spends the one wall a bed most wants on a wall it cannot use properly.',
        focus: { kind: 'furniture', id: bed.item.id },
        at: at(bed),
        weight: 6,
        fix: spot
          ? {
              kind: 'move',
              label: 'Move the bed to a blank wall',
              itemId: bed.item.id,
              to: spot.at,
              rotation: spot.rotation,
            }
          : null,
      }),
    );
  } else {
    findings.push(
      finding(context, {
        id: 'bed-good',
        rule: 'bed-placement',
        category: 'sleep',
        severity: 'praise',
        title: 'The bed is against a solid wall',
        detail: `Headboard ${m(headboardGap)} off the wall, with no window behind it.`,
        why: 'The wall behind the headboard is what a bedroom is arranged around.',
        focus: { kind: 'furniture', id: bed.item.id },
        at: at(bed),
        weight: 0,
        fix: null,
      }),
    );
  }

  // Bedside tables, in pairs where the bed is big enough for two.
  const bedsides = ofRole(context, 'sideTable', 'chest').filter(
    (placed) => distance(at(placed), at(bed)) < bed.box.halfWidth + bed.box.halfDepth,
  );
  if (bed.box.halfWidth * 2 >= 1.3 && bedsides.length < 2 && context.area >= 9) {
    findings.push(
      finding(context, {
        id: 'bed-sides',
        rule: 'bed-placement',
        category: 'sleep',
        severity: 'polish',
        title:
          bedsides.length === 0
            ? 'No bedside table'
            : 'Only one side of the bed has a table',
        detail: `A ${m(bed.box.halfWidth * 2)} bed with ${bedsides.length} bedside${bedsides.length === 1 ? '' : 's'}.`,
        why: 'A double bed used by two people needs a surface on each side, and the symmetry of a matched pair is most of what makes a bedroom look settled.',
        focus: { kind: 'furniture', id: bed.item.id },
        at: at(bed),
        weight: 2,
        fix: null,
      }),
    );
  }

  return findings;
};

/**
 * The best wall to put a bed against: longest blank stretch, no window.
 *
 * Returns the bed's centre position and rotation, validated, or null when
 * nothing better than where it already is can be found.
 */
function bestBedWall(
  context: RoomContext,
  bed: PlacedItem,
): { at: Point2; rotation: number } | null {
  const needed = bed.box.halfWidth * 2;
  const candidates: Array<{ at: Point2; rotation: number; score: number }> = [];

  for (const wall of context.walls) {
    // A window behind the headboard is the thing we are trying to avoid.
    const penalty = wall.hasWindow ? 100 : wall.hasDoor ? 20 : 0;
    for (const span of blankSpans(wall, 0.1, needed)) {
      if (spanLength(span) < needed) continue;
      const middle = (span.from + span.to) / 2;
      const center = seatAgainst(wall, middle, bed.box.halfDepth, 0.02);
      const rotation = wall.seatRotation;
      const box = { ...bed.box, center, rotation };
      if (!positionIsLegal(context.doc, context.level, context.region, bed.item.id, box, false)) continue;
      // Prefer the longest blank wall, and heavily prefer one with no window.
      candidates.push({ at: center, rotation, score: spanLength(span) - penalty });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best && best.score > 0 ? { at: best.at, rotation: best.rotation } : null;
}

/* --------------------------- 12. The workspace ------------------------- */

/**
 * Desk, chair and daylight.
 *
 * The one that matters is glare. A window directly in front of a desk puts a
 * bright field behind the screen and your eyes spend the day adjusting between
 * the two; a window directly behind you reflects off it. A window to one side
 * is what every ergonomics guide recommends and what nobody arranges by
 * accident.
 */
const workspace: Rule = (context) => {
  const desk = largestOfRole(context, 'desk');
  if (!desk) return [];

  const findings: Finding[] = [];

  // A chair to sit at it.
  const chairs = ofRole(context, 'taskChair', 'diningChair', 'armchair').filter(
    (placed) => distance(at(placed), at(desk)) < 1.4,
  );
  if (chairs.length === 0) {
    // Behind the desk: a desk faces the user, so the chair goes on its +Z side.
    const forward = forwardOf(desk.item.rotation);
    const entry = getCatalogEntry('markus-chair');
    const spot = add(at(desk), scale(forward, desk.box.halfDepth + entry.depth / 2 + 0.08));
    const box = {
      center: spot,
      halfWidth: entry.width / 2,
      halfDepth: entry.depth / 2,
      rotation: desk.item.rotation + Math.PI,
    };
    const legal = positionIsLegal(context.doc, context.level, context.region, null, box, false);

    findings.push(
      finding(context, {
        id: 'desk-chair',
        rule: 'workspace',
        category: 'work',
        severity: 'improve',
        title: 'There is no chair at the desk',
        detail: `Nothing to sit on within ${m(1.4)} of the ${getCatalogEntry(desk.item.catalogId).name}.`,
        why: 'A desk is furniture; a desk and a chair is a workspace. It also changes the clearance the desk needs, which is why it is worth placing rather than assuming.',
        focus: { kind: 'furniture', id: desk.item.id },
        at: at(desk),
        weight: 4,
        fix: legal
          ? {
              kind: 'add',
              label: 'Add a desk chair',
              catalogId: 'markus-chair',
              at: spot,
              rotation: desk.item.rotation + Math.PI,
            }
          : null,
      }),
    );
  }

  // Glare. The user sits behind the desk facing its front, so the screen faces
  // the same way the desk does.
  const screenDirection = forwardOf(desk.item.rotation);
  for (const window of context.windows) {
    const toWindow = { x: window.at.x - desk.item.x, z: window.at.z - desk.item.z };
    const span = Math.hypot(toWindow.x, toWindow.z);
    if (span < 0.3 || span > 5) continue;
    const unit = { x: toWindow.x / span, z: toWindow.z / span };
    const alignment = dot(unit, screenDirection);

    // Directly ahead of the desk = behind the user = reflections on the screen.
    if (alignment > 0.75) {
      findings.push(
        finding(context, {
          id: 'desk-reflection',
          rule: 'workspace',
          category: 'work',
          severity: 'polish',
          title: 'A window sits behind whoever uses the desk',
          detail: `The window is ${m(span)} away, ${deg(Math.acos(Math.min(1, alignment)))} off straight behind the seat.`,
          why: 'Daylight over your shoulder lands on the screen as a reflection you cannot turn down. Turning the desk so the window is to one side fixes both this and the glare problem.',
          focus: { kind: 'furniture', id: desk.item.id },
          at: at(desk),
          weight: 2,
          fix: null,
        }),
      );
      break;
    }

    // Directly behind the desk = in front of the user = backlit screen.
    if (alignment < -0.75) {
      findings.push(
        finding(context, {
          id: 'desk-glare',
          rule: 'workspace',
          category: 'work',
          severity: 'improve',
          title: 'The desk faces straight into a window',
          detail: `The window is ${m(span)} directly ahead of the screen.`,
          why: 'Your eyes spend the day adjusting between a bright window and a dim screen, which is the most reliable way to get a headache from a desk. A window to the left or right of the screen is what every ergonomics guide asks for.',
          focus: { kind: 'furniture', id: desk.item.id },
          at: at(desk),
          weight: 4,
          fix: null,
        }),
      );
      break;
    }
  }

  return findings;
};

/* ---------------------------- 13. The dining --------------------------- */

/**
 * Chairs round the table.
 *
 * Two things: are there enough of them for the table, and are they actually
 * arranged around it. The second is the satisfying one — a redistribute fix
 * that spaces every chair evenly round the perimeter, facing in.
 */
const dining: Rule = (context) => {
  const table = largestOfRole(context, 'diningTable');
  if (!table) return [];

  const findings: Finding[] = [];
  const chairs = ofRole(context, 'diningChair');

  // How many a table this size seats: roughly 60 cm of edge per person, on the
  // two long sides plus one at each end where there is room.
  const width = table.box.halfWidth * 2;
  const depth = table.box.halfDepth * 2;
  const seats = Math.max(2, Math.floor(width / 0.6) * 2 + (depth >= 0.9 ? 2 : 0));

  if (chairs.length < seats - 1) {
    findings.push(
      finding(context, {
        id: 'dining-chairs',
        rule: 'dining',
        category: 'dining',
        severity: 'polish',
        title: 'The table has fewer chairs than it seats',
        detail: `${chairs.length} chair${chairs.length === 1 ? '' : 's'} at a ${m(width)} × ${m(depth)} table, which seats about ${seats} at 60 cm each.`,
        why: 'A dining table is sized for the number of people it feeds. Half the chairs makes the table look like it is waiting for the rest of them.',
        focus: { kind: 'furniture', id: table.item.id },
        at: at(table),
        weight: 2,
        fix: null,
      }),
    );
  }

  // Are the chairs actually round the table?
  const strays = chairs.filter((chair) => edgeGap(table.box, chair.box) > 0.5);
  if (strays.length > 0 && chairs.length > 0) {
    const moves = distributeChairs(context, table, chairs);
    findings.push(
      finding(context, {
        id: 'dining-scatter',
        rule: 'dining',
        category: 'dining',
        severity: 'improve',
        title: `${strays.length} chair${strays.length === 1 ? ' is' : 's are'} not at the table`,
        detail: `${strays.length} of ${chairs.length} sit more than ${m(0.5)} from its edge.`,
        why: 'Chairs pushed in evenly round a table are what makes a dining room look laid rather than abandoned, and it is the difference between a table you can seat six at and one you have to set up first.',
        focus: { kind: 'furniture', id: strays[0]!.item.id },
        at: at(strays[0]!),
        weight: 4,
        fix:
          moves.length > 0
            ? { kind: 'moveMany', label: 'Set the chairs round the table', moves }
            : null,
      }),
    );
  } else if (chairs.length >= 2) {
    findings.push(
      finding(context, {
        id: 'dining-good',
        rule: 'dining',
        category: 'dining',
        severity: 'praise',
        title: 'The chairs are set round the table',
        detail: `${chairs.length} chairs, all within ${m(0.5)} of its edge.`,
        why: 'A set table reads as a room in use.',
        focus: { kind: 'furniture', id: table.item.id },
        at: at(table),
        weight: 0,
        fix: null,
      }),
    );
  }

  return findings;
};

/**
 * Even positions for chairs around a table.
 *
 * Walks the table's perimeter in the table's own frame, so a table drawn at an
 * angle gets chairs at that angle rather than at the world grid's. Any position
 * that will not validate is dropped rather than forced; a fix that moves five
 * chairs correctly and buries the sixth in a wall is not an improvement.
 */
function distributeChairs(
  context: RoomContext,
  table: PlacedItem,
  chairs: PlacedItem[],
): Array<{ itemId: string; to: Point2; rotation?: number }> {
  const chairDepth = chairs[0] ? chairs[0].box.halfDepth : 0.25;
  const perimeter = tablePerimeterSlots(table.box, chairDepth);

  // Assign each chair to its nearest free slot, so the ones already in the
  // right place barely move.
  const taken = new Set<number>();
  const moves: Array<{ itemId: string; to: Point2; rotation?: number }> = [];
  const excluded = new Set(chairs.map((chair) => chair.item.id));

  for (const chair of chairs) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < perimeter.length; i++) {
      if (taken.has(i)) continue;
      const span = distance(at(chair), perimeter[i]!.at);
      if (span < bestDistance) {
        bestDistance = span;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) continue;

    const slot = perimeter[bestIndex]!;
    const box = { ...chair.box, center: slot.at, rotation: slot.rotation };
    // Chairs are checked against everything EXCEPT the other chairs being moved
    // in the same operation, since those are about to vacate their positions.
    if (!legalIgnoring(context, chair.item.id, box, excluded)) continue;

    taken.add(bestIndex);
    if (bestDistance > 0.02) {
      moves.push({ itemId: chair.item.id, to: slot.at, rotation: slot.rotation });
    }
  }

  return moves;
}

/** Legality with a set of items treated as absent. */
function legalIgnoring(
  context: RoomContext,
  itemId: string,
  box: { center: Point2; halfWidth: number; halfDepth: number; rotation: number },
  ignore: ReadonlySet<string>,
): boolean {
  // The other chairs are about to vacate their places, so they are treated as
  // absent while the arrangement is checked.
  const trimmed: Level = {
    ...context.level,
    furniture: context.level.furniture.filter(
      (item) => item.id === itemId || !ignore.has(item.id),
    ),
  };
  return positionIsLegal(context.doc, trimmed, context.region, itemId, box, false);
}

/* --------------------------- 14. Circulation --------------------------- */

/**
 * A route through the room.
 *
 * The clearance panel already reports this in detail. The advisor repeats it
 * only when it is genuinely bad — below the tight-squeeze threshold, not merely
 * below the ideal — because a design score that ignored whether you can walk
 * through the room would be scoring the photograph rather than the home.
 */
const circulation: Rule = (context) => {
  const report = context.circulation;
  if (!report || context.items.length === 0) return [];

  const target = context.doc.clearance.walkwayWidth;

  // Each grid cell is 10 cm square. A handful of stray cells behind a bookcase
  // is measurement noise; a real marooned pocket is a fifth of a square metre.
  const maroonedArea = report.marooned.length * CLEARANCE_DEFAULTS.gridCell ** 2;

  if (maroonedArea >= 0.2) {
    return [
      finding(context, {
        id: 'circulation-marooned',
        rule: 'circulation',
        category: 'circulation',
        severity: 'critical',
        title: 'Part of the floor cannot be reached',
        detail: `${maroonedArea.toFixed(1)} m² is walled in by the furniture around it.`,
        why: 'Floor you cannot walk to is floor you do not have. This is the one thing on this list that is not a matter of taste — everything else here is guidance you are free to overrule.',
        focus: { kind: 'floor', id: context.region.key },
        at: report.marooned[0] ?? context.region.interiorPoint,
        weight: 14,
        fix: null,
      }),
    ];
  }

  if (report.narrowestRoute > 0 && report.narrowestRoute < CLEARANCE_DEFAULTS.walkwayTight) {
    return [
      finding(context, {
        id: 'circulation-tight',
        rule: 'circulation',
        category: 'circulation',
        severity: 'improve',
        title: 'The route through the room is a squeeze',
        detail: `Narrowest point on the main route is ${m(report.narrowestRoute)}; your walkway setting is ${m(target)} and ${m(CLEARANCE_DEFAULTS.walkwayTight)} is the point at which people turn sideways.`,
        why: 'The path through a room is furniture in its own right. Below about 75 cm two people cannot pass, and everybody starts taking the long way round without noticing they are doing it.',
        focus: { kind: 'floor', id: context.region.key },
        at: report.pinchPoints[0] ?? context.region.interiorPoint,
        weight: 6,
        fix: null,
      }),
    ];
  }

  return [];
};

/* ------------------------------ The set -------------------------------- */

/**
 * Every rule, in the order their findings are grouped.
 *
 * Order here is presentation only — the report sorts by severity — but keeping
 * related rules adjacent means a room's findings read as a coherent critique
 * rather than as a shuffled list.
 */
export const RULES: readonly Rule[] = [
  emptyRoom,
  circulation,
  seatingFocal,
  conversationGroup,
  coffeeTableReach,
  rugFit,
  wallHugging,
  bedPlacement,
  workspace,
  dining,
  scaleRule,
  lightingLayers,
  palette,
  alignment,
];

/** Exported for the tests, which check each rule in isolation. */
export const RULES_BY_NAME = {
  emptyRoom,
  circulation,
  seatingFocal,
  conversationGroup,
  coffeeTableReach,
  rugFit,
  wallHugging,
  bedPlacement,
  workspace,
  dining,
  scaleRule,
  lightingLayers,
  palette,
  alignment,
} as const;

/** Exposed so `advise.ts` can name the program in whole-design findings. */
export { programLabel };
