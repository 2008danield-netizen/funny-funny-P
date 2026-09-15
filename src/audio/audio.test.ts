/**
 * Tests for the sound itself.
 *
 * -----------------------------------------------------------------------------
 * THE WHOLE REASON THE SYNTHESIS IS PURE.
 *
 * Nothing in `impulse.ts` or `voices.ts` touches the Web Audio API. They are
 * functions from numbers to sample arrays, and that was a deliberate choice
 * made so this file could exist — because the alternative way to check a
 * footstep is to listen to it, and "it sounds about right to me" is not a
 * regression test.
 *
 * What is pinned here is what a listener would actually notice going wrong:
 *
 *   A step on carpet must have less high-frequency energy than one on tile.
 *   That is the entire claim of material-driven synthesis, and if it inverts,
 *   every floor in the app sounds like the wrong floor and nothing throws.
 *
 *   An envelope must reach silence. A buffer that stops at a non-zero sample
 *   is a click, and a click at the end of every footstep is the kind of defect
 *   that gets described as "the audio sounds cheap" without anybody being able
 *   to say why.
 *
 *   A loop must join to itself. Otherwise the running tap ticks once every two
 *   and a half seconds, forever.
 *
 *   The decay must be 60 dB down after exactly RT60. That is the definition of
 *   RT60, and it is what connects the reverb you hear back to the number the
 *   acoustics service computed — the claim the whole session rests on.
 */

import { describe, expect, it } from 'vitest';

import { buildImpulse, decayPerSample, reverbMix } from './impulse';
import {
  FOOTSTEP_TIMBRES,
  airVoiceFor,
  buildVoices,
  footstepTimbre,
  renderAir,
  renderDrawer,
  renderFootstep,
  renderHum,
  renderLatch,
  renderOutside,
  renderSwitch,
  renderWater,
} from './voices';
import type { BandValues } from '@/code/acoustics';

const RATE = 48000;

/* --------------------------------- Helpers --------------------------------- */

/** Root-mean-square level of a buffer, which is what "loudness" means here. */
function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let total = 0;
  for (let i = from; i < to; i += 1) total += (samples[i] ?? 0) ** 2;
  const count = Math.max(1, to - from);
  return Math.sqrt(total / count);
}

/**
 * How much energy is above roughly a quarter of Nyquist.
 *
 * A one-pole high-pass rather than an FFT: the question being asked is
 * comparative — does carpet have less top end than tile — and a difference
 * operator answers that without pulling in a transform. `y[n] = x[n] - x[n-1]`
 * is a 6 dB/octave high-pass, which is plenty to separate 900 Hz from 7 kHz.
 */
function highEnergy(samples: Float32Array): number {
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const difference = (samples[i] ?? 0) - (samples[i - 1] ?? 0);
    total += difference * difference;
  }
  return Math.sqrt(total / Math.max(1, samples.length - 1));
}

const peak = (samples: Float32Array): number => {
  let highest = 0;
  for (const value of samples) highest = Math.max(highest, Math.abs(value));
  return highest;
};

const flat = (value: number): BandValues => [value, value, value, value, value, value];

/* -------------------------------- Footsteps -------------------------------- */

describe('footsteps, voiced by the floor', () => {
  it('makes a carpeted step duller than a tiled one', () => {
    /*
     * The central claim of synthesising rather than sampling: the sound is a
     * function of the material. A carpet is a porous absorber sitting directly
     * under the shoe and it takes the top end away before it can radiate.
     *
     * If this inverts, every floor in the app sounds like the wrong floor and
     * absolutely nothing fails.
     */
    const tile = renderFootstep(footstepTimbre('floor-hard'), RATE);
    const carpet = renderFootstep(footstepTimbre('floor-carpet'), RATE);

    const brightness = (samples: Float32Array) => highEnergy(samples) / Math.max(1e-9, rms(samples));
    expect(brightness(carpet)).toBeLessThan(brightness(tile));
  });

  it('makes a carpeted step quieter than a tiled one', () => {
    const tile = renderFootstep(footstepTimbre('floor-hard'), RATE);
    const carpet = renderFootstep(footstepTimbre('floor-carpet'), RATE);

    expect(rms(carpet)).toBeLessThan(rms(tile));
  });

  it('gives a timber floor more low-frequency body than tile', () => {
    // A board spanning joists over a void is a drum; a slab is not. That low
    // component is most of what makes a timber floor recognisable, and it is
    // what the neighbour downstairs hears.
    expect(footstepTimbre('floor-wood').body).toBeGreaterThan(
      footstepTimbre('floor-hard').body,
    );
    expect(footstepTimbre('stair-timber').body).toBeGreaterThan(
      footstepTimbre('floor-wood').body,
    );
  });

  it('decays rather than stopping', () => {
    // A buffer that ends on a non-zero sample is a click, and a click at the
    // end of every footstep is heard as cheapness without being identifiable.
    for (const timbre of FOOTSTEP_TIMBRES) {
      const samples = renderFootstep(timbre, RATE);
      const head = rms(samples, 0, Math.round(samples.length * 0.2));
      const tail = rms(samples, Math.round(samples.length * 0.9));

      expect(tail).toBeLessThan(head * 0.1);
      expect(Math.abs(samples[samples.length - 1] ?? 1)).toBeLessThan(1e-6);
    }
  });

  it('is deterministic, so the same floor always sounds the same', () => {
    // Variation between steps is applied at playback — a few percent of level
    // and pitch — precisely so the rendered buffers stay checkable.
    const a = renderFootstep(footstepTimbre('floor-wood'), RATE);
    const b = renderFootstep(footstepTimbre('floor-wood'), RATE);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('stays inside full scale', () => {
    for (const timbre of FOOTSTEP_TIMBRES) {
      expect(peak(renderFootstep(timbre, RATE))).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to a real timbre for a floor it has not heard of', () => {
    expect(footstepTimbre('marshmallow').id).toBeTruthy();
  });
});

/* ------------------------------- The one-shots ----------------------------- */

describe('the things you use', () => {
  it('makes a latch that is two clicks, not one', () => {
    /*
     * The pair is what makes it read as a latch rather than as a tap on wood:
     * the bolt leaving the keeper, then the door meeting the stop about
     * eighteen milliseconds later. Checked by finding two separated peaks in
     * the first fifth of the buffer.
     */
    const samples = renderLatch(RATE);
    const window = Math.round(RATE * 0.004);

    let bursts = 0;
    let quiet = true;
    for (let i = 0; i + window < Math.round(RATE * 0.05); i += window) {
      const loud = rms(samples, i, i + window) > rms(samples) * 0.9;
      if (loud && quiet) bursts += 1;
      quiet = !loud;
    }

    expect(bursts).toBeGreaterThanOrEqual(2);
  });

  it('makes a switch far shorter than a latch', () => {
    // A rocker switch is over in about fifteen milliseconds. Anything longer
    // reads as a plastic object being dropped.
    const switchSamples = renderSwitch(RATE);
    const latchSamples = renderLatch(RATE);
    expect(switchSamples.length).toBeLessThan(latchSamples.length);

    const late = rms(switchSamples, Math.round(switchSamples.length * 0.5));
    const early = rms(switchSamples, 0, Math.round(switchSamples.length * 0.2));
    expect(late).toBeLessThan(early * 0.15);
  });

  it('makes a drawer that travels and then stops', () => {
    /*
     * The stop at the end is what tells you it is fully out, and it is the
     * difference between a drawer and a whoosh. So the last tenth must not be
     * the quietest part of the buffer, even though the travel before it is
     * fading.
     */
    const samples = renderDrawer(RATE);
    const travel = rms(samples, Math.round(samples.length * 0.5), Math.round(samples.length * 0.8));
    const stop = rms(samples, Math.round(samples.length * 0.86), Math.round(samples.length * 0.95));

    expect(stop).toBeGreaterThan(travel * 0.5);
    expect(peak(samples)).toBeLessThanOrEqual(1);
  });
});

/* ---------------------------------- Loops ---------------------------------- */

describe('the continuous beds', () => {
  const loops: ReadonlyArray<[string, (rate: number) => Float32Array]> = [
    ['water', renderWater],
    ['hum', renderHum],
    ['outside', renderOutside],
    ['air', (rate) => renderAir(0.7, rate)],
  ];

  it('joins to itself, so the loop point is not an audible tick', () => {
    /*
     * The single most irritating defect available in this subject area: a
     * running tap that ticks once every two and a half seconds, forever, and
     * is heard as a fault in the app rather than as a fault in the sound.
     *
     * The crossfade makes the head and the tail continuous, so the step across
     * the join must be no larger than the steps within the buffer.
     */
    for (const [name, render] of loops) {
      const samples = render(RATE);
      const join = Math.abs((samples[0] ?? 0) - (samples[samples.length - 1] ?? 0));

      let biggest = 0;
      for (let i = 1; i < samples.length; i += 1) {
        biggest = Math.max(biggest, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)));
      }

      expect(join, `${name} loop join`).toBeLessThanOrEqual(biggest);
    }
  });

  it('is never silent, because a bed that plays nothing is a bug', () => {
    for (const [name, render] of loops) {
      expect(rms(render(RATE)), `${name}`).toBeGreaterThan(0.001);
    }
  });

  it('stays inside full scale', () => {
    for (const [name, render] of loops) {
      expect(peak(render(RATE)), `${name}`).toBeLessThanOrEqual(1);
    }
  });

  it('makes faster air brighter as well as louder', () => {
    /*
     * Grille noise is turbulence, and faster air through the same vanes is not
     * merely louder but higher in pitch — which is why a whistling register is
     * described as hissing rather than as rumbling.
     */
    const slow = renderAir(0.2, RATE);
    const fast = renderAir(1.3, RATE);

    const brightness = (samples: Float32Array) => highEnergy(samples) / Math.max(1e-9, rms(samples));
    expect(brightness(fast)).toBeGreaterThan(brightness(slow));
  });

  it('gives the air handler a real fundamental rather than just noise', () => {
    // A blower is a rotating machine with a blade-pass frequency, and that low
    // tone is what you hear through a floor when the heating comes on.
    const hum = renderHum(RATE);
    const air = renderAir(0.7, RATE);

    // The tonal one has far more energy at the bottom relative to the top.
    const tonal = (samples: Float32Array) => rms(samples) / Math.max(1e-9, highEnergy(samples));
    expect(tonal(hum)).toBeGreaterThan(tonal(air));
  });

  it('picks an air buffer from the airflow', () => {
    expect(airVoiceFor(40)).toBe('air-low');
    expect(airVoiceFor(90)).toBe('air-mid');
    expect(airVoiceFor(150)).toBe('air-high');
  });
});

/* ------------------------------ The impulse -------------------------------- */

describe('the room’s impulse response', () => {
  it('decays by exactly 60 dB in one RT60, which is the definition', () => {
    /*
     * The claim the entire session rests on: what you hear is what the
     * acoustics service computed. RT60 is the time to fall 60 dB — a factor of
     * a thousand in amplitude — so the per-sample decay raised to the power of
     * (rt · rate) must come out at one thousandth.
     */
    const rt = 0.8;
    const perSample = decayPerSample(rt, RATE);
    const afterOneRt = Math.pow(perSample, rt * RATE);

    expect(afterOneRt).toBeCloseTo(0.001, 6);
  });

  it('is as long as the room rings, within the cap', () => {
    const short = buildImpulse(flat(0.3), RATE);
    const long = buildImpulse(flat(2), RATE);

    expect(short.duration).toBeCloseTo(0.3, 2);
    expect(long.duration).toBeCloseTo(2, 2);
    expect(long.left.length).toBeGreaterThan(short.left.length);
  });

  it('caps a cathedral rather than allocating forever', () => {
    // Past one RT60 the tail is a thousandth of its start and inaudible under
    // anything else, but it still costs a multiply per sample on every frame.
    const silly = buildImpulse(flat(30), RATE);
    expect(silly.duration).toBeLessThanOrEqual(4);
  });

  it('never returns an empty buffer, however dead the room', () => {
    // A convolver with three samples in it is a click, not a reverb.
    const dead = buildImpulse(flat(0), RATE);
    expect(dead.left.length).toBeGreaterThan(100);
  });

  it('actually decays', () => {
    const response = buildImpulse(flat(1), RATE);
    const head = rms(response.left, 0, Math.round(response.left.length * 0.1));
    const tail = rms(response.left, Math.round(response.left.length * 0.85));

    expect(tail).toBeLessThan(head * 0.2);
  });

  it('starts from silence rather than from a click', () => {
    /*
     * A real room's response begins with a gap before the first reflection
     * arrives. Starting the noise at full amplitude on sample zero puts a hard
     * edge on everything the convolver touches, which is heard as harshness
     * rather than as a room.
     */
    const response = buildImpulse(flat(0.8), RATE);
    expect(Math.abs(response.left[0] ?? 1)).toBeLessThan(0.02);
  });

  it('gives the two channels different noise, or it is not a room', () => {
    // Identical channels is a mono reverb played through two speakers, which
    // is audibly not what standing in a room sounds like.
    const response = buildImpulse(flat(1), RATE);
    const mid = Math.round(response.left.length / 2);
    expect(response.left[mid]).not.toBe(response.right[mid]);
  });

  it('is normalised without shifting the stereo image', () => {
    // Both channels by the SAME factor. Scaling each to its own peak moves the
    // image towards whichever happened to be quieter.
    const response = buildImpulse(flat(1.2), RATE);
    const both = Math.max(peak(response.left), peak(response.right));
    expect(both).toBeGreaterThan(0.9);
    expect(both).toBeLessThanOrEqual(1);
  });

  it('rings longer in the bass when the bass reverb time is longer', () => {
    /*
     * The whole point of doing it per band. A carpeted room with hard walls
     * decays quickly at 4 kHz and slowly at 125 Hz, and that is heard as
     * boominess — which a single-figure reverb preset cannot represent at all.
     */
    const boomy = buildImpulse([2, 1.6, 0.6, 0.5, 0.4, 0.3], RATE);
    const even = buildImpulse(flat(0.6), RATE);

    // The boomy one still has energy where the even one has faded.
    const at = Math.round(RATE * 1.2);
    expect(rms(boomy.left, at, at + RATE / 10)).toBeGreaterThan(
      rms(even.left, at, Math.min(even.left.length, at + RATE / 10)),
    );
  });

  it('is deterministic, so a room sounds the same on every visit', () => {
    const a = buildImpulse(flat(0.7), RATE);
    const b = buildImpulse(flat(0.7), RATE);
    expect(Array.from(a.left)).toEqual(Array.from(b.left));
  });
});

/* -------------------------------- The wet mix ------------------------------ */

describe('how wet the reverb is', () => {
  it('is quieter in an absorbent room, not merely shorter', () => {
    /*
     * A dead room returns little energy however long you make its tail. Mixing
     * a normalised impulse at a fixed level would make a carpeted bedroom as
     * wet as a tiled bathroom — shorter, but just as loud — which is not what
     * a real room does and is exactly what a preset gets wrong.
     */
    const bare = reverbMix(4);
    const furnished = reverbMix(40);

    expect(furnished).toBeLessThan(bare);
  });

  it('stays within sane bounds at both extremes', () => {
    expect(reverbMix(0)).toBeLessThanOrEqual(0.6);
    expect(reverbMix(0)).toBeGreaterThan(0);
    expect(reverbMix(100000)).toBeGreaterThanOrEqual(0.05);
  });
});

/* ------------------------------- The registry ------------------------------ */

describe('the voice registry', () => {
  it('has a voice for every floor the app can draw', () => {
    const voices = buildVoices();
    for (const timbre of FOOTSTEP_TIMBRES) {
      expect(voices.has(`step-${timbre.id}`)).toBe(true);
    }
  });

  it('has every sound the soundscape asks for by name', () => {
    // A missing id is silence, and silence is the one failure mode that looks
    // exactly like "the synthesis is broken".
    const voices = buildVoices();
    for (const id of ['latch', 'switch', 'drawer', 'water', 'hum', 'outside',
      'air-low', 'air-mid', 'air-high']) {
      expect(voices.has(id), id).toBe(true);
    }
  });

  it('renders every synthesised voice without throwing or going silent', () => {
    for (const voice of buildVoices().values()) {
      expect(voice.kind).toBe('synth');
      if (voice.kind !== 'synth') continue;

      const samples = voice.render(RATE);
      expect(samples.length, voice.id).toBeGreaterThan(0);
      expect(rms(samples), voice.id).toBeGreaterThan(0.0005);
      expect(peak(samples), voice.id).toBeLessThanOrEqual(1);
    }
  });

  it('works at a different sample rate, because hardware varies', () => {
    // 44.1 kHz and 48 kHz are both common, and a filter coefficient computed
    // for one and used at the other is a sound in the wrong place.
    const at44 = renderFootstep(footstepTimbre('floor-wood'), 44100);
    const at48 = renderFootstep(footstepTimbre('floor-wood'), 48000);

    expect(at44.length).not.toBe(at48.length);
    // Same loudness, different length — the timbre must not depend on the rate.
    expect(rms(at44)).toBeCloseTo(rms(at48), 1);
  });
});
