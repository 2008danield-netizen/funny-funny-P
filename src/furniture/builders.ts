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

import type { BuildSpec } from './catalog';

/** Which material a part is drawn with. */
export type MaterialRole = 'frame' | 'soft' | 'accent' | 'glass' | 'shade';

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
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geometry.translate(min[0] + size[0] / 2, min[1] + size[1] / 2, min[2] + size[2] / 2);
  return { geometry, role };
}

/** A box with softened edges — used for cushions and upholstered forms. */
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
  // A rounded profile extruded through the cushion's depth. Cheaper and more
  // controllable than a subdivided box, and the softened silhouette is most of
  // what separates "upholstery" from "crate" at a glance.
  const r = Math.min(radius, size[0] / 2.2, size[1] / 2.2);
  const shape = new THREE.Shape();
  shape.moveTo(-size[0] / 2 + r, -size[1] / 2);
  shape.lineTo(size[0] / 2 - r, -size[1] / 2);
  shape.quadraticCurveTo(size[0] / 2, -size[1] / 2, size[0] / 2, -size[1] / 2 + r);
  shape.lineTo(size[0] / 2, size[1] / 2 - r);
  shape.quadraticCurveTo(size[0] / 2, size[1] / 2, size[0] / 2 - r, size[1] / 2);
  shape.lineTo(-size[0] / 2 + r, size[1] / 2);
  shape.quadraticCurveTo(-size[0] / 2, size[1] / 2, -size[0] / 2, size[1] / 2 - r);
  shape.lineTo(-size[0] / 2, -size[1] / 2 + r);
  shape.quadraticCurveTo(-size[0] / 2, -size[1] / 2, -size[0] / 2 + r, -size[1] / 2);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: size[2],
    bevelEnabled: false,
    curveSegments: 3,
    steps: 1,
  });
  geometry.translate(min[0] + size[0] / 2, min[1] + size[1] / 2, min[2]);
  return { geometry, role };
}

/** A vertical cylinder — legs, poles, pedestals. */
function cylinder(
  center: [number, number],
  radius: number,
  bottom: number,
  top: number,
  role: MaterialRole,
  radialSegments = 10,
): FurniturePart {
  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    Math.max(1e-4, top - bottom),
    radialSegments,
  );
  geometry.translate(center[0], (bottom + top) / 2, center[1]);
  return { geometry, role };
}

/** A truncated cone — lampshades. */
function cone(
  center: [number, number],
  topRadius: number,
  bottomRadius: number,
  bottom: number,
  top: number,
  role: MaterialRole,
): FurniturePart {
  const geometry = new THREE.CylinderGeometry(
    topRadius,
    bottomRadius,
    Math.max(1e-4, top - bottom),
    18,
    1,
    true,
  );
  geometry.translate(center[0], (bottom + top) / 2, center[1]);
  return { geometry, role };
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
    parts.push(
      cushion(
        [from, seatHeight - 0.12, -d / 2 + backThickness],
        [to, seatHeight, -d / 2 + backThickness + seatDepth],
        'soft',
        0.04,
      ),
    );
    // Back cushion above it, leaning forward off the back panel.
    parts.push(
      cushion(
        [from, seatHeight, -d / 2 + backThickness],
        [to, h - 0.03, -d / 2 + backThickness + 0.16],
        'soft',
        0.05,
      ),
    );
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
    // Bentwood side frames: two curved rails per side, joined under the seat.
    for (const sign of [-1, 1]) {
      const x = sign * (halfW - 0.03);
      parts.push(box([x - 0.02, 0, -d / 2], [x + 0.02, 0.05, d / 2], 'frame'));
      parts.push(box([x - 0.02, 0, d / 2 - 0.04], [x + 0.02, seatHeight, d / 2], 'frame'));
      parts.push(box([x - 0.02, 0, -d / 2], [x + 0.02, h, -d / 2 + 0.04], 'frame'));
      parts.push(box([x - 0.02, seatHeight - 0.02, -d / 2], [x + 0.02, seatHeight + 0.02, d / 2], 'frame'));
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

  // Back legs run the full height and become the back uprights.
  for (const sign of [-1, 1]) {
    const x = sign * (halfW - legInset);
    parts.push(box([x - 0.018, 0, -d / 2 + legInset - 0.018], [x + 0.018, h, -d / 2 + legInset + 0.018], 'frame'));
    parts.push(box([x - 0.018, 0, d / 2 - legInset - 0.018], [x + 0.018, seatHeight, d / 2 - legInset + 0.018], 'frame'));
  }

  parts.push(box([-halfW, seatHeight - 0.035, -d / 2], [halfW, seatHeight, d / 2], spec.back === 'round' ? 'soft' : 'frame'));

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

  if (spec.shape === 'round') {
    const radius = Math.min(w, d) / 2;
    parts.push(cylinder([0, 0], radius, h - topThickness, h, topRole, 32));
    // Pedestal: a tapered column on a disc foot.
    parts.push(cone([0, 0], radius * 0.16, radius * 0.42, 0.02, h - topThickness, 'frame'));
    parts.push(cylinder([0, 0], radius * 0.44, 0, 0.02, 'frame', 24));
    return parts;
  }

  const halfW = w / 2;
  const halfD = d / 2;
  parts.push(box([-halfW, h - topThickness, -halfD], [halfW, h, halfD], topRole));

  const legRole: MaterialRole = spec.glass ? 'accent' : 'frame';
  const legSize = 0.035;
  const inset = 0.05;

  if (spec.legs === 'trestle') {
    // A pair of A-frames set in from the ends, plus a stretcher.
    for (const sign of [-1, 1]) {
      const x = sign * (halfW - w * 0.14);
      parts.push(box([x - 0.03, 0, -halfD + inset], [x + 0.03, h - topThickness, -halfD + inset + 0.06], legRole));
      parts.push(box([x - 0.03, 0, halfD - inset - 0.06], [x + 0.03, h - topThickness, halfD - inset], legRole));
      parts.push(box([x - 0.03, h - topThickness - 0.08, -halfD + inset], [x + 0.03, h - topThickness, halfD - inset], legRole));
    }
    parts.push(box([-halfW + w * 0.14, h * 0.25, -0.03], [halfW - w * 0.14, h * 0.25 + 0.06, 0.03], legRole));
  } else {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = sx * (halfW - inset);
        const z = sz * (halfD - inset);
        parts.push(box([x - legSize / 2, 0, z - legSize / 2], [x + legSize / 2, h - topThickness, z + legSize / 2], legRole));
      }
    }
  }

  if (spec.apron) {
    const apronTop = h - topThickness;
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
        parts.push(box([x0, y0, frontZ], [x1, y1, halfD], 'frame'));
        // Recessed finger pull along the top edge of each front.
        parts.push(box([x0 + 0.04, y1 - 0.025, halfD - 0.004], [x1 - 0.04, y1 - 0.008, halfD + 0.008], 'accent'));
      }
    }
  }

  if (spec.doors > 0) {
    const doorHeight = h - base;
    for (let i = 0; i < spec.doors; i++) {
      const x0 = -halfW + (w / spec.doors) * i + gap;
      const x1 = -halfW + (w / spec.doors) * (i + 1) - gap;
      parts.push(box([x0, base + gap, frontZ], [x1, base + doorHeight - gap, halfD], 'frame'));
      // Handle on the leading edge, mirrored about the centre of the run.
      const handleX = i < spec.doors / 2 ? x1 - 0.05 : x0 + 0.05;
      parts.push(
        cylinder([handleX, halfD + 0.012], 0.008, base + doorHeight * 0.42, base + doorHeight * 0.58, 'accent', 8),
      );
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

/** A rug: a thin slab lying on the floor. */
function buildRug(
  spec: Extract<BuildSpec, { kind: 'rug' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, depth: d, height: h } = size;
  if (spec.shape === 'round') {
    return [cylinder([0, 0], Math.min(w, d) / 2, 0, h, 'soft', 40)];
  }
  return [box([-w / 2, 0, -d / 2], [w / 2, h, d / 2], 'soft')];
}

/** A lamp: base, stem and shade. */
function buildLamp(
  spec: Extract<BuildSpec, { kind: 'lamp' }>,
  size: BuildDimensions,
): FurniturePart[] {
  const { width: w, height: h } = size;
  const radius = w / 2;
  const parts: FurniturePart[] = [];

  if (spec.style === 'floor') {
    parts.push(cylinder([0, 0], radius * 0.55, 0, 0.02, 'accent', 20));
    parts.push(cylinder([0, 0], 0.014, 0.02, h - radius * 0.9, 'accent'));
    parts.push(cone([0, 0], radius * 0.55, radius, h - radius * 0.9, h, 'shade'));
    return parts;
  }

  // Table lamp: a weighted base, a short arm and a small shade.
  parts.push(cylinder([0, 0], radius * 0.85, 0, 0.02, 'accent', 16));
  parts.push(cylinder([0, 0], 0.012, 0.02, h * 0.55, 'accent'));
  parts.push(box([-0.012, h * 0.55 - 0.012, 0], [0.012, h * 0.55 + 0.012, size.depth * 0.5], 'accent'));
  parts.push(cone([0, size.depth * 0.45], radius * 0.5, radius * 0.95, h * 0.55 - 0.14, h * 0.55 + 0.02, 'shade'));
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

  const castor = 0.05;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (halfW - 0.03);
      const z = sz * (halfD - 0.03);
      parts.push(cylinder([x, z], 0.02, 0.02, castor, 'accent', 8));
      parts.push(cylinder([x, z], 0.009, castor, h, 'accent'));
    }
  }

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
