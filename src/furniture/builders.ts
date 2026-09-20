/**
 * Procedural furniture geometry.
 *
 * Same principle as the floor materials in session 1: generated in code rather
 * than loaded from asset files. No licences to track, no megabytes in the repo,
 * instant load, and — the part that matters most here — every piece is built
 * FROM ITS DIMENSIONS, so the catalogue's real measurements drive the geometry
 * instead of merely labelling it. A 228 cm KIVIK and a 180 cm KLIPPAN are the
 * same builder given different numbers, and both are exactly the size they say.
 *
 * Each builder returns parts tagged with a material role rather than meshes, so
 * the caller can merge everything sharing a role into one buffer. A sofa is
 * roughly 20 boxes but costs three draw calls.
 *
 * LOCAL FRAME
 *   +X  the piece's width, centred on zero
 *   +Y  up, with y = 0 at the floor
 *   +Z  the piece's depth — and the direction it FACES
 *
 * "Faces +Z" is a real contract, not a convention: `snapToWall` rotates a piece
 * so its +Z points into the room, so a sofa whose seat faces -Z would end up
 * staring at the wall.
 */

import * as THREE from 'three';

import { chamferedBox } from '@/scene/millwork';
import { circleSection, lathe, roundedRectSection, sweep, taperedProfile } from '@/scene/profiles';
import { cornerSegments, radialSegments as segmentsFor } from '@/scene/tessellation';

import { buildFoot, buildHandle, buildLeg, type FootStyle, type HandleStyle, type LegStyle } from './legs';
import type { BuildSpec } from './catalog';

/** Which material a part is drawn with. */
/**
 * What a part is made of, as far as the renderer is concerned.
 *
 * `clutter` and `foliage` belong to the things left ON furniture rather than to
 * the furniture itself, and they are separate roles for a reason that is not
 * cosmetic: a mug must not take the sofa's colourway. Changing an armchair from
 * grey to teal should not turn the book on the table teal as well, and it would
 * if clutter borrowed any of the four roles a piece's colourway drives.
 */
export type MaterialRole =
  | 'frame'
  | 'soft'
  | 'accent'
  | 'glass'
  | 'shade'
  | 'clutter'
  | 'foliage';

export interface FurniturePart {
  geometry: THREE.BufferGeometry;
  role: MaterialRole;
}

/** Dimensions a piece is built to, in metres. */
export interface BuildDimensions {
  width: number;
  depth: number;
  height: number;
}

/* ------------------------------- Primitives ---------------------------- */

/** A box spanning the given min/max corners, in local space. */
function box(
  min: [number, number, number],
  max: [number, number, number],
  role: MaterialRole,
): FurniturePart {
  const size: [number, number, number] = [
    Math.max(1e-4, max[0] - min[0]),
    Math.max(1e-4, max[1] - min[1]),
    Math.max(1e-4, max[2] - min[2]),
  ];
  const geometry = chamferedBox(size[0], size[1], size[2]);
  geometry.translate(min[0] + size[0] / 2, min[1] + size[1] / 2, min[2] + size[2] / 2);
  return { geometry, role };
}

/**
 * An upholstered form: a cushion, an arm, a padded back.
 *
 * -----------------------------------------------------------------------------
 * ROUNDED IN ONE PLANE IS NOT ROUNDED.
 *
 * The first version of this extruded a rounded rectangle straight through the
 * depth with no bevel, which softens four edges out of twelve and leaves the
 * front and back faces meeting their sides at a right angle. Seen from the
 * front — which is how a sofa is almost always seen — that is a crate with
 * rounded ends, and the silhouette against the wall behind it is a hard
 * rectangle.
 *
 * `bevelEnabled` rounds the other eight. It is the same mechanism the fielded
 * door panel uses, and the same caution applies: `bevelSize` EXPANDS the middle
 * of the extrusion outward rather than insetting the ends, so the profile has
 * to be drawn smaller by the bevel and swells back to the size asked for.
 *
 * -----------------------------------------------------------------------------
 * AND A CUSHION IS NOT A ROUNDED BOX EITHER.
 *
 * A filled cushion is fatter in the middle than at its edges, because that is
 * where the filling has room to go. The barrel here is slight — a few per cent
 * — and it is the difference between upholstery and a mattress-shaped solid.
 * Overdo it and it reads as a balloon, which is worse than a box.
 */
function cushion(
  min: [number, number, number],
  max: [number, number, number],
  role: MaterialRole,
  radius = 0.03,
): FurniturePart {
  const size: [number, number, number] = [
    Math.max(1e-4, max[0] - min[0]),
    Math.max(1e-4, max[1] - min[1]),
    Math.max(1e-4, max[2] - min[2]),
  ];

  /*
   * The round, clamped so a thin cushion does not become a cylinder.
   *
   * A seat cushion is 120 mm thick and a 30 mm round on a 120 mm dimension is
   * already a quarter of it; anything past a third leaves no flat at all and
   * the form stops reading as a panel with soft edges.
   */
  const r = Math.min(radius, size[0] / 2.2, size[1] / 2.2, size[2] / 2.2);
  const depth = Math.max(1e-4, size[2] - r * 2);

  /*
   * The profile is drawn inset by the bevel and swells back out to `size`.
   *
   * Corners of the rounded rectangle are drawn at `r` again, so the finished
   * form has the same round in every direction — which is what stops one axis
   * looking deliberately different from the others.
   */
  const halfX = size[0] / 2 - r;
  const halfY = size[1] / 2 - r;
  const shape = new THREE.Shape();
  shape.moveTo(-halfX + r, -halfY);
  shape.lineTo(halfX - r, -halfY);
  shape.quadraticCurveTo(halfX, -halfY, halfX, -halfY + r);
  shape.lineTo(halfX, halfY - r);
  shape.quadraticCurveTo(halfX, halfY, halfX - r, halfY);
  shape.lineTo(-halfX + r, halfY);
  shape.quadraticCurveTo(-halfX, halfY, -halfX, halfY - r);
  shape.lineTo(-halfX, -halfY + r);
  shape.quadraticCurveTo(-halfX, -halfY, -halfX + r, -halfY);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: r,
    bevelSize: r,
    bevelOffset: 0,
    bevelSegments: cornerSegments(r),
    curveSegments: cornerSegments(r) + 1,
    steps: 1,
  });

  /*
   * The barrel: three per cent fatter across the middle of the depth.
   *
   * Applied to the finished vertices rather than to the profile, because the
   * bevel has already decided where the middle is. The weight is a raised
   * cosine, so the swell is smooth and dies to nothing exactly at the two ends
   * where the cushion is held by its seams.
   */
  const position = geometry.getAttribute('position');
  for (let v = 0; v < position.count; v++) {
    const along = (position.getZ(v) + r) / Math.max(1e-6, depth + r * 2);
    const swell = 1 + 0.03 * Math.sin(Math.PI * Math.min(1, Math.max(0, along)));
    position.setX(v, position.getX(v) * swell);
    position.setY(v, position.getY(v) * swell);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  geometry.translate(min[0] + size[0] / 2, min[1] + size[1] / 2, min[2] + r);
  return { geometry, role };
}

/**
 * The piping round a cushion: the cord sewn into its seam.
 *
 * -----------------------------------------------------------------------------
 * THE ONE DETAIL THAT SAYS "UPHOLSTERY" RATHER THAN "SOFT SHAPE".
 *
 * Almost every sofa and armchair ever made has a seam running round the edge of
 * each cushion, and on most of them a cord is sewn into it so the seam stands
 * proud. It is six or eight millimetres of relief and it is doing an enormous
 * amount of work: it draws the outline of every cushion as a highlight, it
 * catches light from a different direction than the faces either side of it,
 * and its absence is why a smooth soft shape reads as moulded plastic.
 *
 * Built as a flat ring swept round the cushion's own rounded rectangle — the
 * same profile, at the same place the bevel's widest point falls, which is
 * where the seam actually is.
 */
function piping(
  min: [number, number, number],
  max: [number, number, number],
  role: MaterialRole,
  radius = 0.03,
): FurniturePart | null {
  const size: [number, number, number] = [
    Math.max(1e-4, max[0] - min[0]),
    Math.max(1e-4, max[1] - min[1]),
    Math.max(1e-4, max[2] - min[2]),
  ];

  const r = Math.min(radius, size[0] / 2.2, size[1] / 2.2, size[2] / 2.2);
  // Below about four millimetres the cord is finer than the eye resolves at
  // furniture distance and is only triangles.
  const cord = Math.min(0.007, r * 0.35);
  if (cord < 0.004) return null;

  /*
   * ON the cushion's silhouette, and slightly proud of it.
   *
   * Got wrong first time in a way that produced no error and nothing to see:
   * the outline was drawn at the same inset the cushion's own profile uses,
   * forgetting that the cushion then SWELLS back out by its bevel. The seam
   * ended up thirty-three millimetres inside the surface it was supposed to lie
   * on — a cord sewn into the stuffing.
   *
   * The extrusion's own bevel expands this outline by `cord`, so drawing it at
   * half the size minus half a cord puts the finished rim half a cord proud of
   * the cushion. Which is what proud means: a seam you can see across a room is
   * a seam you could catch a fingernail on.
   */
  const halfX = size[0] / 2 - r - cord * 0.5;
  const halfY = size[1] / 2 - r - cord * 0.5;

  /** The cushion's own outline, at the widest part of its bevel. */
  const outline = new THREE.Shape();
  outline.moveTo(-halfX + r, -halfY);
  outline.lineTo(halfX - r, -halfY);
  outline.quadraticCurveTo(halfX, -halfY, halfX, -halfY + r);
  outline.lineTo(halfX, halfY - r);
  outline.quadraticCurveTo(halfX, halfY, halfX - r, halfY);
  outline.lineTo(-halfX + r, halfY);
  outline.quadraticCurveTo(-halfX, halfY, -halfX, halfY - r);
  outline.lineTo(-halfX, -halfY + r);
  outline.quadraticCurveTo(-halfX, -halfY, -halfX + r, -halfY);
  outline.closePath();

  /*
   * A hole just inside it, so what gets extruded is a BAND and not a slab.
   *
   * Without this the piping is a solid plate the size of the cushion sitting
   * inside the cushion, which is invisible, costs a few hundred triangles and
   * would have been very hard to notice was wrong.
   */
  const inset = cord * 1.6;
  const innerX = Math.max(1e-3, halfX - inset);
  const innerY = Math.max(1e-3, halfY - inset);
  const innerR = Math.max(1e-3, r - inset);
  const hole = new THREE.Path();
  hole.moveTo(-innerX + innerR, -innerY);
  hole.lineTo(innerX - innerR, -innerY);
  hole.quadraticCurveTo(innerX, -innerY, innerX, -innerY + innerR);
  hole.lineTo(innerX, innerY - innerR);
  hole.quadraticCurveTo(innerX, innerY, innerX - innerR, innerY);
  hole.lineTo(-innerX + innerR, innerY);
  hole.quadraticCurveTo(-innerX, innerY, -innerX, innerY - innerR);
  hole.lineTo(-innerX, -innerY + innerR);
  hole.quadraticCurveTo(-innerX, -innerY, -innerX + innerR, -innerY);
  hole.closePath();
  outline.holes.push(hole);

  /*
   * Swept as a thin extrusion with its own bevel, which makes a rounded cord
   * rather than a flat strip. A flat strip would catch light as a band with two
   * hard edges — the opposite of the soft highlight this is for.
   */
  const geometry = new THREE.ExtrudeGeometry(outline, {
    depth: cord,
    bevelEnabled: true,
    bevelThickness: cord,
    bevelSize: cord,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: cornerSegments(r) + 1,
    steps: 1,
  });

  geometry.translate(
    min[0] + size[0] / 2,
    min[1] + size[1] / 2,
    // The seam runs round the middle of the cushion's depth.
    min[2] + size[2] / 2 - cord,
  );
  return { geometry, role };
}

/** A vertical cylinder — legs, poles, pedestals. */
function cylinder(
  center: [number, number],
  radius: number,
  bottom: number,
  top: number,
  role: MaterialRole,
  // Defaulted from the radius rather than to a number, so a table leg and a
  // waste pipe are each exactly as round as their own size calls for.
  sides = segmentsFor(radius),
): FurniturePart {
  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    Math.max(1e-4, top - bottom),
    sides,
  );
  geometry.translate(center[0], (bottom + top) / 2, center[1]);
  return { geometry, role };
}

/* --------------------------------- Legs -------------------------------- */

/**
 * Stands a piece on legs, with their feet.
 *
 * Every builder that used to write four `box(...)` calls for its legs now calls
 * this instead, which is the single change that moved the most triangles in
 * session 18. The positions are still the caller's — a trestle base and a
 * four-corner base put their legs in very different places — but the SHAPE of a
 * leg is now one decision in one file rather than a cuboid repeated eleven
 * times across the catalogue.
 *
 * `splay` rakes each leg away from the piece's centre, which only the mid-century
 * styles want; it is read from the leg's own position so a builder does not have
 * to work out the sign itself.
 */
function legsAt(
  positions: readonly [number, number][],
  top: number,
  thickness: number,
  style: LegStyle,
  role: MaterialRole,
  options: { foot?: FootStyle; splay?: number; bottom?: number } = {},
): FurniturePart[] {
  const { foot = 'glide', splay = 0, bottom = 0 } = options;
  const parts: FurniturePart[] = [];

  for (const at of positions) {
    const rake: [number, number] =
      splay > 0
        ? [Math.sign(at[0] || 1) * splay, Math.sign(at[1] || 1) * splay]
        : [0, 0];

    const leg = buildLeg({ at, top, thickness, style, foot, rake, bottom });
    if (leg) parts.push({ geometry: leg, role });

    const pad = buildFoot(at, foot, thickness, bottom);
    if (pad) parts.push({ geometry: pad, role: 'accent' });
  }

  return parts;
}

/** The four corners of a rectangular base, inset from its edges. */
function corners(halfW: number, halfD: number, inset: number): [number, number][] {
  return [
    [-halfW + inset, -halfD + inset],
    [halfW - inset, -halfD + inset],
    [-halfW + inset, halfD - inset],
    [halfW - inset, halfD - inset],
  ];
}

/* ------------------------------- Fronts --------------------------------- */

/**
 * A door or drawer front, as something other than a slab.
 *
 * -----------------------------------------------------------------------------
 * WHY A FRAMED FRONT IS WORTH FOUR TIMES THE TRIANGLES.
 *
 * A flat front reflects the room as one unbroken plane, so a chest of drawers
 * is a single rectangle of tone however good the material is. A shaker front
 * has a 60 mm frame standing 8 mm proud of a recessed centre, and the shadow
 * line round that recess is the only thing in the whole object that tells you
 * the drawers are separate from one another at a glance.
 *
 * Built here rather than borrowed from `openings/joinery.ts` — which already
 * makes panelled door leaves — because that module works in a door's frame,
 * where the leaf is upright and hinged and carries a lock rail. A drawer front
 * is 140 mm tall and has none of those. Sharing the code would mean a stile
 * width argument, a rail count argument and a lock-rail flag set to false at
 * every call site, which is a worse kind of sharing than two short functions.
 */
type FrontStyle = 'slab' | 'shaker' | 'grooved';

function front(
  min: [number, number, number],
  max: [number, number, number],
  style: FrontStyle,
  role: MaterialRole,
): FurniturePart[] {
  if (style === 'slab') return [box(min, max, role)];

  const width = max[0] - min[0];
  const height = max[1] - min[1];
  const depth = max[2] - min[2];

  if (style === 'grooved') {
    /*
     * A tongue-and-groove front: vertical boards with a V-joint between them.
     * Drawn as the boards themselves with gaps, rather than as a slab with
     * grooves cut in it, because the gap IS the detail and modelling it as
     * geometry means it catches the baked ambient like a real one.
     */
    const parts: FurniturePart[] = [];
    const boards = Math.max(2, Math.round(width / 0.09));
    const pitch = width / boards;
    for (let i = 0; i < boards; i++) {
      const x0 = min[0] + pitch * i + 0.002;
      const x1 = min[0] + pitch * (i + 1) - 0.002;
      parts.push(box([x0, min[1], min[2]], [x1, max[1], max[2]], role));
    }
    return parts;
  }

  // Shaker: four frame members round a recessed centre panel.
  const stile = Math.min(0.06, width * 0.28, height * 0.28);
  const recess = Math.min(0.008, depth * 0.45);
  const parts: FurniturePart[] = [];

  parts.push(box(min, [min[0] + stile, max[1], max[2]], role));
  parts.push(box([max[0] - stile, min[1], min[2]], max, role));
  parts.push(box([min[0] + stile, min[1], min[2]], [max[0] - stile, min[1] + stile, max[2]], role));
  parts.push(box([min[0] + stile, max[1] - stile, min[2]], [max[0] - stile, max[1], max[2]], role));

  // The panel, set back from the frame's face.
  parts.push(
    box(
      [min[0] + stile * 0.6, min[1] + stile * 0.6, min[2]],
      [max[0] - stile * 0.6, max[1] - stile * 0.6, max[2] - recess],
      role,
    ),
  );

  return parts;
}

/* -------------------------------- Builders ----------------------------- */

/** Builds a piece from its spec and dimensions. */
export function buildFurniture(spec: BuildSpec, size: BuildDimensions): FurniturePart[] {
  switch (spec.kind) {
    case 'sofa':
      return buildSofa(spec, size);
    case 'armchair':
      return buildArmchair(spec, size);
    case 'chair':
      return buildChair(spec, size);
    case 'table':
      return buildTable(spec, size);
    case 'shelving':
      return buildShelving(spec, size);
    case 'cabinet':
      return buildCabinet(spec, size);
    case 'bed':
      return buildBed(spec, size);
    case 'rug':
      return buildRug(spec, size);
    case 'lamp':
      return buildLamp(spec, size);
    case 'desk':
      return buildDesk(spec, size);
    case 'trolley':
      return buildTrolley(spec, size);
  }
}

/**
 * A sofa: plinth, arms, back, seat cushions and back cushions.
 *
 * Seat cushions are split per seat and inset slightly from the arms, because a
 * single slab across the whole width reads as a bench. The back cushions sit
 * proud of the back panel, which is what gives the silhouette its depth.
 */
function buildSofa(
  spec: Extract<BuildSpec, { kind: 'sofa' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const parts: FurniturePart[] = [];

  const halfW = w / 2;
  const armWidth = spec.arms === 'none' ? 0 : 0.16;
  const armHeight = spec.arms === 'high' ? h * 0.72 : h * 0.55;
  const seatHeight = Math.min(0.44, h * 0.52);
  const backThickness = 0.14;

  // Plinth: the solid base the whole thing sits on, lifted on short feet.
  const footHeight = 0.08;
  parts.push(box([-halfW, footHeight, -d / 2], [halfW, seatHeight - 0.1, d / 2], 'soft'));

  for (const fx of [-halfW + 0.09, halfW - 0.09]) {
    for (const fz of [-d / 2 + 0.09, d / 2 - 0.09]) {
      parts.push(cylinder([fx, fz], 0.025, 0, footHeight, 'accent', 8));
    }
  }

  // Arms.
  if (spec.arms !== 'none') {
    for (const sign of [-1, 1]) {
      parts.push(
        cushion(
          [sign * halfW - (sign > 0 ? armWidth : 0), footHeight, -d / 2],
          [sign * halfW + (sign > 0 ? 0 : armWidth), armHeight, d / 2],
          'soft',
          0.05,
        ),
      );
    }
  }

  // Back panel, at the -Z end since the sofa faces +Z.
  parts.push(
    cushion(
      [-halfW, footHeight, -d / 2],
      [halfW, h, -d / 2 + backThickness],
      'soft',
      0.05,
    ),
  );

  // Seat cushions, one per seat.
  const innerLeft = -halfW + armWidth;
  const innerRight = halfW - armWidth;
  const seatSpan = innerRight - innerLeft;
  const seatDepth = d - backThickness - 0.04;

  for (let i = 0; i < spec.seats; i++) {
    const from = innerLeft + (seatSpan / spec.seats) * i + 0.01;
    const to = innerLeft + (seatSpan / spec.seats) * (i + 1) - 0.01;

    const seat: [[number, number, number], [number, number, number]] = [
      [from, seatHeight - 0.12, -d / 2 + backThickness],
      [to, seatHeight, -d / 2 + backThickness + seatDepth],
    ];
    parts.push(cushion(seat[0], seat[1], 'soft', 0.04));

    // Back cushion above it, leaning forward off the back panel.
    const back: [[number, number, number], [number, number, number]] = [
      [from, seatHeight, -d / 2 + backThickness],
      [to, h - 0.03, -d / 2 + backThickness + 0.16],
    ];
    parts.push(cushion(back[0], back[1], 'soft', 0.05));

    /*
     * The seam round each cushion, which is the detail that says upholstery.
     *
     * Only the cushions get it, not the plinth or the arms: piping goes where
     * two panels of fabric are sewn together, and on most sofas that is the
     * cushions' own edges. Putting it on everything would read as a seam where
     * no seam is, which is worse than none.
     */
    const seatPipe = piping(seat[0], seat[1], 'accent', 0.04);
    if (seatPipe) parts.push(seatPipe);
    const backPipe = piping(back[0], back[1], 'accent', 0.05);
    if (backPipe) parts.push(backPipe);
  }

  // A chaise extends the seat on one side, which is what makes a corner sofa
  // an L rather than a deeper rectangle.
  if (spec.chaise) {
    parts.push(
      cushion(
        [innerLeft, footHeight, d / 2 - 0.02],
        [innerLeft + seatSpan * 0.45, seatHeight, d / 2 + 0.02],
        'soft',
        0.04,
      ),
    );
  }

  return parts;
}

/** An armchair: lounge (bentwood), wing (upholstered) or office (swivel). */
function buildArmchair(
  spec: Extract<BuildSpec, { kind: 'armchair' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const halfW = w / 2;
  const parts: FurniturePart[] = [];

  if (spec.style === 'office') {
    // Five-star base, gas lift, seat, back and armrests.
    const seatHeight = h * 0.35;
    parts.push(cylinder([0, 0], 0.035, 0.04, seatHeight - 0.06, 'accent'));
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const arm = box(
        [-0.022, 0.03, -0.01],
        [0.022, 0.06, Math.min(halfW, d / 2) * 0.95],
        'accent',
      );
      arm.geometry.rotateY(angle);
      parts.push(arm);
      const castorX = Math.sin(angle) * Math.min(halfW, d / 2) * 0.9;
      const castorZ = Math.cos(angle) * Math.min(halfW, d / 2) * 0.9;
      parts.push(cylinder([castorX, castorZ], 0.028, 0, 0.05, 'accent', 8));
    }
    parts.push(
      cushion([-halfW * 0.85, seatHeight - 0.07, -d * 0.35], [halfW * 0.85, seatHeight, d * 0.35], 'soft', 0.04),
    );
    parts.push(
      cushion([-halfW * 0.8, seatHeight, -d * 0.4], [halfW * 0.8, h, -d * 0.26], 'soft', 0.05),
    );
    for (const sign of [-1, 1]) {
      parts.push(
        box(
          [sign * halfW * 0.85 - 0.03, seatHeight, -d * 0.2],
          [sign * halfW * 0.85 + 0.03, seatHeight + 0.2, d * 0.15],
          'accent',
        ),
      );
    }
    return parts;
  }

  const seatHeight = spec.style === 'wing' ? 0.42 : 0.4;
  const backLean = spec.style === 'lounge' ? 0.18 : 0.06;

  if (spec.style === 'lounge') {
    /*
     * A bentwood cantilever frame, actually bent.
     *
     * The census found this drawn as four boxes per side — a floor rail, a
     * front post, a back post and a seat rail — which is a rectangle with a gap
     * in it. A POÄNG has no posts and no corners: it is ONE piece of laminated
     * birch running from the floor at the back, forward under the seat, up the
     * front and back over to carry the headrest, and its entire identity is
     * that continuous curve. Drawing it as four straight members does not make
     * it look like a cheaper POÄNG, it makes it look like a different chair.
     *
     * The path below is written in the YZ plane and swept with the section's
     * width pinned to world X, which is exactly the planar case `sweep` keeps
     * its reference axis for. Laminate section: 60 mm wide, 12 mm thick, with a
     * 4 mm arris — the real thing, as sold.
     */
    const laminate = roundedRectSection(0.06, 0.012, 0.004);
    const backZ = -d / 2 + 0.04;
    const frontZ = d / 2 - 0.03;

    for (const sign of [-1, 1]) {
      const x = sign * (halfW - 0.035);

      /*
       * Control points read back to front: on the floor at the rear, forward
       * along the runner, up the front in a quarter turn, back over the seat,
       * and up to the headrest. Sampled densely through a Catmull-Rom so the
       * bends are curves rather than creases — a bentwood frame with a visible
       * corner in it is a frame that broke.
       */
      const spine = new THREE.CatmullRomCurve3(
        [
          new THREE.Vector3(x, 0.012, backZ),
          new THREE.Vector3(x, 0.012, backZ + d * 0.35),
          new THREE.Vector3(x, 0.02, frontZ - 0.06),
          new THREE.Vector3(x, 0.1, frontZ),
          new THREE.Vector3(x, seatHeight - 0.06, frontZ - 0.01),
          new THREE.Vector3(x, seatHeight + 0.02, frontZ - 0.12),
          new THREE.Vector3(x, seatHeight + 0.08, backZ + 0.16),
          new THREE.Vector3(x, h * 0.72, backZ + 0.04),
          new THREE.Vector3(x, h, backZ + 0.02),
        ],
        false,
        'catmullrom',
        0.4,
      );

      parts.push({
        geometry: sweep(laminate, spine.getPoints(56), {
          axis: new THREE.Vector3(1, 0, 0),
          crease: 45,
        }),
        role: 'frame',
      });
    }

    // Two cross rails tying the side frames together — under the seat and
    // behind the headrest, which is where the real chair has them.
    for (const [y, z] of [
      [seatHeight - 0.05, frontZ - 0.1],
      [h - 0.05, backZ + 0.03],
    ] as const) {
      const rail = sweep(
        roundedRectSection(0.03, 0.03, 0.008),
        [new THREE.Vector3(-halfW + 0.03, y, z), new THREE.Vector3(halfW - 0.03, y, z)],
        { axis: new THREE.Vector3(0, 1, 0), crease: 30 },
      );
      parts.push({ geometry: rail, role: 'frame' });
    }
  } else {
    // Wing chair: upholstered sides running full height.
    for (const sign of [-1, 1]) {
      parts.push(
        cushion(
          [sign * halfW - (sign > 0 ? 0.12 : 0), 0.1, -d / 2],
          [sign * halfW + (sign > 0 ? 0 : 0.12), h * 0.75, d / 2 - 0.08],
          'soft',
          0.05,
        ),
      );
    }
    for (const fx of [-halfW + 0.08, halfW - 0.08]) {
      for (const fz of [-d / 2 + 0.08, d / 2 - 0.1]) {
        parts.push(cylinder([fx, fz], 0.022, 0, 0.1, 'frame', 8));
      }
    }
  }

  // Seat and back pads, shared by both upholstered styles.
  const inset = spec.style === 'wing' ? 0.12 : 0.04;
  parts.push(
    cushion(
      [-halfW + inset, seatHeight - 0.1, -d / 2 + 0.1],
      [halfW - inset, seatHeight, d / 2 - 0.08],
      'soft',
      0.04,
    ),
  );
  parts.push(
    cushion(
      [-halfW + inset, seatHeight, -d / 2 + 0.06],
      [halfW - inset, h - 0.02, -d / 2 + 0.06 + backLean],
      'soft',
      0.05,
    ),
  );

  return parts;
}

/** A dining chair: four legs, a seat, and a back. */
function buildChair(
  spec: Extract<BuildSpec, { kind: 'chair' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const halfW = w / 2;
  const seatHeight = 0.45;
  const legInset = 0.035;
  const parts: FurniturePart[] = [];

  const style: LegStyle = spec.legStyle ?? 'square-taper';

  /*
   * Back legs run the full height and become the back uprights, so they are NOT
   * tapered legs — a tapered member carrying a backrest would be thinnest where
   * the load is. They stay parallel, and only the front pair tapers, which is
   * how a real side chair is made and why its silhouette is asymmetric.
   */
  for (const sign of [-1, 1]) {
    const x = sign * (halfW - legInset);
    const upright = taperedProfile(
      roundedRectSection(0.036, 0.036, 0.005),
      0,
      h,
      { topScale: 0.78, steps: 2, crease: 25 },
    );
    upright.translate(x, 0, -d / 2 + legInset);
    parts.push({ geometry: upright, role: 'frame' });
  }

  parts.push(
    ...legsAt(
      [
        [-(halfW - legInset), d / 2 - legInset],
        [halfW - legInset, d / 2 - legInset],
      ],
      seatHeight,
      0.036,
      style,
      'frame',
      { foot: 'glide' },
    ),
  );

  /*
   * The seat, dished.
   *
   * A flat board is the single most obvious thing about a cheap chair model. A
   * saddled seat — hollowed a few millimetres across the middle — catches a
   * gradient of light instead of one flat tone, and the lip round its edge
   * reads as a solid plank rather than as card.
   */
  const seatTop = lathe(
    [
      { r: 0, y: seatHeight - 0.006 },
      { r: Math.min(halfW, d / 2) * 0.72, y: seatHeight - 0.004 },
      { r: Math.min(halfW, d / 2) * 0.96, y: seatHeight },
      { r: Math.min(halfW, d / 2), y: seatHeight - 0.008 },
      { r: Math.min(halfW, d / 2), y: seatHeight - 0.032 },
      { r: Math.min(halfW, d / 2) * 0.9, y: seatHeight - 0.038 },
      { r: 0, y: seatHeight - 0.038 },
    ],
    segmentsFor(Math.min(halfW, d / 2)),
    40,
  );
  // Turned round, then squashed to the seat's actual rectangle.
  seatTop.scale(halfW / Math.min(halfW, d / 2), 1, d / 2 / Math.min(halfW, d / 2));
  parts.push({ geometry: seatTop, role: spec.back === 'round' ? 'soft' : 'frame' });

  const backTop = h - 0.04;
  if (spec.back === 'slat') {
    // Horizontal slats with gaps, which is what makes a chair read as a chair
    // in silhouette rather than as a block.
    const slats = 3;
    const span = backTop - (seatHeight + 0.12);
    for (let i = 0; i < slats; i++) {
      const y = seatHeight + 0.12 + (span / slats) * i;
      parts.push(
        box([-halfW + legInset, y, -d / 2 + legInset - 0.01], [halfW - legInset, y + span / (slats * 2), -d / 2 + legInset + 0.01], 'frame'),
      );
    }
  } else if (spec.back === 'round') {
    parts.push(
      cushion(
        [-halfW, seatHeight + 0.08, -d / 2 + legInset - 0.02],
        [halfW, backTop, -d / 2 + legInset + 0.03],
        'soft',
        0.06,
      ),
    );
  } else {
    parts.push(
      box([-halfW + legInset, seatHeight + 0.1, -d / 2 + legInset - 0.01], [halfW - legInset, backTop, -d / 2 + legInset + 0.01], 'frame'),
    );
  }

  return parts;
}

/** A table: a top, an optional apron, and legs. */
function buildTable(
  spec: Extract<BuildSpec, { kind: 'table' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const parts: FurniturePart[] = [];
  const topThickness = spec.glass ? 0.01 : 0.035;
  const topRole: MaterialRole = spec.glass ? 'glass' : 'frame';

  const legRole: MaterialRole = spec.glass ? 'accent' : 'frame';
  const legStyle: LegStyle = spec.legStyle ?? (spec.glass ? 'tube' : 'square-taper');

  if (spec.shape === 'round') {
    const radius = Math.min(w, d) / 2;

    /*
     * A pedestal table, turned in one piece.
     *
     * The census caught this one at 320 triangles: a cylinder for the top, a
     * cone for the column, a cylinder for the foot. DOCKSTA's whole identity is
     * the curve where the column flares into the base, and a cone has no curve
     * — it has one straight line and two hard shoulders, which is why the old
     * version read as a lampshade with a plate on top.
     *
     * The profile runs floor to underside: a flared foot, a hollow under it so
     * it sits on a rim rather than on its whole face, the waisted column, and
     * the flare back out to meet the top.
     */
    const under = h - topThickness;
    const pedestal = lathe(
      [
        { r: 0, y: 0.004 },
        { r: radius * 0.24, y: 0 },
        { r: radius * 0.44, y: 0 },
        { r: radius * 0.46, y: 0.006 },
        { r: radius * 0.42, y: 0.022 },
        { r: radius * 0.3, y: 0.055 },
        { r: radius * 0.2, y: 0.11 },
        { r: radius * 0.15, y: under * 0.45 },
        { r: radius * 0.14, y: under * 0.75 },
        { r: radius * 0.18, y: under * 0.93 },
        { r: radius * 0.34, y: under - 0.006 },
        { r: radius * 0.36, y: under },
        { r: 0, y: under },
      ],
      segmentsFor(radius * 0.46),
      55,
    );
    parts.push({ geometry: pedestal, role: 'frame' });

    /*
     * The top gets a bevelled edge rather than a square-cut cylinder. A 35 mm
     * slab seen edge-on from a sofa is a horizontal band of flat tone; rolling
     * the underside of its rim puts a highlight along it.
     */
    const top = lathe(
      [
        { r: 0, y: under },
        { r: radius - 0.012, y: under },
        { r: radius, y: under + 0.008 },
        { r: radius, y: h - 0.004 },
        { r: radius - 0.005, y: h },
        { r: 0, y: h },
      ],
      segmentsFor(radius),
      55,
    );
    parts.push({ geometry: top, role: topRole });
    return parts;
  }

  const halfW = w / 2;
  const halfD = d / 2;
  parts.push(box([-halfW, h - topThickness, -halfD], [halfW, h, halfD], topRole));

  const legSize = 0.042;
  const inset = 0.05;
  const legTop = h - topThickness;

  if (spec.legs === 'trestle') {
    /*
     * A trestle: two uprights per end joined by a foot and a top rail, with a
     * stretcher between them. The uprights taper — this is the part of a
     * SKOGSTA that makes it look like joinery rather than like scaffolding.
     */
    for (const sign of [-1, 1]) {
      const x = sign * (halfW - w * 0.14);
      parts.push(
        ...legsAt([[x, -halfD + inset + 0.03], [x, halfD - inset - 0.03]], legTop, 0.055, 'square-taper', legRole, {
          foot: 'none',
        }),
      );
      // Foot rail on the floor and a bearer under the top.
      parts.push(box([x - 0.028, 0, -halfD + inset], [x + 0.028, 0.055, halfD - inset], legRole));
      parts.push(box([x - 0.03, legTop - 0.08, -halfD + inset], [x + 0.03, legTop, halfD - inset], legRole));
    }
    parts.push(box([-halfW + w * 0.14, h * 0.25, -0.032], [halfW - w * 0.14, h * 0.25 + 0.065, 0.032], legRole));
  } else {
    parts.push(
      ...legsAt(corners(halfW, halfD, inset), legTop, legSize, legStyle, legRole, {
        foot: spec.glass ? 'glide' : 'none',
        splay: spec.legStyle === 'splayed' ? 0.07 : 0,
      }),
    );
  }

  if (spec.apron) {
    const apronTop = legTop;
    const apronBottom = apronTop - 0.07;
    parts.push(box([-halfW + inset, apronBottom, -halfD + inset - 0.012], [halfW - inset, apronTop, -halfD + inset + 0.012], legRole));
    parts.push(box([-halfW + inset, apronBottom, halfD - inset - 0.012], [halfW - inset, apronTop, halfD - inset + 0.012], legRole));
  }

  return parts;
}

/** Shelving: a carcass with a grid of compartments. */
function buildShelving(
  spec: Extract<BuildSpec, { kind: 'shelving' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const halfW = w / 2;
  const halfD = d / 2;
  const panel = 0.018;
  const parts: FurniturePart[] = [];

  // Sides, top and bottom.
  parts.push(box([-halfW, 0, -halfD], [-halfW + panel, h, halfD], 'frame'));
  parts.push(box([halfW - panel, 0, -halfD], [halfW, h, halfD], 'frame'));
  parts.push(box([-halfW, h - panel, -halfD], [halfW, h, halfD], 'frame'));
  parts.push(box([-halfW, 0, -halfD], [halfW, panel, halfD], 'frame'));

  if (spec.back) {
    // Thin back panel, recessed so it does not read as a solid slab.
    parts.push(box([-halfW + panel, panel, -halfD], [halfW - panel, h - panel, -halfD + 0.005], 'accent'));
  }

  // Horizontal shelves.
  for (let row = 1; row < spec.rows; row++) {
    const y = (h / spec.rows) * row;
    parts.push(box([-halfW + panel, y - panel / 2, -halfD], [halfW - panel, y + panel / 2, halfD], 'frame'));
  }

  // Vertical dividers, for cube units like KALLAX.
  for (let column = 1; column < spec.columns; column++) {
    const x = -halfW + (w / spec.columns) * column;
    parts.push(box([x - panel / 2, panel, -halfD], [x + panel / 2, h - panel, halfD], 'frame'));
  }

  return parts;
}

/** A cabinet or chest: a carcass fronted by doors or drawers. */
function buildCabinet(
  spec: Extract<BuildSpec, { kind: 'cabinet' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const halfW = w / 2;
  const halfD = d / 2;
  const parts: FurniturePart[] = [];

  const base = spec.plinth ? 0.06 : 0.0;
  if (spec.plinth) {
    parts.push(box([-halfW + 0.04, 0, -halfD + 0.04], [halfW - 0.04, base, halfD - 0.02], 'accent'));
  }

  // Carcass, slightly shallower than the front so fronts stand proud.
  parts.push(box([-halfW, base, -halfD], [halfW, h, halfD - 0.02], 'frame'));

  const frontZ = halfD - 0.02;
  const gap = 0.006;

  const face: FrontStyle = spec.front ?? 'slab';
  const pull: HandleStyle = spec.handle ?? 'finger';

  if (spec.drawers > 0) {
    // Chests are usually two columns wide once they get past about a metre.
    const columns = w > 1.1 ? 2 : 1;
    const rows = Math.ceil(spec.drawers / columns);
    const drawerHeight = (h - base) / rows;

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x0 = -halfW + (w / columns) * column + gap;
        const x1 = -halfW + (w / columns) * (column + 1) - gap;
        const y0 = base + drawerHeight * row + gap;
        const y1 = base + drawerHeight * (row + 1) - gap;

        parts.push(...front([x0, y0, frontZ], [x1, y1, halfD], face, 'frame'));

        if (pull === 'finger') {
          // Recessed finger pull along the top edge of each front.
          parts.push(box([x0 + 0.04, y1 - 0.025, halfD - 0.004], [x1 - 0.04, y1 - 0.008, halfD + 0.008], 'accent'));
        } else {
          const handle = buildHandle(pull, [(x0 + x1) / 2, (y0 + y1) / 2, halfD], (x1 - x0) * 0.42);
          if (handle) parts.push({ geometry: handle, role: 'accent' });
        }
      }
    }
  }

  if (spec.doors > 0) {
    const doorHeight = h - base;
    for (let i = 0; i < spec.doors; i++) {
      const x0 = -halfW + (w / spec.doors) * i + gap;
      const x1 = -halfW + (w / spec.doors) * (i + 1) - gap;
      parts.push(...front([x0, base + gap, frontZ], [x1, base + doorHeight - gap, halfD], face, 'frame'));

      // Handle on the leading edge, mirrored about the centre of the run.
      const handleX = i < spec.doors / 2 ? x1 - 0.055 : x0 + 0.055;
      const handle = buildHandle(
        pull === 'finger' ? 'bar' : pull,
        [handleX, base + doorHeight * 0.5, halfD],
        doorHeight * 0.18,
      );
      if (handle) {
        // A door pull runs vertically; the builder draws it along X.
        handle.translate(-handleX, -(base + doorHeight * 0.5), -halfD);
        handle.rotateZ(Math.PI / 2);
        handle.translate(handleX, base + doorHeight * 0.5, halfD);
        parts.push({ geometry: handle, role: 'accent' });
      }
    }
  }

  return parts;
}

/** A bed: frame, headboard, mattress and pillows. */
function buildBed(
  spec: Extract<BuildSpec, { kind: 'bed' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const halfW = w / 2;
  const halfD = d / 2;
  const parts: FurniturePart[] = [];

  const frameHeight = spec.storage ? 0.36 : 0.3;
  const railThickness = 0.05;

  // The headboard is at -Z, so the bed "faces" +Z, which is the foot. That
  // matches the wall-snapping contract: the headboard ends up against the wall.
  parts.push(box([-halfW, 0, -halfD], [halfW, spec.headboard, -halfD + 0.06], 'frame'));

  // Side and foot rails.
  parts.push(box([-halfW, 0, -halfD], [-halfW + railThickness, frameHeight, halfD], 'frame'));
  parts.push(box([halfW - railThickness, 0, -halfD], [halfW, frameHeight, halfD], 'frame'));
  parts.push(box([-halfW, 0, halfD - 0.06], [halfW, frameHeight * 0.75, halfD], 'frame'));

  if (spec.storage) {
    // Drawer fronts in the base, along one side.
    for (let i = 0; i < 2; i++) {
      const z0 = -halfD + 0.2 + (d * 0.35) * i;
      const z1 = z0 + d * 0.3;
      parts.push(box([halfW - railThickness - 0.01, 0.05, z0], [halfW + 0.005, frameHeight - 0.05, z1], 'frame'));
    }
  }

  // Mattress, inset within the rails.
  const mattressTop = frameHeight + 0.22;
  parts.push(
    cushion(
      [-halfW + railThickness, frameHeight - 0.02, -halfD + 0.08],
      [halfW - railThickness, mattressTop, halfD - 0.06],
      'soft',
      0.04,
    ),
  );

  // Duvet, folded back to leave the pillows showing.
  parts.push(
    cushion(
      [-halfW + railThickness, mattressTop, -halfD + 0.55],
      [halfW - railThickness, mattressTop + 0.09, halfD - 0.06],
      'soft',
      0.04,
    ),
  );

  // Pillows.
  const pillowWidth = Math.min(0.5, w / 2 - 0.08);
  for (const sign of w > 1.1 ? [-1, 1] : [0]) {
    const cx = sign * (w > 1.1 ? pillowWidth / 2 + 0.03 : 0);
    parts.push(
      cushion(
        [cx - pillowWidth / 2, mattressTop, -halfD + 0.14],
        [cx + pillowWidth / 2, mattressTop + 0.11, -halfD + 0.5],
        'soft',
        0.05,
      ),
    );
  }

  // `h` is the overall height including the headboard, already used above.
  void h;
  return parts;
}

/**
 * A rug.
 *
 * -----------------------------------------------------------------------------
 * THE WORST OFFENDER IN THE WHOLE CATALOGUE.
 *
 * The census found this one at 300 triangles for a rectangle and 40 for a
 * circle — a single extruded quad. In a screenshot it read as a sheet of paper
 * lying on the floor, and for a very specific reason: a rug's edge is not a cut,
 * it is where the pile stops. A razor-straight edge at a constant height is the
 * one thing no textile on earth does.
 *
 * Three things fix it, in descending order of how much they matter:
 *
 *   1. THE EDGE. A rolled, slightly thicker border — a bound or whipped hem —
 *      so the silhouette against the floor has a soft top and a shadow under it.
 *   2. THE SURFACE. A displaced grid rather than a plane. The displacement is
 *      tiny (a few millimetres) and its job is not to be seen as bumps but to
 *      stop a two-metre expanse returning exactly the same normal everywhere,
 *      which is what makes a flat rug read as painted floor.
 *   3. THE FRINGE, on the kinds that have one.
 *
 * This is deliberately the most expensive item in the catalogue. A rug is the
 * largest single soft surface in a room and it sits right where the eye lands.
 */
function buildRug(
  spec: Extract<BuildSpec, { kind: 'rug' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const parts: FurniturePart[] = [];

  const pile = spec.pile ?? 'low';
  const relief = pile === 'shag' ? h * 0.55 : pile === 'flat' ? h * 0.12 : h * 0.3;
  // A hand's width of border, bound slightly proud of the field.
  const border = Math.min(0.06, Math.min(w, d) * 0.06);

  /*
   * Deterministic, and deliberately not `Math.random`.
   *
   * Two rugs of the same product must be identical, because the geometry cache
   * is keyed by item id and a random surface would mean a rug that reshuffled
   * itself every time the document rebuilt. The hash is the same cheap one the
   * clutter generator uses.
   */
  const wobble = (x: number, z: number): number => {
    const a = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    const b = Math.sin(x * 39.3468 + z * 11.135) * 24634.6345;
    return ((a - Math.floor(a)) + (b - Math.floor(b))) / 2;
  };

  if (spec.shape === 'round') {
    const radius = Math.min(w, d) / 2;
    const sides = segmentsFor(radius);

    // Field and bound edge in one turned profile: flat centre, a dip where the
    // binding is stitched down, then the raised hem and the roll back to the
    // floor.
    const rug = lathe(
      [
        { r: 0, y: h * 0.82 },
        { r: radius - border * 1.6, y: h * 0.86 },
        { r: radius - border, y: h * 0.78 },
        { r: radius - border * 0.55, y: h },
        { r: radius - border * 0.15, y: h * 0.92 },
        { r: radius, y: h * 0.45 },
        { r: radius - 0.004, y: 0 },
        { r: 0, y: 0 },
      ],
      sides,
      45,
    );
    parts.push({ geometry: rug, role: 'soft' });
    return parts;
  }

  const halfW = w / 2;
  const halfD = d / 2;

  /*
   * The field: a grid, displaced.
   *
   * 25 mm cells, which on a 2 x 3 m rug is 80 x 120 — about 19,000 triangles.
   * That is more than the sofa, and it is the right call: this surface fills a
   * third of the frame in any view of a seating group.
   */
  const cell = 0.025;
  const nx = Math.max(2, Math.round(w / cell));
  const nz = Math.max(2, Math.round(d / cell));

  const positions: number[] = [];
  const indices: number[] = [];

  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const x = -halfW + (w / nx) * ix;
      const z = -halfD + (d / nz) * iz;

      /*
       * Falls away at the border so the field meets the hem rather than
       * ending in mid-air. `edge` is 0 at the very edge and 1 once the border
       * width is cleared.
       */
      const fromEdge = Math.min(halfW - Math.abs(x), halfD - Math.abs(z));
      const edge = Math.max(0, Math.min(1, fromEdge / border));

      const y = h * 0.8 + (wobble(x * 37, z * 37) - 0.5) * relief * edge - (1 - edge) * h * 0.1;
      positions.push(x, y, z);
    }
  }

  const stride = nx + 1;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * stride + ix;
      const b = a + 1;
      const c = a + stride;
      const e = c + 1;
      // Wound so the normals point up out of the floor.
      indices.push(a, c, b);
      indices.push(b, c, e);
    }
  }

  const field = new THREE.BufferGeometry();
  field.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  field.setIndex(indices);
  field.computeVertexNormals();
  parts.push({ geometry: field, role: 'soft' });

  /*
   * The bound edge, swept round the rug's perimeter as a rolled hem.
   *
   * This is the part that does the work. It gives the rug a silhouette with a
   * thickness that varies, an underside for the occlusion to find, and a
   * top edge that catches the light along its whole run.
   */
  /*
   * The section is written HEIGHT FIRST, and that is not a slip.
   *
   * `sweep` maps the section's local x onto its reference axis and its local y
   * onto the perpendicular. The reference axis here has to be world up, because
   * the path turns four corners and no fixed horizontal direction stays
   * perpendicular to all four sides. So local x is VERTICAL and local y is the
   * horizontal width of the hem — the opposite way round from how a section is
   * normally read.
   *
   * Written the intuitive way round it came out as a 78 mm vertical fin running
   * all the way round the rug and 35 mm down through the floorboards. It did
   * not look like a bug in a screenshot: it looked like a rug with a thick
   * edge, which is a thing that exists. `__meshProbe` reporting `minY = -0.035`
   * on a rug is what actually identified it.
   */
  const hem = roundedRectSection(h * 1.0, border * 1.3, Math.min(h * 0.45, border * 0.3));
  const path: THREE.Vector3[] = [];
  const inset = border * 0.5;
  const ring: [number, number][] = [
    [-halfW + inset, -halfD + inset],
    [halfW - inset, -halfD + inset],
    [halfW - inset, halfD - inset],
    [-halfW + inset, halfD - inset],
  ];
  // Walk the loop, subdividing each side so the sweep's central-difference
  // tangent has something to work with at the corners.
  for (let i = 0; i <= ring.length; i++) {
    const from = ring[i % ring.length]!;
    const to = ring[(i + 1) % ring.length]!;
    for (let s = 0; s < 4; s++) {
      const t = s / 4;
      // Centred so the hem sits ON the floor and stands very slightly proud of
      // the field, which is what a bound edge does.
      path.push(new THREE.Vector3(from[0] + (to[0] - from[0]) * t, h * 0.52, from[1] + (to[1] - from[1]) * t));
    }
  }
  parts.push({
    geometry: sweep(hem, path, { axis: new THREE.Vector3(0, 1, 0), crease: 35 }),
    role: 'soft',
  });

  if (spec.fringe) {
    /*
     * Fringe on the two short ends, as tapered strands lying on the floor.
     *
     * Individually modelled rather than faked with a texture, because a fringe
     * is a silhouette feature — the whole point of it is the ragged outline
     * against the floorboards, which an alpha map on a flat quad cannot give at
     * a grazing angle.
     */
    const strands = Math.max(8, Math.round(w / 0.018));
    for (const sign of [-1, 1]) {
      for (let i = 0; i < strands; i++) {
        const x = -halfW + (w / (strands - 1)) * i;
        const lean = (wobble(x * 91, sign * 13) - 0.5) * 0.02;
        const length = 0.05 + wobble(x * 17, sign * 29) * 0.02;
        const strand = taperedProfile(circleSection(0.0018, 5), 0, length, { topScale: 0.6, crease: 60 });
        // Turned on its side to lie on the floor, splaying outward.
        strand.rotateX(sign > 0 ? -Math.PI / 2 : Math.PI / 2);
        strand.rotateY(lean * 8);
        strand.translate(x, h * 0.18, sign * (halfD - inset * 0.4));
        parts.push({ geometry: strand, role: 'soft' });
      }
    }
  }

  return parts;
}

/**
 * A lamp: base, stem and shade.
 *
 * -----------------------------------------------------------------------------
 * A SHADE IS A HOLLOW OBJECT, AND THAT IS THE WHOLE POINT OF ONE.
 *
 * The old version drew it as an open-ended cone — a surface with no thickness,
 * so from below you saw the back of it and from the side its rim was a line with
 * no width. A real shade has an inside, and the inside is the brightest surface
 * in the room when the lamp is on: it is the thing that produces the warm ring
 * of light on the ceiling. Turning the profile up the outside, over the rim and
 * back down the inside costs about 600 triangles and gives the shade a lip, an
 * interior for the bounce to land on, and a silhouette with depth.
 *
 * The whole lamp was 214 triangles before this. It is the smallest object in the
 * catalogue and one of the few that is usually lit from within.
 */
function buildLamp(
  spec: Extract<BuildSpec, { kind: 'lamp' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, height: h } = size;
  const radius = w / 2;
  const parts: FurniturePart[] = [];

  /** A shade turned as a hollow form: up the outside, over the rim, back down. */
  const shadeAt = (bottom: number, top: number, lower: number, upper: number) => {
    const wall = 0.0025;
    return lathe(
      [
        { r: lower, y: bottom },
        { r: upper, y: top },
        { r: upper - wall * 0.6, y: top + 0.004 },
        { r: upper - wall, y: top },
        { r: lower - wall, y: bottom + 0.004 },
        { r: lower - wall * 0.4, y: bottom },
      ],
      segmentsFor(Math.max(lower, upper)),
      48,
    );
  };

  if (spec.style === 'floor') {
    const shadeBottom = h - radius * 0.95;

    /*
     * A weighted base, turned. The taper matters more than it sounds: a floor
     * lamp base is the only part of the object at eye level for somebody
     * sitting down, and a flat disc has no silhouette at all from there.
     */
    const base = lathe(
      [
        { r: 0, y: 0.002 },
        { r: radius * 0.5, y: 0 },
        { r: radius * 0.56, y: 0.004 },
        { r: radius * 0.54, y: 0.016 },
        { r: radius * 0.3, y: 0.03 },
        { r: radius * 0.16, y: 0.05 },
        { r: 0.016, y: 0.075 },
        { r: 0, y: 0.075 },
      ],
      segmentsFor(radius * 0.56),
      55,
    );
    parts.push({ geometry: base, role: 'accent' });

    // The stem, very slightly tapered so it does not read as a pipe.
    parts.push({
      geometry: taperedProfile(circleSection(0.013), 0.06, shadeBottom + 0.02, {
        topScale: 0.82,
        crease: 60,
      }),
      role: 'accent',
    });

    parts.push({ geometry: shadeAt(shadeBottom, h, radius, radius * 0.62), role: 'shade' });
    return parts;
  }

  /*
   * Table lamp: a weighted base, a stem, a jointed arm and a shade on the end.
   *
   * The ARM is the point, and the rewrite lost it once already. RANARP is
   * catalogued as a work lamp 190 mm wide and 340 mm deep, and the only thing
   * that makes a lamp deeper than it is wide is a shade cantilevered out over a
   * desk. A centred shade left it rattling around inside a footprint twice its
   * size, which `geometry.test.ts` caught as a piece that does not fill the
   * space it claims — a check that exists precisely because "too small" looks
   * entirely reasonable on screen.
   */
  const stemTop = h * 0.55;
  const reach = size.depth * 0.42;
  const base = lathe(
    [
      { r: 0, y: 0.002 },
      { r: radius * 0.8, y: 0 },
      { r: radius * 0.85, y: 0.006 },
      { r: radius * 0.78, y: 0.024 },
      { r: radius * 0.42, y: 0.05 },
      { r: 0.014, y: 0.08 },
      { r: 0, y: 0.08 },
    ],
    segmentsFor(radius * 0.85),
    55,
  );
  parts.push({ geometry: base, role: 'accent' });

  parts.push({
    geometry: taperedProfile(circleSection(0.011), 0.06, stemTop, { topScale: 0.85, crease: 60 }),
    role: 'accent',
  });

  // The arm: a rod from the top of the stem out over the desk, with a slight
  // droop so it reads as a jointed arm rather than as a shelf bracket.
  const arm = sweep(
    circleSection(0.009, 10),
    [
      new THREE.Vector3(0, stemTop, 0),
      new THREE.Vector3(0, stemTop + 0.012, reach * 0.45),
      new THREE.Vector3(0, stemTop - 0.005, reach),
    ],
    { axis: new THREE.Vector3(1, 0, 0), crease: 60 },
  );
  parts.push({ geometry: arm, role: 'accent' });

  // The shade hangs off the end of the arm, not off the stem.
  const shade = shadeAt(stemTop - 0.15, stemTop - 0.01, radius * 0.95, radius * 0.5);
  shade.translate(0, 0, reach);
  parts.push({ geometry: shade, role: 'shade' });
  return parts;
}

/** A desk: a top on legs, with an optional drawer pedestal. */
function buildDesk(
  spec: Extract<BuildSpec, { kind: 'desk' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const halfW = w / 2;
  const halfD = d / 2;
  const parts: FurniturePart[] = [];
  const topThickness = 0.025;

  parts.push(box([-halfW, h - topThickness, -halfD], [halfW, h, halfD], 'frame'));

  // Steel underframe: an inverted U at each end plus a rear stretcher.
  for (const sign of [-1, 1]) {
    const x = sign * (halfW - 0.06);
    parts.push(box([x - 0.02, 0, -halfD + 0.05], [x + 0.02, h - topThickness, -halfD + 0.09], 'accent'));
    parts.push(box([x - 0.02, 0, halfD - 0.09], [x + 0.02, h - topThickness, halfD - 0.05], 'accent'));
    parts.push(box([x - 0.02, h - topThickness - 0.04, -halfD + 0.05], [x + 0.02, h - topThickness, halfD - 0.05], 'accent'));
  }

  if (spec.drawers > 0) {
    const unitWidth = Math.min(0.36, w * 0.34);
    const x1 = halfW - 0.02;
    const x0 = x1 - unitWidth;
    parts.push(box([x0, 0.03, -halfD + 0.04], [x1, h - topThickness, halfD - 0.02], 'frame'));

    const drawerHeight = (h - topThickness - 0.03) / spec.drawers;
    for (let i = 0; i < spec.drawers; i++) {
      const y0 = 0.03 + drawerHeight * i + 0.005;
      const y1 = 0.03 + drawerHeight * (i + 1) - 0.005;
      parts.push(box([x0 + 0.004, y0, halfD - 0.02], [x1 - 0.004, y1, halfD], 'frame'));
      parts.push(box([x0 + 0.05, y1 - 0.022, halfD], [x1 - 0.05, y1 - 0.008, halfD + 0.008], 'accent'));
    }
  }

  return parts;
}

/** A trolley: tiers on a tubular frame with castors. */
function buildTrolley(
  spec: Extract<BuildSpec, { kind: 'trolley' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  const halfW = w / 2;
  const halfD = d / 2;
  const parts: FurniturePart[] = [];

  /*
   * Castors, as wheels rather than as two stacked cylinders.
   *
   * A trolley sits at knee height with nothing in front of it, so its feet are
   * unusually exposed — more visible than a sofa's, which are behind a skirt.
   * The wheel is the one part of a RÅSKOG a person can name from across a room.
   */
  const castor = 0.05;
  parts.push(
    ...legsAt(corners(halfW, halfD, 0.03), h, 0.018, 'tube', 'accent', { foot: 'castor', bottom: 0 }),
  );
  void castor;

  const usable = h - castor - 0.08;
  for (let tier = 0; tier < spec.tiers; tier++) {
    const y = castor + (usable / spec.tiers) * tier + 0.02;
    // A shallow tray rather than a flat shelf, which is what a RÅSKOG is.
    parts.push(box([-halfW, y, -halfD], [halfW, y + 0.012, halfD], 'frame'));
    for (const sign of [-1, 1]) {
      parts.push(box([sign * halfW - (sign > 0 ? 0.012 : 0), y, -halfD], [sign * halfW + (sign > 0 ? 0 : 0.012), y + 0.05, halfD], 'frame'));
      parts.push(box([-halfW, y, sign * halfD - (sign > 0 ? 0.012 : 0)], [halfW, y + 0.05, sign * halfD + (sign > 0 ? 0 : 0.012)], 'frame'));
    }
  }

  // Push handle across the top.
  parts.push(box([-halfW, h - 0.02, -0.01], [halfW, h, 0.01], 'accent'));
  return parts;
}
