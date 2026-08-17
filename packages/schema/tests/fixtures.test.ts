/**
 * Contract test: every fixture under valid/ must parse, every fixture under
 * invalid/ must be rejected.
 *
 * `apps/extractor/tests/test_schema.py` asserts exactly the same thing against
 * exactly the same files. Two hand-maintained definitions of one contract drift;
 * this is what catches it, until the Phase 4 protobuf makes the mirror
 * unnecessary.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { ExtractionResult, Recipe } from "../src/index.js";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");

function load(kind: string, bucket: "valid" | "invalid"): [string, unknown][] {
  const dir = join(FIXTURES, kind, bucket);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))]);
}

function suite(kind: string, schema: ZodType): void {
  describe(kind, () => {
    const valid = load(kind, "valid");
    const invalid = load(kind, "invalid");

    // A fixture directory that silently empties would turn this whole file
    // into a no-op that still reports green.
    it("has fixtures in both buckets", () => {
      expect(valid.length).toBeGreaterThan(0);
      expect(invalid.length).toBeGreaterThan(0);
    });

    it.each(valid)("accepts %s", (_name, data) => {
      const result = schema.safeParse(data);
      if (!result.success) {
        throw new Error(
          `expected valid, got:\n${JSON.stringify(result.error.issues, null, 2)}`,
        );
      }
    });

    it.each(invalid)("rejects %s", (_name, data) => {
      expect(schema.safeParse(data).success).toBe(false);
    });
  });
}

suite("recipe", Recipe);
suite("result", ExtractionResult);
