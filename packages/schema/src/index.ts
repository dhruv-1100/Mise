/**
 * @mise/schema — the contract between apps/web and apps/extractor.
 *
 * This package is the single source of truth for anything crossing that
 * boundary. Recipe/Ingredient types land in Phase 2 alongside the extraction
 * pipeline; `extractor.proto` and its generated TS + Python stubs land in
 * Phase 4.
 */
export const PACKAGE_NAME = "@mise/schema" as const;
