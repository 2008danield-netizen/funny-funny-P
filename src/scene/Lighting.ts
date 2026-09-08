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
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import type { LightingPresetId, LightingSpec, PlanModel } from '@/state/types';
import { planBounds } from './planGraph';

interface LightingPreset {
  label: string;
  description: string;
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
}

export const LIGHTING_PRESETS: Record<LightingPresetId, LightingPreset> = {
  daylight: {
    label: 'Daylight',
    description: 'Clear midday sun with crisp shadows.',
    skyColor: 0xdfeaf7,
    groundColor: 0xbfae9a,
    hemisphereIntensity: 0.55,
    sunColor: 0xfff4e2,
    sunIntensity: 1.9,
    sunElevation: 48,
    sunAzimuth: 135,
    fillColor: 0xc7d6ea,
    fillIntensity: 0.22,
    environmentIntensity: 0.55,
    background: 0x3a4655,
    shadowRadius: 3,
  },
  overcast: {
    label: 'Overcast',
    description: 'Flat, even light with soft shadows.',
    skyColor: 0xd8dde3,
    groundColor: 0xb0aca6,
    hemisphereIntensity: 0.85,
    sunColor: 0xe9edf2,
    sunIntensity: 0.6,
    sunElevation: 62,
    sunAzimuth: 160,
    fillColor: 0xdde2e8,
    fillIntensity: 0.3,
    environmentIntensity: 0.7,
    background: 0x424851,
    shadowRadius: 8,
  },
  evening: {
    label: 'Evening',
    description: 'Low warm sun and deep contrast.',
    skyColor: 0x6d5f6b,
    groundColor: 0x4a3d33,
    hemisphereIntensity: 0.32,
    sunColor: 0xffb877,
    sunIntensity: 1.6,
    sunElevation: 12,
    sunAzimuth: 250,
    fillColor: 0x5a6b8c,
    fillIntensity: 0.2,
    environmentIntensity: 0.3,
    background: 0x2b2533,
    shadowRadius: 4,
  },
  studio: {
    label: 'Studio',
    description: 'Neutral product lighting for presenting a design.',
    skyColor: 0xffffff,
    groundColor: 0xd8d8d8,
    hemisphereIntensity: 0.7,
    sunColor: 0xffffff,
    sunIntensity: 1.1,
    sunElevation: 55,
    sunAzimuth: 120,
    fillColor: 0xffffff,
    fillIntensity: 0.45,
    environmentIntensity: 0.75,
    background: 0x30353d,
    shadowRadius: 5,
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
    // Bias values fight shadow acne on large flat surfaces like the floor.
    // Normal bias is the effective one for a room; it offsets along the surface
    // normal and so scales correctly with the grazing sun angles of "evening".
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
    this.scene.background = new THREE.Color(preset.background);

    this.positionLights(preset, plan);
    this.fitShadowCamera(plan);
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

  /** Sizes the orthographic shadow frustum to just contain the room. */
  private fitShadowCamera(plan: PlanModel): void {
    // A little headroom beyond the building so shadows cast onto exterior
    // geometry (and the site ground plane) are not clipped at the frustum edge.
    const extent = planBounds(plan).radius * 1.35;
    const camera = this.sun.shadow.camera;

    camera.left = -extent;
    camera.right = extent;
    camera.top = extent;
    camera.bottom = -extent;
    camera.near = 0.5;
    camera.far = this.sun.position.length() + extent * 2;
    camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.environment?.dispose();
    this.pmrem.dispose();
    this.sun.shadow.dispose();
    this.scene.environment = null;
  }
}
