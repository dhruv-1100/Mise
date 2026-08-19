/**
 * Vocabulary for the scaling engine.
 *
 * Kept separate from the logic so the tests can be written against the types
 * first, which is the working order BUILD_PLAN.md §3 asks for here.
 */

import type { Ingredient, Recipe } from "@mise/schema";

/**
 * How an ingredient responds to changing the batch size.
 *
 * The whole reason this package exists: scaling is not multiplication. Tripling
 * a recipe does not triple the salt, cannot use 1.5 eggs, and must not disturb
 * the flour-to-liquid ratio in a cake.
 */
export type ScalingClass =
  /** Scales exactly with the batch. Most ingredients by count. */
  | "LINEAR"
  /**
   * Scales slower than the batch. Salt, spices, leavening, braising liquid:
   * perception and chemistry do not scale with volume, and evaporation does not
   * either.
   */
  | "SUBLINEAR"
  /**
   * Comes in whole units. Eggs, whole onions. 1.5 eggs is not a thing you can
   * put in a bowl.
   */
  | "DISCRETE"
  /**
   * Scales exactly linearly, and the exactness matters. Baking ratios are
   * chemistry; a 5% drift in flour-to-liquid is a different product.
   */
  | "PRECISION_CRITICAL";

export type ScalingWarningCode =
  /** Sublinear ingredient at a large factor — taste before committing. */
  | "SEASON_TO_TASTE"
  /** Rounded to a whole unit. Carries the pre-rounding value. */
  | "ROUNDED_TO_WHOLE"
  /** A half egg. Suggests "1 egg + 1 yolk" rather than rounding away. */
  | "SPLIT_EGG_SUGGESTED"
  /** Ratio-critical ingredient — measure by weight if possible. */
  | "PRECISION_CRITICAL"
  /** Quantity was vague in the source, so there was nothing to scale. */
  | "UNSCALABLE_VAGUE_QUANTITY"
  /** Scaled below a practically measurable amount. */
  | "BELOW_MEASURABLE_MINIMUM";

export interface ScalingWarning {
  code: ScalingWarningCode;
  message: string;
  /** Present on ROUNDED_TO_WHOLE: the value before rounding. */
  exactQty?: number;
}

export type AdvisoryCode =
  /** Volume grew enough that the original pan will not do. */
  | "PAN_SIZE"
  /** Better cooked in batches than in one oversized vessel. */
  | "BATCHING"
  /** Cook time does not scale the way volume does. */
  | "COOK_TIME"
  /** Baking detected — ratios were held exact. */
  | "BAKING_PRECISION"
  /** Scaled far enough that the result is a guess, not a recipe. */
  | "EXTREME_SCALE_FACTOR";

export interface ScalingAdvisory {
  code: AdvisoryCode;
  message: string;
}

export interface ScaledIngredient {
  /** The ingredient after scaling. */
  ingredient: Ingredient;
  /** What it was before, for display as "was 2 tbsp". */
  originalQty: number | null;
  scalingClass: ScalingClass;
  /** Human-readable amount: "1½ cup", "1 tbsp + 1½ tsp", "to taste". */
  display: string;
  warnings: ScalingWarning[];
}

export interface ScaledRecipe {
  recipe: Recipe;
  ingredients: ScaledIngredient[];
  advisories: ScalingAdvisory[];
  /** targetServings / originalServings. */
  factor: number;
  originalServings: number;
  targetServings: number;
  /** True when the recipe was detected as baking and ratios were held exact. */
  isBaking: boolean;
}

export type ScaleFailure =
  /** The source never stated a yield, so there is no factor to compute. */
  | "UNKNOWN_YIELD"
  /** Yield was vague ("serves a few") — no number to scale from. */
  | "VAGUE_YIELD"
  /** Zero, negative, or non-finite target. */
  | "INVALID_TARGET_SERVINGS";

/**
 * Result of a scale attempt.
 *
 * A union rather than the bare `ScaledRecipe` sketched in BUILD_PLAN.md §3.
 * A recipe whose yield the extractor could not determine is a normal outcome —
 * ADR 0001 found descriptions frequently omit yield — and the caller has to
 * handle it. Encoding that in the return type makes it impossible to forget,
 * which matches the project's typed-error-envelope rule.
 */
export type ScaleResult =
  | { ok: true; value: ScaledRecipe }
  | { ok: false; reason: ScaleFailure };
