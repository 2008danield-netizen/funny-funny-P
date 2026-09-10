/**
 * Editing the heating and cooling.
 *
 * Same contract as `plumbingOps`: every function takes a draft document inside
 * `designStore.edit`, changes it, and returns nothing much. Undo is the store's
 * problem.
 *
 * -----------------------------------------------------------------------------
 * ALMOST NOTHING IS STORED.
 *
 * The load, the equipment selection, the duct sizes and the emitter outputs are
 * all derived from the building every time they are asked for. What the
 * document holds is the small set of things that genuinely are decisions: which
 * city, what the envelope is made of, which kind of system, and where the ducts
 * physically run.
 *
 * That is why there is no `setLoad` here and never will be. A stored load is a
 * load that is right until somebody adds a window.
 */

import { calculateLoad, type BuildingLoad } from '@/services/manualJ';
import { selectSystem, type SystemSelection } from '@/services/manualS';
import { routeDucts, resetDuctIds } from '@/services/ducts';
import { layoutHydronic, resetEmitterIds } from '@/services/hydronic';
import { conditionsKey, DESIGN_CONDITIONS, getEquipment } from '@/code/acca';
import type { DesignDocument, HvacSystemKind, Point2 } from './types';

/* ------------------------------- Derivation ------------------------------- */

/**
 * The load, the selection and everything downstream, in one call.
 *
 * Everything that needs any of these needs all of them — the ducts are sized
 * from the selection which is sized from the load — so they are computed
 * together and passed around as one object rather than each caller
 * re-deriving the chain and getting a slightly different answer.
 */
export interface HvacDerived {
  load: BuildingLoad;
  selection: SystemSelection;
}

export function deriveHvac(doc: DesignDocument): HvacDerived {
  const load = calculateLoad(doc);
  const selection = selectSystem(load, doc.hvac.system, {
    heatingEquipmentId: doc.hvac.equipmentManual ? doc.hvac.heatingEquipmentId : null,
    coolingEquipmentId: doc.hvac.equipmentManual ? doc.hvac.coolingEquipmentId : null,
  });
  return { load, selection };
}

/* --------------------------------- Layout --------------------------------- */

export interface HvacRouteResult {
  ducts: number;
  registers: number;
  emitters: number;
  assumptions: string[];
}

/**
 * Lay the whole installation out from scratch.
 *
 * Ductwork for an air system, emitters for a wet one, and nothing at all for a
 * load-only study — the system kind decides, so switching from forced air to
 * hydronic and re-routing genuinely removes the ducts rather than leaving them
 * lying in the model where the drawings would still print them.
 */
export function layoutHvac(doc: DesignDocument): HvacRouteResult {
  const { load, selection } = deriveHvac(doc);

  doc.hvac.ducts = [];
  doc.hvac.registers = [];
  doc.hvac.emitters = [];
  doc.hvac.airHandler = null;

  const assumptions = [...load.assumptions, ...selection.notes];

  if (doc.hvac.system === 'hydronic') {
    const hydronic = layoutHydronic(doc, load, { preferUnderfloor: false });
    doc.hvac.emitters = hydronic.emitters;
    for (const note of hydronic.assumptions) {
      if (!assumptions.includes(note)) assumptions.push(note);
    }
    return { ducts: 0, registers: 0, emitters: hydronic.emitters.length, assumptions };
  }

  const layout = routeDucts(doc, load, selection);
  doc.hvac.ducts = layout.ducts;
  doc.hvac.registers = layout.registers;
  doc.hvac.airHandler = layout.airHandler;

  for (const note of layout.assumptions) {
    if (!assumptions.includes(note)) assumptions.push(note);
  }

  return {
    ducts: layout.ducts.length,
    registers: layout.registers.length,
    emitters: 0,
    assumptions,
  };
}

/** Throws the whole installation away, leaving the envelope and the location. */
export function clearHvac(doc: DesignDocument): void {
  doc.hvac.ducts = [];
  doc.hvac.registers = [];
  doc.hvac.emitters = [];
  doc.hvac.airHandler = null;
}

/** Restarts the id counters, so a test gets the same ids from the same input. */
export function resetHvacCounters(): void {
  resetDuctIds();
  resetEmitterIds();
}

/* -------------------------------- Decisions ------------------------------- */

/**
 * Choose the design location.
 *
 * Rejects anything not in the table rather than storing it, because a key that
 * does not resolve produces a null load, and a null load looks in the UI
 * exactly like "you have not chosen yet" — so a typo would be invisible.
 */
export function setDesignLocation(doc: DesignDocument, key: string): void {
  if (key === '') {
    doc.hvac.locationKey = '';
    return;
  }
  const found = DESIGN_CONDITIONS.find((entry) => conditionsKey(entry) === key);
  if (!found) return;
  doc.hvac.locationKey = key;
}

/**
 * Set one part of the envelope, which un-confirms it.
 *
 * Confirming is a claim about the real building — "these are the numbers, not
 * the app's guesses" — so changing any of those numbers afterwards has to
 * retract the claim. Without that, "confirmed" degrades into "somebody clicked
 * this once", and every check downstream that leans on it is leaning on
 * nothing.
 */
export function setEnvelope(
  doc: DesignDocument,
  patch: Partial<DesignDocument['hvac']['envelope']>,
): void {
  const changed = Object.entries(patch).some(
    ([key, value]) => key !== 'confirmed' && doc.hvac.envelope[key as 'wallAssemblyId'] !== value,
  );
  doc.hvac.envelope = { ...doc.hvac.envelope, ...patch };
  if (changed && patch.confirmed === undefined) doc.hvac.envelope.confirmed = false;
}

/** Mark the envelope as measured rather than assumed, or retract that. */
export function confirmEnvelope(doc: DesignDocument, confirmed: boolean): void {
  doc.hvac.envelope.confirmed = confirmed;
}

/** Change the kind of system, which invalidates whatever was laid out. */
export function setSystemKind(doc: DesignDocument, system: HvacSystemKind): void {
  if (doc.hvac.system === system) return;
  doc.hvac.system = system;
  doc.hvac.equipmentManual = false;
  doc.hvac.heatingEquipmentId = null;
  doc.hvac.coolingEquipmentId = null;
  clearHvac(doc);
}

/**
 * Override the automatic equipment selection.
 *
 * Passing null for both restores the automatic choice, which is the way back
 * from a hand-picked unit — without it the only escape would be changing the
 * system kind and losing the ductwork with it.
 */
export function setEquipment(
  doc: DesignDocument,
  heatingId: string | null,
  coolingId: string | null,
): void {
  if (heatingId === null && coolingId === null) {
    doc.hvac.equipmentManual = false;
    doc.hvac.heatingEquipmentId = null;
    doc.hvac.coolingEquipmentId = null;
    return;
  }

  if (heatingId !== null && !getEquipment(heatingId)) return;
  if (coolingId !== null && !getEquipment(coolingId)) return;

  doc.hvac.equipmentManual = true;
  doc.hvac.heatingEquipmentId = heatingId;
  doc.hvac.coolingEquipmentId = coolingId;
}

/* ------------------------------ Hand editing ------------------------------ */

/** Move the air handler, which does not re-route anything on its own. */
export function moveAirHandler(doc: DesignDocument, at: Point2): void {
  if (!doc.hvac.airHandler) return;
  doc.hvac.airHandler = { ...doc.hvac.airHandler, at };
}

/** Move one point of one duct run, and mark that run as hand-edited. */
export function moveDuctPoint(doc: DesignDocument, runId: string, index: number, at: Point2): void {
  const run = doc.hvac.ducts.find((duct) => duct.id === runId);
  if (!run) return;
  const point = run.points[index];
  if (!point) return;

  run.points[index] = { ...point, at };
  run.manual = true;
}

/** Move a register within its room. The branch that feeds it follows on reroute. */
export function moveRegister(doc: DesignDocument, registerId: string, at: Point2): void {
  const register = doc.hvac.registers.find((entry) => entry.id === registerId);
  if (!register) return;
  register.at = at;
}

/** Hand a run back to the router. */
export function releaseDuct(doc: DesignDocument, runId: string): void {
  const run = doc.hvac.ducts.find((duct) => duct.id === runId);
  if (run) run.manual = false;
}

/**
 * Delete a duct run and everything hanging off it.
 *
 * Removing a trunk and leaving its branches floating would produce a set of
 * ducts that size correctly and connect to nothing, which is worse than either
 * having them or not.
 */
export function removeDuct(doc: DesignDocument, runId: string): void {
  const doomed = new Set<string>([runId]);
  // Bounded rather than recursive: a hand-edited file can contain a cycle.
  for (let pass = 0; pass < 32; pass += 1) {
    let grew = false;
    for (const duct of doc.hvac.ducts) {
      if (duct.upstreamId && doomed.has(duct.upstreamId) && !doomed.has(duct.id)) {
        doomed.add(duct.id);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const servedIds = new Set(
    doc.hvac.ducts.filter((duct) => doomed.has(duct.id)).flatMap((duct) => duct.serves),
  );

  doc.hvac.ducts = doc.hvac.ducts.filter((duct) => !doomed.has(duct.id));
  doc.hvac.registers = doc.hvac.registers.filter((register) => !servedIds.has(register.id));
}

/** Move an emitter along its wall. */
export function moveEmitter(doc: DesignDocument, emitterId: string, at: Point2): void {
  const emitter = doc.hvac.emitters.find((entry) => entry.id === emitterId);
  if (emitter) emitter.at = at;
}

/** Lay out a hydronic system with underfloor wherever the load allows it. */
export function layoutUnderfloor(doc: DesignDocument, regimeId: string): HvacRouteResult {
  const { load, selection } = deriveHvac(doc);
  const hydronic = layoutHydronic(doc, load, { preferUnderfloor: true, regimeId });

  doc.hvac.ducts = [];
  doc.hvac.registers = [];
  doc.hvac.airHandler = null;
  doc.hvac.emitters = hydronic.emitters;

  const assumptions = [...load.assumptions, ...selection.notes];
  for (const note of hydronic.assumptions) {
    if (!assumptions.includes(note)) assumptions.push(note);
  }

  return { ducts: 0, registers: 0, emitters: hydronic.emitters.length, assumptions };
}
