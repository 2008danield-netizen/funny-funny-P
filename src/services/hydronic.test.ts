/**
 * Tests for the hydronic layout.
 *
 * The one that matters is the flow temperature: a radiator at 55/45 gives
 * roughly half what the catalogue says, and a version of this file that ignored
 * that would produce a house that is cold in a way nobody could diagnose from
 * the drawings.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, drawWall, normalizePlan } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import { calculateLoad } from './manualJ';
import { EMITTERS, layoutHydronic, radiatorOutputFactor, resetEmitterIds } from './hydronic';
import type { DesignDocument } from '@/state/types';

function house(options: { city?: string; roof?: string; glazing?: string } = {}): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  // Centred at (6, 4) so the house spans x 0-12 and z 0-8 and the partitions
  // below land inside it. `addRectangle` takes the CENTRE, not a corner — at
  // the origin the partitions fall outside as dangling walls enclosing
  // nothing, which still yields a plan, still yields one room, and silently
  // stops this fixture being the multi-room house it claims to be.
  addRectangle(level.plan, { x: 6, z: 4 }, 12, 8);
  drawWall(level.plan, { x: 6, z: 0 }, { x: 6, z: 8 });
  normalizePlan(level.plan);

  const names = ['Living Room', 'Bedroom 1'];
  findRegions(level.plan).forEach((region, index) => {
    level.plan.rooms[region.key] = {
      name: names[index] ?? `Room ${index}`,
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  });

  for (const wall of level.plan.walls.slice(0, 4)) {
    addOpening(level.plan, wall.id, 'window', 'window-casement', { width: 1.5, height: 1.4, sillHeight: 0.9 }, 2);
  }

  doc.hvac.locationKey = options.city ?? 'Chicago, IL';
  doc.hvac.system = 'hydronic';
  if (options.roof) doc.hvac.envelope.roofAssemblyId = options.roof;
  if (options.glazing) doc.hvac.envelope.glazingId = options.glazing;
  return doc;
}

describe('radiator output', () => {
  it('is the catalogue figure at the catalogue condition', () => {
    // 75/65 into a room at 20 is a mean water temperature of 70, which is
    // exactly ΔT 50 — the condition every catalogue quotes.
    expect(radiatorOutputFactor(75, 65)).toBeCloseTo(1, 6);
  });

  it('roughly halves at a condensing boiler’s flow temperature', () => {
    // 55/45 is ΔT 30. This is the whole reason the flow temperature is an
    // input rather than a constant: radiators sized off the catalogue and then
    // run at 55 leave the house cold, the owner turns the boiler up, and the
    // boiler stops condensing.
    const factor = radiatorOutputFactor(55, 45);
    expect(factor).toBeGreaterThan(0.45);
    expect(factor).toBeLessThan(0.55);
  });

  it('is not linear in temperature difference', () => {
    // A radiator works mostly by convection, which is not linear. Treating it
    // as linear overstates a low-temperature system by around 10%.
    expect(radiatorOutputFactor(55, 45)).toBeLessThan(30 / 50);
  });

  it('gives nothing when the water is no warmer than the room', () => {
    expect(radiatorOutputFactor(20, 20)).toBe(0);
  });
});

describe('hydronic layout', () => {
  beforeEach(() => resetEmitterIds());

  it('puts an emitter in every room with a load', () => {
    const doc = house();
    const load = calculateLoad(doc);
    const layout = layoutHydronic(doc, load);

    const withLoad = load.rooms.filter((room) => room.heatingTotal > 1);
    expect(layout.emitters.length).toBe(withLoad.length);
    expect(withLoad.length).toBeGreaterThan(0);
  });

  it('needs bigger radiators at a lower flow temperature', () => {
    /*
     * Measured on what the room NEEDS rather than on what was placed. The
     * placed length is clamped by the clear wall available, so in a room that
     * is already up against that limit both flow temperatures give the same
     * radiator — and only one of them heats the room. That gap is the finding,
     * and it is what `wantedLength` and `adequate` are for.
     */
    const doc = house();
    const load = calculateLoad(doc);

    const hot = layoutHydronic(doc, load, { regimeId: 'traditional-75' });
    const cool = layoutHydronic(doc, load, { regimeId: 'condensing-55' });

    const wanted = (layout: typeof hot): number =>
      layout.sized.reduce((sum, sized) => sum + sized.wantedLength, 0);

    expect(wanted(cool)).toBeGreaterThan(wanted(hot) * 1.7);
    // And the shortfall shows up as a finding, not just as a smaller number.
    expect(cool.sized.filter((sized) => !sized.adequate).length).toBeGreaterThanOrEqual(
      hot.sized.filter((sized) => !sized.adequate).length,
    );
  });

  it('uses underfloor where the load per square metre allows it', () => {
    const doc = house({ roof: 'roof-r60', glazing: 'triple-lowe' });
    const load = calculateLoad(doc);
    const layout = layoutHydronic(doc, load, { preferUnderfloor: true });

    expect(layout.emitters.some((emitter) => emitter.kind === 'underfloor')).toBe(true);
  });

  it('refuses underfloor in a room it cannot heat, and says why', () => {
    /*
     * Underfloor is capped by the surface temperature people will stand on —
     * about 100 W/m² — and no amount of extra pipe changes that. A badly
     * insulated, heavily glazed room in a cold climate exceeds it, and the
     * honest answer is a radiator rather than an underfloor loop that will
     * never hold the room.
     */
    const doc = house({ city: 'Minneapolis, MN', roof: 'roof-r30', glazing: 'single' });
    doc.hvac.envelope.wallAssemblyId = 'wall-2x4-r13';
    doc.hvac.envelope.infiltrationId = 'very-leaky';

    const load = calculateLoad(doc);
    const layout = layoutHydronic(doc, load, { preferUnderfloor: true });

    const intensity = load.rooms.map((room) => room.heatingTotal / room.area);
    expect(Math.max(...intensity)).toBeGreaterThan(EMITTERS.underfloorWattsPerSquareMetre);

    expect(layout.emitters.some((emitter) => emitter.kind === 'radiator')).toBe(true);
    expect(layout.sized.some((sized) => sized.reason.includes('W/m²'))).toBe(true);
  });

  it('reports a radiator that will not fit rather than inventing a longer one', () => {
    // Nobody makes a 6 m radiator. A room that needs one has to be told.
    const doc = house({ city: 'Minneapolis, MN', roof: 'roof-r30', glazing: 'single' });
    doc.hvac.envelope.wallAssemblyId = 'wall-2x4-r13';
    doc.hvac.envelope.infiltrationId = 'very-leaky';

    const load = calculateLoad(doc);
    const layout = layoutHydronic(doc, load, { regimeId: 'condensing-45' });

    for (const emitter of layout.emitters) {
      expect(emitter.length).toBeLessThanOrEqual(EMITTERS.maxLength);
    }
    expect(layout.sized.some((sized) => !sized.adequate)).toBe(true);
    expect(layout.assumptions.join(' ')).toMatch(/cannot fit/i);
  });

  it('carries the flow temperature into its own caveats', () => {
    const doc = house();
    const load = calculateLoad(doc);
    const layout = layoutHydronic(doc, load, { regimeId: 'traditional-75' });

    expect(layout.assumptions.join(' ')).toContain('75 / 65');
    expect(layout.assumptions.join(' ')).toMatch(/never condenses/i);
  });

  it('places emitters inside the rooms they serve', () => {
    const doc = house();
    const load = calculateLoad(doc);
    const layout = layoutHydronic(doc, load);
    const level = doc.levels[0]!;
    const byKey = new Map(findRegions(level.plan).map((region) => [region.key, region]));

    for (const emitter of layout.emitters) {
      expect(byKey.has(emitter.roomKey)).toBe(true);
    }
  });

  it('does nothing without a design location', () => {
    const doc = house();
    doc.hvac.locationKey = '';
    const layout = layoutHydronic(doc, calculateLoad(doc));

    expect(layout.emitters).toHaveLength(0);
    expect(layout.assumptions.join(' ')).toMatch(/design location/i);
  });
});
