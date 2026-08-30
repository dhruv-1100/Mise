/**
 * The stub extractor's port, in its own module.
 *
 * Both playwright.config.ts and e2e/global-setup.ts need it, and having the
 * setup import the config creates a cycle that only shows up as a confusing
 * load-order failure.
 */
export const STUB_PORT = 50251;
