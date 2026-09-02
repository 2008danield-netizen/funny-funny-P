/**
 * Builds and caches the Three.js materials used by the room.
 *
 * Two rules drive the design here:
 *
 *  1. TEXTURE GENERATION IS EXPENSIVE, MATERIAL UPDATES ARE NOT. Generating a
 *     1024² procedural surface costs tens of milliseconds, so generated canvases
 *     are cached per preset and reused forever. Changing a colour or roughness
 *     only touches a material property and costs nothing.
 *
 *  2. NOTHING LEAKS. WebGL resources are not garbage-collected — every texture
 *     and material this class creates is tracked and released in `dispose()`.
 *     With a room the user can resize continuously, a leak here would exhaust
 *     GPU memory within minutes.
 */

import * as THREE from 'three';

import type { SurfaceMaps } from './generators';
import { generateConcrete } from './generators';
import { getFloorPreset } from './presets';
import { createCanvas, heightToNormalMap } from './textureUtils';
import type { FloorSpec, WallFaceSpec } from '@/state/types';

/** Resolution of generated maps. 1024 resolves plank grain without a long stall. */
const TEXTURE_SIZE = 1024;

/** The three canvases that make up one generated surface. */
interface SurfaceCanvases {
  albedo: HTMLCanvasElement;
  roughness: HTMLCanvasElement;
  normal: HTMLCanvasElement;
  tileMetres: number;
}

/** Paints an ImageData onto a fresh canvas of the same size. */
function toCanvas(image: ImageData): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(image.width);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Converts generator output into ready-to-upload canvases. */
function bakeSurface(maps: SurfaceMaps): SurfaceCanvases {
  return {
    albedo: toCanvas(maps.albedo),
    roughness: toCanvas(maps.roughness),
    normal: toCanvas(heightToNormalMap(maps.height, maps.normalStrength)),
    tileMetres: maps.tileMetres,
  };
}

export class MaterialLibrary {
  /** Generated canvases, keyed by preset ID. Never evicted — the set is small. */
  private surfaceCache = new Map<string, SurfaceCanvases>();

  /** The shared fine-plaster surface applied to every wall. */
  private plaster: SurfaceCanvases | null = null;

  /** Every texture handed out, so it can be released on teardown. */
  private textures = new Set<THREE.Texture>();

  /** Anisotropic filtering level, taken from the renderer's capabilities. */
  private maxAnisotropy = 1;

  setMaxAnisotropy(value: number): void {
    this.maxAnisotropy = Math.max(1, value);
  }

  /** Generates (or returns a cached) surface for a floor preset. */
  private getSurface(presetId: string): SurfaceCanvases {
    const preset = getFloorPreset(presetId);
    const cached = this.surfaceCache.get(preset.id);
    if (cached) return cached;

    const baked = bakeSurface(preset.build(TEXTURE_SIZE));
    this.surfaceCache.set(preset.id, baked);
    return baked;
  }

  /**
   * The wall surface.
   *
   * Painted plaster is not flat — it has a faint orange-peel texture that
   * catches grazing light. Because only the normal and roughness maps are used
   * (the colour comes from the material's `color`), one greyscale surface
   * serves every wall colour.
   */
  private getPlaster(): SurfaceCanvases {
    if (this.plaster) return this.plaster;
    this.plaster = bakeSurface(
      generateConcrete(512, {
        baseColor: '#ffffff',
        mottleColor: '#f2f2f2',
        polish: 0.35,
        seed: 1881,
        tileMetres: 1.5,
      }),
    );
    return this.plaster;
  }

  /** Wraps a canvas in a tracked THREE texture. */
  private makeTexture(canvas: HTMLCanvasElement, colorSpace: THREE.ColorSpace): THREE.Texture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = colorSpace;
    // Anisotropy is what keeps a floor sharp when viewed at a grazing angle —
    // without it, plank grain turns into a blurred smear towards the horizon.
    texture.anisotropy = this.maxAnisotropy;
    texture.needsUpdate = true;
    this.textures.add(texture);
    return texture;
  }

  /**
   * Creates the floor material.
   *
   * The returned material is reconfigured in place by `applyFloorSpec` rather
   * than being recreated, so the floor mesh never needs a new material
   * reference and shader recompilation is avoided on every edit.
   */
  createFloorMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.6,
      metalness: 0,
    });
  }

  /**
   * Applies a floor spec to a material, swapping textures only if the preset
   * actually changed.
   *
   * Since session 2 the floor geometry carries UVs measured in METRES of world
   * space rather than normalised 0..1 (see `floorBuilder`), so the repeat is a
   * pure function of the material's own tile size. Two consequences, both of
   * them wanted: planks never stretch when a room is reshaped, and floorboards
   * run continuously from one room into the next instead of restarting at the
   * doorway.
   */
  applyFloorSpec(material: THREE.MeshStandardMaterial, spec: FloorSpec): void {
    const surface = this.getSurface(spec.presetId);

    // `userData.presetId` tracks what is currently bound so repeated edits to
    // colour or scale do not rebuild GPU textures.
    if (material.userData.presetId !== spec.presetId) {
      this.releaseFloorTextures(material);

      material.map = this.makeTexture(surface.albedo, THREE.SRGBColorSpace);
      // Roughness and normal data are raw values, not colour — they must stay
      // in linear space or the lighting response is subtly wrong.
      material.roughnessMap = this.makeTexture(surface.roughness, THREE.NoColorSpace);
      material.normalMap = this.makeTexture(surface.normal, THREE.NoColorSpace);
      material.userData.presetId = spec.presetId;
      material.needsUpdate = true;
    }

    // One repeat covers `tileMetres * textureScale` metres of floor. UVs are in
    // metres, so the repeat is the reciprocal of that distance.
    const metresPerRepeat = surface.tileMetres * spec.textureScale;
    const repeat = 1 / metresPerRepeat;

    for (const texture of [material.map, material.roughnessMap, material.normalMap]) {
      if (texture) texture.repeat.set(repeat, repeat);
    }

    material.color.set(spec.color);
    material.normalScale.set(1, 1);
  }

  /** Creates a wall material with its own plaster texture instances. */
  createWallMaterial(): THREE.MeshStandardMaterial {
    const plaster = this.getPlaster();
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
      roughnessMap: this.makeTexture(plaster.roughness, THREE.NoColorSpace),
      normalMap: this.makeTexture(plaster.normal, THREE.NoColorSpace),
      // A very light touch — plaster texture should be felt, not seen.
      normalScale: new THREE.Vector2(0.18, 0.18),
    });
  }

  /**
   * Applies colour and finish to one face of a wall.
   *
   * Wall geometry carries UVs in metres (see `wallBuilder`), so the plaster
   * texture is scaled purely by its own tile size. That keeps the grain
   * identical on a 1 m stub and a 9 m run, which is not true if the repeat is
   * derived from the wall's dimensions.
   */
  applyWallSpec(material: THREE.MeshStandardMaterial, spec: WallFaceSpec): void {
    material.color.set(spec.color);
    material.roughness = spec.roughness;

    const repeat = 1 / this.getPlaster().tileMetres;
    for (const texture of [material.roughnessMap, material.normalMap]) {
      if (texture) texture.repeat.set(repeat, repeat);
    }
  }

  /** A plain matte material, used for the ceiling and wall exteriors. */
  createPlainMaterial(color: string, roughness = 0.95): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
  }

  /** Frees the textures currently bound to a floor material. */
  private releaseFloorTextures(material: THREE.MeshStandardMaterial): void {
    for (const texture of [material.map, material.roughnessMap, material.normalMap]) {
      if (texture) {
        texture.dispose();
        this.textures.delete(texture);
      }
    }
    material.map = null;
    material.roughnessMap = null;
    material.normalMap = null;
  }

  /** Releases every GPU resource this library created. */
  dispose(): void {
    for (const texture of this.textures) texture.dispose();
    this.textures.clear();
    this.surfaceCache.clear();
    this.plaster = null;
  }

  /**
   * Renders a small preview of a preset for the UI swatch grid.
   *
   * Generated at low resolution because it is only ever displayed a few dozen
   * pixels wide, which keeps the floor panel instant to open.
   */
  static renderPreview(presetId: string, size = 96): string {
    const preset = getFloorPreset(presetId);
    const maps = preset.build(size);
    return toCanvas(maps.albedo).toDataURL('image/png');
  }
}
