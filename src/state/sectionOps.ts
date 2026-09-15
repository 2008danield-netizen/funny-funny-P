/**
 * Placing and editing the section cuts.
 *
 * Same contract as every other ops file: take a draft inside `designStore.edit`,
 * change it, return nothing much. Undo is the store's problem.
 *
 * -----------------------------------------------------------------------------
 * THE PRESETS REGENERATE. A CUT SOMEBODY DREW DOES NOT.
 *
 * The same rule the pipe and duct routers follow, for the same reason: an app
 * that helpfully moves somebody's correction is an app they stop correcting. So
 * the two automatic cuts — one the long way through the house, one across it —
 * are recomputed whenever the building changes shape, and anything drawn by
 * hand is left exactly where it was put, even if the building moves out from
 * under it.
 */

import { SECTION_LIMITS, type DesignDocument, type Point2, type SectionCut } from './types';
import { outerBoundaries } from '@/scene/planGraph';

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `sec${counter}`;
};

/** Restarts section ids, so a test gets the same ids from the same input. */
export function resetSectionIds(): void {
  counter = 0;
}

/* -------------------------------- The marks ------------------------------- */

/**
 * The next free mark: A, B, C…
 *
 * Marks are what tie the arrow on the floor plan to the sheet the section is
 * drawn on, so two cuts sharing one is not a cosmetic problem — it makes the
 * set ambiguous. Reusing a mark freed by a deletion is deliberate: a set with
 * sections A, B and D in it invites everybody to go looking for C.
 */
export function nextMark(doc: DesignDocument): string {
  const taken = new Set(doc.sections.map((section) => section.mark));
  for (let i = 0; i < 26; i += 1) {
    const mark = String.fromCharCode(65 + i);
    if (!taken.has(mark)) return mark;
  }
  return String(doc.sections.length + 1);
}

/* -------------------------------- The bounds ------------------------------ */

/** The plan extent of everything built, across every storey. */
export function buildingBounds(
  doc: DesignDocument,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const level of doc.levels) {
    for (const outline of outerBoundaries(level.plan)) {
      for (const point of outline.polygon) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
    }
  }

  return Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;
}

/* -------------------------------- The presets ----------------------------- */

/**
 * The two cuts somebody would draw first.
 *
 * Through the middle each way, running past the building at both ends so the
 * arrowheads and the mark sit in clear space — which is how a section line is
 * drawn on a real plan, and why the line is stored un-clipped.
 *
 * Which one is "longitudinal" follows the building rather than the compass: the
 * long section runs along whichever axis the house is longer in, because that
 * is the drawing that shows the most of it.
 */
export function presetSections(doc: DesignDocument): SectionCut[] {
  const bounds = buildingBounds(doc);
  if (!bounds) return [];

  const over = SECTION_LIMITS.overshoot;
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midZ = (bounds.minZ + bounds.maxZ) / 2;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;

  const alongX: SectionCut = {
    id: 'preset-long',
    mark: 'A',
    name: width >= depth ? 'Long section' : 'Cross section',
    from: { x: bounds.minX - over, z: midZ },
    to: { x: bounds.maxX + over, z: midZ },
    looks: 'left',
    automatic: true,
  };

  const alongZ: SectionCut = {
    id: 'preset-cross',
    mark: 'B',
    name: width >= depth ? 'Cross section' : 'Long section',
    from: { x: midX, z: bounds.minZ - over },
    to: { x: midX, z: bounds.maxZ + over },
    looks: 'left',
    automatic: true,
  };

  return width >= depth ? [alongX, alongZ] : [alongZ, alongX];
}

/**
 * Puts the two presets in, or brings the existing ones back into the middle.
 *
 * Called whenever the section panel is opened and whenever the plan changes, so
 * an automatic cut follows the building. Hand-drawn cuts are untouched.
 */
export function refreshPresets(doc: DesignDocument): void {
  const presets = presetSections(doc);
  const manual = doc.sections.filter((section) => !section.automatic);

  if (presets.length === 0) {
    doc.sections = manual;
    return;
  }

  /*
   * The marks are re-assigned after the manual cuts so that a hand-drawn
   * section keeps the mark it was given. Somebody has looked at "Section C" on
   * a printed sheet; renumbering it because the building grew would be worse
   * than the presets taking later letters.
   */
  const taken = new Set(manual.map((section) => section.mark));
  let next = 0;
  const freeMark = (): string => {
    while (next < 26) {
      const mark = String.fromCharCode(65 + next);
      next += 1;
      if (!taken.has(mark)) return mark;
    }
    return '?';
  };

  doc.sections = [...presets.map((preset) => ({ ...preset, mark: freeMark() })), ...manual];
}

/* -------------------------------- Editing --------------------------------- */

/** Draws a new cut by hand. Returns its id, or null if the line was too short. */
export function addSection(
  doc: DesignDocument,
  from: Point2,
  to: Point2,
  looks: 'left' | 'right' = 'left',
): string | null {
  if (Math.hypot(to.x - from.x, to.z - from.z) < SECTION_LIMITS.minLength) return null;

  // Once, not twice: two calls happen to agree today because nothing has been
  // pushed between them, which is exactly the kind of accidental correctness
  // that breaks the moment somebody reorders these lines.
  const mark = nextMark(doc);
  const id = nextId();

  doc.sections.push({
    id,
    mark,
    name: `Section ${mark}`,
    from,
    to,
    looks,
    automatic: false,
  });
  return id;
}

/**
 * Moves one end of a cut, which makes it a hand-drawn one.
 *
 * Dragging an automatic cut is somebody saying where they want it, so it stops
 * being automatic at that moment rather than snapping back to the middle the
 * next time the plan changes.
 */
export function moveSectionEnd(
  doc: DesignDocument,
  id: string,
  end: 'from' | 'to',
  at: Point2,
): void {
  const section = doc.sections.find((entry) => entry.id === id);
  if (!section) return;

  const other = end === 'from' ? section.to : section.from;
  if (Math.hypot(at.x - other.x, at.z - other.z) < SECTION_LIMITS.minLength) return;

  section[end] = at;
  section.automatic = false;
}

/** Slides the whole cut sideways, keeping its direction. */
export function moveSection(doc: DesignDocument, id: string, delta: Point2): void {
  const section = doc.sections.find((entry) => entry.id === id);
  if (!section) return;

  section.from = { x: section.from.x + delta.x, z: section.from.z + delta.z };
  section.to = { x: section.to.x + delta.x, z: section.to.z + delta.z };
  section.automatic = false;
}

/** Looks the other way, which is a completely different drawing. */
export function flipSection(doc: DesignDocument, id: string): void {
  const section = doc.sections.find((entry) => entry.id === id);
  if (section) section.looks = section.looks === 'left' ? 'right' : 'left';
}

export function renameSection(doc: DesignDocument, id: string, name: string): void {
  const section = doc.sections.find((entry) => entry.id === id);
  if (section) section.name = name.slice(0, 120);
}

export function removeSection(doc: DesignDocument, id: string): void {
  doc.sections = doc.sections.filter((section) => section.id !== id);
}

export function clearSections(doc: DesignDocument): void {
  doc.sections = [];
}
