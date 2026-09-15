/**
 * The acoustic report: rooms that will ring, walls that will not stop a
 * conversation, and a bedroom facing the road.
 *
 * -----------------------------------------------------------------------------
 * THIS CHECKER HAS THE WEAKEST AUTHORITY IN THE APP, AND SAYS SO.
 *
 * Every other checker here can fail you an inspection. This one mostly cannot,
 * because a detached house has essentially no acoustic code to fail. That makes
 * it the checker most at risk of sounding more authoritative than it is, so
 * every finding carries which kind of thing it is:
 *
 *   IBC       — real law, and in a detached house it applies to nothing. It is
 *               carried anyway so the report can say that plainly, because
 *               "STC 50" is the number people have heard of and they assume it
 *               governs their bedroom wall.
 *   ASHRAE    — the mechanical industry's own recommendations for background
 *               noise. Not law; an engineer will recognise the numbers.
 *   WHO       — a health body's recommendation for sleep. Not law and not an
 *               engineering standard, which is a third kind of thing again.
 *   none      — this app's guidance, printed as "Guidance" with no citation.
 *
 * Most of what follows is the last one. Inventing a section number to make it
 * look stronger would be the fastest way to make somebody stop believing the
 * IRC and NEC citations that are real.
 *
 * -----------------------------------------------------------------------------
 * AND THE LABORATORY NUMBER IS NOT THE SITE NUMBER.
 *
 * Every STC figure here is what the assembly achieved in a laboratory with no
 * flanking path. Built work does about five points worse as a matter of
 * routine, and far worse than that if anything connects the two rooms around
 * the wall — a continuous ceiling void, back-to-back sockets, a gap under the
 * door. The findings quote the laboratory figure and then say this, rather than
 * predicting a number the building will not achieve.
 */

import {
  ASHRAE_NOISE_SOURCE,
  FACADE_SHADOW_DB,
  IBC_DWELLING_SEPARATION,
  WHO_NIGHT_INDOOR,
  glazingStc,
  noiseCriterion,
  outdoorNoise,
  reverbTarget,
  transmissionSpec,
} from '@/code/acoustics';
import { acousticsFor, addDecibels, speechAverage, type ReverbResult } from './roomAcoustics';
import { findRegions } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { roomPurpose } from './rooms';
import { frontEdgeOf } from '@/building/site';
import { registerAirflows, roomAirflows } from './ductSize';
import type { BuildingLoad } from './manualJ';
import type { SystemSelection } from './manualS';
import type { DesignDocument, Point2 } from '@/state/types';

/* -------------------------------- Findings -------------------------------- */

export type AcousticSeverity = 'violation' | 'caution' | 'advice' | 'pass';

export interface AcousticFinding {
  id: string;
  severity: AcousticSeverity;
  /** The section, or empty when this is the app's own guidance. */
  section: string;
  /** Which book the section is in. 'none' prints as "Guidance". */
  authority: 'IBC' | 'ASHRAE' | 'WHO' | 'none';
  title: string;
  detail: string;
  remedy: string;
  topic: 'reverberation' | 'privacy' | 'mechanical' | 'outside';
  /** The room it is about, where it is about one. */
  roomKey?: string;
}

export interface AcousticReport {
  findings: AcousticFinding[];
  rooms: ReverbResult[];
  /** Nothing here can make a design non-compliant; this is "nothing to flag". */
  clean: boolean;
}

/* --------------------------------- Helpers -------------------------------- */

const round1 = (value: number) => Math.round(value * 10) / 10;

/* ---------------------------------- Run ----------------------------------- */

export function checkAcoustics(
  doc: DesignDocument,
  load: BuildingLoad | null = null,
  selection: SystemSelection | null = null,
): AcousticReport {
  const findings: AcousticFinding[] = [];
  const rooms = doc.levels.flatMap((level) => acousticsFor(doc, level.id));

  reverberationFindings(rooms, findings);
  privacyFindings(doc, findings);
  mechanicalFindings(doc, rooms, load, selection, findings);
  outsideFindings(doc, rooms, findings);

  return {
    findings,
    rooms,
    clean: !findings.some((finding) => finding.severity !== 'pass' && finding.severity !== 'advice'),
  };
}

/* ------------------------------ Reverberation ----------------------------- */

/**
 * Rooms that ring, and rooms that are dead.
 *
 * Both are faults and only one of them gets talked about. A room below its
 * range is oppressive in a way people describe as "stuffy" without knowing
 * why — it is why a bedroom with carpet, curtains, a bed and a wardrobe can
 * feel airless before anybody opens a window.
 */
function reverberationFindings(rooms: ReverbResult[], findings: AcousticFinding[]): void {
  for (const room of rooms) {
    // Below this a room is too small for a reverberation time to be a
    // meaningful description of it: the modes are so far apart that the
    // statistical assumption behind Sabine does not hold at all.
    if (room.volume < 12) continue;

    const target = reverbTarget(room.purpose);
    const rt = room.midRt60;

    if (rt > target.max) {
      const dominant = room.dominant;
      const hardest = room.surfaces
        .filter((surface) => surface.area > 1)
        .sort((a, b) => speechAverage(a.sabins) / a.area - speechAverage(b.sabins) / b.area)[0];

      findings.push({
        id: `reverb-long-${room.roomKey}`,
        severity: rt > target.max * 1.5 ? 'caution' : 'advice',
        section: '',
        authority: 'none',
        topic: 'reverberation',
        roomKey: room.roomKey,
        title: `${room.name} will ring`,
        detail:
          `${round1(rt)} s at speech frequencies, against a comfortable ${target.min}–${target.max} s for this kind of room. `
          + `${target.why} `
          + (hardest
            ? `The ${hardest.label.toLowerCase()} is the most reflective surface in it, at ${round1(hardest.area)} m². `
            : '')
          + (dominant
            ? `Most of what absorption there is comes from the ${dominant.label.toLowerCase()}.`
            : 'There is very little absorption in the room at all.'),
        remedy:
          'Soft furnishing is the cheap answer and it works: a rug over a hard floor, '
          + 'lined curtains, upholstered seating. If the room has to stay hard — a kitchen, '
          + 'a bathroom — the ceiling is the surface nobody touches and the one with the '
          + 'most area going spare.',
      });
    } else if (rt > 0.05 && rt < target.min) {
      findings.push({
        id: `reverb-short-${room.roomKey}`,
        severity: 'advice',
        section: '',
        authority: 'none',
        topic: 'reverberation',
        roomKey: room.roomKey,
        title: `${room.name} may feel dead`,
        detail:
          `${round1(rt)} s, below the ${target.min}–${target.max} s this kind of room usually wants. `
          + 'A room with almost no reverberation reads as oppressive rather than as quiet — '
          + 'people describe it as stuffy and reach for a window.',
        remedy:
          'Nothing needs doing unless it bothers you. A hard surface somewhere — a mirror, '
          + 'a glazed door, a wooden floor in part of the room — gives it back some life.',
      });
    }

    /*
     * The bass ratio, which is the fault a single figure hides entirely.
     *
     * A carpet and soft furnishing kill the top end and do very little at
     * 125 Hz. The result has a perfectly respectable mid-band reverberation
     * time and rings in the bass, and everybody who uses the room calls it
     * boomy while the number says it is fine.
     */
    if (room.bassRatio > 1.6 && rt > 0.2) {
      findings.push({
        id: `reverb-boom-${room.roomKey}`,
        severity: 'advice',
        section: '',
        authority: 'none',
        topic: 'reverberation',
        roomKey: room.roomKey,
        title: `${room.name} will sound boomy`,
        detail:
          `The bass rings ${round1(room.bassRatio)} times as long as the mid — `
          + `${round1((room.rt60[0] ?? 0))} s at 125 Hz against ${round1(rt)} s at speech frequencies. `
          + 'That is the signature of soft furnishing over hard structure: carpets and curtains '
          + 'absorb the top end well and the bottom end hardly at all. It is heard as muddiness '
          + 'rather than as echo, and one averaged figure hides it completely.',
        remedy:
          'Bass needs depth, not softness — thick absorption in the corners, an open bookcase '
          + 'along one wall, or a suspended ceiling with a void behind it. Adding more carpet '
          + 'makes the ratio worse, not better.',
      });
    }
  }
}

/* --------------------------------- Privacy -------------------------------- */

/**
 * Walls between rooms that need privacy and rooms that make noise.
 *
 * The IBC finding is carried deliberately even though it applies to nothing in
 * a detached house, because it is the number everybody has heard of. Saying
 * "the code that requires STC 50 governs the wall between two apartments, and
 * your house has no such wall" is more useful than silence, which reads as
 * approval.
 */
function privacyFindings(doc: DesignDocument, findings: AcousticFinding[]): void {
  const partition = transmissionSpec(doc.acoustics.partitionId);

  /** Rooms somebody sleeps or concentrates in. */
  const quiet = new Set(['bedroom']);
  /** Rooms that generate noise all evening. */
  const loud = new Set(['living', 'dining', 'kitchen', 'laundry']);

  let sensitivePairs = 0;

  for (const level of doc.levels) {
    const regions = findRegions(level.plan);
    const purposeOf = new Map(
      regions.map((region) => [
        region.key,
        roomPurpose(resolveRoomSpec(level.plan, region.key).name),
      ]),
    );

    // A wall shared by two regions is a party wall between them. The region
    // key already names its bounding walls, so the pairing falls out.
    const byWall = new Map<string, string[]>();
    for (const region of regions) {
      for (const wallId of region.wallIds) {
        const list = byWall.get(wallId) ?? [];
        list.push(region.key);
        byWall.set(wallId, list);
      }
    }

    for (const [, keys] of byWall) {
      if (keys.length !== 2) continue;
      const [a, b] = keys as [string, string];
      const purposeA = purposeOf.get(a);
      const purposeB = purposeOf.get(b);
      if (!purposeA || !purposeB) continue;

      const sensitive =
        (quiet.has(purposeA) && loud.has(purposeB)) || (quiet.has(purposeB) && loud.has(purposeA));
      if (!sensitive) continue;
      sensitivePairs += 1;
    }
  }

  if (sensitivePairs === 0) return;

  const walls = sensitivePairs === 1 ? 'One wall' : `${sensitivePairs} walls`;

  if (partition.stc < 45) {
    findings.push({
      id: 'privacy-partition',
      severity: partition.stc < 38 ? 'caution' : 'advice',
      section: '',
      authority: 'none',
      topic: 'privacy',
      title: `${walls} between a bedroom and a living space`,
      detail:
        `The partition specified is a ${partition.label.toLowerCase()}, about STC ${partition.stc} `
        + 'in a laboratory. At that figure a television next door is audible as words, not as a murmur. '
        + 'Built work does around five points worse than the laboratory as a matter of routine, and much '
        + 'worse again if anything flanks the wall — a shared ceiling void, back-to-back sockets, '
        + 'or the gap under the door, which is usually the real path.',
      remedy:
        'Batts in the cavity are the cheapest five points there is and cost nothing during '
        + 'construction. A second layer of board each side buys about six more; resilient channel, '
        + 'which breaks the mechanical path rather than adding mass, buys the most of all. '
        + 'Seal the perimeter and do not put sockets back to back.',
    });
  } else {
    findings.push({
      id: 'privacy-partition-ok',
      severity: 'pass',
      section: '',
      authority: 'none',
      topic: 'privacy',
      title: `${walls} between a bedroom and a living space, adequately built`,
      detail: `The partition specified is a ${partition.label.toLowerCase()}, about STC ${partition.stc}. `
        + 'At that figure speech next door is a murmur rather than words.',
      remedy: 'Keep the perimeter sealed and avoid back-to-back sockets, which flank straight past the wall.',
    });
  }

  findings.push({
    id: 'privacy-ibc-scope',
    severity: 'advice',
    section: IBC_DWELLING_SEPARATION.section,
    authority: 'IBC',
    topic: 'privacy',
    title: 'The STC 50 rule does not apply to this building',
    detail:
      `IBC ${IBC_DWELLING_SEPARATION.section} requires STC ${IBC_DWELLING_SEPARATION.stc} between separate `
      + 'DWELLING UNITS — the wall between two apartments. A detached house contains no such wall, so '
      + 'nothing in it is legally required to achieve anything at all acoustically. '
      + 'It is worth saying plainly, because 50 is the number people have heard of and they assume it '
      + 'governs the wall between their bedroom and their living room. It does not, and no code does.',
    remedy:
      'Treat everything in this report as design guidance rather than compliance. '
      + 'If this building is in fact a duplex or a converted flat, the rule does apply and '
      + `an ordinary uninsulated partition is ${IBC_DWELLING_SEPARATION.stc - transmissionSpec(doc.acoustics.partitionId).stc} points short of it.`,
  });
}

/* -------------------------------- Mechanical ------------------------------- */

/**
 * Air noise at the registers, against ASHRAE's own criteria.
 *
 * The cause of a noisy diffuser is almost always the same thing: too much air
 * through too small a grille. The app already knows the airflow at every
 * register because Manual D computed it, so the level follows from the velocity
 * rather than from a guess.
 *
 * The level model is deliberately crude and says so. A register's real sound
 * power depends on its own geometry, which the app does not model — but the
 * SCALING with velocity is not crude at all: aerodynamic noise rises with
 * roughly the sixth power of velocity, which is why doubling the air through a
 * grille is not twice as loud but about eighteen decibels louder.
 */
function mechanicalFindings(
  doc: DesignDocument,
  rooms: ReverbResult[],
  load: BuildingLoad | null,
  selection: SystemSelection | null,
  findings: AcousticFinding[],
): void {
  if (!load || !selection || doc.hvac.registers.length === 0) return;

  const flows = registerAirflows(doc.hvac.registers, roomAirflows(load, selection));
  const byRoom = new Map(rooms.map((room) => [room.roomKey, room]));

  /*
   * Registers grouped by the room they blow into.
   *
   * Supplies only. A return grille moves air too, but it is drawing rather
   * than throwing and it is nothing like as loud for the same volume — the
   * jet noise that makes a diffuser hiss happens on the outlet side.
   */
  const perRoom = new Map<string, number[]>();
  for (const register of doc.hvac.registers) {
    if (register.system !== 'supply') continue;
    const cfm = flows.get(register.id) ?? 0;
    if (cfm <= 0) continue;
    const list = perRoom.get(register.roomKey) ?? [];
    list.push(cfm);
    perRoom.set(register.roomKey, list);
  }

  for (const [roomKey, cfms] of perRoom) {
    const room = byRoom.get(roomKey);
    if (!room) continue;

    const criterion = noiseCriterion(room.purpose);

    /*
     * One register's level from its airflow.
     *
     * Anchored at a quiet reference: a residential register passing 60 cfm
     * through a normally sized grille sits around 25 dBA in the room, which is
     * the figure manufacturers publish and the one an engineer expects. From
     * there the sixth-power law does the work, so the app is asserting a
     * SCALING it can defend and one anchor point it names.
     */
    const levels = cfms.map((cfm) => 25 + 60 * Math.log10(Math.max(cfm, 1) / 60) * (1 / 3));
    const combined = addDecibels(levels);

    if (combined <= criterion.limit) continue;

    findings.push({
      id: `mech-noise-${roomKey}`,
      severity: combined > criterion.limit + 6 ? 'caution' : 'advice',
      section: '',
      authority: 'ASHRAE',
      topic: 'mechanical',
      roomKey,
      title: `The supply air will be audible in ${room.name}`,
      detail:
        `About ${Math.round(combined)} dBA from ${cfms.length === 1 ? 'the register' : `${cfms.length} registers`} `
        + `passing ${Math.round(cfms.reduce((sum, cfm) => sum + cfm, 0))} cfm between them, against `
        + `${criterion.target}–${criterion.limit} dBA recommended for this kind of room. `
        + `${ASHRAE_NOISE_SOURCE}. `
        + 'Grille noise rises with about the sixth power of air velocity, so this is a '
        + 'velocity problem rather than a volume problem: the same air through a larger '
        + 'grille is dramatically quieter.',
      remedy:
        'Use a larger register, or split the room’s air between two of them — halving the '
        + 'velocity through each is worth roughly eighteen decibels. A lined flexible '
        + 'connection at the boot also stops fan noise travelling down the branch as structure-borne sound.',
    });
  }
}

/* --------------------------------- Outside --------------------------------- */

/**
 * What the road does to the rooms that face it.
 *
 * The app knows which plot line is the front, because the setback checks needed
 * it — so it also knows which facade the noise arrives at, and a bedroom at the
 * back of the house is genuinely quieter than one at the front by the acoustic
 * shadow of the building itself.
 *
 * The interesting result is about glazing, and it is counter-intuitive: triple
 * glazing is barely better than double, because three similar panes at similar
 * spacings resonate together. Laminated glass, or two panes of DIFFERENT
 * thickness, beats it comfortably and costs less. Somebody choosing a window
 * for its U-factor is also choosing what the road sounds like, and nothing else
 * in the app would have told them.
 */
function outsideFindings(
  doc: DesignDocument,
  rooms: ReverbResult[],
  findings: AcousticFinding[],
): void {
  const outside = outdoorNoise(doc.acoustics.outdoorNoiseId);
  const stc = glazingStc(doc.hvac.envelope.glazingId);

  const front = frontFacadeNormal(doc);
  const byKey = new Map(rooms.map((room) => [room.roomKey, room]));

  for (const level of doc.levels) {
    for (const region of findRegions(level.plan)) {
      const room = byKey.get(region.key);
      if (!room || room.purpose !== 'bedroom') continue;

      /*
       * Does this room have glazing that looks at the road?
       *
       * Measured by the room's own centre relative to the building's, along the
       * front direction: a bedroom in the front half of the house faces the
       * road, one in the back half is screened by the house itself.
       */
      const hasGlazing = level.plan.walls
        .filter((wall) => region.wallIds.includes(wall.id))
        .some((wall) => wall.openings.some((opening) => opening.kind === 'window'));
      if (!hasGlazing) continue;

      const facing = front ? facesFront(region.polygon, doc, front) : true;
      const atFacade = outside.dba - (facing ? 0 : FACADE_SHADOW_DB);

      /*
       * Through the glazing. The STC is a speech-frequency average and traffic
       * noise is weighted to the bass, where every window does worse — so the
       * conventional allowance is to take about five points off the STC when
       * the source is road traffic rather than speech.
       */
      const inside = atFacade - (stc - 5);

      if (inside <= WHO_NIGHT_INDOOR.dba) continue;

      findings.push({
        id: `outside-bedroom-${region.key}`,
        severity: inside > WHO_NIGHT_INDOOR.dba + 5 ? 'caution' : 'advice',
        section: '',
        authority: 'WHO',
        topic: 'outside',
        roomKey: region.key,
        title: `${room.name} will be noisy at night with the window shut`,
        detail:
          `About ${Math.round(inside)} dBA inside, against the ${WHO_NIGHT_INDOOR.dba} dBA `
          + `${WHO_NIGHT_INDOOR.source} recommends for a bedroom overnight. `
          + `Outside is ${outside.label.toLowerCase()} at ${outside.dba} dBA`
          + (facing ? ' at this facade' : `, less about ${FACADE_SHADOW_DB} dB of screening by the house itself`)
          + `, and the glazing specified is about STC ${stc} — less roughly five points against traffic, `
          + 'which is weighted to the bass where every window performs worse than its speech rating.',
        remedy:
          'Laminated glass is the answer and it is the cheap one: an acoustic interlayer beats '
          + 'triple glazing comfortably and costs less. Triple glazing is barely better than double '
          + 'acoustically — three similar panes at similar spacings resonate together — so a window '
          + 'chosen for its U-factor is not the window to choose for this. '
          + 'Two panes of DIFFERENT thickness also works, for the same reason. '
          + 'Failing that, put the bedroom at the back.',
      });
    }
  }
}

/** Which way the front of the plot faces, as an outward unit vector. */
function frontFacadeNormal(doc: DesignDocument): { x: number; z: number } | null {
  const boundary = doc.site.boundary;
  if (boundary.length < 3) return null;

  const index = frontEdgeOf(boundary, doc.site.setbacks?.frontAt ?? null);
  const a = boundary[index]!;
  const b = boundary[(index + 1) % boundary.length]!;

  const length = Math.hypot(b.x - a.x, b.z - a.z);
  if (length < 1e-6) return null;

  // The edge midpoint relative to the plot centroid gives the outward side
  // without having to know the boundary's winding.
  const centroid = boundary.reduce(
    (sum, point) => ({ x: sum.x + point.x / boundary.length, z: sum.z + point.z / boundary.length }),
    { x: 0, z: 0 },
  );
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const out = { x: mid.x - centroid.x, z: mid.z - centroid.z };
  const outLength = Math.hypot(out.x, out.z);
  if (outLength < 1e-6) return null;

  return { x: out.x / outLength, z: out.z / outLength };
}

/** Whether a room sits in the half of the building that looks at the road. */
function facesFront(
  polygon: readonly Point2[],
  doc: DesignDocument,
  front: { x: number; z: number },
): boolean {
  if (polygon.length === 0) return true;

  const roomCentre = polygon.reduce(
    (sum, point) => ({ x: sum.x + point.x / polygon.length, z: sum.z + point.z / polygon.length }),
    { x: 0, z: 0 },
  );

  // The building's own centre, from the ground storey's rooms.
  const ground = doc.levels[0];
  if (!ground) return true;
  const vertices = ground.plan.vertices;
  if (vertices.length === 0) return true;

  const buildingCentre = vertices.reduce(
    (sum, vertex) => ({ x: sum.x + vertex.x / vertices.length, z: sum.z + vertex.z / vertices.length }),
    { x: 0, z: 0 },
  );

  const offset = { x: roomCentre.x - buildingCentre.x, z: roomCentre.z - buildingCentre.z };
  return offset.x * front.x + offset.z * front.z >= 0;
}
