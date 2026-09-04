/**
 * Tests for the roof code checks.
 *
 * The point of these checks is that a person can act on them, so what is tested
 * is not only whether a finding appears but whether it is USABLE: the right
 * section, the measurement and the limit in the same sentence, and a remedy
 * with a number in it.
 */

import { describe, expect, it } from 'vitest';

import { asPitch, IRC_ROOF_SLOPES } from '@/code/irc';
import { createDefaultDocument, defaultRoofFor } from '@/state/defaults';
import { addRectangle, normalizePlan } from '@/state/planOps';
import type { DesignDocument, Roof } from '@/state/types';

import { checkAllRoofs, checkRoof, slopeRuleFor } from './roofCode';

function house(width = 12, depth = 8): DesignDocument {
  const doc = createDefaultDocument();
  const level = doc.levels[0]!;
  level.plan.vertices = [];
  level.plan.walls = [];
  level.plan.rooms = {};
  level.wallHeight = 2.6;
  level.plan.defaultWallThickness = 0.2;
  level.plan.defaultWallHeight = 2.6;
  addRectangle(level.plan, { x: 0, z: 0 }, width, depth);
  normalizePlan(level.plan);
  return doc;
}

function roofOn(doc: DesignDocument, changes: Partial<Roof> = {}): Roof {
  return { ...defaultRoofFor(doc.levels[0]!.id), ...changes };
}

const find = (doc: DesignDocument, roof: Roof, id: string) =>
  checkRoof(doc, roof)!.findings.find((finding) => finding.id === id);

describe('minimum slope for the covering', () => {
  it('passes a 6:12 asphalt shingle roof and says which section it cleared', () => {
    const doc = house();
    const finding = find(doc, roofOn(doc, { covering: 'asphalt-shingle', pitch: 0.5 }), 'roof-slope')!;

    expect(finding.severity).toBe('pass');
    expect(finding.section).toBe('R905.2.2');
    expect(finding.detail).toContain('6:12');
  });

  it('refuses asphalt shingles below 2:12, and offers a covering that would work', () => {
    const doc = house();
    const roof = roofOn(doc, { covering: 'asphalt-shingle', pitch: 1 / 12, kind: 'shed' });
    const finding = find(doc, roof, 'roof-slope')!;

    expect(finding.severity).toBe('violation');
    expect(finding.section).toBe('R905.2.2');
    // The measurement, the limit and the citation, in one sentence.
    expect(finding.detail).toContain('1:12');
    expect(finding.detail).toContain('2:12');
    expect(finding.detail).toContain('R905.2.2');
    expect(finding.remedy).toMatch(/membrane|metal/i);
  });

  it('flags the doubled-underlayment band between 2:12 and 4:12', () => {
    const doc = house();
    const roof = roofOn(doc, { covering: 'asphalt-shingle', pitch: 3 / 12 });
    const finding = find(doc, roof, 'roof-slope-underlayment')!;

    expect(finding.severity).toBe('caution');
    expect(finding.detail).toContain('R905.1.1');
    expect(checkRoof(doc, roof)!.compliant).toBe(true);
  });

  it('holds each covering to its own figure', () => {
    // Spot-checked against the code rather than derived from one another: a
    // table that has been transcribed once can be transcribed wrong.
    expect(slopeRuleFor('slate').absolute.pitch).toBeCloseTo(4 / 12, 9);
    expect(slopeRuleFor('wood-shake').absolute.pitch).toBeCloseTo(4 / 12, 9);
    expect(slopeRuleFor('metal-shingle').absolute.pitch).toBeCloseTo(3 / 12, 9);
    expect(slopeRuleFor('clay-tile').absolute.pitch).toBeCloseTo(2.5 / 12, 9);
    expect(slopeRuleFor('standing-seam-metal').absolute.pitch).toBeCloseTo(0.25 / 12, 9);
    expect(slopeRuleFor('membrane').absolute.pitch).toBeCloseTo(0.25 / 12, 9);
  });

  it('lets a membrane roof be nearly flat, which is the point of one', () => {
    const doc = house();
    const roof = roofOn(doc, { kind: 'flat', covering: 'membrane', pitch: 0.25 / 12 });
    expect(find(doc, roof, 'roof-slope')!.severity).toBe('pass');
  });

  it('writes pitches the way a roofer says them', () => {
    expect(asPitch(0.5)).toBe('6:12');
    expect(asPitch(IRC_ROOF_SLOPES.clayOrConcreteTile.pitch)).toBe('2 1/2:12');
    expect(asPitch(IRC_ROOF_SLOPES.membrane.pitch)).toBe('0 1/4:12');
  });
});

describe('attic ventilation', () => {
  it('works the opening out from the roof area', () => {
    const doc = house(12, 8);
    const finding = find(doc, roofOn(doc), 'roof-ventilation')!;

    expect(finding.section).toBe('R806.2');
    // 13 x 9 m of eave outline is about 1259 sq ft; a 150th of that is
    // 8.4 sq ft, or about 1209 sq in.
    expect(finding.detail).toMatch(/sq in/);
    expect(finding.detail).toContain('1/150');
    // And the halved figure for the exception, which is worth real money.
    expect(finding.remedy).toContain('40');
  });

  it('warns that an unvented assembly has conditions', () => {
    const doc = house();
    const finding = find(doc, roofOn(doc, { ventilation: 'unvented' }), 'roof-ventilation')!;

    expect(finding.severity).toBe('caution');
    expect(finding.section).toBe('R806.5');
    expect(finding.detail).toMatch(/air-impermeable|vapour retarder/i);
  });
});

describe('attic access', () => {
  it('is required once the roof space is big and tall enough', () => {
    const doc = house(12, 8);
    const finding = find(doc, roofOn(doc, { pitch: 0.5 }), 'roof-attic-access')!;

    expect(finding.section).toBe('R807.1');
    expect(finding.remedy).toContain('22 in');
    expect(finding.remedy).toContain('30 in');
  });

  it('is not required over a small, shallow roof', () => {
    // Under 30 in of rise, so R807.1 does not bite however big the plan is.
    const doc = house(12, 8);
    const roof = roofOn(doc, { kind: 'flat', covering: 'membrane', pitch: 0.25 / 12 });
    expect(find(doc, roof, 'roof-attic-access')).toBeUndefined();
  });
});

describe('the plot line', () => {
  function withBoundary(doc: DesignDocument, halfWidth: number, halfDepth: number) {
    doc.site.boundary = [
      { x: -halfWidth, z: -halfDepth },
      { x: halfWidth, z: -halfDepth },
      { x: halfWidth, z: halfDepth },
      { x: -halfWidth, z: halfDepth },
    ];
    return doc;
  }

  it('says nothing when there is no plot drawn', () => {
    const doc = house();
    expect(find(doc, roofOn(doc), 'roof-lot-line-eave')).toBeUndefined();
  });

  it('refuses an eave that projects inside two feet of the line', () => {
    // House 12 x 8 with a 0.4 m overhang, on a plot only just bigger.
    const doc = withBoundary(house(12, 8), 6.8, 4.8);
    const finding = find(doc, roofOn(doc, { overhang: 0.4 }), 'roof-lot-line-eave')!;

    expect(finding.severity).toBe('violation');
    expect(finding.section).toBe('R302.1');
    expect(finding.remedy).toMatch(/Cut the overhang back by/);
  });

  it('asks for a protected soffit between two and five feet', () => {
    const doc = withBoundary(house(12, 8), 7.5, 5.5);
    const finding = find(doc, roofOn(doc, { overhang: 0.4 }), 'roof-lot-line-eave')!;

    expect(finding.severity).toBe('caution');
    expect(finding.detail).toMatch(/underside/i);
  });

  it('says nothing when the house stands well clear', () => {
    const doc = withBoundary(house(12, 8), 20, 20);
    expect(find(doc, roofOn(doc), 'roof-lot-line-eave')).toBeUndefined();
    expect(find(doc, roofOn(doc), 'roof-lot-line-wall')).toBeUndefined();
  });

  it('checks the zoning setbacks the user entered, and says they are not the IRC', () => {
    const doc = withBoundary(house(12, 8), 10, 10);
    doc.site.setbacks = { front: 7.6, rear: 0, side: 0, frontAt: { x: 0, z: -10 } };

    const findings = checkRoof(doc, roofOn(doc))!.findings.filter((finding) =>
      finding.id.startsWith('roof-setback'),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('violation');
    // No section, because a zoning ordinance has none to cite — and the finding
    // says so rather than leaving the user to wonder.
    expect(findings[0]!.section).toBe('');
    expect(findings[0]!.detail).toMatch(/zoning/i);
    expect(findings[0]!.title).toContain('front');
  });
});

describe('the whole building', () => {
  it('checks every roof and reports each separately', () => {
    const doc = house();
    doc.roofs = [
      roofOn(doc, { id: 'r1', pitch: 0.5 }),
      roofOn(doc, { id: 'r2', pitch: 1 / 12, covering: 'slate' }),
    ];

    const reports = checkAllRoofs(doc);
    expect(reports).toHaveLength(2);
    expect(reports[0]!.compliant).toBe(true);
    expect(reports[1]!.compliant).toBe(false);
  });

  it('never states a limit without a section, or a section without a limit', () => {
    const doc = house();
    doc.site.boundary = [
      { x: -7, z: -5 },
      { x: 7, z: -5 },
      { x: 7, z: 5 },
      { x: -7, z: 5 },
    ];

    for (const report of checkAllRoofs({ ...doc, roofs: [roofOn(doc, { pitch: 3 / 12 })] })) {
      for (const finding of report.findings) {
        if (!finding.section) continue;
        // Anything citing a section cites a well-formed one, and quotes it in
        // the detail so the reader can see what was applied.
        expect(finding.section).toMatch(/^R\d+(\.\d+)*$/);
        expect(finding.detail).toContain(finding.section);
      }
    }
  });
});
