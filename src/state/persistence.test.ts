/**
 * Tests for what an exported design file contains.
 *
 * The rule this protects: a design file is ONE thing you can send somebody. A
 * file that arrives without the plan its author traced from is a file the
 * recipient cannot carry on with — and the failure is silent, because the model
 * still opens and looks complete.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument } from './defaults';
import { getImage, resetImageMemory } from './imageStore';
import { imageIdsIn, importDocument } from './persistence';
import { placeNewUnderlay } from '@/plan/underlay';
import type { DesignDocument } from './types';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function asFile(value: unknown): File {
  return new File([JSON.stringify(value)], 'design.json', { type: 'application/json' });
}

function withUnderlay(): DesignDocument {
  const doc = createDefaultDocument();
  doc.levels[0]!.underlay = placeNewUnderlay('img-traced', 1200, 800);
  return doc;
}

describe('which images a design needs', () => {
  it('lists the plan behind every storey, once each', () => {
    const doc = withUnderlay();
    expect(imageIdsIn(doc)).toEqual(['img-traced']);
    expect(imageIdsIn(createDefaultDocument())).toEqual([]);
  });
});

describe('opening a design file', () => {
  it('still opens a file written before there were any images', () => {
    // Every export up to session 7 was the bare document. Those must keep
    // opening, or a design somebody saved last month is lost.
    return importDocument(asFile(createDefaultDocument())).then((doc) => {
      expect(doc.levels).toHaveLength(1);
      expect(doc.schemaVersion).toBeGreaterThanOrEqual(7);
    });
  });

  it('puts the images back where the underlays expect to find them', async () => {
    resetImageMemory();

    const doc = await importDocument(
      asFile({
        havavamama: 1,
        document: withUnderlay(),
        images: { 'img-traced': { dataUrl: PIXEL, width: 1200, height: 800 } },
      }),
    );

    expect(doc.levels[0]!.underlay!.imageId).toBe('img-traced');
    // Restored under the SAME key, which is what makes the underlay resolve.
    const stored = await getImage('img-traced');
    expect(stored?.dataUrl).toBe(PIXEL);
    expect(stored?.width).toBe(1200);
  });

  it('opens a bundle whose images are missing rather than refusing it', async () => {
    resetImageMemory();

    const doc = await importDocument(asFile({ havavamama: 1, document: withUnderlay() }));
    // The design is still worth having; the panel is what says the plan behind
    // it could not be found.
    expect(doc.levels[0]!.underlay).not.toBeNull();
    expect(await getImage('img-traced')).toBeNull();
  });

  it('treats an envelope with no marker as a plain document', async () => {
    const doc = await importDocument(asFile({ ...createDefaultDocument(), name: 'Plain' }));
    expect(doc.name).toBe('Plain');
  });

  it('turns junk into the starter room instead of throwing', async () => {
    const doc = await importDocument(asFile({ nonsense: true }));
    expect(doc.levels.length).toBeGreaterThan(0);
  });
});
