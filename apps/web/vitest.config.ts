import { defineConfig } from "vitest/config";

/**
 * Unit tests for the parts of the web app that are logic rather than React.
 *
 * CLAUDE.md is explicit that React components are not unit tested here — cook
 * mode gets Playwright. What lives in this suite is the code where being wrong
 * is silent: the migration splitter, and the redirect sanitiser that stands
 * between a sign-in link and an open redirect.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
