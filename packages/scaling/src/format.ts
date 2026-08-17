/**
 * Turning numbers into amounts a person can measure.
 *
 * "0.33 cups" is arithmetically correct and useless — no measuring cup has that
 * mark. This module is the difference between output that looks computed and
 * output that looks like a recipe.
 */

/** Fractions that appear on real measuring equipment. */
const FRACTIONS: ReadonlyArray<readonly [value: number, glyph: string]> = [
  [1 / 8, "⅛"],
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [3 / 8, "⅜"],
  [1 / 2, "½"],
  [5 / 8, "⅝"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
  [7 / 8, "⅞"],
];

/** Close enough to a marked fraction that a cook would use that mark. */
const SNAP_TOLERANCE = 0.02;

/** Units measured in whole increments, where a fraction glyph reads as noise. */
const INTEGER_UNITS = ["g", "ml", "gram", "grams", "millilitre", "milliliter"];

/**
 * Weights and metric volumes read off a digital scale or jug, which display
 * decimals. "1⅔ kg" is not a thing any kitchen equipment shows.
 */
const DECIMAL_UNITS = ["kg", "kilogram", "kilograms", "l", "litre", "liter", "litres", "liters"];

/**
 * Units where fractions are natural, because the equipment is physically
 * marked that way. This is the whole reason the fraction logic exists: a
 * measuring cup has a ⅓ line on it, and "0.33 cup" asks the cook to find a
 * mark that is not there.
 */
const FRACTIONAL_UNITS = ["cup", "cups", "tbsp", "tablespoon", "tsp", "teaspoon"];

const TSP_PER_TBSP = 3;

function normaliseUnit(unit: string | null): string {
  return unit === null ? "" : unit.toLowerCase().trim();
}

/** "1.670" -> "1.67", "2.00" -> "2", "100" -> "100". */
function stripTrailingZeros(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/**
 * Decimal that is never "0" for a positive input.
 *
 * A quantity that rounds away to nothing is worse than an ugly one: it tells
 * the cook to add zero of something the recipe needs.
 */
function decimal(value: number, places: number): string {
  const fixed = stripTrailingZeros(value.toFixed(places));
  if (Number.parseFloat(fixed) !== 0) return fixed;
  return stripTrailingZeros(value.toPrecision(2));
}

/** Nearest marked fraction, or null if the value is not near one. */
function snapFraction(fraction: number): string | null {
  let best: string | null = null;
  let bestDistance = SNAP_TOLERANCE;
  for (const [value, glyph] of FRACTIONS) {
    const distance = Math.abs(fraction - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = glyph;
    }
  }
  return best;
}

/** "1½", "¾", "3" — or null when no marked fraction is close. */
function asMixedNumber(value: number): string | null {
  const whole = Math.floor(value);
  const fraction = value - whole;

  // Rounded up to the next whole by the snap tolerance: 1.995 is 2.
  if (fraction > 1 - SNAP_TOLERANCE) return String(whole + 1);
  if (fraction < SNAP_TOLERANCE) return whole === 0 ? null : String(whole);

  const glyph = snapFraction(fraction);
  if (glyph === null) return null;
  return whole === 0 ? glyph : `${whole}${glyph}`;
}

function withUnit(amount: string, unit: string | null): string {
  return unit === null ? amount : `${amount} ${unit}`;
}

/**
 * Render a quantity for display.
 *
 * @param qty  Positive amount, or null when the source was vague.
 * @param unit Raw unit as written, or null for a bare count.
 */
export function formatQuantity(qty: number | null, unit: string | null): string {
  if (qty === null) return "";

  const normalised = normaliseUnit(unit);

  // Weights in grams and millilitres: whole numbers. "333⅓ g" is absurd.
  if (INTEGER_UNITS.includes(normalised)) {
    const amount = qty >= 10 ? String(Math.round(qty)) : decimal(qty, 1);
    return withUnit(amount, unit);
  }

  if (DECIMAL_UNITS.includes(normalised)) {
    return withUnit(decimal(qty, 2), unit);
  }

  // A tablespoon with a fractional part reads better as spoons: 1.5 tbsp is
  // "1 tbsp + 1½ tsp", which is two measurements a cook already owns.
  if ((normalised === "tbsp" || normalised === "tablespoon") && !Number.isInteger(qty)) {
    const whole = Math.floor(qty);
    const teaspoons = (qty - whole) * TSP_PER_TBSP;
    const teaspoonText = asMixedNumber(teaspoons) ?? decimal(teaspoons, 2);

    // No "0 tsp" guard needed: this branch only runs for a non-integer
    // quantity, so the teaspoon remainder is always positive, and neither
    // asMixedNumber nor decimal can render a positive value as zero.
    if (whole === 0) return withUnit(teaspoonText, "tsp");
    return `${withUnit(String(whole), unit)} + ${withUnit(teaspoonText, "tsp")}`;
  }

  if (FRACTIONAL_UNITS.includes(normalised) || normalised === "") {
    const mixed = asMixedNumber(qty);
    if (mixed !== null) return withUnit(mixed, unit);
    return withUnit(decimal(qty, 2), unit);
  }

  // Anything else — cloves, cans, unrecognised units.
  const mixed = asMixedNumber(qty);
  return withUnit(mixed ?? decimal(qty, 2), unit);
}
