import { dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// eslint-config-next 15 ships eslintrc-style configs, so FlatCompat adapts them
// for ESLint 9. Under pnpm's strict node_modules the eslintrc plugin resolver
// looks for eslint-plugin-* relative to *this* file and misses the plugins that
// eslint-config-next depends on, so resolve them relative to that package
// instead. Both workarounds go away when we move to Next 16.
const compat = new FlatCompat({
  baseDirectory: __dirname,
  resolvePluginsRelativeTo: dirname(
    require.resolve("eslint-config-next/package.json"),
  ),
});

const eslintConfig = [
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // CLAUDE.md non-negotiable: no `any` in TypeScript.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];

export default eslintConfig;
