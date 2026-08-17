/**
 * @mise/schema — the contract between apps/web and apps/extractor.
 *
 * `extractor.proto` and its generated TS + Python stubs land in Phase 4 and
 * will supersede the hand-mirrored Pydantic models in
 * `apps/extractor/app/schema.py`.
 *
 * Note for `packages/scaling`, which must stay dependency-free: import from
 * here with `import type`, which `verbatimModuleSyntax` erases at compile time,
 * so zod never becomes a runtime dependency of that package.
 */
export {
  Conflict,
  Confidence,
  Creator,
  ExtractionResult,
  Ingredient,
  InsufficientReason,
  Recipe,
  SourceKind,
  Step,
  VideoId,
  Yield,
} from "./recipe.js";
