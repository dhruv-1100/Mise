/**
 * @mise/scaling — the recipe scaling engine.
 *
 * Non-negotiable (see CLAUDE.md): this package stays dependency-free and
 * deterministic. No I/O, no clock, no randomness — every input maps to exactly
 * one output, forever. That is what makes 100% branch coverage and
 * property-based testing tractable here.
 *
 * Implementation lands in Phase 3.
 */
export const PACKAGE_NAME = "@mise/scaling" as const;
