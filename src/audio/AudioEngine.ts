/**
 * One Web Audio graph for the whole building.
 *
 * -----------------------------------------------------------------------------
 * IT CANNOT START WITHOUT A CLICK, AND THAT IS NOT A BUG.
 *
 * Every browser refuses to let a page make noise until the person has
 * interacted with it, and it refuses by putting the AudioContext into a
 * "suspended" state rather than by throwing — so an app that ignores this does
 * not crash, it silently produces nothing, and the developer concludes the
 * synthesis is broken.
 *
 * So the context is created lazily on a real gesture and `resume()` is called
 * every time the walkthrough starts, because a context can be suspended again
 * at any point by the browser (a backgrounded tab, an audio device change).
 * Treating that as normal rather than as an error is the whole discipline here.
 *
 * -----------------------------------------------------------------------------
 * BUDGETED, LIKE THE LIGHTS.
 *
 * Session 15 learned this the expensive way: a pool allocated once, reused
 * forever, because creating and destroying nodes mid-frame is what costs. Here
 * it is worse than a stall — every convolver is an FFT running continuously,
 * and a handful of them will take a frame budget on their own.
 *
 * So there is exactly ONE convolver for the room you are in, not one per
 * source, and a fixed number of positional voices. A sound that cannot get a
 * voice is dropped rather than queued: a footstep that arrives late is worse
 * than a footstep that never arrives.
 *
 * -----------------------------------------------------------------------------
 * THE GRAPH.
 *
 *   one-shot ─┐
 *             ├─► panner ─┬─► dry gain ──────────────┐
 *   loop ─────┘           └─► send gain ─► convolver ├─► master ─► out
 *                                                     │
 *   outside bed ────────────► its own gain ───────────┘
 *
 * The outside bed bypasses the room convolver deliberately. Traffic reaching
 * you through a closed window has already been filtered and diffused by the
 * wall; running it through the room's reverb again would double-count the room
 * and make the outdoors sound like it is in the hall.
 */

import { buildImpulse, reverbMix } from './impulse';
import { buildVoices, type Voice } from './voices';
import type { BandValues } from '@/code/acoustics';

/**
 * How many positional one-shots may sound at once.
 *
 * Twelve is far more than a house produces — footsteps are one at a time, and
 * doors and switches are events a person causes one at a time — but a cap that
 * is never reached still has to exist, because the failure mode without one is
 * unbounded node creation on a stuck key.
 */
const MAX_VOICES = 12;

/** How many continuous beds may run: registers, taps, the air handler. */
const MAX_BEDS = 8;

/** One continuous sound, held open until something stops it. */
interface Bed {
  key: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: PannerNode;
}

export interface Listener {
  x: number;
  y: number;
  z: number;
  /** Which way the head faces, radians, 0 looking towards +z. */
  heading: number;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private send: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  /** The outdoor bed's own path, which skips the room reverb. */
  private outsideGain: GainNode | null = null;
  private outsideBed: AudioBufferSourceNode | null = null;

  private voices = buildVoices();
  private buffers = new Map<string, AudioBuffer>();
  private beds = new Map<string, Bed>();
  private playing = 0;
  /** Cumulative one-shots started, so a check can tell quiet from absent. */
  private started = 0;
  private dropped = 0;

  /** What the last impulse was built for, so it is not rebuilt every frame. */
  private impulseKey = '';

  private volume = 0.7;
  private muted = false;

  /** In-line after the master, so it is always pulled — see `buildGraph`. */
  private analyser: AnalyserNode | null = null;
  private meterBuffer: Float32Array<ArrayBuffer> | null = null;

  /* -------------------------------- Lifecycle ------------------------------ */

  get running(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  get state(): string {
    return this.context?.state ?? 'not started';
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  /** How many continuous sounds are open, for the panel to show honestly. */
  get bedCount(): number {
    return this.beds.size;
  }

  /**
   * Counters, for telling "quiet" apart from "nothing happened".
   *
   * A level of zero has at least four causes and they need different fixes: no
   * sound was asked for, the pool was full, the buffer rendered silence, or
   * the gain chain ate it. These separate the first two from the rest.
   */
  get counters(): { started: number; dropped: number; playing: number } {
    return { started: this.started, dropped: this.dropped, playing: this.playing };
  }

  /**
   * Starts, or resumes after the browser suspended it.
   *
   * Safe to call on every walkthrough entry. Returns whether sound is actually
   * running, so the caller can say "click to allow sound" rather than leaving
   * somebody wondering why the house is silent.
   */
  async start(): Promise<boolean> {
    if (!this.context) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;

      try {
        this.context = new Ctor();
      } catch {
        return false;
      }
      this.buildGraph();
    }

    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        return false;
      }
    }

    return this.context.state === 'running';
  }

  private buildGraph(): void {
    const context = this.context;
    if (!context) return;

    this.master = context.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;

    /*
     * The meter sits IN the chain, not beside it.
     *
     * The first version tapped it off the master and left it unconnected
     * downstream, on the reasoning that metering should never be a link in the
     * path carrying the audio. That reasoning is wrong about how Web Audio
     * works: rendering is PULLED from the destination, so a node with no route
     * to the destination is never asked for samples and its analysis buffer
     * stays full of zeros. The meter read silence over a graph that was working
     * perfectly — which is exactly the kind of instrument that is worse than no
     * instrument.
     *
     * An AnalyserNode passes its input through unchanged, so putting it in-line
     * costs one node and changes nothing about what comes out.
     */
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.meterBuffer = new Float32Array(this.analyser.fftSize);

    this.master.connect(this.analyser);
    this.analyser.connect(context.destination);

    this.dry = context.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.master);

    this.convolver = context.createConvolver();
    this.convolver.connect(this.master);

    this.send = context.createGain();
    this.send.gain.value = 0.25;
    this.send.connect(this.convolver);

    this.outsideGain = context.createGain();
    this.outsideGain.gain.value = 0;
    this.outsideGain.connect(this.master);
  }

  /**
   * The level actually coming out, as an RMS of the master bus.
   *
   * Here because "is it working" and "is it configured to work" are different
   * questions, and only one of them can be answered by reading state. A
   * suspended context, a muted master, a voice that rendered silence and a
   * panner pointing the wrong way all look identical from the outside and all
   * produce the same number here: zero.
   *
   * It is also what lets the browser check measure sound rather than assume it.
   * The analyser is attached on first use and left in place; it is one node and
   * it does no work nobody asked for.
   */
  level(): number {
    if (!this.context || !this.analyser) return 0;

    const buffer = this.meterBuffer;
    if (!buffer) return 0;

    this.analyser.getFloatTimeDomainData(buffer);
    let total = 0;
    for (let i = 0; i < buffer.length; i += 1) total += (buffer[i] ?? 0) ** 2;
    return Math.sqrt(total / buffer.length);
  }

  /** How far the context's clock has got, which says whether it is really running. */
  get elapsed(): number {
    return this.context?.currentTime ?? 0;
  }

  /**
   * A snapshot of the graph, for diagnosing silence.
   *
   * Silence has half a dozen causes that look identical from outside — a
   * suspended context, a muted master, an empty convolver, a listener in the
   * wrong place — and chasing them by reasoning rather than by measurement is
   * how an afternoon disappears. This reports the ones worth knowing.
   */
  diagnose(): Record<string, unknown> {
    const context = this.context;
    if (!context) return { context: 'none' };

    return {
      state: context.state,
      sampleRate: context.sampleRate,
      currentTime: +context.currentTime.toFixed(2),
      master: this.master?.gain.value ?? null,
      dry: this.dry?.gain.value ?? null,
      send: this.send?.gain.value ?? null,
      convolver: this.convolver?.buffer ? this.convolver.buffer.length : 0,
      outside: this.outsideGain?.gain.value ?? null,
      analyser: this.analyser ? this.analyser.fftSize : 0,
      listener: context.listener.positionX
        ? {
            x: +context.listener.positionX.value.toFixed(2),
            y: +context.listener.positionY.value.toFixed(2),
            z: +context.listener.positionZ.value.toFixed(2),
          }
        : 'legacy',
      voices: this.voices.size,
      beds: [...this.beds.keys()],
      buffers: [...this.buffers.keys()],
    };
  }

  /* --------------------------------- Settings ------------------------------ */

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /* --------------------------------- The room ------------------------------ */

  /**
   * Points the reverb at the room somebody is standing in.
   *
   * Keyed so that walking about inside one room does no work at all: building a
   * four-second stereo impulse is tens of milliseconds, which would be a
   * visible stutter if it happened on every frame. It happens when the room
   * changes, and the room only changes when you walk through a door.
   */
  setRoom(key: string, rt60: BandValues, sabinsAtSpeech: number): void {
    if (!this.context || !this.convolver || !this.send) return;
    if (key === this.impulseKey) return;
    this.impulseKey = key;

    const response = buildImpulse(rt60, this.context.sampleRate);
    const buffer = this.context.createBuffer(2, response.left.length, this.context.sampleRate);
    /*
     * `getChannelData().set()` rather than `copyToChannel()`.
     *
     * They do the same thing, and only one of them accepts a Float32Array over
     * any ArrayBufferLike — `copyToChannel` is typed to reject one backed by a
     * SharedArrayBuffer, which these never are but which the type system
     * cannot know. `set` takes an ArrayLike and is not fussy.
     */
    buffer.getChannelData(0).set(response.left);
    buffer.getChannelData(1).set(response.right);
    this.convolver.buffer = buffer;

    /*
     * How wet, from the room's absorption rather than from taste.
     *
     * A dead room returns little energy however long its tail; mixing a
     * normalised impulse at a fixed level would make a carpeted bedroom as wet
     * as a tiled bathroom, with a shorter tail but the same loudness. That is
     * not what happens in a real room and it is the thing a preset gets wrong.
     */
    this.send.gain.setTargetAtTime(reverbMix(sabinsAtSpeech), this.context.currentTime, 0.1);
  }

  /** Where the ears are. Called every frame; cheap. */
  setListener(listener: Listener): void {
    const context = this.context;
    if (!context) return;

    const { listener: ears } = context;

    /*
     * `heading` is the walker's, and its convention is that zero looks towards
     * +z — so forward is (sin h, cos h) and NOT (sin(h+π), cos(h+π)).
     *
     * The π is tempting because the camera code has one: `camera.rotateY` is
     * given `heading + π`, since a Three camera looks down its own −z while the
     * walker's heading is measured towards +z. That π belongs to the camera's
     * local axes, not to the heading, and carrying it over here would rotate
     * the entire sound field by half a turn — front behind you, left on the
     * right. Silent, and exactly the kind of thing nobody notices until they
     * walk towards a running tap and it gets quieter.
     */
    const forwardX = Math.sin(listener.heading);
    const forwardZ = Math.cos(listener.heading);

    if (ears.positionX) {
      // The modern interface: AudioParams, which can be ramped rather than
      // jumped. A listener that teleports produces a click on every source.
      const now = context.currentTime;
      const ease = 0.02;
      ears.positionX.setTargetAtTime(listener.x, now, ease);
      ears.positionY.setTargetAtTime(listener.y, now, ease);
      ears.positionZ.setTargetAtTime(listener.z, now, ease);
      ears.forwardX.setTargetAtTime(forwardX, now, ease);
      ears.forwardY.setTargetAtTime(0, now, ease);
      ears.forwardZ.setTargetAtTime(forwardZ, now, ease);
      ears.upX.setTargetAtTime(0, now, ease);
      ears.upY.setTargetAtTime(1, now, ease);
      ears.upZ.setTargetAtTime(0, now, ease);
    } else {
      // Safari and older Chrome. Deprecated, and the only thing that works
      // there — a graph that silently does not pan is worse than a deprecation.
      const legacy = ears as unknown as {
        setPosition: (x: number, y: number, z: number) => void;
        setOrientation: (
          fx: number, fy: number, fz: number,
          ux: number, uy: number, uz: number,
        ) => void;
      };
      legacy.setPosition(listener.x, listener.y, listener.z);
      legacy.setOrientation(forwardX, 0, forwardZ, 0, 1, 0);
    }
  }

  /* --------------------------------- Buffers ------------------------------- */

  /**
   * Renders a voice, once, and keeps it.
   *
   * Synthesis is not free — a six-second outdoor bed is a few million
   * multiplies — so every voice is rendered on first use and cached for the
   * life of the context. The sample seam is here too: a `sample` voice would
   * be fetched instead, and nothing above this line would know.
   */
  private bufferFor(voice: Voice): AudioBuffer | null {
    const context = this.context;
    if (!context) return null;

    const existing = this.buffers.get(voice.id);
    if (existing) return existing;

    if (voice.kind === 'sample') {
      // Nothing ships one yet. Deliberately not a silent fallback: a missing
      // file should be visible in the console rather than sound like a bug in
      // the synthesis.
      console.warn(`[havavamama] sampled voice "${voice.id}" is not loaded`);
      return null;
    }

    const samples = voice.render(context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.getChannelData(0).set(samples);
    this.buffers.set(voice.id, buffer);
    return buffer;
  }

  private panner(): PannerNode | null {
    const context = this.context;
    if (!context) return null;

    const panner = context.createPanner();
    // HRTF rather than equal-power: the difference between "that is to my left"
    // and "that is behind me", which is most of what makes a walkthrough feel
    // like a place. It costs a convolution per source, which is why they are
    // pooled and capped.
    panner.panningModel = 'HRTF';

    /*
     * An inverse distance law with a floor under it.
     *
     * Inverse is the physically correct model and used raw it is unusable: the
     * gain goes to infinity as the distance goes to zero, so standing on top of
     * a register would deafen somebody. `refDistance` is that floor — within a
     * metre the level stops climbing — and a metre is about as close as anybody
     * gets to a tap or a light switch.
     */
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 30;
    panner.rolloffFactor = 1.4;
    return panner;
  }

  /* -------------------------------- One-shots ------------------------------ */

  /**
   * Plays a sound once, at a point in the building.
   *
   * Dropped rather than queued when the pool is full — see the note at the top.
   * `gain` and `rate` are where per-event variation lives: two footsteps differ
   * by a few percent of level and pitch, which is what stops a walk sounding
   * like a machine, and doing it here rather than in the synthesis keeps the
   * rendered buffers testable.
   */
  play(
    voiceId: string,
    at: { x: number; y: number; z: number },
    gain = 1,
    rate = 1,
  ): void {
    const context = this.context;
    if (!context || context.state !== 'running') return;
    if (this.playing >= MAX_VOICES) {
      this.dropped += 1;
      return;
    }

    const voice = this.voices.get(voiceId);
    if (!voice) return;

    const buffer = this.bufferFor(voice);
    if (!buffer) return;

    const panner = this.panner();
    if (!panner) return;

    panner.positionX?.setValueAtTime(at.x, context.currentTime);
    panner.positionY?.setValueAtTime(at.y, context.currentTime);
    panner.positionZ?.setValueAtTime(at.z, context.currentTime);

    const level = context.createGain();
    level.gain.value = Math.max(0, gain);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.5, Math.min(2, rate));

    source.connect(level);
    level.connect(panner);
    panner.connect(this.dry!);
    panner.connect(this.send!);

    this.playing += 1;
    this.started += 1;
    source.onended = () => {
      this.playing -= 1;
      // Disconnecting matters: an orphaned panner keeps its HRTF convolution
      // alive, and a few hundred of them is a real leak in a long session.
      source.disconnect();
      level.disconnect();
      panner.disconnect();
    };

    source.start();
  }

  /* ---------------------------------- Beds --------------------------------- */

  /**
   * Opens a continuous sound at a point, or leaves it alone if already open.
   *
   * Keyed by whatever the caller calls it — a register id, a fixture id — so
   * the soundscape can say "these should be running" every frame and the engine
   * works out what actually needs starting or stopping. Restarting a loop every
   * frame would be a machine-gun of attack transients.
   */
  openBed(key: string, voiceId: string, at: { x: number; y: number; z: number }, gain: number): void {
    const context = this.context;
    if (!context || context.state !== 'running') return;

    const existing = this.beds.get(key);
    if (existing) {
      existing.gain.gain.setTargetAtTime(Math.max(0, gain), context.currentTime, 0.2);
      return;
    }

    if (this.beds.size >= MAX_BEDS) return;

    const voice = this.voices.get(voiceId);
    if (!voice) return;
    const buffer = this.bufferFor(voice);
    if (!buffer) return;

    const panner = this.panner();
    if (!panner) return;
    panner.positionX?.setValueAtTime(at.x, context.currentTime);
    panner.positionY?.setValueAtTime(at.y, context.currentTime);
    panner.positionZ?.setValueAtTime(at.z, context.currentTime);

    const level = context.createGain();
    // Faded up rather than switched on. A loop that starts at full level puts
    // a click at its own beginning, however seamless the buffer is.
    level.gain.value = 0;
    level.gain.setTargetAtTime(Math.max(0, gain), context.currentTime, 0.15);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    source.connect(level);
    level.connect(panner);
    panner.connect(this.dry!);
    panner.connect(this.send!);
    source.start();

    this.beds.set(key, { key, source, gain: level, panner });
  }

  /** Fades a bed out and takes it down. */
  closeBed(key: string): void {
    const context = this.context;
    const bed = this.beds.get(key);
    if (!context || !bed) return;

    this.beds.delete(key);
    bed.gain.gain.setTargetAtTime(0, context.currentTime, 0.12);

    // Stopped after the fade rather than with it, or the fade is a click.
    window.setTimeout(() => {
      try {
        bed.source.stop();
      } catch {
        // Already stopped: the context went away underneath us, which happens
        // on teardown and is not worth reporting.
      }
      bed.source.disconnect();
      bed.gain.disconnect();
      bed.panner.disconnect();
    }, 400);
  }

  /** Every bed not in this set is closed. The soundscape's whole interface. */
  keepOnly(keys: ReadonlySet<string>): void {
    for (const key of [...this.beds.keys()]) {
      if (!keys.has(key)) this.closeBed(key);
    }
  }

  /* -------------------------------- Outside -------------------------------- */

  /**
   * The outdoor bed, which is not positional and not reverberated.
   *
   * Not positional because it is not a point source: traffic arrives through a
   * whole facade at once, and panning it to a spot would make the road sound
   * like a lawnmower in the garden. Not reverberated because it has already
   * been through the wall — running it through the room's own reverb as well
   * would count the room twice.
   */
  setOutside(gain: number): void {
    const context = this.context;
    if (!context || context.state !== 'running' || !this.outsideGain) return;

    if (gain <= 0.0001) {
      this.outsideGain.gain.setTargetAtTime(0, context.currentTime, 0.3);
      return;
    }

    if (!this.outsideBed) {
      const voice = this.voices.get('outside');
      if (!voice) return;
      const buffer = this.bufferFor(voice);
      if (!buffer) return;

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this.outsideGain);
      source.start();
      this.outsideBed = source;
    }

    this.outsideGain.gain.setTargetAtTime(gain, context.currentTime, 0.4);
  }

  /* -------------------------------- Teardown ------------------------------- */

  /** Silences everything without destroying the context. */
  silence(): void {
    for (const key of [...this.beds.keys()]) this.closeBed(key);
    this.setOutside(0);
  }

  async dispose(): Promise<void> {
    this.silence();
    this.buffers.clear();
    this.impulseKey = '';

    const context = this.context;
    this.context = null;
    if (context) {
      try {
        await context.close();
      } catch {
        // Closing an already-closed context throws, and on teardown that is
        // exactly the state it is often in.
      }
    }
  }
}
