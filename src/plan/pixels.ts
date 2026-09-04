/**
 * Getting at the pixels of an image, in the browser.
 *
 * The one place that turns a stored plan into something the detector can read.
 * Kept separate from both the store (which is about keeping images) and the
 * detector (which is pure, and stays testable by never touching a canvas).
 */

import { loadImageElement } from '@/state/imageStore';
import type { Pixels } from './detect';

/** Reads an image's pixels out of a data URL. */
export async function pixelsFrom(dataUrl: string): Promise<Pixels> {
  const image = await loadImageElement(dataUrl);

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser would not give us a canvas to read the plan with.');

  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: data.width, height: data.height, data: data.data };
}
