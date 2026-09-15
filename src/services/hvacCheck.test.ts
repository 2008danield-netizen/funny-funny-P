/**
 * Tests for the HVAC and envelope checks.
 *
 * A checker is only worth having if it fires on the things that are actually
 * wrong and stays quiet on the things that are not, so these are all built the
 * same way: make a building that has a specific defect, and assert the finding
 * that names it — and then make one that does not, and assert it passes.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultDocument } from '@/state/defaults';
import { addOpening, addRectangle, normalizePlan } from '@/state/planOps';
import { findRegions } from '@/scene/planGraph';
import { calculateLoad } from './manualJ';
import { selectSystem } from './manualS';
import { routeDucts } from './ducts';
import { checkHvac, type HvacFinding } from './hvacCheck';
import type { DesignDocument, HvacSystemKind } from '@/state/types';

function house(city = 'Chicago, IL'): DesignDocument {
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
  doc.hvac.system = 'forced-air';
  doc.hvac.envelope.confirmed = true;
  return doc;
}

function report(doc: DesignDocument, system: HvacSystemKind = 'forced-air') {
  doc.hvac.system = system;
  const load = calculateLoad(doc);
  const selection = selectSystem(load, system);
  const layout = routeDucts(doc, load, selection);
  doc.hvac.ducts = layout.ducts;
  doc.hvac.registers = layout.registers;
  doc.hvac.airHandler = layout.airHandler;
  return checkHvac(doc, load, selection);
}

const find = (findings: HvacFinding[], id: string): HvacFinding | undefined =>
  findings.find((finding) => finding.id === id);

describe('the envelope check', () => {
  it('fails a wall below the zone minimum, and cites the table', () => {
    const doc = house('Minneapolis, MN'); // Zone 6
    doc.hvac.envelope.wallAssemblyId = 'wall-2x4-r13';

    const wall = find(report(doc).findings, 'envelope-wall')!;
    expect(wall.severity).toBe('violation');
    expect(wall.section).toBe('R402.1.3');
    expect(wall.detail).toContain('R-13');
  });

  it('passes the same wall where the code allows it', () => {
    // Zone 2. The identical assembly is compliant, which is the whole point of
    // checking against the zone rather than against a single number.
    const doc = house('Houston, TX');
    doc.hvac.envelope.wallAssemblyId = 'wall-2x4-r13';

    expect(find(report(doc).findings, 'envelope-wall')!.severity).toBe('pass');
  });

  it('measures the code against the nominal R and the load against the effective R', () => {
    // The thermal bridge. R-21 batts in a 2x6 wall are about R-16.5 as built,
    // and using one number for both would either fail compliant walls or
    // undersize the heating.
    const doc = house('Chicago, IL');
    doc.hvac.envelope.wallAssemblyId = 'wall-2x6-r21';

    const wall = find(report(doc).findings, 'envelope-wall')!;
    expect(wall.detail).toContain('R-21');
    expect(wall.detail).toMatch(/16\.5/);
  });

  it('checks a slab against the slab row, not the floor row', () => {
    const doc = house('Chicago, IL');
    doc.hvac.envelope.floorAssemblyId = 'floor-slab';

    const findings = report(doc).findings;
    expect(find(findings, 'envelope-slab')).toBeDefined();
    expect(find(findings, 'envelope-floor')).toBeUndefined();
  });

  it('fails single glazing everywhere', () => {
    const doc = house('Miami, FL');
    doc.hvac.envelope.glazingId = 'single';

    const window = find(report(doc).findings, 'envelope-window-u')!;
    expect(window.severity).toBe('violation');
    // And names a window you could actually order.
    expect(window.remedy).toMatch(/low-e|triple|double/i);
  });

  it('only applies the solar gain limit in the hot zones', () => {
    const hot = house('Phoenix, AZ');
    hot.hvac.envelope.glazingId = 'double-clear'; // SHGC 0.6
    expect(find(report(hot).findings, 'envelope-window-shgc')).toBeDefined();

    // In a cold climate the sun through the glass is free heat, and the code
    // does not cap it.
    const cold = house('Minneapolis, MN');
    cold.hvac.envelope.glazingId = 'double-clear';
    expect(find(report(cold).findings, 'envelope-window-shgc')).toBeUndefined();
  });

  it('warns about leakage as a caution rather than a violation', () => {
    // The conversion from natural air changes to a blower-door reading is an
    // estimate. Only the test settles it, so this must never be a violation.
    const doc = house('Chicago, IL');
    doc.hvac.envelope.infiltrationId = 'leaky';

    const leakage = find(report(doc).findings, 'envelope-leakage')!;
    expect(leakage.severity).toBe('caution');
    expect(leakage.detail).toMatch(/approximate/i);
  });

  it('says loudly when the envelope is still the defaults', () => {
    const doc = house();
    doc.hvac.envelope.confirmed = false;

    const unconfirmed = find(report(doc).findings, 'envelope-unconfirmed')!;
    expect(unconfirmed.severity).toBe('caution');
    // Guidance, not code — so no section, and the UI prints it as such.
    expect(unconfirmed.section).toBe('');
  });
});

describe('the equipment check', () => {
  it('refuses to check anything without a design location', () => {
    const doc = house();
    doc.hvac.locationKey = '';

    const result = report(doc);
    expect(result.compliant).toBe(false);
    expect(find(result.findings, 'hvac-no-location')).toBeDefined();
  });

  it('passes correctly sized equipment', () => {
    const findings = report(house()).findings;
    const cooling = find(findings, 'equipment-cooling');
    if (cooling) expect(cooling.severity).toBe('pass');
  });

  it('calls out oversized cooling as a violation, not a nag', () => {
    // The single most common real defect, and the one that makes a house feel
    // worse rather than merely cost more.
    const doc = house();
    doc.hvac.system = 'forced-air';
    doc.hvac.equipmentManual = true;
    doc.hvac.coolingEquipmentId = 'ac-5';

    const load = calculateLoad(doc);
    const selection = selectSystem(load, 'forced-air', {
      heatingEquipmentId: null,
      coolingEquipmentId: 'ac-5',
    });
    const findings = checkHvac(doc, load, selection).findings;

    const oversized = find(findings, 'equipment-cooling-oversized')!;
    expect(oversized.severity).toBe('violation');
    expect(oversized.detail).toMatch(/clammy|moisture|humidity/i);
  });

  it('reports the balance point and the backup for a heat pump', () => {
    const findings = report(house('Minneapolis, MN'), 'heat-pump').findings;
    const balance = find(findings, 'equipment-balance-point')!;

    expect(balance.title).toMatch(/backup heat needed below/i);
    expect(balance.remedy).toMatch(/kW/);
  });

  it('says a heat pump in a mild climate needs no backup at all', () => {
    const findings = report(house('Miami, FL'), 'heat-pump').findings;
    const balance = find(findings, 'equipment-balance-point')!;

    expect(balance.severity).toBe('pass');
    expect(balance.title).toMatch(/no backup/i);
  });
});

describe('the duct check', () => {
  it('passes a routed system', () => {
    const findings = report(house()).findings;
    expect(find(findings, 'ducts-unserved')).toBeUndefined();
    expect(find(findings, 'ducts-return-missing')).toBeUndefined();
  });

  it('catches a storey with supply air and no return', () => {
    const doc = house();
    const load = calculateLoad(doc);
    const selection = selectSystem(load, 'forced-air');
    const layout = routeDucts(doc, load, selection);

    doc.hvac.ducts = layout.ducts;
    doc.hvac.airHandler = layout.airHandler;
    doc.hvac.registers = layout.registers.filter((register) => register.system !== 'return');

    const missing = find(checkHvac(doc, load, selection).findings, 'ducts-return-missing')!;
    expect(missing.severity).toBe('violation');
  });

  it('catches a room left without a supply', () => {
    const doc = house();
    const load = calculateLoad(doc);
    const selection = selectSystem(load, 'forced-air');
    const layout = routeDucts(doc, load, selection);

    doc.hvac.ducts = layout.ducts;
    doc.hvac.airHandler = layout.airHandler;
    doc.hvac.registers = layout.registers.filter((register) => register.system !== 'supply');

    expect(find(checkHvac(doc, load, selection).findings, 'ducts-unserved')!.severity).toBe(
      'violation',
    );
  });

  it('always names the duct loss it does not model', () => {
    // In a hot climate with ducts in a loft this is 15–25% of the cooling load,
    // and the app cannot see it. Staying silent about that would be dishonest.
    const findings = report(house('Phoenix, AZ')).findings;
    expect(find(findings, 'ducts-unconditioned')).toBeDefined();
  });

  it('says nothing about ducts for a system that has none', () => {
    const findings = report(house(), 'hydronic').findings;
    expect(findings.filter((finding) => finding.system === 'ducts')).toHaveLength(0);
  });
});

describe('the citations', () => {
  it('never prints an authority without a section, or the reverse', () => {
    /*
     * The bug this exists for: the panel used to infer which book a section
     * was in from the shape of the string, and printed "IECC IRC M1505.4" on
     * the ventilation finding. A citation that is visibly wrong is worse than
     * no citation, because it teaches the reader to distrust the ones that are
     * right — so the finding carries its own authority and this pins the two
     * together.
     */
    const findings = report(house()).findings;
    expect(findings.length).toBeGreaterThan(0);

    for (const finding of findings) {
      if (finding.authority === 'none') {
        expect(finding.section).toBe('');
      } else {
        expect(finding.section).not.toBe('');
      }
    }
  });

  it('cites the ventilation rule to the IRC, not the energy code', () => {
    const doc = house();
    doc.hvac.envelope.infiltrationId = 'tight';

    const ventilation = find(report(doc).findings, 'ventilation-required')!;
    expect(ventilation.authority).toBe('IRC');
  });

  it('never repeats the book inside the section', () => {
    // "IRC IRC M1505.4" is what happens when the section carries the authority
    // as well as the field that exists for it.
    for (const finding of report(house()).findings) {
      if (finding.authority === 'none') continue;
      expect(finding.section.startsWith(finding.authority)).toBe(false);
    }
  });

  it('cites the sizing windows to ACCA, which is a method rather than a law', () => {
    const findings = report(house()).findings;
    for (const finding of findings) {
      if (finding.section.startsWith('Manual')) expect(finding.authority).toBe('ACCA');
    }
  });

  it('cites the envelope minimums to the IECC, which is law where adopted', () => {
    const wall = find(report(house('Minneapolis, MN')).findings, 'envelope-wall')!;
    expect(wall.authority).toBe('IECC');
  });
});

describe('the ventilation check', () => {
  it('asks for outdoor air, and insists on it in a tight house', () => {
    const doc = house();
    doc.hvac.envelope.infiltrationId = 'tight';

    const ventilation = find(report(doc).findings, 'ventilation-required')!;
    expect(ventilation.severity).toBe('caution');
    expect(ventilation.detail).toMatch(/does not ventilate itself/i);
  });
});
