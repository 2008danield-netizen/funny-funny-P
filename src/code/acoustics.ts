/**
 * Room acoustics — the numbers, with their sources.
 *
 * -----------------------------------------------------------------------------
 * THIS IS THE FIRST SYSTEM IN THE APP WITH ALMOST NO CODE BEHIND IT.
 *
 * Every other checker here cites a book that can fail you an inspection. The
 * IRC governs the stairs, the NEC the wiring, the IPC the drains, the IECC the
 * envelope. Acoustics in a single-family house is governed by nothing at all.
 *
 * The IBC does require STC 50 between separate dwelling units (1206.2) and IIC
 * 50 for the floor between them (1206.3) — but that is the wall between two
 * apartments, not the wall between your bedroom and your living room, and a
 * detached house has no such wall in it.
 *
 * So most of what follows is GUIDANCE, and it says so. That matters more here
 * than anywhere else in this project, because acoustic advice is exactly the
 * kind of thing that sounds authoritative and is usually somebody's opinion.
 * A finding with an invented citation is worse than no finding: somebody looks
 * it up, finds it says something else, and stops believing the ones that are
 * real. Rule 26 of this codebase, applied where it is hardest to keep.
 *
 * What IS solid:
 *
 *   SABINE and EYRING are physics, not opinion. Given the absorption in a room
 *   they give its reverberation time, and the derivation is a century old.
 *
 *   ABSORPTION COEFFICIENTS are measured, published values. The ones below are
 *   the conventional figures found across published tables — Egan's
 *   "Architectural Acoustics", Cavanaugh & Wilkes, and manufacturers' own ISO
 *   354 test data. They are typical rather than specific to any one product,
 *   which is honest for a design tool and useless for a specification. Every
 *   entry says so.
 *
 *   ASHRAE's background-noise criteria (Applications Handbook, chapter 49) are
 *   the industry's own recommendations for mechanical noise in occupied rooms.
 *   Not law, but not invented either, and a mechanical engineer will recognise
 *   the numbers.
 *
 *   STC RATINGS below are the conventional laboratory figures for common
 *   partitions. Real site performance is routinely 5 points worse because of
 *   flanking, and the checks say that rather than pretending otherwise.
 *
 * -----------------------------------------------------------------------------
 * WHY OCTAVE BANDS AND NOT ONE NUMBER.
 *
 * A single reverberation time is the figure everybody quotes and it hides the
 * fault that actually annoys people. Absorption is strongly frequency
 * dependent: a carpet kills the top end and does almost nothing at 125 Hz, so
 * a carpeted room with hard walls has a short, bright-sounding RT60 at 2 kHz
 * and a long boomy one in the bass. That is the "muddy" room, and averaging it
 * away is how you fail to predict it.
 *
 * Six bands, 125 Hz to 4 kHz, which is the standard set and enough to see the
 * shape.
 */

/* ----------------------------- The frequency axis -------------------------- */

/**
 * The octave band centres, in hertz.
 *
 * Every absorption array in this file is in this order, and the physics
 * functions assume it. Six numbers rather than one — see the note above.
 */
export const BANDS = [125, 250, 500, 1000, 2000, 4000] as const;

export type BandValues = readonly [number, number, number, number, number, number];

/** The band index conventionally quoted as "the" figure for a room. */
export const SPEECH_BAND = 2; // 500 Hz

/**
 * The bands speech intelligibility actually lives in.
 *
 * 500 Hz, 1 kHz and 2 kHz. When a single reverberation time is quoted for a
 * room this is what it should be the mean of, and quoting the 125 Hz figure
 * instead is how a boomy room gets reported as a lively one.
 */
export const SPEECH_BANDS = [2, 3, 4] as const;

/* --------------------------- Absorption coefficients ----------------------- */

/**
 * One surface's absorption, as a fraction of incident energy, per band.
 *
 * Zero is a perfect mirror and one is an open window — which is literally the
 * reference: the unit of absorption is the sabin, and one square metre of open
 * window is one metric sabin, because everything that reaches it leaves.
 */
export interface AbsorptionSpec {
  id: string;
  label: string;
  /** Absorption coefficient at each band in `BANDS`. */
  alpha: BandValues;
  /**
   * Where the figure came from. Typical published values, not a test report
   * for a named product — which is the honest thing to say at design stage.
   */
  source: string;
}

const typical = (source: string) => `Typical published value (${source})`;

const EGAN = typical('Egan, Architectural Acoustics');
const CW = typical('Cavanaugh & Wilkes, Architectural Acoustics');
const ISO = typical('manufacturers’ ISO 354 data');

/**
 * Surfaces, by an id this app's own finishes map onto.
 *
 * The mapping from a floor preset to one of these lives in the acoustics
 * service rather than here, because this file is meant to stay a table of
 * measured numbers and nothing else.
 */
export const SURFACES: readonly AbsorptionSpec[] = [
  /* ------------------------------- Floors -------------------------------- */
  {
    id: 'floor-hard',
    label: 'Tile, stone or polished concrete',
    // Almost perfectly reflective, and flat with frequency. This is the finish
    // that makes a bathroom ring.
    alpha: [0.01, 0.01, 0.015, 0.02, 0.02, 0.02],
    source: EGAN,
  },
  {
    id: 'floor-wood',
    label: 'Wood boards on joists',
    // Slightly absorbent in the bass, because the boards and the void below
    // them act as a panel absorber. Bare concrete does not do this, which is
    // why a timber floor sounds warmer than a slab with the same finish on it.
    alpha: [0.15, 0.11, 0.1, 0.07, 0.06, 0.07],
    source: CW,
  },
  {
    id: 'floor-carpet',
    label: 'Carpet on underlay',
    // The classic porous absorber: nothing at the bottom, a great deal at the
    // top. A carpeted room with hard walls is bright-free and still boomy.
    alpha: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73],
    source: EGAN,
  },

  /* -------------------------------- Walls -------------------------------- */
  {
    id: 'wall-gypsum',
    label: 'Painted plasterboard on studs',
    // Note the bass figure. A stud wall is a membrane over a cavity and it
    // absorbs low frequencies rather well — which is the single biggest reason
    // a real room is less boomy than a concrete box of the same size.
    alpha: [0.29, 0.1, 0.05, 0.04, 0.07, 0.09],
    source: CW,
  },
  {
    id: 'wall-masonry',
    label: 'Painted masonry',
    alpha: [0.01, 0.01, 0.02, 0.02, 0.02, 0.03],
    source: EGAN,
  },
  {
    id: 'ceiling-gypsum',
    label: 'Plasterboard ceiling',
    alpha: [0.29, 0.1, 0.05, 0.04, 0.07, 0.09],
    source: CW,
  },
  {
    id: 'ceiling-acoustic-tile',
    label: 'Acoustic ceiling tile',
    // Here for comparison rather than because the app models it: it is the
    // single most effective thing you can do to a ringing room, and the report
    // says so when it recommends treatment.
    alpha: [0.34, 0.55, 0.74, 0.86, 0.87, 0.78],
    source: ISO,
  },

  /* ------------------------------- Openings ------------------------------ */
  {
    id: 'glass-window',
    label: 'Window glass',
    // Thin glass absorbs a surprising amount of bass by flexing, and virtually
    // nothing above that. A wall of glass is a reflector, not an opening.
    alpha: [0.35, 0.25, 0.18, 0.12, 0.07, 0.04],
    source: EGAN,
  },
  {
    id: 'door-wood',
    label: 'Wood door',
    alpha: [0.14, 0.1, 0.06, 0.08, 0.1, 0.1],
    source: CW,
  },
  {
    id: 'opening',
    label: 'Open doorway',
    // The definition of total absorption: everything that reaches it leaves
    // and none of it comes back. This is why an open door to a hall measurably
    // shortens a room's reverberation.
    alpha: [1, 1, 1, 1, 1, 1],
    source: 'By definition — one square metre of opening is one metric sabin',
  },

  /* ------------------------------ Furniture ------------------------------ */
  {
    id: 'upholstered',
    label: 'Upholstered seating',
    // Per square metre of plan footprint rather than surface area: a sofa is
    // absorbing on five faces and its cushions are a deep porous absorber, so
    // the footprint figure is the one published for furnished areas.
    alpha: [0.44, 0.6, 0.77, 0.89, 0.82, 0.7],
    source: EGAN,
  },
  {
    id: 'bed',
    label: 'Bed with bedding',
    alpha: [0.35, 0.5, 0.66, 0.75, 0.72, 0.65],
    source: CW,
  },
  {
    id: 'soft-furnishing',
    label: 'Curtains, rugs and soft furnishing',
    alpha: [0.14, 0.35, 0.55, 0.72, 0.7, 0.65],
    source: EGAN,
  },
  {
    id: 'furniture-hard',
    label: 'Cabinets, tables and hard furniture',
    // Not nothing: a bookcase full of books is a decent diffuser and absorber,
    // and a run of cabinets breaks up the parallel walls that cause flutter.
    alpha: [0.1, 0.1, 0.12, 0.12, 0.12, 0.12],
    source: CW,
  },
  {
    id: 'person',
    label: 'A seated person',
    // In sabins each, not per square metre — handled separately. Kept here so
    // the figure has one home; occupancy is not modelled yet.
    alpha: [0.18, 0.4, 0.46, 0.46, 0.51, 0.46],
    source: EGAN,
  },
];

export function surfaceAbsorption(id: string): AbsorptionSpec {
  return SURFACES.find((entry) => entry.id === id) ?? SURFACES[0]!;
}

/* ------------------------------ Air absorption ----------------------------- */

/**
 * How much the air itself absorbs, per metre, per band.
 *
 * Negligible in a bedroom and not negligible in a double-height hall, and it
 * only bites at the top two bands. At 20 °C and 50% relative humidity, which
 * is the condition these coefficients are quoted at and close enough to a
 * heated house.
 *
 * Leaving it out is the usual simplification and it makes large rooms sound
 * brighter than they are, because the 4 kHz decay is the one it shortens most.
 */
export const AIR_ABSORPTION: BandValues = [0, 0, 0, 0.0012, 0.0024, 0.0072];

/* ------------------------------ Reverberation ------------------------------ */

/**
 * Sabine's equation. RT60 = 0.161 V / A, metric.
 *
 * V is the room volume in cubic metres and A the total absorption in metric
 * sabins — that is, the sum of every surface's area times its coefficient.
 *
 * Derived in 1898 by Wallace Sabine, who worked it out empirically in a
 * Harvard lecture theatre by carrying seat cushions in and out at night. It
 * assumes a diffuse field: sound bouncing everywhere equally, losing a little
 * at every reflection.
 */
export const SABINE_CONSTANT = 0.161;

/**
 * The absorption above which Sabine stops being right, as a mean coefficient.
 *
 * Sabine's derivation assumes each reflection removes a small fraction of the
 * energy. When the mean coefficient gets large that is no longer a small
 * fraction — and in the limit of a fully absorbent room Sabine predicts a
 * reverberation time that is short but not zero, which is nonsense: an anechoic
 * chamber has no reverberation at all.
 *
 * Eyring's form fixes it by using the logarithm, and reduces to Sabine's when
 * the absorption is small. Above this figure the app reports Eyring and says
 * which it used, because quietly switching equations is how a number becomes
 * unexplainable.
 */
export const EYRING_THRESHOLD = 0.2;

/* ------------------------- What a room should sound like -------------------- */

/**
 * The target reverberation band for each kind of room.
 *
 * GUIDANCE, and nothing more. There is no code anywhere requiring a living
 * room to have a particular reverberation time, and there is no standard for
 * dwellings the way ANSI S12.60 exists for classrooms or BB93 for schools in
 * the UK. These are the ranges room-acoustics practice works to for domestic
 * spaces, quoted as the mean of the 500 Hz, 1 kHz and 2 kHz bands.
 *
 * The app prints "Guidance" against every one of them rather than a section
 * number, because inventing a citation is the fastest way to make somebody
 * stop believing the citations that are real.
 */
export interface ReverbTarget {
  /** Shortest sensible. Below this a room sounds dead and oppressive. */
  min: number;
  /** Longest comfortable. Above this speech starts to smear. */
  max: number;
  why: string;
}

export const REVERB_TARGETS: Record<string, ReverbTarget> = {
  living: {
    min: 0.4,
    max: 0.7,
    why: 'Long enough to feel like a room rather than a padded cell, short enough that a television and a conversation do not fight.',
  },
  bedroom: {
    min: 0.3,
    max: 0.6,
    why: 'Quiet and slightly dead is what people want to sleep in.',
  },
  dining: {
    min: 0.4,
    max: 0.7,
    why: 'The room where reverberation is most often wrong: hard floor, hard table, glass wall, and six people who cannot hear each other.',
  },
  kitchen: {
    min: 0.4,
    max: 0.8,
    why: 'Hard surfaces everywhere by necessity. A little ring is normal; a lot means the ceiling is the only thing left to treat.',
  },
  bathroom: {
    min: 0.4,
    max: 1,
    why: 'Tiled on five sides and small. It will ring, everybody expects it to, and it is not worth treating.',
  },
  hall: {
    min: 0.4,
    max: 0.9,
    why: 'Nobody holds a conversation in a corridor, so the tolerance is wide — but a double-height hall with a stone floor carries every sound into the rooms off it.',
  },
  stairs: {
    min: 0.4,
    max: 1,
    why: 'A stairwell is a tall hard shaft that couples every storey together acoustically.',
  },
  laundry: { min: 0.4, max: 1, why: 'A machine room. Reverberation is the least of it.' },
  garage: { min: 0.5, max: 1.5, why: 'Bare and hard, and not a room anybody listens in.' },
  store: { min: 0.3, max: 1, why: 'Too small to have a meaningful reverberation time.' },
  other: { min: 0.4, max: 0.8, why: 'A general domestic range.' },
};

export function reverbTarget(purpose: string): ReverbTarget {
  return REVERB_TARGETS[purpose] ?? REVERB_TARGETS.other!;
}

/* --------------------------- Background noise ------------------------------ */

/**
 * ASHRAE's recommended background noise from the mechanical system, in dBA.
 *
 * From the ASHRAE Applications Handbook, chapter 49 (Noise and Vibration
 * Control), which gives these as RC/NC ranges for residential rooms. Converted
 * here to the A-weighted level a sound meter reads, which is roughly NC + 8,
 * because that is the number somebody can actually check with a phone.
 *
 * Recommendations, not law. But a mechanical engineer will recognise them, and
 * "the bedroom diffuser is at NC 40" is a real complaint with a real cause: air
 * moving too fast through a register that is too small.
 */
export interface NoiseCriterion {
  /** The quietest of the recommended range, dBA. */
  target: number;
  /** Above this the room is audibly noisy for its purpose, dBA. */
  limit: number;
}

export const BACKGROUND_NOISE: Record<string, NoiseCriterion> = {
  bedroom: { target: 25, limit: 33 },
  living: { target: 30, limit: 38 },
  dining: { target: 30, limit: 38 },
  kitchen: { target: 35, limit: 45 },
  bathroom: { target: 35, limit: 45 },
  hall: { target: 35, limit: 45 },
  stairs: { target: 35, limit: 45 },
  laundry: { target: 40, limit: 50 },
  garage: { target: 45, limit: 55 },
  store: { target: 40, limit: 50 },
  other: { target: 32, limit: 40 },
};

export function noiseCriterion(purpose: string): NoiseCriterion {
  return BACKGROUND_NOISE[purpose] ?? BACKGROUND_NOISE.other!;
}

/**
 * The source of the ASHRAE figures, for a finding to carry.
 */
export const ASHRAE_NOISE_SOURCE =
  'ASHRAE Applications Handbook, ch. 49 — recommended indoor design criteria';

/* ------------------------------- Getting through ---------------------------- */

/**
 * Sound Transmission Class: a single number for how much a partition stops.
 *
 * Roughly, the decibel reduction at speech frequencies. STC 30 and you hear the
 * words next door; STC 45 and you hear that somebody is talking; STC 50 and you
 * hear a murmur. Every 10 points is about half as loud again.
 *
 * These are LABORATORY figures for the assemblies as tested (ASTM E90). Built
 * work does 5 points worse as a matter of routine, and much worse than that if
 * anything flanks — a shared ceiling void, a back-to-back socket, a gap under
 * the door. The checks say so rather than quoting the laboratory figure as if
 * it were a prediction.
 */
export interface TransmissionSpec {
  /** The assembly id this applies to, matching `building/buildUp.ts`. */
  id: string;
  label: string;
  stc: number;
  source: string;
}

const LAB = 'Typical ASTM E90 laboratory value for this assembly';

export const TRANSMISSION: readonly TransmissionSpec[] = [
  {
    id: 'partition-single',
    label: 'Single stud partition, one layer each side, no insulation',
    // The default interior wall in nearly every house, and the reason you can
    // hear a television through it.
    stc: 34,
    source: LAB,
  },
  {
    id: 'partition-insulated',
    label: 'Single stud partition, insulated cavity',
    // Batts in an existing partition buy about five points. Cheap, and the
    // single best-value acoustic upgrade in a house under construction.
    stc: 39,
    source: LAB,
  },
  {
    id: 'partition-double-board',
    label: 'Single stud partition, insulated, two layers each side',
    stc: 45,
    source: LAB,
  },
  {
    id: 'partition-resilient',
    label: 'Insulated partition on resilient channel',
    // Breaking the mechanical path matters more than mass. This is what gets a
    // domestic partition to the number the IBC asks between apartments.
    stc: 50,
    source: LAB,
  },
  {
    id: 'wall-exterior-stud',
    label: 'Insulated exterior stud wall with sheathing and cladding',
    stc: 39,
    source: LAB,
  },
];

export function transmissionSpec(id: string): TransmissionSpec {
  return TRANSMISSION.find((entry) => entry.id === id) ?? TRANSMISSION[0]!;
}

/**
 * STC of the glazing types the envelope already offers.
 *
 * Keyed by the same glazing ids the IECC module uses, so choosing a window for
 * its U-factor also decides what the road sounds like — which is a real
 * trade-off and one nobody is usually shown.
 *
 * Note the shape of it: triple glazing is barely better acoustically than
 * double, because three panes of similar thickness at similar spacing resonate
 * together. Laminated glass or two panes of DIFFERENT thickness beat it easily
 * and cost less. That is genuinely counter-intuitive and worth surfacing.
 */
export const GLAZING_STC: Record<string, number> = {
  single: 27,
  'double-clear': 29,
  'double-lowe': 30,
  'double-lowe-argon': 31,
  'triple-lowe': 33,
};

export function glazingStc(glazingId: string): number {
  return GLAZING_STC[glazingId] ?? 29;
}

/**
 * The IBC's requirement, carried so the report can say what it does NOT apply to.
 *
 * This is the one real citation in the file and it is here mostly to be ruled
 * out: it governs the wall between two dwelling units, so in a detached house
 * nothing in the building has to meet it. Saying that plainly is more useful
 * than staying silent, because "STC 50" is the number people have heard of and
 * they assume it applies to their bedroom wall.
 */
export const IBC_DWELLING_SEPARATION = {
  section: '1206.2',
  authority: 'IBC' as const,
  stc: 50,
  asWritten:
    'Walls, partitions and floor/ceiling assemblies separating dwelling units '
    + 'shall have a sound transmission class of not less than 50 (45 if field tested).',
  appliesTo: 'Separate dwelling units only — not rooms within one house.',
};

/* ------------------------------- Outside ---------------------------------- */

/**
 * How loud it is outside, as the level at the facade in dBA.
 *
 * A design input rather than a derived one: nothing in the model knows what is
 * on the other side of the plot boundary. The figures are the conventional
 * daytime L(Aeq) bands used in environmental noise assessment.
 *
 * It matters which facade, and the app knows that: the site records which plot
 * line is the front, so a bedroom on the road gets the full level and one at
 * the back gets the level less the screening the house itself provides.
 */
export interface OutdoorNoiseLevel {
  id: string;
  label: string;
  description: string;
  /** Level at the front facade, dBA. */
  dba: number;
}

export const OUTDOOR_NOISE: readonly OutdoorNoiseLevel[] = [
  {
    id: 'quiet',
    label: 'Quiet — rural or a cul-de-sac',
    description: 'Birds, wind, an occasional car. Nothing to design against.',
    dba: 40,
  },
  {
    id: 'suburban',
    label: 'Suburban street',
    description: 'A residential road with passing traffic. The usual case.',
    dba: 50,
  },
  {
    id: 'busy-road',
    label: 'Busy road',
    description: 'A main road or a bus route. Audible indoors through ordinary windows.',
    dba: 62,
  },
  {
    id: 'city',
    label: 'City centre or a flight path',
    description: 'Continuous traffic, sirens, aircraft. Glazing becomes a real decision.',
    dba: 70,
  },
];

export function outdoorNoise(id: string): OutdoorNoiseLevel {
  return OUTDOOR_NOISE.find((entry) => entry.id === id) ?? OUTDOOR_NOISE[1]!;
}

/**
 * How quiet a bedroom should be at night with the windows shut, in dBA.
 *
 * The World Health Organization's Night Noise Guidelines recommend no more
 * than 30 dB L(Aeq) inside a bedroom overnight, and that is what this is. A
 * recommendation from a health body rather than a building code — which is a
 * third kind of authority again, and the report labels it as such rather than
 * lumping it in with the IBC.
 */
export const WHO_NIGHT_INDOOR = {
  dba: 30,
  authority: 'WHO' as const,
  source: 'WHO Night Noise Guidelines for Europe (2009) — indoor bedroom L(Aeq)',
};

/**
 * How much the house itself screens its own back from a road at the front.
 *
 * A rough figure, and honest about being one: the real answer depends on the
 * road's distance, the ground between, the fences and the neighbours. Ten
 * decibels is the conventional allowance for the acoustic shadow of a building
 * and it is the right order of magnitude — halving the loudness twice over.
 */
export const FACADE_SHADOW_DB = 10;
