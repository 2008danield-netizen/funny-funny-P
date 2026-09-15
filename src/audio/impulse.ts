/**
 * The reverb you hear is the reverb the numbers predict.
 *
 * -----------------------------------------------------------------------------
 * WHY NOT A PRESET.
 *
 * Every game and every DAW ships a handful of reverb presets — small room,
 * hall, cathedral — and picking one by eye would sound perfectly convincing
 * here. It would also be the one thing this app must not do, because the whole
 * argument of the last session was that a real light source tells you the
 * corner is dark and a brightness knob cannot.
 *
 * The same applies here, more strongly. A preset called "bathroom" tells you a
 * bathroom sounds like a bathroom. An impulse response generated from THIS
 * room's volume and THIS room's surfaces tells you that the dining room you
 * have designed, with its tiled floor and its glass wall, will be the room
 * where nobody can hear each other — which is a real and common design fault,
 * and one you would otherwise discover after the table arrives.
 *
 * So the convolver is fed a response synthesised from the six band reverb times
 * that `services/roomAcoustics` computed. Change the floor finish and the sound
 * of the room changes, because the absorption changed.
 *
 * -----------------------------------------------------------------------------
 * HOW AN IMPULSE RESPONSE IS MADE.
 *
 * A room's response to a perfect click is, to a very good approximation, noise
 * that decays exponentially. That is what reverberation IS: thousands of
 * reflections arriving so densely that they stop being individual echoes and
 * become a wash that fades.
 *
 * So: fill a buffer with noise, multiply it by a decaying envelope, done. The
 * only subtlety is that the decay rate has to differ per frequency band, and
 * that is the entire point — a carpeted room with hard walls decays quickly at
 * 4 kHz and slowly at 125 Hz, which is heard as boominess and is exactly what a
 * single-figure reverb preset cannot represent.
 *
 * Doing that properly means filtering. This module does it by SUMMING BANDS:
 * generate one decaying noise layer per octave band, band-limit each with a
 * simple one-pole pair, and add them with their own decay rates. Crude next to
 * a real filterbank, and it puts the energy in the right places, which is what
 * is being asked of it.
 *
 * -----------------------------------------------------------------------------
 * PURE ON PURPOSE.
 *
 * Nothing in this file touches the Web Audio API. It takes numbers and returns
 * Float32Arrays, which means the part most likely to be quietly wrong — an
 * envelope that decays to the wrong level, a buffer that is the wrong length —
 * is tested in the ordinary suite rather than by listening to it and hoping.
 */

import { BANDS, type BandValues } from '@/code/acoustics';

/** Two channels of samples, ready to be handed to a convolver. */
export interface ImpulseResponse {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  /** How long it actually is, in seconds. */
  duration: number;
}

/*
 * The tail is carried for exactly one RT60 and no further.
 *
 * RT60 is by definition the time to fall 60 dB, which is a factor of a
 * thousand in amplitude — inaudible under anything else in the scene. Past
 * that point the buffer is silence that still costs a multiply per sample on
 * every convolved frame.
 */

/** Never generate more than this, however long the room rings. */
const MAX_SECONDS = 4;

/** Nor less than this: a convolver with three samples in it is a click. */
const MIN_SECONDS = 0.05;

/**
 * A small deterministic noise source.
 *
 * Deterministic so that the same room gives the same impulse every time the app
 * runs — a reverb that differs between two visits to the same room would be a
 * very confusing bug to chase, and `Math.random` would do exactly that. Also
 * makes the tests meaningful.
 *
 * Mulberry32: small, fast, and good enough for noise nobody will analyse.
 */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // To -1..1 rather than 0..1: noise with a DC offset is not noise, it is
    // noise plus a thump.
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/**
 * The decay multiplier for one sample step, given a reverb time.
 *
 * RT60 is a fall of 60 dB, which is a factor of 1000 in amplitude. So the
 * per-sample factor is 10^(-3/(rt·sampleRate)) — and writing it that way rather
 * than as an approximation is why the tests can check the envelope really is
 * 60 dB down after exactly RT60 seconds.
 */
export function decayPerSample(rt60: number, sampleRate: number): number {
  if (rt60 <= 0) return 0;
  return Math.pow(10, -3 / (rt60 * sampleRate));
}

/**
 * A one-pole band-pass, as a pair of coefficients.
 *
 * Genuinely crude — a single pole either side gives a gentle 6 dB/octave skirt
 * rather than anything an acoustician would call an octave band. It is the
 * right trade here: the job is to put each decay rate roughly where it belongs
 * in the spectrum, not to measure anything, and a proper filterbank would be
 * six biquads per channel running over a four-second buffer.
 */
function onePole(cutoff: number, sampleRate: number): number {
  const x = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  return Math.max(0, Math.min(0.9999, x));
}

/**
 * Builds a room's impulse response from its per-band reverb times.
 *
 * `rt60` is the six-band array from `reverbTime`, in the order of `BANDS`.
 */
export function buildImpulse(
  rt60: BandValues,
  sampleRate: number,
  seed = 20240916,
): ImpulseResponse {
  const longest = Math.max(...rt60, 0);
  const duration = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, longest));
  const length = Math.max(1, Math.round(duration * sampleRate));

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  /*
   * One noise layer per band, each with its own decay.
   *
   * The two channels get different noise, which is what makes the tail sound
   * like a room rather than like a mono reverb played through two speakers.
   * The ENVELOPES are shared, because the decay of a room is a property of the
   * room and not of which ear you listen with.
   */
  for (let band = 0; band < BANDS.length; band += 1) {
    const centre = BANDS[band]!;
    const time = rt60[band] ?? 0;
    if (time <= 0) continue;

    const decay = decayPerSample(time, sampleRate);

    // A band-pass as a low-pass minus the band below it. Roughly an octave
    // wide, which is what we are after.
    const highCut = onePole(Math.min(centre * 1.4, sampleRate * 0.45), sampleRate);
    const lowCut = onePole(Math.min(centre * 0.7, sampleRate * 0.45), sampleRate);

    const rngL = noise(seed + band * 7919);
    const rngR = noise(seed + band * 7919 + 104729);

    let lowL = 0;
    let highL = 0;
    let lowR = 0;
    let highR = 0;
    let envelope = 1;

    for (let i = 0; i < length; i += 1) {
      const rawL = rngL();
      const rawR = rngR();

      // Two cascaded one-poles, subtracted: the difference between "everything
      // below 1.4f" and "everything below 0.7f" is a band around f.
      highL = highL * highCut + rawL * (1 - highCut);
      lowL = lowL * lowCut + rawL * (1 - lowCut);
      highR = highR * highCut + rawR * (1 - highCut);
      lowR = lowR * lowCut + rawR * (1 - lowCut);

      left[i] = (left[i] ?? 0) + (highL - lowL) * envelope;
      right[i] = (right[i] ?? 0) + (highR - lowR) * envelope;

      envelope *= decay;
    }
  }

  /*
   * A short fade in over the first few milliseconds.
   *
   * A real room's response starts with the direct sound and then a gap before
   * the first reflection arrives — a few milliseconds in a bedroom, tens in a
   * hall. Starting the noise at full amplitude on sample zero puts a click at
   * the front of every convolution, which is heard as a hard edge on everything
   * rather than as a room.
   */
  const fade = Math.min(length, Math.round(sampleRate * 0.004));
  for (let i = 0; i < fade; i += 1) {
    const gain = i / fade;
    left[i] = (left[i] ?? 0) * gain;
    right[i] = (right[i] ?? 0) * gain;
  }

  normalise(left, right);

  return { left, right, sampleRate, duration };
}

/**
 * Scales both channels so the loudest sample is just under full scale.
 *
 * Both by the SAME factor, or the stereo image shifts towards whichever channel
 * happened to have the quieter peak. Done on the pair rather than per channel
 * for exactly that reason.
 */
function normalise(left: Float32Array, right: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    peak = Math.max(peak, Math.abs(left[i] ?? 0), Math.abs(right[i] ?? 0));
  }
  if (peak < 1e-9) return;

  const gain = 0.98 / peak;
  for (let i = 0; i < left.length; i += 1) {
    left[i] = (left[i] ?? 0) * gain;
    right[i] = (right[i] ?? 0) * gain;
  }
}

/**
 * How loud the reverb should be relative to the dry sound.
 *
 * Not a taste knob: it is the reverberant-field level, and it follows from the
 * room's absorption. A dead room returns little energy however long you make
 * its tail, and mixing a normalised impulse at a fixed level would make a
 * carpeted bedroom as wet as a tiled bathroom — the reverb would be shorter but
 * just as loud, which is not what happens.
 *
 * `sabins` is the room's total absorption at speech frequencies. The reverberant
 * level goes as 4/A, so the wet gain follows the square root of that in
 * amplitude terms, clamped to something sane at both ends.
 */
export function reverbMix(sabinsAtSpeech: number): number {
  if (sabinsAtSpeech <= 0.5) return 0.6;
  const level = Math.sqrt(4 / sabinsAtSpeech);
  return Math.max(0.05, Math.min(0.6, level));
}
