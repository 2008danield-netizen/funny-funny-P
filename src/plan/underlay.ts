/**
 * Placing a floor plan image in the world.
 *
 * The whole of this module exists to answer one question: where is a given
 * pixel of somebody's scan, in metres, on the site? Everything else about
 * tracing — drawing over it, detecting its walls, lining it up with the storey
 * below — is built on that mapping being right.
 *
 * THE CONVENTION. Image pixels are the usual thing: x across, y down, origin at
 * the top-left corner. World coordinates are the app's usual thing: x across,
 * z away, in metres. A `Point2` is used for both, with `z` carrying the pixel y
 * — which is not elegant, but it means one vector type instead of two and no
 * conversion at the boundary. Every function here says which space it wants.
 *
 * An underlay is placed by three numbers: where its CENTRE sits, how many
 * metres one pixel is, and how far it is turned. Centre rather than a corner,
 * because rotating and rescaling about the middle is what feels right under the
 * hand — a corner-anchored image swings away from the cursor when you scale it.
 */

import type { Point2, Underlay } from '@/state/types';

/** Half the image, in pixels. */
function halfSize(underlay: Underlay): Point2 {
  return { x: underlay.pixelWidth / 2, z: underlay.pixelHeight / 2 };
}

/**
 * Where a pixel of the image lands in the world, in metres.
 *
 * `pixel.z` carries the image's y coordinate. Measured from the top-left of the
 * image, as every image-editing tool in the world measures it.
 */
export function imageToWorld(underlay: Underlay, pixel: Point2): Point2 {
  const half = halfSize(underlay);
  const offsetX = (pixel.x - half.x) * underlay.metresPerPixel;
  const offsetZ = (pixel.z - half.z) * underlay.metresPerPixel;

  const cos = Math.cos(underlay.rotation);
  const sin = Math.sin(underlay.rotation);

  return {
    x: underlay.at.x + offsetX * cos - offsetZ * sin,
    z: underlay.at.z + offsetX * sin + offsetZ * cos,
  };
}

/** The inverse: which pixel of the image a point in the world falls on. */
export function worldToImage(underlay: Underlay, world: Point2): Point2 {
  const dx = world.x - underlay.at.x;
  const dz = world.z - underlay.at.z;

  const cos = Math.cos(-underlay.rotation);
  const sin = Math.sin(-underlay.rotation);

  const offsetX = dx * cos - dz * sin;
  const offsetZ = dx * sin + dz * cos;

  const half = halfSize(underlay);
  return {
    x: half.x + offsetX / underlay.metresPerPixel,
    z: half.z + offsetZ / underlay.metresPerPixel,
  };
}

/** How big the image is on the ground, in metres. */
export function underlaySize(underlay: Underlay): { width: number; depth: number } {
  return {
    width: underlay.pixelWidth * underlay.metresPerPixel,
    depth: underlay.pixelHeight * underlay.metresPerPixel,
  };
}

/** The four corners in the world, clockwise from the image's top-left. */
export function underlayCorners(underlay: Underlay): Point2[] {
  return [
    imageToWorld(underlay, { x: 0, z: 0 }),
    imageToWorld(underlay, { x: underlay.pixelWidth, z: 0 }),
    imageToWorld(underlay, { x: underlay.pixelWidth, z: underlay.pixelHeight }),
    imageToWorld(underlay, { x: 0, z: underlay.pixelHeight }),
  ];
}

/* ------------------------------- Calibration ------------------------------ */

/**
 * Sets the scale from two points on the image and the real distance between
 * them.
 *
 * This is the single act that turns a picture into a measurement, and it is
 * worth doing carefully: everything traced afterwards inherits its error. Two
 * points a long way apart are much better than two close together, because the
 * few pixels of slop in each click are divided by the distance between them —
 * which is why the UI asks for the longest wall somebody knows the length of
 * rather than a doorway.
 *
 * The centre of the image stays where it is, so recalibrating does not send the
 * plan flying off across the site.
 */
export function calibrateUnderlay(
  underlay: Underlay,
  from: Point2,
  to: Point2,
  metres: number,
  label = 'a known length',
): Underlay {
  const pixels = Math.hypot(to.x - from.x, to.z - from.z);
  if (pixels < 1 || !(metres > 0)) return underlay;

  return {
    ...underlay,
    metresPerPixel: metres / pixels,
    calibration: { from, to, metres, label },
  };
}

/** Whether the scale came from a real measurement rather than a guess. */
export function isCalibrated(underlay: Underlay): boolean {
  return underlay.calibration !== null;
}

/**
 * How long a calibration is, in pixels — how much to trust it.
 *
 * A calibration taken across 40 pixels is worth saying something about: two
 * clicks are each worth a pixel or two, so the scale could easily be five
 * percent out, which is half a metre in a ten-metre house.
 */
export function calibrationSpan(underlay: Underlay): number {
  const calibration = underlay.calibration;
  if (!calibration) return 0;
  return Math.hypot(
    calibration.to.x - calibration.from.x,
    calibration.to.z - calibration.from.z,
  );
}

/* -------------------------------- Alignment ------------------------------- */

/** An axis-aligned box, in whatever space its maker was working in. */
export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function boundsOf(points: readonly Point2[]): Bounds | null {
  if (points.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ };
}

/** The underlay's own extent in the world. */
export function underlayBounds(underlay: Underlay): Bounds {
  return boundsOf(underlayCorners(underlay))!;
}

/**
 * Suggests a placement that lines this plan up with something already drawn.
 *
 * Given a box in the image that holds the drawing itself, and a box in the
 * world that the drawing should cover — the outline of the storey below, say —
 * this scales and shifts the underlay so the two agree.
 *
 * It fits by the LONGER side rather than by stretching to fit both, because an
 * image has one scale and a plan drawn at a different aspect than the storey
 * below means one of the two is wrong; distorting the picture to hide that
 * would produce a house that measures correctly in one direction only.
 *
 * A suggestion, not an answer. Upper floors overhang, extensions exist, and the
 * user gets to nudge it afterwards.
 */
export function suggestAlignment(
  underlay: Underlay,
  contentInPixels: Bounds,
  targetInWorld: Bounds,
): Underlay {
  const contentWidth = contentInPixels.maxX - contentInPixels.minX;
  const contentHeight = contentInPixels.maxZ - contentInPixels.minZ;
  const targetWidth = targetInWorld.maxX - targetInWorld.minX;
  const targetDepth = targetInWorld.maxZ - targetInWorld.minZ;

  if (contentWidth < 1 || contentHeight < 1 || targetWidth <= 0 || targetDepth <= 0) {
    return underlay;
  }

  // One scale for both axes: the picture is not stretched.
  const metresPerPixel = Math.min(targetWidth / contentWidth, targetDepth / contentHeight);

  // Put the middle of the drawing on the middle of the target, working in the
  // rotated frame so that a turned underlay still lands centred.
  const scaled: Underlay = { ...underlay, metresPerPixel };
  const contentCentre = {
    x: (contentInPixels.minX + contentInPixels.maxX) / 2,
    z: (contentInPixels.minZ + contentInPixels.maxZ) / 2,
  };
  const where = imageToWorld(scaled, contentCentre);

  return {
    ...scaled,
    at: {
      x: underlay.at.x + ((targetInWorld.minX + targetInWorld.maxX) / 2 - where.x),
      z: underlay.at.z + ((targetInWorld.minZ + targetInWorld.maxZ) / 2 - where.z),
    },
  };
}

/**
 * A first placement for a freshly imported image.
 *
 * Centred on the origin at a guessed scale, unrotated, half faded. The guess is
 * chosen so that a typical plan lands at roughly house-sized rather than either
 * microscopic or filling the county — because an image that appears somewhere
 * off screen looks to the user like an import that failed.
 */
export function placeNewUnderlay(
  imageId: string,
  pixelWidth: number,
  pixelHeight: number,
  spanMetres = 12,
): Underlay {
  const longest = Math.max(pixelWidth, pixelHeight, 1);
  return {
    imageId,
    pixelWidth,
    pixelHeight,
    at: { x: 0, z: 0 },
    metresPerPixel: spanMetres / longest,
    rotation: 0,
    opacity: 0.5,
    locked: false,
    calibration: null,
  };
}
