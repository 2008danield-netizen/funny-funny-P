/**
 * How much sky each point of the building can actually see.
 *
 * -----------------------------------------------------------------------------
 * THE SUN IS BLOCKED BY THE BUILDING. THE AMBIENT LIGHT IS NOT.
 *
 * This is the single biggest reason the rooms in this app have looked flat, and
 * it took three sessions of fixing other things to find it.
 *
 * Shadow mapping does its job: stand inside a closed room and the sun correctly
 * does not reach you. But the hemisphere light and the environment probe have no
 * notion of occlusion at all. They light every surface as though it were sitting
 * in an open field. A wall in the middle of a house, with a ceiling directly
 * above it and three other walls around it, receives exactly as much "sky" as
 * the outside of the roof does.
 *
 * The consequence is not subtle, and it explains why tuning the sun-to-ambient
 * ratio in session 17 changed almost nothing indoors. That ratio — 3.2 to 1 —
 * is the ratio OUTSIDE. Step through a door and the sun's contribution collapses
 * to near zero while the ambient stays at full strength, so indoors the ratio
 * silently inverts and ambient wins about three to one. Uniform light from every
 * direction at once is the definition of a flat picture, and no amount of
 * chamfering, moulding or screen-space occlusion survives it.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD.
 *
 * For every vertex of every surface that carries light, cast a spread of rays
 * over the hemisphere it faces and count how many escape the building. That
 * fraction — how much sky this point can see — multiplies the ambient term and
 * nothing else.
 *
 * It is the thing game engines bake, and it buys, correctly and all at once:
 * corners that darken, light that falls off as you walk away from a window, the
 * underside of every shelf going dark, a cupboard interior that is actually
 * dark, and a room that is dimmer than the garden outside it.
 *
 * It is also what finally makes geometry visible. A cove moulding or a 2 mm
 * chamfer only reads because its surface turns relative to the light; under
 * uniform light there is nothing for it to turn relative to. Every bit of
 * modelling detail added before this was invisible for want of this.
 *
 * -----------------------------------------------------------------------------
 * WHY PER-VERTEX AND NOT A LIGHTMAP.
 *
 * A lightmap is better and needs a UV unwrap — every surface in the building
 * packed, without overlap, into one texture. That is a large piece of machinery
 * and it has to be redone on every plan edit.
 *
 * Per-vertex needs no unwrap at all, because session 18's subdivision already
 * gave every surface a vertex roughly every quarter-metre. The cost is that
 * detail finer than that quarter-metre cannot be represented — which is exactly
 * the trade the subdivision was chosen to make, since corner darkening falls off
 * over about half a metre.
 */

import * as THREE from 'three';

import { Bvh } from './bvh';

/** How many rays each vertex casts over its hemisphere. */
const SAMPLES = 48;

/**
 * The most rays one bake may cast, across every surface.
 *
 * Roughly a second of work in a browser. Past that the bake is spread thinner
 * rather than allowed to run longer: a large building gets fewer samples per
 * point, which is noisier, instead of a frozen tab, which is unusable.
 */
const MAX_RAYS = 400000;

/**
 * How far a ray travels before it counts as having escaped, in metres.
 *
 * Not infinity, and the reason is what this is measuring. The question is "can
 * this point see sky", and a ray that has travelled twelve metres inside a house
 * without hitting anything is, in every real plan, on its way out of a window or
 * a doorway. Capping it keeps the cost bounded on a large model and makes no
 * difference to the answer in a domestic one.
 */
const REACH = 12;

/**
 * How far off the surface each ray starts, in metres.
 *
 * The classic self-intersection guard. A ray leaving exactly from the surface
 * it belongs to will, at grazing angles, immediately hit that same surface and
 * report the point as fully enclosed. The result is a mesh covered in black
 * speckle, which is the single most recognisable symptom of a bake with no
 * offset — and two millimetres is plenty to avoid it without letting rays start
 * inside a neighbouring wall.
 */
const OFFSET = 0.002;


/**
 * How many times the baked field is averaged with itself before it is used.
 *
 * -----------------------------------------------------------------------------
 * THE FIRST PICTURE OUT OF THE WORKING BAKE HAD TRIANGLES IN IT.
 *
 * Visibly: a sawtooth of light and dark running down a wall near a corner, in
 * exactly the zigzag the tessellator's triangles make. It is not noise and more
 * rays would not have removed it.
 *
 * The cause is that a per-vertex bake can only represent detail as fine as the
 * vertices are spaced, and the tessellator does not space them evenly — it
 * splits along the longest edge, so some vertices land where visibility is
 * changing quickly and their neighbours do not. Linear interpolation across the
 * triangles between them then draws the mesh rather than the light.
 *
 * Averaging each value with its neighbours along the mesh's own edges removes
 * exactly the variation that is one triangle wide — which is precisely the
 * variation the mesh cannot honestly represent — and leaves the metre-scale
 * gradient, which is what the bake is for, almost untouched. Two passes: one is
 * not quite enough on a bad corner, and past three the corner darkening itself
 * starts to wash out.
 */
const SMOOTH_PASSES = 2;

/**
 * How many times the BOUNCE is averaged, which is far more.
 *
 * -----------------------------------------------------------------------------
 * THE FIRST DAYLIT ROOM CAME OUT BLOTCHY.
 *
 * Grey smears across a wall, twenty or thirty centimetres across. It looked
 * like occlusion noise and it was not: the screen-space pass was innocent, and
 * doubling its samples changed nothing. The smears were at exactly the spacing
 * of the mesh's own vertices, which is what gives it away — the bounce is
 * gathered at twelve rays a point, and twelve rays is about thirty per cent
 * noise on a value that then gets stretched across a quarter of a metre.
 *
 * The fix is not more rays. The bounce is a LOW-FREQUENCY term by design: the
 * whole reason it is sampled coarsely is that bounced colour changes over
 * metres, so anything varying from one vertex to the next is noise by
 * definition and can be averaged away without losing a thing. Five passes
 * removes it; the sky visibility keeps two, because its variation over a
 * quarter-metre is the corner darkening and is real.
 */
const BOUNCE_SMOOTH_PASSES = 5;

/**
 * The light the building is standing in, in linear working colour space.
 *
 * Built by `Lighting.bakeLight()` off the live lights, not off a preset, so the
 * bake and the render are never describing different times of day.
 */
export interface BakeLight {
  /** Sky colour times the hemisphere light's intensity. */
  sky: THREE.Color;
  /** What the ground throws back up, times the same intensity. */
  ground: THREE.Color;
  /** Direction TOWARDS the sun, normalised. */
  sun: THREE.Vector3;
  /** Sun colour times its intensity. */
  sunColour: THREE.Color;
}

/** A white sky with no sun, for a bake that was given no lighting to stand in. */
const PLAIN_LIGHT: BakeLight = {
  sky: new THREE.Color(1, 1, 1),
  ground: new THREE.Color(0.35, 0.33, 0.3),
  sun: new THREE.Vector3(0, 1, 0),
  sunColour: new THREE.Color(0, 0, 0),
};

/**
 * How many rays each surface a bounce comes OFF casts to find its own light.
 *
 * Far fewer than a point gets, and for a reason that is not thrift. This number
 * decides how brightly one patch of floor glows, and a patch of floor is a
 * whole triangle of the coarse geometry — the result is already averaged over
 * something the size of a doorway. Sampling it finely would be measuring a
 * quantity that has been thrown away before it is used.
 */
const SOURCE_SAMPLES = 6;

/**
 * How many rays each point casts to gather colour from its surroundings.
 *
 * A quarter of what the sky visibility gets, deliberately, because the two
 * measure different things. Sky visibility carries the CORNER — a gradient that
 * changes over centimetres and is the whole reason for the bake — and needs the
 * rays. Bounced colour changes over metres: the wall near a wood floor is
 * warmer than the wall near a window, and twelve rays resolve that perfectly
 * well. Spending forty-eight on it would roughly double the bake for detail
 * that is not there to find.
 */
const BOUNCE_SAMPLES = 12;

/**
 * How dark the bounce may leave a place that sees no sky at all, 0 to 1.
 *
 * This is what `FLOOR` used to be for, and it is now a tenth of what it was.
 *
 * The old floor of 0.12 was a stand-in: a point deep inside a cupboard sees no
 * sky, its honest sky visibility is zero, and rendering that as black is wrong
 * because the light that really reaches such a place arrives bounced. With the
 * bounce actually computed, that stand-in is doing the bounce's job badly and
 * mostly needs to get out of the way — but not entirely, because this is ONE
 * bounce, and a real cupboard is lit by the third and fourth.
 */
const FLOOR = 0.012;

export interface BakeResult {
  /** Vertices visited. */
  vertices: number;
  /** Rays cast. */
  rays: number;
  /** Milliseconds taken. */
  ms: number;
  /** Mean sky visibility, for a check to assert the bake did something. */
  mean: number;
  /** The darkest vertex found. */
  darkest: number;
  /** Rays per point actually afforded, which a large building reduces. */
  samples: number;
  /** Mean bounce added on top of the sky, as a fraction of open daylight. */
  bounce: number;
  /** How far the bounce's colour departs from grey, 0 to 1. See `chroma`. */
  chroma: number;
}

/**
 * Builds the set of directions each vertex samples.
 *
 * A cosine-weighted hemisphere, which is not an aesthetic choice: diffuse
 * surfaces respond to incoming light in proportion to the cosine of its angle
 * from the normal, so sampling in that same proportion spends rays where they
 * affect the answer and none where they barely would. Uniform sampling needs
 * roughly three times as many rays for the same noise.
 *
 * The spiral is the standard trick for spreading points evenly on a disc
 * without clumping, which random sampling at 48 rays badly does.
 */
function hemisphereDirections(count: number): THREE.Vector3[] {
  const directions: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    // Even spread over the disc, then lifted onto the hemisphere. The square
    // root is what makes it cosine-weighted rather than uniform.
    const radius = Math.sqrt((i + 0.5) / count);
    const theta = i * golden;

    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    const y = Math.sqrt(Math.max(0, 1 - radius * radius));

    directions.push(new THREE.Vector3(x, y, z));
  }
  return directions;
}

const DIRECTIONS = hemisphereDirections(SAMPLES);

/** How many distinct positions the surfaces hold, to the millimetre. */
function countDistinct(surfaces: readonly THREE.Mesh[]): number {
  const seen = new Set<string>();
  for (const mesh of surfaces) {
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    for (let v = 0; v < position.count; v++) {
      seen.add(
        `${Math.round(position.getX(v) * 1000)},` +
          `${Math.round(position.getY(v) * 1000)},` +
          `${Math.round(position.getZ(v) * 1000)}`,
      );
    }
  }
  return seen.size;
}

/**
 * Averages a per-group value with its neighbours along the mesh's own edges.
 *
 * Exported because it is the one piece of the bake whose correctness is not
 * obvious from the picture: a smoothing pass that averaged the wrong things
 * would still produce a smooth result, just the wrong one.
 *
 * `groupOf` maps each vertex to the group holding its value, which is how
 * vertices at the same position — of which non-indexed geometry has many — are
 * treated as one point rather than as separate, unconnected islands.
 *
 * The weighting is half the point's own value and half the mean of its
 * neighbours. Full replacement by the neighbour mean would drift the field
 * across several passes; half is the standard Laplacian smoothing weight and
 * converges on the local average without moving it.
 */
export function smoothAlongEdges(
  geometry: THREE.BufferGeometry,
  groupOf: Int32Array,
  values: Float32Array,
  passes: number,
): void {
  if (passes <= 0 || values.length === 0) return;

  const index = geometry.index;
  const position = geometry.getAttribute('position');
  if (!position) return;
  const corners = index ? index.count : position.count;
  if (corners < 3) return;

  /*
   * Neighbours as one flat pair list rather than an array of arrays.
   *
   * Each triangle contributes its three edges, both ways round, and duplicates
   * are left in deliberately: an edge shared by two triangles counts twice,
   * which weights a neighbour by how much of the surface it actually shares —
   * the same reason area weighting is used for smooth normals.
   */
  const from: number[] = [];
  const to: number[] = [];

  const link = (a: number, b: number): void => {
    const ga = groupOf[a] ?? -1;
    const gb = groupOf[b] ?? -1;
    if (ga < 0 || gb < 0 || ga === gb) return;
    from.push(ga);
    to.push(gb);
    from.push(gb);
    to.push(ga);
  };

  for (let i = 0; i + 2 < corners; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    link(a, b);
    link(b, c);
    link(c, a);
  }

  const sums = new Float32Array(values.length);
  const counts = new Float32Array(values.length);

  for (let pass = 0; pass < passes; pass++) {
    sums.fill(0);
    counts.fill(0);

    for (let e = 0; e < from.length; e++) {
      const a = from[e]!;
      sums[a] = sums[a]! + values[to[e]!]!;
      counts[a] = counts[a]! + 1;
    }

    for (let g = 0; g < values.length; g++) {
      const count = counts[g]!;
      // A point with no neighbours — a stray vertex, or a mesh of one triangle
      // — keeps what it measured. Averaging it with nothing would be zero.
      if (count === 0) continue;
      values[g] = values[g]! * 0.5 + (sums[g]! / count) * 0.5;
    }
  }
}

/**
 * How far a colour departs from grey, 0 to 1.
 *
 * Reported by the bake because "the bounce carries colour" is a claim that can
 * be checked, and the number that checks it is not the mean brightness. A
 * bounce that is exactly grey everywhere would raise `bounce` handsomely and
 * would have failed at the one thing this pass is for. This is the spread
 * between the strongest and weakest channel, relative to the strongest.
 */
function chroma(r: number, g: number, b: number): number {
  const high = Math.max(r, g, b);
  if (high <= 1e-6) return 0;
  return (high - Math.min(r, g, b)) / high;
}

/**
 * `smoothAlongEdges`, applied to each channel of an interleaved RGB field.
 *
 * The bounce needs the same treatment as the sky visibility and for the same
 * reason — a per-vertex value on an unevenly tessellated mesh draws the mesh —
 * and in fact needs it more, being gathered at a quarter of the rays.
 */
function smoothChannels(
  geometry: THREE.BufferGeometry,
  groupOf: Int32Array,
  values: Float32Array,
  passes: number,
): void {
  const count = values.length / 3;
  const channel = new Float32Array(count);

  for (let c = 0; c < 3; c++) {
    for (let g = 0; g < count; g++) channel[g] = values[g * 3 + c]!;
    smoothAlongEdges(geometry, groupOf, channel, passes);
    for (let g = 0; g < count; g++) values[g * 3 + c] = channel[g]!;
  }
}

/**
 * What every triangle in the building gives off, per side, in linear RGB.
 *
 * -----------------------------------------------------------------------------
 * WHY EVERY TRIANGLE IS TWO SURFACES.
 *
 * A wall has an inside and an outside, and they are lit completely differently
 * — the point of the whole exercise. The same is true of a ceiling, a worktop,
 * a door. So each triangle is measured twice, once along its normal and once
 * against it, and a bounce ray picks the side it arrived on.
 *
 * Getting that wrong is not a small error. Take the colour of the sunlit
 * OUTSIDE of a wall and paint it on the inside, and every room in the house
 * glows as though the walls were made of paper.
 *
 * -----------------------------------------------------------------------------
 * WHAT LANDS ON A SURFACE, AND WHAT LEAVES IT.
 *
 * What lands is the sky it can see, plus the sun if the sun can see it. What
 * leaves is that, times how much the surface reflects — its albedo, which the
 * tree carries per triangle.
 *
 * The result is six floats per triangle: three for the front, three for the
 * back. Flat arrays rather than objects, because this is read once per bounce
 * ray and a few hundred thousand property lookups are not free.
 */
function gatherSourceRadiance(bvh: Bvh, light: BakeLight): Float32Array {
  const out = new Float32Array(bvh.triangleCount * 6);
  if (bvh.triangleCount === 0) return out;

  const directions = hemisphereDirections(SOURCE_SAMPLES);

  const normal = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const facing = new THREE.Vector3();

  for (let t = 0; t < bvh.triangleCount; t++) {
    bvh.normalOf(t, normal);
    bvh.centroidOf(t, centre);

    const albedoR = bvh.albedo ? bvh.albedo[t * 3]! : 0.5;
    const albedoG = bvh.albedo ? bvh.albedo[t * 3 + 1]! : 0.5;
    const albedoB = bvh.albedo ? bvh.albedo[t * 3 + 2]! : 0.5;

    for (const sign of [1, -1]) {
      facing.copy(normal).multiplyScalar(sign);

      if (Math.abs(facing.y) < 0.99) tangent.set(0, 1, 0).cross(facing).normalize();
      else tangent.set(1, 0, 0).cross(facing).normalize();
      bitangent.crossVectors(facing, tangent);

      origin.copy(centre).addScaledVector(facing, OFFSET);

      let open = 0;
      for (const sample of directions) {
        direction
          .copy(tangent)
          .multiplyScalar(sample.x)
          .addScaledVector(facing, sample.y)
          .addScaledVector(bitangent, sample.z)
          .normalize();

        if (!bvh.anyHit(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, REACH)) {
          open++;
        }
      }
      const sky = open / SOURCE_SAMPLES;

      /*
       * The sun, which on a sunlit floor is most of the bounce.
       *
       * Lambert's cosine law, then one shadow ray. A surface turned away from
       * the sun gets nothing without a ray being cast at all, which is most of
       * the triangles in a building and so is worth the branch.
       */
      let sun = 0;
      const cosine = facing.dot(light.sun);
      if (cosine > 0) {
        if (!bvh.anyHit(origin.x, origin.y, origin.z, light.sun.x, light.sun.y, light.sun.z, REACH)) {
          sun = cosine;
        }
      }

      const base = t * 6 + (sign === 1 ? 0 : 3);
      out[base] = albedoR * (light.sky.r * sky + light.sunColour.r * sun);
      out[base + 1] = albedoG * (light.sky.g * sky + light.sunColour.g * sun);
      out[base + 2] = albedoB * (light.sky.b * sky + light.sunColour.b * sun);
    }
  }

  return out;
}

/**
 * Bakes sky visibility and one bounce of coloured light into each mesh.
 *
 * `surfaces` are the meshes that receive the bake; `occluders` are everything
 * that can block a ray, which is normally the surfaces plus the furniture. The
 * two lists differ because a sofa should darken the wall behind it without
 * itself needing per-vertex shading.
 *
 * Two attributes come out, and they are separate on purpose. `bakedAmbient` is
 * a single float: how much open sky this point can see, sampled finely because
 * it carries the corner darkening. `bakedBounce` is an RGB: the light that
 * arrived here off other surfaces, sampled coarsely because it changes over
 * metres rather than centimetres. The shader adds them.
 */
export function bakeSkyVisibility(
  surfaces: readonly THREE.Mesh[],
  occluders: readonly THREE.Object3D[],
  light: BakeLight = PLAIN_LIGHT,
): BakeResult {
  const started = Date.now();

  /*
   * Rays are cast against the COARSE geometry, not against what is drawn.
   *
   * Session 18's subdivision gave every wall several hundred triangles so that
   * light could vary across it. The bake does not need any of them: the coarse
   * geometry describes exactly the same surface — window holes included — with
   * about twenty triangles, which is all an intersection test looks at.
   * `subdivide.ts` keeps it for this.
   */
  const proxies: THREE.Mesh[] = [];

  for (const object of occluders) {
    if (!object.visible) continue;
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) continue;

    const coarse = mesh.geometry.userData.coarse as THREE.BufferGeometry | undefined;
    if (!coarse) {
      proxies.push(mesh);
      continue;
    }

    /*
     * A stand-in carrying the same transform — written to `matrix`, NOT to
     * `matrixWorld`, and the difference was a real bug that hid for two
     * commits.
     *
     * Copying the world matrix looks like the direct thing to do and is
     * undone immediately. `Bvh.fromMeshes` calls `updateMatrixWorld(true)` on
     * everything it is given, as it must, and for an object with no parent
     * that recomputes `matrixWorld` FROM `matrix` — which was still the
     * identity. Every proxy in the building therefore collapsed to the origin
     * in its own local coordinates.
     *
     * The symptom was not an obviously broken picture. It was a sealed room
     * whose floor reported seeing 64% of the sky, because the ceiling that
     * should have blocked it was somewhere else entirely; and that in turn is
     * why adding a window to a room changed nothing. Found by measuring the
     * floor and the ceiling separately instead of trusting one mean over
     * everything.
     */
    const proxy = new THREE.Mesh(coarse);
    mesh.updateMatrixWorld(true);
    proxy.matrix.copy(mesh.matrixWorld);
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldNeedsUpdate = true;
    proxies.push(proxy);
  }

  /*
   * ONE TREE, BUILT ONCE, QUERIED A FEW HUNDRED THOUSAND TIMES.
   *
   * `THREE.Raycaster` walks every triangle of every object on every cast and
   * then sorts the hits by distance. At this ray count that is not a constant
   * factor to shave — it is the difference between a bake that finishes and one
   * that never gives the page back, which is exactly what the first version of
   * this did. `bvh.ts` explains the arithmetic.
   */
  const bvh = Bvh.fromMeshes(proxies);

  /*
   * WHAT EVERY SURFACE IN THE BUILDING IS GIVING OFF, WORKED OUT ONCE.
   *
   * A bounce needs a source, and the source is every other surface: a floor in
   * sun throws warm light up the wall opposite, a lawn outside throws green
   * onto the reveal of a window, a white ceiling throws the sky back down.
   *
   * Computing that per bounce ray would mean asking "how much light lands on
   * this patch of floor" a hundred thousand times over for the same few
   * thousand patches. Doing it once per triangle instead costs a few tens of
   * thousands of rays — about a twentieth of the bake — and the answer it
   * produces is the same one.
   */
  const radiance = gatherSourceRadiance(bvh, light);

  /*
   * A hard ceiling on the work, kept even now the tree makes each ray cheap.
   *
   * The tree removed the triangle count from the cost; it did not remove the
   * vertex count, and that still grows with the size of the building. A budget
   * measured in RAYS is the honest unit — it is what actually takes the time —
   * and it lets a small house get a fine bake while a large one degrades to a
   * coarser one rather than to a frozen tab.
   */
  const budget = MAX_RAYS;

  /*
   * How many samples each point can afford, worked out before any are cast.
   *
   * Counting the distinct positions first costs one cheap pass and is what lets
   * the decision be made up front. Deciding as it goes would leave the surfaces
   * baked early in the list finely sampled and the ones baked late coarsely,
   * which shows as the shading resolution changing across a room — the same
   * mistake the subdivision budget made and for the same reason.
   */
  const distinct = countDistinct(surfaces);
  const samples = Math.max(
    8,
    // The bounce's twelve come out of the same budget. Leaving them out of the
    // sum meant the ceiling was quietly a fifth higher than it claimed.
    Math.min(SAMPLES, Math.floor(budget / Math.max(1, distinct)) - BOUNCE_SAMPLES),
  );
  const directions = samples === SAMPLES ? DIRECTIONS : hemisphereDirections(samples);

  /*
   * A separate, coarser set for the bounce, and never a subset of the above.
   *
   * Taking every fourth of the forty-eight would leave a spiral with a gap in
   * it — the golden-angle sequence is even only when taken whole — and the gap
   * would sit in the same place on every point in the building, which is how a
   * sampling artefact stops looking like noise and starts looking like a mark
   * on the wall.
   */
  const bounceDirections = hemisphereDirections(BOUNCE_SAMPLES);

  /*
   * What the arriving light is measured AGAINST.
   *
   * The attribute multiplies the renderer's own indirect term, so both parts
   * have to be expressed as a fraction of standing in the open — the sky
   * visibility already is, being a count of rays that escaped. Dividing the
   * bounce by the sky colour puts it in the same units, and doing it per
   * channel is what lets the bounce be a different colour from the sky, which
   * is the entire point of this pass.
   */
  const reference = [
    Math.max(1e-4, light.sky.r),
    Math.max(1e-4, light.sky.g),
    Math.max(1e-4, light.sky.b),
  ] as const;

  let vertices = 0;
  let rays = 0;
  let total = 0;
  let darkest = 1;
  let bounceTotal = 0;
  let chromaTotal = 0;

  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const origin = new THREE.Vector3();

  for (const mesh of surfaces) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    if (!position || !normals) continue;

    mesh.updateMatrixWorld(true);
    const toWorld = mesh.matrixWorld;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(toWorld);

    const visibility = new Float32Array(position.count);

    /*
     * BAKE EACH DISTINCT POINT ONCE, NOT EACH VERTEX.
     *
     * This is the difference between a bake that takes a second and one that
     * hangs the tab, and it is entirely an artefact of how the geometry is
     * stored. Subdivision leaves these surfaces NON-INDEXED: every triangle
     * carries its own three vertices, so a point where six triangles meet
     * appears six times, and a ten-metre wall reports about 8,400 vertices for
     * roughly 450 distinct positions.
     *
     * Baking all 8,400 does eighteen times the work for an identical answer,
     * and the first version of this did exactly that — enough to block the main
     * thread so thoroughly that the canvas never appeared at all.
     *
     * Positions are keyed to the millimetre. That is finer than anything the
     * bake can resolve and coarse enough that two vertices meant to be the same
     * point always agree, which floating-point arithmetic does not guarantee on
     * its own.
     */
    const unique = new Map<string, number[]>();
    for (let v = 0; v < position.count; v++) {
      const key =
        `${Math.round(position.getX(v) * 1000)},` +
        `${Math.round(position.getY(v) * 1000)},` +
        `${Math.round(position.getZ(v) * 1000)}`;
      const seen = unique.get(key);
      if (seen) seen.push(v);
      else unique.set(key, [v]);
    }

    /*
     * The groups, in a fixed order, so the smoothing pass below can address
     * them by number rather than by string key.
     */
    const groups = [...unique.values()];
    const groupOf = new Int32Array(position.count).fill(-1);
    for (let g = 0; g < groups.length; g++) {
      for (const index of groups[g]!) groupOf[index] = g;
    }

    const values = new Float32Array(groups.length);
    // Three per group: the bounced light arriving here, as a fraction of open
    // daylight, per channel.
    const bounced = new Float32Array(groups.length * 3);

    for (let g = 0; g < groups.length; g++) {
      const shared = groups[g]!;
      const v = shared[0]!;
      point.fromBufferAttribute(position, v).applyMatrix4(toWorld);
      normal.fromBufferAttribute(normals, v).applyMatrix3(normalMatrix).normalize();

      /*
       * A frame to sample in. `Vector3.randomDirection` would need rejecting
       * half its samples; building a tangent frame once per vertex and reusing
       * the same 48 precomputed directions is both faster and deterministic,
       * which matters because a bake that differs run to run makes every visual
       * regression impossible to attribute.
       */
      if (Math.abs(normal.y) < 0.99) tangent.set(0, 1, 0).cross(normal).normalize();
      else tangent.set(1, 0, 0).cross(normal).normalize();
      bitangent.crossVectors(normal, tangent);

      origin.copy(point).addScaledVector(normal, OFFSET);

      let escaped = 0;
      for (const sample of directions) {
        direction
          .copy(tangent)
          .multiplyScalar(sample.x)
          .addScaledVector(normal, sample.y)
          .addScaledVector(bitangent, sample.z)
          .normalize();

        rays++;
        /*
         * An any-hit query: it stops at the first triangle it touches and never
         * works out which, or how far. Inside a room most rays are pointed at a
         * wall a metre away and fail almost immediately, which is worth as much
         * as the tree itself.
         */
        if (
          !bvh.anyHit(
            origin.x, origin.y, origin.z,
            direction.x, direction.y, direction.z,
            REACH,
          )
        ) {
          escaped++;
        }
      }

      values[g] = FLOOR + (1 - FLOOR) * (escaped / samples);

      /*
       * THE BOUNCE: WHAT THE ROOM ITSELF IS THROWING AT THIS POINT.
       *
       * A second, coarser gather with a different question. The pass above
       * asked only whether each ray got out; this one asks, of the rays that
       * did NOT, what colour the thing they hit is giving off — which is the
       * table computed once at the top.
       *
       * Rays that escape contribute nothing here. They are already counted, in
       * full, by the sky visibility above, and adding them again would double
       * the daylight on every surface that can see out of a window.
       */
      let bounceR = 0;
      let bounceG = 0;
      let bounceB = 0;

      for (const sample of bounceDirections) {
        direction
          .copy(tangent)
          .multiplyScalar(sample.x)
          .addScaledVector(normal, sample.y)
          .addScaledVector(bitangent, sample.z)
          .normalize();

        rays++;
        const hit = bvh.closestHit(
          origin.x, origin.y, origin.z,
          direction.x, direction.y, direction.z,
          REACH,
        );
        if (!hit) continue;

        /*
         * Which side of that triangle the light is coming off.
         *
         * The ray arrives on the face turned towards it, so the side whose
         * normal OPPOSES the ray. Reading the wrong one paints the sunlit
         * outside of a wall onto its inside and every room glows.
         */
        const triangle = hit.triangle;
        bvh.normalOf(triangle, facing);
        const front = facing.dot(direction) < 0;
        const base = triangle * 6 + (front ? 0 : 3);

        bounceR += radiance[base]!;
        bounceG += radiance[base + 1]!;
        bounceB += radiance[base + 2]!;
      }

      bounced[g * 3] = bounceR / BOUNCE_SAMPLES / reference[0];
      bounced[g * 3 + 1] = bounceG / BOUNCE_SAMPLES / reference[1];
      bounced[g * 3 + 2] = bounceB / BOUNCE_SAMPLES / reference[2];

      vertices++;
    }

    smoothAlongEdges(geometry, groupOf, values, SMOOTH_PASSES);
    smoothChannels(geometry, groupOf, bounced, BOUNCE_SMOOTH_PASSES);

    for (let v = 0; v < position.count; v++) {
      const g = groupOf[v]!;
      // Every vertex sharing a position gets the same value, so the surface
      // stays continuous rather than showing the seams between triangles.
      visibility[v] = g >= 0 ? values[g]! : 1;
    }

    const bounce = new Float32Array(position.count * 3);
    for (let v = 0; v < position.count; v++) {
      const g = groupOf[v]!;
      if (g < 0) continue;
      bounce[v * 3] = bounced[g * 3]!;
      bounce[v * 3 + 1] = bounced[g * 3 + 1]!;
      bounce[v * 3 + 2] = bounced[g * 3 + 2]!;
    }

    for (const value of values) {
      total += value;
      if (value < darkest) darkest = value;
    }

    for (let g = 0; g < groups.length; g++) {
      const r = bounced[g * 3]!;
      const gr = bounced[g * 3 + 1]!;
      const b = bounced[g * 3 + 2]!;
      bounceTotal += (r + gr + b) / 3;
      chromaTotal += chroma(r, gr, b);
    }

    geometry.setAttribute('bakedAmbient', new THREE.BufferAttribute(visibility, 1));
    geometry.setAttribute('bakedBounce', new THREE.BufferAttribute(bounce, 3));
  }

  return {
    vertices,
    rays,
    ms: Date.now() - started,
    mean: vertices > 0 ? total / vertices : 0,
    darkest,
    samples,
    bounce: vertices > 0 ? bounceTotal / vertices : 0,
    chroma: vertices > 0 ? chromaTotal / vertices : 0,
  };
}

/**
 * Teaches a material to use the baked attribute, and only on the ambient.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS HOOKS `aomap_fragment` AND NOT VERTEX COLOURS.
 *
 * Three has a perfectly good mechanism for "darken the indirect light here": the
 * ambient occlusion map, which multiplies `reflectedLight.indirectDiffuse` and
 * deliberately leaves direct light alone. That distinction is the whole point —
 * a patch of floor in direct sun should stay bright even if it can see very
 * little sky, because the sun is reaching it regardless.
 *
 * Vertex colours would have been easier and are wrong: they multiply the
 * material's base colour, so they dim the direct sun too and a sunbeam falling
 * into a dark corner would be swallowed by it.
 *
 * So the attribute is injected into that same chunk, replacing the texture read
 * with a value interpolated from the vertices. No second UV set, no unwrap.
 */
export function useBakedAmbient(material: THREE.Material): void {
  if (material.userData.bakedAmbient) return;
  material.userData.bakedAmbient = true;

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float bakedAmbient;
        attribute vec3 bakedBounce;
        varying float vBakedAmbient;
        varying vec3 vBakedBounce;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBakedAmbient = bakedAmbient;
        vBakedBounce = bakedBounce;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vBakedAmbient;
        varying vec3 vBakedBounce;`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        /*
         * Sky plus bounce. The sky term is one number because open sky is one
         * colour; the bounce is three because a wood floor and a lawn are not.
         *
         * They ADD rather than multiply: they are two separate lots of light
         * arriving at the same place, and a point that sees no sky at all is
         * lit entirely by the second — which is the whole reason a room with
         * the door shut is not pitch black.
         *
         * The specular takes the mean rather than the colour. Tinting a
         * reflection by the bounce would be double-counting: what a shiny floor
         * reflects is decided by what is in front of it, not by what happens to
         * be lighting it.
         */
        vec3 bakedIndirect = vec3(vBakedAmbient) + vBakedBounce;
        reflectedLight.indirectDiffuse *= bakedIndirect;
        reflectedLight.indirectSpecular *=
          vBakedAmbient + (vBakedBounce.r + vBakedBounce.g + vBakedBounce.b) / 3.0;`,
      );
  };

  // Three caches compiled programs by a key that does not include the hook, so
  // without this a material sharing a key with an un-hooked one silently gets
  // the wrong shader.
  material.customProgramCacheKey = () => 'bakedAmbient';
  material.needsUpdate = true;
}

/**
 * A default for geometry that has not been baked.
 *
 * The shader reads the attribute unconditionally, and a missing attribute reads
 * as zero — which would render every unbaked surface black. Filling it with ones
 * means "sees the whole sky", which is exactly the old behaviour and therefore
 * the right thing to fall back to.
 */
export function fillUnbaked(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  if (!position) return;

  if (!geometry.getAttribute('bakedAmbient')) {
    const ones = new Float32Array(position.count).fill(1);
    geometry.setAttribute('bakedAmbient', new THREE.BufferAttribute(ones, 1));
  }

  /*
   * The bounce defaults to ZERO, not to ones, and the asymmetry is the point.
   *
   * Sky visibility of one means "sees the whole sky", which is the behaviour
   * from before the bake existed and so the right thing to fall back to. A
   * bounce of one would mean "as much light again arriving off the walls",
   * which nothing has measured and which would double the ambient on every
   * surface that was never baked — every stick of furniture in the building.
   */
  if (!geometry.getAttribute('bakedBounce')) {
    const zeros = new Float32Array(position.count * 3);
    geometry.setAttribute('bakedBounce', new THREE.BufferAttribute(zeros, 3));
  }
}
