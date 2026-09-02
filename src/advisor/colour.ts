/**
 * Colour arithmetic for the palette rules.
 *
 * Interior colour advice is mostly about three measurable things, and one thing
 * that is not measurable at all:
 *
 *   • CONTRAST — perceived lightness difference. Two surfaces that meet with
 *     almost the same lightness read as one surface, and the room loses the
 *     line where the floor stops and the wall starts.
 *   • TEMPERATURE — warm hues (reds through yellows) against cool ones (greens
 *     through blues). Mixing them is not a mistake; mixing them at high
 *     saturation with nothing between them usually is.
 *   • VARIETY — how many distinct hue families are in play. Beyond three, a
 *     room stops having a palette and starts having a collection.
 *
 * The thing that is not measurable is whether it is any good. This module can
 * tell you that a sage wall and a terracotta sofa are 140 degrees apart on the
 * wheel; it cannot tell you that the combination is lovely. The rules that use
 * it are written accordingly — they flag the mechanical problems and stay quiet
 * about taste.
 *
 * Lightness is computed as RELATIVE LUMINANCE (the sRGB/WCAG weighting), not as
 * HSL's L. HSL lightness says pure yellow and pure blue are equally light,
 * which is wrong to the eye by a wide margin and would have the advisor
 * approving a navy floor under a yellow wall as a strong contrast when in fact
 * it is a very strong one, and vice versa.
 */

export interface Hsl {
  /** 0-360. */
  h: number;
  /** 0-1. */
  s: number;
  /** 0-1. */
  l: number;
}

/** Parses "#rgb" or "#rrggbb" into 0-1 channels. Falls back to mid grey. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const raw = hex.trim().replace(/^#/, '');
  const expanded =
    raw.length === 3
      ? raw
          .split('')
          .map((char) => char + char)
          .join('')
      : raw;

  if (!/^[0-9a-f]{6}$/i.test(expanded)) return { r: 0.5, g: 0.5, b: 0.5 };

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16) / 255,
    g: Number.parseInt(expanded.slice(2, 4), 16) / 255,
    b: Number.parseInt(expanded.slice(4, 6), 16) / 255,
  };
}

export function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const channel = (value: number) =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function hexToHsl(hex: string): Hsl {
  const { r, g, b } = parseHex(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta < 1e-9) return { h: 0, s: 0, l };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;

  h *= 60;
  if (h < 0) h += 360;

  return { h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;

  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];

  return toHex({ r: r + m, g: g + m, b: b + m });
}

/**
 * Relative luminance, 0 (black) to 1 (white).
 *
 * The sRGB transfer function is undone first: a hex value of 128 is not half as
 * bright as 255, it is about 21% as bright, and skipping the linearisation
 * makes every contrast judgement here wrong in the mid tones — which is where
 * interior palettes live.
 */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Absolute luminance difference between two colours, 0-1. */
export function contrast(a: string, b: string): number {
  return Math.abs(luminance(a) - luminance(b));
}

/** Shortest distance around the colour wheel, 0-180. */
export function hueDistance(a: number, b: number): number {
  const diff = Math.abs(((a - b) % 360) + 360) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export type Temperature = 'warm' | 'cool' | 'neutral';

/**
 * How much colour is actually present, 0-1: the max channel minus the min.
 *
 * Used instead of HSL saturation, which is a trap at the extremes. An off-white
 * like #f4f2ee has channels within 6/255 of each other and yet an HSL saturation
 * of 21%, because the saturation denominator collapses as lightness approaches
 * 1. Judging by saturation therefore has the advisor confidently describing a
 * white wall as a warm colour and pitting it against the sofa. Chroma has no
 * such blind spot: 0.024 for that off-white, and 0.36 for terracotta.
 */
export function chroma(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** Below this, a colour has no hue worth discussing. */
const NEUTRAL_CHROMA = 0.06;

/**
 * The band of hues that read as neutral even with real colour in them.
 *
 * Beiges, creams, stone and taupe live at hues 20-60, and in decorating they
 * are neutrals — nobody calls a linen sofa "an orange sofa". A cool tint of the
 * same chroma is a colour: pale sage is green, pale blue is blue. That asymmetry
 * is how people actually see it, so the rules encode it rather than pretending
 * the colour wheel is even.
 */
const WARM_NEUTRAL = { minHue: 20, maxHue: 60, maxChroma: 0.18 };

function isWarmNeutral(h: number, c: number): boolean {
  return h >= WARM_NEUTRAL.minHue && h < WARM_NEUTRAL.maxHue && c < WARM_NEUTRAL.maxChroma;
}

/**
 * Whether a colour reads warm, cool, or neither.
 *
 * Anything with too little chroma to see is neutral, which is also how a
 * decorator would describe it — and it stops the advisor generating advice
 * about a colour difference nobody can perceive.
 */
export function temperatureOf(hex: string): Temperature {
  const c = chroma(hex);
  if (c < NEUTRAL_CHROMA) return 'neutral';
  const { h } = hexToHsl(hex);
  // Reds, oranges, yellows and the warmer end of green.
  if (h < 75 || h >= 330) return 'warm';
  if (h >= 160 && h < 290) return 'cool';
  return 'neutral';
}

/**
 * A coarse hue family name, used to count how varied a palette is.
 *
 * Deliberately coarse. Distinguishing "rust" from "terracotta" would count a
 * perfectly coherent scheme as two colours; the question the rule is asking is
 * "how many different things is this room trying to be".
 */
export function hueFamily(hex: string): string {
  const { h, l } = hexToHsl(hex);
  const c = chroma(hex);
  if (l < 0.12) return 'black';
  if (l > 0.9 && c < NEUTRAL_CHROMA * 2) return 'white';
  if (c < NEUTRAL_CHROMA || isWarmNeutral(h, c)) return 'neutral';
  if (h < 20 || h >= 335) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'teal';
  if (h < 260) return 'blue';
  if (h < 300) return 'violet';
  return 'pink';
}

/**
 * A wall colour that would sit well with a given floor.
 *
 * The rule of thumb it encodes: keep the hue family, drop the saturation to a
 * fraction, and lift the lightness well clear of the floor. That is how most
 * of the safe wall colours in any paint chart relate to a wooden floor — a
 * quieter, paler cousin of the same hue rather than a contrasting statement.
 *
 * It is a starting point offered as a one-click fix, not a decree; the swatch
 * grid in the plan panel is still where somebody chooses a colour they like.
 */
export function harmoniousWall(floorHex: string, floorTint: string): string {
  const base = hexToHsl(blend(floorHex, floorTint));
  return hslToHex({
    h: base.h,
    s: Math.min(0.18, base.s * 0.45),
    // Well above the floor's luminance, and never so bright it clips to paper.
    l: Math.max(0.78, Math.min(0.92, base.l + 0.32)),
  });
}

/** Multiplies one colour by another, the way a texture tint works. */
export function blend(base: string, tint: string): string {
  const a = parseHex(base);
  const b = parseHex(tint);
  return toHex({ r: a.r * b.r, g: a.g * b.g, b: a.b * b.b });
}

/** A human name for a colour, coarse enough to be recognisable in a sentence. */
export function describeColour(hex: string): string {
  const { l } = hexToHsl(hex);
  const family = hueFamily(hex);
  if (family === 'white') return 'off-white';
  if (family === 'black') return 'near-black';
  if (family === 'neutral') {
    // A warm neutral is a stone or a beige, not a grey; calling a cream wall
    // "pale grey" is the sort of small wrongness that costs a tool its
    // credibility on everything else it says.
    const warm = isWarmNeutral(hexToHsl(hex).h, chroma(hex));
    if (warm) return l > 0.72 ? 'cream' : l > 0.4 ? 'stone' : 'taupe';
    return l > 0.6 ? 'pale grey' : l > 0.35 ? 'mid grey' : 'charcoal';
  }
  const depth = l > 0.72 ? 'pale ' : l < 0.32 ? 'deep ' : '';
  const intensity = chroma(hex) > 0.45 ? 'strong ' : '';
  return `${depth}${intensity}${family}`;
}
