/**
 * Every sound in the building, made out of arithmetic.
 *
 * -----------------------------------------------------------------------------
 * WHY SYNTHESISED AND NOT RECORDED.
 *
 * A recorded footstep on oak is better than a synthesised one. It is also a
 * footstep on somebody else's oak, in somebody else's room, and it will sound
 * exactly the same in a tiled bathroom as in a carpeted bedroom unless somebody
 * records nine more.
 *
 * Synthesis makes the sound a FUNCTION of the material, which is the same
 * argument as everywhere else here: the app already knows the floor is porcelain
 * tile, so the step should be bright and short because the surface is hard, not
 * because a clip named "tile" was chosen. Add a floor finish to the catalogue
 * and it sounds right immediately, with nobody going to record anything.
 *
 * -----------------------------------------------------------------------------
 * AND A SEAM FOR THE DAY THAT STOPS BEING GOOD ENOUGH.
 *
 * Every sound sits behind `Voice`, which is either something synthesised here
 * or a file to load. Nothing downstream knows which, so a recorded set can be
 * dropped in one sound at a time — the tap first, say, where synthesis is
 * weakest — without touching the engine, the soundscape or the panel.
 *
 * -----------------------------------------------------------------------------
 * PURE, LIKE THE IMPULSE.
 *
 * Nothing here touches the Web Audio API either. These are functions from
 * parameters to sample arrays, so what they produce can be measured in the test
 * suite: that a step on carpet really does have less high-frequency energy than
 * one on tile, that an envelope ends at silence rather than at a click.
 *
 * -----------------------------------------------------------------------------
 * ALL OF IT IS NOISE AND FILTERS.
 *
 * Almost every sound a house makes is broadband noise shaped by a resonance and
 * an envelope. A footstep is a short noise burst with a thump under it. A latch
 * is two very short bursts. Running water is filtered noise with a slow
 * wobble. Air at a register is filtered noise and nothing else — genuinely,
 * that is all it is. The synthesis is therefore simple and the character comes
 * almost entirely from the filter and the envelope, which is exactly where the
 * material's properties belong.
 */

/* --------------------------------- The seam -------------------------------- */

/**
 * One sound, however it is made.
 *
 * A synthesised voice renders itself into samples on demand. A sampled voice
 * names a file for the engine to fetch. Nothing that plays a sound cares which
 * it has, which is the entire point: replacing one with the other later is a
 * one-line change in the registry and nothing else moves.
 */
export type Voice =
  | {
      kind: 'synth';
      id: string;
      /** How long the rendered buffer is, seconds. */
      duration: number;
      /** Fills a mono buffer. Pure, deterministic, testable. */
      render: (sampleRate: number) => Float32Array;
    }
  | {
      kind: 'sample';
      id: string;
      /** Relative to the app's base URL. Nothing ships one yet. */
      url: string;
    };

/* ------------------------------- Noise and maths --------------------------- */

/**
 * Deterministic noise, for the same reason the impulse uses it.
 *
 * A footstep that differs every time it is rendered cannot be tested, and the
 * variation people actually hear between footsteps is variation in the
 * PARAMETERS — a slightly different level, a slightly different filter — which
 * the soundscape applies at playback. Randomising the waveform underneath as
 * well buys nothing audible and costs the ability to check anything.
 */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** A one-pole low-pass coefficient for a cutoff in hertz. */
function lowpassCoefficient(cutoff: number, sampleRate: number): number {
  const x = Math.exp((-2 * Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate);
  return Math.max(0, Math.min(0.9999, x));
}

/**
 * An exponential decay from one to zero over `seconds`.
 *
 * Exponential rather than linear because that is what physical decay does, and
 * because a linear fade has an audible corner where it reaches zero. The tail
 * is forced to actually arrive at zero at the end rather than merely getting
 * close, since a buffer that stops at a non-zero sample is a click.
 */
function decayEnvelope(index: number, length: number, sharpness: number): number {
  if (length <= 1) return 0;
  const t = index / (length - 1);
  return Math.exp(-sharpness * t) * (1 - t);
}

/**
 * Scales a buffer to a peak ceiling.
 *
 * Every voice here is built by adding filtered noise to a tone, and the peak
 * of that sum is not something you can predict from the constants — the first
 * versions of the water and outdoor beds came out at 1.3 and 2.0, which a sound
 * card turns into crackle rather than into loudness. So the independent beds
 * are normalised, once, at render.
 *
 * NOT used on the footsteps or the air, and that is the important distinction:
 * their relative levels carry meaning. Carpet is quieter than tile BECAUSE
 * carpet is quieter than tile, and normalising each to the same peak would
 * throw away the one thing the synthesis exists to express. Those use a fixed
 * family gain instead, so every member is scaled by the same amount.
 */
function normaliseTo(samples: Float32Array, ceiling: number): Float32Array {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak < 1e-9) return samples;

  const gain = ceiling / peak;
  for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) * gain;
  return samples;
}

/**
 * Headroom below full scale.
 *
 * Not 1.0: these buffers are summed with each other and with a reverb return
 * before they reach the output, so a voice that peaks at full scale on its own
 * clips as soon as a second one plays.
 */
const CEILING = 0.9;

/**
 * One gain for the whole footstep family, and one for the whole air family.
 *
 * Chosen so the loudest member lands just under the ceiling — a timber stair
 * and a register at full tilt respectively. Applied identically to every
 * member, so the ratios between materials and between airflows survive.
 */
const FOOTSTEP_GAIN = 0.8;
const AIR_GAIN = 0.6;

/* -------------------------------- Footsteps -------------------------------- */

/**
 * How a floor sounds underfoot.
 *
 * Three numbers, and they are the whole difference between walking on tile and
 * walking on carpet:
 *
 *   `brightness` — where the noise burst is filtered. A hard floor radiates
 *                  energy right up to the top of hearing; a carpet is a porous
 *                  absorber sitting directly under the shoe and takes all of
 *                  that away before it ever leaves the floor.
 *   `sharpness`  — how fast the burst dies. A tile click is over in 40 ms; a
 *                  timber floor rings on because the board and the joist void
 *                  under it are a resonator.
 *   `body`       — how much low thump there is. This is the structure, not the
 *                  finish: a suspended timber floor drums and a slab does not,
 *                  whatever is laid on top.
 */
export interface FootstepTimbre {
  id: string;
  label: string;
  /** Filter cutoff for the impact noise, hertz. */
  brightness: number;
  /** How quickly the burst decays. Higher is shorter. */
  sharpness: number;
  /** Level of the low-frequency thump, 0 to 1. */
  body: number;
  /** Frequency of that thump, hertz. */
  thump: number;
  /** Overall level relative to the loudest surface. */
  level: number;
}

export const FOOTSTEP_TIMBRES: readonly FootstepTimbre[] = [
  {
    id: 'floor-hard',
    label: 'Tile, stone or concrete',
    // Bright, short, and loud. There is nothing between the shoe and the slab
    // to absorb anything, which is why a tiled hall is the noisiest floor in a
    // house to walk on and why it is never specified in a bedroom.
    brightness: 7000,
    sharpness: 22,
    body: 0.25,
    thump: 90,
    level: 1,
  },
  {
    id: 'floor-wood',
    label: 'Wood boards',
    // The body figure is the interesting one: a board spanning joists over a
    // void is a drum, and that low component is most of what makes a timber
    // floor recognisable. It is also what the neighbour downstairs hears.
    brightness: 3800,
    sharpness: 16,
    body: 0.75,
    thump: 68,
    level: 0.85,
  },
  {
    id: 'floor-carpet',
    label: 'Carpet',
    // Almost no top end and almost no level. A carpet absorbs the impact
    // before it can radiate, which is why it is the single most effective
    // thing you can put on a floor for the room below it.
    brightness: 900,
    sharpness: 34,
    body: 0.35,
    thump: 60,
    level: 0.42,
  },
  {
    id: 'stair-timber',
    label: 'Timber stair',
    // A tread is a short board fixed at both ends over a large open void, and
    // it is the loudest thing in most houses to walk on.
    brightness: 4200,
    sharpness: 13,
    body: 0.9,
    thump: 55,
    level: 1,
  },
];

export function footstepTimbre(id: string): FootstepTimbre {
  return FOOTSTEP_TIMBRES.find((entry) => entry.id === id) ?? FOOTSTEP_TIMBRES[0]!;
}

/**
 * One footstep.
 *
 * A noise burst through a low-pass, plus a decaying sine for the structural
 * thump. The heel strike and the toe are not modelled separately — at walking
 * pace they merge into one event to the ear, and separating them would be
 * detail nobody could hear over the reverb it is about to go through.
 */
export function renderFootstep(timbre: FootstepTimbre, sampleRate: number): Float32Array {
  const length = Math.round(sampleRate * 0.22);
  const out = new Float32Array(length);

  const rng = noise(0x5f0057 + Math.round(timbre.brightness));
  const coefficient = lowpassCoefficient(timbre.brightness, sampleRate);
  let filtered = 0;

  for (let i = 0; i < length; i += 1) {
    const envelope = decayEnvelope(i, length, timbre.sharpness);

    filtered = filtered * coefficient + rng() * (1 - coefficient);
    // Compensating for the filter's own loss of level, so a dull step is quiet
    // because carpet is quiet rather than because the filter ate it.
    const impact = filtered * (1 / (1 - coefficient)) * 0.35;

    const thud =
      Math.sin((2 * Math.PI * timbre.thump * i) / sampleRate) *
      timbre.body *
      Math.exp((-i / sampleRate) * 26);

    out[i] = (impact + thud) * envelope * timbre.level * FOOTSTEP_GAIN;
  }

  return out;
}

/* ------------------------------- The things you use ------------------------ */

/**
 * A door latch.
 *
 * Two clicks a few milliseconds apart — the latch bolt leaving the keeper and
 * the door meeting the stop — and it is the pair that makes it read as a latch
 * rather than as a tap on wood. Getting the gap wrong is the difference between
 * a door closing and a stone hitting a stone.
 */
export function renderLatch(sampleRate: number): Float32Array {
  const length = Math.round(sampleRate * 0.16);
  const out = new Float32Array(length);
  const rng = noise(0x1a7c4);

  const clicks = [
    { at: 0, level: 0.55, cutoff: 5200, sharpness: 60 },
    { at: 0.018, level: 1, cutoff: 2600, sharpness: 28 },
  ];

  for (const click of clicks) {
    const start = Math.round(click.at * sampleRate);
    const coefficient = lowpassCoefficient(click.cutoff, sampleRate);
    let filtered = 0;

    for (let i = start; i < length; i += 1) {
      const local = i - start;
      filtered = filtered * coefficient + rng() * (1 - coefficient);
      const envelope = decayEnvelope(local, length - start, click.sharpness);
      out[i] = (out[i] ?? 0) + filtered * (1 / (1 - coefficient)) * 0.3 * envelope * click.level;
    }
  }

  // A little low body, because a door leaf is a large light panel and it moves
  // air when it shuts.
  for (let i = 0; i < length; i += 1) {
    const thud = Math.sin((2 * Math.PI * 74 * i) / sampleRate) * Math.exp((-i / sampleRate) * 30);
    out[i] = (out[i] ?? 0) + thud * 0.3;
  }

  return out;
}

/**
 * A light switch.
 *
 * Almost nothing: a single very short, very bright click. The whole character
 * is in how fast it decays — a rocker switch is over in about fifteen
 * milliseconds and anything longer reads as a plastic object being dropped.
 */
export function renderSwitch(sampleRate: number): Float32Array {
  const length = Math.round(sampleRate * 0.06);
  const out = new Float32Array(length);
  const rng = noise(0x5417c4);

  const coefficient = lowpassCoefficient(6500, sampleRate);
  let filtered = 0;

  for (let i = 0; i < length; i += 1) {
    filtered = filtered * coefficient + rng() * (1 - coefficient);
    out[i] = filtered * (1 / (1 - coefficient)) * 0.3 * decayEnvelope(i, length, 90);
  }

  return out;
}

/**
 * A drawer running out and stopping.
 *
 * A short rumble of filtered noise while it travels, then a soft stop. The
 * rumble is amplitude-modulated at a few hundred hertz, which is what makes it
 * sound like something rolling on a runner rather than like a whoosh.
 */
export function renderDrawer(sampleRate: number): Float32Array {
  const length = Math.round(sampleRate * 0.34);
  const out = new Float32Array(length);
  const rng = noise(0xd4a3e);

  const coefficient = lowpassCoefficient(1400, sampleRate);
  let filtered = 0;

  for (let i = 0; i < length; i += 1) {
    const t = i / length;
    filtered = filtered * coefficient + rng() * (1 - coefficient);

    // Fades in, holds, then dies as the drawer reaches the end of its travel.
    const travel = Math.min(1, t * 6) * Math.max(0, 1 - Math.pow(t, 2.2));
    // The roll: a slow tremolo over the noise.
    const roll = 0.75 + 0.25 * Math.sin((2 * Math.PI * 190 * i) / sampleRate);

    out[i] = filtered * (1 / (1 - coefficient)) * 0.22 * travel * roll;
  }

  // The stop at the end, which is what tells you it is fully out.
  const stopAt = Math.round(length * 0.86);
  for (let i = stopAt; i < length; i += 1) {
    const local = i - stopAt;
    const thud = Math.sin((2 * Math.PI * 120 * local) / sampleRate) *
      Math.exp((-local / sampleRate) * 45);
    out[i] = (out[i] ?? 0) + thud * 0.35;
  }

  return out;
}

/* --------------------------------- The beds -------------------------------- */

/**
 * A looping bed of sound, as one seamless buffer.
 *
 * Running water, air at a register and the hum of an air handler are all
 * continuous, so they are rendered once as a loop and played indefinitely
 * rather than retriggered. The first and last samples have to match or the loop
 * point is an audible tick once a second forever, which is the single most
 * irritating bug in this file's subject area — so every loop here crossfades
 * its own tail over its head.
 */
function seamless(out: Float32Array, sampleRate: number): Float32Array {
  const fade = Math.min(Math.round(sampleRate * 0.05), Math.floor(out.length / 4));
  if (fade <= 1) return out;

  const length = out.length;
  for (let i = 0; i < fade; i += 1) {
    const gain = i / fade;
    const head = out[i] ?? 0;
    const tail = out[length - fade + i] ?? 0;
    // Equal-power, so the crossfade does not dip in the middle.
    out[i] = head * Math.sqrt(gain) + tail * Math.sqrt(1 - gain);
  }

  return out.slice(0, length - fade);
}

/**
 * Running water.
 *
 * Noise through a band-pass, with a slow wander in the filter. The wander is
 * what separates water from steam: a fixed filter over noise is a hiss, and the
 * ear identifies water by the way the bubbling shifts the spectrum around.
 */
export function renderWater(sampleRate: number): Float32Array {
  const length = Math.round(sampleRate * 2.4);
  const out = new Float32Array(length);
  const rng = noise(0x7a7e12);

  let low = 0;
  let high = 0;
  let wanderA = 0;
  let wanderB = 0;

  for (let i = 0; i < length; i += 1) {
    const raw = rng();

    // Two slow sines at incommensurate rates, so the wander never repeats
    // audibly within the loop.
    wanderA = Math.sin((2 * Math.PI * 1.7 * i) / sampleRate);
    wanderB = Math.sin((2 * Math.PI * 2.9 * i) / sampleRate);
    const centre = 1800 + 700 * wanderA + 400 * wanderB;

    const highCoefficient = lowpassCoefficient(centre * 1.8, sampleRate);
    const lowCoefficient = lowpassCoefficient(centre * 0.5, sampleRate);

    high = high * highCoefficient + raw * (1 - highCoefficient);
    low = low * lowCoefficient + raw * (1 - lowCoefficient);

    out[i] = (high - low) * 2.2;
  }

  return normaliseTo(seamless(out, sampleRate), CEILING);
}

/**
 * Air leaving a register.
 *
 * Filtered noise and genuinely nothing else — the sound of a diffuser is
 * turbulence at the vanes and it has no tonal content at all. The `velocity`
 * argument shifts where the noise sits: faster air through the same grille is
 * not only louder but brighter, which is why a whistling register is described
 * as hissing rather than as rumbling.
 */
export function renderAir(velocity: number, sampleRate: number): Float32Array {
  const length = Math.round(sampleRate * 2);
  const out = new Float32Array(length);
  const rng = noise(0xa14a17);

  const centre = 700 + 1800 * Math.min(1.5, Math.max(0, velocity));
  const highCoefficient = lowpassCoefficient(centre * 2.4, sampleRate);
  const lowCoefficient = lowpassCoefficient(centre * 0.35, sampleRate);

  let low = 0;
  let high = 0;

  for (let i = 0; i < length; i += 1) {
    const raw = rng();
    high = high * highCoefficient + raw * (1 - highCoefficient);
    low = low * lowCoefficient + raw * (1 - lowCoefficient);
    out[i] = (high - low) * 1.6 * AIR_GAIN;
  }

  return seamless(out, sampleRate);
}

/**
 * The air handler itself.
 *
 * A blower is a rotating machine and it has a real fundamental — the blade-pass
 * frequency, which is the shaft speed times the number of blades. A typical
 * residential blower at 1000 rpm with ten blades gives about 170 Hz, and that
 * low tone with its first few harmonics is exactly what you hear through a
 * floor when the heating comes on.
 */
export function renderHum(sampleRate: number): Float32Array {
  const length = Math.round(sampleRate * 2);
  const out = new Float32Array(length);
  const rng = noise(0x8a4b21);

  const fundamental = 170;
  const coefficient = lowpassCoefficient(400, sampleRate);
  let filtered = 0;

  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;

    // The tone and two harmonics, falling away as harmonics do.
    let tone = Math.sin(2 * Math.PI * fundamental * t);
    tone += 0.4 * Math.sin(2 * Math.PI * fundamental * 2 * t);
    tone += 0.15 * Math.sin(2 * Math.PI * fundamental * 3 * t);

    // Plus the motor's own broadband rumble.
    filtered = filtered * coefficient + rng() * (1 - coefficient);
    const rumble = filtered * (1 / (1 - coefficient)) * 0.5;

    out[i] = tone * 0.22 + rumble * 0.3;
  }

  return normaliseTo(seamless(out, sampleRate), CEILING);
}

/**
 * Outside.
 *
 * A low rumble of traffic with occasional passes over it. Deliberately not
 * birdsong: a road is what the acoustic report is about, and the point of
 * hearing it is to notice that the bedroom at the front is noisy — which
 * birdsong would not convey.
 *
 * The level and the filtering are applied at playback from the facade
 * calculation, so this is the raw material rather than the finished sound.
 */
export function renderOutside(sampleRate: number): Float32Array {
  const length = Math.round(sampleRate * 6);
  const out = new Float32Array(length);
  const rng = noise(0xc0ffee);

  const coefficient = lowpassCoefficient(500, sampleRate);
  let filtered = 0;

  // Three passing vehicles at times that do not divide the loop evenly, so the
  // six-second cycle is much less obvious than it would otherwise be.
  const passes = [0.8, 2.6, 4.9];

  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    filtered = filtered * coefficient + rng() * (1 - coefficient);

    let level = 0.3;
    for (const pass of passes) {
      // A pass is a smooth swell and fade about a second and a half wide.
      const distance = Math.abs(t - pass);
      level += 0.7 * Math.exp(-(distance * distance) / 0.35);
    }

    out[i] = filtered * (1 / (1 - coefficient)) * 0.35 * level;
  }

  return normaliseTo(seamless(out, sampleRate), CEILING);
}

/* -------------------------------- The registry ----------------------------- */

/**
 * Every sound the app can make, by id.
 *
 * A flat registry rather than scattered constructors, so the day somebody wants
 * to drop in recorded audio the change is here and nowhere else: swap a
 * `{ kind: 'synth' }` entry for a `{ kind: 'sample', url }` one and the engine
 * loads a file instead. Nothing that plays a sound will notice.
 */
export function buildVoices(): Map<string, Voice> {
  const voices = new Map<string, Voice>();

  const synth = (id: string, duration: number, render: (rate: number) => Float32Array) => {
    voices.set(id, { kind: 'synth', id, duration, render });
  };

  for (const timbre of FOOTSTEP_TIMBRES) {
    synth(`step-${timbre.id}`, 0.22, (rate) => renderFootstep(timbre, rate));
  }

  synth('latch', 0.16, renderLatch);
  synth('switch', 0.06, renderSwitch);
  synth('drawer', 0.34, renderDrawer);
  synth('water', 2.4, renderWater);
  synth('hum', 2, renderHum);
  synth('outside', 6, renderOutside);

  // Air at three velocities rather than one continuous parameter: rendering a
  // two-second buffer costs real milliseconds, and three steps is more
  // difference than anybody can hear between one register and the next.
  synth('air-low', 2, (rate) => renderAir(0.3, rate));
  synth('air-mid', 2, (rate) => renderAir(0.7, rate));
  synth('air-high', 2, (rate) => renderAir(1.2, rate));

  return voices;
}

/** Which air buffer suits an airflow, in cfm. */
export function airVoiceFor(cfm: number): string {
  if (cfm < 60) return 'air-low';
  if (cfm < 110) return 'air-mid';
  return 'air-high';
}
