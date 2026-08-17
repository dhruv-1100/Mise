import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Types only — no branches to cover, and counting it drags the number
      // down for no signal.
      exclude: ["src/types.ts"],
      reporter: ["text", "html"],
      // BUILD_PLAN.md §3: 100% branch coverage, enforced in CI. This is the one
      // component where correctness beats speed, so the gate is absolute rather
      // than a target to drift down from.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
