/**
 * What the building sounds like while you walk through it.
 *
 * -----------------------------------------------------------------------------
 * EVERY SOUND HERE IS AN ANSWER TO A QUESTION THE DESIGN ASKS.
 *
 * That is the test each one had to pass to be in this file, and it is what
 * separates this from adding atmosphere:
 *
 *   FOOTSTEPS say what the floor is. Walking from the hall onto the kitchen
 *   tile and hearing it change is how you find out that the tiled hall you
 *   drew is the noisiest room in the house to move through — which is a real
 *   complaint about real houses and one nobody anticipates from a plan.
 *
 *   THE REVERB says what the room is. It is computed from this room's own
 *   surfaces, so a dining room with a hard floor and a glass wall sounds like
 *   the room where nobody can hear each other, because it is.
 *
 *   THE REGISTER says whether the mechanical design is quiet. The airflow is
 *   the one Manual D computed; the level follows from it. If you can hear the
 *   supply from the bed, the acoustic report has a finding about it and you
 *   have just heard the same thing twice.
 *
 *   OUTSIDE says which side of the house faces the road. Through the glazing
 *   actually specified, so choosing a window for its U-factor and hearing what
 *   that does to the bedroom happens in the same session.
 *
 * Nothing here is a mood. A crackling fire would be atmosphere; it is not in
 * this file, and neither is birdsong.
 *
 * -----------------------------------------------------------------------------
 * AND IT IS DRIVEN BY DISTANCE, NOT BY A TIMER.
 *
 * Footsteps are triggered by how far the walker has actually travelled, not by
 * a clock. That is the difference between steps that track the walking and
 * steps that drift out of phase with it the moment somebody slows down at a
 * doorway — and it costs nothing, because the walker already reports where it
 * is.
 */

import { AudioEngine } from './AudioEngine';
import { airVoiceFor, footstepTimbre } from './voices';
import { speechAverage, acousticsFor, type ReverbResult } from '@/services/roomAcoustics';
import { floorAbsorptionId } from '@/services/roomAcoustics';
import { glazingStc, outdoorNoise, FACADE_SHADOW_DB } from '@/code/acoustics';
import { findRegions } from '@/scene/planGraph';
import { resolveRoomSpec } from '@/state/planOps';
import { pointInPolygon } from '@/physics/collision';
import { elevationOf } from '@/state/levels';
import { registerAirflows, roomAirflows } from '@/services/ductSize';
import { calculateLoad } from '@/services/manualJ';
import { selectSystem } from '@/services/manualS';
import type { SoundSettings } from '@/state/selection';
import type { Standing } from '@/walk/ground';
import type { DesignDocument, Point2 } from '@/state/types';

/**
 * How far somebody walks between footfalls, in metres.
 *
 * An average adult stride is about 750 mm, so a footfall every 750 mm of
 * travel. Running lengthens the stride rather than merely speeding it up,
 * which is why this is scaled by speed rather than left constant — a person
 * hurrying does not take the same steps faster, they take longer ones.
 */
const STRIDE = 0.75;

/** Below this the walker is standing still and takes no steps. */
const MOVING_SPEED = 0.15;

/** How far the mechanical beds can be heard from. Beyond this, not worth a node. */
const MECHANICAL_RANGE = 9;

/** And how many registers may sound at once, nearest first. */
const MAX_REGISTERS = 3;

export interface WalkSnapshot {
  at: Point2;
  eyeY: number;
  heading: number;
  speed: number;
  standing: Standing;
}

/**
 * What the live state says is happening, in the shape this file needs.
 *
 * A flat snapshot rather than a reference to `LiveState`, so the soundscape can
 * be driven by a test without constructing the walkthrough. It is also the
 * honest boundary: this module needs to know what is running and what has just
 * changed, and nothing else.
 */
export interface LiveSnapshot {
  /** Fixture ids whose taps are running. */
  runningTaps: ReadonlySet<string>;
  /** Device ids of lit fittings. Not sounded, but part of the same state. */
  litFittings: ReadonlySet<string>;
}

/** One thing that happened this frame and wants a sound. */
export interface SoundEvent {
  kind: 'door' | 'switch' | 'drawer' | 'tap';
  at: { x: number; y: number; z: number };
}

export class Soundscape {
  readonly engine = new AudioEngine();

  private settings: SoundSettings;
  /** Distance travelled since the last footfall, metres. */
  private sinceStep = 0;
  /** Where the feet were last frame, to measure how far they actually went. */
  private lastAt: Point2 | null = null;
  /** Which foot, so the two alternate in pitch rather than being identical. */
  private foot = 0;
  /** The room key the listener was in, to know when the reverb must change. */
  private roomKey = '';

  /** Cached per document identity — deriving this every frame would be silly. */
  private cachedFor: DesignDocument | null = null;
  private rooms: ReverbResult[] = [];
  private registerLevels = new Map<string, number>();

  constructor(settings: SoundSettings) {
    this.settings = settings;
  }

  /** What the soundscape currently believes, for diagnosing a stuck setting. */
  get current(): SoundSettings {
    return this.settings;
  }

  setSettings(settings: SoundSettings): void {
    this.settings = settings;
    this.engine.setVolume(settings.volume);
    this.engine.setMuted(settings.muted);
  }

  /** Starts the context. Must be called from a real user gesture. */
  async start(): Promise<boolean> {
    const running = await this.engine.start();
    this.engine.setVolume(this.settings.volume);
    this.engine.setMuted(this.settings.muted);
    return running;
  }

  /** Everything off, for leaving the walkthrough. */
  stop(): void {
    this.engine.silence();
    this.sinceStep = 0;
    this.lastAt = null;
    this.roomKey = '';
  }

  dispose(): void {
    void this.engine.dispose();
  }

  /* ------------------------------ Derived state ---------------------------- */

  /**
   * Re-derives the acoustic model when the document changes, and not otherwise.
   *
   * Reverberation is a function of the whole room — every surface, every piece
   * of furniture — and computing it for the whole building sixty times a second
   * would be absurd. It changes when the design changes, so it is keyed on the
   * document's identity, which the store replaces on every edit.
   */
  private refresh(doc: DesignDocument): void {
    if (this.cachedFor === doc) return;
    this.cachedFor = doc;

    this.rooms = doc.levels.flatMap((level) => acousticsFor(doc, level.id));

    /*
     * The airflow at each register, which is what decides how loud it is.
     *
     * Wrapped rather than assumed: a design with no location has no load, and a
     * load computed for the wrong climate would be a silent wrong answer. No
     * load means no mechanical bed, which is the honest outcome.
     */
    this.registerLevels = new Map();
    try {
      if (doc.hvac.locationKey && doc.hvac.registers.length > 0) {
        const load = calculateLoad(doc);
        const selection = selectSystem(load, doc.hvac.system, {
          heatingEquipmentId: doc.hvac.heatingEquipmentId,
          coolingEquipmentId: doc.hvac.coolingEquipmentId,
        });
        this.registerLevels = registerAirflows(doc.hvac.registers, roomAirflows(load, selection));
      }
    } catch {
      // A load that cannot be computed is not an audio problem. The HVAC panel
      // is where that gets reported; here it simply means silence.
      this.registerLevels = new Map();
    }
  }

  /* --------------------------------- A frame ------------------------------- */

  /**
   * Advances the soundscape.
   *
   * Called from the walkthrough's own frame, after the walker has moved, with
   * whatever happened this frame. Returns nothing: sound never asks for a
   * redraw, and coupling it to the frame budget would be the wrong dependency.
   */
  update(
    doc: DesignDocument,
    walk: WalkSnapshot,
    live: LiveSnapshot,
    events: readonly SoundEvent[],
  ): void {
    if (!this.engine.running) return;
    this.refresh(doc);

    const ear = { x: walk.at.x, y: walk.eyeY, z: walk.at.z };
    this.engine.setListener({ ...ear, heading: walk.heading });

    this.applyRoom(doc, walk);
    this.applyFootsteps(doc, walk);
    this.applyEvents(events);
    this.applyBeds(doc, live, ear);
    this.applyOutside(doc, walk);
  }

  /* ------------------------ Used from the orbit view ------------------------ */

  /**
   * One sound, from outside the walkthrough.
   *
   * The Use tool works in the ordinary view as well, and a door that swings
   * open in silence up there while the same door latches audibly from inside
   * would be a strange inconsistency. This is the path for that: a real click
   * is a user gesture, so the context can legitimately start here.
   *
   * The room is not computed. Standing at an orbit camera you are not IN a
   * room — you are usually outside the building looking down at it — so the
   * event gets a short generic tail rather than the acoustics of a room the
   * listener is not in.
   */
  async playFromOrbit(
    listener: { x: number; y: number; z: number; heading: number },
    event: SoundEvent,
  ): Promise<void> {
    if (!this.settings.interactions) return;
    if (!(await this.start())) return;

    this.engine.setListener(listener);
    if (this.roomKey !== 'orbit') {
      this.engine.setRoom('orbit', [0.35, 0.3, 0.25, 0.2, 0.16, 0.12], 250);
      this.roomKey = 'orbit';
    }

    this.applyEvents([event]);
  }

  /* ---------------------------------- Room --------------------------------- */

  /** Which room the listener is standing in, by region key. */
  private roomAt(doc: DesignDocument, walk: WalkSnapshot): ReverbResult | null {
    const level = doc.levels.find((entry) => entry.id === walk.standing.levelId);
    if (!level) return null;

    for (const region of findRegions(level.plan)) {
      if (!pointInPolygon(walk.at, region.polygon)) continue;
      return this.rooms.find((room) => room.roomKey === region.key) ?? null;
    }
    return null;
  }

  private applyRoom(doc: DesignDocument, walk: WalkSnapshot): void {
    if (!this.settings.reverb) {
      // A flat, near-silent response rather than tearing the convolver out of
      // the graph: rebuilding the graph on a checkbox is how clicks happen.
      this.engine.setRoom('dry', [0.01, 0.01, 0.01, 0.01, 0.01, 0.01], 400);
      this.roomKey = 'dry';
      return;
    }

    const room = this.roomAt(doc, walk);

    if (!room) {
      /*
       * Outside, or in a space with no enclosing region.
       *
       * Deliberately not silence: standing in the garden there is still a
       * faint ground reflection, and a dead switch from "room" to "nothing"
       * at the front door is far more noticeable than a very short tail.
       */
      if (this.roomKey !== 'outdoors') {
        this.engine.setRoom('outdoors', [0.4, 0.3, 0.25, 0.2, 0.15, 0.1], 200);
        this.roomKey = 'outdoors';
      }
      return;
    }

    if (room.roomKey === this.roomKey) return;
    this.roomKey = room.roomKey;
    this.engine.setRoom(room.roomKey, room.rt60, speechAverage(room.sabins));
  }

  /* -------------------------------- Footsteps ------------------------------ */

  /**
   * Which timbre the surface underfoot has.
   *
   * A stair is its own case and not a floor finish at all: a tread is a short
   * board fixed at both ends over a large open void, and it is the loudest
   * thing in most houses to walk on whatever is laid on it.
   */
  private footVoice(doc: DesignDocument, walk: WalkSnapshot): string {
    if (walk.standing.kind === 'stair') return 'step-stair-timber';

    const level = doc.levels.find((entry) => entry.id === walk.standing.levelId);
    if (!level) return 'step-floor-wood';

    for (const region of findRegions(level.plan)) {
      if (!pointInPolygon(walk.at, region.polygon)) continue;
      const spec = resolveRoomSpec(level.plan, region.key);
      return `step-${floorAbsorptionId(spec.floor.presetId)}`;
    }

    // Outside the building: the ground, which is neither of the three.
    return 'step-floor-hard';
  }

  private applyFootsteps(doc: DesignDocument, walk: WalkSnapshot): void {
    /*
     * MEASURED FROM THE POSITION, NOT FROM THE SPEED.
     *
     * The first version integrated `speed × delta`, which is the same number
     * right up until it is not. The walker reports the speed it INTENDED; the
     * collision solver decides where it actually ended up. Walk into a wall and
     * the two diverge completely — speed stays at walking pace, the position
     * does not move, and you hear yourself striding on the spot.
     *
     * Taking the difference between this frame's feet and last frame's is both
     * the honest reading and a simpler one, and it is what "driven by distance"
     * was always supposed to mean.
     */
    const previous = this.lastAt;
    this.lastAt = { x: walk.at.x, z: walk.at.z };

    if (!this.settings.footsteps) return;

    const travelled = previous
      ? Math.hypot(walk.at.x - previous.x, walk.at.z - previous.z)
      : 0;

    if (walk.speed < MOVING_SPEED && travelled < 1e-4) {
      /*
       * Reset to most of a stride when standing.
       *
       * Not to zero: starting from zero means the first step of every walk
       * comes three quarters of a metre after setting off, which feels like a
       * lag. Starting most of the way through means the first footfall lands
       * almost immediately, which is what happens when a person starts walking.
       */
      this.sinceStep = STRIDE * 0.8;
      return;
    }

    this.sinceStep += travelled;

    // A longer stride when hurrying, rather than the same stride faster: that
    // is what people actually do, and the difference is audible.
    const stride = STRIDE * (1 + Math.max(0, walk.speed - 1.4) * 0.25);
    if (this.sinceStep < stride) return;
    this.sinceStep -= stride;

    this.foot = 1 - this.foot;

    const voiceId = this.footVoice(doc, walk);
    const timbre = footstepTimbre(voiceId.replace('step-', ''));

    /*
     * The variation is here rather than in the synthesis.
     *
     * Two feet are not the same length and no two steps land identically, so a
     * few percent of pitch and level either way is what stops a walk sounding
     * like a metronome. Keeping it at playback means the rendered buffers stay
     * deterministic and therefore testable.
     */
    const rate = this.foot === 0 ? 0.97 : 1.04;
    const harder = Math.min(1.3, 0.75 + walk.speed * 0.25);

    this.engine.play(
      voiceId,
      // At the feet, not at the ear. A footstep heard from head height is a
      // footstep somebody else is taking.
      { x: walk.at.x, y: walk.standing.y + 0.05, z: walk.at.z },
      /*
       * Louder than it first looks like it should be, for two reasons.
       *
       * A footstep is a transient a few milliseconds long, and a transient is
       * heard as far quieter than its peak — measured against a running tap on
       * the master bus it came out about twenty times lower, which in a house
       * with the heating on is inaudible.
       *
       * And it is your own foot. The distance law is doing the right thing for
       * a point source a metre and a half below your ears, and your own
       * footsteps do not reach you that way: they arrive through the floor and
       * up your own legs as well as through the air.
       */
      timbre.level * harder * 1.2,
      rate,
    );
  }

  /* --------------------------------- Events -------------------------------- */

  private applyEvents(events: readonly SoundEvent[]): void {
    if (!this.settings.interactions) return;

    for (const event of events) {
      switch (event.kind) {
        case 'door':
          this.engine.play('latch', event.at, 0.7, 0.95 + Math.random() * 0.1);
          break;
        case 'switch':
          this.engine.play('switch', event.at, 0.5);
          break;
        case 'drawer':
          this.engine.play('drawer', event.at, 0.55, 0.95 + Math.random() * 0.12);
          break;
        case 'tap':
          // The tap's own click. The water that follows is a bed, opened by
          // `applyBeds` from the live state, because it continues after the
          // event that started it.
          this.engine.play('switch', event.at, 0.35, 0.8);
          break;
      }
    }
  }

  /* ---------------------------------- Beds --------------------------------- */

  /**
   * Everything continuous: running taps, air at the registers, the air handler.
   *
   * Declared rather than commanded — the whole set that should be open is
   * computed and handed to the engine, which works out what to start and stop.
   * That way a tap turned off while you were in another room is not still
   * running when you come back, and nothing has to remember to close anything.
   */
  private applyBeds(
    doc: DesignDocument,
    live: LiveSnapshot,
    ear: { x: number; y: number; z: number },
  ): void {
    const wanted = new Set<string>();

    /* ------------------------------- Taps -------------------------------- */

    if (this.settings.interactions) {
      for (const fixture of doc.fixtures) {
        if (!live.runningTaps.has(fixture.id)) continue;

        const base = elevationOf(doc, fixture.levelId);
        const at = { x: fixture.at.x, y: base + fixture.y + 0.9, z: fixture.at.z };
        const key = `tap-${fixture.id}`;
        wanted.add(key);
        this.engine.openBed(key, 'water', at, 0.5);
      }
    }

    /* ---------------------------- Mechanical ------------------------------ */

    if (this.settings.mechanical && this.registerLevels.size > 0) {
      /*
       * The nearest few supply registers, and only the ones within earshot.
       *
       * A house has a dozen registers and they are inaudible from two rooms
       * away — each one is a node with a panner and an HRTF convolution on it,
       * so opening them all would be paying for a dozen sources to hear three.
       */
      const candidates = doc.hvac.registers
        .filter((register) => register.system === 'supply')
        .map((register) => {
          const base = elevationOf(doc, register.levelId);
          const at = { x: register.at.x, y: base + register.height, z: register.at.z };
          return {
            register,
            at,
            distance: Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z),
            cfm: this.registerLevels.get(register.id) ?? 0,
          };
        })
        .filter((entry) => entry.cfm > 1 && entry.distance <= MECHANICAL_RANGE)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_REGISTERS);

      for (const entry of candidates) {
        const key = `air-${entry.register.id}`;
        wanted.add(key);
        /*
         * Level from airflow, with the sixth-power law in it.
         *
         * Aerodynamic noise at a grille rises with roughly the sixth power of
         * velocity, which is why doubling the air through a register is not
         * twice as loud but about eighteen decibels louder. Expressed in
         * amplitude here rather than decibels, hence the cube.
         */
        const ratio = entry.cfm / 90;
        const level = Math.min(1, Math.pow(ratio, 3)) * 0.35;
        this.engine.openBed(key, airVoiceFor(entry.cfm), entry.at, level);
      }

      /* -------------------------- The air handler ------------------------- */

      const handler = doc.hvac.airHandler;
      if (handler) {
        const base = elevationOf(doc, handler.levelId);
        const at = { x: handler.at.x, y: base + 0.9, z: handler.at.z };
        const distance = Math.hypot(at.x - ear.x, at.y - ear.y, at.z - ear.z);

        if (distance <= MECHANICAL_RANGE * 1.5) {
          wanted.add('handler');
          this.engine.openBed('handler', 'hum', at, 0.3);
        }
      }
    }

    this.engine.keepOnly(wanted);
  }

  /* --------------------------------- Outside ------------------------------- */

  /**
   * Traffic, through the wall and through the glazing actually specified.
   *
   * The interesting part is the difference between the two. A wall is around
   * STC 39 and a window around STC 30, so the window is the hole: in a room
   * with any glazing at all, essentially everything you hear from the road came
   * through the glass. That is why the remedy in the acoustic report is about
   * glazing and not about insulation, and hearing it makes the point better
   * than reading it.
   */
  private applyOutside(doc: DesignDocument, walk: WalkSnapshot): void {
    if (!this.settings.outside) {
      this.engine.setOutside(0);
      return;
    }

    const outside = outdoorNoise(doc.acoustics.outdoorNoiseId);
    const level = doc.levels.find((entry) => entry.id === walk.standing.levelId);
    if (!level) {
      this.engine.setOutside(0);
      return;
    }

    const region = findRegions(level.plan).find((entry) =>
      pointInPolygon(walk.at, entry.polygon),
    );

    /* ---- Outdoors: the full level, unattenuated ---- */

    if (!region) {
      this.engine.setOutside(this.levelToGain(outside.dba));
      return;
    }

    /* ---- Indoors: through whichever envelope this room has ---- */

    const bounding = new Set(region.wallIds);
    let glazedArea = 0;
    for (const wall of level.plan.walls) {
      if (!bounding.has(wall.id)) continue;
      for (const opening of wall.openings) {
        if (opening.kind === 'window') glazedArea += opening.width * opening.height;
      }
    }

    /*
     * A room with no window to the outside hears the road through the wall and
     * then through whatever is between it and the facade — which is to say,
     * barely at all. Rather than model the path, this takes the wall's own
     * transmission loss and adds the screening of the house itself, which is
     * the right order of magnitude for an internal room.
     */
    const stc = glazedArea > 0 ? glazingStc(doc.hvac.envelope.glazingId) : 39 + FACADE_SHADOW_DB;

    // Traffic is weighted to the bass, where every assembly does worse than its
    // speech-frequency rating. Five points is the conventional allowance.
    const inside = outside.dba - (stc - 5);
    this.engine.setOutside(this.levelToGain(inside));
  }

  /**
   * A sound pressure level to a playback gain.
   *
   * Anchored so that the loudest case the app models — standing outside beside
   * a city street at 70 dBA — is a comfortable full-scale rather than a
   * clipping one, and 30 dBA is nearly inaudible, which is what 30 dBA is.
   * Twenty decibels is a factor of ten in amplitude, hence the exponent.
   */
  private levelToGain(dba: number): number {
    if (dba <= 20) return 0;
    return Math.min(0.5, Math.pow(10, (dba - 70) / 20) * 0.5);
  }
}
