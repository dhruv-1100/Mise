import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Shared flat config for the pure TypeScript packages (packages/*).
 * apps/web has its own config because it layers eslint-config-next on top.
 */
export default tseslint.config(
  {
    // src/gen is emitted by scripts/codegen.sh; see the note in
    // apps/extractor/pyproject.toml for why generated output is not linted.
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/src/gen/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md non-negotiable: no `any` in TypeScript.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
