/**
 * Checking the envelope against the energy code, and the system against ACCA.
 *
 * -----------------------------------------------------------------------------
 * TWO DIFFERENT KINDS OF AUTHORITY, KEPT APART.
 *
 * The IECC is law where it is adopted. Manual J, S and D are not law in
 * themselves — they are the methods the IRC points at (M1401.3), so a system
 * that departs from them is not illegal in the way an under-insulated wall is,
 * it is unjustifiable. That distinction matters to anybody reading these
 * findings, so it is carried in the `section` field: an IECC finding cites
 * R402-something, an ACCA finding cites the manual, and a finding with an
 * empty section is this app's own guidance and prints as such.
 *
 * -----------------------------------------------------------------------------
 * THE ENVELOPE CHECK MEASURES THE ASSEMBLY, NOT THE BATT.
 *
 * The code is written in terms of "R-20", and it is universally read as "put
 * R-20 batts in". Those are not the same thing. A 2x6 wall with R-21 batts is
 * about R-16.5 once the studs are counted — timber is roughly R-1.25 per inch
 * against the batt's R-3.7, and something like a quarter of a stud wall is
 * timber. That is the thermal bridge, and it is why the assemblies in
 * `iecc.ts` carry both figures.
 *
 * The load calculation uses the effective R, because that is the heat that
 * actually flows. The code check uses the nominal R, because that is what the
 * prescriptive table is written against and what an inspector reads off the
 * label. Using one number for both would either fail compliant walls or
 * undersize the heating, and the app would be wrong in one direction or the
 * other every time.
 *
 * -----------------------------------------------------------------------------
 * AND THE BIG ONE: NONE OF THIS IS APPROVAL.
 *
 * Passing every check here means the design is consistent with the figures it
 * was given. The figures start as assumptions, the design conditions are for a
 * city rather than an address, and nothing here has been near a plans examiner.
 */

import {
  AIR_LEAKAGE,
  DUCT_LEAKAGE,
  GLAZING,
  IECC_TABLE,
  airLeakageLimit,
  getAssembly,
  getGlazing,
  requirementForZone,
  DOOR_TYPES,
  FLOOR_ASSEMBLIES,
  ROOF_ASSEMBLIES,
  WALL_ASSEMBLIES,
} from '@/code/iecc';
import {
  INFILTRATION,
  INFILTRATION_SECTION,
  SIZING_LIMITS,
  VELOCITY_LIMITS,
  VENTILATION,
  wattsToBtu,
} from '@/code/acca';
import type { BuildingLoad } from './manualJ';
import type { SystemSelection } from './manualS';
import { sizeAllDucts, roomAirflows } from './ductSize';
import type { DesignDocument } from '@/state/types';

/* -------------------------------- Findings -------------------------------- */

export type HvacSeverity = 'violation' | 'caution' | 'advice' | 'pass';

export interface HvacFinding {
  id: string;
  severity: HvacSeverity;
  /** The section, or empty when the finding is this app's guidance. */
  section: string;
  title: string;
  detail: string;
  remedy: string;
  system: 'envelope' | 'load' | 'equipment' | 'ducts' | 'ventilation';
}

export interface HvacReport {
  findings: HvacFinding[];
  compliant: boolean;
  /** The zone everything was measured against, or empty with no location. */
  climateZone: string;
}

/**
 * How much a blower-door reading exceeds the natural air change rate.
 *
 * The code is written in ACH50 — air changes at 50 pascals, which is what a
 * blower door measures. The load calculation is in NATURAL air changes, which
 * is what the building does on an ordinary day. The two are related by roughly
 * a factor of twenty for a house of this size in a moderate climate; the
 * factor genuinely varies between about fifteen and twenty-five with height
 * and exposure.
 *
 * So this conversion is an estimate, and everything that depends on it is
 * reported as a caution rather than a violation. A blower-door test is the
 * only thing that settles it, and the code requires one anyway.
 */
const ACH50_PER_NATURAL = 20;

/* ---------------------------------- Run ----------------------------------- */

export function checkHvac(
  doc: DesignDocument,
  load: BuildingLoad,
  selection: SystemSelection,
): HvacReport {
  const findings: HvacFinding[] = [];

  if (!load.conditions) {
    findings.push({
      id: 'hvac-no-location',
      severity: 'caution',
      section: '',
      title: 'No design location chosen',
      detail:
        'Nothing can be sized without design conditions. There is deliberately no default, because a load calculated for the wrong climate looks exactly like an answer.',
      remedy: 'Choose the nearest city on the list in the HVAC panel.',
      system: 'load',
    });
    return { findings, compliant: false, climateZone: '' };
  }

  const zone = load.conditions.climateZone;

  checkEnvelope(doc, load, zone, findings);
  checkEquipment(load, selection, findings);
  checkDucts(doc, load, selection, findings);
  checkVentilation(doc, load, selection, findings);

  return {
    findings,
    compliant: !findings.some((finding) => finding.severity === 'violation'),
    climateZone: zone,
  };
}

/* -------------------------------- Envelope -------------------------------- */

function checkEnvelope(
  doc: DesignDocument,
  load: BuildingLoad,
  zone: string,
  findings: HvacFinding[],
): void {
  const spec = doc.hvac.envelope;

  if (!spec.confirmed) {
    findings.push({
      id: 'envelope-unconfirmed',
      severity: 'caution',
      section: '',
      title: 'The envelope is still the app’s defaults',
      detail:
        'Every insulation value, window type and leakage figure the load was calculated from is an assumption this app made, not something anybody measured. The load is only as good as they are, and a load built on six guesses is a different kind of number from one built on six measurements.',
      remedy: 'Open the envelope section, set what the building actually is, and tick it as confirmed.',
      system: 'envelope',
    });
  }

  const required = requirementForZone(zone);
  if (!required) {
    findings.push({
      id: 'envelope-no-zone',
      severity: 'advice',
      section: IECC_TABLE.section,
      title: `No prescriptive row for climate zone ${zone}`,
      detail: `${IECC_TABLE.edition} Table ${IECC_TABLE.section} does not list this zone, so the envelope has not been checked against it.`,
      remedy: 'Check the envelope against your local amendment by hand.',
      system: 'envelope',
    });
    return;
  }

  const wall = getAssembly(WALL_ASSEMBLIES, spec.wallAssemblyId) ?? WALL_ASSEMBLIES[2]!;
  const roof = getAssembly(ROOF_ASSEMBLIES, spec.roofAssemblyId) ?? ROOF_ASSEMBLIES[2]!;
  const floor = getAssembly(FLOOR_ASSEMBLIES, spec.floorAssemblyId) ?? FLOOR_ASSEMBLIES[0]!;
  const glazing = getGlazing(spec.glazingId) ?? null;
  const door = getGlazing(spec.doorId) ?? DOOR_TYPES[1]!;

  /*
   * Nominal against nominal. The prescriptive table is written in the R-value
   * printed on the packaging, so that is what it is measured against — and the
   * assembly's effective R, which is what the load used, is quoted alongside so
   * the difference is visible rather than hidden.
   */
  const insulation: Array<{
    id: string;
    name: string;
    nominal: number;
    effective: number;
    needed: number;
  }> = [
    { id: 'wall', name: 'Walls', nominal: wall.nominalR, effective: wall.effectiveR, needed: required.wall },
    { id: 'ceiling', name: 'Ceiling', nominal: roof.nominalR, effective: roof.effectiveR, needed: required.ceiling },
  ];

  // A slab is measured against the slab row, not the floor row. The two are
  // completely different requirements and swapping them fails compliant slabs.
  const isSlab = floor.id.startsWith('floor-slab');
  if (isSlab) {
    insulation.push({
      id: 'slab',
      name: 'Slab edge',
      nominal: floor.nominalR,
      effective: floor.effectiveR,
      needed: required.slab,
    });
  } else {
    insulation.push({
      id: 'floor',
      name: 'Floor',
      nominal: floor.nominalR,
      effective: floor.effectiveR,
      needed: required.floor,
    });
  }

  for (const item of insulation) {
    if (item.needed <= 0) continue;

    if (item.nominal + 0.001 < item.needed) {
      findings.push({
        id: `envelope-${item.id}`,
        severity: 'violation',
        section: IECC_TABLE.section,
        title: `${item.name} below the minimum for zone ${zone}`,
        detail: `R-${item.nominal} against the R-${item.needed} that ${IECC_TABLE.edition} Table ${IECC_TABLE.section} requires in zone ${zone}. The load was calculated on the assembly's effective R-${item.effective.toFixed(1)}, which is lower again once the framing is counted.`,
        remedy: `Specify at least R-${item.needed}${item.id === 'slab' ? ` down ${required.slabDepthFeet} ft of the slab edge` : ''}, or take the performance path with an energy model.`,
        system: 'envelope',
      });
    } else {
      findings.push({
        id: `envelope-${item.id}`,
        severity: 'pass',
        section: IECC_TABLE.section,
        title: `${item.name} meet zone ${zone}`,
        detail: `R-${item.nominal} against R-${item.needed} required. Effective R-${item.effective.toFixed(1)} once the framing is counted, which is the figure the load used.`,
        remedy: '',
        system: 'envelope',
      });
    }
  }

  /* ---- Windows, where the U-factor is the whole assembly ---- */

  if (glazing) {
    if (glazing.uFactor > required.window + 0.0001) {
      findings.push({
        id: 'envelope-window-u',
        severity: 'violation',
        section: IECC_TABLE.section,
        title: `Windows conduct more than zone ${zone} allows`,
        detail: `U-${glazing.uFactor.toFixed(2)} against the U-${required.window.toFixed(2)} maximum. That is the whole window including the frame, which is markedly worse than the centre-of-glass figure on the sticker.`,
        remedy: `Specify glazing at U-${required.window.toFixed(2)} or lower — ${betterGlazing(required.window)}.`,
        system: 'envelope',
      });
    } else {
      findings.push({
        id: 'envelope-window-u',
        severity: 'pass',
        section: IECC_TABLE.section,
        title: `Windows meet zone ${zone}`,
        detail: `U-${glazing.uFactor.toFixed(2)} against a U-${required.window.toFixed(2)} maximum.`,
        remedy: '',
        system: 'envelope',
      });
    }

    /*
     * The solar heat gain limit only exists in the hot zones, and it is the
     * opposite requirement from the U-factor: it caps how much SUN gets in,
     * which in a cold climate is free heat you want.
     */
    if (required.solarHeatGain !== null && glazing.solarHeatGain > required.solarHeatGain + 0.001) {
      findings.push({
        id: 'envelope-window-shgc',
        severity: 'violation',
        section: IECC_TABLE.section,
        title: `Windows let in more sun than zone ${zone} allows`,
        detail: `A solar heat gain coefficient of ${glazing.solarHeatGain.toFixed(2)} against a maximum of ${required.solarHeatGain.toFixed(2)}. In a hot climate the sun through the glass is usually the largest single cooling load in the house.`,
        remedy: 'Specify a low-solar-gain low-E coating, or shade the glass externally.',
        system: 'envelope',
      });
    }
  }

  if (door.uFactor > required.door + 0.0001) {
    findings.push({
      id: 'envelope-door-u',
      severity: 'violation',
      section: IECC_TABLE.section,
      title: `Doors conduct more than zone ${zone} allows`,
      detail: `U-${door.uFactor.toFixed(2)} against a U-${required.door.toFixed(2)} maximum.`,
      remedy: 'Specify an insulated door.',
      system: 'envelope',
    });
  }

  /* ---- Air leakage, which is measured rather than specified ---- */

  const infiltration =
    INFILTRATION.find((entry) => entry.id === spec.infiltrationId) ?? INFILTRATION[1]!;
  const impliedAch50 = infiltration.winterAch * ACH50_PER_NATURAL;
  const limit = airLeakageLimit(zone);

  if (impliedAch50 > limit) {
    findings.push({
      id: 'envelope-leakage',
      severity: 'caution',
      section: AIR_LEAKAGE.section,
      title: 'Assumed leakage would fail a blower-door test',
      detail: `"${infiltration.label}" is ${infiltration.winterAch} natural air changes an hour, which is roughly ${impliedAch50.toFixed(1)} ACH50 — against the ${limit} ACH50 that ${AIR_LEAKAGE.asWritten}. The conversion between the two is approximate, so this is a warning rather than a finding: only the test settles it.`,
      remedy:
        'Build tighter, or expect to fail the test. Note that a tighter house needs mechanical ventilation, which is a separate requirement rather than an option.',
      system: 'envelope',
    });
  } else {
    findings.push({
      id: 'envelope-leakage',
      severity: 'pass',
      section: AIR_LEAKAGE.section,
      title: 'Assumed leakage would pass the test',
      detail: `About ${impliedAch50.toFixed(1)} ACH50 against a ${limit} ACH50 limit, from Manual J's ${INFILTRATION_SECTION} classes.`,
      remedy: '',
      system: 'envelope',
    });
  }

  /* ---- A sanity check on the load itself ---- */

  if (load.floorArea > 0) {
    const sqFt = load.floorArea / 0.092903;
    const heatingPerSqFt = wattsToBtu(load.heatingTotal) / sqFt;
    const sqFtPerTon = wattsToBtu(load.coolingTotal) > 0 ? (sqFt * 12000) / wattsToBtu(load.coolingTotal) : 0;

    if (sqFtPerTon > 0 && sqFtPerTon < 400) {
      findings.push({
        id: 'load-implausible-cooling',
        severity: 'caution',
        section: '',
        title: 'The cooling load looks implausibly large',
        detail: `${Math.round(sqFtPerTon)} ft² per ton. A real house lands somewhere between about 600 and 1,500, so something in the envelope or the glazing is almost certainly wrong.`,
        remedy: 'Check the window areas and the envelope assemblies before believing this number.',
        system: 'load',
      });
    }
    if (heatingPerSqFt > 60) {
      findings.push({
        id: 'load-implausible-heating',
        severity: 'caution',
        section: '',
        title: 'The heating load looks implausibly large',
        detail: `${heatingPerSqFt.toFixed(0)} BTU/h per ft². Even a poorly insulated house in a cold climate is usually under 40.`,
        remedy: 'Check the envelope assemblies and the infiltration class.',
        system: 'load',
      });
    }
  }
}

/**
 * The cheapest glazing in the catalogue that would meet a U-factor limit.
 *
 * Named rather than described, because "specify a better window" is advice
 * nobody can act on and "double glazed, low-E, argon filled" is a thing you
 * can ask a supplier for.
 */
function betterGlazing(limit: number): string {
  const options = [...GLAZING].sort((a, b) => b.uFactor - a.uFactor);
  const found = options.find((glazing) => glazing.uFactor <= limit);
  return found ? found.label.toLowerCase() : `something at or below U-${limit.toFixed(2)}`;
}

/* -------------------------------- Equipment ------------------------------- */

function checkEquipment(
  load: BuildingLoad,
  selection: SystemSelection,
  findings: HvacFinding[],
): void {
  if (selection.system === 'load-only') return;

  if (!selection.heating && !selection.cooling) {
    findings.push({
      id: 'equipment-none',
      severity: 'caution',
      section: '',
      title: 'No equipment selected',
      detail: 'There is a load but nothing chosen to meet it.',
      remedy: 'Pick a system type in the HVAC panel.',
      system: 'equipment',
    });
    return;
  }

  const cooling = selection.cooling;
  if (cooling) {
    const percent = Math.round(cooling.fraction * 100);

    if (cooling.fraction > SIZING_LIMITS.cooling.maxFraction) {
      findings.push({
        id: 'equipment-cooling-oversized',
        severity: 'violation',
        section: SIZING_LIMITS.cooling.section,
        title: 'The cooling is oversized',
        detail: `${cooling.model.name} is ${percent}% of the design cooling load, against Manual S's ${SIZING_LIMITS.cooling.asWritten}. An oversized coil satisfies the thermostat before it has been cold and wet long enough to remove any moisture, so the house ends up cool and clammy — and the usual response, turning the thermostat down, makes it worse.`,
        remedy:
          'Take the next size down, or a variable-capacity unit, which can run at part load for long enough to dehumidify.',
        system: 'equipment',
      });
    } else if (cooling.fraction < SIZING_LIMITS.cooling.minFraction) {
      findings.push({
        id: 'equipment-cooling-undersized',
        severity: 'violation',
        section: SIZING_LIMITS.cooling.section,
        title: 'The cooling is undersized',
        detail: `${cooling.model.name} is ${percent}% of the design cooling load, against a ${Math.round(SIZING_LIMITS.cooling.minFraction * 100)}% floor. It will run continuously on the hottest afternoons and still lose ground.`,
        remedy: 'Take the next size up, or reduce the load — the glass is usually the place to start.',
        system: 'equipment',
      });
    } else {
      findings.push({
        id: 'equipment-cooling',
        severity: 'pass',
        section: SIZING_LIMITS.cooling.section,
        title: 'The cooling is correctly sized',
        detail: `${cooling.model.name} at ${percent}% of the design load, inside Manual S's ${SIZING_LIMITS.cooling.asWritten}.`,
        remedy: '',
        system: 'equipment',
      });
    }
  }

  const heating = selection.heating;
  if (heating && !selection.balancePoint) {
    const percent = Math.round(heating.fraction * 100);

    if (heating.fraction > SIZING_LIMITS.heating.maxFraction) {
      findings.push({
        id: 'equipment-heating-oversized',
        severity: 'caution',
        section: SIZING_LIMITS.heating.section,
        title: 'The heating is oversized',
        detail: `${heating.model.name} is ${percent}% of the design heating load, against ${SIZING_LIMITS.heating.asWritten}. It will short-cycle, which costs efficiency and leaves the far rooms behind — but it is not the comfort problem an oversized coil is, which is why this is a caution.`,
        remedy: 'Take the next size down, or a modulating unit.',
        system: 'equipment',
      });
    } else if (heating.fraction < 1) {
      findings.push({
        id: 'equipment-heating-undersized',
        severity: 'violation',
        section: SIZING_LIMITS.heating.section,
        title: 'The heating cannot meet the load',
        detail: `${heating.model.name} delivers ${percent}% of what the building needs at the winter design temperature.`,
        remedy: 'Take a larger unit, or reduce the load.',
        system: 'equipment',
      });
    } else {
      findings.push({
        id: 'equipment-heating',
        severity: 'pass',
        section: SIZING_LIMITS.heating.section,
        title: 'The heating is correctly sized',
        detail: `${heating.model.name} at ${percent}% of the design load, inside the ${Math.round(SIZING_LIMITS.heating.maxFraction * 100)}% ceiling.`,
        remedy: '',
        system: 'equipment',
      });
    }
  }

  /* ---- The balance point, which is the heat pump's whole story ---- */

  const balance = selection.balancePoint;
  if (balance && load.conditions) {
    if (balance.coversDesignDay) {
      findings.push({
        id: 'equipment-balance-point',
        severity: 'pass',
        section: SIZING_LIMITS.heatPumpHeating.section,
        title: 'The heat pump needs no backup',
        detail: `It carries the house unaided down to ${Math.round(load.conditions.winterDryBulb)}°F, the winter design temperature here.`,
        remedy: '',
        system: 'equipment',
      });
    } else {
      findings.push({
        id: 'equipment-balance-point',
        severity: 'advice',
        section: SIZING_LIMITS.heatPumpHeating.section,
        title: `Backup heat needed below ${Math.round(balance.outdoorF)}°F`,
        detail: `That is the balance point — where the pump's falling capacity crosses the building's rising load. At the ${Math.round(load.conditions.winterDryBulb)}°F design temperature it is short by ${Math.round(balance.supplementalBtu).toLocaleString()} BTU/h, which is about ${balance.supplementalKw.toFixed(1)} kW of resistance heat.`,
        remedy: `Fit ${Math.ceil(balance.supplementalKw / 5) * 5} kW of backup, and set the thermostat's lockout so it only runs below the balance point rather than every time the pump defrosts.`,
        system: 'equipment',
      });

      if (balance.supplementalKw > 10) {
        findings.push({
          id: 'equipment-backup-large',
          severity: 'caution',
          section: '',
          title: 'That is a large amount of backup heat',
          detail: `${balance.supplementalKw.toFixed(1)} kW is around ${Math.ceil((balance.supplementalKw * 1000) / 240 / 40) * 40} A of 240 V service on its own, and it will run on the coldest days of the year when electricity is dearest.`,
          remedy:
            'A cold-climate heat pump holds far more of its capacity at low temperature and would cut most of this. Check the electrical service can carry it either way.',
          system: 'equipment',
        });
      }
    }
  }

  /* ---- The split ---- */

  const latent = selection.latent;
  if (latent && !latent.latentAdequate) {
    findings.push({
      id: 'equipment-latent',
      severity: 'caution',
      section: SIZING_LIMITS.cooling.section,
      title: 'Not enough moisture removal',
      detail: `The design latent load is ${Math.round(latent.latentRequiredBtu).toLocaleString()} BTU/h and this unit removes ${Math.round(latent.latentProvidedBtu).toLocaleString()}. The house will hold temperature and still feel damp.`,
      remedy: 'A variable-capacity unit, a lower sensible heat ratio, or a whole-house dehumidifier.',
      system: 'equipment',
    });
  }
  if (latent && !latent.sensibleAdequate) {
    findings.push({
      id: 'equipment-sensible',
      severity: 'violation',
      section: SIZING_LIMITS.cooling.section,
      title: 'Not enough sensible capacity',
      detail: `The sensible load is ${Math.round(latent.sensibleRequiredBtu).toLocaleString()} BTU/h and this unit provides ${Math.round(latent.sensibleProvidedBtu).toLocaleString()}, even though its total capacity looks adequate.`,
      remedy: 'Choose a unit with a higher sensible heat ratio, or the next size up.',
      system: 'equipment',
    });
  }
}

/* ---------------------------------- Ducts --------------------------------- */

function checkDucts(
  doc: DesignDocument,
  load: BuildingLoad,
  selection: SystemSelection,
  findings: HvacFinding[],
): void {
  if (selection.system === 'hydronic' || selection.system === 'load-only') return;
  if (selection.system === 'mini-split') return;

  if (doc.hvac.ducts.length === 0) {
    if (selection.supplyCfm > 0) {
      findings.push({
        id: 'ducts-none',
        severity: 'caution',
        section: '',
        title: 'No ductwork routed',
        detail: 'Equipment has been selected but the air has nowhere to go.',
        remedy: 'Route the ducts from the HVAC panel.',
        system: 'ducts',
      });
    }
    return;
  }

  const sized = sizeAllDucts(doc, load, selection);

  const noisy = sized.filter((duct) => !duct.withinVelocity);
  if (noisy.length > 0) {
    const worst = noisy.reduce((a, b) => (a.velocity > b.velocity ? a : b));
    findings.push({
      id: 'ducts-velocity',
      severity: 'caution',
      section: VELOCITY_LIMITS.trunk.section,
      title: `${noisy.length} duct${noisy.length === 1 ? '' : 's'} would be audible`,
      detail: `The worst carries ${Math.round(worst.cfm)} cfm through a ${worst.size.asWritten} duct at ${Math.round(worst.velocity)} feet per minute, against a ${worst.velocityLimit} fpm limit for a ${worst.role}. Nothing fails — you simply hear it, permanently.`,
      remedy: 'Take the next duct size up, or split the run.',
      system: 'ducts',
    });
  } else {
    findings.push({
      id: 'ducts-velocity',
      severity: 'pass',
      section: VELOCITY_LIMITS.trunk.section,
      title: 'Air speeds are inside the noise limits',
      detail: `Every run is under ${VELOCITY_LIMITS.trunk.asWritten} in the trunks and ${VELOCITY_LIMITS.branch.asWritten} in the branches.`,
      remedy: '',
      system: 'ducts',
    });
  }

  /* ---- Every room that should have air, and does not ---- */

  const airflows = roomAirflows(load, selection);
  const served = new Set(
    doc.hvac.registers.filter((r) => r.system === 'supply').map((r) => r.roomKey),
  );
  const unserved = airflows.filter((flow) => flow.designCfm > 10 && !served.has(flow.roomKey));

  if (unserved.length > 0) {
    findings.push({
      id: 'ducts-unserved',
      severity: 'violation',
      section: '',
      title: `${unserved.length} room${unserved.length === 1 ? ' has' : 's have'} a load and no supply`,
      detail: `${unserved.map((flow) => flow.roomName).join(', ')}. Each needs air and has none routed to it.`,
      remedy: 'Re-route the ducts, or add a register by hand.',
      system: 'ducts',
    });
  }

  /* ---- Returns, and the pressurisation nobody sees ---- */

  const returns = doc.hvac.registers.filter((r) => r.system === 'return');
  const levelsWithSupply = new Set(
    doc.hvac.registers.filter((r) => r.system === 'supply').map((r) => r.levelId),
  );
  const levelsWithReturn = new Set(returns.map((r) => r.levelId));
  const missing = [...levelsWithSupply].filter((levelId) => !levelsWithReturn.has(levelId));

  if (missing.length > 0) {
    findings.push({
      id: 'ducts-return-missing',
      severity: 'violation',
      section: '',
      title: 'A storey has supply air and no return',
      detail:
        'Air that goes into a storey has to come back out of it. Without a return the storey pressurises and pushes conditioned air out through the structure, which is expensive and invisible.',
      remedy: 'Add a return on each storey that has supply registers.',
      system: 'ducts',
    });
  } else if (returns.length > 0) {
    findings.push({
      id: 'ducts-return',
      severity: 'advice',
      section: '',
      title: 'One central return per storey',
      detail:
        'That only works if the air can get back to it from behind a closed door. A bedroom with a supply, no return and a closed door pressurises just as surely as a whole storey does.',
      remedy: 'Undercut the doors by at least 20 mm, or fit transfer grilles.',
      system: 'ducts',
    });
  }

  /* ---- Duct leakage, which the code tests and this app cannot ---- */

  findings.push({
    id: 'ducts-leakage',
    severity: 'advice',
    section: DUCT_LEAKAGE.section,
    title: 'Ductwork has to be tested',
    detail: `The IECC caps leakage at ${DUCT_LEAKAGE.asWritten}. That is a measurement on the finished installation; nothing here predicts it.`,
    remedy: 'Seal every joint with mastic — not tape — and have the system pressure tested.',
    system: 'ducts',
  });

  /*
   * The one honest omission worth naming rather than burying.
   *
   * This app routes every duct inside the conditioned envelope, in the floor
   * void. Enormous numbers of real houses run them through an unconditioned
   * loft instead, where in a hot climate the air around them is at 130°F, and
   * that adds 15-25% to the cooling load — an entire half-ton on a small
   * house. It is not modelled, so it is said.
   */
  findings.push({
    id: 'ducts-unconditioned',
    severity: 'advice',
    section: '',
    title: 'Ducts are assumed to run inside the insulation',
    detail:
      'The load makes no allowance for duct loss or gain in an unconditioned space. If any of this ends up in a loft or a vented crawl space, add 15–25% to the cooling load and insulate the ducts heavily.',
    remedy: 'Keep the ducts inside the thermal envelope if the structure allows it.',
    system: 'ducts',
  });
}

/* ------------------------------- Ventilation ------------------------------ */

function checkVentilation(
  doc: DesignDocument,
  load: BuildingLoad,
  selection: SystemSelection,
  findings: HvacFinding[],
): void {
  if (selection.ventilationCfm <= 0) return;

  const spec = doc.hvac.envelope;
  const infiltration =
    INFILTRATION.find((entry) => entry.id === spec.infiltrationId) ?? INFILTRATION[1]!;

  findings.push({
    id: 'ventilation-required',
    severity: infiltration.id === 'tight' ? 'caution' : 'advice',
    section: VENTILATION.section,
    title: `This house needs ${Math.round(selection.ventilationCfm)} cfm of outdoor air`,
    detail: `${VENTILATION.asWritten}, for ${Math.round(load.floorArea / 0.092903).toLocaleString()} ft² and ${load.bedrooms} bedroom${load.bedrooms === 1 ? '' : 's'}. ${
      infiltration.id === 'tight'
        ? 'A house this tight does not ventilate itself, so this is a requirement rather than a recommendation — the moisture from cooking, washing and breathing has nowhere else to go.'
        : 'A leakier house gets some of this by accident, but not reliably and not when the wind drops.'
    }`,
    remedy:
      'Fit a balanced ventilator — an HRV in a cold climate, an ERV in a humid one — or at minimum a continuous exhaust fan with a fresh-air inlet.',
    system: 'ventilation',
  });
}
