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
 * The darkest the ambient is ever allowed to go, 0 to 1.
 *
 * A point deep inside a cupboard genuinely sees no sky and its honest answer is
 * zero. Rendering that as pure black is wrong for a different reason: the light
 * that actually reaches such a place in reality is BOUNCED, arriving after two
 * or three reflections, and none of that is simulated here. So this floor is
 * standing in for the bounce until S3 computes it properly, and it is deliberate
 * rather than a fudge to make the picture nicer.
 */
const FLOOR = 0.12;

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
 * Bakes sky visibility into a `bakedAmbient` attribute on each mesh.
 *
 * `surfaces` are the meshes that receive the bake; `occluders` are everything
 * that can block a ray, which is normally the surfaces plus the furniture. The
 * two lists differ because a sofa should darken the wall behind it without
 * itself needing per-vertex shading.
 */
export function bakeSkyVisibility(
  surfaces: readonly THREE.Mesh[],
  occluders: readonly THREE.Object3D[],
): BakeResult {
  const started = Date.now();

  const raycaster = new THREE.Raycaster();
  raycaster.far = REACH;
  /*
   * Only meshes, and only the first hit.
   *
   * `layers` filtering is cheaper than letting the raycaster walk sprites and
   * lines on every one of several hundred thousand casts. The first-hit
   * shortcut that three-mesh-bvh provides is not available on the stock
   * raycaster, so the loop below stops at the first intersection itself rather
   * than asking for a sorted list it will throw away.
   */

  /*
   * Rays are cast against the COARSE geometry, not against what is drawn.
   *
   * Session 18's subdivision gave every wall several hundred triangles so that
   * light could vary across it. Every one of those triangles is then tested by
   * every ray, and there is no spatial index here, so the same change that made
   * this bake possible also made it four hundred times slower — slow enough that
   * the first version never finished and the canvas never appeared.
   *
   * The coarse geometry describes exactly the same surface with about twenty
   * triangles, holes for the windows included, which is all an intersection
   * test needs. `subdivide.ts` keeps it for this.
   */
  const targets: THREE.Object3D[] = [];
  const temporary: THREE.BufferGeometry[] = [];

  for (const object of occluders) {
    if (!object.visible) continue;
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) continue;

    const coarse = mesh.geometry.userData.coarse as THREE.BufferGeometry | undefined;
    if (!coarse) {
      targets.push(mesh);
      continue;
    }

    // A stand-in carrying the same transform, so a hit lands in the same place.
    const proxy = new THREE.Mesh(coarse);
    mesh.updateMatrixWorld(true);
    proxy.matrixWorld.copy(mesh.matrixWorld);
    proxy.matrixAutoUpdate = false;
    targets.push(proxy);
  }

  /*
   * A hard ceiling on the work, and it exists because the first version had
   * none and hung the tab so completely that the canvas never appeared.
   *
   * Every ray is tested against every triangle of every occluder — there is no
   * spatial index here — so the cost is vertices x rays x triangles and all
   * three grow with the size of the building. A budget measured in RAYS is the
   * honest unit: it is what actually takes the time, and it lets a small house
   * get a fine bake while a large one degrades to a coarse one instead of
   * freezing.
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
    Math.min(SAMPLES, Math.floor(budget / Math.max(1, distinct))),
  );
  const directions = samples === SAMPLES ? DIRECTIONS : hemisphereDirections(samples);

  let vertices = 0;
  let rays = 0;
  let total = 0;
  let darkest = 1;

  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
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

    for (const shared of unique.values()) {
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

        raycaster.set(origin, direction);
        rays++;
        /*
         * `intersectObjects` sorts every hit by distance before returning. All
         * this needs to know is whether there was one at all, and at a quarter
         * of a million casts that sort is most of the bake's cost — so the
         * result array is only ever tested for emptiness, never read.
         */
        if (raycaster.intersectObjects(targets, true).length === 0) escaped++;
      }

      const value = FLOOR + (1 - FLOOR) * (escaped / samples);
      // Written to every vertex that shares this position, so the surface stays
      // continuous rather than showing the seams between triangles.
      for (const index of shared) visibility[index] = value;

      total += value;
      if (value < darkest) darkest = value;
      vertices++;
    }

    geometry.setAttribute('bakedAmbient', new THREE.BufferAttribute(visibility, 1));
  }

  for (const geometry of temporary) geometry.dispose();

  return {
    vertices,
    rays,
    ms: Date.now() - started,
    mean: vertices > 0 ? total / vertices : 0,
    darkest,
    samples,
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
        varying float vBakedAmbient;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBakedAmbient = bakedAmbient;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vBakedAmbient;`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vBakedAmbient;
        reflectedLight.indirectSpecular *= vBakedAmbient;`,
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
  if (geometry.getAttribute('bakedAmbient')) return;
  const position = geometry.getAttribute('position');
  if (!position) return;
  const ones = new Float32Array(position.count).fill(1);
  geometry.setAttribute('bakedAmbient', new THREE.BufferAttribute(ones, 1));
}
