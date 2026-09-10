/**
 * Tests for the Manual J load calculation.
 *
 * The load is the number every other part of this session depends on, and it is
 * the hardest to eyeball: a figure that is 40% low still looks like a plausible
 * BTU/h. So these tests check it three ways — against the physics it claims to
 * implement, against the shape the answer must have, and against the range a
 * real Manual J lands in.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, normalizePlan } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import { TON_BTU, wattsToBtu } from '@/code/acca';
import type { DesignDocument } from '@/state/types';

import { calculateLoad } from './manualJ';

/** A single-storey rectangular house with windows on every side. */
function house(options: { width?: number; depth?: number; city?: string; windows?: boolean } = {}): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  addRectangle(level.plan, { x: 0, z: 0 }, options.width ?? 12, options.depth ?? 8);
  normalizePlan(level.plan);

  for (const region of findRegions(level.plan)) {
    level.plan.rooms[region.key] = {
      name: 'Living Room',
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  }

  if (options.windows !== false) {
    for (const wall of level.plan.walls.slice(0, 4)) {
      addOpening(level.plan, wall.id, 'window', 'window-casement', { width: 1.5, height: 1.4, sillHeight: 0.9 }, 2);
      addOpening(level.plan, wall.id, 'window', 'window-casement', { width: 1.5, height: 1.4, sillHeight: 0.9 }, 5);
    }
  }

  doc.hvac.locationKey = options.city ?? 'Chicago, IL';
  return doc;
}

describe('the Manual J load', () => {
  it('refuses to compute without a design location', () => {
    const doc = house();
    doc.hvac.locationKey = '';

    const load = calculateLoad(doc);
    expect(load.conditions).toBeNull();
    expect(load.heatingTotal).toBe(0);
    // And says why, rather than silently returning zero.
    expect(load.assumptions.join(' ')).toMatch(/design location/i);
  });

  it('lands in the range a real Manual J does', () => {
    /*
     * The sanity check that catches a calculation which is internally
     * consistent and wrong by a factor. A well-insulated modern house comes out
     * at 800–1300 ft² per ton of cooling — well above the old "500 ft²/ton"
     * rule of thumb, which is based on 1970s construction and is why so many
     * systems are oversized.
     */
    const load = calculateLoad(house({ city: 'Phoenix, AZ' }));
    const sqft = load.floorArea / 0.092903;
    const tons = wattsToBtu(load.coolingTotal) / TON_BTU;
    const sqftPerTon = sqft / tons;

    expect(sqftPerTon).toBeGreaterThan(600);
    expect(sqftPerTon).toBeLessThan(1400);

    // Heating, in BTU/h per square foot, for a cold climate.
    const chicago = calculateLoad(house({ city: 'Chicago, IL' }));
    const heatPerSqFt = wattsToBtu(chicago.heatingTotal) / (chicago.floorArea / 0.092903);
    expect(heatPerSqFt).toBeGreaterThan(10);
    expect(heatPerSqFt).toBeLessThan(35);
  });

  it('does not discount solar twice', () => {
    /*
     * The bug this test exists for: the solar table is on an SHGC = 1.0 basis,
     * and an earlier version held values "for clear double glazing" — SHGC 0.6
     * already folded in — which the caller then multiplied by the real SHGC as
     * well. Cooling came out around half of what Manual J gives.
     *
     * Halving the glazing's SHGC must roughly halve the solar term. If the
     * table's basis is ever changed back, this fails.
     */
    const clear = house();
    clear.hvac.envelope.glazingId = 'double-clear'; // SHGC 0.6
    const lowE = house();
    lowE.hvac.envelope.glazingId = 'double-lowe'; // SHGC 0.3

    const clearSolar = calculateLoad(clear).rooms[0]!.coolingSolar;
    const lowESolar = calculateLoad(lowE).rooms[0]!.coolingSolar;

    expect(lowESolar / clearSolar).toBeCloseTo(0.5, 1);
  });

  it('makes a colder city need more heat and a hotter one more cooling', () => {
    const miami = calculateLoad(house({ city: 'Miami, FL' }));
    const minneapolis = calculateLoad(house({ city: 'Minneapolis, MN' }));

    expect(minneapolis.heatingTotal).toBeGreaterThan(miami.heatingTotal * 3);
    expect(miami.coolingLatent).toBeGreaterThan(minneapolis.coolingLatent);
  });

  it('counts humidity as a real part of the cooling duty in a humid climate', () => {
    // Houston and Phoenix are both hot; only one of them is wet. An air
    // conditioner sized on sensible heat alone leaves Houston cold and clammy.
    const houston = calculateLoad(house({ city: 'Houston, TX' }));
    const phoenix = calculateLoad(house({ city: 'Phoenix, AZ' }));

    const houstonLatentShare = houston.coolingLatent / houston.coolingTotal;
    const phoenixLatentShare = phoenix.coolingLatent / phoenix.coolingTotal;

    expect(houstonLatentShare).toBeGreaterThan(phoenixLatentShare);
  });

  it('makes better insulation reduce the load', () => {
    const poor = house();
    poor.hvac.envelope.wallAssemblyId = 'wall-2x4-r13';
    poor.hvac.envelope.roofAssemblyId = 'roof-r30';

    const good = house();
    good.hvac.envelope.wallAssemblyId = 'wall-double-r38';
    good.hvac.envelope.roofAssemblyId = 'roof-r60';

    expect(calculateLoad(good).heatingTotal).toBeLessThan(calculateLoad(poor).heatingTotal);
  });

  it('makes a leaky house cost more to heat than a tight one', () => {
    const tight = house();
    tight.hvac.envelope.infiltrationId = 'tight';
    const leaky = house();
    leaky.hvac.envelope.infiltrationId = 'very-leaky';

    const tightLoad = calculateLoad(tight);
    const leakyLoad = calculateLoad(leaky);

    // Infiltration is kept per room, so sum it to see the term move on its own
    // rather than only seeing the total move and assuming why.
    const infiltration = (load: typeof tightLoad): number =>
      load.rooms.reduce((sum, room) => sum + room.heatingInfiltration, 0);

    expect(infiltration(leakyLoad)).toBeGreaterThan(infiltration(tightLoad) * 2);
    expect(leakyLoad.heatingTotal).toBeGreaterThan(tightLoad.heatingTotal * 1.3);
  });

  it('ignores windows for heating that it counts for cooling', () => {
    // Heating is the coldest hour of the year, at night: no sun. Cooling is a
    // summer afternoon. Glass therefore behaves completely differently in the
    // two calculations, and a version that used one number for both is wrong.
    const withGlass = calculateLoad(house({ windows: true }));
    const without = calculateLoad(house({ windows: false }));

    expect(withGlass.rooms[0]!.coolingSolar).toBeGreaterThan(0);
    expect(without.rooms[0]!.coolingSolar).toBe(0);
  });

  it('scales with the size of the building', () => {
    const small = calculateLoad(house({ width: 8, depth: 6 }));
    const large = calculateLoad(house({ width: 16, depth: 12 }));

    expect(large.heatingTotal).toBeGreaterThan(small.heatingTotal);
    expect(large.floorArea).toBeGreaterThan(small.floorArea * 3);
  });

  it('says out loud that the envelope is an assumption', () => {
    const load = calculateLoad(house());
    expect(load.assumptions.join(' ')).toMatch(/default/i);

    const confirmed = house();
    confirmed.hvac.envelope.confirmed = true;
    expect(calculateLoad(confirmed).assumptions.join(' ')).not.toMatch(/still the app/i);
  });

  it('keeps every term separately so a wrong figure can be traced', () => {
    const room = calculateLoad(house()).rooms[0]!;
    const sum =
      room.heatingWalls +
      room.heatingWindows +
      room.heatingDoors +
      room.heatingRoof +
      room.heatingFloor +
      room.heatingInfiltration;

    expect(room.heatingTotal).toBeCloseTo(sum, 6);
  });
});
