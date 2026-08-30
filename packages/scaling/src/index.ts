/**
 * @mise/scaling — the recipe scaling engine.
 *
 * Non-negotiable (see CLAUDE.md): this package stays dependency-free and
 * deterministic. No I/O, no clock, no randomness — every input maps to exactly
 * one output, forever. `@mise/schema` appears only as a devDependency and only
 * ever as `import type`, which `verbatimModuleSyntax` erases at compile time,
 * so nothing it depends on reaches the runtime.
 */

export { classifyUnit, isMetric, toMetric } from "./convert";
export type { Converted, UnitKind } from "./convert";
export { formatQuantity } from "./format";
export { scale } from "./scale";
export { classify, isBakingRecipe, isEgg } from "./taxonomy";
export type {
  AdvisoryCode,
  ScaledIngredient,
  ScaledRecipe,
  ScaleFailure,
  ScaleResult,
  ScalingAdvisory,
  ScalingClass,
  ScalingWarning,
  ScalingWarningCode,
} from "./types";
