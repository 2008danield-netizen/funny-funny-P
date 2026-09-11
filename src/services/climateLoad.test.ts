/**
 * Tests for where the electrical service calculation gets its climate load.
 *
 * The point of this module is that there is exactly ONE answer to "how big is
 * the heating", so most of these are about precedence rather than arithmetic.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, normalizePlan } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import { climateLoadVa } from './climateLoad';
import { calculateLoad } from './circuits';
import type { DesignDocument } from '@/state/types';

function house(city = ''): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};

  addRectangle(level.plan, { x: 0, z: 0 }, 12, 8);
  normalizePlan(level.plan);

  for (const region of findRegions(level.plan)) {
    level.plan.rooms[region.key] = {
      name: 'Living Room',
      floor: { presetId: 'oak-plank', color: '#ffffff', textureScale: 1 },
      wall: { color: '#ece7df', roughness: 0.88 },
      ceilingColor: '#f7f5f2',
    };
  }

  for (const wall of level.plan.walls.slice(0, 4)) {
    addOpening(level.plan, wall.id, 'window', 'window-casement', { width: 1.5, height: 1.4, sillHeight: 0.9 }, 2);
  }

  doc.hvac.locationKey = city;
  return doc;
}

describe('the climate load for NEC 220.82(C)', () => {
  it('is nothing at all when neither source has anything', () => {
    const climate = climateLoadVa(house());
    expect(climate.va).toBe(0);
    expect(climate.source).toBe('none');
  });

  it('uses the typed-in figure while there is no design location', () => {
    const doc = house();
    doc.electrical.heatingVa = 9000;
    doc.electrical.coolingVa = 4000;

    const climate = climateLoadVa(doc);
    expect(climate.va).toBe(9000);
    expect(climate.source).toBe('entered');
  });

  it('prefers the load calculation once there is one', () => {
    // Two live sources for one fact is how a service ends up sized for
    // equipment nobody is installing.
    const doc = house('Chicago, IL');
    doc.hvac.system = 'forced-air';
    doc.electrical.heatingVa = 99000; // Deliberately absurd.

    const climate = climateLoadVa(doc);
    expect(climate.source).toBe('derived');
    expect(climate.va).toBeLessThan(20000);
    expect(climate.working).toMatch(/Manual J|backup/);
  });

  it('takes the larger of heating and cooling, not the sum', () => {
    // 220.82(C) adds one or the other, because they never run together — on a
    // split system, at least.
    const doc = house('Phoenix, AZ');
    doc.hvac.system = 'forced-air';

    const climate = climateLoadVa(doc);
    expect(climate.label).toMatch(/larger of the two/);
    // Phoenix: cooling wins, and an air conditioner draws far more than a
    // furnace's blower.
    expect(climate.label).toMatch(/^Cooling/);
  });

  it('adds a heat pump’s backup heat to its compressor rather than comparing them', () => {
    /*
     * The one case where two things genuinely do run at the same time. Below
     * the balance point the compressor is still working flat out and the strip
     * heat makes up the difference, so they add — and this is exactly why a
     * cold-climate heat pump lands a house on a bigger service than it expected.
     */
    const cold = house('Minneapolis, MN');
    cold.hvac.system = 'heat-pump';

    const mild = house('Miami, FL');
    mild.hvac.system = 'heat-pump';

    const coldLoad = climateLoadVa(cold);
    const mildLoad = climateLoadVa(mild);

    expect(coldLoad.working).toMatch(/backup heat/);
    expect(coldLoad.va).toBeGreaterThan(mildLoad.va);
    // And the mild one has no backup at all, so it is just the compressor.
    expect(mildLoad.working).not.toMatch(/backup/);
  });

  it('counts one machine once for a heat pump', () => {
    // A heat pump is one condenser on one set of wires. Adding the heating and
    // cooling figures would inflate the service by a whole unit.
    const doc = house('Miami, FL');
    doc.hvac.system = 'heat-pump';

    const climate = climateLoadVa(doc);
    expect(climate.va).toBeLessThan(8000);
  });

  it('falls back to the typed figure for a load-only study', () => {
    const doc = house('Chicago, IL');
    doc.hvac.system = 'load-only';
    doc.electrical.heatingVa = 9000;

    const climate = climateLoadVa(doc);
    expect(climate.source).toBe('entered');
    expect(climate.va).toBe(9000);
  });
});

describe('the service calculation', () => {
  it('grows when the climate load appears', () => {
    const without = calculateLoad(house());
    const withHvac = house('Minneapolis, MN');
    withHvac.hvac.system = 'forced-air';

    expect(calculateLoad(withHvac).demandVa).toBeGreaterThan(without.demandVa);
  });

  it('stops complaining about a missing climate load once it has one', () => {
    const bare = calculateLoad(house());
    expect(bare.gaps.join(' ')).toMatch(/heating or cooling/i);

    const doc = house('Chicago, IL');
    doc.hvac.system = 'forced-air';
    expect(calculateLoad(doc).gaps.join(' ')).not.toMatch(/heating or cooling/i);
  });

  it('keeps the climate load out of the demand-factor subtotal', () => {
    // 220.82(C) is added at full value AFTER the demand factor, so folding it
    // into the connected load would discount it by 60 percent.
    const doc = house('Chicago, IL');
    doc.hvac.system = 'forced-air';
    const load = calculateLoad(doc);

    const lineTotal = load.lines.reduce((sum, line) => sum + line.va, 0);
    expect(lineTotal).toBeCloseTo(load.connectedVa, 6);
    expect(load.demandVa).toBeGreaterThan(load.climate.va);
  });
});
