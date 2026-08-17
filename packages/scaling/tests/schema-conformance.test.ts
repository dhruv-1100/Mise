/**
 * "Output is always schema-valid for any positive serving count."
 *
 * The plan lists this as a property, and it is the one that keeps the scaling
 * engine honest about the contract rather than merely about arithmetic.
 *
 * `@mise/schema` is a devDependency here, imported for its runtime validator in
 * tests only. `packages/scaling` still ships zero runtime dependencies — the
 * `src/` tree imports from it with `import type`, which is erased at compile
 * time.
 */

import fc from "fast-check";
import { describe, it } from "vitest";
import { Recipe } from "@mise/schema";

import { scale } from "../src/index.js";
import { arbRecipe } from "./arbitraries.js";

describe("schema conformance", () => {
  it("the generator itself produces schema-valid recipes", () => {
    // Without this, every property below could be passing over garbage.
    fc.assert(
      fc.property(arbRecipe(), (recipe) => {
        const parsed = Recipe.safeParse(recipe);
        if (!parsed.success) {
          throw new Error(
            `arbRecipe produced invalid input:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
          );
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("scaled output is schema-valid for any positive serving count", () => {
    fc.assert(
      fc.property(arbRecipe(), fc.integer({ min: 1, max: 500 }), (recipe, target) => {
        const result = scale(recipe, target);
        if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);

        const parsed = Recipe.safeParse(result.value.recipe);
        if (!parsed.success) {
          throw new Error(
            `scale() produced an invalid recipe at target=${target}:\n` +
              JSON.stringify(parsed.error.issues, null, 2),
          );
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });
});
