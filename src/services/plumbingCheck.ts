/**
 * Checking the plumbing against the IPC.
 *
 * -----------------------------------------------------------------------------
 * THE SAME CONTRACT AS EVERY OTHER CHECKER HERE.
 *
 * Every finding names the measurement, the limit and the section. A finding
 * with an empty `section` is guidance rather than code, and the UI prints
 * "Guidance" instead of a citation — water velocity and water heater sizing are
 * the two that fall in that bucket, because the IPC genuinely does not legislate
 * them and pretending otherwise would teach people to distrust the citations
 * that are real.
 *
 * -----------------------------------------------------------------------------
 * WHY THE PRESSURE CHECK IS DONE PROPERLY RATHER THAN OFF THE TABLE.
 *
 * Appendix E's sizing table answers "what size pipe for this many fixture
 * units", and for an ordinary house on ordinary pressure it is right. But it
 * assumes a pressure range and a developed length, and a house that is long,
 * tall, or on low street pressure falls outside both while still passing the
 * table.
 *
 * So the table gives a starting size and then the real arithmetic runs on top:
 * Hunter's curve for the flow, Hazen–Williams for the friction, 9.8 kPa for
 * every metre of rise. Where the two disagree the calculation wins, and the
 * finding says which is which — because "the table says 3/4 in but you will
 * have 12 psi at the top shower" is the sentence that is actually useful.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS NOT CHECKED.
 *
 * Nothing about materials or jointing, nothing about backflow devices beyond
 * saying one is needed, nothing about gas, and nothing about whether there is a
 * joist in the way. All of those depend on how the building is actually built.
 */

import {
  HOT_WATER,
  IPC_CLEANOUTS,
  IPC_SLOPE,
  IPC_SUPPLY,
  IPC_TRAPS,
  IPC_VENTS,
  STATIC_HEAD_KPA_PER_METRE,
  WC_LIMIT_3_INCH,
  asWsfu,
  flowForWsfu,
  frictionLossPerMetre,
  inches,
  minSlopeFor,
  serviceSizeFor,
  supplySizeFor,
  trapArmFor,
  velocityFor,
  ventSizeFor,
} from '@/code/ipc';
import { asFeetInches } from '@/code/irc';
import { getFixture } from '@/fittings/fixtures';
import { elevationOf } from '@/state/levels';
import { indexVertices, openingCenter, resolveWall } from '@/scene/planGraph';
import {
  accumulateWsfu,
  developedLength,
  horizontalLength,
  plumbingTotals,
  sizeAllDrainage,
  trapSizeOf,
  worldHeight,
  type SizedRun,
} from './plumbingSize';
import { countBathrooms, storageFor } from './supply';
import type { DesignDocument, PipeRun } from '@/state/types';

export type PlumbingSeverity = 'violation' | 'caution' | 'advice' | 'pass';

export interface PlumbingFinding {
  id: string;
  severity: PlumbingSeverity;
  /** The section, or empty when the finding is guidance rather than code. */
  section: string;
  title: string;
  detail: string;
  remedy: string;
  /** Which system it is about, for grouping in the panel. */
  system: 'drainage' | 'venting' | 'supply' | 'hot-water';
}

export interface PlumbingReport {
  findings: PlumbingFinding[];
  compliant: boolean;
  /** What the pressure calculation worked out, for the panel to show. */
  pressure: PressureResult | null;
}

/* --------------------------------- Run ------------------------------------ */

export function checkPlumbing(doc: DesignDocument): PlumbingReport {
  const findings: PlumbingFinding[] = [];
  const routed =
    doc.plumbing.drainage.length > 0 || doc.plumbing.supply.length > 0;

  if (!routed) {
    return { findings, compliant: true, pressure: null };
  }

  const sized = sizeAllDrainage(doc);

  checkFalls(doc, sized, findings);
  checkWaterClosets(sized, findings);
  checkTraps(doc, findings);
  checkVenting(doc, sized, findings);
  checkCleanouts(doc, sized, findings);

  const pressure = checkSupply(doc, findings);
  checkHotWater(doc, findings);

  return {
    findings,
    compliant: !findings.some((finding) => finding.severity === 'violation'),
    pressure,
  };
}

/* -------------------------------- Drainage -------------------------------- */

/**
 * Every horizontal drain must fall at least the minimum for its size.
 *
 * Three separate failures live here and they are genuinely different:
 *
 *   • FALLING THE WRONG WAY — a negative slope. The pipe runs uphill. This is
 *     always a violation and there is nothing to discuss.
 *   • TOO FLAT — it falls, but not enough. A violation, with the shortfall in
 *     millimetres so it is clear how much is missing.
 *   • TOO STEEP — guidance only. The IPC sets no maximum; a drain much past
 *     1 in 12 outruns its solids and leaves them behind, which every plumber
 *     knows and no section states.
 */
function checkFalls(
  doc: DesignDocument,
  sized: readonly SizedRun[],
  findings: PlumbingFinding[],
): void {
  for (const entry of sized) {
    if (entry.role === 'vent' || entry.role === 'stack') continue;
    if (entry.slope === null || entry.horizontalLength < 0.05) continue;

    const rule = minSlopeFor(entry.size.size);
    const label = describe(doc, entry.run);

    if (entry.slope < 0) {
      findings.push({
        id: `fall-uphill-${entry.run.id}`,
        severity: 'violation',
        section: IPC_SLOPE.section,
        title: 'A drain runs uphill',
        detail: `${label} rises ${(Math.abs(entry.slope) * entry.horizontalLength * 1000).toFixed(0)} mm over its ${entry.horizontalLength.toFixed(2)} m run. Water will not flow along it.`,
        remedy:
          'Move the fixture nearer the stack, drop the stack, or get the sewer connection deeper. This is not something a bigger pipe fixes.',
        system: 'drainage',
      });
      continue;
    }

    if (entry.slope < rule.minSlope - 1e-6) {
      const short = (rule.minSlope - entry.slope) * entry.horizontalLength * 1000;
      findings.push({
        id: `fall-flat-${entry.run.id}`,
        severity: 'violation',
        section: IPC_SLOPE.section,
        title: 'A drain is laid too flat',
        detail: `${label} falls 1 in ${(1 / entry.slope).toFixed(0)} over ${entry.horizontalLength.toFixed(2)} m. IPC ${IPC_SLOPE.section} wants at least ${rule.asWritten} (1 in ${(1 / rule.minSlope).toFixed(0)}) for ${entry.size.asWritten} pipe — about ${short.toFixed(0)} mm more fall than it has.`,
        remedy: `Shorten the run, or find another ${short.toFixed(0)} mm of depth at the downstream end.`,
        system: 'drainage',
      });
      continue;
    }

    if (entry.slope > IPC_SLOPE.practicalMaxSlope) {
      findings.push({
        id: `fall-steep-${entry.run.id}`,
        severity: 'advice',
        // Guidance: the IPC sets no maximum slope.
        section: '',
        title: 'A drain is very steep',
        detail: `${label} falls 1 in ${(1 / entry.slope).toFixed(0)}, steeper than ${IPC_SLOPE.practicalMaxAsWritten}. Water outruns the solids at that gradient and leaves them behind.`,
        remedy:
          'Run it flatter and take the drop vertically at the end, rather than sloping the whole way.',
        system: 'drainage',
      });
    }
  }
}

/**
 * Not more than two water closets on a 3 in drain.
 *
 * Checked separately from the DFU tables because it is a COUNT, and no fixture
 * unit total expresses it: three WCs on a 3 in stack is 9 DFU against a 48 DFU
 * limit, passes every arithmetic check, and is still a violation — and will
 * block.
 */
function checkWaterClosets(sized: readonly SizedRun[], findings: PlumbingFinding[]): void {
  for (const entry of sized) {
    if (entry.role === 'vent') continue;
    if (entry.size.size >= inches(4) - 1e-9) continue;
    if (entry.waterClosets <= WC_LIMIT_3_INCH.maxWaterClosets) continue;

    findings.push({
      id: `wc-count-${entry.run.id}`,
      severity: 'violation',
      section: WC_LIMIT_3_INCH.section,
      title: 'Too many water closets on a 3 in drain',
      detail: `${entry.waterClosets} water closets discharge into a ${entry.size.asWritten} ${entry.role === 'stack' ? 'stack' : 'drain'}. ${WC_LIMIT_3_INCH.asWritten}. The fixture-unit total is within the table; the count is not.`,
      remedy: 'Take it up to 4 in, or split the WCs across two stacks.',
      system: 'drainage',
    });
  }
}

/**
 * Trap sizes, and the trap arm to its vent.
 *
 * 906.1 is the rule that catches more real mistakes than any other in
 * drainage: run a trap too far before venting it and the flow siphons its water
 * seal out, and the room smells of sewer. The distance is measured along the
 * pipe, not in a straight line.
 */
function checkTraps(doc: DesignDocument, findings: PlumbingFinding[]): void {
  for (const connection of doc.plumbing.connections) {
    const fixture = doc.fixtures.find((candidate) => candidate.id === connection.fixtureId);
    if (!fixture) continue;
    const entry = getFixture(fixture.fixtureId);
    const name = entry?.name ?? 'A fixture';

    const required = trapSizeOf(fixture.fixtureId);
    if (required > 0 && connection.trapSize < required - 1e-9) {
      findings.push({
        id: `trap-size-${connection.fixtureId}`,
        severity: 'violation',
        section: '709.1',
        title: 'A trap is too small',
        detail: `The ${name.toLowerCase()} has a ${(connection.trapSize * 1000).toFixed(0)} mm trap where Table 709.1 asks for ${(required * 1000).toFixed(0)} mm.`,
        remedy: `Fit a ${(required * 1000).toFixed(0)} mm trap.`,
        system: 'drainage',
      });
    }

    const branch = doc.plumbing.drainage.find((run) => run.id === connection.drainRunId);
    if (!branch) {
      findings.push({
        id: `trap-nodrain-${connection.fixtureId}`,
        severity: 'violation',
        section: IPC_TRAPS.oneTrapPerFixture.section,
        title: 'A fixture has no drain',
        detail: `The ${name.toLowerCase()} is not connected to anything.`,
        remedy: 'Re-route the drainage, or draw a branch to it by hand.',
        system: 'drainage',
      });
      continue;
    }

    const arm = trapArmFor(connection.trapSize);
    const armLength = horizontalLength(branch);
    const vented = connection.ventRunId !== null;

    // A trap arm longer than the table allows is only a fault if the fixture
    // is relying on the stack to vent it. A reventing pipe of its own resets
    // the measurement, which is exactly why the router adds one.
    const ownVent =
      connection.ventRunId !== null &&
      doc.plumbing.drainage.some(
        (run) => run.id === connection.ventRunId && run.serves.includes(connection.fixtureId),
      );

    if (!vented) {
      findings.push({
        id: `trap-unvented-${connection.fixtureId}`,
        severity: 'violation',
        section: IPC_VENTS.sizing.section,
        title: 'A trap has no vent',
        detail: `Nothing vents the ${name.toLowerCase()}. Water falling down the stack will siphon its seal out, and the room will smell of sewer.`,
        remedy: 'Re-route the drainage, which adds a vent to every trap.',
        system: 'venting',
      });
    } else if (!ownVent && armLength > arm.maxLength + 1e-6) {
      findings.push({
        id: `trap-arm-${connection.fixtureId}`,
        severity: 'violation',
        section: IPC_TRAPS.distanceToVent.section,
        title: 'A trap is too far from its vent',
        detail: `The ${name.toLowerCase()}'s trap arm runs ${asFeetInches(armLength)} to the stack. Table 906.1 allows ${arm.maxAsWritten} on ${(connection.trapSize * 1000).toFixed(0)} mm pipe.`,
        remedy: 'Move the fixture nearer the stack, or give it a vent of its own.',
        system: 'venting',
      });
    }
  }
}

/* --------------------------------- Venting -------------------------------- */

function checkVenting(
  doc: DesignDocument,
  sized: readonly SizedRun[],
  findings: PlumbingFinding[],
): void {
  const vents = doc.plumbing.drainage.filter((run) => run.system === 'vent');
  const drains = sized.filter((entry) => entry.role !== 'vent');

  if (drains.length > 0 && vents.length === 0) {
    findings.push({
      id: 'vent-none',
      severity: 'violation',
      section: IPC_VENTS.stackVent.section,
      title: 'The drainage has no vent',
      detail:
        'Every building drain needs at least one vent carried full size through the roof. Without one, the traps siphon and the drains gurgle and run slowly.',
      remedy: 'Re-route the drainage, which carries the stack up through the roof.',
      system: 'venting',
    });
    return;
  }

  /*
   * The main vent has to exist and has to reach open air. Its SIZE is checked
   * with every other vent below, against 916.2 — there is no universal 3 in
   * minimum, whatever everyone remembers. That figure is the frost rule, and it
   * is conditional on the climate, which this app does not know.
   */
  const buildingDrain = sized.find((entry) => entry.role === 'building-drain');
  const mainVent = sized.find(
    (entry) => entry.role === 'vent' && highestPoint(doc, entry.run) > topWallHeight(doc),
  );

  if (buildingDrain && !mainVent) {
    findings.push({
      id: 'vent-not-through-roof',
      severity: 'violation',
      section: IPC_VENTS.throughRoof.section,
      title: 'No vent goes through the roof',
      detail:
        'A vent has to terminate in open air. One that stops in the roof space vents the drains into the loft.',
      remedy: 'Re-route the drainage, which carries the stack vent above the roof.',
      system: 'venting',
    });
  }

  /*
   * Frost closure. A caution and never a violation, because 904.2 applies only
   * where the winter design temperature is at or below 0°F and nothing in this
   * model says where the building is. Naming the condition lets the user decide;
   * asserting it as a violation would be citing a section for a rule that may
   * not apply to them.
   */
  if (mainVent && mainVent.size.size < IPC_VENTS.frostClosure.minimumSize - 1e-9) {
    findings.push({
      id: 'vent-frost',
      severity: 'caution',
      section: IPC_VENTS.frostClosure.section,
      title: 'The vent may frost shut in a cold climate',
      detail: `The vent through the roof is ${mainVent.size.asWritten}. Where the winter design temperature is ${IPC_VENTS.frostClosure.appliesBelow} or below, IPC ${IPC_VENTS.frostClosure.section} wants ${IPC_VENTS.frostClosure.minimumAsWritten}. This app does not know where the building is, so it cannot tell you whether that applies.`,
      remedy: `In a cold climate, take the vent up to ${IPC_VENTS.frostClosure.minimumAsWritten} at least a foot inside the roof line.`,
      system: 'venting',
    });
  }

  // Each vent must be at least half the drain it serves.
  for (const entry of sized) {
    if (entry.role !== 'vent') continue;
    const served = sized.find((candidate) => candidate.run.id === entry.run.downstreamId);
    if (!served) continue;

    const wanted = ventSizeFor(served.size.size);
    if (entry.size.size < wanted - 1e-9) {
      findings.push({
        id: `vent-small-${entry.run.id}`,
        severity: 'violation',
        section: IPC_VENTS.sizing.section,
        title: 'A vent is too small for the drain it serves',
        detail: `A ${entry.size.asWritten} vent serves a ${served.size.asWritten} drain. ${IPC_VENTS.sizing.asWritten}.`,
        remedy: `Take it up to ${(Math.ceil((wanted / inches(1)) * 4) / 4).toFixed(2)} in or the next size above.`,
        system: 'venting',
      });
    }
  }

  // 904.5 — a vent may not open near a window somebody opens.
  for (const stack of doc.plumbing.stacks) {
    const nearby = openingsNear(doc, stack.at, IPC_VENTS.clearOfOpenings.horizontal);
    if (nearby > 0) {
      findings.push({
        id: `vent-near-window-${stack.id}`,
        severity: 'caution',
        section: IPC_VENTS.clearOfOpenings.section,
        title: 'A vent terminates near a window',
        detail: `The stack vent comes out within ${IPC_VENTS.clearOfOpenings.horizontalAsWritten} of ${nearby} opening${nearby === 1 ? '' : 's'}. IPC ${IPC_VENTS.clearOfOpenings.section} wants it ${IPC_VENTS.clearOfOpenings.horizontalAsWritten} away horizontally, or ${IPC_VENTS.clearOfOpenings.belowAsWritten} above the top of the opening.`,
        remedy:
          'Move the stack, or carry the vent higher — the rule is satisfied by height as well as by distance, and this check only measures the plan distance.',
        system: 'venting',
      });
    }
  }
}

/* ------------------------------- Cleanouts -------------------------------- */

/**
 * Cleanouts. Reported as cautions rather than violations, deliberately.
 *
 * The app does not model cleanouts as objects — a cleanout is a fitting a
 * plumber puts in, not something anybody draws at this stage — so this cannot
 * say whether one is present. What it CAN say is where the code requires one,
 * which is the useful half: it turns into a list of positions to hand over.
 */
function checkCleanouts(
  doc: DesignDocument,
  sized: readonly SizedRun[],
  findings: PlumbingFinding[],
): void {
  const buildingDrain = sized.find((entry) => entry.role === 'building-drain');
  if (!buildingDrain) return;

  const wanted: string[] = [];
  if (doc.plumbing.stacks.length > 0) wanted.push('at the foot of the stack');
  wanted.push('where the drain leaves the building');

  const long = sized.filter(
    (entry) => entry.role !== 'vent' && entry.horizontalLength > IPC_CLEANOUTS.maxSpacing,
  );
  if (long.length > 0) wanted.push(`every ${IPC_CLEANOUTS.maxSpacingAsWritten} along a straight run`);

  findings.push({
    id: 'cleanouts',
    severity: 'caution',
    section: IPC_CLEANOUTS.section,
    title: 'Cleanouts are required but not drawn',
    detail: `IPC ${IPC_CLEANOUTS.section} wants a cleanout ${wanted.join(', ')}, each with ${IPC_CLEANOUTS.clearance.asWritten} of clear space to rod it. This app does not draw cleanouts, so it cannot tell you whether they are there.`,
    remedy: 'Mark them on the drawing before it goes to a plumber.',
    system: 'drainage',
  });
}

/* --------------------------------- Supply --------------------------------- */

export interface PressureResult {
  /** Street pressure the calculation started from, kPa. */
  mainKpa: number;
  /** What is left at the worst fixture, kPa. */
  residualKpa: number;
  /** What that fixture needs, kPa. */
  requiredKpa: number;
  /** The fixture it is, by name. */
  worstFixture: string;
  /** Developed length to it, metres. */
  length: number;
  /** How much of the budget went where. */
  staticKpa: number;
  frictionKpa: number;
  /** Fastest water in the system, m/s. */
  peakVelocity: number;
}

/**
 * The pressure budget, spent from the street to the worst outlet.
 *
 * The "worst" fixture is not the furthest and not the highest — it is the one
 * with the least left after both. So every supplied fixture is evaluated and
 * the smallest residual wins, which for a two-storey house is usually the
 * upstairs shower and occasionally the far end of the kitchen.
 */
function checkSupply(doc: DesignDocument, findings: PlumbingFinding[]): PressureResult | null {
  if (doc.plumbing.supply.length === 0) return null;

  const totals = plumbingTotals(doc);
  const wsfuByRun = accumulateWsfu(doc);

  const service = doc.plumbing.supply.find((run) => run.downstreamId === null);
  const serviceSize = serviceSizeFor(wsfuByRun.get(service?.id ?? '') ?? totals.totalWsfu);

  if (service && serviceSize.size < IPC_SUPPLY.minServiceSize.metres - 1e-9) {
    findings.push({
      id: 'service-small',
      severity: 'violation',
      section: IPC_SUPPLY.minServiceSize.section,
      title: 'The water service is too small',
      detail: `The service works out at ${serviceSize.asWritten}. IPC ${IPC_SUPPLY.minServiceSize.section} sets a floor of ${IPC_SUPPLY.minServiceSize.asWritten} whatever the load.`,
      remedy: `Use ${IPC_SUPPLY.minServiceSize.asWritten}.`,
      system: 'supply',
    });
  }

  // Walk each fixture's path back to the service, spending the budget.
  const byId = new Map(doc.plumbing.supply.map((run) => [run.id, run]));
  let worst: PressureResult | null = null;
  let peakVelocity = 0;

  for (const connection of doc.plumbing.connections) {
    for (const runId of [connection.coldRunId, connection.hotRunId]) {
      if (!runId) continue;

      const fixture = doc.fixtures.find((candidate) => candidate.id === connection.fixtureId);
      if (!fixture) continue;

      let friction = 0;
      let length = 0;
      let current: PipeRun | undefined = byId.get(runId);
      const guard = new Set<string>();

      while (current && !guard.has(current.id)) {
        guard.add(current.id);

        const wsfu = wsfuByRun.get(current.id) ?? asWsfu(0);
        const size = supplySizeFor(wsfu);
        const flow = flowForWsfu(wsfu);
        const run = developedLength(doc, current);

        length += run;
        // Appendix E: allow for fittings on top of the measured length.
        friction +=
          frictionLossPerMetre(flow, size.bore) * run * (1 + IPC_SUPPLY.fittingAllowance.fraction);
        peakVelocity = Math.max(peakVelocity, velocityFor(flow, size.bore));

        current = current.downstreamId ? byId.get(current.downstreamId) : undefined;
      }

      // Static head: how far the outlet is above the street.
      const outlet = byId.get(runId)?.points[byId.get(runId)!.points.length - 1];
      const rise = outlet ? worldHeight(doc, outlet) : elevationOf(doc, fixture.levelId);
      const staticKpa = Math.max(0, rise) * STATIC_HEAD_KPA_PER_METRE;

      const residual = doc.plumbing.mainPressureKpa - staticKpa - friction;
      const entry = getFixture(fixture.fixtureId);
      const required =
        entry?.kind === 'shower'
          ? IPC_SUPPLY.minFlowPressure.showerKpa
          : IPC_SUPPLY.minFlowPressure.typicalKpa;

      if (!worst || residual < worst.residualKpa) {
        worst = {
          mainKpa: doc.plumbing.mainPressureKpa,
          residualKpa: residual,
          requiredKpa: required,
          worstFixture: entry?.name ?? 'A fixture',
          length,
          staticKpa,
          frictionKpa: friction,
          peakVelocity,
        };
      }
    }
  }

  if (!worst) return null;
  worst.peakVelocity = peakVelocity;

  if (worst.residualKpa < worst.requiredKpa) {
    findings.push({
      id: 'pressure-short',
      severity: 'violation',
      section: IPC_SUPPLY.minFlowPressure.section,
      title: 'Not enough pressure at the worst fixture',
      detail: `${worst.worstFixture} is ${worst.length.toFixed(1)} m of pipe from the main. Starting at ${psi(worst.mainKpa)}, ${psi(worst.staticKpa)} goes on height and ${psi(worst.frictionKpa)} on friction, leaving ${psi(worst.residualKpa)} — below the ${psi(worst.requiredKpa)} IPC ${IPC_SUPPLY.minFlowPressure.section} wants at the fitting.`,
      remedy:
        'Take the trunk up a size, shorten the run, or check the street pressure — the default figure is an assumption until somebody measures it.',
      system: 'supply',
    });
  }

  if (!doc.plumbing.mainPressureMeasured) {
    findings.push({
      id: 'pressure-assumed',
      severity: 'caution',
      section: '',
      title: 'The street pressure is an assumption',
      detail: `The whole supply calculation starts from ${psi(doc.plumbing.mainPressureKpa)}, which is a typical figure rather than a measured one. Real street pressure varies from about 40 to over 80 psi, and the sizing changes with it.`,
      remedy:
        'Put a gauge on an outside tap and enter the real figure. It costs a few pounds and it is the single number this calculation is most sensitive to.',
      system: 'supply',
    });
  }

  if (doc.plumbing.mainPressureKpa > IPC_SUPPLY.maxStaticPressure.kpa) {
    findings.push({
      id: 'pressure-high',
      severity: 'violation',
      section: IPC_SUPPLY.maxStaticPressure.section,
      title: 'The street pressure is too high without a reducing valve',
      detail: `${psi(doc.plumbing.mainPressureKpa)} at the main. IPC ${IPC_SUPPLY.maxStaticPressure.section} requires a pressure-reducing valve above ${IPC_SUPPLY.maxStaticPressure.asWritten}.`,
      remedy: 'Fit a pressure-reducing valve on the service.',
      system: 'supply',
    });
  }

  if (peakVelocity > IPC_SUPPLY.maxVelocity.metresPerSecond) {
    findings.push({
      id: 'velocity-high',
      severity: 'caution',
      // Guidance: the IPC sets no velocity limit.
      section: '',
      title: 'The water moves fast enough to erode the pipe',
      detail: `Peak velocity works out at ${peakVelocity.toFixed(1)} m/s. Above ${IPC_SUPPLY.maxVelocity.asWritten} copper erodes at the fittings and the pipework sings when a tap opens.`,
      remedy: 'Take the pipe carrying the most fixture units up one size.',
      system: 'supply',
    });
  }

  return worst;
}

/* ------------------------------- Hot water -------------------------------- */

function checkHotWater(doc: DesignDocument, findings: PlumbingFinding[]): void {
  const heater = doc.plumbing.heater;
  const hotFixtures = doc.fixtures.filter(
    (fixture) => getFixture(fixture.fixtureId)?.connections.hot === true,
  );

  if (hotFixtures.length === 0) return;

  if (!heater) {
    findings.push({
      id: 'heater-none',
      severity: 'violation',
      section: HOT_WATER.required.section,
      title: 'There is no water heater',
      detail: `${hotFixtures.length} fixture${hotFixtures.length === 1 ? ' needs' : 's need'} hot water and nothing makes any.`,
      remedy: 'Route the supply, which places one.',
      system: 'hot-water',
    });
    return;
  }

  if (heater.kind === 'storage') {
    const wanted = storageFor(countBathrooms(doc));
    if (heater.litres < wanted) {
      findings.push({
        id: 'heater-small',
        severity: 'advice',
        // Guidance: IPC 501.1 requires adequate size and does not say how.
        section: '',
        title: 'The cylinder looks small for the house',
        detail: `${heater.litres} litres for ${countBathrooms(doc)} bathroom${countBathrooms(doc) === 1 ? '' : 's'}. The usual allowance works out nearer ${wanted} litres.`,
        remedy: `Consider ${wanted} litres, or an instantaneous heater sized on flow rate instead.`,
        system: 'hot-water',
      });
    }
  }

  // Scald protection at a bath or shower is code, and it is easy to forget.
  const bathing = doc.fixtures.filter((fixture) => {
    const kind = getFixture(fixture.fixtureId)?.kind;
    return kind === 'bath' || kind === 'shower';
  });

  if (bathing.length > 0) {
    findings.push({
      id: 'scald',
      severity: 'caution',
      section: HOT_WATER.scaldProtection.section,
      title: 'Baths and showers need temperature limiting',
      detail: `${bathing.length} bathing fixture${bathing.length === 1 ? '' : 's'}. IPC ${HOT_WATER.scaldProtection.section} limits the outlet to ${HOT_WATER.scaldProtection.asWritten}, which means a thermostatic mixing valve — not just turning the cylinder down.`,
      remedy: 'Specify thermostatic mixers on the bath and shower outlets.',
      system: 'hot-water',
    });
  }
}

/* -------------------------------- Helpers --------------------------------- */

/** kPa in the units the code is written in, for a message somebody reads. */
function psi(kpa: number): string {
  return `${(kpa / 6.895).toFixed(0)} psi`;
}

/** Names a run in a way that identifies it on the drawing. */
function describe(doc: DesignDocument, run: PipeRun): string {
  const names = run.serves
    .map((fixtureId) => {
      const fixture = doc.fixtures.find((candidate) => candidate.id === fixtureId);
      return fixture ? getFixture(fixture.fixtureId)?.name : null;
    })
    .filter((name): name is string => Boolean(name));

  if (names.length === 1) return `The branch from the ${names[0]!.toLowerCase()}`;
  if (names.length > 1) return `The branch serving ${names.length} fixtures`;
  return run.downstreamId === null ? 'The building drain' : 'A drain';
}

/** The highest point of a run, in world terms. */
function highestPoint(doc: DesignDocument, run: PipeRun): number {
  return Math.max(...run.points.map((point) => worldHeight(doc, point)));
}

/** The top of the topmost wall, so "through the roof" can be told from "not". */
function topWallHeight(doc: DesignDocument): number {
  let top = 0;
  for (const level of doc.levels) {
    top = Math.max(top, elevationOf(doc, level.id) + level.wallHeight);
  }
  return top;
}

/**
 * How many openings are within a distance of a point in plan.
 *
 * Only the plan distance: 904.5 is satisfied by height as well, and this app
 * cannot reliably tell how high the vent is relative to the head of a window on
 * a pitched roof. So it reports a CAUTION and says which half it measured,
 * rather than a violation it cannot stand behind.
 */
function openingsNear(doc: DesignDocument, at: { x: number; z: number }, within: number): number {
  let count = 0;
  for (const level of doc.levels) {
    const vertices = indexVertices(level.plan);
    for (const wall of level.plan.walls) {
      const segment = resolveWall(wall, vertices);
      if (!segment) continue;

      for (const opening of wall.openings) {
        if (opening.kind !== 'window') continue;
        // `openingCenter` rather than arithmetic here: an opening's offset is
        // measured to its CENTRE, and adding half a width would shift every
        // window along its wall.
        const point = openingCenter(segment, opening);
        if (Math.hypot(point.x - at.x, point.z - at.z) <= within) count += 1;
      }
    }
  }
  return count;
}

/** For the panel and the schedules: the sized runs, without re-deriving them. */
export function drainageSchedule(doc: DesignDocument): SizedRun[] {
  return sizeAllDrainage(doc);
}
