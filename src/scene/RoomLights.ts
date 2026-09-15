/**
 * The light fittings, actually lighting things.
 *
 * -----------------------------------------------------------------------------
 * WHY REAL LIGHTS AND NOT A BRIGHTNESS KNOB.
 *
 * Raising the light level of a room when its switch is flipped is nearly free
 * and reads convincingly at a glance. It also cannot tell you the one thing
 * worth knowing: that the corner of the room is dark, that the worktop is lit
 * from behind so you work in your own shadow, that a single pendant does not
 * reach a five-metre room. Those are lighting-design faults, they are exactly
 * what somebody assessing a house wants to find, and only real light sources at
 * the real fitting positions can show them.
 *
 * -----------------------------------------------------------------------------
 * AND WHY THERE IS A HARD CAP.
 *
 * Every light in a WebGL scene costs shader work on every lit fragment, and
 * forward rendering makes that cost roughly linear in the number of lights. A
 * house with thirty downlights switched on would be thirty lights per fragment
 * and the frame budget would be gone — on a headset, catastrophically.
 *
 * So only the nearest few are real. The rest contribute nothing, which is
 * honest: you cannot see round a corner into a room you are not in, and a light
 * you cannot see the effect of is a light that need not be computed. The cap is
 * a number the frame meter can argue with rather than a guess baked in
 * somewhere.
 */

import * as THREE from 'three';

import { isLighting } from '@/services/layout';
import { elevationOf } from '@/state/levels';
import type { DesignDocument } from '@/state/types';

/**
 * Lamps, as the people who sell them describe them.
 *
 * Colour temperature is the choice that matters most and the one people have
 * an opinion about — the same room in 2700 K and in 4000 K is two different
 * rooms, and getting to see that before buying forty fittings is worth having.
 */
export interface LampChoice {
  id: string;
  label: string;
  description: string;
  /** Correlated colour temperature, kelvin. */
  kelvin: number;
  /** Luminous flux of one fitting, lumens. */
  lumens: number;
}

export const LAMPS: readonly LampChoice[] = [
  {
    id: 'warm-2700',
    label: 'Warm white — 2700 K',
    description: 'What a filament bulb looked like. Standard for living rooms and bedrooms.',
    kelvin: 2700,
    lumens: 800,
  },
  {
    id: 'soft-3000',
    label: 'Soft white — 3000 K',
    description: 'A little cleaner. Common in kitchens and bathrooms without feeling clinical.',
    kelvin: 3000,
    lumens: 900,
  },
  {
    id: 'neutral-4000',
    label: 'Neutral — 4000 K',
    description: 'Task lighting. Honest colours, and cold in a living room.',
    kelvin: 4000,
    lumens: 1000,
  },
  {
    id: 'daylight-5000',
    label: 'Daylight — 5000 K',
    description: 'Garages and workshops. In a bedroom it reads as an office at midnight.',
    kelvin: 5000,
    lumens: 1100,
  },
];

export function getLamp(id: string): LampChoice {
  return LAMPS.find((lamp) => lamp.id === id) ?? LAMPS[0]!;
}

/**
 * Colour temperature to RGB.
 *
 * An approximation of the Planckian locus, good across the range domestic
 * lamps are sold in, which is all that is asked of it. Doing this properly
 * means a spectral table and a colour-space conversion for a difference nobody
 * could see on a fitting in a 3D view.
 */
export function kelvinToColour(kelvin: number): THREE.Color {
  const t = Math.max(1000, Math.min(12000, kelvin)) / 100;

  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }

  const clamp = (value: number) => Math.max(0, Math.min(255, value)) / 255;
  return new THREE.Color(clamp(r), clamp(g), clamp(b));
}

/** How many real light sources may exist at once. */
export const LIGHT_BUDGET = {
  /**
   * Six is the number most mobile GPUs manage without the shader falling off a
   * cliff, and it is more than you can see the effect of from one place in a
   * house. The frame meter is there to argue with it.
   */
  maxLights: 6,
  /** Beyond this, a fitting contributes nothing worth the shader cost. */
  maxDistance: 12,
} as const;

interface Fitting {
  deviceId: string;
  position: THREE.Vector3;
}

/*
 * A recessed downlight really does throw downwards and a pendant really does
 * throw everywhere, and that is not modelled: every fitting here is a point
 * light. Getting it right means spot lights for the recessed ones, which means
 * two pools with two shader permutations, for a difference that matters much
 * less than whether the corner of the room is lit at all. Worth doing later,
 * and said here rather than left to be discovered.
 */

export class RoomLights {
  readonly group = new THREE.Group();

  private pool: THREE.PointLight[] = [];
  private fittings: Fitting[] = [];
  private builtFor: DesignDocument | null = null;
  private lamp: LampChoice = LAMPS[0]!;
  private enabled = false;

  constructor() {
    this.group.name = 'RoomLights';
    this.group.visible = false;

    /*
     * The pool is allocated once and reused.
     *
     * Adding and removing lights from a scene forces Three to recompile every
     * material that could be lit by them, because the light count is baked into
     * the shader. Doing that as somebody flips switches would stall for a
     * visible fraction of a second each time. Instead the full budget exists
     * from the start and unused ones are set to zero intensity, which is a
     * uniform change and costs nothing.
     */
    for (let i = 0; i < LIGHT_BUDGET.maxLights; i += 1) {
      const light = new THREE.PointLight(0xffffff, 0, LIGHT_BUDGET.maxDistance, 2);
      light.castShadow = false;
      light.visible = true;
      this.pool.push(light);
      this.group.add(light);
    }
  }

  setVisible(visible: boolean): void {
    this.enabled = visible;
    this.group.visible = visible;
    if (!visible) for (const light of this.pool) light.intensity = 0;
  }

  setLamp(lampId: string): void {
    this.lamp = getLamp(lampId);
  }

  /** Re-reads where the fittings are. Cheap, and only on a document change. */
  private refresh(doc: DesignDocument): void {
    if (this.builtFor === doc) return;
    this.builtFor = doc;

    this.fittings = [];
    for (const device of doc.electrical.devices) {
      if (!isLighting(device.kind)) continue;

      const base = elevationOf(doc, device.levelId);
      this.fittings.push({
        deviceId: device.id,
        /*
         * A touch below the fitting itself. A point light exactly at the
         * ceiling plane lights the ceiling from inside it, which produces a
         * bright ring round the fitting and very little else.
         */
        position: new THREE.Vector3(device.at.x, base + device.height - 0.08, device.at.z),
      });
    }
  }

  /**
   * Lights the nearest lit fittings and switches the rest off.
   *
   * `from` is where the viewer is, which decides which few of the lit fittings
   * are worth computing. Sorting by distance every frame is cheap — there are
   * tens of fittings, not thousands — and it means walking from room to room
   * hands the budget over without anything having to notice.
   */
  update(doc: DesignDocument, litDeviceIds: ReadonlySet<string>, from: THREE.Vector3): void {
    if (!this.enabled) return;
    this.refresh(doc);

    const colour = kelvinToColour(this.lamp.kelvin);
    /*
     * Lumens to a Three.js intensity. Three's physical lights are in candela,
     * and a lumen figure divided by about 4π steradians is the candela of a
     * source throwing in every direction — which a bare lamp roughly is. The
     * further scaling is tone-mapping taste rather than physics, and it is the
     * one number here somebody should feel free to argue with.
     */
    const intensity = (this.lamp.lumens / (4 * Math.PI)) * 0.22;

    const candidates = this.fittings
      .filter((fitting) => litDeviceIds.has(fitting.deviceId))
      .map((fitting) => ({ fitting, distance: fitting.position.distanceTo(from) }))
      .filter((entry) => entry.distance <= LIGHT_BUDGET.maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, LIGHT_BUDGET.maxLights);

    this.pool.forEach((light, index) => {
      const entry = candidates[index];
      if (!entry) {
        light.intensity = 0;
        return;
      }

      light.position.copy(entry.fitting.position);
      light.color.copy(colour);
      light.intensity = intensity;
      light.distance = LIGHT_BUDGET.maxDistance;
    });
  }

  /** How many of the budget are in use, for the panel to show honestly. */
  get inUse(): number {
    return this.pool.filter((light) => light.intensity > 0).length;
  }

  dispose(): void {
    for (const light of this.pool) {
      light.dispose();
      this.group.remove(light);
    }
    this.pool = [];
    this.group.clear();
  }
}
