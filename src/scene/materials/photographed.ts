/**
 * The seam for photographed materials, and the rule that guards it.
 *
 * -----------------------------------------------------------------------------
 * EVERY SURFACE IN THIS BUILDING IS DRAWN BY ARITHMETIC.
 *
 * The oak, the marble, the plaster, the brick — all of it is generated from a
 * few parameters at start-up, which is why this app ships no images and why a
 * floor preset is thirty lines rather than twelve megabytes. That has been the
 * right trade for fourteen sessions: it makes every material editable, it costs
 * nothing to download, and it raises no questions about who owns the pixels.
 *
 * It also has a ceiling, and the ceiling is real. Procedural wood gets the
 * plank layout, the grain direction and the joint relief right, and it does not
 * get the things a photograph carries for free: the knot that is not periodic,
 * the mineral streak, the one board that came from a different tree. Generated
 * texture is CONVINCINGLY REGULAR, and real material is not regular at all.
 *
 * -----------------------------------------------------------------------------
 * WHICH IS WHY THIS FILE SHIPS NO IMAGES.
 *
 * Photographed material is somebody's work, and using it in a product that is
 * meant to be sold is a licensing decision rather than a technical one. There
 * are three honest routes — a permissive source such as CC0 scan libraries, a
 * bought commercial pack, or photographing surfaces yourself — and they differ
 * in cost, in attribution obligation, and in whether they can be redistributed
 * inside an app at all.
 *
 * So what is here is the machinery and the safeguard, with nothing loaded. The
 * safeguard is not a comment: `registerPhotographed` REFUSES a texture set that
 * does not carry a licence, a source and an attribution line, so it is not
 * possible to end up shipping an image whose terms nobody recorded. That is the
 * failure this is really guarding against — not somebody deliberately taking a
 * texture, but a file quietly arriving in a folder and being forgotten.
 *
 * -----------------------------------------------------------------------------
 * AND THE TWO THINGS THAT ARE EASY TO GET WRONG.
 *
 * Colour space: an albedo map is COLOUR and must be tagged sRGB; a roughness,
 * metalness, AO or normal map is DATA and must not be. Getting it backwards is
 * the single most common texture bug there is, and it does not look like a bug
 * — it looks like the material is slightly too dark or slightly too shiny, and
 * people tune other things to compensate.
 *
 * Scale: this app's floors carry UVs measured in METRES of world space, not in
 * normalised 0..1, so a texture's repeat is a pure function of the real-world
 * size of the surface it was photographed from. A scan of a 2 m square of oak
 * and a scan of a 600 mm tile are not interchangeable at the same repeat, and
 * nothing about the image says which it is. It has to be declared.
 */

import * as THREE from 'three';

/** What a texture set must say about itself before it may be used. */
export interface TextureLicence {
  /**
   * The licence, as its actual identifier rather than a description.
   *
   * "CC0-1.0", "CC-BY-4.0", "Proprietary-Purchased", "Own-Photograph". A phrase
   * like "free for commercial use" is what a licence is SUMMARISED as on a
   * download page and is not a licence; it cannot be checked against anything
   * and it is not what a rights holder would be shown.
   */
  spdx: string;
  /** Where it came from, precisely enough to find it again. */
  source: string;
  /**
   * The attribution line to display, or null when the licence requires none.
   *
   * Null is an assertion, not an omission — it means somebody established that
   * this licence does not require attribution. An undefined field would mean
   * nobody had looked.
   */
  attribution: string | null;
  /** When the terms were last checked, ISO date, or null if never. */
  verifiedAt: string | null;
}

/** The images a photographed material is made of. */
export interface TextureSet {
  /**
   * The real-world size the scan covers, in metres.
   *
   * Required, and there is no sensible default: see the header. A 2 m scan and
   * a 600 mm scan tile completely differently on the same floor.
   */
  tileMetres: number;
  /** Base colour. sRGB. */
  albedo: string;
  /** Tangent-space normals. Linear. Optional. */
  normal?: string;
  /** Roughness, in the green channel by convention. Linear. Optional. */
  roughness?: string;
  /** Ambient occlusion. Linear. Optional. */
  occlusion?: string;
  /** Who owns it and on what terms. */
  licence: TextureLicence;
}

/** A registered set, ready to be bound to a material. */
export interface PhotographedMaterial {
  id: string;
  set: TextureSet;
}

/**
 * Why a texture set was refused.
 *
 * Returned rather than thrown, because a missing licence is a thing to report
 * to whoever is adding the texture, not a crash for whoever is using the app.
 */
export type RegistrationError =
  | { reason: 'no-licence'; detail: string }
  | { reason: 'no-source'; detail: string }
  | { reason: 'no-attribution-decision'; detail: string }
  | { reason: 'no-scale'; detail: string }
  | { reason: 'duplicate'; detail: string };

const registry = new Map<string, PhotographedMaterial>();

/**
 * Registers a photographed texture set, or refuses it and says why.
 *
 * The refusal is the point. Everything else here is ordinary texture plumbing
 * that any renderer has; this is what stops an image with unrecorded terms from
 * reaching a build, which is the way that mistake actually happens — not by
 * anybody deciding to take something, but by a file arriving in a folder and
 * being forgotten about by the time anyone asks.
 */
export function registerPhotographed(
  id: string,
  set: TextureSet,
): { ok: true } | { ok: false; error: RegistrationError } {
  if (registry.has(id)) {
    return { ok: false, error: { reason: 'duplicate', detail: `${id} is already registered` } };
  }
  if (!set.licence?.spdx?.trim()) {
    return {
      ok: false,
      error: { reason: 'no-licence', detail: `${id} has no licence identifier` },
    };
  }
  if (!set.licence.source?.trim()) {
    return { ok: false, error: { reason: 'no-source', detail: `${id} does not say where it came from` } };
  }
  if (set.licence.attribution === undefined) {
    /*
     * Undefined and null are different answers and this is the one place in the
     * codebase where the distinction carries weight. Null says somebody
     * established that no attribution is required; undefined says nobody
     * looked.
     */
    return {
      ok: false,
      error: {
        reason: 'no-attribution-decision',
        detail: `${id} has no attribution decision — use null to assert none is required`,
      },
    };
  }
  if (!(set.tileMetres > 0)) {
    return {
      ok: false,
      error: { reason: 'no-scale', detail: `${id} does not say what real-world size it covers` },
    };
  }

  registry.set(id, { id, set });
  return { ok: true };
}

/** Everything registered, for the credits screen and for the README check. */
export function photographedMaterials(): PhotographedMaterial[] {
  return [...registry.values()];
}

/** The attribution lines that must be displayed. Empty when none are required. */
export function requiredAttributions(): string[] {
  return photographedMaterials()
    .map((material) => material.set.licence.attribution)
    .filter((line): line is string => line !== null);
}

/** Forgets everything. For tests, and for a future "use generated only" switch. */
export function clearPhotographed(): void {
  registry.clear();
}

/**
 * Loads a registered set and binds it to a material.
 *
 * Returns false when the id is not registered, which is the state this file
 * ships in: no images, so nothing to load, and every material stays generated.
 * That is a working state rather than a broken one, and it is deliberately the
 * default.
 */
export function applyPhotographed(
  material: THREE.MeshStandardMaterial,
  id: string,
  loader: THREE.TextureLoader = new THREE.TextureLoader(),
): boolean {
  const entry = registry.get(id);
  if (!entry) return false;

  const { set } = entry;
  const repeat = 1 / set.tileMetres;

  /** Binds one image with the colour space its CONTENT requires. */
  const bind = (url: string, colorSpace: THREE.ColorSpace): THREE.Texture => {
    const texture = loader.load(url);
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    // UVs are in metres of world space, so the repeat is the inverse of the
    // scan's real size. See the header.
    texture.repeat.set(repeat, repeat);
    return texture;
  };

  material.map = bind(set.albedo, THREE.SRGBColorSpace);
  if (set.normal) material.normalMap = bind(set.normal, THREE.NoColorSpace);
  if (set.roughness) material.roughnessMap = bind(set.roughness, THREE.NoColorSpace);
  if (set.occlusion) {
    material.aoMap = bind(set.occlusion, THREE.NoColorSpace);
    /*
     * A scan's own occlusion is small-scale — the shadow inside a grain, under
     * a tile's chamfer — and the sky bake computes the room-scale kind. They
     * multiply rather than duplicating each other, which is why both can be on
     * at once, but the scan's has to be held back: a photograph taken under
     * diffuse light already has some of it baked into the albedo.
     */
    material.aoMapIntensity = 0.6;
  }

  material.needsUpdate = true;
  return true;
}
