/**
 * Applying the advisor's suggestions.
 *
 * -----------------------------------------------------------------------------
 * THE GUARANTEE THIS FILE MAKES.
 *
 * Every fix goes through the ordinary editing operations in
 * `state/furnitureOps.ts` — the same ones a mouse drag goes through. Nothing
 * here writes an item's `x`, `z` or `rotation` directly, and it would be a
 * serious mistake to start: doing so bypasses the collision solver, the room
 * containment test and the clearance enforcement, and would let the advisor
 * produce a layout the app itself refuses to let a person create.
 *
 * That is not a theoretical concern. A "helpful" suggestion that pushes a bed
 * halfway into a wall is far worse than no suggestion, because the user cannot
 * tell which of the app's guarantees still hold afterwards.
 * -----------------------------------------------------------------------------
 *
 * Applying is also ATOMIC from the user's point of view: the whole fix happens
 * inside one `designStore.edit`, so one press of Ctrl+Z puts everything back,
 * including a `moveMany` that shifted six dining chairs.
 */

import {
  moveFurniture,
  placeFurniture,
  removeFurniture,
  rotateFurniture,
} from '@/state/furnitureOps';
import { setRoomSpec } from '@/state/planOps';
import { getCatalogEntry } from '@/furniture/catalog';
import type { DesignDocument, Level } from '@/state/types';
import type { Fix } from './types';

export interface FixResult {
  applied: boolean;
  /** What happened, for the status line. Always set when `applied` is false. */
  message: string;
  /** IDs worth selecting afterwards, so the user can see what moved. */
  touched: string[];
}

/**
 * Applies a fix to a draft document.
 *
 * Call inside `designStore.edit`. Returns a result rather than throwing,
 * because "the layout moved on since the advice was computed" is an ordinary
 * outcome — the report is recomputed continuously while the user drags, and a
 * button can always be pressed a moment after it stopped being valid.
 */
export function applyFix(doc: DesignDocument, level: Level, fix: Fix): FixResult {
  switch (fix.kind) {
    case 'move': {
      const item = level.furniture.find((candidate) => candidate.id === fix.itemId);
      if (!item) return miss();

      // Rotation first: `moveFurniture` solves collisions at the item's
      // CURRENT angle, so turning afterwards could sweep it into something the
      // move had carefully avoided.
      if (fix.rotation !== undefined && !rotateFurniture(doc, level, fix.itemId, fix.rotation)) {
        return {
          applied: false,
          message: 'It cannot turn that way where it stands.',
          touched: [fix.itemId],
        };
      }

      const moved = moveFurniture(doc, level, fix.itemId, fix.to, { snapWalls: false });
      return moved.moved
        ? { applied: true, message: '', touched: [fix.itemId] }
        : {
            applied: false,
            message: 'Something is in the way of that position now.',
            touched: [fix.itemId],
          };
    }

    case 'rotate': {
      const turned = rotateFurniture(doc, level, fix.itemId, fix.rotation);
      return turned
        ? { applied: true, message: '', touched: [fix.itemId] }
        : {
            applied: false,
            message: 'There is not enough room to turn it there.',
            touched: [fix.itemId],
          };
    }

    case 'moveMany': {
      /*
       * Chairs round a table are a permutation: every one of them is heading
       * for a spot another one may currently be standing in. Moving them one
       * at a time therefore fails on the first collision even though the final
       * arrangement is perfectly legal.
       *
       * So they are lifted out of the document first — which is exactly what
       * happens physically when you set a table — and then placed back. Any
       * that will not fit are restored where they were, so a partial failure
       * leaves the room tidy rather than half-rearranged.
       */
      const originals = new Map(
        fix.moves.map((move) => {
          const item = level.furniture.find((candidate) => candidate.id === move.itemId);
          return [move.itemId, item ? { ...item } : null];
        }),
      );

      const ids = new Set(fix.moves.map((move) => move.itemId));
      const lifted = level.furniture.filter((item) => ids.has(item.id));
      level.furniture = level.furniture.filter((item) => !ids.has(item.id));

      const touched: string[] = [];
      let failures = 0;

      for (const move of fix.moves) {
        const original = originals.get(move.itemId);
        if (!original) continue;

        const placed = { ...original, x: move.to.x, z: move.to.z };
        if (move.rotation !== undefined) placed.rotation = move.rotation;
        level.furniture.push(placed);

        // Validate through the ordinary move path: pushing it onto the array
        // above put it somewhere untested, and this is what tests it.
        const settled = moveFurniture(doc, level, move.itemId, move.to, { snapWalls: false });
        if (!settled.moved) {
          level.furniture = level.furniture.filter((item) => item.id !== move.itemId);
          level.furniture.push({ ...original });
          failures += 1;
        } else {
          touched.push(move.itemId);
        }
      }

      // Anything the fix did not mention goes back untouched.
      for (const item of lifted) {
        if (!fix.moves.some((move) => move.itemId === item.id)) level.furniture.push(item);
      }

      if (touched.length === 0) {
        return { applied: false, message: 'None of them will fit there now.', touched: [] };
      }
      return {
        applied: true,
        message:
          failures > 0
            ? `Moved ${touched.length}; ${failures} would not fit.`
            : '',
        touched,
      };
    }

    case 'add': {
      const result = placeFurniture(doc, level, fix.catalogId, fix.at, {
        rotation: fix.rotation,
        // The position was chosen deliberately; do not let wall snapping move it.
        snapWalls: false,
      });
      return result.id
        ? { applied: true, message: '', touched: [result.id] }
        : {
            applied: false,
            message: result.reason ?? 'There is no room for it there.',
            touched: [],
          };
    }

    case 'remove': {
      const exists = level.furniture.some((item) => item.id === fix.itemId);
      if (!exists) return miss();
      removeFurniture(level, fix.itemId);
      return { applied: true, message: '', touched: [] };
    }

    case 'swap': {
      const item = level.furniture.find((candidate) => candidate.id === fix.itemId);
      if (!item) return miss();

      const original = { ...item };
      const { x, z, rotation } = original;

      removeFurniture(level, fix.itemId);
      const result = placeFurniture(doc, level, fix.toCatalogId, { x, z }, {
        rotation,
        snapWalls: false,
      });

      if (!result.id) {
        // Put the original back rather than leaving a hole where a piece was.
        level.furniture.push(original);
        const entry = getCatalogEntry(fix.toCatalogId);
        return {
          applied: false,
          message: `The ${entry.name} will not fit in that spot.`,
          touched: [fix.itemId],
        };
      }

      // Carry the confirmed price across only if it was confirmed for the SAME
      // product; a price the user looked up for one rug says nothing about
      // another one.
      return { applied: true, message: '', touched: [result.id] };
    }

    case 'paint': {
      const before = level.plan.rooms[fix.roomKey];
      setRoomSpec(level.plan, fix.roomKey, {
        wall: {
          color: fix.color,
          // Keep the finish the user chose; only the colour is being advised.
          roughness: before?.wall.roughness ?? level.plan.defaultRoom.wall.roughness,
        },
      });
      return { applied: true, message: '', touched: [] };
    }

    case 'furnish':
      // Handled by the panel, which opens the generator so the user picks a
      // budget and a style rather than having a room filled with a guess.
      return {
        applied: false,
        message: 'Open the furnish controls to choose a style and a budget.',
        touched: [],
      };
  }
}

function miss(): FixResult {
  return {
    applied: false,
    message: 'That piece is no longer in the design.',
    touched: [],
  };
}

/** Whether a fix is applied by `applyFix` at all, or handed to the UI. */
export function isDirectlyApplicable(fix: Fix): boolean {
  return fix.kind !== 'furnish';
}
