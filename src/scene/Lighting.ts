/**
 * Room lighting.
 *
 * The setup mirrors how a real interior is lit rather than how a 3D tutorial
 * lights a floating cube:
 *
 *   • An ENVIRONMENT MAP provides indirect light. Physically-based materials
 *     look plastic and dead without one, because roughness only means something
 *     when there is an environment to reflect. Three's `RoomEnvironment` gives a
 *     neutral interior-like probe with no asset download.
 *   • A HEMISPHERE LIGHT approximates sky-above / floor-bounce colour gradient.
 *   • One DIRECTIONAL LIGHT acts as the sun through a window, and is the only
 *     shadow caster — multiple shadow-casting lights would cost frames and, in
 *     an interior, mostly produce muddled overlapping shadows.
 *   • A dim opposing FILL light stops the shadow side going pure black.
 *
 * The shadow camera is refitted whenever the room resizes; a shadow frustum
 * sized for a small room produces hard-clipped shadows in a large one, and one
 * sized for a large room wastes depth precision on a small one.
 *
 * CALIBRATION CONSTRAINT — read before raising any intensity below.
 * havavamama is a colour-selection tool: a user picking terracotta must see
 * terracotta, not salmon. Total scene illuminance is therefore tuned so that a
 * light wall facing the key light lands below the shoulder of the ACES tone
 * curve. Push these values up and every saturated paint colour desaturates
 * towards white, which is a correctness bug in a design app, not a taste call.
 * If a preset needs to feel brighter, raise `background` and lower contrast
 * rather than adding light.
 *
 * -----------------------------------------------------------------------------
 * AND THE SECOND CONSTRAINT, WHICH SESSION 17 ADDED: THE CONTRAST RATIO.
 *
 * The constraint above is real, and obeying it alone produced a room nobody
 * believed. Every preset drifted towards the same shape — a bright sun and an
 * ambient nearly as bright — because lowering contrast is the easy way to stop
 * anything clipping. "Daylight" ended up running the sun at 1.9 against an
 * ambient of 1.32. That is a ratio of 1.4 to 1. Real midday sun against real
 * skylight is between five and ten to one.
 *
 * The cost was not subtle. A surface in shadow lost about a third of its light,
 * which the eye reads as no shadow at all, and an entire session was spent
 * hunting a shadow bug that did not exist: the shadows were rendering perfectly
 * and drowning in fill. Flat light is also why the model looked like coloured
 * cardboard — the eye takes almost all of its shape information from the ratio
 * between lit and unlit, and at 1.4 to 1 there is nothing to read.
 *
 * So each preset now declares a deliberate ratio, and `lighting.test.ts` holds
 * them to it. The ratio is raised by LOWERING THE AMBIENT, never by raising the
 * sun — that keeps total illuminance under the constraint above, so saturated
 * paint stays honest, while the shade gets somewhere to go.
 *
 * Overcast is the exception and is meant to be: an overcast sky HAS no sun, and
 * a preset that faked contrast under one would be lying about the weather.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import type { LightingPresetId, LightingSpec, PlanModel } from '@/state/types';
import { Sky, type SkyColours } from './Sky';
import type { BakeLight } from './skyBake';

/** World up, and a fallback for when the sun is directly overhead. */
const UP = new THREE.Vector3(0, 1, 0);
const UP_FALLBACK = new THREE.Vector3(0, 0, 1);
import { planBounds } from './planGraph';

interface LightingPreset {
  label: string;
  description: string;
  /**
   * Sun against everything else, as a deliberate number rather than an accident.
   *
   * Declared here and checked in `lighting.test.ts` against the intensities
   * below, so that a well-meaning tweak to one of them cannot quietly flatten
   * the preset again. See the header for why this is a correctness property and
   * not a matter of taste.
   */
  ratio: number;
  /** Colour of the sky contribution. */
  skyColor: number;
  /** Colour bounced up off the ground plane. */
  groundColor: number;
  hemisphereIntensity: number;
  sunColor: number;
  sunIntensity: number;
  /** Sun elevation above the horizon, in degrees. */
  sunElevation: number;
  /** Sun compass bearing, in degrees; 0 = from the north (-Z). */
  sunAzimuth: number;
  fillColor: number;
  fillIntensity: number;
  /** Multiplier on the environment map's contribution. */
  environmentIntensity: number;
  /**
   * Viewport background colour behind the building.
   *
   * Since session 2 this is also WHAT YOU SEE THROUGH A WINDOW, which changes
   * what it has to be. A near-black backdrop looked good behind an unglazed box,
   * but glazing against it reads as a black hole punched in the wall rather than
   * as a window. Each preset therefore uses a muted sky tone: light enough to
   * sit convincingly outside the glass, dark enough that the room stays the
   * brightest thing on screen.
   */
  background: number;
  /** Softness of the shadow edge, in shadow-map texels. */
  shadowRadius: number;
  /**
   * The sky gradient behind the building.
   *
   * Replaces the flat `background` colour, which is kept only as the clear
   * colour for the moments before the sky mesh has drawn.
   */
  sky: SkyColours;
}

export const LIGHTING_PRESETS: Record<LightingPresetId, LightingPreset> = {
  daylight: {
    label: 'Daylight',
    description: 'Clear midday sun with crisp shadows.',
    // 3.2 : 1. A clear sky is nearer 10 : 1; this is pulled back so the shade
    // stays readable in a tool people have to make decisions inside.
    ratio: 3.2,
    skyColor: 0xdfeaf7,
    groundColor: 0xbfae9a,
    hemisphereIntensity: 0.22,
    sunColor: 0xfff4e2,
    sunIntensity: 1.9,
    sunElevation: 48,
    sunAzimuth: 135,
    fillColor: 0xc7d6ea,
    fillIntensity: 0.08,
    environmentIntensity: 0.30,
    background: 0x3a4655,
    shadowRadius: 3,
    sky: { zenith: 0x3f6fae, horizon: 0xc3d6e6, ground: 0x7d8478, sun: 0xfff0d0, sunFocus: 110 },
  },
  overcast: {
    label: 'Overcast',
    description: 'Flat, even light with soft shadows.',
    // 0.35 : 1, and deliberately so. Overcast means the sun is behind cloud and
    // the sky IS the light source. Faking contrast here would be a lie about
    // the weather, and this preset exists precisely for judging colour without
    // a shadow falling across it.
    ratio: 0.35,
    skyColor: 0xd8dde3,
    groundColor: 0xb0aca6,
    hemisphereIntensity: 0.80,
    sunColor: 0xe9edf2,
    sunIntensity: 0.6,
    sunElevation: 62,
    sunAzimuth: 160,
    fillColor: 0xdde2e8,
    fillIntensity: 0.28,
    environmentIntensity: 0.65,
    background: 0x424851,
    shadowRadius: 8,
    sky: { zenith: 0x8e9aa6, horizon: 0xcdd3d8, ground: 0x7c7f80, sun: 0xdfe4e8, sunFocus: 12 },
  },
  evening: {
    label: 'Evening',
    description: 'Low warm sun and deep contrast.',
    // 4.3 : 1, the deepest of the four, because the description promises deep
    // contrast and a low sun genuinely delivers it \u2014 the sky is dim and what is
    // left of the sun is raking.
    ratio: 4.3,
    skyColor: 0x6d5f6b,
    groundColor: 0x4a3d33,
    hemisphereIntensity: 0.14,
    sunColor: 0xffb877,
    sunIntensity: 1.6,
    sunElevation: 12,
    sunAzimuth: 250,
    fillColor: 0x5a6b8c,
    fillIntensity: 0.07,
    environmentIntensity: 0.16,
    background: 0x2b2533,
    shadowRadius: 4,
    sky: { zenith: 0x243057, horizon: 0xd88a5a, ground: 0x3b3a3e, sun: 0xffc07a, sunFocus: 60 },
  },
  studio: {
    label: 'Studio',
    description: 'Neutral product lighting for presenting a design.',
    // 1.6 : 1. The flattest of the three lit presets, as a key-and-fill studio
    // setup should be, but still enough to read form \u2014 at the old 0.58 : 1 the
    // fill was brighter than the key and nothing had a shape.
    ratio: 1.6,
    skyColor: 0xffffff,
    groundColor: 0xd8d8d8,
    hemisphereIntensity: 0.30,
    sunColor: 0xffffff,
    sunIntensity: 1.3,
    sunElevation: 55,
    sunAzimuth: 120,
    fillColor: 0xffffff,
    fillIntensity: 0.18,
    environmentIntensity: 0.35,
    background: 0x30353d,
    shadowRadius: 5,
    sky: { zenith: 0x4a4f57, horizon: 0x9aa2ac, ground: 0x55585c, sun: 0xf2f4f7, sunFocus: 30 },
  },
};

/** Shadow map resolution. 2048 is a good quality/VRAM trade-off for one light. */
const SHADOW_MAP_SIZE = 2048;

export class Lighting {
  readonly group = new THREE.Group();

  private hemisphere: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;

  /** Pre-filtered environment map used for indirect lighting. */
  private environment: THREE.Texture | null = null;
  /** The sun's un-jittered position, for `offsetSun`. */
  private sunBase: THREE.Vector3 | null = null;
  /** The gradient sky behind everything. */
  private sky = new Sky();
  private pmrem: THREE.PMREMGenerator;

  private scene: THREE.Scene;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.group.name = 'Lighting';

    this.hemisphere = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    this.group.add(this.hemisphere);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    /*
     * Bias values fight shadow acne on large flat surfaces like the floor.
     * Normal bias is the effective one for a room; it offsets along the surface
     * normal and so scales correctly with the grazing sun angles of "evening".
     *
     * Both were suspected of erasing the room's shadows in session 17 and both
     * were cleared: zeroing them changed the rendered frame by nothing at all.
     * They are recorded here so the next person does not spend the same hour —
     * 2 cm along the normal cannot hide the shadow of a sofa, and the shadows
     * were never missing in the first place. See `report()` below.
     */
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    this.fill = new THREE.DirectionalLight(0xffffff, 0.3);
    this.group.add(this.fill);

    // Build the environment probe once — it is independent of every setting
    // except its intensity multiplier, which is applied on the scene.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    const roomEnvironment = new RoomEnvironment();
    this.environment = this.pmrem.fromScene(roomEnvironment, 0.04).texture;
    roomEnvironment.dispose();
    this.scene.environment = this.environment;
  }

  /** Applies a lighting spec, refitting shadows to the room's size. */
  apply(spec: LightingSpec, plan: PlanModel): void {
    const preset = LIGHTING_PRESETS[spec.presetId];
    const gain = spec.intensity;

    this.hemisphere.color.setHex(preset.skyColor);
    this.hemisphere.groundColor.setHex(preset.groundColor);
    this.hemisphere.intensity = preset.hemisphereIntensity * gain;

    this.sun.color.setHex(preset.sunColor);
    this.sun.intensity = preset.sunIntensity * gain;
    this.sun.castShadow = spec.shadowsEnabled;
    this.sun.shadow.radius = preset.shadowRadius;

    this.fill.color.setHex(preset.fillColor);
    this.fill.intensity = preset.fillIntensity * gain;

    this.scene.environment = this.environment;
    this.scene.environmentIntensity = preset.environmentIntensity * gain;
    this.positionLights(preset, plan);
    // Order matters: the aim decides where the frustum sits, so it has to be
    // settled before the frustum is measured around it.
    this.aimAtShadow(preset, plan);
    this.fitShadowCamera(preset, plan);

    /*
     * The sky is painted AFTER `positionLights`, because that is what decides
     * where the sun is and the glow has to be in the right place. It replaces
     * `scene.background` outright — there is no flat colour left.
     */
    const sunDirection = this.sun.position.clone().sub(this.sun.target.position).normalize();
    this.sky.apply(this.scene, preset.sky, sunDirection);
  }

  /**
   * The light the sky bake is standing in, described in its own terms.
   *
   * -----------------------------------------------------------------------------
   * ONE QUESTION, ASKED IN ONE PLACE.
   *
   * The bake needs to know what colour the sky is, what colour the ground
   * throws back, where the sun is and how strong it is. Every one of those is
   * already decided here, by the preset and by `positionLights`, and every one
   * of them would be a silent mistake if the bake decided it separately: a
   * bounce computed against a daylight sky while the scene is rendered at dusk
   * is not subtly wrong, it is a different time of day baked into the walls.
   *
   * The colours come off the LIVE lights rather than off the preset, so the
   * overall gain and any later adjustment are already in them — and they are in
   * the renderer's working (linear) colour space, which is what arithmetic on
   * light requires.
   */
  bakeLight(): BakeLight {
    return {
      sky: this.hemisphere.color.clone().multiplyScalar(this.hemisphere.intensity),
      ground: this.hemisphere.groundColor.clone().multiplyScalar(this.hemisphere.intensity),
      sun: this.sun.position.clone().sub(this.sun.target.position).normalize(),
      sunColour: this.sun.color.clone().multiplyScalar(this.sun.intensity),
    };
  }

  /**
   * Nudges the sun to a point on its own disc.
   *
   * The sun is not a point — it subtends about half a degree of sky, and that
   * is the entire reason real shadows have soft edges that widen with distance
   * from whatever cast them. A shadow map from a point light cannot produce
   * that; blurring it produces a uniform softness that is wrong everywhere
   * except at one distance.
   *
   * So instead the progressive renderer moves the sun to a different point on
   * its disc for each accumulated sample and averages the results. Averaging N
   * point lights spread over the sun's angular diameter is, literally, what an
   * area light IS — so the penumbra comes out correct for free.
   *
   * The offset is applied about the axis perpendicular to the sun direction,
   * so it is a genuine angular displacement rather than a translation that
   * would also change the light's distance and therefore its shadow frustum.
   */
  offsetSun(angleX: number, angleY: number): void {
    if (angleX === 0 && angleY === 0) {
      if (this.sunBase) this.sun.position.copy(this.sunBase);
      return;
    }
    if (!this.sunBase) return;

    const direction = this.sunBase.clone().sub(this.sun.target.position);
    const distance = direction.length();
    if (distance < 1e-6) return;
    direction.normalize();

    // Build a frame around the sun direction to displace within.
    const up = Math.abs(direction.y) > 0.99 ? UP_FALLBACK : UP;
    const right = new THREE.Vector3().crossVectors(direction, up).normalize();
    const across = new THREE.Vector3().crossVectors(right, direction).normalize();

    const displaced = direction
      .clone()
      .addScaledVector(right, Math.tan(angleX))
      .addScaledVector(across, Math.tan(angleY))
      .normalize()
      .multiplyScalar(distance);

    this.sun.position.copy(this.sun.target.position).add(displaced);
  }

  /**
   * Resizes the shadow map.
   *
   * Disposing the old map is essential rather than tidy: `mapSize` is read when
   * the map is allocated, so without the dispose the light keeps rendering into
   * the old texture and the setting silently does nothing.
   */
  setShadowMapSize(size: number): void {
    if (this.sun.shadow.mapSize.width === size) return;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /**
   * Places the sun and fill on a sphere around the room.
   *
   * The distance scales with room size so that the directional light's shadow
   * frustum (which is orthographic and positioned at the light) always fully
   * contains the room.
   */
  private positionLights(preset: LightingPreset, plan: PlanModel): void {
    const bounds = planBounds(plan);
    const distance = Math.max(8, bounds.radius * 4);

    const elevation = THREE.MathUtils.degToRad(preset.sunElevation);
    const azimuth = THREE.MathUtils.degToRad(preset.sunAzimuth);

    const horizontal = Math.cos(elevation) * distance;
    this.sun.position.set(
      Math.sin(azimuth) * horizontal,
      Math.sin(elevation) * distance,
      -Math.cos(azimuth) * horizontal,
    );
    // Aim slightly above the floor, at the middle of the plan, so shadows fall
    // across the building rather than past it.
    this.sun.position.x += bounds.center.x;
    this.sun.position.z += bounds.center.z;
    // Remembered so `offsetSun` has an axis to displace about, and so the
    // cheap path can put the sun back exactly where it belongs.
    this.sunBase = this.sun.position.clone();
    this.sun.target.position.set(bounds.center.x, bounds.height * 0.25, bounds.center.z);
    this.sun.target.updateMatrixWorld();

    // The fill sits opposite the sun and lower, mimicking light bounced back
    // off the far wall rather than a second sun.
    this.fill.position.set(
      -this.sun.position.x * 0.6,
      Math.max(2, this.sun.position.y * 0.4),
      -this.sun.position.z * 0.6,
    );
  }

  /**
   * Sizes the orthographic shadow frustum to contain the room AND its shadow.
   *
   * The second half of that sentence is the session-17 fix. The frustum used to
   * be `radius * 1.35` — a little headroom around the building, with a comment
   * claiming it was enough for shadows falling on the ground. It is not, and the
   * lower the sun the more wrong it gets: a 2.6 m wall under the evening
   * preset's 12° sun throws a shadow twelve metres long, and the frustum stopped
   * it after five. The building's own shadow on the grass simply ended in
   * mid-air, which is the one shadow in the whole scene a person is guaranteed
   * to look at.
   *
   * So the reach is computed from the sun's actual elevation, and the frustum is
   * both widened to hold it and SHIFTED to sit over it — growing symmetrically
   * would spend half the new area on empty ground behind the building, where
   * nothing is ever cast.
   */
  private fitShadowCamera(preset: LightingPreset, plan: PlanModel): void {
    const bounds = planBounds(plan);
    const camera = this.sun.shadow.camera;

    /*
     * How far the shadow of the tallest thing reaches, and why it is capped.
     *
     * The frustum is one fixed-resolution texture. Doubling its extent halves
     * the shadow detail everywhere, so an arbitrarily low sun would trade every
     * crisp shadow in the building for the far end of one long smear on the
     * lawn. One building radius of reach is the compromise: enough that the
     * shadow clearly travels and lands, capped before the interior turns soft.
     */
    const elevation = THREE.MathUtils.degToRad(preset.sunElevation);
    const reach = Math.min(bounds.height / Math.max(Math.tan(elevation), 0.08), bounds.radius);

    const extent = bounds.radius * 1.35 + reach * 0.5;
    camera.left = -extent;
    camera.right = extent;
    camera.top = extent;
    camera.bottom = -extent;

    /*
     * Near and far, measured from the light to what it is aimed at.
     *
     * This used to use `sun.position.length()`, the distance from the WORLD
     * ORIGIN — which happens to be right only while the building sits on the
     * origin. Move a plan a hundred metres out and the far plane lands behind
     * the building and every shadow disappears. Nobody had moved one that far
     * yet, which is the only reason it had not been noticed.
     */
    const throwDistance = this.sun.position.distanceTo(this.sun.target.position);
    camera.near = 0.5;
    camera.far = throwDistance + bounds.radius * 2 + reach;
    camera.updateProjectionMatrix();
  }

  /**
   * Aims the sun so the frustum straddles the building and its shadow.
   *
   * The shadow travels along the sun's horizontal direction, away from it. So
   * the target is pushed half a reach that way: the building sits at one end of
   * the frustum and the far tip of its shadow at the other, and neither is
   * clipped.
   */
  private aimAtShadow(preset: LightingPreset, plan: PlanModel): void {
    const bounds = planBounds(plan);
    const elevation = THREE.MathUtils.degToRad(preset.sunElevation);
    const reach = Math.min(bounds.height / Math.max(Math.tan(elevation), 0.08), bounds.radius);

    // Horizontal direction the light travels in, which is where shadows go.
    const travel = this.sun.target.position.clone().sub(this.sun.position).setY(0);
    if (travel.lengthSq() < 1e-8) return;
    travel.normalize();

    this.sun.target.position.set(
      bounds.center.x + travel.x * reach * 0.5,
      bounds.height * 0.25,
      bounds.center.z + travel.z * reach * 0.5,
    );
    this.sun.target.updateMatrixWorld();
  }

  /**
   * What the sun is actually doing, for automated checking.
   *
   * Session 17 spent an hour on a room with no shadows in it while every line
   * of code that could switch shadows off said they were on. Reading the
   * settings proved nothing, because the settings were right — what was wrong
   * was downstream of them. So this reports the state the renderer will
   * actually consult at draw time: whether the shadow map has been allocated at
   * all, what the frustum ended up covering, and how the bias compares to the
   * size of the things the shadows are supposed to land on.
   */
  report(): {
    castShadow: boolean;
    intensity: number;
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    mapAllocated: boolean;
    mapSize: number;
    bias: number;
    normalBias: number;
    radius: number;
    frustum: { extent: number; near: number; far: number };
    environmentIntensity: number;
    hemisphere: number;
  } {
    const camera = this.sun.shadow.camera;
    return {
      castShadow: this.sun.castShadow,
      intensity: +this.sun.intensity.toFixed(3),
      position: {
        x: +this.sun.position.x.toFixed(2),
        y: +this.sun.position.y.toFixed(2),
        z: +this.sun.position.z.toFixed(2),
      },
      target: {
        x: +this.sun.target.position.x.toFixed(2),
        y: +this.sun.target.position.y.toFixed(2),
        z: +this.sun.target.position.z.toFixed(2),
      },
      mapAllocated: this.sun.shadow.map !== null,
      mapSize: this.sun.shadow.mapSize.width,
      bias: this.sun.shadow.bias,
      normalBias: this.sun.shadow.normalBias,
      radius: this.sun.shadow.radius,
      frustum: { extent: +camera.right.toFixed(2), near: camera.near, far: +camera.far.toFixed(2) },
      environmentIntensity: +(this.scene.environmentIntensity ?? 1).toFixed(3),
      hemisphere: +this.hemisphere.intensity.toFixed(3),
    };
  }

  /**
   * Reads the shadow map back off the GPU, for automated checking.
   *
   * The one question the settings cannot answer. A shadow map that was never
   * rendered into is uniformly the far plane, and every setting that feeds it
   * still reads as correct — which is precisely the state session 17 was stuck
   * in. Sampling it says whether the depth pass actually drew the building.
   *
   * Slow, because it stalls the pipeline waiting for the read. Called only from
   * the probe, never from a frame.
   */
  sampleShadowMap(renderer: THREE.WebGLRenderer, patch = 256): {
    readable: boolean;
    min: number;
    max: number;
    distinct: number;
    note: string;
    /** The depth pass, downsampled, so it can be looked at rather than trusted. */
    preview: number[];
    previewSize: number;
  } {
    const target = this.sun.shadow.map;
    const empty = { readable: false, min: 0, max: 0, distinct: 0, preview: [], previewSize: 0 };
    if (!target) return { ...empty, note: 'no map allocated' };

    const buffer = new Uint8Array(target.width * target.height * 4);
    try {
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, buffer);
    } catch (error) {
      return { ...empty, note: String(error) };
    }

    // Three packs depth into RGBA; the red channel alone is enough to tell a
    // uniform map from one with a building in it.
    const seen = new Set<number>();
    let min = 255;
    let max = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const value = buffer[i]!;
      seen.add(value);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    // Nearest-neighbour down to something that fits in a message.
    const previewSize = Math.min(patch, target.width);
    const step = Math.floor(target.width / previewSize);
    const preview: number[] = [];
    for (let y = 0; y < previewSize; y++) {
      for (let x = 0; x < previewSize; x++) {
        preview.push(buffer[((y * step) * target.width + x * step) * 4]!);
      }
    }

    return {
      readable: true,
      min,
      max,
      distinct: seen.size,
      note: seen.size <= 1 ? 'UNIFORM — nothing was drawn into the shadow map' : 'has depth',
      preview,
      previewSize,
    };
  }

  dispose(): void {
    this.sky.dispose();
    this.scene.background = null;
    this.environment?.dispose();
    this.pmrem.dispose();
    this.sun.shadow.dispose();
    this.scene.environment = null;
  }
}
