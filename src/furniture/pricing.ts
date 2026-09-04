/**
 * The shopping list.
 *
 * -----------------------------------------------------------------------------
 * ABOUT THE NUMBERS — this matters more than the code.
 *
 * The catalogue ships ROUGH ESTIMATES so totals work out of the box. They are
 * guesses: IKEA prices differ by country, change several times a year, and none
 * of these has been checked against a listing. Nobody should budget a room from
 * them without checking.
 *
 * So every figure carries its basis, and the basis survives all the way through
 * aggregation and export. A room total made of estimates is labelled an estimate
 * total; a total where the user has confirmed every price is labelled confirmed;
 * a mixture says so. That is the difference between a tool that is approximately
 * useful and one that quietly misleads someone into ordering a sofa they cannot
 * afford.
 *
 * Entering a real price on a placed piece overrides the estimate and promotes it
 * to a fact. The same field is what a licensed retailer feed writes to later.
 * -----------------------------------------------------------------------------
 */

import { getCatalogEntry, type CatalogEntry } from './catalog';
import type { DesignDocument, FurnitureItem } from '@/state/types';

/** Where a price came from. */
export type PriceBasis = 'confirmed' | 'estimate' | 'unknown';

export interface LineItem {
  /** Catalogue ID — one line per product, not per placed piece. */
  catalogId: string;
  entry: CatalogEntry;
  quantity: number;
  /** IDs of the placed pieces this line covers. */
  itemIds: string[];
  /** Price for ONE of them, or null when nothing is known. */
  unitPrice: number | null;
  unitBasis: PriceBasis;
  /** unitPrice x quantity, or null. */
  lineTotal: number | null;
  /** Rooms these pieces stand in, by name. */
  rooms: string[];
}

export interface ShoppingList {
  lines: LineItem[];
  total: number | null;
  /**
   * The weakest basis among the lines that contributed to the total.
   *
   * 'estimate' if any line is estimated, 'unknown' if any line has no price at
   * all, 'confirmed' only when every single one was entered by hand.
   */
  basis: PriceBasis;
  /** Number of lines with no price of any kind. */
  unpricedLines: number;
  itemCount: number;
}

/** The price of one placed piece, and how much to trust it. */
export function priceOf(item: FurnitureItem): { amount: number | null; basis: PriceBasis } {
  // A number typed in by a person beats a guess written by a language model.
  if (typeof item.price === 'number' && Number.isFinite(item.price)) {
    return { amount: item.price, basis: 'confirmed' };
  }

  const estimate = getCatalogEntry(item.catalogId).price;
  if (estimate) return { amount: estimate.amount, basis: 'estimate' };

  return { amount: null, basis: 'unknown' };
}

/** The weaker of two bases — used when aggregating. */
function weaker(a: PriceBasis, b: PriceBasis): PriceBasis {
  const order: PriceBasis[] = ['confirmed', 'estimate', 'unknown'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * Builds the shopping list for a design.
 *
 * Grouped by product rather than by placed piece, because six identical dining
 * chairs are one line on an order, not six. Per-item price overrides complicate
 * that slightly: if two of the six have confirmed prices and four do not, the
 * line reports the confirmed figure and marks the whole line as estimated,
 * since the total is only as trustworthy as its weakest component.
 */
export function buildShoppingList(
  doc: DesignDocument,
  roomNameOf: (item: FurnitureItem) => string | null,
): ShoppingList {
  const grouped = new Map<string, FurnitureItem[]>();
  for (const item of doc.levels.flatMap((level) => level.furniture)) {
    const list = grouped.get(item.catalogId) ?? [];
    list.push(item);
    grouped.set(item.catalogId, list);
  }

  const lines: LineItem[] = [];

  for (const [catalogId, items] of grouped) {
    const entry = getCatalogEntry(catalogId);

    let unitPrice: number | null = null;
    let unitBasis: PriceBasis = 'unknown';

    for (const item of items) {
      const price = priceOf(item);
      if (price.amount === null) {
        unitBasis = weaker(unitBasis, 'unknown');
        continue;
      }
      // Prefer a confirmed figure if any of the group has one.
      if (unitPrice === null || (price.basis === 'confirmed' && unitBasis !== 'confirmed')) {
        unitPrice = price.amount;
      }
      unitBasis = unitPrice === null ? price.basis : weaker(unitBasis === 'unknown' ? price.basis : unitBasis, price.basis);
    }

    const rooms = [
      ...new Set(items.map((item) => roomNameOf(item)).filter((name): name is string => !!name)),
    ].sort();

    lines.push({
      catalogId,
      entry,
      quantity: items.length,
      itemIds: items.map((item) => item.id),
      unitPrice,
      unitBasis,
      lineTotal: unitPrice === null ? null : unitPrice * items.length,
      rooms,
    });
  }

  // Most expensive first: the line worth arguing about is at the top.
  lines.sort((a, b) => (b.lineTotal ?? -1) - (a.lineTotal ?? -1));

  let total: number | null = null;
  let basis: PriceBasis = 'confirmed';
  let unpricedLines = 0;

  for (const line of lines) {
    if (line.lineTotal === null) {
      unpricedLines += 1;
      basis = weaker(basis, 'unknown');
      continue;
    }
    total = (total ?? 0) + line.lineTotal;
    basis = weaker(basis, line.unitBasis);
  }

  return {
    lines,
    total,
    basis: lines.length === 0 ? 'unknown' : basis,
    unpricedLines,
    itemCount: doc.levels.reduce((count, level) => count + level.furniture.length, 0),
  };
}

/** Human-readable label for a basis, used throughout the UI. */
export function basisLabel(basis: PriceBasis): string {
  switch (basis) {
    case 'confirmed':
      return 'confirmed prices';
    case 'estimate':
      return 'rough estimates';
    default:
      return 'incomplete';
  }
}

/** Escapes a value for CSV, quoting anything containing a delimiter. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Renders the list as CSV.
 *
 * The basis column is not optional decoration: a spreadsheet full of numbers
 * with no indication that most were guessed is precisely the artefact this
 * module exists to avoid producing.
 */
export function toCsv(list: ShoppingList, currency: string): string {
  const rows: string[] = [
    [
      'Product',
      'Series',
      'Category',
      'Quantity',
      'Width (m)',
      'Depth (m)',
      'Height (m)',
      'Rooms',
      `Unit price (${currency})`,
      `Line total (${currency})`,
      'Price basis',
    ]
      .map(csvCell)
      .join(','),
  ];

  for (const line of list.lines) {
    rows.push(
      [
        line.entry.name,
        line.entry.series,
        line.entry.category,
        line.quantity,
        line.entry.width,
        line.entry.depth,
        line.entry.height,
        line.rooms.join('; '),
        line.unitPrice,
        line.lineTotal,
        line.unitBasis,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  rows.push('');
  rows.push([`Total (${currency})`, '', '', '', '', '', '', '', '', list.total, list.basis].map(csvCell).join(','));
  rows.push(
    csvCell(
      'Prices marked "estimate" are rough figures shipped with havavamama and have ' +
        'not been checked against any IKEA listing. Verify before ordering.',
    ),
  );

  return rows.join('\n');
}

/** Downloads the shopping list as a CSV file. */
export function downloadCsv(list: ShoppingList, currency: string, designName: string): void {
  const blob = new Blob([toCsv(list, currency)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const stem =
    designName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'havavamama';

  const link = document.createElement('a');
  link.href = url;
  link.download = `${stem}-shopping-list.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
