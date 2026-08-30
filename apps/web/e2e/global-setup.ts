import { startStubExtractor } from "./stub-extractor";
import { STUB_PORT } from "./ports";

/**
 * Start the stub extractor before any spec runs.
 *
 * In the Playwright process rather than a separate one: Playwright compiles
 * TypeScript for its own config and setup, and this needs the generated stubs
 * from @mise/schema, which are TypeScript source. Spawning a second Node
 * process would need a TypeScript runner this repo does not have.
 */
export default async function globalSetup() {
  const server = await startStubExtractor(STUB_PORT);
  return async () => {
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
  };
}
