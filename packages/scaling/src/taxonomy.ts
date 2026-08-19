/**
 * Ingredient taxonomy.
 *
 * Keyword matching, deliberately. A learned classifier here would be
 * non-deterministic and untestable, and this package's whole value is that it
 * is neither. When a term is missing the failure is a wrong-but-predictable
 * LINEAR classification, which is the safe default.
 */

import type { Ingredient, Recipe } from "@mise/schema";
import type { ScalingClass } from "./types.js";

/**
 * Perception and chemistry do not scale with volume. Doubling a stew does not
 * double how salty it tastes, and yeast is governed by time and temperature
 * rather than by dough mass.
 */
const SUBLINEAR_TERMS = [
  "salt",
  "pepper",
  "peppercorn",
  "chilli",
  "chili",
  "cayenne",
  "paprika",
  "cumin",
  "coriander powder",
  "turmeric",
  "cinnamon",
  "cardamom",
  "clove powder",
  "nutmeg",
  "saffron",
  "garam masala",
  "curry powder",
  "oregano",
  "thyme",
  "rosemary",
  "bay leaf",
  "vanilla",
  "spice",
  "seasoning",
  "baking powder",
  "baking soda",
  "bicarbonate",
  "yeast",
  "msg",
  "stock cube",
  "bouillon",
];

/** Things that come in whole units. 1.5 eggs is not a thing you can put in a bowl. */
const DISCRETE_TERMS = [
  "egg",
  "onion",
  "potato",
  "tomato",
  "carrot",
  "shallot",
  "lemon",
  "lime",
  "orange",
  "apple",
  "banana",
  "avocado",
  "bell pepper",
  "capsicum",
  "cucumber",
  "aubergine",
  "eggplant",
  "courgette",
  "zucchini",
  "garlic clove",
  "bay leaf",
];

/** The ratio backbone of a baked good. Drift here changes the product. */
const BAKING_RATIO_TERMS = [
  "flour",
  "sugar",
  "butter",
  "milk",
  "buttermilk",
  "cream",
  "water",
  "oil",
  "cocoa",
  "cornstarch",
  "cornflour",
  "semolina",
  "oats",
];

/** Units that measure rather than count. "500 g potato" is a weight. */
const MEASURED_UNITS = [
  "g",
  "gram",
  "grams",
  "kg",
  "kilogram",
  "ml",
  "millilitre",
  "milliliter",
  "l",
  "litre",
  "liter",
  "oz",
  "ounce",
  "lb",
  "pound",
  "cup",
  "cups",
  "tbsp",
  "tablespoon",
  "tsp",
  "teaspoon",
  "pint",
  "quart",
];

const BAKING_TITLE_RE =
  /\b(cake|bread|cookie|biscuit|brownie|muffin|scone|pastry|pie|tart|loaf|dough|bun|croissant|focaccia|baguette|shortbread|cupcake|baking|baked)\b/i;

function matches(name: string, terms: readonly string[]): boolean {
  const lowered = name.toLowerCase();
  return terms.some((term) => lowered.includes(term));
}

function isMeasuredByWeightOrVolume(unit: string | null): boolean {
  if (unit === null) return false;
  return MEASURED_UNITS.includes(unit.toLowerCase().trim());
}

/**
 * Is this a baking recipe, where ratios are chemistry rather than preference?
 *
 * Two independent signals, because either alone is wrong often enough to
 * matter: a title can say "bread" for a sandwich video, and an ingredient list
 * can contain flour for a roux.
 */
export function isBakingRecipe(recipe: Recipe): boolean {
  if (BAKING_TITLE_RE.test(recipe.title)) return true;

  const names = recipe.ingredients.map((i) => i.name.toLowerCase());
  const hasFlour = names.some((n) => n.includes("flour"));
  const hasBakingPartner = names.some(
    (n) =>
      n.includes("sugar") ||
      n.includes("butter") ||
      n.includes("yeast") ||
      n.includes("baking powder") ||
      n.includes("baking soda"),
  );
  return hasFlour && hasBakingPartner;
}

/**
 * Classify a single ingredient.
 *
 * Order is the whole design. Sublinear wins over precision-critical so that
 * salt in a cake is still seasoned to taste — the flour-to-liquid ratio is
 * chemistry, but perceived saltiness is not. Discrete wins over
 * precision-critical because you cannot use two-thirds of an egg however
 * important the ratio is.
 */
export function classify(ingredient: Ingredient, baking: boolean): ScalingClass {
  if (matches(ingredient.name, SUBLINEAR_TERMS)) return "SUBLINEAR";

  if (matches(ingredient.name, DISCRETE_TERMS) && !isMeasuredByWeightOrVolume(ingredient.unit)) {
    return "DISCRETE";
  }

  if (baking && matches(ingredient.name, BAKING_RATIO_TERMS)) return "PRECISION_CRITICAL";

  return "LINEAR";
}

/** Eggs get their own treatment: half an egg is a yolk, not a rounding error. */
export function isEgg(name: string): boolean {
  return /\begg/i.test(name);
}
