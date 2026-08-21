/**
 * Property-based tests for the scaling engine.
 *
 * These are the point of this package. Written before the implementation, per
 * BUILD_PLAN.md §3 — correctness beats speed here, and a property that holds
 * over ten thousand generated recipes says more than any number of examples.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { classify, scale } from "../src/index";
import { arbIngredient, arbRecipe } from "./arbitraries";

/** Floats accumulate error; compare within a relative tolerance. */
function closeTo(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected));
}

function unwrap(result: ReturnType<typeof scale>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
}

describe("scale", () => {
  it("scaling to the original serving count is the identity", () => {
    fc.assert(
      fc.property(arbRecipe(), (recipe) => {
        const servings = recipe.yield?.qty;
        if (servings == null) return true;

        const scaled = unwrap(scale(recipe, servings));
        expect(scaled.factor).toBe(1);

        for (const [i, si] of scaled.ingredients.entries()) {
          const original = recipe.ingredients[i]!;
          if (original.qty === null) {
            expect(si.ingredient.qty).toBeNull();
          } else {
            expect(closeTo(si.ingredient.qty!, original.qty)).toBe(true);
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("doubling then halving returns the original, except where rounding intervenes", () => {
    fc.assert(
      fc.property(arbRecipe(), fc.integer({ min: 2, max: 6 }), (recipe, multiple) => {
        const servings = recipe.yield?.qty;
        if (servings == null) return true;

        const up = unwrap(scale(recipe, servings * multiple));
        const back = unwrap(scale(up.recipe, servings));

        for (const [i, si] of back.ingredients.entries()) {
          const original = recipe.ingredients[i]!;
          // DISCRETE rounds to whole units on the way out and cannot come back
          // — that is the intended behaviour, not a bug, and it gets golden
          // tests of its own.
          if (si.scalingClass === "DISCRETE") continue;
          if (original.qty === null) {
            expect(si.ingredient.qty).toBeNull();
          } else {
            expect(closeTo(si.ingredient.qty!, original.qty, 1e-6)).toBe(true);
          }
        }
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("is monotonic — more servings never yields less of any ingredient", () => {
    fc.assert(
      fc.property(
        arbRecipe(),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        (recipe, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);

          const scaledLo = unwrap(scale(recipe, lo));
          const scaledHi = unwrap(scale(recipe, hi));

          for (const [i, si] of scaledHi.ingredients.entries()) {
            const other = scaledLo.ingredients[i]!;
            if (si.ingredient.qty === null || other.ingredient.qty === null) continue;
            expect(si.ingredient.qty).toBeGreaterThanOrEqual(other.ingredient.qty - 1e-9);
          }
          return true;
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never invents a quantity the source did not have", () => {
    // The single most damaging thing this engine could do. A vague quantity
    // must stay vague through any scale factor.
    fc.assert(
      fc.property(arbRecipe(), fc.integer({ min: 1, max: 100 }), (recipe, target) => {
        const scaled = unwrap(scale(recipe, target));
        for (const [i, si] of scaled.ingredients.entries()) {
          if (recipe.ingredients[i]!.qty === null) {
            expect(si.ingredient.qty).toBeNull();
            expect(si.ingredient.qtyText).toBe(recipe.ingredients[i]!.qtyText);
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("produces a positive, finite quantity wherever the input had one", () => {
    fc.assert(
      fc.property(arbRecipe(), fc.integer({ min: 1, max: 200 }), (recipe, target) => {
        const scaled = unwrap(scale(recipe, target));
        for (const si of scaled.ingredients) {
          if (si.ingredient.qty === null) continue;
          expect(Number.isFinite(si.ingredient.qty)).toBe(true);
          expect(si.ingredient.qty).toBeGreaterThan(0);
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("always reports the yield it actually scaled to", () => {
    fc.assert(
      fc.property(arbRecipe(), fc.integer({ min: 1, max: 200 }), (recipe, target) => {
        const scaled = unwrap(scale(recipe, target));
        expect(scaled.recipe.yield?.qty).toBe(target);
        expect(scaled.targetServings).toBe(target);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("sublinear ingredients grow strictly slower than linear ones", () => {
    fc.assert(
      fc.property(arbIngredient, fc.integer({ min: 2, max: 20 }), (ing, multiple) => {
        if (ing.qty === null) return true;
        if (classify(ing, false) !== "SUBLINEAR") return true;

        const scaled = unwrap(scale({ ...base(ing) }, 4 * multiple));
        const value = scaled.ingredients[0]!.ingredient.qty!;

        expect(value).toBeGreaterThan(ing.qty);
        expect(value).toBeLessThan(ing.qty * multiple);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("rejects non-positive or non-finite serving counts", () => {
    fc.assert(
      fc.property(
        arbRecipe(),
        fc.constantFrom(0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY),
        (recipe, bad) => {
          const result = scale(recipe, bad);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason).toBe("INVALID_TARGET_SERVINGS");
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

function base(ing: { name: string; qty: number | null }) {
  return {
    videoId: "aaaaaaaaaaa",
    title: "Test",
    creator: {
      name: "Example Kitchen",
      channelId: "UCexampleexampleexample",
      channelUrl: "https://www.youtube.com/channel/UCexampleexampleexample",
    },
    ingredients: [
      {
        name: ing.name,
        qty: ing.qty,
        qtyText: null,
        unit: "g",
        prep: null,
        optional: false,
        source: "description" as const,
        confidence: 1,
      },
    ],
    steps: [],
    yield: { qty: 4, qtyText: null, unit: "serving" },
    equipment: [],
    sources: ["description" as const],
    conflicts: [],
    extractedAt: "2026-08-17T19:41:09Z",
  };
}
