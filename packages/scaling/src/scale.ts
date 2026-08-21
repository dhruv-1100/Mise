/**
 * The scaling engine.
 *
 * Pure and deterministic: no I/O, no clock, no randomness. Every input maps to
 * exactly one output, forever. That is what makes the property tests and the
 * coverage requirement tractable.
 */

import type { Ingredient, Recipe } from "@mise/schema";
import { formatQuantity } from "./format";
import { classify, isBakingRecipe, isEgg } from "./taxonomy";
import type {
  ScaledIngredient,
  ScaleResult,
  ScalingAdvisory,
  ScalingWarning,
} from "./types";

/**
 * Sublinear growth exponent.
 *
 * BUILD_PLAN.md §3 gives the target directly: roughly x2.2 seasoning for a x3
 * batch. Solving 3^k = 2.2 gives k = ln(2.2)/ln(3) = 0.7176. A power law is the
 * right shape because it is exactly 1 at factor 1 (so scaling to the original
 * yield is the identity) and its own inverse under the reciprocal factor (so
 * scaling up and back returns the original exactly).
 */
const SUBLINEAR_EXPONENT = Math.log(2.2) / Math.log(3);

/** Above this, seasoning stops being a multiplication and starts being tasting. */
const SEASON_TO_TASTE_FACTOR = 2;
/** Above this, a domestic pan is the wrong vessel. */
const PAN_SIZE_FACTOR = 2;
/** Above this, cook in batches rather than looking for a bigger pot. */
const BATCHING_FACTOR = 8;
/** Above this, the output is an estimate rather than a recipe. */
const EXTREME_FACTOR = 20;

/** Smallest amount worth writing down, by unit family. */
const MEASURABLE_MINIMUM: ReadonlyArray<readonly [units: readonly string[], minimum: number]> = [
  [["tsp", "teaspoon", "tbsp", "tablespoon", "cup", "cups"], 1 / 8],
  [["g", "gram", "grams", "ml", "millilitre", "milliliter"], 0.5],
];

const PAN_TERMS = ["pan", "skillet", "pot", "tin", "dish", "tray", "wok", "kadhai", "casserole"];

/** Trim float noise without disturbing round-trip accuracy. */
function clean(value: number): number {
  return Number.parseFloat(value.toPrecision(12));
}

function measurableMinimum(unit: string | null): number {
  if (unit === null) return 0.01;
  const normalised = unit.toLowerCase().trim();
  for (const [units, minimum] of MEASURABLE_MINIMUM) {
    if (units.includes(normalised)) return minimum;
  }
  return 0.01;
}

function scaleIngredient(
  ingredient: Ingredient,
  factor: number,
  baking: boolean,
): ScaledIngredient {
  const scalingClass = classify(ingredient, baking);
  const warnings: ScalingWarning[] = [];

  // Nothing to scale. The source never gave a number, and inventing one here
  // would be the worst thing this engine could do.
  if (ingredient.qty === null) {
    warnings.push({
      code: "UNSCALABLE_VAGUE_QUANTITY",
      message: `"${ingredient.name}" had no stated quantity, so it is unchanged. Adjust to taste.`,
    });
    return {
      ingredient: { ...ingredient },
      originalQty: null,
      scalingClass,
      display: ingredient.qtyText ?? "",
      warnings,
    };
  }

  const originalQty = ingredient.qty;
  let scaled: number;
  let display: string | null = null;

  switch (scalingClass) {
    case "SUBLINEAR": {
      scaled = clean(originalQty * Math.pow(factor, SUBLINEAR_EXPONENT));
      if (factor > SEASON_TO_TASTE_FACTOR) {
        warnings.push({
          code: "SEASON_TO_TASTE",
          message: `Seasoning does not scale with volume. Start with this much ${ingredient.name} and taste before adding more.`,
        });
      }
      break;
    }

    case "DISCRETE": {
      const exact = originalQty * factor;
      const whole = Math.floor(exact);
      const remainder = exact - whole;

      // Half an egg is a yolk, not a rounding error.
      if (isEgg(ingredient.name) && Math.abs(remainder - 0.5) < 1e-9 && whole >= 1) {
        scaled = whole;
        display =
          whole === 1
            ? "1 egg + 1 yolk"
            : `${whole} eggs + 1 yolk`;
        warnings.push({
          code: "SPLIT_EGG_SUGGESTED",
          message: `This works out at ${exact} eggs. Use ${display} rather than rounding.`,
        });
        break;
      }

      scaled = Math.max(1, Math.round(exact));
      if (Math.abs(scaled - exact) > 1e-9) {
        warnings.push({
          code: "ROUNDED_TO_WHOLE",
          message: `Rounded to ${scaled} from ${clean(exact)}.`,
          exactQty: clean(exact),
        });
      }
      break;
    }

    case "PRECISION_CRITICAL": {
      scaled = clean(originalQty * factor);
      warnings.push({
        code: "PRECISION_CRITICAL",
        message: `Baking ratios are chemistry, not preference. Measure ${ingredient.name} by weight if you can.`,
      });
      break;
    }

    default: {
      scaled = clean(originalQty * factor);
      break;
    }
  }

  if (scaled < measurableMinimum(ingredient.unit)) {
    warnings.push({
      code: "BELOW_MEASURABLE_MINIMUM",
      message: `This is less than most kitchens can measure. Use the smallest pinch you can manage.`,
    });
  }

  return {
    ingredient: { ...ingredient, qty: scaled },
    originalQty,
    scalingClass,
    display: display ?? formatQuantity(scaled, ingredient.unit),
    warnings,
  };
}

function buildAdvisories(recipe: Recipe, factor: number, baking: boolean): ScalingAdvisory[] {
  const advisories: ScalingAdvisory[] = [];
  if (factor === 1) return advisories;

  const hasPan = recipe.equipment.some((item) =>
    PAN_TERMS.some((term) => item.toLowerCase().includes(term)),
  );

  if (factor > PAN_SIZE_FACTOR && hasPan) {
    advisories.push({
      code: "PAN_SIZE",
      message:
        "Volume scales faster than pan area. Use a wider pan, or the food will steam instead of browning.",
    });
  }

  if (factor >= BATCHING_FACTOR) {
    advisories.push({
      code: "BATCHING",
      message: "At this size, cook in batches. One oversized vessel will cook unevenly.",
    });
  }

  if (factor > PAN_SIZE_FACTOR && recipe.steps.some((step) => step.durationS !== null)) {
    advisories.push({
      code: "COOK_TIME",
      message:
        "Timings are unchanged for thin or spread-out food, but anything cooked in depth will take longer. Judge by doneness, not the clock.",
    });
  }

  if (baking) {
    advisories.push({
      code: "BAKING_PRECISION",
      message:
        "Baking ratios were scaled exactly. Pan depth changes bake time — check early and often.",
    });
  }

  if (factor > EXTREME_FACTOR) {
    advisories.push({
      code: "EXTREME_SCALE_FACTOR",
      message: `Scaling by ${clean(factor)}x is an estimate, not a recipe. Test a smaller batch first.`,
    });
  }

  return advisories;
}

/**
 * Scale a recipe to a target yield.
 *
 * Returns a discriminated result rather than throwing: a recipe whose yield the
 * extractor could not determine is a normal outcome (ADR 0001 found
 * descriptions often omit it), and the caller must handle it.
 */
export function scale(recipe: Recipe, targetServings: number): ScaleResult {
  if (!Number.isFinite(targetServings) || targetServings <= 0) {
    return { ok: false, reason: "INVALID_TARGET_SERVINGS" };
  }
  if (recipe.yield === null) {
    return { ok: false, reason: "UNKNOWN_YIELD" };
  }
  if (recipe.yield.qty === null) {
    return { ok: false, reason: "VAGUE_YIELD" };
  }

  const originalServings = recipe.yield.qty;
  const factor = targetServings / originalServings;
  const baking = isBakingRecipe(recipe);

  const ingredients = recipe.ingredients.map((ingredient) =>
    scaleIngredient(ingredient, factor, baking),
  );

  const scaledRecipe: Recipe = {
    ...recipe,
    ingredients: ingredients.map((scaled) => scaled.ingredient),
    yield: { ...recipe.yield, qty: targetServings },
  };

  return {
    ok: true,
    value: {
      recipe: scaledRecipe,
      ingredients,
      advisories: buildAdvisories(recipe, factor, baking),
      factor,
      originalServings,
      targetServings,
      isBaking: baking,
    },
  };
}
