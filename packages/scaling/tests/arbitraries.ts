/**
 * fast-check arbitraries producing schema-valid recipes.
 *
 * These must satisfy every invariant in `@mise/schema` — contiguous step
 * indices, declared sources, no unit without a quantity. A generator that
 * produces invalid input would make the "output is always schema-valid"
 * property vacuous, so `arbRecipe` is itself checked against the real schema in
 * `schema-conformance.test.ts`.
 */

import fc from "fast-check";
import type { Ingredient, Recipe, Step } from "@mise/schema";

import { classify } from "../src/index.js";

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("");

export const arbVideoId: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...ID_CHARS), { minLength: 11, maxLength: 11 })
  .map((cs) => cs.join(""));

/** Names that the taxonomy classifies deterministically, so tests can target a class. */
export const SUBLINEAR_NAMES = ["salt", "black pepper", "cumin", "baking powder", "yeast"];
export const DISCRETE_NAMES = ["egg", "onion", "potato"];
export const BAKING_NAMES = ["plain flour", "caster sugar", "butter", "milk"];
export const LINEAR_NAMES = ["dried spaghetti", "olive oil", "chopped tomatoes", "paneer"];

const ALL_NAMES = [...SUBLINEAR_NAMES, ...DISCRETE_NAMES, ...BAKING_NAMES, ...LINEAR_NAMES];

/** Quantities that survive a float round-trip cleanly; real recipes look like this. */
const arbQty = fc
  .integer({ min: 1, max: 4000 })
  .map((n) => n / 4)
  .filter((q) => q > 0);

const arbUnit = fc.constantFrom("g", "ml", "tbsp", "tsp", "cup", "clove", "l", "kg");

/**
 * Ask the real classifier, never a second list.
 *
 * A duplicate notion of "discrete" here disagreed with the taxonomy on
 * "chopped tomatoes" — which contains "tomato" — and produced a fractional
 * count that broke the identity property for a reason that said nothing about
 * the engine. The generator has to agree with the implementation about what a
 * countable ingredient is, so it asks.
 */
function isDiscrete(candidate: Ingredient): boolean {
  // Discrete-ness does not depend on whether the recipe is baking.
  return classify(candidate, false) === "DISCRETE";
}

export const arbIngredient: fc.Arbitrary<Ingredient> = fc
  .record({
    name: fc.constantFrom(...ALL_NAMES),
    qtyRaw: arbQty,
    hasQty: fc.boolean(),
    unit: fc.option(arbUnit, { nil: null }),
    prep: fc.option(fc.constantFrom("minced", "diced", "at room temperature"), { nil: null }),
    optional: fc.boolean(),
    confidence: fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
  })
  .map(({ name, qtyRaw, hasQty, unit, prep, optional, confidence }): Ingredient => {
    const candidate: Ingredient = {
      name,
      qty: qtyRaw,
      qtyText: null,
      unit,
      prep,
      optional,
      source: "description",
      confidence,
    };

    // Countable things are whole in a real recipe. Generating 2.5 eggs would
    // make the identity property fail for a reason that says nothing about the
    // engine — rounding 2.5 to 3 at factor 1 is correct behaviour, and it gets
    // its own golden test instead.
    const qty = hasQty ? (isDiscrete(candidate) ? Math.max(1, Math.round(qtyRaw)) : qtyRaw) : null;

    return {
      ...candidate,
      qty,
      qtyText: qty === null ? "to taste" : null,
      // Schema invariant: a unit without a quantity is meaningless.
      unit: qty === null ? null : unit,
    };
  });

export const arbSteps: fc.Arbitrary<Step[]> = fc
  .array(
    fc.record({
      text: fc.constantFrom("Heat the pan.", "Add the aromatics.", "Simmer until thick."),
      durationS: fc.option(fc.integer({ min: 1, max: 7200 }), { nil: null }),
      tempC: fc.option(fc.integer({ min: 20, max: 260 }), { nil: null }),
    }),
    { maxLength: 8 },
  )
  // Schema invariant: indices are exactly 1..n.
  .map((steps) =>
    steps.map((s, i) => ({ ...s, index: i + 1, source: "description" as const })),
  );

export interface RecipeOptions {
  /** Force a specific yield, for tests that need a known factor. */
  servings?: fc.Arbitrary<number>;
  ingredients?: fc.Arbitrary<Ingredient[]>;
  equipment?: fc.Arbitrary<string[]>;
}

export function arbRecipe(options: RecipeOptions = {}): fc.Arbitrary<Recipe> {
  return fc
    .record({
      videoId: arbVideoId,
      title: fc.constantFrom("Weeknight Pasta", "Skillet Cornbread", "Braised Greens"),
      ingredients: options.ingredients ?? fc.array(arbIngredient, { minLength: 1, maxLength: 12 }),
      steps: arbSteps,
      servings: options.servings ?? fc.integer({ min: 1, max: 24 }),
      equipment: options.equipment ?? fc.constant<string[]>([]),
    })
    .map(
      ({ videoId, title, ingredients, steps, servings, equipment }): Recipe => ({
        videoId,
        title,
        creator: {
          name: "Example Kitchen",
          channelId: "UCexampleexampleexample",
          channelUrl: "https://www.youtube.com/channel/UCexampleexampleexample",
        },
        ingredients,
        steps,
        yield: { qty: servings, qtyText: null, unit: "serving" },
        equipment,
        sources: ["description"],
        conflicts: [],
        extractedAt: "2026-08-17T19:41:09Z",
      }),
    );
}

/** An ingredient with a known name, quantity, and unit. For golden tests. */
export function ingredient(
  name: string,
  qty: number | null,
  unit: string | null = null,
): Ingredient {
  return {
    name,
    qty,
    qtyText: qty === null ? "to taste" : null,
    unit: qty === null ? null : unit,
    prep: null,
    optional: false,
    source: "description",
    confidence: 1,
  };
}

/** A minimal, schema-valid recipe with the given ingredients and yield. */
export function recipeOf(
  ingredients: Ingredient[],
  servings: number | null = 4,
  extra: Partial<Recipe> = {},
): Recipe {
  return {
    videoId: "aaaaaaaaaaa",
    title: "Test Recipe",
    creator: {
      name: "Example Kitchen",
      channelId: "UCexampleexampleexample",
      channelUrl: "https://www.youtube.com/channel/UCexampleexampleexample",
    },
    ingredients,
    steps: [],
    yield: servings === null ? null : { qty: servings, qtyText: null, unit: "serving" },
    equipment: [],
    sources: ["description"],
    conflicts: [],
    extractedAt: "2026-08-17T19:41:09Z",
    ...extra,
  };
}
