/**
 * Golden tests for the cases BUILD_PLAN.md §3 calls out by name.
 *
 * Properties prove the engine is self-consistent. These prove it is *right*
 * about the handful of behaviours a cook would actually notice.
 */

import { describe, expect, it } from "vitest";

import { scale } from "../src/index";
import { ingredient, recipeOf } from "./arbitraries";

function scaleTo(recipe: Parameters<typeof scale>[0], target: number) {
  const result = scale(recipe, target);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
}

describe("failure cases", () => {
  it("refuses a recipe with no stated yield", () => {
    const result = scale(recipeOf([ingredient("salt", 1, "tsp")], null), 8);
    expect(result).toEqual({ ok: false, reason: "UNKNOWN_YIELD" });
  });

  it("refuses a recipe whose yield is only vague text", () => {
    const recipe = recipeOf([ingredient("salt", 1, "tsp")], 4);
    recipe.yield = { qty: null, qtyText: "serves a crowd", unit: "serving" };
    expect(scale(recipe, 8)).toEqual({ ok: false, reason: "VAGUE_YIELD" });
  });
});

describe("discrete ingredients", () => {
  it("rounds eggs to whole numbers and says so", () => {
    // 3 eggs at x1.25 is 3.75 — not a half, so this is plain rounding rather
    // than the yolk case below.
    const scaled = scaleTo(recipeOf([ingredient("egg", 3)], 4), 5);
    const egg = scaled.ingredients[0]!;

    expect(egg.scalingClass).toBe("DISCRETE");
    expect(egg.ingredient.qty).toBe(4);
    const warning = egg.warnings.find((w) => w.code === "ROUNDED_TO_WHOLE");
    expect(warning?.exactQty).toBeCloseTo(3.75);
  });

  it("suggests a yolk whenever the count lands exactly on a half", () => {
    // 3 eggs at x1.5 is 4.5. The plan's rule is a yolk, not a round.
    const scaled = scaleTo(recipeOf([ingredient("egg", 3)], 4), 6);
    const egg = scaled.ingredients[0]!;

    expect(egg.ingredient.qty).toBe(4);
    expect(egg.display).toBe("4 eggs + 1 yolk");
    expect(egg.warnings.map((w) => w.code)).toContain("SPLIT_EGG_SUGGESTED");
  });

  it("suggests a yolk rather than silently rounding a half egg", () => {
    // The plan's example: halving 3 eggs gives 1.5, and "1 egg + 1 yolk" is a
    // better answer than either 1 or 2.
    const scaled = scaleTo(recipeOf([ingredient("egg", 3)], 4), 2);
    const egg = scaled.ingredients[0]!;

    expect(egg.warnings.map((w) => w.code)).toContain("SPLIT_EGG_SUGGESTED");
    expect(egg.display).toContain("yolk");
  });

  it("never rounds a countable ingredient below one", () => {
    const scaled = scaleTo(recipeOf([ingredient("onion", 1)], 8), 1);
    expect(scaled.ingredients[0]!.ingredient.qty).toBe(1);
  });

  it("treats a weighed countable as linear, not discrete", () => {
    // "500 g potato" is a weight, not a count. Rounding it to whole potatoes
    // would be nonsense.
    const scaled = scaleTo(recipeOf([ingredient("potato", 500, "g")], 4), 6);
    expect(scaled.ingredients[0]!.scalingClass).toBe("LINEAR");
    expect(scaled.ingredients[0]!.ingredient.qty).toBe(750);
  });
});

describe("sublinear ingredients", () => {
  it("scales salt well below the batch factor", () => {
    const scaled = scaleTo(recipeOf([ingredient("salt", 1, "tsp")], 4), 12);
    const salt = scaled.ingredients[0]!;

    expect(salt.scalingClass).toBe("SUBLINEAR");
    // The plan's number: roughly x2.2 for a x3 batch.
    expect(salt.ingredient.qty!).toBeGreaterThan(2.0);
    expect(salt.ingredient.qty!).toBeLessThan(2.4);
  });

  it("advises tasting once the batch more than doubles", () => {
    const scaled = scaleTo(recipeOf([ingredient("cumin", 2, "tsp")], 4), 12);
    expect(scaled.ingredients[0]!.warnings.map((w) => w.code)).toContain("SEASON_TO_TASTE");
  });

  it("does not nag about seasoning at small factors", () => {
    const scaled = scaleTo(recipeOf([ingredient("salt", 1, "tsp")], 4), 6);
    expect(scaled.ingredients[0]!.warnings.map((w) => w.code)).not.toContain("SEASON_TO_TASTE");
  });
});

describe("baking", () => {
  const cake = () =>
    recipeOf(
      [
        ingredient("plain flour", 250, "g"),
        ingredient("caster sugar", 200, "g"),
        ingredient("butter", 125, "g"),
        ingredient("baking powder", 2, "tsp"),
        ingredient("salt", 1, "tsp"),
      ],
      8,
      { title: "Simple Vanilla Cake" },
    );

  it("holds flour and sugar exactly linear", () => {
    const scaled = scaleTo(cake(), 16);
    expect(scaled.isBaking).toBe(true);

    const flour = scaled.ingredients[0]!;
    expect(flour.scalingClass).toBe("PRECISION_CRITICAL");
    expect(flour.ingredient.qty).toBe(500);
    expect(scaled.ingredients[1]!.ingredient.qty).toBe(400);
  });

  it("flags precision-critical ingredients", () => {
    const scaled = scaleTo(cake(), 16);
    expect(scaled.ingredients[0]!.warnings.map((w) => w.code)).toContain("PRECISION_CRITICAL");
    expect(scaled.advisories.map((a) => a.code)).toContain("BAKING_PRECISION");
  });

  it("still treats salt as sublinear inside a baking recipe", () => {
    // Ratio backbone is chemistry; perceived saltiness is not.
    const scaled = scaleTo(cake(), 24);
    const salt = scaled.ingredients[4]!;
    expect(salt.scalingClass).toBe("SUBLINEAR");
    expect(salt.ingredient.qty!).toBeLessThan(3);
  });

  it("does not mistake a savoury recipe for baking", () => {
    const scaled = scaleTo(recipeOf([ingredient("olive oil", 2, "tbsp")], 4), 8);
    expect(scaled.isBaking).toBe(false);
  });
});

describe("advisories", () => {
  it("recommends a larger pan when volume grows", () => {
    const recipe = recipeOf([ingredient("olive oil", 2, "tbsp")], 4, {
      equipment: ["12-inch skillet"],
    });
    expect(scaleTo(recipe, 12).advisories.map((a) => a.code)).toContain("PAN_SIZE");
  });

  it("suggests batching at large factors", () => {
    const recipe = recipeOf([ingredient("olive oil", 2, "tbsp")], 4, {
      equipment: ["12-inch skillet"],
    });
    expect(scaleTo(recipe, 40).advisories.map((a) => a.code)).toContain("BATCHING");
  });

  it("warns that cook time does not scale with volume", () => {
    const recipe = recipeOf([ingredient("beef", 500, "g")], 4, {
      steps: [
        {
          index: 1,
          text: "Braise until tender.",
          durationS: 7200,
          tempC: 150,
          source: "description",
        },
      ],
    });
    expect(scaleTo(recipe, 12).advisories.map((a) => a.code)).toContain("COOK_TIME");
  });

  it("flags an absurd scale factor rather than pretending it is fine", () => {
    const recipe = recipeOf([ingredient("olive oil", 2, "tbsp")], 4);
    expect(scaleTo(recipe, 400).advisories.map((a) => a.code)).toContain("EXTREME_SCALE_FACTOR");
  });

  it("stays quiet when nothing needs saying", () => {
    const scaled = scaleTo(recipeOf([ingredient("olive oil", 2, "tbsp")], 4), 4);
    expect(scaled.advisories).toEqual([]);
  });
});

describe("vague quantities", () => {
  it("passes them through untouched and explains why", () => {
    const scaled = scaleTo(recipeOf([ingredient("salt", null)], 4), 16);
    const salt = scaled.ingredients[0]!;

    expect(salt.ingredient.qty).toBeNull();
    expect(salt.ingredient.qtyText).toBe("to taste");
    expect(salt.display).toBe("to taste");
    expect(salt.warnings.map((w) => w.code)).toContain("UNSCALABLE_VAGUE_QUANTITY");
  });
});

describe("no quantity at all", () => {
  it("renders an empty amount when the source gave neither number nor wording", () => {
    // The schema permits qty and qtyText both null: the ingredient was named
    // and nothing was said about how much.
    const bare = { ...ingredient("chilli flakes", null), qtyText: null };
    const scaled = scaleTo(recipeOf([bare], 4), 8);

    expect(scaled.ingredients[0]!.display).toBe("");
    expect(scaled.ingredients[0]!.warnings.map((w) => w.code)).toContain(
      "UNSCALABLE_VAGUE_QUANTITY",
    );
  });
});

describe("very small results", () => {
  it("warns when an amount scales below what anyone can measure", () => {
    const scaled = scaleTo(recipeOf([ingredient("saffron", 0.25, "tsp")], 24), 1);
    expect(scaled.ingredients[0]!.warnings.map((w) => w.code)).toContain(
      "BELOW_MEASURABLE_MINIMUM",
    );
  });
});
