/**
 * The things people leave on furniture.
 *
 * -----------------------------------------------------------------------------
 * AN EMPTY ROOM IS A SHOWROOM, AND A SHOWROOM DOES NOT LOOK REAL.
 *
 * Everything up to here has been about making surfaces and light behave
 * correctly, and it works — and a perfectly lit room with a perfectly modelled
 * sofa and nothing else in it still reads as a computer image, for a reason
 * that has nothing to do with rendering. Nobody lives there. There is no mug on
 * the table, nothing on the shelves, no plant, no book left face-down.
 *
 * Clutter is cheap in triangles and expensive in credibility. Three objects on
 * a coffee table do more for "this is a room" than another thousand triangles
 * of sofa.
 *
 * -----------------------------------------------------------------------------
 * PLACED BY RULE, NOT SCATTERED.
 *
 * Random placement is the thing that gives this away. Real objects sit where
 * they were PUT: on horizontal surfaces, within reach, near an edge but not on
 * it, upright. So each kind of furniture has its own rule — a table carries a
 * mug and something to read, shelves carry books, a chest of drawers carries a
 * plant — and the variation within a rule is a hash of the piece's own id, so a
 * given sofa always has the same book on it and the room does not reshuffle
 * itself every time a wall is dragged.
 *
 * That determinism is not a nicety. A rebuild happens on every edit, and
 * clutter that jumped about would turn moving a wall into the room being
 * burgled and refurnished.
 */

import * as THREE from 'three';

import { chamferedBox } from '@/scene/millwork';
import { radialSegments } from '@/scene/tessellation';

import type { FurniturePart, MaterialRole } from './builders';
import type { BuildSpec } from './catalog';

/**
 * A small deterministic generator, seeded from a string.
 *
 * Not a good random number generator and it does not need to be: what is
 * wanted is a stable, well-spread number per piece of furniture, so that two
 * bookcases in a room are not identical and the same bookcase is identical to
 * itself on every rebuild.
 */
function seeded(text: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < text.length; i++) {
    state ^= text.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A book: a board with a slightly proud block of pages inside it. */
function book(
  width: number,
  height: number,
  thickness: number,
  role: MaterialRole,
): THREE.BufferGeometry {
  /*
   * Two boxes rather than one, because the step between the cover and the
   * pages is the whole of what makes a box read as a book at this size. A
   * single slab is a brick.
   */
  const cover = chamferedBox(width, height, thickness, 0.0015);
  const pages = chamferedBox(width * 0.94, height * 0.92, thickness * 1.04, 0.001);
  pages.translate(-width * 0.02, 0, 0);
  return merge([cover, pages], role).geometry;
}

/** A mug: a tapered body, hollowed at the top, with a handle. */
function mug(radius: number, height: number): THREE.BufferGeometry {
  const sides = radialSegments(radius);
  const body = new THREE.CylinderGeometry(radius, radius * 0.82, height, sides, 1);
  body.translate(0, height / 2, 0);

  // The hollow: a slightly smaller cylinder sunk in from the rim. Open-ended,
  // so the inside is a surface rather than a cap floating in the middle.
  const well = new THREE.CylinderGeometry(radius * 0.86, radius * 0.7, height * 0.9, sides, 1, true);
  well.translate(0, height * 0.58, 0);

  const handle = new THREE.TorusGeometry(
    height * 0.28,
    radius * 0.11,
    Math.max(6, Math.round(radialSegments(radius * 0.11) / 2)),
    sides,
    Math.PI * 1.25,
  );
  handle.rotateY(Math.PI / 2);
  handle.translate(radius * 0.92, height * 0.55, 0);

  return merge([body, well, handle], 'clutter').geometry;
}

/** A plant: a tapered pot and a spray of leaves. */
function plant(height: number, random: () => number): FurniturePart[] {
  const potHeight = height * 0.32;
  const potRadius = height * 0.2;
  const sides = radialSegments(potRadius);

  const pot = new THREE.CylinderGeometry(potRadius, potRadius * 0.74, potHeight, sides, 1);
  pot.translate(0, potHeight / 2, 0);
  const rim = new THREE.TorusGeometry(potRadius, potRadius * 0.06, 6, sides);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, potHeight, 0);

  /*
   * Leaves as tapered blades on their own stems, leaning out in a fan.
   *
   * A sphere of green is the usual shortcut and reads as a topiary ball; what
   * makes a houseplant a houseplant is that its leaves are separate, they lean
   * different amounts, and you can see between them.
   */
  const leaves: THREE.BufferGeometry[] = [];
  const count = 5 + Math.floor(random() * 4);
  for (let i = 0; i < count; i++) {
    const length = height * (0.42 + random() * 0.26);
    const blade = chamferedBox(height * 0.09, length, 0.004, 0.002);
    blade.translate(0, length / 2, 0);
    blade.rotateZ((random() - 0.5) * 0.9);
    blade.rotateY((i / count) * Math.PI * 2 + random() * 0.4);
    blade.translate(0, potHeight * 0.9, 0);
    leaves.push(blade);
  }

  return [
    merge([pot, rim], 'clutter'),
    merge(leaves, 'foliage'),
  ];
}

/** A folded towel or throw: three stacked slabs, each a little offset. */
function folded(width: number, depth: number, random: () => number): THREE.BufferGeometry {
  const layers: THREE.BufferGeometry[] = [];
  let y = 0;
  for (let i = 0; i < 3; i++) {
    const thickness = 0.012 + random() * 0.006;
    const slab = chamferedBox(width * (1 - i * 0.04), thickness, depth * (1 - i * 0.05), 0.006);
    slab.translate((random() - 0.5) * 0.012, y + thickness / 2, (random() - 0.5) * 0.012);
    layers.push(slab);
    y += thickness;
  }
  return merge(layers, 'soft').geometry;
}

/** Concatenates geometries into one part. */
function merge(geometries: THREE.BufferGeometry[], role: MaterialRole): FurniturePart {
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
  return { geometry: merged, role };
}

/** Places a part at a point on the piece's own local axes. */
function at(part: FurniturePart, x: number, y: number, z: number, turn = 0): FurniturePart {
  if (turn !== 0) part.geometry.rotateY(turn);
  part.geometry.translate(x, y, z);
  return part;
}

/**
 * What sits on a given piece of furniture.
 *
 * `seed` is the piece's own id, so the same piece always carries the same
 * things — see the header for why that matters more than it sounds.
 */
export function clutterFor(
  spec: BuildSpec,
  size: { width: number; depth: number; height: number },
  seed: string,
): FurniturePart[] {
  const random = seeded(seed);
  const parts: FurniturePart[] = [];
  const { width: w, depth: d, height: h } = size;

  switch (spec.kind) {
    case 'table':
    case 'desk': {
      /*
       * On a table: something to drink from and something to read, placed
       * within reach of an edge rather than in the middle. A mug in the dead
       * centre of a dining table is where nobody has ever put one.
       */
      const top = h;
      parts.push(at(mugPart(), w * (0.18 + random() * 0.14), top, d * (random() - 0.5) * 0.5));

      const stack = 1 + Math.floor(random() * 3);
      let y = top;
      for (let i = 0; i < stack; i++) {
        const thickness = 0.022 + random() * 0.016;
        const b = merge([book(0.15, 0.21, thickness, 'clutter')], 'clutter');
        b.geometry.rotateX(-Math.PI / 2);
        parts.push(at(b, -w * 0.2, y + thickness / 2, d * (random() - 0.5) * 0.4, random() * 0.5));
        y += thickness;
      }

      if (spec.kind === 'desk' || random() > 0.5) {
        for (const part of plant(0.34, random)) {
          parts.push(at(part, w * (random() - 0.5) * 0.4, top, -d * 0.28));
        }
      }
      break;
    }

    case 'shelving': {
      /*
       * Books on shelves, in runs with gaps — a shelf packed end to end looks
       * like a library's, and a shelf with three books evenly spaced looks like
       * a catalogue photograph. Real shelves have runs and gaps.
       */
      const rows = Math.max(1, spec.rows);
      const shelfSpacing = h / rows;
      for (let row = 0; row < rows; row++) {
        const y = shelfSpacing * row + 0.02;
        let x = -w / 2 + 0.05;
        while (x < w / 2 - 0.08) {
          if (random() > 0.75) {
            // A gap, which is what makes it a shelf somebody uses.
            x += 0.05 + random() * 0.12;
            continue;
          }
          const thickness = 0.018 + random() * 0.022;
          const height = shelfSpacing * (0.5 + random() * 0.18);
          const b = merge([book(0.13, height, thickness, 'clutter')], 'clutter');
          b.geometry.rotateY(Math.PI / 2);
          parts.push(at(b, x + thickness / 2, y + height / 2, 0));
          x += thickness + 0.002;
        }
      }
      break;
    }

    case 'cabinet': {
      for (const part of plant(0.45, random)) {
        parts.push(at(part, w * 0.26, h, 0));
      }
      const bowl = mugPart();
      parts.push(at(bowl, -w * 0.22, h, d * 0.05));
      break;
    }

    case 'bed': {
      // Pillows against the headboard and a throw folded across the foot.
      for (const sign of [-1, 1]) {
        const pillow = merge([chamferedBox(w * 0.42, 0.1, d * 0.2, 0.035)], 'soft');
        parts.push(at(pillow, sign * w * 0.22, h + 0.05, -d * 0.36));
      }
      parts.push(at(merge([folded(w * 0.8, d * 0.22, random)], 'soft'), 0, h, d * 0.3));
      break;
    }

    case 'trolley':
    case 'sofa':
    case 'armchair':
    case 'chair':
    case 'rug':
    case 'lamp':
    default:
      /*
       * Nothing, on purpose.
       *
       * A sofa with a book balanced on its arm is a photograph's idea of a
       * sofa. Things get left on HORIZONTAL surfaces at working height, and a
       * rule that put something on every piece of furniture would be the
       * scattering this exists to avoid.
       */
      break;
  }

  return parts;
}

/** A mug as a part, so the switch above reads as placement rather than geometry. */
function mugPart(): FurniturePart {
  return merge([mug(0.042, 0.095)], 'clutter');
}
