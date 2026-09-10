/**
 * Where the electrical service calculation gets its heating and cooling load.
 *
 * -----------------------------------------------------------------------------
 * TWO SOURCES FOR ONE FACT IS A BUG WAITING TO HAPPEN.
 *
 * NEC 220.82(C) adds the larger of the heating and the cooling load to the
 * service calculation at full value, and it is usually the biggest single item
 * in it. Before there was a load calculation the app had no choice but to ask
 * the user for both figures.
 *
 * Now it does have one, and leaving the typed-in fields as an independent
 * source would mean the app could hold two different answers to "how big is the
 * air conditioner" — one on the electrical panel and one on the HVAC panel —
 * with nothing reconciling them. A service sized for equipment nobody is
 * installing is exactly the kind of error that survives all the way to the
 * inspection.
 *
 * So the order is fixed and stated: a design location means the calculation
 * wins; no design location means the typed figures are all there is. Whichever
 * it used, it says so, because the reader of a load calculation is entitled to
 * know where each line came from.
 *
 * -----------------------------------------------------------------------------
 * WHY THE HEAT PUMP CASE IS DIFFERENT.
 *
 * For a heat pump the compressor and the backup resistance heat can run at the
 * same time — that is the whole point of backup heat — so they add rather than
 * alternate. That is 440.  It is also why a cold-climate heat pump on a small
 * service is a real problem: ten kilowatts of strip heat is another forty
 * amps on top of everything else, drawn on the coldest evening of the year.
 */

import { deriveHvac } from '@/state/hvacOps';
import type { DesignDocument } from '@/state/types';

export interface ClimateLoad {
  /** Volt-amperes to add under 220.82(C). */
  va: number;
  /** Where it came from. */
  source: 'derived' | 'entered' | 'none';
  /** A line label for the load calculation table. */
  label: string;
  /** How it was arrived at, for the "working" column. */
  working: string;
}

export function climateLoadVa(doc: DesignDocument): ClimateLoad {
  const entered = Math.max(doc.electrical.heatingVa, doc.electrical.coolingVa);

  // No design location means no load calculation, so the typed figures are
  // everything there is to go on.
  if (doc.hvac.locationKey === '') {
    return entered > 0
      ? {
          va: entered,
          source: 'entered',
          label: 'Heating or cooling, whichever is larger',
          working: 'the figure entered by hand on the electrical panel',
        }
      : { va: 0, source: 'none', label: '', working: '' };
  }

  const { selection } = deriveHvac(doc);

  const heating = selection.heatingWatts;
  const cooling = selection.coolingWatts;

  /*
   * Backup heat, which only exists for a heat pump and only below its balance
   * point. It is added to the compressor rather than compared against it,
   * because both run together on the design day.
   */
  const backupWatts = selection.balancePoint
    ? Math.ceil(selection.balancePoint.supplementalKw / 5) * 5 * 1000
    : 0;

  const heatingSide = heating + backupWatts;
  const coolingSide = cooling;

  const va = Math.max(heatingSide, coolingSide);

  if (va === 0) {
    return entered > 0
      ? {
          va: entered,
          source: 'entered',
          label: 'Heating or cooling, whichever is larger',
          working: 'the figure entered by hand; no equipment has been selected',
        }
      : { va: 0, source: 'none', label: '', working: '' };
  }

  const winter = heatingSide >= coolingSide;
  const equipment = winter
    ? (selection.heating?.model.name ?? 'heating')
    : (selection.cooling?.model.name ?? 'cooling');

  return {
    va,
    source: 'derived',
    label: winter ? 'Heating, the larger of the two' : 'Cooling, the larger of the two',
    working:
      backupWatts > 0 && winter
        ? `${equipment} plus ${backupWatts / 1000} kW of backup heat, which run together below the balance point`
        : `${equipment}, from the Manual J load`,
  };
}
