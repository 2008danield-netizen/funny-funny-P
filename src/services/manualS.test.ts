/**
 * Manual S selection, tested against the failure it exists to prevent.
 *
 * The load is synthesised rather than calculated from a document. Selection
 * takes a `BuildingLoad` and nothing else, so feeding it one directly tests the
 * selection rules in isolation — a change to the load calculation should not be
 * able to break these, and vice versa.
 */

import { describe, expect, it } from 'vitest';
import { balancePointOf, selectSystem } from './manualS';
import { btuToWatts, findConditions, getEquipment, SIZING_LIMITS } from '@/code/acca';
import type { BuildingLoad, RoomLoad } from './manualJ';

function room(heatingWatts: number, sensibleWatts: number): RoomLoad {
  return {
    levelId: 'l1',
    levelName: 'Ground floor',
    roomKey: 'r1',
    roomName: 'Living',
    area: 40,
    volume: 100,
    heatingWalls: heatingWatts,
    heatingWindows: 0,
    heatingDoors: 0,
    heatingRoof: 0,
    heatingFloor: 0,
    heatingInfiltration: 0,
    heatingTotal: heatingWatts,
    coolingWalls: sensibleWatts,
    coolingWindows: 0,
    coolingSolar: 0,
    coolingRoof: 0,
    coolingInfiltration: 0,
    coolingInternal: 0,
    coolingSensible: sensibleWatts,
    coolingLatent: 0,
    coolingTotal: sensibleWatts,
  };
}

/** A building whose loads are stated in BTU/h, which is how equipment is sold. */
function load(options: {
  heatingBtu: number;
  sensibleBtu: number;
  latentBtu?: number;
  city?: string;
  floorArea?: number;
}): BuildingLoad {
  const latentBtu = options.latentBtu ?? 0;
  return {
    conditions: findConditions(options.city ?? 'Chicago, IL'),
    rooms: [room(btuToWatts(options.heatingBtu), btuToWatts(options.sensibleBtu))],
    heatingTotal: btuToWatts(options.heatingBtu),
    coolingSensible: btuToWatts(options.sensibleBtu),
    coolingLatent: btuToWatts(latentBtu),
    coolingTotal: btuToWatts(options.sensibleBtu + latentBtu),
    floorArea: options.floorArea ?? 180,
    bedrooms: 3,
    assumptions: [],
  };
}

describe('Manual S equipment selection', () => {
  it('never picks an air conditioner more than 115% of the cooling load', () => {
    // The whole reason this file exists. Walk a range of loads and assert that
    // the selection is never allowed to round up into short-cycling territory,
    // because that is what "just fit the next size up" produces.
    for (let btu = 18000; btu <= 55000; btu += 1000) {
      const selection = selectSystem(load({ heatingBtu: 50000, sensibleBtu: btu }), 'forced-air');
      const cooling = selection.cooling;
      expect(cooling).not.toBeNull();

      if (cooling!.withinLimits) {
        expect(cooling!.fraction).toBeLessThanOrEqual(SIZING_LIMITS.cooling.maxFraction + 1e-9);
        expect(cooling!.fraction).toBeGreaterThanOrEqual(SIZING_LIMITS.cooling.minFraction - 1e-9);
      }
    }
  });

  it('says so rather than lying when no unit fits the window', () => {
    // A tiny load. The smallest air conditioner made is 1.5 ton, which is more
    // than double this — a real situation in a well-built flat, and the honest
    // answer is "this is oversized and here is by how much", not a silent pick.
    const selection = selectSystem(load({ heatingBtu: 12000, sensibleBtu: 7000 }), 'forced-air');

    expect(selection.cooling!.withinLimits).toBe(false);
    expect(selection.cooling!.fraction).toBeGreaterThan(SIZING_LIMITS.cooling.maxFraction);
    expect(selection.cooling!.reason).toContain('90–115%');
  });

  it('sizes a furnace at or above the load but under the 140% ceiling', () => {
    const selection = selectSystem(load({ heatingBtu: 55000, sensibleBtu: 30000 }), 'forced-air');
    const heating = selection.heating!;

    expect(heating.providedBtu).toBeGreaterThanOrEqual(heating.requiredBtu);
    expect(heating.fraction).toBeLessThanOrEqual(SIZING_LIMITS.heating.maxFraction);
    expect(heating.model.kind).toBe('furnace');
  });

  it('sizes a heat pump on cooling, not on heating', () => {
    // Chicago: a heating load far larger than the cooling load. Sizing on
    // heating would buy a 5 ton machine for a 2 ton summer, which is the
    // oversizing trap wearing a different hat.
    const selection = selectSystem(load({ heatingBtu: 60000, sensibleBtu: 24000 }), 'heat-pump');

    expect(selection.heating!.model.id).toBe(selection.cooling!.model.id);
    expect(selection.cooling!.fraction).toBeLessThanOrEqual(SIZING_LIMITS.cooling.maxFraction);
    expect(selection.heating!.providedBtu).toBeLessThan(selection.heating!.requiredBtu);
  });

  it('counts a heat pump’s electrical load once, not twice', () => {
    // One machine, one condenser, one set of wires. Adding both figures would
    // inflate the electrical service by a whole unit.
    const selection = selectSystem(load({ heatingBtu: 60000, sensibleBtu: 24000 }), 'heat-pump');
    expect(selection.coolingWatts).toBe(0);
    expect(selection.heatingWatts).toBeGreaterThan(0);

    const split = selectSystem(load({ heatingBtu: 60000, sensibleBtu: 24000 }), 'forced-air');
    expect(split.coolingWatts).toBeGreaterThan(0);
    expect(split.heatingWatts).toBeGreaterThan(0);
  });

  it('finds a balance point between the two rated points', () => {
    const pump = getEquipment('hp-3')!;
    const chicago = findConditions('Chicago, IL')!;
    const point = balancePointOf(pump, 60000, chicago);

    // A 3 ton pump against a 60,000 BTU/h Chicago load cannot possibly carry
    // the design day; the balance point has to land well above it.
    expect(point.outdoorF).toBeGreaterThan(chicago.winterDryBulb);
    expect(point.supplementalBtu).toBeGreaterThan(0);
    expect(point.coversDesignDay).toBe(false);
    expect(point.supplementalKw).toBeCloseTo(point.supplementalBtu / 3412, 6);
  });

  it('needs no backup heat when the pump covers the design day', () => {
    // Miami: a 3 ton pump against a small heating load. Capacity at 50°F is
    // far above what the building needs, so the balance point falls below the
    // design temperature and the answer is "none", not "some small number".
    const miami = findConditions('Miami, FL')!;
    const point = balancePointOf(getEquipment('hp-3')!, 12000, miami);

    expect(point.outdoorF).toBeLessThan(miami.winterDryBulb);
    expect(point.supplementalBtu).toBe(0);
    expect(point.coversDesignDay).toBe(true);
  });

  it('puts the balance point where capacity and load actually cross', () => {
    // Checked against the definition rather than against the implementation:
    // at the balance point the pump's output equals the building's load.
    const pump = getEquipment('hp-3')!;
    const chicago = findConditions('Chicago, IL')!;
    const designLoad = 60000;
    const point = balancePointOf(pump, designLoad, chicago);

    const slope = (pump.heatingBtu - pump.capacityAt17F!) / 30;
    const capacityThere = pump.capacityAt17F! + (point.outdoorF - 17) * slope;
    const loadThere =
      (designLoad * (70 - point.outdoorF)) / (70 - chicago.winterDryBulb);

    expect(capacityThere).toBeCloseTo(loadThere, 3);
  });

  it('flags a coil that cannot keep up with the humidity', () => {
    // Miami, where the latent load is large. A unit chosen on total capacity
    // alone can be perfectly sized and still leave the house damp.
    const selection = selectSystem(
      load({ heatingBtu: 10000, sensibleBtu: 24000, latentBtu: 14000, city: 'Miami, FL' }),
      'forced-air',
    );

    expect(selection.latent).not.toBeNull();
    expect(selection.latent!.latentAdequate).toBe(false);
    expect(selection.notes.some((note) => note.includes('moisture'))).toBe(true);
  });

  it('selects nothing at all without a design location', () => {
    const nowhere = load({ heatingBtu: 50000, sensibleBtu: 30000 });
    nowhere.conditions = null;

    const selection = selectSystem(nowhere, 'forced-air');
    expect(selection.heating).toBeNull();
    expect(selection.cooling).toBeNull();
    expect(selection.notes[0]).toContain('No design location');
  });

  it('selects nothing for a load-only study, but still reports ventilation', () => {
    const selection = selectSystem(load({ heatingBtu: 50000, sensibleBtu: 30000 }), 'load-only');
    expect(selection.heating).toBeNull();
    expect(selection.cooling).toBeNull();
    expect(selection.ventilationCfm).toBeGreaterThan(0);
  });

  it('gives a hydronic system a boiler and no ducts', () => {
    const selection = selectSystem(load({ heatingBtu: 55000, sensibleBtu: 30000 }), 'hydronic');

    expect(selection.heating!.model.kind).toBe('boiler');
    expect(selection.cooling).toBeNull();
    expect(selection.supplyCfm).toBe(0);
  });

  it('derives airflow from the cooling capacity at 400 cfm per ton', () => {
    const selection = selectSystem(load({ heatingBtu: 50000, sensibleBtu: 33000 }), 'forced-air');
    const tons = selection.cooling!.model.coolingBtu / 12000;

    expect(selection.supplyCfm).toBeCloseTo(tons * 400, 6);
  });

  it('honours a hand-picked model over the automatic choice', () => {
    const selection = selectSystem(load({ heatingBtu: 55000, sensibleBtu: 30000 }), 'forced-air', {
      heatingEquipmentId: 'furnace-120',
      coolingEquipmentId: null,
    });

    expect(selection.heating!.model.id).toBe('furnace-120');
    // And it is still measured honestly: 120,000 BTU/h against a 55,000 load
    // is well past the ceiling, and the app says so rather than deferring.
    expect(selection.heating!.withinLimits).toBe(false);
  });

  it('scales ventilation with floor area and bedrooms', () => {
    const small = selectSystem(
      load({ heatingBtu: 30000, sensibleBtu: 20000, floorArea: 90 }),
      'forced-air',
    );
    const large = selectSystem(
      load({ heatingBtu: 60000, sensibleBtu: 40000, floorArea: 280 }),
      'forced-air',
    );

    expect(large.ventilationCfm).toBeGreaterThan(small.ventilationCfm);
  });
});
