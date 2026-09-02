/**
 * Unit conversion and formatting.
 *
 * The rule this module exists to enforce: the design document is metric, and
 * imperial exists only at the boundary where a human reads or types a number.
 * Nothing outside the UI layer should ever import from here.
 */

import type { UnitSystem } from './types';

const METRES_PER_FOOT = 0.3048;
const INCHES_PER_FOOT = 12;
const METRES_PER_INCH = METRES_PER_FOOT / INCHES_PER_FOOT;

/**
 * Formats a metric length for display.
 *
 * metric   → "3.60 m" (or "45 cm" for values under a metre, which read better)
 * imperial → "11′ 10″"
 */
export function formatLength(metres: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const totalInches = metres / METRES_PER_INCH;
    let feet = Math.floor(totalInches / INCHES_PER_FOOT);
    let inches = Math.round(totalInches - feet * INCHES_PER_FOOT);

    // Rounding 11.6" up to 12" must roll over into the next foot.
    if (inches === INCHES_PER_FOOT) {
      feet += 1;
      inches = 0;
    }
    return `${feet}′ ${inches}″`;
  }

  if (metres < 1) {
    return `${Math.round(metres * 100)} cm`;
  }
  return `${metres.toFixed(2)} m`;
}

/** Short unit suffix for axis labels and input adornments. */
export function unitSuffix(system: UnitSystem): string {
  return system === 'imperial' ? 'ft' : 'm';
}

/** Converts a stored metric length into the number shown in an input field. */
export function toDisplayNumber(metres: number, system: UnitSystem): number {
  return system === 'imperial' ? metres / METRES_PER_FOOT : metres;
}

/** Converts a number typed into an input field back into stored metres. */
export function fromDisplayNumber(value: number, system: UnitSystem): number {
  return system === 'imperial' ? value * METRES_PER_FOOT : value;
}

/** Formats an area, e.g. "12.4 m²" or "133 sq ft". */
export function formatArea(squareMetres: number, system: UnitSystem): string {
  if (system === 'imperial') {
    const squareFeet = squareMetres / (METRES_PER_FOOT * METRES_PER_FOOT);
    return `${Math.round(squareFeet)} sq ft`;
  }
  return `${squareMetres.toFixed(1)} m²`;
}
