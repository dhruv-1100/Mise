/**
 * Metric conversion, for display.
 *
 * A cook reading a recipe written in cups wants grams, and one reading grams
 * may want cups. The extractor already canonicalises to grams and millilitres
 * (`apps/extractor/app/units.py`) but that value never reaches the recipe — it
 * lives in the pipeline's stats and is used by the eval harness. This is the
 * display-side twin.
 *
 * TWO IMPLEMENTATIONS OF ONE TABLE IS THE DRIFT THIS REPO ALREADY GUARDS
 * AGAINST for the recipe contract. Both are checked against
 * `packages/schema/fixtures/units/conversions.json`, so a factor changed on one
 * side and not the other fails in both suites.
 *
 * Volume is US customary, and that choice is not neutral — see `AMBIGUOUS`.
 */

export type UnitKind = "mass" | "volume" | "count" | "vague";

/** Grams per unit. */
const MASS: ReadonlyMap<string, number> = new Map([
  ["g", 1], ["gm", 1], ["gms", 1], ["gram", 1], ["grams", 1],
  ["gramme", 1], ["grammes", 1],
  ["kg", 1000], ["kgs", 1000], ["kilo", 1000], ["kilos", 1000],
  ["kilogram", 1000], ["kilograms", 1000],
  ["mg", 0.001], ["milligram", 0.001], ["milligrams", 0.001],
  ["oz", 28.349523125], ["ozs", 28.349523125],
  ["ounce", 28.349523125], ["ounces", 28.349523125],
  ["lb", 453.59237], ["lbs", 453.59237],
  ["pound", 453.59237], ["pounds", 453.59237],
]);

/** Millilitres per unit. US customary. */
const VOLUME: ReadonlyMap<string, number> = new Map([
  ["ml", 1], ["mls", 1], ["millilitre", 1], ["millilitres", 1],
  ["milliliter", 1], ["milliliters", 1], ["cc", 1],
  ["l", 1000], ["litre", 1000], ["litres", 1000], ["liter", 1000], ["liters", 1000],
  ["tsp", 4.92892159375], ["tsps", 4.92892159375],
  ["teaspoon", 4.92892159375], ["teaspoons", 4.92892159375],
  ["tbsp", 14.78676478125], ["tbsps", 14.78676478125],
  ["tablespoon", 14.78676478125], ["tablespoons", 14.78676478125],
  ["cup", 236.5882365], ["cups", 236.5882365],
  ["fl oz", 29.5735295625], ["floz", 29.5735295625],
  ["fluid ounce", 29.5735295625], ["fluid ounces", 29.5735295625],
  ["pint", 473.176473], ["pints", 473.176473],
  ["quart", 946.352946], ["quarts", 946.352946],
  ["gallon", 3785.411784], ["gallons", 3785.411784],
]);

/**
 * Units whose size depends on where the creator is.
 *
 * The tables above pick US customary. These are the ones where that choice
 * materially changes the answer — a metric cup is 250ml and an imperial cup
 * 284ml, so "1 cup" converted to grams can be off by 20% depending on who
 * wrote it. Surfaced to the reader rather than hidden, because a confidently
 * wrong number is worse than a caveated one.
 */
const AMBIGUOUS: ReadonlySet<string> = new Set([
  "cup", "cups", "tbsp", "tbsps", "tablespoon", "tablespoons",
]);

function key(unit: string): string {
  return unit.toLowerCase().trim().replace(/\.$/, "");
}

export function classifyUnit(unit: string | null): UnitKind {
  if (unit === null) return "vague";
  const k = key(unit);
  if (MASS.has(k)) return "mass";
  if (VOLUME.has(k)) return "volume";
  return "count";
}

export interface Converted {
  qty: number;
  unit: string;
  /** True when the source unit's size depends on region — see AMBIGUOUS. */
  approximate: boolean;
}

/**
 * Convert to metric, or return null when there is nothing to convert.
 *
 * Null rather than a guess, in three cases: a vague quantity (there is no
 * number), a countable unit ("4 cloves" is already the clearest form), and a
 * unit not in the tables. An unrecognised unit is a missing alias to add, not a
 * number to invent — the same rule `units.py` follows for the same reason.
 */
export function toMetric(qty: number | null, unit: string | null): Converted | null {
  if (qty === null || unit === null) return null;
  const k = key(unit);
  const approximate = AMBIGUOUS.has(k);

  const grams = MASS.get(k);
  if (grams !== undefined) {
    const total = qty * grams;
    // Above a kilo, grams stop being readable: "1500 g" is worse than "1.5 kg".
    return total >= 1000
      ? { qty: round(total / 1000, 2), unit: "kg", approximate }
      : { qty: round(total, total < 10 ? 2 : 0), unit: "g", approximate };
  }

  const ml = VOLUME.get(k);
  if (ml !== undefined) {
    const total = qty * ml;
    return total >= 1000
      ? { qty: round(total / 1000, 2), unit: "l", approximate }
      : { qty: round(total, total < 10 ? 1 : 0), unit: "ml", approximate };
  }

  return null;
}

/** Is this already metric? Nothing to offer a reader who is looking at grams. */
export function isMetric(unit: string | null): boolean {
  if (unit === null) return false;
  const k = key(unit);
  return ["g", "gram", "grams", "kg", "kilogram", "kilograms", "mg",
    "ml", "millilitre", "millilitres", "milliliter", "milliliters",
    "l", "litre", "litres", "liter", "liters"].includes(k);
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
