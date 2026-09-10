/**
 * Manual D: how much air each room gets, and how big the duct has to be.
 *
 * -----------------------------------------------------------------------------
 * A DUCT SIZE IS NEVER STORED.
 *
 * The same rule the pipe sizing follows, for the same reason. A duct's
 * diameter is a function of the air passing through it, and the air passing
 * through it changes when a room is added downstream, when a window is added
 * to a room it feeds, when the equipment is re-selected, or when the design
 * city changes. A stored diameter is a diameter that is right once.
 *
 * So the document stores the route and what it serves; everything numeric
 * here is computed from those on demand.
 *
 * -----------------------------------------------------------------------------
 * HOW A ROOM'S SHARE OF THE AIR IS DECIDED.
 *
 * Proportionally, and TWICE — once for heating and once for cooling, because
 * the two do not distribute the same way at all. A north-facing bedroom is a
 * large share of the heating load and a small share of the cooling load; a
 * west-facing living room with a lot of glass is the reverse. The duct that
 * feeds either of them has to be big enough for whichever season asks for
 * more, so the design airflow is the larger of the two.
 *
 * That means the room airflows add up to MORE than the blower moves, which
 * looks wrong and is not. Every branch is sized for its own worst season, and
 * the balancing dampers are what reconcile them on the day. Sizing every
 * branch for its share of a single season is how you get a house where the
 * bedrooms are cold in January and fine in July.
 *
 * The trunk, though, is capped at what the blower moves — see `accumulateCfm`.
 * A branch may be sized for a flow that only happens in one season; a trunk
 * may not be sized for a flow that happens in no season at all.
 *
 * -----------------------------------------------------------------------------
 * WHY THE VELOCITY CHECK IS ABOUT NOISE.
 *
 * A duct will carry as much air as you push through it. Undersize it and
 * nothing breaks — you simply hear it, as a rush at the register and a roar in
 * the trunk, forever. It is the most common complaint about a system that is
 * otherwise correctly designed, and it is completely avoidable at design time,
 * which is why it is checked here rather than left to the installer.
 */

import {
  DUCT_SECTION,
  VELOCITY_LIMITS,
  ductForCfm,
  velocityInDuct,
  type DuctSize,
} from '@/code/acca';
import type { BuildingLoad, RoomLoad } from './manualJ';
import type { SystemSelection } from './manualS';
import type { DesignDocument, DuctRun, Register } from '@/state/types';

/* ------------------------------ Room airflow ------------------------------ */

/** What one room needs, in each season and overall. */
export interface RoomAirflow {
  roomKey: string;
  roomName: string;
  levelId: string;
  /** Share of the blower's air the heating case asks for, cfm. */
  heatingCfm: number;
  coolingCfm: number;
  /** The larger of the two — what the branch is actually sized for. */
  designCfm: number;
}

/**
 * Every room's share of the air.
 *
 * Empty when there is no equipment, because there is no blower and therefore
 * no air to share out. That is a real state — a load-only study — rather than
 * a failure.
 */
export function roomAirflows(load: BuildingLoad, selection: SystemSelection): RoomAirflow[] {
  if (selection.supplyCfm <= 0) return [];

  const heatingTotal = load.heatingTotal;
  const coolingTotal = load.coolingSensible;

  return load.rooms.map((room: RoomLoad) => {
    const heatingCfm =
      heatingTotal > 0 ? selection.supplyCfm * (room.heatingTotal / heatingTotal) : 0;
    const coolingCfm =
      coolingTotal > 0 ? selection.supplyCfm * (room.coolingSensible / coolingTotal) : 0;

    return {
      roomKey: room.roomKey,
      roomName: room.roomName,
      levelId: room.levelId,
      heatingCfm,
      coolingCfm,
      designCfm: Math.max(heatingCfm, coolingCfm),
    };
  });
}

/** The airflow at each register, sharing a room's air between its registers. */
export function registerAirflows(
  registers: readonly Register[],
  airflows: readonly RoomAirflow[],
): Map<string, number> {
  const byRoom = new Map(airflows.map((flow) => [flow.roomKey, flow]));

  // How many supply registers each room has, so a room with two gets half in
  // each rather than the full amount twice.
  const counts = new Map<string, number>();
  for (const register of registers) {
    if (register.system !== 'supply') continue;
    counts.set(register.roomKey, (counts.get(register.roomKey) ?? 0) + 1);
  }

  const result = new Map<string, number>();
  for (const register of registers) {
    if (register.system === 'supply') {
      const flow = byRoom.get(register.roomKey);
      const share = counts.get(register.roomKey) ?? 1;
      result.set(register.id, flow ? flow.designCfm / share : 0);
    } else {
      /*
       * A return does not have a load of its own. It carries back whatever the
       * supplies on its storey delivered, because in a sealed house the air
       * that goes in has to come out — and this is precisely the arithmetic
       * people skip, which is how a bedroom with a supply and no return ends
       * up pressurising and pushing its own conditioned air out through the
       * walls.
       */
      const onLevel = airflows.filter((flow) => flow.levelId === register.levelId);
      const levelTotal = onLevel.reduce((sum, flow) => sum + flow.designCfm, 0);
      const returnsHere = registers.filter(
        (other) => other.system === 'return' && other.levelId === register.levelId,
      ).length;
      result.set(register.id, returnsHere > 0 ? levelTotal / returnsHere : levelTotal);
    }
  }

  return result;
}

/* ------------------------------- Duct sizing ------------------------------ */

export type DuctRole = 'trunk' | 'branch' | 'riser';

export interface SizedDuct {
  run: DuctRun;
  role: DuctRole;
  /** Everything flowing through this run, cfm. */
  cfm: number;
  size: DuctSize;
  /** Air speed at that size, feet per minute. */
  velocity: number;
  /** The noise limit this run was measured against. */
  velocityLimit: number;
  withinVelocity: boolean;
  /** Developed length, metres — the run as built, risers included. */
  length: number;
  section: string;
}

/** What kind of duct this is, from its shape rather than a stored label. */
export function ductRole(run: DuctRun): DuctRole {
  const levels = new Set(run.points.map((point) => point.levelId));
  if (levels.size > 1) return 'riser';
  return run.upstreamId === null ? 'trunk' : 'branch';
}

/** Length of a duct run in metres, counting the vertical parts. */
export function ductLength(doc: DesignDocument, run: DuctRun): number {
  let total = 0;
  for (let i = 1; i < run.points.length; i += 1) {
    const a = run.points[i - 1]!;
    const b = run.points[i]!;
    const plan = Math.hypot(b.at.x - a.at.x, b.at.z - a.at.z);
    const rise = elevationOf(doc, b.levelId) + b.height - (elevationOf(doc, a.levelId) + a.height);
    total += Math.hypot(plan, rise);
  }
  return total;
}

/** Height of a level's finished floor above the site datum. */
function elevationOf(doc: DesignDocument, levelId: string): number {
  let elevation = 0;
  for (const level of doc.levels) {
    if (level.id === levelId) return elevation;
    elevation += level.wallHeight + level.slabThickness;
  }
  return elevation;
}

/**
 * The air flowing in every run, accumulated up the tree from the registers.
 *
 * Walked from the leaves rather than from the air handler, because that is the
 * direction the information actually flows: a trunk carries what its branches
 * carry, and a branch carries what its registers take. Doing it the other way
 * round means guessing at the split, which is the thing this file exists to
 * avoid guessing at.
 */
export function accumulateCfm(
  ducts: readonly DuctRun[],
  registerCfm: ReadonlyMap<string, number>,
  systemCfm = Infinity,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const run of ducts) {
    let own = 0;
    for (const registerId of run.serves) own += registerCfm.get(registerId) ?? 0;
    totals.set(run.id, own);
  }

  /*
   * Push each run's own load up through its ancestors. Depth-limited rather
   * than recursive so that a corrupt document with a cycle in it — which a
   * hand-edited JSON file can absolutely contain — cannot hang the app.
   */
  const byId = new Map(ducts.map((run) => [run.id, run]));
  for (const run of ducts) {
    let own = 0;
    for (const registerId of run.serves) own += registerCfm.get(registerId) ?? 0;
    if (own === 0) continue;

    let parentId = run.upstreamId;
    for (let depth = 0; depth < 32 && parentId; depth += 1) {
      const parent = byId.get(parentId);
      if (!parent) break;
      totals.set(parent.id, (totals.get(parent.id) ?? 0) + own);
      parentId = parent.upstreamId;
    }
  }

  /*
   * Cap every run at what the blower actually moves.
   *
   * A guard rather than a fix for anything observed. Each BRANCH is sized for
   * its own worst season, so the branch airflows can add up to more than the
   * system moves — a north bedroom's January share plus a west living room's
   * July share is not a quantity of air that exists at any one moment. The
   * TRUNK carries what the fan delivers, and the fan delivers one number, so
   * summing the branches into it would size it for a flow that is physically
   * impossible.
   *
   * In practice the sum has come out equal to the system airflow on every
   * house tried, because the same season dominates in every room of a simple
   * plan and that season's shares sum to exactly one. It is a plan with real
   * variety of orientation — a north bedroom and a west living room in the
   * same house — that separates them, and this is here so that plan gets the
   * right trunk rather than a size up.
   */
  if (Number.isFinite(systemCfm)) {
    for (const [id, cfm] of totals) totals.set(id, Math.min(cfm, systemCfm));
  }

  return totals;
}

/** Every duct in the document, with its airflow, size and velocity. */
export function sizeAllDucts(
  doc: DesignDocument,
  load: BuildingLoad,
  selection: SystemSelection,
): SizedDuct[] {
  const airflows = roomAirflows(load, selection);
  const registerCfm = registerAirflows(doc.hvac.registers, airflows);
  const totals = accumulateCfm(doc.hvac.ducts, registerCfm, selection.supplyCfm);

  return doc.hvac.ducts.map((run) => {
    const role = ductRole(run);
    const cfm = totals.get(run.id) ?? 0;
    const size = ductForCfm(cfm);
    const velocity = velocityInDuct(cfm, size.inches);
    const limit =
      role === 'branch'
        ? VELOCITY_LIMITS.branch.feetPerMinute
        : VELOCITY_LIMITS.trunk.feetPerMinute;

    return {
      run,
      role,
      cfm,
      size,
      velocity,
      velocityLimit: limit,
      withinVelocity: velocity <= limit,
      length: ductLength(doc, run),
      section: DUCT_SECTION,
    };
  });
}

/* -------------------------------- Totals ---------------------------------- */

export interface DuctTotals {
  supplyRuns: number;
  returnRuns: number;
  registers: number;
  returns: number;
  /** Total duct, metres. */
  length: number;
  /** The largest duct in the house, which is what has to fit somewhere. */
  largestInches: number;
  /** Air the blower moves, cfm. */
  supplyCfm: number;
}

export function ductTotals(sized: readonly SizedDuct[], doc: DesignDocument): DuctTotals {
  let supplyRuns = 0;
  let returnRuns = 0;
  let length = 0;
  let largestInches = 0;

  for (const duct of sized) {
    if (duct.run.system === 'supply') supplyRuns += 1;
    else returnRuns += 1;
    length += duct.length;
    largestInches = Math.max(largestInches, duct.size.inches);
  }

  return {
    supplyRuns,
    returnRuns,
    registers: doc.hvac.registers.filter((register) => register.system === 'supply').length,
    returns: doc.hvac.registers.filter((register) => register.system === 'return').length,
    length,
    largestInches,
    supplyCfm: sized
      .filter((duct) => duct.run.system === 'supply' && duct.run.upstreamId === null)
      .reduce((sum, duct) => sum + duct.cfm, 0),
  };
}
