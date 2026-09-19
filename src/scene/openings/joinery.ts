/**
 * Doors and windows built the way a joiner builds them.
 *
 * -----------------------------------------------------------------------------
 * A DOOR IS NOT A SLAB.
 *
 * Until now every leaf in this building was one box: the right size, the right
 * colour, and instantly recognisable as not a door. A real door — almost any
 * real door, from a 1900 terrace to a flat-pack replacement — is a frame of
 * stiles and rails with panels set back inside it, and the whole reason it
 * reads as a door from across a room is the shadow line where the panel drops
 * away from the frame.
 *
 * That shadow line is why this belongs in a realism pass rather than a detail
 * pass. It is a ten-millimetre step, and ten millimetres of depth on a flat
 * surface at eye height does more for "this is a real place" than any amount of
 * texture on the flat surface would.
 *
 * -----------------------------------------------------------------------------
 * THE PROPORTIONS ARE NOT INVENTED.
 *
 * Stiles at 105 mm, top rail the same, lock rail a little heavier at 155 mm and
 * a bottom rail heavier again at 195 mm. That progression is the convention and
 * it is not decorative: the bottom rail takes the kicks and the lock rail
 * carries the mortice, so both are made deeper. A door with rails all the same
 * width looks subtly wrong to people who could not tell you why.
 *
 * Everything scales down on a narrow door rather than overflowing it, because
 * cupboard doors and 600 mm cloakroom doors both exist and a 105 mm stile on a
 * 400 mm leaf leaves no panel at all.
 *
 * -----------------------------------------------------------------------------
 * SHAKER AND FIELDED.
 *
 * Two panel treatments, and the difference is one line of geometry. A shaker
 * panel is flat and set back; a fielded panel is set back and then raised again
 * in the middle with a bevel running round it. The bevel is what catches the
 * light, which is the entire point — and `ExtrudeGeometry` produces exactly
 * that shape with its bevel options, so the fielded panel costs nothing extra
 * to build.
 */

import * as THREE from 'three';

import { chamferedBox } from '@/scene/millwork';
import { creaseNormals } from '@/scene/shading';

/** Width of the vertical stiles at each edge of a leaf, in metres. */
const STILE = 0.105;
/** Width of the rail across the top. */
const TOP_RAIL = 0.105;
/** Width of the rail across the bottom, heavier because it takes the kicks. */
const BOTTOM_RAIL = 0.195;
/** Width of the middle rail, heavier than the top because it holds the lock. */
const LOCK_RAIL = 0.155;

/**
 * How far a panel sits back from the face of the frame, in metres.
 *
 * Ten millimetres a side, which leaves a 40 mm door with a 20 mm panel. That is
 * thin for a real door and right for this one: the number that matters is the
 * STEP, because the step is what casts the shadow that makes the door read.
 */
const RECESS = 0.010;

/**
 * The smallest a stile or rail may be squeezed to before the leaf gives up.
 *
 * Below this there is no panel left and the joinery is drawing lines rather
 * than describing a thing. A leaf that narrow gets a plain slab, which is
 * honest: a 300 mm door is a cupboard front and cupboard fronts are slabs.
 */
const MIN_MEMBER = 0.035;

export type PanelStyle = 'shaker' | 'fielded' | 'flush';

export interface LeafOptions {
  /** How the panels are treated, or `flush` for a plain slab. */
  style: PanelStyle;
  /**
   * How many panels tall.
   *
   * Two is the ordinary interior door, split by the lock rail. Four and six
   * belong to period doors and to tall front doors; one is a flush panel in a
   * frame, which is what most modern glazed doors are.
   */
  rows: number;
}

/**
 * A door leaf, centred on the origin, lying in the XY plane.
 *
 * The caller places and hinges it. Nothing here knows where the door is or
 * which way it opens, which is the same contract the slab had.
 */
export function panelledLeaf(
  width: number,
  height: number,
  thickness: number,
  options: LeafOptions,
): THREE.BufferGeometry {
  if (options.style === 'flush') return chamferedBox(width, height, thickness);

  /*
   * The members, squeezed to fit rather than allowed to overflow.
   *
   * A narrow leaf gets narrower stiles in the same proportion to one another,
   * so a cupboard door still looks like a small door and not like a door with
   * the middle missing. The cap is a quarter of the width, which on a 900 mm
   * leaf never binds and on a 450 mm one does all the work.
   */
  const scale = Math.min(1, width / (STILE * 4), height / ((TOP_RAIL + BOTTOM_RAIL) * 3));
  const stile = STILE * scale;
  const topRail = TOP_RAIL * scale;
  const bottomRail = BOTTOM_RAIL * scale;
  const lockRail = LOCK_RAIL * scale;

  const rows = Math.max(1, Math.round(options.rows));
  const dividers = rows - 1;

  // Is there anything left to make a panel out of?
  const fieldHeight = height - topRail - bottomRail - lockRail * dividers;
  const fieldWidth = width - stile * 2;
  if (
    stile < MIN_MEMBER ||
    topRail < MIN_MEMBER ||
    fieldWidth < MIN_MEMBER * 2 ||
    fieldHeight < MIN_MEMBER * 2
  ) {
    return chamferedBox(width, height, thickness);
  }

  const pieces: THREE.BufferGeometry[] = [];

  const halfW = width / 2;
  const halfH = height / 2;

  /** A frame member, positioned by its own extent rather than its centre. */
  const member = (x0: number, y0: number, x1: number, y1: number): void => {
    const geometry = chamferedBox(x1 - x0, y1 - y0, thickness);
    geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    pieces.push(geometry);
  };

  // Stiles, full height, at each edge.
  member(-halfW, -halfH, -halfW + stile, halfH);
  member(halfW - stile, -halfH, halfW, halfH);

  // Rails, running between the stiles.
  const inLeft = -halfW + stile;
  const inRight = halfW - stile;
  member(inLeft, halfH - topRail, inRight, halfH);
  member(inLeft, -halfH, inRight, -halfH + bottomRail);

  /*
   * The panel openings, stacked from the bottom.
   *
   * Each row gets the same share of what is left after the rails, which is what
   * a joiner does on a two-panel door and NOT what they do on a traditional
   * six-panel one — where the bottom panels are deliberately taller. That is a
   * refinement for a period door style, and an even split is right for the two
   * and four panel doors that are almost all of them.
   */
  const rowHeight = fieldHeight / rows;
  let y = -halfH + bottomRail;

  for (let row = 0; row < rows; row++) {
    const panelBottom = y;
    const panelTop = y + rowHeight;

    pieces.push(panel(inLeft, panelBottom, inRight, panelTop, thickness, options.style));

    y = panelTop;
    if (row < rows - 1) {
      member(inLeft, y, inRight, y + lockRail);
      y += lockRail;
    }
  }

  const merged = concatenate(pieces);
  /*
   * Creased rather than left as built, and it is the fielded panel that needs
   * it: its bevel is four flat faces meeting the flat of the field, and at a
   * shallow bevel angle those want to read as one soft surface. The frame's own
   * right angles are far past the crease angle and stay sharp.
   */
  return creaseNormals(merged);
}

/**
 * One panel, set back into the leaf.
 *
 * Shaker: a flat board, recessed, with its edges eased. The step at its border
 * is the whole effect.
 *
 * Fielded: the same board with a bevel run round it so the middle stands proud
 * again. `ExtrudeGeometry`'s bevel does exactly this, and the shape it makes —
 * a flat field with four sloping margins — is what "fielded" means.
 */
function panel(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  style: PanelStyle,
): THREE.BufferGeometry {
  const width = x1 - x0;
  const height = y1 - y0;
  const centreX = (x0 + x1) / 2;
  const centreY = (y0 + y1) / 2;

  if (style === 'shaker') {
    const geometry = chamferedBox(width, height, thickness - RECESS * 2);
    geometry.translate(centreX, centreY, 0);
    return geometry;
  }

  /*
   * The bevel, and why it is a quarter of the recess rather than all of it.
   *
   * A fielded panel's raised middle sits a little BELOW the face of the frame,
   * never proud of it — a panel standing higher than its own frame is a
   * mistake, not a style. So the field rises by most of the recess and the
   * bevel runs down from it over a margin several times its own height, which
   * is the shallow angle that makes the margin catch light as a soft band.
   */
  const rise = RECESS * 0.7;
  const margin = Math.min(0.045, Math.min(width, height) * 0.18);
  const core = thickness - RECESS * 2 - rise * 2;

  /*
   * The shape is the RAISED FIELD, and the bevel grows outward from it.
   *
   * This was got wrong once and the wrong version looked entirely reasonable in
   * the source. `bevelSize` in `ExtrudeGeometry` does not inset the ends — it
   * EXPANDS the middle. Drawing the shape at the panel's full width therefore
   * produced a panel 45 mm wider than the gap between the stiles, lapping over
   * them on both sides. Measured, not spotted: the vertices at the widest depth
   * came back at x = 0.380 where the stile's inner face is at 0.335.
   *
   * So the shape is the small front face and the extrusion swells to the
   * panel's true size in the middle. Read front to back that is exactly a
   * fielded panel: a raised field, a margin sloping down and out, then the full
   * width of the board where it meets the frame.
   */
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2 + margin, -height / 2 + margin);
  shape.lineTo(width / 2 - margin, -height / 2 + margin);
  shape.lineTo(width / 2 - margin, height / 2 - margin);
  shape.lineTo(-width / 2 + margin, height / 2 - margin);
  shape.closePath();

  const depth = Math.max(0.002, core);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: rise,
    bevelSize: margin,
    bevelOffset: 0,
    bevelSegments: 1,
  });

  /*
   * Placed by its FRONT face, not by its centre.
   *
   * The raised field has to end up exactly one recess behind the face of the
   * frame — never proud of it, which is a mistake rather than a style, and
   * never so far back that the bevel disappears. The extrusion's front is at
   * depth + rise, so that is the point to line up.
   */
  const front = thickness / 2 - RECESS;
  geometry.translate(centreX, centreY, front - (depth + rise));
  return geometry;
}

/* ------------------------------- Windows ------------------------------- */

export interface SashOptions {
  /** Vertical glazing bars across the opening. */
  mullions: number;
  /** Horizontal glazing bars up the opening. */
  transoms: number;
}

/**
 * A window sash: the frame that actually holds the glass.
 *
 * -----------------------------------------------------------------------------
 * A WINDOW IS TWO FRAMES, NOT ONE.
 *
 * The old geometry had a single band round the hole and a pane in the middle,
 * which is the diagram of a window rather than a window. A real one has an
 * outer frame fixed to the wall and a sash inside it holding the glass, with a
 * step between the two — and that step is the line you actually see when you
 * look at a window from inside a room.
 *
 * Built in the opening's own coordinates: X across, Y up, Z through the wall,
 * with the caller supplying the four edges and the depth band to sit in.
 */
export function sashFrame(
  left: number,
  bottom: number,
  right: number,
  top: number,
  zMin: number,
  zMax: number,
  options: SashOptions,
): THREE.BufferGeometry | null {
  const width = right - left;
  const height = top - bottom;
  if (width <= 0 || height <= 0) return null;

  /*
   * Sash sections, scaled to the opening.
   *
   * A 45 mm sash on a 1.2 m window is right; the same 45 mm on a 400 mm
   * rooflight is a porthole. The cap keeps it proportionate without letting it
   * grow on a patio door, where a heavy sash would look like a shop front.
   */
  const section = Math.min(0.045, Math.min(width, height) * 0.09);
  const bar = Math.min(0.022, section * 0.55);
  if (section < 0.008) return null;

  const pieces: THREE.BufferGeometry[] = [];
  const add = (x0: number, y0: number, x1: number, y1: number): void => {
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return;
    const geometry = chamferedBox(x1 - x0, y1 - y0, zMax - zMin);
    geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, (zMin + zMax) / 2);
    pieces.push(geometry);
  };

  // The sash: stiles at the sides, rails top and bottom.
  add(left, bottom, left + section, top);
  add(right - section, bottom, right, top);
  add(left + section, top - section, right - section, top);
  add(left + section, bottom, right - section, bottom + section);

  const innerLeft = left + section;
  const innerRight = right - section;
  const innerBottom = bottom + section;
  const innerTop = top - section;

  // Glazing bars, evenly spaced across the light the sash encloses.
  const across = Math.max(0, Math.round(options.mullions));
  for (let i = 1; i <= across; i++) {
    const centre = innerLeft + ((innerRight - innerLeft) * i) / (across + 1);
    add(centre - bar / 2, innerBottom, centre + bar / 2, innerTop);
  }

  const up = Math.max(0, Math.round(options.transoms));
  for (let i = 1; i <= up; i++) {
    const centre = innerBottom + ((innerTop - innerBottom) * i) / (up + 1);
    add(innerLeft, centre - bar / 2, innerRight, centre + bar / 2);
  }

  return pieces.length > 0 ? concatenate(pieces) : null;
}

/* ------------------------------- Merging ------------------------------- */

/**
 * Concatenates geometries into one, de-indexing first.
 *
 * The same trap `wallBuilder` documents: a `BoxGeometry` holds 24 unique
 * corners behind a 36-entry index, so copying raw attributes and dropping the
 * index scrambles every face. Extruded panels arrive non-indexed already, and
 * mixing the two is exactly when this bites.
 *
 * Only position, normal and uv are carried. Anything else a source geometry
 * happens to have would need the same treatment and none of these have any.
 */
function concatenate(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geometries.map((geometry) => {
    const result = geometry.index ? geometry.toNonIndexed() : geometry;
    if (result !== geometry) geometry.dispose();
    if (!result.getAttribute('normal')) result.computeVertexNormals();
    if (!result.getAttribute('uv')) {
      const count = result.getAttribute('position').count;
      result.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    return result;
  });

  let vertices = 0;
  for (const geometry of flat) vertices += geometry.getAttribute('position').count;

  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);

  let at = 0;
  for (const geometry of flat) {
    const position = geometry.getAttribute('position');
    positions.set(position.array as Float32Array, at * 3);
    normals.set(geometry.getAttribute('normal').array as Float32Array, at * 3);
    uvs.set(geometry.getAttribute('uv').array as Float32Array, at * 2);
    at += position.count;
    geometry.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return merged;
}
