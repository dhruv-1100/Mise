import { defineConfig, devices } from "@playwright/test";


/**
 * End-to-end specs, for the things unit tests cannot see.
 *
 * CLAUDE.md is explicit about why this exists: a <Suspense> boundary once left
 * its client children rendered, correct-looking and completely inert — no
 * handlers attached — in both dev and a production build, while typecheck, lint
 * and every unit test passed. Nothing but a real browser clicking a real button
 * catches that, and cook mode is now full of real buttons.
 *
 * The extractor is stubbed (see e2e/stub-extractor.ts). Everything else is real:
 * the Next server, the BFF's gRPC client, the generated stubs, the zod parse.
 */

import { STUB_PORT } from "./e2e/ports";

export default defineConfig({
  testDir: "./e2e",
  // The stub is a module the specs' setup imports, not a spec itself.
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",

  // A flake retried into a pass is a flake you ship. Locally: none.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Spread rather than `workers: undefined`. This tsconfig sets
  // exactOptionalPropertyTypes, under which an explicit undefined is not the
  // same as an absent key and is a type error — and `next build` typechecks
  // this file along with everything else.
  ...(process.env.CI ? { workers: 1 } : {}),

  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
  },

  projects: [
    // Cook mode is a phone-on-a-counter surface, so that is the viewport it is
    // tested at. Desktop gets the recipe page.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],

  webServer: {
    // A production build, not `next dev`. The hydration bug this suite exists
    // for behaved identically in both, but dev's on-demand compilation makes
    // the first navigation to each route slow enough to look like a timeout.
    command: "pnpm build && pnpm start --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      EXTRACTOR_GRPC_ADDRESS: `127.0.0.1:${STUB_PORT}`,
      NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3100",
      // Deliberately no DATABASE_URL or AUTH_*: the specs cover the signed-out
      // public surface, and the app degrading cleanly to "signed out" when
      // accounts are unconfigured is itself worth exercising.
    },
  },
});
