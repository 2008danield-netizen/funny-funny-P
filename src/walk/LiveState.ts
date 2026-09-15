/**
 * What is open and what is on, right now.
 *
 * -----------------------------------------------------------------------------
 * NONE OF THIS IS THE DESIGN.
 *
 * A door you left open, a light you switched on, a drawer you pulled out — that
 * is how you left a walkthrough, not what you are building. So it lives here
 * rather than on the document: nothing is saved, nothing is exported, nothing
 * reaches the drawings, and leaving the walkthrough throws it away.
 *
 * The alternative is worse than it first looks. Persist it and an exported file
 * carries which drawers were open, the plan sheets have to decide whether to
 * draw them that way, and "the design" quietly stops meaning one thing.
 *
 * -----------------------------------------------------------------------------
 * EVERYTHING EASES, AND THAT IS NOT DECORATION.
 *
 * A door that snaps from shut to open is a jump cut. In a headset it is worse
 * than that: the thing you are holding teleports, which is exactly the kind of
 * event the inner ear objects to. Half a second of swing costs nothing and is
 * the difference between a door opening and a door being replaced by an open
 * door.
 */

import type { Interactable } from './interactables';

/** How long each thing takes to move, in seconds. */
const DURATION = {
  /** A door is heavy and swings a long way. */
  door: 0.55,
  /** A drawer is light and travels 500 mm. */
  drawer: 0.3,
  cabinet: 0.35,
} as const;

/** One thing part-way between shut and open. */
interface Moving {
  /** Where it is now, 0 shut to 1 open. */
  value: number;
  /** Where it is heading. */
  target: number;
  /** Seconds for a full traverse. */
  duration: number;
}

export interface LiveSummary {
  doorsOpen: number;
  doorsClosed: number;
  lightsOn: number;
  drawersOpen: number;
  tapsRunning: number;
}

export class LiveState {
  private moving = new Map<string, Moving>();
  /** Fittings that are lit, by device id. */
  private lit = new Set<string>();
  /** Taps that are running, by fixture id. */
  private running = new Set<string>();
  /** Switches somebody has flipped, so the panel can say which. */
  private flipped = new Set<string>();

  /**
   * Doors start open, which is what this app has always drawn.
   *
   * Not changed here on purpose: doors are drawn standing open so the floor
   * area their swing needs is visible, and the drawings rely on that. A
   * walkthrough where every door is already open is a slightly duller
   * walkthrough; a drawing that silently stopped showing door swings would be
   * a worse drawing.
   */
  private static initialFor(kind: Interactable['kind']): number {
    return kind === 'door' ? 1 : 0;
  }

  /** How far open something is, 0 to 1. */
  openness(item: Interactable): number {
    return this.moving.get(item.id)?.value ?? LiveState.initialFor(item.kind);
  }

  /** Whether a fitting is lit. */
  isLit(deviceId: string): boolean {
    return this.lit.has(deviceId);
  }

  isRunning(fixtureId: string): boolean {
    return this.running.has(fixtureId);
  }

  /** Every fitting currently lit, for the renderer to place lights at. */
  get litFittings(): string[] {
    return [...this.lit];
  }

  /**
   * What using this thing does, and what to call it next time.
   *
   * Returns the verb for what just happened, which the crosshair shows for a
   * moment — "Opened", "Turned on" — because an action with no acknowledgement
   * leaves people pressing the button again.
   */
  use(item: Interactable): string {
    switch (item.kind) {
      case 'door':
      case 'drawer':
      case 'cabinet-door': {
        const duration =
          item.kind === 'door'
            ? DURATION.door
            : item.kind === 'drawer'
              ? DURATION.drawer
              : DURATION.cabinet;

        const current = this.moving.get(item.id) ?? {
          value: LiveState.initialFor(item.kind),
          target: LiveState.initialFor(item.kind),
          duration,
        };

        // Aim at the opposite of where it is HEADED, not where it is. Hitting
        // a door twice quickly should shut it again, not stall it half open.
        const target = current.target > 0.5 ? 0 : 1;
        this.moving.set(item.id, { ...current, target, duration });
        return target > 0.5 ? 'Opened' : 'Closed';
      }

      case 'switch': {
        /*
         * A switch acts on the fittings it controls rather than on itself, so
         * a room with two switches for one light behaves the way a room does:
         * either of them turns it off.
         */
        const anyOn = item.controls.some((id) => this.lit.has(id));
        for (const id of item.controls) {
          if (anyOn) this.lit.delete(id);
          else this.lit.add(id);
        }

        if (anyOn) this.flipped.delete(item.id);
        else this.flipped.add(item.id);

        if (item.controls.length === 0) return 'Nothing wired to it';
        return anyOn ? 'Turned off' : 'Turned on';
      }

      case 'tap': {
        if (this.running.has(item.id)) {
          this.running.delete(item.id);
          return 'Turned off';
        }
        this.running.add(item.id);
        return 'Turned on';
      }
    }
  }

  /** What the prompt should say before it is used. */
  verbFor(item: Interactable): string {
    switch (item.kind) {
      case 'door':
      case 'drawer':
      case 'cabinet-door':
        return this.openness(item) > 0.5 ? 'Close' : 'Open';
      case 'switch':
        if (item.controls.length === 0) return 'Not wired to a light';
        return item.controls.some((id) => this.lit.has(id)) ? 'Turn off' : 'Turn on';
      case 'tap':
        return this.running.has(item.id) ? 'Turn off' : 'Turn on';
    }
  }

  /**
   * Advances everything that is moving.
   *
   * Returns whether anything changed, so the frame loop knows to keep drawing
   * while a door is still swinging and to stop once it has arrived.
   */
  update(delta: number): boolean {
    let changed = false;

    for (const [id, entry] of this.moving) {
      if (entry.value === entry.target) continue;

      const step = delta / entry.duration;
      const gap = entry.target - entry.value;
      entry.value =
        Math.abs(gap) <= step ? entry.target : entry.value + Math.sign(gap) * step;

      this.moving.set(id, entry);
      changed = true;
    }

    return changed;
  }

  /** Everything back to how the document describes it. */
  reset(): void {
    this.moving.clear();
    this.lit.clear();
    this.running.clear();
    this.flipped.clear();
  }

  summary(items: readonly Interactable[]): LiveSummary {
    let doorsOpen = 0;
    let doorsClosed = 0;
    let drawersOpen = 0;

    for (const item of items) {
      if (item.kind === 'door') {
        if (this.openness(item) > 0.5) doorsOpen += 1;
        else doorsClosed += 1;
      } else if (item.kind === 'drawer' || item.kind === 'cabinet-door') {
        if (this.openness(item) > 0.5) drawersOpen += 1;
      }
    }

    return {
      doorsOpen,
      doorsClosed,
      lightsOn: this.lit.size,
      drawersOpen,
      tapsRunning: this.running.size,
    };
  }
}
